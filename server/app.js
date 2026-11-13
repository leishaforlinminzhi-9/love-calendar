import { TYPE_IDS, typeOf } from '../frontend/love-types.js';
import { buildPrompt, iconKey, normalizeText } from './prompt.js';
import { createLedger } from './spend.js';
import { createSync, isIconDataUrl, ICON_KEY_RE, MAX_ICON_BYTES } from './sync.js';

// Runtime-neutral backend: takes a standard Request, returns a standard Response. The same code runs under
// Node (server/index.js, local use) and on Cloudflare Workers (server/worker.js, free hosting).

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const RAW_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const encoder = new TextEncoder();

function safeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function sniffMime(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function defaultParams(model) {
  // Lowest quality is plenty for a 256px icon and is the cheapest tier; jpeg keeps the payload small.
  if (/^(gpt-image|chatgpt-image)/i.test(model)) return { quality: 'low', output_format: 'jpeg', output_compression: 85 };
  return {};
}

export function createApp({ env, store, ephemeralRisk = false }) {
  const cfg = {
    apiKey: env.IMAGE_API_KEY || '',
    // IMAGE_PAUSED=true: draw no new icons (e.g. while the key is being replaced); stored icons are still handed out
    paused: ['1', 'true', 'yes'].includes(String(env.IMAGE_PAUSED ?? '').toLowerCase()),
    apiBase: (env.IMAGE_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    // gpt-image-1 (and -mini / 1.5) are being shut down by OpenAI between 2026-10-23 and 2026-12-01.
    model: env.IMAGE_MODEL || 'gpt-image-2.5-flare',
    size: env.IMAGE_SIZE ?? '1024x1024',
    accessCode: env.ACCESS_CODE || '',
    // Explicit opt-in: anyone who has the link may read and write the shared calendar. Limits below still apply.
    open: ['1', 'true', 'yes'].includes(String(env.OPEN_ACCESS ?? '').toLowerCase()),
    ratePerMin: Number(env.RATE_PER_MIN) || 6,
    dailyLimit: Number(env.DAILY_LIMIT) || 200,
    origins: (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    // optional password for the visit list (/api/visits); without it the list is open to whoever has the link
    visitsKey: env.VISITS_KEY || '',
    // Workers AI (the [ai] binding in wrangler.toml): finds the flat places in a photo for 小狗跳进照片; absent under Node
    ai: env.AI || null,
    surfacesPerDay: Number(env.SURFACES_PER_DAY) || 300,
  };

  let extraParams = {};
  try {
    if (env.IMAGE_PARAMS) extraParams = JSON.parse(env.IMAGE_PARAMS);
  } catch {
    console.warn('IMAGE_PARAMS is not valid JSON, ignoring it.');
  }

  const ledger = createLedger({
    store,
    warnAtUsd: Number(env.BUDGET_WARN_USD) || 50,
    fallbackCostUsd: Number(env.FALLBACK_COST_USD) || 0.02,
    priceOverride: env.PRICE_PER_M,
  });
  const syncer = createSync({ store, iconKeyFor: iconKey, typeIds: TYPE_IDS });
  const ready = ledger.init(); // first real read from the store: wrong Upstash credentials fail here
  ready.catch(() => {}); // reported by whoever awaits `ready`; avoids an "unhandled rejection" in the meantime

  // ---------- http helpers ----------

  function corsHeaders(request) {
    const origin = request.headers.get('origin');
    const headers = {
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type, x-access-code, x-visits-key',
      'access-control-max-age': '86400',
      vary: 'Origin',
    };
    if (cfg.origins.includes('*')) headers['access-control-allow-origin'] = '*';
    else if (origin && cfg.origins.includes(origin)) headers['access-control-allow-origin'] = origin;
    return headers;
  }

  function json(request, status, body, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request), ...extraHeaders },
    });
  }

  async function readJson(request, limit = 4096) {
    if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'too_large', '请求内容过大');
    const body = await request.text();
    if (body.length > limit) throw new HttpError(413, 'too_large', '请求内容过大');
    try {
      return JSON.parse(body || '{}');
    } catch {
      throw new HttpError(400, 'bad_json', '请求格式不正确');
    }
  }

  // The diary is private and image generation costs money, so remote callers always need the access code.
  // Without ACCESS_CODE the API only answers requests coming from this very machine (never true on a Worker).
  function requireAccess(request, ctx) {
    if (cfg.open) return; // OPEN_ACCESS: no passcode, by choice
    if (cfg.accessCode) {
      if (!safeEqual(request.headers.get('x-access-code') ?? '', cfg.accessCode)) throw new HttpError(401, 'unauthorized', '需要正确的访问口令');
      return;
    }
    if (!ctx.isLocal) throw new HttpError(403, 'access_code_required', '后端未设置 ACCESS_CODE，不允许远程访问');
  }

  // Rate limits live in the store (not in memory): a Worker may run in several places at once.
  async function checkRate(ip) {
    const now = new Date();
    const minute = Math.floor(now.getTime() / 60_000);
    if ((await store.counters.hit(`ip:${ip}:${minute}`, 120)) > cfg.ratePerMin) throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试');
    if ((await store.counters.hit(`daily:${now.toISOString().slice(0, 10)}`, 172_800)) > cfg.dailyLimit) {
      throw new HttpError(429, 'daily_limit', '今日生成额度已用完');
    }
  }

  // ---------- image generation ----------

  async function generateImage(prompt) {
    const body = {
      model: cfg.model,
      prompt,
      n: 1,
      ...(cfg.size ? { size: cfg.size } : {}),
      ...defaultParams(cfg.model),
      ...extraParams,
    };

    let upstream;
    try {
      upstream = await fetch(`${cfg.apiBase}/images/generations`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(110_000),
      });
    } catch (err) {
      console.error('[image] request failed:', err.message);
      throw new HttpError(504, 'upstream_timeout', '图像服务无响应');
    }

    const raw = await upstream.text();
    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {}

    if (!upstream.ok) {
      const detail = String(parsed?.error?.message || parsed?.message || raw).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200);
      console.error(`[image] upstream ${upstream.status}:`, detail);
      // OpenAI refuses calls that come from a country it does not serve; say so plainly instead of a vague upstream error
      if (upstream.status === 403 && /country|region|territory/i.test(detail)) {
        throw new HttpError(502, 'upstream_region', '图像服务拒绝了后端当前所在地区的请求（OpenAI 不支持该地区）');
      }
      throw new HttpError(502, 'upstream_error', `图像服务返回错误：${detail}`);
    }

    const item = parsed.data?.[0] ?? parsed.images?.[0];
    if (item?.b64_json) return { image: `data:${sniffMime(item.b64_json)};base64,${item.b64_json}`, usage: parsed.usage };
    if (item?.url) {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
      if (!img.ok) throw new HttpError(502, 'upstream_error', '图片下载失败');
      const type = img.headers.get('content-type')?.split(';')[0] || 'image/png';
      return { image: `data:${type};base64,${bytesToBase64(new Uint8Array(await img.arrayBuffer()))}`, usage: parsed.usage };
    }
    throw new HttpError(502, 'upstream_error', '图像服务未返回图片');
  }

  // Identical requests that arrive together share one paid generation. The job is registered synchronously,
  // before anything is awaited, otherwise two simultaneous requests could both pass the check and both pay.
  const pending = new Map(); // icon key -> Promise<{ image, prompt }>

  // Only these reasons are kept for diagnosis: no text, no IP, just what failed and where it ran.
  const FAILURE_CODES = new Set(['upstream_region', 'upstream_error', 'upstream_timeout']);

  async function recordFailure(err, ctx) {
    if (err.code === 'rate_limited' || err.code === 'daily_limit') return; // expected, not a failure
    try {
      const code = FAILURE_CODES.has(err.code) ? err.code : 'unexpected';
      await Promise.all([
        store.counters.add(`fail_${code}`, 1),
        store.setJson('last_failure', {
          at: new Date().toISOString(),
          code,
          status: err.status ?? null,
          message: String(err.message).slice(0, 200),
          country: ctx.country ?? null,
          colo: ctx.colo ?? null,
        }),
      ]);
    } catch (e) {
      console.error('[image] could not record the failure:', e.message);
    }
  }

  function generateOnce(key, type, text, ctx) {
    const running = pending.get(key);
    if (running) return running;

    const job = (async () => {
      await checkRate(ctx.ip);
      const prompt = buildPrompt(type, text);
      const { image, usage } = await generateImage(prompt);
      const cost = await ledger.recordGeneration(cfg.model, usage);
      // never fail a request that has already been paid for because the keepsake copy could not be stored
      if (image.length < 900_000) await store.images.put(key, image).catch((err) => console.error('[image] could not keep a copy:', err.message));
      const b = await ledger.status();
      console.log(`[image] ${cfg.model} +$${cost.usd.toFixed(4)}${cost.estimated ? ' (estimated)' : ''} | total $${b.spentUsd.toFixed(4)} / $${b.warnAtUsd} warn line`);
      if (b.overBudget) console.warn(`BUDGET WARNING: spent $${b.spentUsd.toFixed(2)}, over the $${b.warnAtUsd} warn line`);
      return { image, prompt };
    })()
      .catch(async (err) => {
        await recordFailure(err, ctx);
        throw err;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
    // If the visitor's connection drops while this runs, the paid image must still be finished and kept, so that a retry
    // finds it ready instead of paying again. (On a Worker, waitUntil keeps the job alive after the client has gone.)
    ctx.waitUntil?.(job.catch(() => {}));
    return job;
  }

  // ---------- 飞盘计分 (a frisbee day: teams take turns, every point is saved here so all phones see the same score) ----------

  const FB_ID_RE = /^[a-z0-9]{6,32}$/;
  // a team or player name: no spaces, nothing that splits a roster line, nothing HTML could misread
  const FB_NAME_RE = /^[^\s<>&"'`\\|｜:：,，、]+$/u;
  const fbName = (s, max) => typeof s === 'string' && [...s].length <= max && FB_NAME_RE.test(s);
  // Every open page asks every few seconds whether anything changed. The answer is remembered for a moment, so most of
  // those polls cost no database call: a change made through this copy of the Worker updates it at once, one made
  // through another copy shows up within 2 s.
  const fbRevs = new Map(); // game -> { rev, at }
  let fbLatest = { id: null, at: 0 };

  async function fbRev(game) {
    const hit = fbRevs.get(game);
    if (hit && Date.now() - hit.at < 2000) return hit.rev;
    const rev = await store.frisbee.rev(game);
    fbRevs.set(game, { rev, at: Date.now() });
    return rev;
  }

  async function fbLatestId() {
    if (Date.now() - fbLatest.at < 15_000) return fbLatest.id;
    fbLatest = { id: await store.frisbee.latest(), at: Date.now() };
    return fbLatest.id;
  }

  // teams: [{ name, groups: [[player, ...], [player, ...]] }] (two groups = the two rows the roster was written in)
  function fbTeams(teams) {
    if (!Array.isArray(teams) || teams.length < 2 || teams.length > 4) throw new HttpError(400, 'bad_teams', '需要 2–4 支队伍');
    const names = new Set();
    return teams.map((t, i) => {
      const name = String(t?.name ?? '').trim();
      if (!fbName(name, 8) || names.has(name)) throw new HttpError(400, 'bad_teams', `第 ${i + 1} 队的队名不行（1–8 个字，不重复，不带空格和标点）`);
      names.add(name);
      const groups = (Array.isArray(t.groups) ? t.groups : []).slice(0, 2).map((g) => (Array.isArray(g) ? g : []).map((n) => String(n ?? '').trim()));
      const players = groups.flat();
      const bad = players.find((n, k) => !fbName(n, 12) || players.indexOf(n) !== k);
      if (bad !== undefined) throw new HttpError(400, 'bad_teams', `${name}的「${bad}」不行（名字 1–12 个字，同一队不重名）`);
      if (players.length < 1 || players.length > 20) throw new HttpError(400, 'bad_teams', `${name}需要 1–20 个人`);
      return { name, groups };
    });
  }

  async function fbWriteLimit(ip) {
    const minute = Math.floor(Date.now() / 60_000);
    if ((await store.counters.hit(`fb:${ip}:${minute}`, 120)) > 60) throw new HttpError(429, 'rate_limited', '记得太快了，歇一下再试');
  }

  // ---------- routes ----------

  async function route(request, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/api/health' && method === 'GET') {
      return json(request, 200, {
        ok: true,
        imageConfigured: Boolean(cfg.apiKey) && !cfg.paused,
        imagePaused: cfg.paused,
        accessRequired: Boolean(cfg.accessCode) && !cfg.open,
        open: cfg.open,
        model: cfg.apiKey ? cfg.model : null,
        store: store.driver,
        ephemeralRisk,
        budget: await ledger.status(),
        lastFailure: await store.getJson('last_failure').catch(() => null),
        // where this very request entered the network (country and data-centre code only, never an address):
        // lets a visitor see which country the backend thinks they are in
        via: { country: ctx.country ?? null, colo: ctx.colo ?? null },
      });
    }

    // ----- visit log: anonymous (when, how long, which kind of device); no address, name or diary text is ever stored -----

    if (pathname === '/api/visit' && method === 'POST') {
      const minute = Math.floor(Date.now() / 60_000);
      if ((await store.counters.hit(`visit:${ctx.ip}:${minute}`, 120)) > 30) throw new HttpError(429, 'rate_limited', '请求过于频繁');
      const body = await readJson(request, 512);
      const id = String(body.id ?? '');
      if (!/^[a-z0-9]{10,20}$/.test(id)) throw new HttpError(400, 'bad_visit', '无效的访问编号');
      const device = ['phone', 'tablet', 'desktop'].includes(body.device) ? body.device : 'desktop';
      const seconds = Math.min(86_400, Math.max(0, Math.round(Number(body.seconds) || 0)));
      await store.visits.report(id, { device, seconds }, Date.now());
      return json(request, 200, { ok: true });
    }

    // the visit list: open to whoever has the link, unless a VISITS_KEY secret is set, which then becomes the password
    if (pathname === '/api/visits' && method === 'GET') {
      if (cfg.visitsKey && !safeEqual(request.headers.get('x-visits-key') ?? '', cfg.visitsKey)) throw new HttpError(401, 'unauthorized', '需要访问记录密钥');
      const limit = Math.min(500, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 200));
      return json(request, 200, { visits: await store.visits.recent(limit) });
    }

    // ----- sync: diary entries (metadata) + their small icons -----

    if (pathname === '/api/sync' && method === 'POST') {
      requireAccess(request, ctx);
      return json(request, 200, await syncer.sync(await readJson(request, 512_000)));
    }

    if (pathname === '/api/icons/get' && method === 'POST') {
      requireAccess(request, ctx);
      const { keys } = await readJson(request, 8192);
      const wanted = (Array.isArray(keys) ? keys : []).filter((k) => ICON_KEY_RE.test(k)).slice(0, 60);
      return json(request, 200, { icons: await store.icons.getMany(wanted) });
    }

    const iconRoute = pathname.match(/^\/api\/icons\/([a-f0-9]{64})$/);
    if (iconRoute && method === 'PUT') {
      requireAccess(request, ctx);
      const { image } = await readJson(request, MAX_ICON_BYTES + 2048);
      if (!isIconDataUrl(image)) throw new HttpError(400, 'bad_image', '图标格式不正确或过大');
      await store.icons.put(iconRoute[1], image);
      return json(request, 200, { ok: true });
    }

    if (pathname === '/api/generate' && method === 'POST') {
      requireAccess(request, ctx);
      const { text, type, fresh, cacheOnly } = await readJson(request);
      if (!TYPE_IDS.includes(type)) throw new HttpError(400, 'bad_type', '未知的类型');
      // a type with a fixed subject ignores the text (a long poem is fine); every other type is drawn from it
      const fixed = Boolean(typeOf(type).fixedSubject);
      const clean = fixed ? normalizeText(text).slice(0, 80) || type : normalizeText(text);
      if (!clean || clean.length > 80) throw new HttpError(400, 'bad_text', '内容需为 1–80 字');

      // Reuse an icon that was already paid for, unless the user explicitly asked for a new one.
      const key = await iconKey(type, clean);
      if (cacheOnly === true) {
        // "is there already a finished icon for this?": answers from what is stored, never generates, costs nothing
        const small = await store.icons.get(key).catch(() => null);
        const image = small ?? (await store.images.get(key).catch(() => null));
        if (image && (small || RAW_IMAGE_RE.test(image))) return json(request, 200, { image, cached: true, small: Boolean(small), iconKey: key });
        // a miss is a normal answer, not an error: it must not show up as a failed request in the browser
        return json(request, 200, { image: null, cached: false, iconKey: key });
      }
      if (fresh !== true) {
        // the small icon (uploaded by a browser) is preferred; the raw image kept at generation time is the fallback
        const small = await store.icons.get(key).catch(() => null);
        const image = small ?? (await store.images.get(key).catch(() => null));
        if (image && (small || RAW_IMAGE_RE.test(image))) {
          await ledger.recordCacheHit();
          return json(request, 200, { image, cached: true, small: Boolean(small), iconKey: key, budget: await ledger.status() });
        }
      }

      // only a real generation needs the key; looking up an icon that was already paid for never does
      if (!cfg.apiKey) throw new HttpError(503, 'not_configured', '后端未配置图像 API');
      if (cfg.paused) throw new HttpError(503, 'not_configured', '图标生成已暂停');
      const { image, prompt } = await generateOnce(key, type, clean, ctx);
      return json(request, 200, { image, prompt, cached: false, small: false, iconKey: key, budget: await ledger.status() });
    }

    // ----- 小狗跳进照片: where in this photo could a little dog stand? (a vision model points at the flat places) -----

    if (pathname === '/api/surfaces' && method === 'POST') {
      if (!cfg.ai) throw new HttpError(503, 'not_configured', '后端没有接上识别模型');
      const minute = Math.floor(Date.now() / 60_000), day = new Date().toISOString().slice(0, 10);
      if ((await store.counters.hit(`surf:${ctx.ip}:${minute}`, 120)) > 8) throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试');
      if ((await store.counters.hit(`surf:${day}`, 172_800)) > cfg.surfacesPerDay) throw new HttpError(429, 'daily_limit', '今天的识别次数用完了');
      const { image, debug } = await readJson(request, 400_000);
      if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw new HttpError(400, 'bad_image', '图片格式不正确');
      const TARGETS = [['桌面', 'the top surface of a table or desk'], ['地面', 'the floor'], ['平面', 'a flat surface where a small toy could stand']];
      // two questions per kind of place: where exactly could she stand (point), and which part of the photo is it (detect: boxes)
      const ask = async (task, target) => {
        let out = await cfg.ai.run('@cf/moondream/moondream3.1-9B-A2B', { task, image, target, max_objects: 6, stream: false });
        // some models hand back a stream or a Response: read it as JSON
        if (out instanceof ReadableStream || out instanceof Response) { const text = await new Response(out instanceof Response ? out.body : out).text(); try { out = JSON.parse(text); } catch { out = { text }; } }
        return out?.result ?? out ?? {};
      };
      const BOXES = false;
      const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
      const found = await Promise.all(TARGETS.map(async ([label, target]) => {
        // (detect, the boxes, is off: the page no longer shows the areas; set BOXES = true to ask for them again)
        const [pt, det] = await Promise.all([ask('point', target).catch((err) => ({ error: err.message })), BOXES ? ask('detect', target).catch((err) => ({ error: err.message })) : {}]);
        if (pt.error || det.error) console.error('[surfaces]', target, pt.error || det.error);
        const points = (pt.points ?? []).map((p) => [num(p.x), num(p.y)]).filter(([x, y]) => x !== null && y !== null).slice(0, 6);
        const boxes = (det.objects ?? []).map((o) => [num(o.x_min ?? o.xmin ?? o.x0), num(o.y_min ?? o.ymin ?? o.y0), num(o.x_max ?? o.xmax ?? o.x1), num(o.y_max ?? o.ymax ?? o.y1)]).filter((b) => b.every((v) => v !== null)).slice(0, 6);
        return { label, points, boxes, ...(debug === true ? { raw: JSON.stringify({ pt, det }).slice(0, 900) } : {}) };
      }));
      return json(request, 200, { surfaces: found });
    }

    // ----- 飞盘计分: for every point, which two teams played, which of them scored and who threw the assist -----

    // one game as it stands (the newest unless `game` is given); `rev` = the revision the page already has
    if (pathname === '/api/frisbee/state' && method === 'POST') {
      const { game: asked, rev } = await readJson(request, 512);
      const latest = await fbLatestId();
      const game = FB_ID_RE.test(String(asked ?? '')) ? asked : latest;
      if (!game) return json(request, 200, { game: null, latest: null });
      if (Number.isInteger(rev) && rev === (await fbRev(game))) return json(request, 200, { game, latest, rev, same: true });
      const state = await store.frisbee.state(game);
      if (!state) throw new HttpError(404, 'no_game', '没有这场比赛');
      fbRevs.set(game, { rev: state.rev, at: Date.now() });
      return json(request, 200, { game, latest, ...state });
    }

    if (pathname === '/api/frisbee/games' && method === 'POST') {
      return json(request, 200, { games: await store.frisbee.list(40), latest: await fbLatestId() });
    }

    // record a point ({ game, id, at, a, b, team, assist, by }), take one back ({ game, id, deleted: true }) or put it back (false)
    if (pathname === '/api/frisbee/point' && method === 'POST') {
      await fbWriteLimit(ctx.ip);
      const p = await readJson(request, 2048);
      const game = String(p.game ?? ''), id = String(p.id ?? '');
      if (!FB_ID_RE.test(game) || !FB_ID_RE.test(id)) throw new HttpError(400, 'bad_point', '比赛或这一分的编号不对');
      const info = await store.frisbee.info(game);
      if (!info) throw new HttpError(404, 'no_game', '没有这场比赛');
      let rev;
      if (typeof p.deleted === 'boolean') rev = await store.frisbee.setDeleted(game, id, p.deleted);
      else {
        const isTeam = (v) => Number.isInteger(v) && v >= 0 && v < info.teams.length;
        if (!isTeam(p.a) || !isTeam(p.b) || p.a === p.b || (p.team !== p.a && p.team !== p.b)) throw new HttpError(400, 'bad_point', '对战的两队或得分的队不对');
        const assist = p.assist === null || p.assist === undefined || p.assist === '' ? null : String(p.assist).trim();
        if (assist !== null && !fbName(assist, 12)) throw new HttpError(400, 'bad_point', '助攻的名字不对');
        const now = Date.now();
        // when the point was recorded on the phone: it may only upload later, from a field without signal
        const at = Number.isFinite(p.at) && p.at > now - 30 * 86_400_000 && p.at < now + 600_000 ? Math.round(p.at) : now;
        const by = FB_ID_RE.test(String(p.by ?? '')) ? p.by : null;
        rev = await store.frisbee.addPoint(game, { id, at, a: p.a, b: p.b, team: p.team, assist, by, t: now });
      }
      fbRevs.set(game, { rev, at: Date.now() });
      return json(request, 200, { ok: true, rev });
    }

    // start a new game ({ teams }), or rename the teams and players of one ({ game, teams })
    if (pathname === '/api/frisbee/game' && method === 'POST') {
      await fbWriteLimit(ctx.ip);
      const p = await readJson(request, 8192);
      const teams = fbTeams(p.teams);
      if (p.game !== undefined) {
        const game = String(p.game);
        const info = FB_ID_RE.test(game) ? await store.frisbee.info(game) : null;
        if (!info) throw new HttpError(404, 'no_game', '没有这场比赛');
        // points name their teams by position, so a game keeps its number of teams
        if (teams.length !== info.teams.length) throw new HttpError(400, 'bad_teams', `这场是 ${info.teams.length} 支队伍，要换队伍数就开新的一场`);
        const rev = await store.frisbee.putInfo(game, { ...info, teams, edited: Date.now() });
        fbRevs.set(game, { rev, at: Date.now() });
        return json(request, 200, { game, rev });
      }
      if ((await store.counters.hit(`fbnew:${new Date().toISOString().slice(0, 10)}`, 172_800)) > 30) throw new HttpError(429, 'daily_limit', '今天开的比赛太多了');
      const created = Date.now();
      const game = `g${created.toString(36)}${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
      await store.frisbee.create(game, { teams, created });
      fbLatest = { id: game, at: Date.now() };
      return json(request, 200, { game, rev: 1 });
    }

    throw new HttpError(404, 'not_found', '接口不存在');
  }

  // ctx: { isLocal: boolean, ip: string } supplied by the runtime-specific entry point
  async function handle(request, ctx = {}) {
    const context = { isLocal: ctx.isLocal === true, ip: ctx.ip || 'unknown', country: ctx.country, colo: ctx.colo, waitUntil: ctx.waitUntil };
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
      await ready;
      return await route(request, context);
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) console.error(err);
      return json(
        request,
        known ? err.status : 500,
        { error: err.code || 'server_error', message: known ? err.message : '服务器错误' },
        err.status === 413 ? { connection: 'close' } : {},
      );
    }
  }

  return { handle, ready, ledger };
}
