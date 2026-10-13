import { TYPE_IDS } from '../frontend/love-types.js';
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
    apiBase: (env.IMAGE_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    // gpt-image-1 (and -mini / 1.5) are being shut down by OpenAI between 2026-10-23 and 2026-12-01.
    model: env.IMAGE_MODEL || 'gpt-image-2.5-flare',
    size: env.IMAGE_SIZE ?? '1024x1024',
    accessCode: env.ACCESS_CODE || '',
    ratePerMin: Number(env.RATE_PER_MIN) || 6,
    dailyLimit: Number(env.DAILY_LIMIT) || 200,
    origins: (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
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
      'access-control-allow-headers': 'content-type, x-access-code',
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

  function generateOnce(key, type, text, ip) {
    const running = pending.get(key);
    if (running) return running;

    const job = (async () => {
      await checkRate(ip);
      const prompt = buildPrompt(type, text);
      const { image, usage } = await generateImage(prompt);
      const cost = await ledger.recordGeneration(cfg.model, usage);
      // never fail a request that has already been paid for because the keepsake copy could not be stored
      if (image.length < 900_000) await store.images.put(key, image).catch((err) => console.error('[image] could not keep a copy:', err.message));
      const b = await ledger.status();
      console.log(`[image] ${cfg.model} +$${cost.usd.toFixed(4)}${cost.estimated ? ' (estimated)' : ''} | total $${b.spentUsd.toFixed(4)} / $${b.warnAtUsd} warn line`);
      if (b.overBudget) console.warn(`BUDGET WARNING: spent $${b.spentUsd.toFixed(2)}, over the $${b.warnAtUsd} warn line`);
      return { image, prompt };
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  // ---------- routes ----------

  async function route(request, ctx) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (pathname === '/api/health' && method === 'GET') {
      return json(request, 200, {
        ok: true,
        imageConfigured: Boolean(cfg.apiKey),
        accessRequired: Boolean(cfg.accessCode),
        model: cfg.apiKey ? cfg.model : null,
        store: store.driver,
        ephemeralRisk,
        budget: await ledger.status(),
      });
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
      if (!cfg.apiKey) throw new HttpError(503, 'not_configured', '后端未配置图像 API');

      const { text, type, fresh } = await readJson(request);
      const clean = normalizeText(text);
      if (!clean || clean.length > 80) throw new HttpError(400, 'bad_text', '内容需为 1–80 字');
      if (!TYPE_IDS.includes(type)) throw new HttpError(400, 'bad_type', '未知的类型');

      // Reuse an icon that was already paid for, unless the user explicitly asked for a new one.
      const key = await iconKey(type, clean);
      if (fresh !== true) {
        // the small icon (uploaded by a browser) is preferred; the raw image kept at generation time is the fallback
        const small = await store.icons.get(key).catch(() => null);
        const image = small ?? (await store.images.get(key).catch(() => null));
        if (image && (small || RAW_IMAGE_RE.test(image))) {
          await ledger.recordCacheHit();
          return json(request, 200, { image, cached: true, small: Boolean(small), iconKey: key, budget: await ledger.status() });
        }
      }

      const { image, prompt } = await generateOnce(key, type, clean, ctx.ip);
      return json(request, 200, { image, prompt, cached: false, small: false, iconKey: key, budget: await ledger.status() });
    }

    throw new HttpError(404, 'not_found', '接口不存在');
  }

  // ctx: { isLocal: boolean, ip: string } supplied by the runtime-specific entry point
  async function handle(request, ctx = {}) {
    const context = { isLocal: ctx.isLocal === true, ip: ctx.ip || 'unknown' };
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
