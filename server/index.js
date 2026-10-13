import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { TYPE_IDS } from '../frontend/love-types.js';
import { buildPrompt, normalizeText } from './prompt.js';
import { createImageCache } from './cache.js';
import { createLedger } from './spend.js';
import { createStore } from './store.js';
import { createSync, isIconDataUrl, ICON_KEY_RE, MAX_ICON_BYTES } from './sync.js';

try {
  process.loadEnvFile(); // optional .env in the working directory
} catch {}

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const IMAGE_API_KEY = env.IMAGE_API_KEY || '';
const IMAGE_API_BASE = (env.IMAGE_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
// gpt-image-1 (and -mini / 1.5) are being shut down by OpenAI between 2026-10-23 and 2026-12-01.
const IMAGE_MODEL = env.IMAGE_MODEL || 'gpt-image-2.5-flare';
const IMAGE_SIZE = env.IMAGE_SIZE ?? '1024x1024';
const ACCESS_CODE = env.ACCESS_CODE || '';
const RATE_PER_MIN = Number(env.RATE_PER_MIN) || 6;
const DAILY_LIMIT = Number(env.DAILY_LIMIT) || 200;
const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const DATA_DIR = env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const BUDGET_WARN_USD = Number(env.BUDGET_WARN_USD) || 50;

let EXTRA_PARAMS = {};
try {
  if (env.IMAGE_PARAMS) EXTRA_PARAMS = JSON.parse(env.IMAGE_PARAMS);
} catch {
  console.warn('IMAGE_PARAMS is not valid JSON, ignoring it.');
}

// Raw generated images (best-effort, only for reuse): plain files. Everything that must survive restarts
// (diary entries, small icons, spend ledger) goes through `store`: files locally, Upstash Redis when configured.
const cache = createImageCache(DATA_DIR);
const store = createStore({ dir: DATA_DIR, env });
const ledger = createLedger({
  store,
  warnAtUsd: BUDGET_WARN_USD,
  fallbackCostUsd: Number(env.FALLBACK_COST_USD) || 0.02,
  priceOverride: env.PRICE_PER_M,
});
// Moving from the file store to Upstash: carry the spend total over instead of starting again from $0.
if (store.driver !== 'file') {
  try {
    if (!(await store.getJson('ledger'))) await store.setJson('ledger', JSON.parse(readFileSync(join(DATA_DIR, 'ledger.json'), 'utf8')));
  } catch {} // nothing to migrate, or the store is unreachable: init() below reports that properly
}
try {
  await ledger.init(); // first real read from the store: a wrong Upstash URL/token fails here, at startup
} catch (err) {
  console.error(`\nCannot reach the ${store.driver} store: ${err.message}\nCheck UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.\n`);
  process.exit(1);
}
const syncer = createSync({ store, iconKeyFor: (type, text) => cache.key(type, text), typeIds: TYPE_IDS });
// Render's free disk is wiped whenever the instance restarts, so a file store there silently loses the diary.
const EPHEMERAL_RISK = Boolean(env.RENDER) && store.driver === 'file' && env.DATA_DIR_PERSISTENT !== '1';

const FRONTEND_DIR = fileURLToPath(new URL('../frontend/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- helpers ----------

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = {
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type, x-access-code',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (ALLOWED_ORIGINS.includes('*')) headers['access-control-allow-origin'] = '*';
  else if (origin && ALLOWED_ORIGINS.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function sendJson(req, res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(req) });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        reject(new HttpError(413, 'too_large', '请求内容过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'bad_json', '请求格式不正确'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function checkAccess(req) {
  if (!ACCESS_CODE) return;
  const given = Buffer.from(String(req.headers['x-access-code'] || ''));
  const want = Buffer.from(ACCESS_CODE);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new HttpError(401, 'unauthorized', '需要正确的访问口令');
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// The diary is private and image generation costs money, so remote callers always need the access code.
// Without ACCESS_CODE the API only answers requests coming from this very machine.
function requireAccess(req) {
  if (ACCESS_CODE) return checkAccess(req);
  if (req.headers['x-forwarded-for'] || !LOOPBACK.has(req.socket.remoteAddress)) {
    throw new HttpError(403, 'access_code_required', '后端需要先设置 ACCESS_CODE，才能被远程访问');
  }
}

const hits = new Map(); // ip -> timestamps within the last minute
let day = new Date().toDateString();
let dayCount = 0;

function checkRate(req) {
  const now = Date.now();
  const today = new Date().toDateString();
  if (today !== day) {
    day = today;
    dayCount = 0;
  }
  if (dayCount >= DAILY_LIMIT) throw new HttpError(429, 'daily_limit', '今天的生成额度用完啦，明天再来');

  const ip = clientIp(req);
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_PER_MIN) throw new HttpError(429, 'rate_limited', '生成太频繁了，稍等一分钟');
  recent.push(now);
  hits.set(ip, recent);
  dayCount += 1;

  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
}

function sniffMime(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  return 'image/png';
}

function defaultParams(model) {
  // Lowest quality is plenty for a 256px icon and is the cheapest tier; jpeg keeps the payload small.
  if (/^(gpt-image|chatgpt-image)/i.test(model)) return { quality: 'low', output_format: 'jpeg', output_compression: 85 };
  return {};
}

// ---------- image generation ----------

async function generateImage(prompt) {
  const body = {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    ...(IMAGE_SIZE ? { size: IMAGE_SIZE } : {}),
    ...defaultParams(IMAGE_MODEL),
    ...EXTRA_PARAMS,
  };

  let upstream;
  try {
    upstream = await fetch(`${IMAGE_API_BASE}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${IMAGE_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(110_000),
    });
  } catch (err) {
    console.error('[image] request failed:', err.message);
    throw new HttpError(504, 'upstream_timeout', '图像服务没有响应，请稍后重试');
  }

  const raw = await upstream.text();
  let json = {};
  try {
    json = JSON.parse(raw);
  } catch {}

  if (!upstream.ok) {
    const detail = String(json?.error?.message || json?.message || raw).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200);
    console.error(`[image] upstream ${upstream.status}:`, detail);
    throw new HttpError(502, 'upstream_error', `图像服务返回错误：${detail}`);
  }

  const item = json.data?.[0] ?? json.images?.[0];
  if (item?.b64_json) return { image: `data:${sniffMime(item.b64_json)};base64,${item.b64_json}`, usage: json.usage };
  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(30_000) });
    if (!img.ok) throw new HttpError(502, 'upstream_error', '下载生成的图片失败');
    const type = img.headers.get('content-type')?.split(';')[0] || 'image/png';
    return { image: `data:${type};base64,${Buffer.from(await img.arrayBuffer()).toString('base64')}`, usage: json.usage };
  }
  throw new HttpError(502, 'upstream_error', '图像服务没有返回图片');
}

// Identical requests that arrive together share one paid generation.
const pending = new Map(); // cache key -> Promise<{ image, prompt }>

function generateOnce(req, key, type, text) {
  let job = pending.get(key);
  if (job) return job;

  checkRate(req);
  const prompt = buildPrompt(type, text);
  job = generateImage(prompt)
    .then(({ image, usage }) => {
      const cost = ledger.recordGeneration(IMAGE_MODEL, usage);
      cache.set(key, image);
      const b = ledger.status();
      console.log(`[image] ${IMAGE_MODEL} +$${cost.usd.toFixed(4)}${cost.estimated ? ' (estimated)' : ''} | total $${b.spentUsd.toFixed(4)} / $${b.warnAtUsd} warn line`);
      if (b.overBudget) console.warn(`\n!!! BUDGET WARNING: spent $${b.spentUsd.toFixed(2)}, over the $${b.warnAtUsd} warn line !!!\n`);
      return { image, prompt };
    })
    .finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

// ---------- routes ----------

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      imageConfigured: Boolean(IMAGE_API_KEY),
      accessRequired: Boolean(ACCESS_CODE),
      model: IMAGE_API_KEY ? IMAGE_MODEL : null,
      store: store.driver,
      ephemeralRisk: EPHEMERAL_RISK,
      budget: ledger.status(),
    });
  }

  // ----- sync: diary entries (metadata) + their small icons -----

  if (pathname === '/api/sync' && req.method === 'POST') {
    requireAccess(req);
    return sendJson(req, res, 200, await syncer.sync(await readJson(req, 512_000)));
  }

  if (pathname === '/api/icons/get' && req.method === 'POST') {
    requireAccess(req);
    const { keys } = await readJson(req, 8192);
    const wanted = (Array.isArray(keys) ? keys : []).filter((k) => ICON_KEY_RE.test(k)).slice(0, 60);
    const found = await Promise.all(wanted.map(async (k) => [k, await store.icons.get(k)]));
    return sendJson(req, res, 200, { icons: Object.fromEntries(found.filter(([, image]) => image)) });
  }

  const iconRoute = pathname.match(/^\/api\/icons\/([a-f0-9]{64})$/);
  if (iconRoute && req.method === 'PUT') {
    requireAccess(req);
    const { image } = await readJson(req, MAX_ICON_BYTES + 2048);
    if (!isIconDataUrl(image)) throw new HttpError(400, 'bad_image', '图标格式不正确或太大');
    await store.icons.put(iconRoute[1], image);
    return sendJson(req, res, 200, { ok: true });
  }

  if (pathname === '/api/generate' && req.method === 'POST') {
    requireAccess(req);
    if (!IMAGE_API_KEY) throw new HttpError(503, 'not_configured', '后端还没有配置图像 API');

    const { text, type, fresh } = await readJson(req);
    const clean = normalizeText(text);
    if (!clean || clean.length > 80) throw new HttpError(400, 'bad_text', '请输入 1–80 字的爱的表达');
    if (!TYPE_IDS.includes(type)) throw new HttpError(400, 'bad_type', '未知的类型');

    // Reuse an icon that was already paid for, unless the user explicitly asked for a new one.
    const key = cache.key(type, clean);
    if (fresh !== true) {
      // the small icon in the durable store (uploaded by a browser) is preferred; the raw file cache is a fallback
      const small = await store.icons.get(key).catch(() => null);
      const image = small ?? cache.get(key);
      if (image) {
        ledger.recordCacheHit();
        return sendJson(req, res, 200, { image, cached: true, small: Boolean(small), iconKey: key, budget: ledger.status() });
      }
    }

    const { image, prompt } = await generateOnce(req, key, type, clean);
    return sendJson(req, res, 200, { image, prompt, cached: false, small: false, iconKey: key, budget: ledger.status() });
  }

  throw new HttpError(404, 'not_found', '接口不存在');
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  const file = join(FRONTEND_DIR, rel);
  if (!file.startsWith(FRONTEND_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req)).end();
    } else if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
    } else {
      throw new HttpError(405, 'method_not_allowed', '不支持的请求方式');
    }
  } catch (err) {
    if (res.headersSent) return res.end();
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(err);
    if (status === 413) {
      // answer first, then drop the connection so the rest of the upload isn't read
      res.setHeader('connection', 'close');
      res.once('finish', () => req.destroy());
    }
    sendJson(req, res, status, {
      error: err.code || 'server_error',
      message: err instanceof HttpError ? err.message : '服务器出错了',
    });
  }
});

server.listen(PORT, () => {
  const b = ledger.status();
  console.log(`Love calendar running at http://localhost:${PORT}`);
  console.log(
    IMAGE_API_KEY
      ? `Image API: ${IMAGE_API_BASE} (${IMAGE_MODEL}) | spent so far $${b.spentUsd.toFixed(4)} of $${b.warnAtUsd} warn line`
      : 'Image API: not configured (set IMAGE_API_KEY) – the app will use built-in icons.',
  );
  console.log(`Sync storage: ${store.driver}${ACCESS_CODE ? '' : ' | no ACCESS_CODE: API only answers this machine'}`);
  if (EPHEMERAL_RISK) {
    console.warn('\n!!! Running on Render with a file store: the diary is wiped on every restart. Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. !!!\n');
  }
});
