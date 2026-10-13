import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_VERSION, normalizeText } from './prompt.js';

// Generated icons are kept on disk, keyed by (type, text, prompt version) only. The model is deliberately
// not part of the key, so switching models later still reuses every image that was already paid for.
export function createImageCache(dir) {
  const root = join(dir, 'cache');
  mkdirSync(root, { recursive: true });
  const pathFor = (key) => join(root, `${key}.txt`);

  return {
    key(type, text) {
      return createHash('sha256').update(`v${PROMPT_VERSION}|${type}|${normalizeText(text)}`).digest('hex');
    },
    get(key) {
      try {
        const dataUrl = readFileSync(pathFor(key), 'utf8');
        return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) ? dataUrl : null;
      } catch {
        return null;
      }
    },
    set(key, dataUrl) {
      writeFileSync(pathFor(key), dataUrl);
    },
  };
}
