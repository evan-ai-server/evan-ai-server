// src/demandSignalEngine.js
// Live demand signals: scarcity scoring, listing velocity, sell-through pressure,
// and "buy window open / closing" alerts from market listing data.

// ── Scarcity thresholds by category ──────────────────────────────────────────
// How many active listings = scarce / normal / flooded
const SCARCITY_THRESHOLDS = {
  sneakers:     { scarce: 5,  normal: 20, flooded: 60  },
  apparel:      { scarce: 8,  normal: 30, flooded: 100 },
  bag:          { scarce: 4,  normal: 15, flooded: 40  },
  electronics:  { scarce: 6,  normal: 25, flooded: 80  },
  watch:        { scarce: 3,  normal: 12, flooded: 35  },
  eyewear:      { scarce: 5,  normal: 20, flooded: 60  },
  collectibles: { scarce: 3,  normal: 10, flooded: 30  },
  default:      { scarce: 5,  normal: 20, flooded: 60  },
};

// Minimum sold-to-live ratio to signal strong demand
const STRONG_DEMAND_SOLD_RATIO = 0.40; // 40%+ of results are sold = high sell-through

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Score scarcity based on live listing count vs. category norms.
 */
export function scoreScarcity(uiItems = [], category = "") {
  const cat         = String(category || "").toLowerCase().replace(/s$/, "");
  const thresholds  = SCARCITY_THRESHOLDS[cat] || SCARCITY_THRESHOLDS.default;
  const liveCount   = uiItems.filter(i => i?.sold !== true).length;

  const tier = liveCount <= thresholds.scarce   ? "scarce"
             : liveCount <= thresholds.normal    ? "normal"
             : liveCount <= thresholds.flooded   ? "high_supply"
             : "flooded";

  const scarcityScore = tier === "scarce"      ? 0.90
                      : tier === "normal"       ? 0.60
                      : tier === "high_supply"  ? 0.35
                      : 0.15;

  return {
    liveListingCount: liveCount,
    tier,
    scarcityScore:    round2(scarcityScore),
    thresholds,
    signal: tier === "scarce"
      ? `Only ${liveCount} listing${liveCount !== 1 ? "s" : ""} available — scarce supply, buy window may be short`
      : tier === "flooded"
      ? `${liveCount} listings available — oversupplied market, negotiate hard`
      : null,
  };
}

/**
 * Compute sell-through pressure from sold vs. live listing ratio.
 */
export function computeSellThroughPressure(uiItems = []) {
  if (!Array.isArray(uiItems) || !uiItems.length) return null;

  const soldCount  = uiItems.filter(i => i?.sold === true || String(i?.status || "").toLowerCase() === "sold").length;
  const liveCount  = uiItems.length - soldCount;
  const ratio      = uiItems.length > 0 ? round2(soldCount / uiItems.length) : 0;

  const pressure = ratio >= 0.60 ? "very_high"
                 : ratio >= 0.40 ? "high"
                 : ratio >= 0.20 ? "moderate"
                 : "low";

  const sellerWindow = pressure === "very_high" ? "open"
                     : pressure === "high"       ? "open"
                     : pressure === "moderate"   ? "moderate"
                     : "closed";

  return {
    soldCount,
    liveCount,
    totalSeen:       uiItems.length,
    soldRatio:       ratio,
    pressure,
    sellerWindow,
    signal: pressure === "very_high"
      ? `${(ratio * 100).toFixed(0)}% of listings are sold — extremely hot market, list ASAP`
      : pressure === "high"
      ? `${(ratio * 100).toFixed(0)}% sell-through — strong demand, good time to sell`
      : pressure === "low"
      ? `Low sell-through — market is slow, expect longer time to sell`
      : null,
  };
}

/**
 * Detect price compression (many listings in a tight band = fair market, hard to undercut).
 * vs. wide spread (arbitrage opportunity).
 */
export function detectPriceCompression(uiItems = []) {
  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (prices.length < 3) return null;

  const median    = prices[Math.floor(prices.length / 2)];
  const p10       = prices[Math.floor(prices.length * 0.10)];
  const p90       = prices[Math.floor(prices.length * 0.90)];
  const iqrSpread = round2(((p90 - p10) / median) * 100);

  const compression = iqrSpread < 15  ? "tight"     // prices clustered — efficient market
                    : iqrSpread < 35  ? "moderate"
                    : iqrSpread < 60  ? "wide"       // spread — arbitrage exists
                    : "very_wide";

  return {
    p10:        round2(p10),
    median:     round2(median),
    p90:        round2(p90),
    iqrSpread,
    compression,
    signal: compression === "tight"
      ? "Price-efficient market — listings tightly clustered, little room to arbitrage"
      : compression === "wide" || compression === "very_wide"
      ? `Wide price spread (${iqrSpread.toFixed(0)}%) — significant variation between listings, shop around`
      : null,
  };
}

/**
 * Detect listing freshness signals from available data.
 * Infers recency from listing structure (new listings = more competition or hot drop).
 */
export function detectListingVelocity(uiItems = []) {
  if (!Array.isArray(uiItems) || uiItems.length < 2) return null;

  // Proxy for velocity: ratio of listings with recent timestamps or "new" indicators
  const withTimestamp = uiItems.filter(i => i?.listedAt || i?.date || i?.createdAt).length;
  const totalCount    = uiItems.length;

  // If items have timestamps, compute recency
  const recentCutoffMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now            = Date.now();
  const recentCount    = uiItems.filter(i => {
    const ts = i?.listedAt || i?.date || i?.createdAt;
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return Number.isFinite(t) && (now - t) < recentCutoffMs;
  }).length;

  // If no timestamps available, fall back to listing count signal
  if (withTimestamp === 0) {
    return {
      available:    false,
      totalListed:  totalCount,
      recentCount:  null,
      signal:       totalCount > 10 ? `${totalCount} listings visible — active market` : null,
    };
  }

  const recentRatio = round2(recentCount / totalCount);
  const velocity    = recentRatio >= 0.60 ? "high"
                    : recentRatio >= 0.30 ? "moderate"
                    : "low";

  return {
    available:    true,
    totalListed:  totalCount,
    recentCount,
    recentRatio,
    velocity,
    signal: velocity === "high"
      ? `${recentCount} of ${totalCount} listings are recent — high activity, competitive market`
      : velocity === "low"
      ? `Stale market — most listings are older, less competition`
      : null,
  };
}

/**
 * Master demand signal payload.
 */
export function buildDemandSignalPayload({
  uiItems  = [],
  category = "",
} = {}) {
  const scarcity        = scoreScarcity(uiItems, category);
  const sellThrough     = computeSellThroughPressure(uiItems);
  const compression     = detectPriceCompression(uiItems);
  const velocity        = detectListingVelocity(uiItems);

  // Overall demand score: weighted composite
  const demandScore = round2(
    (scarcity?.scarcityScore      || 0.5) * 0.35 +
    (mapPressureToScore(sellThrough?.pressure)) * 0.40 +
    (velocity?.velocity === "high" ? 0.8 : velocity?.velocity === "moderate" ? 0.5 : 0.3) * 0.25
  );

  const demandTier = demandScore >= 0.70 ? "hot"
                   : demandScore >= 0.50 ? "warm"
                   : demandScore >= 0.30 ? "cool"
                   : "cold";

  const signals = [
    scarcity?.signal,
    sellThrough?.signal,
    compression?.signal,
    velocity?.signal,
  ].filter(Boolean);

  return {
    demandScore,
    demandTier,
    signals,
    scarcity:     scarcity     || null,
    sellThrough:  sellThrough  || null,
    compression:  compression  || null,
    velocity:     velocity     || null,
    buyerAdvice:  demandTier === "hot"
      ? "High demand — act fast, listings move quickly"
      : demandTier === "warm"
      ? "Healthy demand — standard urgency applies"
      : demandTier === "cold"
      ? "Soft demand — negotiate hard, sellers are motivated"
      : null,
    sellerAdvice: demandTier === "hot"
      ? "List now — this is a seller's market"
      : demandTier === "cold"
      ? "Hold unless you need cash — demand is soft"
      : "List at market — steady demand",
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function mapPressureToScore(pressure) {
  return pressure === "very_high" ? 0.95
       : pressure === "high"      ? 0.75
       : pressure === "moderate"  ? 0.50
       : 0.20;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
