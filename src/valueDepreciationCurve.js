// src/valueDepreciationCurve.js
// Forward value projection: predicts what this item will be worth in 3/6/12 months.
// Brand-specific curves, category decay rates, appreciation signals.
// "This Apple Watch will be worth $180 in 6 months — buy now or wait for the dip."

// ── Annual depreciation rates (%/year, negative = appreciation) ──────────────
// Positive = loses value, negative = gains value
const BRAND_ANNUAL_DEPRECIATION = {
  // Appreciating (negative = gains)
  "rolex":             -0.05,  // ~5% annual appreciation (conservative)
  "patek philippe":    -0.08,
  "ap":                -0.04,
  "omega":             -0.02,
  "seiko skx":         -0.06,  // discontinued = scarcity appreciation
  "supreme box logo":  -0.03,  // BOGO holds / appreciates
  "louis vuitton":      0.00,  // holds value flat
  "chanel":            -0.04,  // consistent appreciation
  "hermes":            -0.06,  // Birkin-driven appreciation

  // Neutral / slow decay
  "jordan 1":           0.05,  // slight decay once hype cools
  "jordan 4":           0.04,
  "new balance 990":    0.03,
  "tag heuer":          0.04,
  "hamilton":           0.03,

  // Moderate decay
  "nike dunk":          0.15,  // oversaturation
  "adidas yeezy":       0.20,  // post-Kanye collapse
  "samsung":            0.25,
  "coach":              0.08,
  "michael kors":       0.10,
  "kate spade":         0.08,

  // Fast decay
  "apple iphone":       0.45,  // ~45% in first year
  "apple watch":        0.35,
  "airpods":            0.40,
  "sony headphones":    0.30,
  "beats":              0.30,
  "samba adidas":       0.18,  // at peak, fading
  "palace":             0.20,

  // Very fast decay
  "samsung galaxy":     0.50,
  "meta quest":         0.40,
  "iphone base":        0.50,
};

// Category-level fallbacks when no brand match
const CATEGORY_ANNUAL_DEPRECIATION = {
  electronics:  0.35,
  sneakers:     0.12,
  apparel:      0.15,
  bag:          0.05,
  watch:        0.02,
  eyewear:      0.18,
  collectibles: 0.08,
  default:      0.20,
};

// Condition-adjusted depreciation multiplier
// New items depreciate faster (first-owner penalty); used items more stable
const CONDITION_DECAY_MULTIPLIER = {
  new:       1.20,  // new items take the biggest hit first
  like_new:  1.00,
  good:      0.80,
  fair:      0.60,
  poor:      0.40,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve annual depreciation rate for an item.
 */
function resolveDepreciationRate(identity = {}, category = "") {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const key   = `${brand} ${model}`.trim();

  // Try brand+model match first
  for (const [bKey, rate] of Object.entries(BRAND_ANNUAL_DEPRECIATION)) {
    if (key.includes(bKey) || bKey.split(" ").every(t => t.length >= 3 && key.includes(t))) {
      return { rate, source: "brand_model", key: bKey };
    }
  }

  // Brand-only fallback
  for (const [bKey, rate] of Object.entries(BRAND_ANNUAL_DEPRECIATION)) {
    if (brand.includes(bKey) || bKey.includes(brand)) {
      return { rate, source: "brand", key: bKey };
    }
  }

  // Category fallback
  const cat = String(category || "").toLowerCase().replace(/s$/, "");
  const catRate = CATEGORY_ANNUAL_DEPRECIATION[cat] || CATEGORY_ANNUAL_DEPRECIATION.default;
  return { rate: catRate, source: "category", key: cat };
}

/**
 * Project value at a future time horizon.
 * @param currentPrice - current market price
 * @param annualRate - fractional annual rate (positive = depreciates)
 * @param months - projection horizon in months
 */
function projectValue(currentPrice, annualRate, months) {
  const fraction = months / 12;
  // Continuous compounding: V(t) = V0 * e^(-r*t) for depreciation
  // For appreciation (negative rate): V(t) = V0 * e^(|r|*t)
  const futureValue = currentPrice * Math.pow(1 - annualRate, fraction);
  return Math.max(0, round2(futureValue));
}

/**
 * Build the full value depreciation curve for an item.
 */
export function buildValueDepreciationCurve({
  identity       = {},
  category       = "",
  currentPrice   = null,
  conditionLabel = "",
  medianMarket   = null,
} = {}) {
  const price = finiteOrNull(currentPrice) || finiteOrNull(medianMarket);
  if (!price) return null;

  const { rate: baseRate, source, key: rateKey } = resolveDepreciationRate(identity, category);

  // Condition adjustment
  const condKey    = resolveConditionKey(conditionLabel);
  const condMult   = CONDITION_DECAY_MULTIPLIER[condKey] ?? 1.0;
  const effectiveRate = baseRate * condMult;

  // Appreciation signal (negative effective rate)
  const isAppreciating = effectiveRate < 0;
  const absRate        = Math.abs(effectiveRate);

  // Project at 3, 6, 12, 24 months
  const projections = [3, 6, 12, 24].map(months => {
    const projectedPrice  = projectValue(price, effectiveRate, months);
    const changeDollars   = round2(projectedPrice - price);
    const changePct       = round2((changeDollars / price) * 100);
    return {
      months,
      projectedPrice,
      changeDollars,
      changePct,
      direction: changeDollars < 0 ? "down" : changeDollars > 0 ? "up" : "flat",
    };
  });

  const at3m  = projections[0];
  const at6m  = projections[1];
  const at12m = projections[2];

  // Buy/wait recommendation
  const buyNowSignal = (() => {
    if (isAppreciating) return "buy_now";
    if (Math.abs(at6m.changePct) >= 25) return "buy_now"; // big drop — consider now vs. then
    if (Math.abs(at3m.changePct) <= 5)  return "neutral";
    return "wait_to_see";
  })();

  const verdict = isAppreciating
    ? `Appreciating asset — buy now, this will be worth ~$${at12m.projectedPrice.toFixed(2)} in 12 months (+${Math.abs(at12m.changePct).toFixed(0)}%)`
    : at6m.changePct <= -15
    ? `Depreciating fast — this will be worth ~$${at6m.projectedPrice.toFixed(2)} in 6 months. Buy now or wait for the floor.`
    : at12m.changePct <= -30
    ? `Long-term decline — expect ~$${at12m.projectedPrice.toFixed(2)} in 12 months. Sell if holding.`
    : `Moderate depreciation — estimated ~$${at12m.projectedPrice.toFixed(2)} in 12 months`;

  return {
    currentPrice:   round2(price),
    conditionKey:   condKey,
    annualRate:     round2(effectiveRate * 100), // as %
    isAppreciating,
    rateSource:     source,
    rateKey,
    projections,
    at3m,
    at6m,
    at12m,
    buyNowSignal,
    verdict,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function resolveConditionKey(label) {
  const c = String(label || "").toLowerCase();
  if (/\b(new|ds|deadstock|nwt|sealed|unworn)\b/.test(c))           return "new";
  if (/\b(like new|vnds|excellent|mint|open box)\b/.test(c))        return "like_new";
  if (/\b(good|guc|euc|lightly used)\b/.test(c))                    return "good";
  if (/\b(fair|worn|used)\b/.test(c))                               return "fair";
  if (/\b(poor|damaged|parts)\b/.test(c))                           return "poor";
  return "good";
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
