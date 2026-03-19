// src/conditionTierPricer.js
// Feature 75 — Condition Tier Pricer
// Buckets sold comps by condition keywords found in listing titles/descriptions.
// Outputs: "New: $340. Like New: $280. Good: $220. Fair: $160."
// Automatically computed from sold comp title parsing — no manual tagging required.

// ── Condition tier definitions ────────────────────────────────────────────────
const CONDITION_TIERS = {
  new: {
    rank:     5,
    label:    "New",
    keywords: [
      "new with tags", "nwt", "brand new", "deadstock", "ds", "new in box", "nib",
      "factory sealed", "sealed", "never worn", "never used", "unworn", "unwashed",
      "new without tags", "nwot", "brand-new", "new old stock", "nos",
    ],
  },
  like_new: {
    rank:     4,
    label:    "Like New",
    keywords: [
      "like new", "like-new", "vnds", "very near deadstock", "near deadstock",
      "near mint", "nm", "mint condition", "mint", "excellent condition",
      "lightly worn", "lightly used", "barely worn", "barely used",
      "worn once", "worn 1x", "1x worn", "tried on",
    ],
  },
  good: {
    rank:     3,
    label:    "Good",
    keywords: [
      "good condition", "gently used", "good used", "good shape",
      "pre-owned", "preowned", "pre owned", "used", "light wear",
      "light use", "minor wear", "minor scuffs", "slight wear", "ex",
    ],
  },
  fair: {
    rank:     2,
    label:    "Fair",
    keywords: [
      "fair condition", "moderate wear", "moderate use", "visible wear",
      "some wear", "worn", "shows wear", "signs of wear", "used condition",
      "play condition", "beater", "well worn", "heavy use", "used heavily",
    ],
  },
  poor: {
    rank:     1,
    label:    "Poor / For Parts",
    keywords: [
      "poor condition", "heavily worn", "rough condition", "for parts",
      "as is", "as-is", "damaged", "defective", "broken", "cracked",
      "not working", "parts only", "spares",
    ],
  },
};

// Tier rank → tier key map for reverse lookup
const RANK_TO_KEY = Object.fromEntries(
  Object.entries(CONDITION_TIERS).map(([k, v]) => [v.rank, k])
);

// ── Condition classifier ──────────────────────────────────────────────────────

/**
 * Classify a listing into a condition tier based on title + description text.
 * Returns the tier key (e.g., "like_new") or null if no match.
 */
export function classifyCondition(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();

  // Check from best condition down — first match wins
  for (const rank of [5, 4, 3, 2, 1]) {
    const key = RANK_TO_KEY[rank];
    const tier = CONDITION_TIERS[key];
    if (tier.keywords.some(kw => text.includes(kw))) {
      return key;
    }
  }
  return null;
}

// ── Statistical helpers ───────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }

function statsForPrices(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const len = sorted.length;
  const mid = Math.floor(len / 2);
  const median = len % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const avg = prices.reduce((a, b) => a + b, 0) / len;
  const p25idx = Math.max(0, Math.floor(len * 0.25) - 1);
  const p75idx = Math.min(len - 1, Math.floor(len * 0.75));
  return {
    count:  len,
    avg:    round2(avg),
    median: round2(median),
    low:    round2(Math.min(...prices)),
    high:   round2(Math.max(...prices)),
    p25:    round2(sorted[p25idx]),
    p75:    round2(sorted[p75idx]),
  };
}

// ── Core bucketing engine ─────────────────────────────────────────────────────

/**
 * Bucket sold comps by condition tier and compute stats per tier.
 * soldItems: array of { title, description?, price?, totalPrice?, salePrice?, sold? }
 */
export function priceByConditionTier(soldItems = []) {
  if (!Array.isArray(soldItems) || !soldItems.length) return buildEmptyResult();

  // Filter to sold items only
  const sold = soldItems.filter(item =>
    item?.sold === true ||
    String(item?.status || "").toLowerCase() === "sold" ||
    item?.source === "ebay_sold"
  );

  if (!sold.length) return buildEmptyResult();

  // Initialize buckets
  const buckets = {};
  for (const key of Object.keys(CONDITION_TIERS)) {
    buckets[key] = [];
  }
  const unclassified = [];

  for (const item of sold) {
    const price = Number(item?.totalPrice ?? item?.price ?? item?.salePrice ?? 0);
    if (!Number.isFinite(price) || price <= 0) continue;

    const tier = classifyCondition(item?.title || "", item?.description || "");
    if (tier && buckets[tier]) {
      buckets[tier].push(price);
    } else {
      unclassified.push(price);
    }
  }

  // Build stats per tier
  const tiers = {};
  for (const [key, prices] of Object.entries(buckets)) {
    const tierDef = CONDITION_TIERS[key];
    const stats = statsForPrices(prices);
    tiers[key] = stats
      ? { label: tierDef.label, rank: tierDef.rank, ...stats }
      : { label: tierDef.label, rank: tierDef.rank, count: 0 };
  }

  // Unclassified bucket
  const unclassifiedStats = statsForPrices(unclassified);

  // Compute condition discount ladder
  const ladder = buildConditionLadder(tiers);

  // Best value tier (most data + reasonable price)
  const bestDataTier = pickBestDataTier(tiers);

  const topSignal = buildTopSignal(tiers, ladder);

  return {
    tiers,
    unclassified: unclassifiedStats
      ? { label: "Unknown Condition", count: unclassified.length, ...unclassifiedStats }
      : { label: "Unknown Condition", count: 0 },
    ladder,
    bestDataTier,
    topSignal,
    totalClassified: Object.values(buckets).reduce((s, a) => s + a.length, 0),
    totalSold: sold.length,
  };
}

// ── Ladder: discount from "new" price per tier ────────────────────────────────

function buildConditionLadder(tiers) {
  const newMedian = tiers.new?.median ?? tiers.new?.avg;
  if (!newMedian) return null;

  const ladder = {};
  for (const [key, tier] of Object.entries(tiers)) {
    if (key === "new" || !tier.count) continue;
    const tierMedian = tier.median ?? tier.avg;
    if (!tierMedian) continue;
    const discountPct = round2(((newMedian - tierMedian) / newMedian) * 100);
    ladder[key] = {
      label:       tier.label,
      median:      tierMedian,
      discountPct,
      discountAmt: round2(newMedian - tierMedian),
    };
  }
  return Object.keys(ladder).length ? ladder : null;
}

function pickBestDataTier(tiers) {
  // Tier with most samples, weighted by recency (prefer like_new > good > fair)
  const ordered = ["like_new", "good", "new", "fair", "poor"];
  let best = null;
  let bestScore = -1;
  for (const key of ordered) {
    const tier = tiers[key];
    if (!tier?.count) continue;
    // Score = count * rank (rank penalizes extremes)
    const score = tier.count * (CONDITION_TIERS[key]?.rank ?? 1);
    if (score > bestScore) { bestScore = score; best = key; }
  }
  return best;
}

// ── Signal builders ───────────────────────────────────────────────────────────

function buildTopSignal(tiers, ladder) {
  const parts = [];
  const orderByRank = ["new", "like_new", "good", "fair", "poor"];
  for (const key of orderByRank) {
    const tier = tiers[key];
    if (!tier?.count || !tier.median) continue;
    parts.push(`${tier.label}: $${tier.median}`);
    if (parts.length >= 4) break; // keep signal concise
  }
  return parts.length ? parts.join(" · ") : null;
}

function buildEmptyResult() {
  const emptyTier = (label, rank) => ({ label, rank, count: 0 });
  return {
    tiers: {
      new:      emptyTier("New", 5),
      like_new: emptyTier("Like New", 4),
      good:     emptyTier("Good", 3),
      fair:     emptyTier("Fair", 2),
      poor:     emptyTier("Poor / For Parts", 1),
    },
    unclassified: { label: "Unknown Condition", count: 0 },
    ladder: null,
    bestDataTier: null,
    topSignal: null,
    totalClassified: 0,
    totalSold: 0,
  };
}

// ── Estimate price for a given condition ──────────────────────────────────────

/**
 * Estimate what an item should be priced at for a given condition tier.
 * Uses tier stats if available, falls back to ladder interpolation.
 */
export function estimatePriceForCondition(conditionKey, tierResult) {
  const tier = tierResult?.tiers?.[conditionKey];
  if (tier?.median) return { price: tier.median, confidence: tier.count >= 3 ? "high" : "low", source: "direct_comps" };
  if (tier?.avg)    return { price: tier.avg,    confidence: "low",  source: "direct_comps_avg" };

  // Try ladder interpolation from new price
  const newMedian = tierResult?.tiers?.new?.median ?? tierResult?.tiers?.new?.avg;
  if (!newMedian) return null;

  const DEFAULT_DISCOUNTS = { like_new: 0.15, good: 0.30, fair: 0.50, poor: 0.70 };
  const discount = DEFAULT_DISCOUNTS[conditionKey];
  if (discount == null) return null;

  return {
    price:      round2(newMedian * (1 - discount)),
    confidence: "estimated",
    source:     "discount_from_new",
  };
}

// ── Master payload builder ─────────────────────────────────────────────────────

export function buildConditionTierPayload(soldItems = [], currentCondition = null) {
  const result = priceByConditionTier(soldItems);
  let conditionEstimate = null;
  if (currentCondition) {
    conditionEstimate = estimatePriceForCondition(currentCondition, result);
  }
  return {
    conditionTiers:    result,
    conditionEstimate,
    topSignal:         result.topSignal,
  };
}
