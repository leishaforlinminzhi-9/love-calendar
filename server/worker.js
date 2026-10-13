import { createApp } from './app.js';
import { createUpstashStore } from './store-upstash.js';

// Cloudflare Workers entry point (free hosting, no sleeping). It serves the API only; the frontend stays on
// GitHub Pages. Configuration comes from wrangler.toml [vars] and from secrets (`wrangler secret put ...`).

let appPromise = null;

async function build(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN secrets');
  }
  const store = createUpstashStore({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  const app = createApp({ env, store });
  await app.ready;
  return app;
}

export default {
  async fetch(request, env) {
    try {
      appPromise ??= build(env);
      const app = await appPromise;
      // a Worker always sits behind Cloudflare's edge, so no request counts as "local"
      return await app.handle(request, { isLocal: false, ip: request.headers.get('cf-connecting-ip') || 'unknown' });
    } catch (err) {
      appPromise = null; // retry from scratch on the next request instead of caching a failure
      console.error('startup failed:', err.message);
      return new Response(JSON.stringify({ error: 'misconfigured', message: '后端配置不完整，请检查 Upstash 和密钥' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
      });
    }
  },
};
