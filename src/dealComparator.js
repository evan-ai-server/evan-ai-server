// src/dealComparator.js
// Deal verdict engine: STEAL / GOOD DEAL / FAIR / OVERPRICED / PRICE TRAP
// with market percentile rank, savings vs median, and price-drop signal

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compare a scanned price against the full market price distribution.
 * Returns percentile rank and savings metrics.
 *
 * percentile: 100 = cheapest in market, 0 = most expensive
 */
export function compareDealToMarket(scannedPrice, uiItems = [], consensus = null) {
  const scanned = finiteOrNull(scannedPrice);
  if (!scanned) return null;

  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!prices.length) return null;

  const medianMarket = finiteOrNull(consensus?.medianPrice) ?? prices[Math.floor(prices.length / 2)];
  const avgMarket    = round2(prices.reduce((s, v) => s + v, 0) / prices.length);
  const minMarket    = prices[0];
  const maxMarket    = prices[prices.length - 1];

  // Percentile: fraction of market listings that are MORE expensive than scanned
  const countMoreExpensive = prices.filter(p => p > scanned).length;
  const percentile         = round2((countMoreExpensive / prices.length) * 100);

  const vsMedianPct        = round2(((scanned - medianMarket) / medianMarket) * 100);
  const savingsVsMedian    = round2(medianMarket - scanned);

  return {
    scannedPrice,
    medianMarket:  round2(medianMarket),
    avgMarket,
    minMarket:     round2(minMarket),
    maxMarket:     round2(maxMarket),
    percentile,
    vsMedianPct,
    savingsVsMedian,
    sampleSize:    prices.length,
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
 */
export function buildDealComparatorPayload({
  scannedPrice = null,
  uiItems      = [],
  consensus    = null,
  category     = "",
  identity     = null,
} = {}) {
  const comparison      = compareDealToMarket(scannedPrice, uiItems, consensus);
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
