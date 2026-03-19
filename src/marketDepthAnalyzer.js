// src/marketDepthAnalyzer.js
// Market Depth Analyzer: detects price walls, supply/demand imbalance,
// bid-ask spread proxy, and liquidity tiers across the live market.
// "Heavy supply wall at $165 — price will compress to $150 before moving."

// ── Price wall detection ───────────────────────────────────────────────────────
// A price wall: ≥N listings clustered within a tight band
const WALL_MIN_LISTINGS = 3;
const WALL_BAND_PCT     = 0.05; // 5% price band = same cluster

// ── Liquidity tier thresholds ─────────────────────────────────────────────────
const LIQUIDITY_TIERS = [
  { minListings: 20, tier: "deep",      label: "Deep Market",    note: "High liquidity — easy entry and exit" },
  { minListings: 8,  tier: "moderate",  label: "Moderate",       note: "Adequate depth — normal price discovery" },
  { minListings: 3,  tier: "thin",      label: "Thin Market",    note: "Low supply — prices can move sharply" },
  { minListings: 0,  tier: "illiquid",  label: "Illiquid",       note: "Very few listings — hard to price accurately" },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Cluster prices into bands and detect walls.
 */
export function detectPriceWalls(prices = []) {
  if (prices.length < WALL_MIN_LISTINGS) return [];

  const sorted = [...prices].filter(p => p > 0).sort((a, b) => a - b);
  const walls  = [];

  let clusterStart  = 0;
  let clusterPrices = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const bandRef   = clusterPrices[0];
    const withinBand = sorted[i] <= bandRef * (1 + WALL_BAND_PCT);

    if (withinBand) {
      clusterPrices.push(sorted[i]);
    } else {
      if (clusterPrices.length >= WALL_MIN_LISTINGS) {
        const median = clusterPrices[Math.floor(clusterPrices.length / 2)];
        walls.push({
          priceCenter: round2(median),
          priceMin:    round2(clusterPrices[0]),
          priceMax:    round2(clusterPrices[clusterPrices.length - 1]),
          listingCount: clusterPrices.length,
          strength:    clusterPrices.length >= 8 ? "strong" : clusterPrices.length >= 5 ? "moderate" : "weak",
          signal:      `Supply wall at ~$${median.toFixed(2)} (${clusterPrices.length} listings) — price will face resistance here`,
        });
      }
      clusterPrices = [sorted[i]];
    }
  }
  // Final cluster
  if (clusterPrices.length >= WALL_MIN_LISTINGS) {
    const median = clusterPrices[Math.floor(clusterPrices.length / 2)];
    walls.push({
      priceCenter: round2(median),
      priceMin:    round2(clusterPrices[0]),
      priceMax:    round2(clusterPrices[clusterPrices.length - 1]),
      listingCount: clusterPrices.length,
      strength:    clusterPrices.length >= 8 ? "strong" : clusterPrices.length >= 5 ? "moderate" : "weak",
      signal:      `Supply wall at ~$${median.toFixed(2)} (${clusterPrices.length} listings) — price will face resistance here`,
    });
  }

  return walls.sort((a, b) => b.listingCount - a.listingCount);
}

/**
 * Compute bid-ask spread proxy: difference between lowest active ask and
 * highest recent sold price.
 */
export function computeBidAskSpread(activeItems = [], soldItems = []) {
  const activePrices = activeItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const soldPrices = soldItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => b - a);

  if (!activePrices.length || !soldPrices.length) return null;

  const lowestAsk   = activePrices[0];
  const highestSold = soldPrices[0];
  const spread      = round2(lowestAsk - highestSold);
  const spreadPct   = round2((spread / highestSold) * 100);

  const isNegative  = spread < 0; // ask below recent sold = unusual, potential steal
  const isTight     = spreadPct <= 5;
  const isWide      = spreadPct > 20;

  return {
    lowestAsk,
    highestSold,
    spread,
    spreadPct,
    isNegative,
    isTight,
    isWide,
    signal: isNegative
      ? `Asking below last sold — sellers are eager, prices dropping`
      : isTight
      ? `Tight bid-ask spread (${spreadPct}%) — efficient market, price is fair`
      : isWide
      ? `Wide bid-ask spread (${spreadPct}%) — sellers anchoring high, patient buyers will win`
      : null,
  };
}

/**
 * Score supply/demand imbalance.
 */
export function scoreSupplyDemandImbalance(activeCount = 0, soldCount = 0) {
  if (!activeCount && !soldCount) return null;
  const total = activeCount + soldCount;
  const sellThroughRate = soldCount / total;

  const imbalance = sellThroughRate >= 0.70 ? "demand_heavy"  // more sold than active
                  : sellThroughRate >= 0.45 ? "balanced"
                  : sellThroughRate >= 0.25 ? "supply_heavy"
                  : "oversupplied";

  const score = round2(sellThroughRate * 100);

  return {
    activeCount,
    soldCount,
    sellThroughRate: round2(sellThroughRate),
    imbalance,
    score,
    signal: imbalance === "demand_heavy"
      ? `Demand-heavy market (${Math.round(sellThroughRate * 100)}% sell-through) — buyers absorbing supply fast`
      : imbalance === "oversupplied"
      ? `Oversupplied (${Math.round(sellThroughRate * 100)}% sell-through) — patient buyers hold the power`
      : null,
  };
}

/**
 * Classify market liquidity.
 */
export function classifyLiquidity(totalListings = 0) {
  const tier = LIQUIDITY_TIERS.find(t => totalListings >= t.minListings) || LIQUIDITY_TIERS[LIQUIDITY_TIERS.length - 1];
  return { ...tier, totalListings };
}

/**
 * Compute the "floor price" — the price below which there is essentially no supply.
 */
export function computePriceFloor(prices = [], percentile = 10) {
  const sorted = [...prices].filter(p => p > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.floor((percentile / 100) * sorted.length) - 1);
  return round2(sorted[idx]);
}

/**
 * Master market depth analyzer payload.
 */
export function buildMarketDepthPayload({
  uiItems   = [],
  soldItems = [],
  category  = "",
} = {}) {
  const active     = uiItems.filter(i => !i?.sold && !i?.isSold);
  const sold       = soldItems.length ? soldItems : uiItems.filter(i => i?.sold || i?.isSold);

  const activePrices = active.map(i => finiteOrNull(i?.totalPrice ?? i?.price)).filter(Boolean);
  const soldPrices   = sold.map(i => finiteOrNull(i?.totalPrice ?? i?.price)).filter(Boolean);
  const allPrices    = [...activePrices, ...soldPrices];

  const walls        = detectPriceWalls(activePrices);
  const spread       = computeBidAskSpread(active, sold);
  const imbalance    = scoreSupplyDemandImbalance(active.length, sold.length);
  const liquidity    = classifyLiquidity(uiItems.length);
  const priceFloor   = computePriceFloor(activePrices, 10);
  const priceCeiling = activePrices.length ? round2(Math.max(...activePrices)) : null;

  const dominantWall = walls[0] || null;

  const topSignal = dominantWall?.signal
    || spread?.signal
    || imbalance?.signal
    || (liquidity.tier === "illiquid" ? "Very thin market — price discovery is unreliable" : null);

  return {
    walls,
    spread:        spread    || null,
    imbalance:     imbalance || null,
    liquidity,
    priceFloor,
    priceCeiling,
    activeCount:   active.length,
    soldCount:     sold.length,
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
