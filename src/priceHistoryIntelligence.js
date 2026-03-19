// src/priceHistoryIntelligence.js
// Price timing oracle: seasonal price patterns, cycle detection,
// "buy now vs. wait" signals, and historical low/high context.

// ── Seasonal price calendars ──────────────────────────────────────────────────
// Month indexes: 0=Jan … 11=Dec
// Multiplier vs. annual average: >1 = expensive season, <1 = cheap season
const CATEGORY_SEASONAL_CURVES = {
  sneakers: [1.05, 1.00, 0.97, 0.95, 0.93, 0.90, 0.92, 0.95, 1.00, 1.05, 1.10, 1.08],
  // Jan/Feb after holiday = soft; summer = softest; back-to-school Sep + holiday = peak
  apparel:  [0.90, 0.88, 0.92, 0.95, 1.00, 1.02, 1.00, 0.95, 1.00, 1.05, 1.10, 1.08],
  // Summer slowdown; holiday Q4 = peak
  electronics: [0.95, 1.05, 1.00, 0.98, 0.97, 0.95, 0.93, 0.90, 1.05, 1.08, 1.12, 1.10],
  // Post-CES spike Feb; back-to-school Aug dip; holiday Q4 peak
  watch:    [1.02, 1.00, 0.98, 0.97, 0.95, 0.93, 0.92, 0.93, 0.97, 1.00, 1.05, 1.08],
  // Holiday gift-buying Dec/Nov = peak; summer = trough
  bag:      [0.95, 0.97, 1.00, 1.02, 1.03, 1.02, 1.00, 0.98, 1.00, 1.02, 1.08, 1.10],
  eyewear:  [0.95, 0.95, 0.97, 1.00, 1.05, 1.08, 1.10, 1.08, 1.02, 0.98, 0.95, 0.93],
  // Spring/summer = peak sunglass demand; winter = trough
  collectibles: [1.00, 1.02, 1.03, 1.03, 1.02, 1.00, 0.97, 0.95, 0.98, 1.02, 1.05, 1.08],
};

// Known sale/drop windows by category (month + label)
const KNOWN_SALE_WINDOWS = {
  sneakers: [
    { month: 10, label: "Nike/Adidas Black Friday drops",  discountEst: "10-20%" },
    { month:  6, label: "Mid-year clearance — older colorways go soft", discountEst: "10-15%" },
    { month:  1, label: "Post-holiday sneaker softness",   discountEst: "5-12%" },
  ],
  electronics: [
    { month: 10, label: "Black Friday / Cyber Monday — peak electronics deals", discountEst: "15-30%" },
    { month:  6, label: "Amazon Prime Day deals",          discountEst: "10-20%" },
    { month:  8, label: "Back-to-school sales",            discountEst: "8-15%" },
    { month:  1, label: "Post-CES new-model discounts on last-gen", discountEst: "10-25%" },
  ],
  apparel: [
    { month: 10, label: "Black Friday + end-of-season clearance",    discountEst: "20-40%" },
    { month:  6, label: "End-of-summer clearance",        discountEst: "15-30%" },
    { month:  1, label: "January clearance",               discountEst: "20-35%" },
  ],
  bag: [
    { month: 10, label: "Holiday gift-buying — resale prices peak",  discountEst: "-5% (prices UP)" },
    { month:  1, label: "Post-holiday luxury softness",   discountEst: "5-10%" },
  ],
  watch: [
    { month: 10, label: "Holiday watch gifting — prices firm",       discountEst: "-5% (prices UP)" },
    { month:  6, label: "Summer lull — softest watch market",        discountEst: "5-8%" },
  ],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Get the current seasonal price position for a category.
 * Returns where in the annual cycle we are (cheap/expensive/neutral).
 */
export function getSeasonalPricePosition(category = "", referenceDate = null) {
  const now   = referenceDate ? new Date(referenceDate) : new Date();
  const month = now.getMonth(); // 0-11
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");

  const curve = CATEGORY_SEASONAL_CURVES[cat] || null;
  if (!curve) return null;

  const currentMultiplier = curve[month];
  const minMultiplier     = Math.min(...curve);
  const maxMultiplier     = Math.max(...curve);
  const avgMultiplier     = curve.reduce((s, v) => s + v, 0) / curve.length;

  // Find cheapest upcoming month
  let cheapestUpcomingMonth = month;
  let cheapestUpcomingValue = currentMultiplier;
  for (let i = 1; i <= 11; i++) {
    const m = (month + i) % 12;
    if (curve[m] < cheapestUpcomingValue) {
      cheapestUpcomingValue  = curve[m];
      cheapestUpcomingMonth  = m;
    }
  }

  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthsUntilCheap = ((cheapestUpcomingMonth - month) + 12) % 12;

  const position = currentMultiplier <= minMultiplier + 0.02 ? "at_low"
                 : currentMultiplier >= maxMultiplier - 0.02 ? "at_peak"
                 : currentMultiplier < avgMultiplier          ? "below_avg"
                 : "above_avg";

  const buySignal = position === "at_low"    ? "buy_now"
                  : position === "below_avg" ? "good_time"
                  : position === "at_peak"   ? "wait"
                  : "neutral";

  return {
    currentMonth:         MONTH_NAMES[month],
    currentMultiplier:    round2(currentMultiplier),
    position,
    buySignal,
    cheapestUpcomingMonth: MONTH_NAMES[cheapestUpcomingMonth],
    monthsUntilCheap,
    seasonalPctVsAvg:     round2((currentMultiplier - avgMultiplier) / avgMultiplier * 100),
    signal: position === "at_low"
      ? `Seasonal low — historically the cheapest time to buy this category`
      : position === "at_peak"
      ? `Seasonal peak — prices are ${round2((currentMultiplier - avgMultiplier) / avgMultiplier * 100)}% above average. Wait ${monthsUntilCheap} months for ${MONTH_NAMES[cheapestUpcomingMonth]} low.`
      : buySignal === "good_time"
      ? `Below-average seasonal pricing — reasonable time to buy`
      : `Neutral seasonal window`,
  };
}

/**
 * Get known upcoming sale windows for a category.
 */
export function getUpcomingSaleWindows(category = "", referenceDate = null) {
  const now      = referenceDate ? new Date(referenceDate) : new Date();
  const month    = now.getMonth();
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");

  const windows  = KNOWN_SALE_WINDOWS[cat] || [];
  if (!windows.length) return null;

  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const upcoming = windows.map(w => {
    const monthsAway = ((w.month - month) + 12) % 12;
    return { ...w, monthName: MONTH_NAMES[w.month], monthsAway };
  }).sort((a, b) => a.monthsAway - b.monthsAway);

  const next = upcoming[0];

  return {
    nextSaleWindow:  next,
    allSaleWindows:  upcoming,
    signal: next.monthsAway === 0
      ? `Sale window NOW: ${next.label} (${next.discountEst} off)`
      : `Next sale window: ${next.label} in ${next.monthsAway} month${next.monthsAway !== 1 ? "s" : ""} — expected ${next.discountEst}`,
  };
}

/**
 * Compute price context vs. the live market sample (historical low/high proxy).
 * Uses market item spread to estimate relative positioning.
 */
export function computeMarketPriceContext(scannedPrice, uiItems = [], consensus = null) {
  const scanned = finiteOrNull(scannedPrice);

  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!prices.length) return null;

  const sampleLow    = prices[0];
  const sampleHigh   = prices[prices.length - 1];
  const sampleMedian = prices[Math.floor(prices.length / 2)];
  const sampleMean   = round2(prices.reduce((s, v) => s + v, 0) / prices.length);

  const vsLow    = scanned !== null ? round2(((scanned - sampleLow)    / sampleLow)    * 100) : null;
  const vsHigh   = scanned !== null ? round2(((scanned - sampleHigh)   / sampleHigh)   * 100) : null;
  const vsMedian = scanned !== null ? round2(((scanned - sampleMedian) / sampleMedian) * 100) : null;

  const atOrNearLow = scanned !== null && scanned <= sampleLow * 1.05;
  const atOrNearHigh = scanned !== null && scanned >= sampleHigh * 0.95;

  return {
    sampleLow:    round2(sampleLow),
    sampleHigh:   round2(sampleHigh),
    sampleMedian: round2(sampleMedian),
    sampleMean,
    sampleSize:   prices.length,
    scannedPrice: scanned,
    vsLowPct:     vsLow,
    vsHighPct:    vsHigh,
    vsMedianPct:  vsMedian,
    atOrNearLow,
    atOrNearHigh,
    signal: atOrNearLow
      ? `Near the lowest in this market sample — historically a buy signal`
      : atOrNearHigh
      ? `Near the highest in this market sample — wait for a better price`
      : vsMedian !== null && vsMedian < -10
      ? `${Math.abs(vsMedian).toFixed(0)}% below median — strong value`
      : null,
  };
}

/**
 * Master price history intelligence payload.
 */
export function buildPriceHistoryIntelPayload({
  scannedPrice  = null,
  uiItems       = [],
  consensus     = null,
  category      = "",
  referenceDate = null,
} = {}) {
  const seasonal      = getSeasonalPricePosition(category, referenceDate);
  const saleWindows   = getUpcomingSaleWindows(category, referenceDate);
  const marketContext = computeMarketPriceContext(scannedPrice, uiItems, consensus);

  // Unified buy-now-vs-wait verdict
  const waitSignal = seasonal?.buySignal === "wait" || (saleWindows?.nextSaleWindow?.monthsAway ?? 99) <= 2;
  const buyNowSignal = seasonal?.buySignal === "buy_now" || marketContext?.atOrNearLow;

  const verdict = buyNowSignal ? "buy_now"
                : waitSignal   ? "wait"
                : "neutral";

  const verdictSignal = verdict === "buy_now"
    ? "Buy now — seasonal low and/or near market floor"
    : verdict === "wait"
    ? `Wait — ${saleWindows?.nextSaleWindow ? saleWindows.nextSaleWindow.label + " in " + saleWindows.nextSaleWindow.monthsAway + " months" : "seasonal peak, prices likely to soften"}`
    : "Neutral timing — no strong buy or wait signal";

  return {
    verdict,
    verdictSignal,
    seasonal:      seasonal      || null,
    saleWindows:   saleWindows   || null,
    marketContext: marketContext  || null,
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
