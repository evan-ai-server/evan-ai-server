// src/resaleSpeedPredictor.js
// Resale Speed Predictor: models days-to-sell per platform based on demand tier,
// price position vs. market, condition, category, and sell-through velocity.
// "At market price: ~3 days StockX, ~7 days eBay, ~14 days Depop."

// ── Base days-to-sell by category + platform ─────────────────────────────────
// Warm demand, at market price, good condition
const BASE_DAYS = {
  sneakers: {
    stockx:   3,
    goat:     4,
    ebay:     5,
    depop:    8,
    poshmark: 10,
    mercari:  7,
  },
  electronics: {
    ebay:     4,
    mercari:  5,
    offerup:  3,
    swappa:   4,
    depop:    12,
    poshmark: 15,
  },
  bag: {
    "the real real": 10,
    vestiaire:       14,
    ebay:            8,
    poshmark:        7,
    depop:           10,
    fashionphile:    12,
  },
  watch: {
    chrono24:  12,
    ebay:      10,
    poshmark:  14,
    mercari:   8,
  },
  apparel: {
    depop:    5,
    poshmark: 6,
    ebay:     7,
    mercari:  6,
    "the real real": 14,
  },
  eyewear: {
    ebay:     7,
    poshmark: 8,
    depop:    9,
    mercari:  8,
    vestiaire: 14,
  },
  default: {
    ebay:     7,
    depop:    9,
    poshmark: 10,
    mercari:  8,
  },
};

// ── Multiplier tables ─────────────────────────────────────────────────────────

const DEMAND_MULTIPLIER = {
  hot:  0.50,  // sell twice as fast
  warm: 1.00,
  cool: 1.80,
  cold: 3.50,
};

const PRICE_POSITION_MULTIPLIER = {
  steal:       0.60,  // priced low = sells fast
  good:        0.80,
  fair:        1.00,
  high:        1.80,
  price_trap:  3.00,
};

const CONDITION_MULTIPLIER = {
  new:         0.70,
  like_new:    0.80,
  very_good:   1.00,
  good:        1.20,
  fair:        1.70,
  poor:        2.80,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Predict days-to-sell for a single platform.
 */
export function predictDaysToSell({
  platform       = "ebay",
  category       = "",
  demandTier     = "warm",
  dealVerdict    = "fair",
  conditionLabel = "good",
  sellThroughRatio = null,  // from marketMomentum
} = {}) {
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");
  const bases = BASE_DAYS[cat] || BASE_DAYS.default;
  const base  = bases[platform] || 7;

  const demandMult    = DEMAND_MULTIPLIER[demandTier]      ?? 1.0;
  const priceMult     = PRICE_POSITION_MULTIPLIER[dealVerdict] ?? 1.0;

  const condKey       = String(conditionLabel || "good").toLowerCase().replace(/\s+|-/g, "_");
  const conditionMult = CONDITION_MULTIPLIER[condKey] ?? CONDITION_MULTIPLIER.good;

  // Sell-through ratio bonus: high velocity market = faster
  const velocityMult  = sellThroughRatio !== null
    ? (1 - (Math.min(0.60, sellThroughRatio) * 0.5))  // up to 30% faster at 60% sell-through
    : 1.0;

  const days = Math.max(1, Math.round(base * demandMult * priceMult * conditionMult * velocityMult));
  return days;
}

/**
 * Predict days-to-sell across all relevant platforms for a category.
 */
export function predictAllPlatforms({
  category       = "",
  demandTier     = "warm",
  dealVerdict    = "fair",
  conditionLabel = "good",
  sellThroughRatio = null,
} = {}) {
  const cat       = String(category || "").toLowerCase().replace(/s$/, "");
  const platforms = Object.keys(BASE_DAYS[cat] || BASE_DAYS.default);

  const predictions = platforms.map(platform => ({
    platform,
    daysToSell: predictDaysToSell({ platform, category, demandTier, dealVerdict, conditionLabel, sellThroughRatio }),
  })).sort((a, b) => a.daysToSell - b.daysToSell);

  return predictions;
}

/**
 * Find the fastest-selling platform.
 */
export function getFastestPlatform(predictions = []) {
  if (!predictions.length) return null;
  return predictions[0];
}

/**
 * Master resale speed predictor payload.
 */
export function buildResaleSpeedPayload({
  category         = "",
  demandSignals    = null,
  dealComparator   = null,
  conditionPricing = null,
  marketMomentum   = null,
} = {}) {
  const demandTier     = demandSignals?.tier || "warm";
  const dealVerdict    = dealComparator?.verdict || "fair";
  const conditionLabel = conditionPricing?.normalizedCondition || "good";
  const sellThrough    = marketMomentum?.velocity?.sellThroughRatio ?? null;

  const predictions    = predictAllPlatforms({
    category, demandTier, dealVerdict, conditionLabel, sellThroughRatio: sellThrough,
  });
  const fastest        = getFastestPlatform(predictions);

  const summaryLine = predictions
    .slice(0, 3)
    .map(p => `~${p.daysToSell}d on ${p.platform}`)
    .join(", ");

  return {
    predictions,
    fastestPlatform:  fastest?.platform   || null,
    fastestDays:      fastest?.daysToSell || null,
    demandTier,
    dealVerdict,
    topSignal: fastest
      ? `Fastest on ${fastest.platform}: ~${fastest.daysToSell} day${fastest.daysToSell !== 1 ? "s" : ""} to sell (${summaryLine})`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
