// Upstash Redis over its REST API: free tier, durable, plain fetch (works in Node and in Cloudflare Workers).
//
// Every store implements the same small async interface used by the rest of the server:
//   getJson(name) / setJson(name, value)    small documents
//   entries.all() / entries.putMany(list)   diary entries (metadata only)
//   icons.get / getMany / put               small icon images, kept apart from the entries
//   counters.*                              atomic numbers: revisions, spend ledger, rate limits
//   visits.report / visits.recent           the anonymous visit log (when, for how long, which kind of device)
//
// Calls are batched on purpose: a Cloudflare Worker may make only 50 outgoing requests per invocation.

export function createUpstashStore({ url, token }) {
  const base = url.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  async function post(path, body) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Upstash request failed: ${json.error ?? res.status}`);
    return json;
  }

  const text = (args) => args.map((a) => (typeof a === 'string' ? a : String(a)));

  async function cmd(...args) {
    const json = await post('', text(args));
    if (json.error) throw new Error(`Upstash ${args[0]} failed: ${json.error}`);
    return json.result;
  }

  // several commands in ONE outgoing request
  async function pipeline(commands) {
    const out = await post('/pipeline', commands.map(text));
    return out.map((r, i) => {
      if (r.error) throw new Error(`Upstash ${commands[i][0]} failed: ${r.error}`);
      return r.result;
    });
  }

  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const incrCommand = (amount) => (Number.isInteger(amount) ? 'INCRBY' : 'INCRBYFLOAT');

  return {
    driver: 'upstash',
    durable: true,

    async getJson(name) {
      const raw = await cmd('GET', `love:json:${name}`);
      return raw ? JSON.parse(raw) : null;
    },
    async setJson(name, value) {
      await cmd('SET', `love:json:${name}`, JSON.stringify(value));
    },

    entries: {
      async all() {
        const flat = await cmd('HGETALL', 'love:entries');
        if (!flat) return [];
        // REST returns [field, value, field, value, ...]; tolerate a map too
        const values = Array.isArray(flat) ? flat.filter((_, i) => i % 2 === 1) : Object.values(flat);
        return values.map((v) => JSON.parse(v));
      },
      async putMany(list) {
        if (!list.length) return;
        const args = ['HSET', 'love:entries'];
        for (const e of list) args.push(e.id, JSON.stringify(e));
        await cmd(...args);
      },
    },

    icons: {
      async get(key) {
        return (await cmd('GET', `love:icon:${key}`)) ?? null;
      },
      async getMany(keys) {
        if (!keys.length) return {};
        const values = await cmd('MGET', ...keys.map((k) => `love:icon:${k}`));
        return Object.fromEntries(keys.map((k, i) => [k, values[i]]).filter(([, v]) => v));
      },
      async put(key, dataUrl) {
        await cmd('SET', `love:icon:${key}`, dataUrl);
      },
    },

    // raw generated images: kept so an image that was already paid for is never generated again
    images: {
      async get(key) {
        return (await cmd('GET', `love:raw:${key}`)) ?? null;
      },
      async put(key, dataUrl) {
        await cmd('SET', `love:raw:${key}`, dataUrl);
      },
    },

    // anonymous visit log: one small hash per page visit (kept 90 days), newest ids in a sorted set capped at 2000
    visits: {
      // idempotent: the first report creates the record, later ones only raise the seconds
      async report(id, { device, seconds }, now) {
        const key = `love:visit:${id}`;
        await pipeline([
          ['HSETNX', key, 'at', now],
          ['HSETNX', key, 'device', device],
          ['HSET', key, 'seconds', seconds, 'last', now],
          ['EXPIRE', key, 90 * 86_400],
          ['ZADD', 'love:visits', 'NX', now, id],
          ['ZREMRANGEBYRANK', 'love:visits', 0, -2001],
        ]);
      },
      async recent(limit) {
        const ids = await cmd('ZREVRANGE', 'love:visits', 0, limit - 1);
        if (!ids?.length) return [];
        const rows = await pipeline(ids.map((id) => ['HGETALL', `love:visit:${id}`]));
        // HGETALL answers [field, value, field, value, ...]
        const toObject = (flat) => {
          if (!Array.isArray(flat)) return flat ?? {};
          const o = {};
          for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
          return o;
        };
        return rows
          .map((flat, i) => {
            const r = toObject(flat);
            return r.at ? { id: ids[i], at: Number(r.at), device: r.device, seconds: Number(r.seconds) || 0, last: Number(r.last) || Number(r.at) } : null;
          })
          .filter(Boolean);
      },
    },

    counters: {
      async getMany(names) {
        const values = await cmd('MGET', ...names.map((n) => `love:counter:${n}`));
        return values.map(num);
      },
      async add(name, amount) {
        return Number(await cmd(incrCommand(amount), `love:counter:${name}`, amount));
      },
      async addMany(amounts) {
        await pipeline(Object.entries(amounts).map(([n, a]) => [incrCommand(a), `love:counter:${n}`, a]));
      },
      async setIfMissing(name, value) {
        await cmd('SETNX', `love:counter:${name}`, value);
      },
      // counts events inside a time window (rate limits); the key expires on its own
      async hit(name, ttlSeconds) {
        const n = Number(await cmd('INCR', `love:rate:${name}`));
        if (n === 1) await cmd('EXPIRE', `love:rate:${name}`, ttlSeconds);
        return n;
      },
    },
  };
}
