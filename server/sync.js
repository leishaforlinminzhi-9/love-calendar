import { normalizeText } from './prompt.js';

const DAY = 86_400_000;
const ICON_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export const ICON_KEY_RE = /^[a-f0-9]{64}$/;
export const MAX_ICON_BYTES = 200_000;

export function isIconDataUrl(value) {
  return typeof value === 'string' && value.length <= MAX_ICON_BYTES && ICON_RE.test(value);
}

// Slots 0 and 1 are the daily pair; slots 2..MAX_SLOT hold "redeemed" extras written on a later day.
const MAX_SLOT = 5;

// Entries arrive from browsers, so everything is re-validated here.
function sanitize(raw, typeIds) {
  const slot = Number(raw?.slot);
  if (typeof raw?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) || !Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) return null;
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  // 'busy' = "too busy, banked for later": a placeholder in one of the two daily slots, no text
  const kind = raw.kind === 'busy' ? 'busy' : 'love';
  if (kind === 'busy' && slot > 1) return null;
  const deleted = raw.deleted === true;
  const text = deleted || kind === 'busy' ? '' : normalizeText(raw.text).slice(0, 60);
  if (!deleted && kind === 'love' && !text) return null;
  return {
    id: `${raw.date}_${slot}`,
    date: raw.date,
    slot,
    kind,
    text,
    type: kind === 'love' && typeIds.includes(raw.type) ? raw.type : 'other',
    deleted,
    createdAt: Number(raw.createdAt) || updatedAt,
    // a device with a wrong clock must not be able to win every conflict forever
    updatedAt: Math.min(updatedAt, Date.now() + DAY),
  };
}

// Last-writer-wins per entry (by updatedAt). Deletions are tombstones so they propagate to other devices.
// Everything a sync needs from the store is a handful of batched calls, however many entries are pushed.
export function createSync({ store, iconKeyFor, typeIds }) {
  let epochPromise = null;

  // A random id created together with the data. If the server's data is ever lost/reset the epoch changes,
  // which tells every device to push its full copy again instead of trusting an old cursor.
  function ensureEpoch() {
    epochPromise ??= (async () => {
      const meta = await store.getJson('meta');
      if (meta?.epoch) return meta.epoch;
      const epoch = crypto.randomUUID();
      await store.setJson('meta', { epoch, createdAt: new Date().toISOString() });
      return epoch;
    })().catch((err) => {
      epochPromise = null; // let the next request retry instead of caching a failure
      throw err;
    });
    return epochPromise;
  }

  async function sync(body) {
    const epoch = await ensureEpoch();
    const current = new Map((await store.entries.all()).map((e) => [e.id, e]));

    // keep only changes that are newer than what is stored (a later change to the same id replaces an earlier one)
    const accepted = new Map();
    for (const raw of (Array.isArray(body?.changes) ? body.changes : []).slice(0, 2000)) {
      const change = sanitize(raw, typeIds);
      if (!change) continue;
      const existing = current.get(change.id);
      if (existing && existing.updatedAt >= change.updatedAt) continue;
      accepted.set(change.id, change);
      current.set(change.id, change);
    }

    if (accepted.size) {
      const last = await store.counters.add('rev', accepted.size); // reserve a block of revisions in one call
      const first = last - accepted.size + 1;
      const written = await Promise.all(
        [...accepted.values()].map(async (c, i) => ({
          ...c,
          iconKey: c.deleted || c.kind === 'busy' ? null : await iconKeyFor(c.type, c.text),
          rev: first + i,
        })),
      );
      await store.entries.putMany(written);
      for (const e of written) current.set(e.id, e);
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
