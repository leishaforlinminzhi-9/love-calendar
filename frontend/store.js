// Tiny IndexedDB wrapper. Falls back to memory if IndexedDB is blocked (e.g. some private modes).

const DB_NAME = 'love-calendar';
const STORE = 'entries';

let dbPromise = null;
const memory = new Map();
export let persistent = true;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => {
    persistent = false;
    return null;
  });
  return dbPromise;
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAll() {
  const db = await open();
  if (!db) return [...memory.values()];
  return run(db, 'readonly', (s) => s.getAll());
}

export async function save(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const db = await open();
  if (!db) return list.forEach((e) => memory.set(e.id, e));
  await run(db, 'readwrite', (s) => list.forEach((e) => s.put(e)));
}

export async function remove(id) {
  const db = await open();
  if (!db) return void memory.delete(id);
  await run(db, 'readwrite', (s) => s.delete(id));
}

export async function clear() {
  const db = await open();
  if (!db) return memory.clear();
  await run(db, 'readwrite', (s) => s.clear());
}
