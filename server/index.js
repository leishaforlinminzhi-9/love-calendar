import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createFileStore } from './store-file.js';
import { createUpstashStore } from './store-upstash.js';

// Node entry point: local use (and any host that runs Node). Cloudflare Workers uses server/worker.js instead.
// This file only adapts the runtime: env, storage choice, static files, and Node request -> standard Request.

try {
  process.loadEnvFile(); // optional .env in the working directory
} catch {}

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DATA_DIR = env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const FRONTEND_DIR = fileURLToPath(new URL('../frontend/', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 600_000;

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

// Durable store: Upstash Redis when configured, plain files otherwise.
const store =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? createUpstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN })
    : createFileStore(DATA_DIR);

// Moving from the file store to Upstash: carry the spend total over instead of starting again from $0.
if (store.driver !== 'file') {
  try {
    if (!(await store.getJson('ledger')) && !(await store.getJson('ledger-meta'))) {
      await store.setJson('ledger', JSON.parse(readFileSync(join(DATA_DIR, 'ledger.json'), 'utf8')));
    }
  } catch {} // nothing to migrate, or the store is unreachable: app.ready below reports that properly
}

// Render's free disk is wiped whenever the instance restarts, so a file store there silently loses the diary.
const ephemeralRisk = Boolean(env.RENDER) && store.driver === 'file' && env.DATA_DIR_PERSISTENT !== '1';
const app = createApp({ env, store, ephemeralRisk });

try {
  await app.ready;
} catch (err) {
  console.error(`\nCannot reach the ${store.driver} store: ${err.message}\nCheck UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.\n`);
  process.exit(1);
}

// ---------- Node request -> standard Request ----------

class TooLarge extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        reject(new TooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !tooLarge && resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const headers = new Headers();
  for (const name of ['origin', 'content-type', 'x-access-code', 'x-visits-key']) {
    if (req.headers[name]) headers.set(name, String(req.headers[name]));
  }
  // behind a proxy the first X-Forwarded-For entry is the caller; directly connected loopback means "this machine"
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ctx = { isLocal: !forwarded && LOOPBACK.has(req.socket.remoteAddress), ip: forwarded || req.socket.remoteAddress || 'unknown' };

  let body;
  try {
    body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
  } catch (err) {
    if (!(err instanceof TooLarge)) throw err;
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
    res.end(JSON.stringify({ error: 'too_large', message: '请求内容过大' }));
    res.once('finish', () => req.destroy()); // answer first, then stop reading the rest of the upload
    return;
  }

  const response = await app.handle(new Request(url, { method: req.method, headers, body }), ctx);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
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
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/') || req.method === 'OPTIONS') await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url.pathname);
    else {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'method_not_allowed', message: '不支持的请求方式' }));
    }
  } catch (err) {
    console.error(err);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'server_error', message: '服务器错误' }));
  }
});

server.listen(PORT, async () => {
  const b = await app.ledger.status();
  console.log(`Love calendar running at http://localhost:${PORT}`);
  console.log(
    env.IMAGE_API_KEY
      ? `Image API: ${env.IMAGE_API_BASE || 'https://api.openai.com/v1'} (${env.IMAGE_MODEL || 'gpt-image-2.5-flare'}) | spent so far $${b.spentUsd.toFixed(4)} of $${b.warnAtUsd} warn line`
      : 'Image API: not configured (set IMAGE_API_KEY) – the app will use built-in icons.',
  );
  const openAccess = ['1', 'true', 'yes'].includes(String(env.OPEN_ACCESS ?? '').toLowerCase());
  console.log(`Sync storage: ${store.driver} | access: ${openAccess ? 'OPEN (anyone with the link can read and write)' : env.ACCESS_CODE ? 'passcode' : 'this machine only (no ACCESS_CODE)'}`);
  if (ephemeralRisk) {
    console.warn('\n!!! Running on Render with a file store: the diary is wiped on every restart. Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. !!!\n');
  }
});
