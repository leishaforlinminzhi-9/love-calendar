// Tiny IndexedDB wrapper. Falls back to memory if IndexedDB is blocked (e.g. some private modes).
// Saving never throws: every record is also kept in memory, and a failed write is reported so the app can say so.

const DB_NAME = 'love-calendar';
const STORE = 'entries';

let dbPromise = null;
const memory = new Map();
export let persistent = true;
let reportFailure = () => {};

// called once with a function that tells the user the device could not store their records
export function onPersistFailure(fn) {
  reportFailure = fn;
}

function failed(err) {
  console.error('local storage failed:', err);
  if (persistent) reportFailure(err);
  persistent = false;
}

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
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export async function loadAll() {
  const db = await open();
  if (!db) return [...memory.values()];
  return run(db, 'readonly', (s) => s.getAll());
}

export async function save(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  list.forEach((e) => memory.set(e.id, e)); // always keep a copy in memory, whatever happens next
  const db = await open();
  if (!db) return;
  try {
    await run(db, 'readwrite', (s) => list.forEach((e) => s.put(e)));
  } catch (err) {
    failed(err);
  }
}

export async function remove(id) {
  memory.delete(id);
  const db = await open();
  if (!db) return;
  try {
    await run(db, 'readwrite', (s) => s.delete(id));
  } catch (err) {
    failed(err);
  }
}

export async function clear() {
  memory.clear();
  const db = await open();
  if (!db) return;
  try {
    await run(db, 'readwrite', (s) => s.clear());
  } catch (err) {
    failed(err);
  }
}
