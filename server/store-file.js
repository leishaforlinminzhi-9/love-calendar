import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Plain files: perfect for running on your own computer. Same interface as the Upstash store (Node only).

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

export function createFileStore(dir) {
  mkdirSync(join(dir, 'icons'), { recursive: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  const docFile = (name) => join(dir, `${name}.json`);
  const entriesFile = join(dir, 'entries.json');
  const countersFile = join(dir, 'counters.json');

  const entries = readJsonFile(entriesFile, {});
  const counters = readJsonFile(countersFile, {});
  const windows = new Map(); // rate-limit windows live in memory only: they are meant to be short-lived
  const saveCounters = () => writeJsonFile(countersFile, counters);
  const iconFile = (key) => join(dir, 'icons', `${key}.txt`);

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
      async putMany(list) {
        if (!list.length) return;
        for (const e of list) entries[e.id] = e;
        writeJsonFile(entriesFile, entries);
      },
    },

    icons: {
      async get(key) {
        return existsSync(iconFile(key)) ? readFileSync(iconFile(key), 'utf8') : null;
      },
      async getMany(keys) {
        const found = {};
        for (const k of keys) if (existsSync(iconFile(k))) found[k] = readFileSync(iconFile(k), 'utf8');
        return found;
      },
      async put(key, dataUrl) {
        writeFileSync(iconFile(key), dataUrl);
      },
    },

    // raw generated images: kept so an image that was already paid for is never generated again
    images: {
      async get(key) {
        const file = join(dir, 'cache', `${key}.txt`);
        return existsSync(file) ? readFileSync(file, 'utf8') : null;
      },
      async put(key, dataUrl) {
        writeFileSync(join(dir, 'cache', `${key}.txt`), dataUrl);
      },
    },

    counters: {
      async getMany(names) {
        return names.map((n) => counters[n] ?? null);
      },
      async add(name, amount) {
        counters[name] = (counters[name] ?? 0) + amount;
        saveCounters();
        return counters[name];
      },
      async addMany(amounts) {
        for (const [n, a] of Object.entries(amounts)) counters[n] = (counters[n] ?? 0) + a;
        saveCounters();
      },
      async setIfMissing(name, value) {
        if (counters[name] === undefined) {
          counters[name] = Number(value);
          saveCounters();
        }
      },
      async hit(name, ttlSeconds) {
        const now = Date.now();
        const w = windows.get(name);
        if (!w || w.expires < now) {
          windows.set(name, { n: 1, expires: now + ttlSeconds * 1000 });
          if (windows.size > 5000) for (const [k, v] of windows) if (v.expires < now) windows.delete(k);
          return 1;
        }
        w.n += 1;
        return w.n;
      },
    },
  };
}
