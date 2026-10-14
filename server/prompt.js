import { typeOf } from '../frontend/love-types.js';

// Bump when the look of the icon set is changed on purpose: it invalidates the image cache.
// v2: the subject is taken from the user's text (v1 always drew the type's fixed picture, e.g. a bowl of soup for any food).
export const PROMPT_VERSION = 2;

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
  const subject = moment && !t.fixedSubject
    ? `Moment: "${moment}" (category: ${t.theme}).\n` +
      'Subject: draw the ONE most recognisable concrete object from this moment, the thing it actually mentions (the real food, gift, item or place), ' +
      'as a single simple, charming object, optionally with one tiny heart or sparkle. Never swap it for a different object.\n' +
      `If the moment mentions no concrete object (only words, feelings or actions), draw this instead: ${t.motif}.`
    : `Subject: ${t.motif}.`;
  return [
    'A cute app icon illustration for a warm love-journal app.',
    subject,
    'Composition: a single centered subject filling about 70% of the canvas, keep background props minimal, ' +
      `on a full-bleed square canvas with a smooth ${t.colorName} gradient background going from ${t.from} to ${t.to}.`,
    `Palette: built around ${t.colorName} (${t.color}) and cream white, with small accents of ${t.accentName}.`,
    `Style: ${STYLE}`,
    NEGATIVE,
    'Keep exactly the same style, lighting and level of detail as the rest of the icon set.',
  ].join('\n');
}
