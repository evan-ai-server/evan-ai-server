// src/pricePredictionModel.js
// Price Prediction Model: projects market price at 30, 60, and 90 days by
// combining depreciation rate, seasonal demand curve, market momentum, and
// trend phase. Produces confidence intervals and a buy/wait verdict.
// "Expected: $145-155 in 30d, $130-145 in 90d. Wait 6 weeks to buy."

// ── Volatility by category (annualized std dev estimate) ─────────────────────
const CATEGORY_VOLATILITY = {
  sneakers:    0.22, // high hype-driven swings
  electronics: 0.28, // depreciates fast, volatile
  bag:         0.12, // luxury is stickier
  watch:       0.10, // most stable
  apparel:     0.18,
  eyewear:     0.15,
  default:     0.20,
};

// ── Trend phase multipliers (per-month drift) ─────────────────────────────────
const TREND_PHASE_DRIFT = {
  emerging:   +0.025,  // +2.5%/mo — hype building
  rising:     +0.015,  // +1.5%/mo
  peak:        0.000,  // flat — saturation
  fading:     -0.020,  // -2%/mo
  dead:       -0.040,  // -4%/mo
  evergreen:  +0.003,  // slow appreciation
};

// ── Seasonal adjustment per month offset ─────────────────────────────────────
// Returns demand index delta from current month to target month
function getSeasonalDrift(category = "", fromMonth = null, toMonth = null) {
  // Simple sine approximation — actual curves are in seasonalFlipCalendar.js
  // Here we just use the relative change between two months
  const PEAK_MONTHS = {
    sneakers:    [4, 11],
    electronics: [11, 7],
    bag:         [11, 2],
    watch:       [6, 11],
    apparel:     [4, 11],
    eyewear:     [6, 7],
    default:     [11],
  };
  const cat    = String(category || "").toLowerCase().replace(/s$/, "");
  const peaks  = PEAK_MONTHS[cat] || PEAK_MONTHS.default;
  const from   = fromMonth  ?? new Date().getMonth() + 1;
  const to     = ((from - 1 + toMonth) % 12) + 1;

  const distFrom = Math.min(...peaks.map(p => Math.abs(p - from)));
  const distTo   = Math.min(...peaks.map(p => Math.abs(p - to)));

  // Positive = moving toward peak (prices rise), negative = moving away
  return (distFrom - distTo) * 0.008; // ~0.8% per month closer to peak
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Project price at a specific number of days out.
 */
export function projectPrice({
  currentPrice     = null,
  days             = 30,
  category         = "",
  annualDepreciationPct = 0,
  momentumTier     = "stable",
  trendPhase       = null,
  currentMonth     = null,
} = {}) {
  const base = finiteOrNull(currentPrice);
  if (!base) return null;

  const months   = days / 30;
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const vol      = CATEGORY_VOLATILITY[cat] ?? CATEGORY_VOLATILITY.default;

  // 1. Depreciation component (annual → monthly)
  const deprMonthly = (annualDepreciationPct / 100) / 12;
  const deprFactor  = Math.pow(1 - deprMonthly, months);

  // 2. Momentum drift
  const momentumMonthly = momentumTier === "surging"   ? +0.025
                        : momentumTier === "rising"    ? +0.012
                        : momentumTier === "stable"    ?  0.000
                        : momentumTier === "softening" ? -0.015
                        : -0.030; // falling
  const momentumFactor = Math.pow(1 + momentumMonthly, months);

  // 3. Trend phase drift
  const phaseDrift = TREND_PHASE_DRIFT[trendPhase] ?? 0;
  const phaseFactor = Math.pow(1 + phaseDrift, months);

  // 4. Seasonal drift
  const fromMonth   = currentMonth ?? new Date().getMonth() + 1;
  const seasonAdj   = getSeasonalDrift(category, fromMonth, Math.round(months));
  const seasonFactor = 1 + seasonAdj;

  // Composite projected price
  const projected = round2(base * deprFactor * momentumFactor * phaseFactor * seasonFactor);

  // Confidence interval using volatility
  const volForPeriod = vol * Math.sqrt(months / 12);
  const low  = round2(projected * (1 - volForPeriod));
  const high = round2(projected * (1 + volForPeriod));
  const confidence = Math.max(30, Math.round(85 - months * 3)); // confidence shrinks with time

  return {
    days,
    projected,
    low,
    high,
    range:      `$${low.toFixed(2)}–$${high.toFixed(2)}`,
    confidence,
    changePct:  round2(((projected - base) / base) * 100),
  };
}

/**
 * Build full price projection at 30, 60, 90 days.
 */
export function buildPriceProjection({
  currentPrice          = null,
  category              = "",
  depreciationCurve     = null,
  marketMomentum        = null,
  trendIntel            = null,
  currentMonth          = null,
} = {}) {
  const base              = finiteOrNull(currentPrice);
  if (!base) return null;

  const annualDeprPct     = depreciationCurve?.annualDepreciationPct ?? 0;
  const momentumTier      = marketMomentum?.overallTier ?? "stable";
  const trendPhase        = trendIntel?.phase ?? null;

  const p30 = projectPrice({ currentPrice: base, days: 30,  category, annualDepreciationPct: annualDeprPct, momentumTier, trendPhase, currentMonth });
  const p60 = projectPrice({ currentPrice: base, days: 60,  category, annualDepreciationPct: annualDeprPct, momentumTier, trendPhase, currentMonth });
  const p90 = projectPrice({ currentPrice: base, days: 90,  category, annualDepreciationPct: annualDeprPct, momentumTier, trendPhase, currentMonth });

  // Buy/wait verdict
  const isRising   = (p30?.changePct ?? 0) > 3;
  const isFalling  = (p30?.changePct ?? 0) < -5;
  const bigDrop90  = (p90?.changePct ?? 0) < -12;

  const verdict = isRising   ? "BUY_NOW"    // price going up — act fast
                : bigDrop90  ? "WAIT"        // significant drop expected — wait
                : isFalling  ? "WAIT_SHORT"  // falling, wait a few weeks
                :              "NEUTRAL";

  const verdictNote = verdict === "BUY_NOW"
    ? `Price rising — buy now before it climbs further`
    : verdict === "WAIT"
    ? `Price expected to drop ~${Math.abs(p90?.changePct ?? 0).toFixed(0)}% in 90 days — wait for the floor`
    : verdict === "WAIT_SHORT"
    ? `Mild decline expected — wait 2-4 weeks for better price`
    : `Price expected to stay flat — buy when ready`;

  return {
    currentPrice:   base,
    projections: {
      day30: p30,
      day60: p60,
      day90: p90,
    },
    verdict,
    verdictNote,
    inputs: {
      annualDeprPct,
      momentumTier,
      trendPhase,
    },
    topSignal: p30
      ? `30-day outlook: ${p30.range} (${p30.changePct > 0 ? "+" : ""}${p30.changePct}%) | ${verdictNote}`
      : null,
  };
}

/**
 * Master price prediction payload.
 */
export function buildPricePredictionPayload({
  scannedPrice      = null,
  medianMarket      = null,
  category          = "",
  depreciationCurve = null,
  marketMomentum    = null,
  trendIntel        = null,
} = {}) {
  const price = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  const projection = buildPriceProjection({
    currentPrice: price,
    category,
    depreciationCurve,
    marketMomentum,
    trendIntel,
  });

  return {
    projection:  projection || null,
    topSignal:   projection?.topSignal || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function round2(v) { return Math.round(v * 100) / 100; }
