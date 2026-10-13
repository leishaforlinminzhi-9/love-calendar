import { typeOf } from '../frontend/love-types.js';

// Bump when the look of the icon set is changed on purpose: it invalidates the image cache.
export const PROMPT_VERSION = 1;

// The style block never changes, so every icon in the calendar looks like one set.
// Only the subject (from the love type) and the palette (from the love type) vary.
const STYLE =
  'Soft 3D clay and glossy sticker look, chunky rounded shapes, gentle highlights, a soft contact shadow, ' +
  'smooth pastel gradients, warm and joyful mood, simple and instantly readable at small size.';

const NEGATIVE =
  'Strictly no text, no letters, no numbers, no watermark, no signature, no frame, no border, no rounded-corner outline, ' +
  'no people faces in realistic style, no clutter.';

export function normalizeText(text) {
  return String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); // Node 20+ and Workers
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Identifies one generated icon: (type, text, prompt version) only. The model is deliberately not part of it,
// so switching models later still reuses every image that was already paid for.
export function iconKey(type, text) {
  return sha256Hex(`v${PROMPT_VERSION}|${type}|${normalizeText(text)}`);
}

function clean(text) {
  return normalizeText(text)
    .replace(/[\u0000-\u001f"“”\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function buildPrompt(typeId, text) {
  const t = typeOf(typeId);
  const moment = clean(text);
  return [
    'A cute app icon illustration for a warm love-journal app.',
    `Subject: ${t.motif}.`,
    moment ? `Add one tiny subtle detail inspired by this moment (never draw any writing): "${moment}".` : '',
    'Composition: a single centered subject filling about 70% of the canvas, keep background props minimal, ' +
      `on a full-bleed square canvas with a smooth ${t.colorName} gradient background going from ${t.from} to ${t.to}.`,
    `Palette: built around ${t.colorName} (${t.color}) and cream white, with small accents of ${t.accentName}.`,
    `Style: ${STYLE}`,
    NEGATIVE,
    'Keep exactly the same style, lighting and level of detail as the rest of the icon set.',
  ]
    .filter(Boolean)
    .join('\n');
}
