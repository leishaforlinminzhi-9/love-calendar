// Upstash Redis over its REST API: free tier, durable, plain fetch (works in Node and in Cloudflare Workers).
//
// Every store implements the same small async interface used by the rest of the server:
//   getJson(name) / setJson(name, value)    small documents
//   entries.all() / entries.putMany(list)   diary entries (metadata only)
//   icons.get / getMany / put               small icon images, kept apart from the entries
//   counters.*                              atomic numbers: revisions, spend ledger, rate limits
//   visits.report / visits.recent           the anonymous visit log (when, for how long, which kind of device)
//   frisbee.*                               飞盘计分: games (teams), their points and a revision per game
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

    // 飞盘计分: per game its teams (JSON), its points (hash: id -> JSON), the ids taken back (set) and a revision that
    // goes up with every change; the games in a sorted set by when they were started
    frisbee: {
      async latest() {
        return (await cmd('ZREVRANGE', 'love:fb:games', 0, 0))?.[0] ?? null;
      },
      async list(limit) {
        const ids = (await cmd('ZREVRANGE', 'love:fb:games', 0, limit - 1)) ?? [];
        if (!ids.length) return [];
        const rows = await pipeline([
          ...ids.flatMap((id) => [['GET', `love:fb:game:${id}`], ['HKEYS', `love:fb:points:${id}`], ['SMEMBERS', `love:fb:deleted:${id}`]]),
          ['HMGET', 'love:fb:first', ...ids],
        ]);
        const firsts = rows.at(-1) ?? [];
        return ids
          .map((id, i) => {
            const [raw, keys, deleted] = rows.slice(i * 3, i * 3 + 3);
            if (!raw) return null;
            const info = JSON.parse(raw);
            const gone = new Set(deleted ?? []);
            const first = Number(firsts[i]) || null; // when its first point was played: the game's day in the list
            return { id, created: info.created, first, teams: info.teams.map((t) => t.name), points: (keys ?? []).filter((k) => !gone.has(k)).length };
          })
          .filter(Boolean);
      },
      async info(game) {
        const raw = await cmd('GET', `love:fb:game:${game}`);
        return raw ? JSON.parse(raw) : null;
      },
      async rev(game) {
        return Number(await cmd('GET', `love:fb:rev:${game}`)) || 0;
      },
      async state(game) {
        // the revision is read first: a point written in between then simply comes again with the next revision
        const [rev, raw, flat, deleted] = await pipeline([
          ['GET', `love:fb:rev:${game}`],
          ['GET', `love:fb:game:${game}`],
          ['HGETALL', `love:fb:points:${game}`],
          ['SMEMBERS', `love:fb:deleted:${game}`],
        ]);
        if (!raw) return null;
        const gone = new Set(deleted ?? []);
        const values = Array.isArray(flat) ? flat.filter((_, i) => i % 2 === 1) : Object.values(flat ?? {});
        const points = values.map((v) => JSON.parse(v)).map((p) => (gone.has(p.id) ? { ...p, deleted: true } : p));
        return { rev: Number(rev) || 0, info: JSON.parse(raw), points };
      },
      async create(game, info) {
        await pipeline([
          ['SET', `love:fb:game:${game}`, JSON.stringify(info)],
          ['SET', `love:fb:rev:${game}`, 1],
          ['ZADD', 'love:fb:games', info.created, game],
        ]);
      },
      async putInfo(game, info) {
        const [, rev] = await pipeline([['SET', `love:fb:game:${game}`, JSON.stringify(info)], ['INCR', `love:fb:rev:${game}`]]);
        return Number(rev);
      },
      // idempotent: a phone that sends the same point twice (no answer the first time) still adds it once
      async addPoint(game, point) {
        const [, , rev] = await pipeline([
          ['HSETNX', `love:fb:points:${game}`, point.id, JSON.stringify(point)],
          ['HSETNX', 'love:fb:first', game, point.at],
          ['INCR', `love:fb:rev:${game}`],
        ]);
        return Number(rev);
      },
      async setDeleted(game, id, deleted) {
        const [, rev] = await pipeline([[deleted ? 'SADD' : 'SREM', `love:fb:deleted:${game}`, id], ['INCR', `love:fb:rev:${game}`]]);
        return Number(rev);
      },
    },
  };
}
