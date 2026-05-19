// src/dealComparator.js
// Deal verdict engine: STEAL / GOOD DEAL / FAIR / OVERPRICED / PRICE TRAP
// with market percentile rank, savings vs median, and price-drop signal.
//
// PHASE 3 NOTE — LEGACY VERDICT NAMESPACE.
// This module's `verdict` field ("steal" | "good_deal" | "fair" |
// "overpriced" | "price_trap") and `dealEngineVerdict` field
// ("BUY" | "CHECK" | "PASS") are LEGACY parallel verdict systems.
// They are isolated under `responsePayload.legacy` (see
// shared/legacyNamespace.js) and MUST NOT drive UI, emotion, or
// analytics. The canonical decision is `buyOrPass.verdict` from
// src/buyOrPassEngine.js.
//
// The fields here remain for backwards compatibility with downstream
// scoring code (buyOrPassEngine consumes "steal"/"good"/"fair"/etc as
// price-quality features, which is a permitted internal use). Phase 5
// will remove them from the wire-level response shape.

import { bucketItemsByCondition } from "./conditionTierPricer.js";

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compare a scanned price against the market price distribution.
 *
 * When `scanCondition` is provided, the comp basket is first narrowed to the
 * matching condition tier (with adjacent-tier fallback and minimum-size guard)
 * so the percentile and savings are computed against an apples-to-apples set
 * of comps. A "Used – Acceptable" scan no longer competes against a basket
 * dominated by "New Sealed" listings, and vice-versa.
 *
 * The `bracket*` fields on the result expose which subset was used so
 * downstream UI / observability can show "compared against 12 'Good' comps"
 * instead of mystery math.
 *
 * percentile: 100 = cheapest in market, 0 = most expensive
 *
 * @param {number} scannedPrice
 * @param {Array}  uiItems
 * @param {object} consensus
 * @param {object} [options]
 * @param {string|null} [options.scanCondition]   — canonical tier key or
 *   eBay-style enum; null disables condition-aware bracketing.
 * @param {number} [options.minBucketSize=5]
 * @param {number} [options.learnedAdjustmentPct] — signed pct shift applied to
 *   the median used for verdict math (NOT to the displayed medianMarket).
 *   Comes from getCategoryOutcomePrior — see learnedBracketAdjustment().
 */
export function compareDealToMarket(scannedPrice, uiItems = [], consensus = null, options = {}) {
  const scanned = finiteOrNull(scannedPrice);
  if (!scanned) return null;

  const { scanCondition = null, minBucketSize = 5, learnedAdjustmentPct = 0 } = options || {};

  // Condition-aware basket selection. When scanCondition is null this returns
  // the full uiItems with bucketSource="all_listings" — identical to the old
  // behavior, so callers that don't pass scanCondition see no change.
  const bucket = bucketItemsByCondition(uiItems, scanCondition, minBucketSize);

  const rawPrices = bucket.bucketItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!rawPrices.length) return null;

  // IQR outlier fence — drops a $12 Etsy mislabel hiding in an otherwise
  // $20–$30 wrap-sunglasses distribution from anchoring the verdict.
  // Mirrors buildPriceStats in index.js so the two systems agree.
  const prices = trimIQR(rawPrices);

  // Displayed market median — comes from consensus when available so the UI
  // shows the broader-market number even when the bracket math runs against
  // a narrower bucket. Falls back to the bucket's own median.
  const displayedMedian = finiteOrNull(consensus?.medianPrice) ?? prices[Math.floor(prices.length / 2)];

  // Bracket median — what the verdict math actually compares the scan against.
  // Condition-bucketed and learned-adjusted. This is the "right" number for a
  // condition-matched scan even when it differs from the broader market median.
  const bucketMedianRaw = prices[Math.floor(prices.length / 2)];
  const learnedShift    = Number.isFinite(learnedAdjustmentPct) ? learnedAdjustmentPct : 0;
  const bracketMedian   = round2(bucketMedianRaw * (1 + learnedShift / 100));

  const avgMarket    = round2(prices.reduce((s, v) => s + v, 0) / prices.length);
  const minMarket    = prices[0];
  const maxMarket    = prices[prices.length - 1];

  // Percentile against the bucketed, cleaned distribution.
  const countMoreExpensive = prices.filter(p => p > scanned).length;
  const percentile         = round2((countMoreExpensive / prices.length) * 100);

  // vsMedianPct is the verdict-relevant deviation — uses bracketMedian so
  // condition-aware scans don't get the wrong percentage just because the
  // broader-market median is dragged by a different condition mix.
  const vsMedianPct        = round2(((scanned - bracketMedian) / bracketMedian) * 100);
  const savingsVsMedian    = round2(bracketMedian - scanned);

  return {
    scannedPrice,
    medianMarket:    round2(displayedMedian),
    bracketMedian:   bracketMedian,          // what the verdict math used
    avgMarket,
    minMarket:       round2(minMarket),
    maxMarket:       round2(maxMarket),
    percentile,
    vsMedianPct,
    savingsVsMedian,
    sampleSize:      prices.length,
    rawSampleSize:   rawPrices.length,
    outliersTrimmed: rawPrices.length - prices.length,

    // Bucket provenance — surfaces "we compared against 12 'Good' comps" so
    // the verdict is auditable. Consumed by UI tooltips and /debug endpoints.
    bracketCondition:    bucket.bucketCondition,
    bracketSource:       bucket.bucketSource,
    bracketSize:         bucket.bucketSize,
    scanConditionTier:   bucket.scanConditionTier,
    bracketShiftPct:     learnedShift || 0,
  };
}

/**
 * Build a structured deal verdict from the market comparison.
 */
export function buildDealVerdict(comparison, category = "", identity = null) {
  if (!comparison) return null;

  const { percentile, vsMedianPct, scannedPrice, medianMarket, savingsVsMedian } = comparison;

  const verdict = percentile >= 80 ? "steal"
                : percentile >= 60 ? "good_deal"
                : percentile >= 40 ? "fair"
                : percentile >= 20 ? "overpriced"
                : "price_trap";

  const VERDICT_LABELS = {
    steal:      "STEAL",
    good_deal:  "GOOD DEAL",
    fair:       "FAIR PRICE",
    overpriced: "OVERPRICED",
    price_trap: "PRICE TRAP",
  };

  const VERDICT_EMOJIS = {
    steal:      "🔥",
    good_deal:  "✅",
    fair:       "⚖️",
    overpriced: "⚠️",
    price_trap: "🚫",
  };

  const verdictLabel = VERDICT_LABELS[verdict];
  const verdictEmoji = VERDICT_EMOJIS[verdict];

  // Deal Engine mapping: steal/good_deal → BUY, fair → CHECK, overpriced/price_trap → PASS
  const DEAL_ENGINE_VERDICT = {
    steal:      "BUY",
    good_deal:  "BUY",
    fair:       "CHECK",
    overpriced: "PASS",
    price_trap: "PASS",
  };
  const dealEngineVerdict = DEAL_ENGINE_VERDICT[verdict] || "CHECK";

  const actionableSignal = (() => {
    const absDiff = Math.abs(vsMedianPct).toFixed(0);
    if (verdict === "steal")      return `Priced ${absDiff}% below median — buy immediately`;
    if (verdict === "good_deal")  return `${absDiff}% below median — solid deal`;
    if (verdict === "fair")       return "At market price — negotiate or wait for a dip";
    if (verdict === "overpriced") return `${absDiff}% above median — look elsewhere`;
    if (verdict === "price_trap") return `${absDiff}% above median — do NOT buy at this price`;
    return "";
  })();

  return {
    verdict,
    verdictLabel,
    verdictEmoji,
    dealEngineVerdict,
    percentile,
    vsMedianPct,
    savingsVsMedian,
    scannedPrice,
    medianMarket,
    signal:          `${verdictLabel} ${verdictEmoji} — ${actionableSignal}`,
    actionableSignal,
  };
}

/**
 * Detect if the market price is dropping based on the distribution shape.
 * Uses skew and supply pressure heuristics.
 *
 * Returns a "hold off" or "buy now" recommendation.
 */
export function computePriceDropSignal(uiItems = []) {
  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (prices.length < 4) return null;

  const median = prices[Math.floor(prices.length / 2)];
  const q1     = prices[Math.floor(prices.length * 0.25)];
  const q3     = prices[Math.floor(prices.length * 0.75)];
  const mean   = prices.reduce((s, v) => s + v, 0) / prices.length;
  const iqr    = q3 - q1 || 1;

  // Skew: negative skew (mean < median) = many cheap listings = supply pressure = dropping
  const skew           = round2((mean - median) / iqr);
  const cheapCount     = prices.filter(p => p < median * 0.85).length;
  const expensiveCount = prices.filter(p => p > median * 1.15).length;
  const supplyPressure = cheapCount > expensiveCount * 1.5;

  const trend = (skew < -0.3 || supplyPressure) ? "dropping"
              : skew > 0.5                        ? "rising"
              : "stable";

  return {
    trend,
    skew,
    supplyPressure,
    cheapListings:      cheapCount,
    expensiveListings:  expensiveCount,
    median:             round2(median),
    mean:               round2(mean),
    recommendation: trend === "dropping"
      ? "Prices trending down — consider waiting before buying"
      : trend === "rising"
      ? "Prices trending up — buy now before market rises further"
      : "Market stable — standard purchase timing",
  };
}

/**
 * Master deal comparator payload — attached to every market search response.
 *
 * @param {object} args
 * @param {number}       args.scannedPrice
 * @param {Array}        args.uiItems
 * @param {object}       args.consensus
 * @param {string}       args.category
 * @param {object|null}  args.identity
 * @param {string|null}  args.scanCondition         — canonical tier key
 *   (new|like_new|good|fair|poor) or eBay enum. When non-null, the comp
 *   basket is narrowed to the matching condition tier with adjacent-tier
 *   fallback so the verdict is computed against apples-to-apples comps.
 * @param {number}       args.learnedAdjustmentPct  — signed pct from
 *   outcomeLearning.getCategoryOutcomePrior, shifts bracket median for
 *   verdict math without changing displayed median.
 */
export function buildDealComparatorPayload({
  scannedPrice         = null,
  uiItems              = [],
  consensus            = null,
  category             = "",
  identity             = null,
  scanCondition        = null,
  learnedAdjustmentPct = 0,
} = {}) {
  const comparison      = compareDealToMarket(scannedPrice, uiItems, consensus, {
    scanCondition,
    learnedAdjustmentPct,
  });
  const verdict         = buildDealVerdict(comparison, category, identity);
  const priceDropSignal = computePriceDropSignal(uiItems);

  return {
    comparison:      comparison      || null,
    verdict:         verdict         || null,
    priceDropSignal: priceDropSignal || null,
    summary:         verdict?.signal || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// IQR (Tukey) outlier fence. Drops anything below Q1−1.5×IQR or above Q3+1.5×IQR.
// Falls back to the raw distribution when trimming would leave too few points.
function trimIQR(sortedPrices) {
  if (!Array.isArray(sortedPrices) || sortedPrices.length < 4) return sortedPrices;
  const q1  = sortedPrices[Math.floor(sortedPrices.length * 0.25)];
  const q3  = sortedPrices[Math.floor(sortedPrices.length * 0.75)];
  const iqr = Math.max(q3 - q1, 0.01);
  const lo  = q1 - 1.5 * iqr;
  const hi  = q3 + 1.5 * iqr;
  const clean = sortedPrices.filter(p => p >= lo && p <= hi);
  return clean.length >= 2 ? clean : sortedPrices;
}
