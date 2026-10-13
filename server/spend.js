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

const SPENT = 'ledger_spent_usd';
const GENERATIONS = 'ledger_generations';
const CACHE_HITS = 'ledger_cache_hits';

// Running total of what has been spent on the image API. The numbers are *atomic counters in the store*, not
// values held in memory: a Worker can run in several places at once (phone and laptop reach different data
// centers), and each of them must add to the same total instead of overwriting it.
export function createLedger({ store, warnAtUsd, fallbackCostUsd, priceOverride }) {
  const override = parseOverride(priceOverride);
  let since = new Date().toISOString();

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
      // older versions kept the totals in one JSON document: carry them over once, never double count
      const legacy = await store.getJson('ledger');
      if (legacy) {
        await store.counters.setIfMissing(SPENT, Number(legacy.totalUsd) || 0);
        await store.counters.setIfMissing(GENERATIONS, Number(legacy.generations) || 0);
        await store.counters.setIfMissing(CACHE_HITS, Number(legacy.cacheHits) || 0);
      }
      const meta = await store.getJson('ledger-meta');
      if (meta?.since) since = meta.since;
      else {
        since = legacy?.since ?? since;
        await store.setJson('ledger-meta', { since });
      }
    },
    async status() {
      const [spent, generations, cacheHits] = await store.counters.getMany([SPENT, GENERATIONS, CACHE_HITS]);
      const totalUsd = spent ?? 0;
      return {
        spentUsd: Math.round(totalUsd * 1e4) / 1e4,
        warnAtUsd,
        overBudget: totalUsd >= warnAtUsd,
        generations: generations ?? 0,
        cacheHits: cacheHits ?? 0,
        since,
      };
    },
    async recordGeneration(model, usage) {
      const cost = costOf(model, usage);
      await store.counters.addMany({ [SPENT]: cost.usd, [GENERATIONS]: 1 });
      return cost;
    },
    async recordCacheHit() {
      await store.counters.add(CACHE_HITS, 1);
    },
  };
}
