// USD per 1M tokens: [text input, image input, image output].
// Source: OpenAI pricing page (checked 2026-10-13). Override with PRICE_PER_M="text,imageIn,imageOut".
const RATES = {
  'gpt-image-1': [5, 10, 40],
  'gpt-image-1-mini': [2, 2.5, 8],
  'gpt-image-1.5': [5, 8, 32],
  'gpt-image-2': [5, 8, 30],
  'gpt-image-2.5-flare': [5, 8, 30],
  'gpt-image-2.5-sunburst': [5, 8, 30],
  'chatgpt-image-latest': [5, 8, 32],
};

function ratesFor(model, override) {
  if (override) return override;
  const key = Object.keys(RATES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? RATES[key] : null;
}

function parseOverride(text) {
  const nums = String(text ?? '').split(',').map(Number);
  return nums.length === 3 && nums.every((n) => Number.isFinite(n) && n >= 0) ? nums : null;
}

// Running total of what this server has spent on the image API. It lives in the durable store, so it
// survives restarts (and, with Upstash, redeploys). Call init() once before use.
export function createLedger({ store, warnAtUsd, fallbackCostUsd, priceOverride }) {
  const override = parseOverride(priceOverride);
  let data = { totalUsd: 0, generations: 0, cacheHits: 0, since: new Date().toISOString() };
  let writes = Promise.resolve();

  const persist = () => {
    const snapshot = { ...data };
    writes = writes
      .then(() => store.setJson('ledger', snapshot))
      .catch((err) => console.error('[ledger] could not save:', err.message));
  };

  function costOf(model, usage) {
    const rates = ratesFor(model, override);
    const textIn = usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens;
    const imageIn = usage?.input_tokens_details?.image_tokens ?? 0;
    const out = usage?.output_tokens;
    if (!rates || !Number.isFinite(textIn) || !Number.isFinite(out)) return { usd: fallbackCostUsd, estimated: true };
    return { usd: (textIn * rates[0] + imageIn * rates[1] + out * rates[2]) / 1e6, estimated: false };
  }

  return {
    async init() {
      const saved = await store.getJson('ledger');
      if (saved) data = { ...data, ...saved };
    },
    status() {
      return {
        spentUsd: Math.round(data.totalUsd * 1e4) / 1e4,
        warnAtUsd,
        overBudget: data.totalUsd >= warnAtUsd,
        generations: data.generations,
        cacheHits: data.cacheHits,
        since: data.since,
      };
    },
    recordGeneration(model, usage) {
      const cost = costOf(model, usage);
      data.totalUsd += cost.usd;
      data.generations += 1;
      persist();
      return cost;
    },
    recordCacheHit() {
      data.cacheHits += 1;
      persist();
    },
  };
}
