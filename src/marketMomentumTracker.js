// src/marketMomentumTracker.js
// Market momentum tracker: computes price velocity and direction from live
// listing and sold comp data. Detects rising, falling, or stable markets.
// Separates listing price trend from sold price trend for accurate signal.
// "Sold comps up 8% in last 30 — market heating, buy before it climbs further."

// ── Momentum tier thresholds ──────────────────────────────────────────────────
const MOMENTUM_TIERS = {
  surging:   { minPct:  10, label: "Surging",  signal: "strongly rising — buy now before it climbs further" },
  rising:    { minPct:   4, label: "Rising",   signal: "trending up — favorable sell window opening" },
  stable:    { minPct:  -4, label: "Stable",   signal: "flat market — price at consensus" },
  softening: { minPct: -10, label: "Softening",signal: "trending down — wait for the floor before buying" },
  falling:   { minPct: -Infinity, label: "Falling", signal: "in sharp decline — high risk of further drop" },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Partition items into time buckets (recent vs. older) by listing date.
 * Returns { recent: Item[], older: Item[] }
 */
function splitByTime(items = []) {
  const now  = Date.now();
  const cutoff = 14 * 24 * 60 * 60 * 1000; // 14-day split

  const withTime = items.filter(i => {
    const ts = i?.listedAt || i?.date || i?.timestamp;
    return !!ts;
  });

  if (withTime.length < 4) {
    // No timestamps: split by array position (latter half = recent)
    const mid = Math.floor(items.length / 2);
    return { recent: items.slice(mid), older: items.slice(0, mid), hasTimestamps: false };
  }

  const recent = withTime.filter(i => {
    const ts = new Date(i?.listedAt || i?.date || i?.timestamp).getTime();
    return now - ts <= cutoff;
  });
  const older  = withTime.filter(i => {
    const ts = new Date(i?.listedAt || i?.date || i?.timestamp).getTime();
    return now - ts > cutoff;
  });

  return { recent, older, hasTimestamps: true };
}

/**
 * Compute median price from an array of items.
 */
function medianPrice(items = []) {
  const prices = items
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!prices.length) return null;
  return round2(prices[Math.floor(prices.length / 2)]);
}

/**
 * Classify momentum from percent change.
 */
function classifyMomentum(pct = 0) {
  if (pct >= MOMENTUM_TIERS.surging.minPct)   return "surging";
  if (pct >= MOMENTUM_TIERS.rising.minPct)    return "rising";
  if (pct >= MOMENTUM_TIERS.stable.minPct)    return "stable";
  if (pct >= MOMENTUM_TIERS.softening.minPct) return "softening";
  return "falling";
}

/**
 * Compute price momentum from a set of items.
 */
export function computePriceMomentum(items = [], label = "listings") {
  if (!Array.isArray(items) || items.length < 4) {
    return { available: false, reason: `Not enough ${label} for momentum analysis` };
  }

  const { recent, older } = splitByTime(items);
  const recentMedian = medianPrice(recent);
  const olderMedian  = medianPrice(older);

  if (!recentMedian || !olderMedian) {
    return { available: false, reason: "Insufficient price data in one or both time windows" };
  }

  const changePct  = round2(((recentMedian - olderMedian) / olderMedian) * 100);
  const changeDollar = round2(recentMedian - olderMedian);
  const tier       = classifyMomentum(changePct);
  const tierMeta   = MOMENTUM_TIERS[tier];

  return {
    available:     true,
    tier,
    tierLabel:     tierMeta.label,
    changePct,
    changeDollar,
    recentMedian,
    olderMedian,
    recentCount:   recent.length,
    olderCount:    older.length,
    signal:        `${label} ${tierMeta.signal} (${changePct > 0 ? "+" : ""}${changePct}% / ${changeDollar > 0 ? "+" : ""}$${Math.abs(changeDollar).toFixed(2)})`,
  };
}

/**
 * Detect price compression: spread between highest and lowest listings is
 * narrowing (sellers converging on consensus).
 */
export function detectPriceConvergence(uiItems = []) {
  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (prices.length < 5) return null;

  const min    = prices[0];
  const max    = prices[prices.length - 1];
  const spread = round2(((max - min) / min) * 100);
  const cv     = (() => {
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
    return round2((Math.sqrt(variance) / mean) * 100);
  })();

  const isConverged = spread < 20 || cv < 10;
  const isFragmented = spread > 60 || cv > 30;

  return {
    spread,
    coefficientOfVariation: cv,
    isConverged,
    isFragmented,
    priceRange: { min: round2(min), max: round2(max) },
    signal: isConverged
      ? `Tight market — sellers aligned within ${spread.toFixed(0)}% range (strong consensus)`
      : isFragmented
      ? `Fragmented pricing — ${spread.toFixed(0)}% spread suggests opportunity for patient buyers`
      : null,
  };
}

/**
 * Compute sell-through velocity: ratio of sold to active listings.
 */
export function computeSellThroughVelocity(allItems = [], soldItems = []) {
  const active = allItems.filter(i => !i?.sold && !i?.isSold).length;
  const sold   = soldItems.length || allItems.filter(i => i?.sold || i?.isSold).length;
  if (!active && !sold) return null;

  const total    = active + sold;
  const ratio    = round2(sold / total);
  const tier     = ratio >= 0.60 ? "fast"
                 : ratio >= 0.35 ? "moderate"
                 : ratio >= 0.15 ? "slow"
                 : "stagnant";

  return {
    soldCount:   sold,
    activeCount: active,
    sellThroughRatio: ratio,
    tier,
    signal: tier === "fast"
      ? `High sell-through (${Math.round(ratio * 100)}%) — demand is absorbing supply fast`
      : tier === "stagnant"
      ? `Very low sell-through (${Math.round(ratio * 100)}%) — oversupplied market`
      : null,
  };
}

/**
 * Master market momentum tracker payload.
 */
export function buildMarketMomentumPayload({
  uiItems    = [],
  soldItems  = [],
  category   = "",
} = {}) {
  const allItems       = Array.isArray(uiItems) ? uiItems : [];
  const sold           = Array.isArray(soldItems) ? soldItems : [];

  // Separate active and sold within uiItems if not provided separately
  const activeListing  = allItems.filter(i => !i?.sold && !i?.isSold);
  const soldFromItems  = allItems.filter(i => i?.sold || i?.isSold);
  const soldAll        = sold.length ? sold : soldFromItems;

  const listingMomentum = computePriceMomentum(activeListing, "listing prices");
  const soldMomentum    = computePriceMomentum(soldAll, "sold comps");
  const convergence     = detectPriceConvergence(activeListing);
  const velocity        = computeSellThroughVelocity(allItems, sold);

  // Composite momentum: sold comps trump listing prices
  const primaryMomentum = soldMomentum?.available ? soldMomentum : listingMomentum;
  const tier            = primaryMomentum?.available ? primaryMomentum.tier : "stable";

  const topSignal = soldMomentum?.available
    ? `Sold comps ${MOMENTUM_TIERS[soldMomentum.tier]?.signal ?? soldMomentum.tier} (${soldMomentum.changePct > 0 ? "+" : ""}${soldMomentum.changePct}%)`
    : listingMomentum?.available
    ? `Listing prices ${MOMENTUM_TIERS[listingMomentum.tier]?.signal ?? listingMomentum.tier} (${listingMomentum.changePct > 0 ? "+" : ""}${listingMomentum.changePct}%)`
    : convergence?.signal
    || velocity?.signal
    || null;

  return {
    listing:      listingMomentum?.available  ? listingMomentum  : null,
    sold:         soldMomentum?.available     ? soldMomentum     : null,
    convergence:  convergence                 || null,
    velocity:     velocity                    || null,
    overallTier:  tier,
    topSignal,
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
