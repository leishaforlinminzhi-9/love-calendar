import { createApp } from './app.js';
import { createUpstashStore } from './store-upstash.js';

// Cloudflare Workers entry point (free hosting, no sleeping). It serves the API only; the frontend stays on
// GitHub Pages. Configuration comes from wrangler.toml [vars] and from secrets (`wrangler secret put ...`).

let appPromise = null;

const REQUIRED = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];

async function build(env) {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) throw Object.assign(new Error(`missing ${missing.join(', ')}`), { missing });
  const store = createUpstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  const app = createApp({ env, store });
  await app.ready;
  return app;
}

export default {
  async fetch(request, env, executionCtx) {
    try {
      appPromise ??= build(env);
      const app = await appPromise;
      // a Worker always sits behind Cloudflare's edge, so no request counts as "local"
      return await app.handle(request, {
        isLocal: false,
        ip: request.headers.get('cf-connecting-ip') || 'unknown',
        country: request.cf?.country,
        colo: request.cf?.colo,
        waitUntil: (promise) => executionCtx.waitUntil(promise),
      });
    } catch (err) {
      appPromise = null; // retry from scratch on the next request instead of caching a failure
      console.error('startup failed:', err.message);
      // Say WHAT is wrong, never the values: names of missing settings, or Upstash's own error text (it never contains our token).
      const missing = err.missing ?? [];
      const storeError = missing.length === 0 && String(err.message).startsWith('Upstash');
      const message = missing.length ? `后端缺少配置：${missing.join('、')}` : storeError ? '后端连不上数据库，请检查 Upstash 的地址和令牌' : '后端启动失败';
      return new Response(JSON.stringify({ error: 'misconfigured', message, ...(missing.length ? { missing } : {}), ...(storeError ? { detail: String(err.message).slice(0, 160) } : {}) }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
      });
    }
  },
};
