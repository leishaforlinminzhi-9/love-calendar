import { randomUUID } from 'node:crypto';
import { normalizeText } from './prompt.js';

const DAY = 86_400_000;
const ICON_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const ICON_KEY_RE = /^[a-f0-9]{64}$/;
export const MAX_ICON_BYTES = 200_000;

export function isIconDataUrl(value) {
  return typeof value === 'string' && value.length <= MAX_ICON_BYTES && ICON_RE.test(value);
}

// Entries arrive from browsers, so everything is re-validated here.
function sanitize(raw, typeIds) {
  const slot = Number(raw?.slot);
  if (typeof raw?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) || ![0, 1].includes(slot)) return null;
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const deleted = raw.deleted === true;
  const text = deleted ? '' : normalizeText(raw.text).slice(0, 60);
  if (!deleted && !text) return null;
  return {
    id: `${raw.date}_${slot}`,
    date: raw.date,
    slot,
    text,
    type: typeIds.includes(raw.type) ? raw.type : 'other',
    deleted,
    createdAt: Number(raw.createdAt) || updatedAt,
    // a device with a wrong clock must not be able to win every conflict forever
    updatedAt: Math.min(updatedAt, Date.now() + DAY),
  };
}

// Last-writer-wins per entry (by updatedAt). Deletions are tombstones so they propagate to other devices.
export function createSync({ store, iconKeyFor, typeIds }) {
  let epochPromise = null;

  // A random id created together with the data. If the server's data is ever lost/reset the epoch changes,
  // which tells every device to push its full copy again instead of trusting an old cursor.
  function ensureEpoch() {
    epochPromise ??= (async () => {
      const meta = await store.getJson('meta');
      if (meta?.epoch) return meta.epoch;
      const epoch = randomUUID();
      await store.setJson('meta', { epoch, createdAt: new Date().toISOString() });
      return epoch;
    })();
    return epochPromise;
  }

  async function sync(body) {
    const epoch = await ensureEpoch();
    const current = new Map((await store.entries.all()).map((e) => [e.id, e]));

    for (const raw of (Array.isArray(body?.changes) ? body.changes : []).slice(0, 2000)) {
      const change = sanitize(raw, typeIds);
      if (!change) continue;
      const existing = current.get(change.id);
      if (existing && existing.updatedAt >= change.updatedAt) continue;
      const entry = { ...change, iconKey: change.deleted ? null : iconKeyFor(change.type, change.text), rev: await store.incr('rev') };
      await store.entries.put(entry.id, entry);
      current.set(entry.id, entry);
    }

    const knownEpoch = typeof body?.epoch === 'string' ? body.epoch : null;
    const epochChanged = knownEpoch !== null && knownEpoch !== epoch;
    const since = knownEpoch === epoch ? Number(body?.since) || 0 : 0;
    const all = [...current.values()];
    return {
      epoch,
      resync: epochChanged,
      cursor: all.reduce((max, e) => Math.max(max, e.rev ?? 0), 0),
      entries: all.filter((e) => (e.rev ?? 0) > since),
    };
  }

  return { sync };
}
