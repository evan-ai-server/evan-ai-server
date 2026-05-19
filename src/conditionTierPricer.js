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

// ── Structured-condition → canonical-tier map ─────────────────────────────────
// Marketplace APIs return condition codes; we map them to our tier keys so
// the classifier can prefer them over flaky title-text parsing.
//
//   eBay Browse:          NEW / LIKE_NEW / NEW_OTHER / NEW_WITH_DEFECTS /
//                         USED_EXCELLENT / USED_VERY_GOOD / USED_GOOD /
//                         USED_ACCEPTABLE / FOR_PARTS_OR_NOT_WORKING /
//                         CERTIFIED_REFURBISHED / SELLER_REFURBISHED /
//                         MANUFACTURER_REFURBISHED
//   Free-text from other sources is normalized by lower-casing + trimming.
const STRUCTURED_CONDITION_MAP = {
  // eBay enums
  NEW:                          "new",
  NEW_OTHER:                    "new",
  NEW_WITH_DEFECTS:             "like_new",
  LIKE_NEW:                     "like_new",
  CERTIFIED_REFURBISHED:        "like_new",
  MANUFACTURER_REFURBISHED:     "like_new",
  SELLER_REFURBISHED:           "good",
  USED_EXCELLENT:               "like_new",
  USED_VERY_GOOD:               "like_new",
  USED_GOOD:                    "good",
  USED_ACCEPTABLE:              "fair",
  FOR_PARTS_OR_NOT_WORKING:     "poor",
  // Lower-case canonical (in case caller already normalized)
  new:                          "new",
  like_new:                     "like_new",
  good:                         "good",
  fair:                         "fair",
  poor:                         "poor",
};

function normalizeStructuredCondition(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (STRUCTURED_CONDITION_MAP[s]) return STRUCTURED_CONDITION_MAP[s];
  const upper = s.toUpperCase().replace(/[\s-]+/g, "_");
  if (STRUCTURED_CONDITION_MAP[upper]) return STRUCTURED_CONDITION_MAP[upper];
  const lower = s.toLowerCase();
  if (STRUCTURED_CONDITION_MAP[lower]) return STRUCTURED_CONDITION_MAP[lower];
  return null;
}

// ── Condition classifier ──────────────────────────────────────────────────────

/**
 * Classify a listing into a condition tier.
 *
 * Prefers a structured condition field (e.g. eBay's `condition` enum) over
 * title-text parsing — structured codes don't lie, title keywords sometimes do
 * ("Brand New In Box" appearing in the title of a refurbished listing, etc.).
 *
 * Returns the tier key (e.g., "like_new") or null if no signal matches.
 */
export function classifyCondition(title = "", description = "", structured = null) {
  // 1. Structured field wins when present and recognized.
  const fromStructured = normalizeStructuredCondition(structured);
  if (fromStructured) return fromStructured;

  // 2. Fall back to title/description keyword match — best tier first.
  const text = `${title} ${description}`.toLowerCase();
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
 * Bucket comps by condition tier and compute stats per tier.
 *
 * By default this buckets ALL items (active asks + sold). Pass
 * { soldOnly: true } to restore the old behavior — only useful when the
 * caller has true sold-comp data (e.g. from /buy/marketplace_insights).
 *
 * items: array of { title, description?, condition?, price?, totalPrice?,
 *                   salePrice?, sold?, source? }
 */
export function priceByConditionTier(items = [], { soldOnly = false } = {}) {
  if (!Array.isArray(items) || !items.length) return buildEmptyResult();

  // Filter scope. Default = all comps. Opt-in soldOnly preserves legacy
  // behavior for callers that only want sold prices in the buckets.
  const pool = soldOnly
    ? items.filter(item =>
        item?.sold === true ||
        String(item?.status || "").toLowerCase() === "sold" ||
        item?.source === "ebay_sold"
      )
    : items;

  if (!pool.length) return buildEmptyResult();

  // Initialize buckets
  const buckets = {};
  for (const key of Object.keys(CONDITION_TIERS)) {
    buckets[key] = [];
  }
  const unclassified = [];

  for (const item of pool) {
    const price = Number(item?.totalPrice ?? item?.price ?? item?.salePrice ?? 0);
    if (!Number.isFinite(price) || price <= 0) continue;

    // Structured field on the item beats title-text parsing — eBay returns
    // a real `condition` enum on every Browse listing.
    const tier = classifyCondition(
      item?.title       || "",
      item?.description || "",
      item?.condition   ?? null,
    );
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

  // totalSold is the count of true sold comps in the pool (post-filter).
  // When soldOnly=false this is computed separately so downstream code can
  // tell "this stat is sold data" vs "this stat is mixed asks + sold".
  const soldInPool = pool.reduce((acc, item) => acc + (
    (item?.sold === true ||
     String(item?.status || "").toLowerCase() === "sold" ||
     item?.source === "ebay_sold") ? 1 : 0
  ), 0);

  return {
    tiers,
    unclassified: unclassifiedStats
      ? { label: "Unknown Condition", count: unclassified.length, ...unclassifiedStats }
      : { label: "Unknown Condition", count: 0 },
    ladder,
    bestDataTier,
    topSignal,
    totalClassified: Object.values(buckets).reduce((s, a) => s + a.length, 0),
    totalConsidered: pool.length,
    totalSold:       soldInPool,
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
    totalConsidered: 0,
    totalSold:       0,
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

export function buildConditionTierPayload(items = [], currentCondition = null) {
  const result = priceByConditionTier(items);
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

// ── Bucketing for the price-bracket math ──────────────────────────────────────
// Picks the subset of comps that best represents what the scanned item should
// be compared against. Used by dealComparator to escape the failure mode where
// a "Used – Acceptable" listing gets compared against a basket containing
// mostly "New Sealed" comps (or vice-versa) and the verdict ends up wrong.
//
// Strategy:
//   1. Bucket all comps by condition tier (structured field preferred, title
//      keywords as fallback).
//   2. If the scan's own condition bucket has >= minBucketSize items, use it.
//   3. Else try the adjacent tier (one tier up or down — closest substitute).
//   4. Else fall back to all comps. Better an honest "we don't have condition-
//      matched data" than a falsely confident verdict.
//
// Returns:
//   {
//     bucketItems:      Item[],    // the chosen subset
//     bucketCondition:  string,    // canonical tier key OR "all_conditions"
//     bucketSource:     "matched_condition" | "adjacent_condition" | "all_listings",
//     bucketSize:       number,
//     scanConditionTier: string|null,
//   }
const TIER_ORDER = ["new", "like_new", "good", "fair", "poor"];
const TIER_NEIGHBORS = {
  new:      ["like_new"],
  like_new: ["new", "good"],
  good:     ["like_new", "fair"],
  fair:     ["good", "poor"],
  poor:     ["fair"],
};

// Sold comps are the gold standard for resale verdicts — they're what people
// actually paid, vs asks which are upper-bound (sellers list optimistically).
// When a tier bucket has enough sold comps on its own, we use those exclusively.
const SOLD_PREFERENCE_MIN = 3;

function isSoldComp(item) {
  if (!item) return false;
  return (
    item.sold === true ||
    item.__isSoldComp === true ||
    item.source === "ebay_sold" ||
    String(item.status || "").toLowerCase() === "sold"
  );
}

export function bucketItemsByCondition(items = [], scanCondition = null, minBucketSize = 5) {
  const safeItems = Array.isArray(items) ? items : [];
  const total = safeItems.length;

  // No condition info on the scan → no condition-aware bracketing possible.
  // Return everything (with sold-preference still applied) and tell the
  // caller why.
  const scanTier = normalizeStructuredCondition(scanCondition);
  if (!scanTier || total === 0) {
    const allSold = safeItems.filter(isSoldComp);
    if (allSold.length >= SOLD_PREFERENCE_MIN) {
      return {
        bucketItems:       allSold,
        bucketCondition:   "all_conditions",
        bucketSource:      "sold_listings_only",
        bucketSize:        allSold.length,
        scanConditionTier: scanTier,
      };
    }
    return {
      bucketItems:       safeItems,
      bucketCondition:   "all_conditions",
      bucketSource:      "all_listings",
      bucketSize:        total,
      scanConditionTier: scanTier,
    };
  }

  // Classify every item once, cache the tier on a parallel array so we don't
  // re-parse titles when picking adjacent buckets.
  const tiers = safeItems.map((it) =>
    classifyCondition(it?.title || "", it?.description || "", it?.condition ?? null)
  );

  const itemsForTier = (tierKey) =>
    safeItems.filter((_, i) => tiers[i] === tierKey);

  // 1. Exact match — prefer sold comps within the bucket when possible.
  const matched = itemsForTier(scanTier);
  if (matched.length) {
    const matchedSold = matched.filter(isSoldComp);
    if (matchedSold.length >= SOLD_PREFERENCE_MIN) {
      return {
        bucketItems:       matchedSold,
        bucketCondition:   scanTier,
        bucketSource:      "matched_condition_sold",
        bucketSize:        matchedSold.length,
        scanConditionTier: scanTier,
      };
    }
    if (matched.length >= minBucketSize) {
      return {
        bucketItems:       matched,
        bucketCondition:   scanTier,
        bucketSource:      "matched_condition",
        bucketSize:        matched.length,
        scanConditionTier: scanTier,
      };
    }
  }

  // 2. Adjacent tier(s) — pool the matched bucket with its closest neighbors
  //    before giving up. A "good" scan with only 2 matched + 4 "like_new" is
  //    better compared against those 6 than against all conditions.
  const neighborTiers = TIER_NEIGHBORS[scanTier] || [];
  const pooled = [...matched];
  for (const t of neighborTiers) pooled.push(...itemsForTier(t));
  if (pooled.length >= minBucketSize) {
    const pooledSold = pooled.filter(isSoldComp);
    if (pooledSold.length >= SOLD_PREFERENCE_MIN) {
      return {
        bucketItems:       pooledSold,
        bucketCondition:   scanTier,
        bucketSource:      "adjacent_condition_sold",
        bucketSize:        pooledSold.length,
        scanConditionTier: scanTier,
      };
    }
    return {
      bucketItems:       pooled,
      bucketCondition:   scanTier,
      bucketSource:      "adjacent_condition",
      bucketSize:        pooled.length,
      scanConditionTier: scanTier,
    };
  }

  // 3. Fall back to all comps — honest under-data state. Still apply
  //    sold-preference when enough exist globally.
  const allSold = safeItems.filter(isSoldComp);
  if (allSold.length >= SOLD_PREFERENCE_MIN) {
    return {
      bucketItems:       allSold,
      bucketCondition:   "all_conditions",
      bucketSource:      "sold_listings_only",
      bucketSize:        allSold.length,
      scanConditionTier: scanTier,
    };
  }
  return {
    bucketItems:       safeItems,
    bucketCondition:   "all_conditions",
    bucketSource:      "all_listings",
    bucketSize:        total,
    scanConditionTier: scanTier,
  };
}
