import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Durable storage behind sync. Both drivers expose the same small async interface:
//   getJson(name) / setJson(name, value)   small documents (spend ledger, server meta)
//   entries.all() / entries.put(id, entry)  the diary entries (metadata only, a few hundred bytes each)
//   icons.get(key) / icons.put(key, url)    the small icon images, stored apart from the entries
//   incr(name)                              monotonic counters (sync revision)

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

// Plain files: perfect for running on your own computer, or on a host with a persistent disk.
export function createFileStore(dir) {
  mkdirSync(join(dir, 'icons'), { recursive: true });
  const docFile = (name) => join(dir, `${name}.json`);
  const entriesFile = join(dir, 'entries.json');
  const countersFile = join(dir, 'counters.json');

  let entries = readJsonFile(entriesFile, {});
  let counters = readJsonFile(countersFile, {});

  return {
    driver: 'file',
    durable: true,
    async getJson(name) {
      return readJsonFile(docFile(name), null);
    },
    async setJson(name, value) {
      writeJsonFile(docFile(name), value);
    },
    entries: {
      async all() {
        return Object.values(entries);
      },
      async put(id, entry) {
        entries[id] = entry;
        writeJsonFile(entriesFile, entries);
      },
    },
    icons: {
      async get(key) {
        const file = join(dir, 'icons', `${key}.txt`);
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
      },
      async put(key, dataUrl) {
        writeFileSync(join(dir, 'icons', `${key}.txt`), dataUrl);
      },
    },
    async incr(name) {
      counters[name] = (counters[name] ?? 0) + 1;
      writeJsonFile(countersFile, counters);
      return counters[name];
    },
  };
}

// Upstash Redis over its REST API: free tier, durable, no driver needed (plain fetch).
export function createUpstashStore({ url, token }) {
  const base = url.replace(/\/+$/, '');

  async function cmd(...args) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(`Upstash ${args[0]} failed: ${json.error ?? res.status}`);
    return json.result;
  }

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
      async put(id, entry) {
        await cmd('HSET', 'love:entries', id, JSON.stringify(entry));
      },
    },
    icons: {
      async get(key) {
        return (await cmd('GET', `love:icon:${key}`)) ?? null;
      },
      async put(key, dataUrl) {
        await cmd('SET', `love:icon:${key}`, dataUrl);
      },
    },
    async incr(name) {
      return Number(await cmd('INCR', `love:counter:${name}`));
    },
  };
}

export function createStore({ dir, env }) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? createUpstashStore({ url, token }) : createFileStore(dir);
}
