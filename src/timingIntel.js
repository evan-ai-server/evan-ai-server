// src/timingIntel.js
// Predictive Pricing + Timing Intelligence
// Tells users: buy now, wait for drop, or watch window.
// Inputs: price history, market data, category, seasonality, scan velocity.

// ── Timing Signal Definitions ─────────────────────────────────────────────────
// BUY_NOW   — strong conditions favor immediate purchase
// WAIT      — price likely to drop within observable window
// WATCH     — uncertain; monitor before committing
// SELL_NOW  — if holding, conditions favor selling
// PASS      — price too high; no near-term improvement expected

// ── Category seasonality priors ───────────────────────────────────────────────
// month index 0=Jan, window = months where demand is high (price up) vs low (buy window)
const CATEGORY_SEASON = {
  sneakers:     { highDemand: [8, 9, 10, 11], lowDemand: [1, 2, 6, 7] },
  electronics:  { highDemand: [10, 11],       lowDemand: [1, 2, 8]    },
  clothing:     { highDemand: [8, 9, 10, 11], lowDemand: [1, 2, 3, 6] },
  bags:         { highDemand: [10, 11],       lowDemand: [1, 2, 6, 7] },
  watches:      { highDemand: [11, 0],        lowDemand: [1, 2, 7, 8] },
  cameras:      { highDemand: [5, 6, 11],     lowDemand: [1, 2, 9]    },
  jewelry:      { highDemand: [0, 1, 10, 11], lowDemand: [5, 6, 7, 8] },
  vintage:      { highDemand: [3, 4, 9, 10],  lowDemand: [1, 7, 8]    },
  collectibles: { highDemand: [7, 8, 11],     lowDemand: [1, 2, 6]    },
};

const NOW_MONTH = new Date().getMonth(); // 0-indexed

/**
 * Predict the timing signal for a buy/sell decision.
 *
 * @returns {object} timingIntel — { timingSignal, priceDirection, confidence,
 *                                   whyNow, timeHorizon, risk, seasonContext }
 */
export function predictTimingSignal({
  priceHistory    = [],   // [{ price, timestamp }] sorted most-recent first
  currentPrice    = null,
  category        = "",
  buySignal       = null,
  dealStrength    = 0,
  demandScore     = 0,
  listingCount    = 0,
  isWatched       = false,
  holdingCost     = 0,
}) {
  const cat = (category || "").toLowerCase();
  const season  = CATEGORY_SEASON[cat] || null;

  // ── Price direction from history ──────────────────────────────────────────
  const direction  = predictPriceDirection(priceHistory, currentPrice);
  const seasonal   = seasonalContext(season);
  const urgency    = computeUrgency({ buySignal, dealStrength, demandScore, listingCount, direction, seasonal });

  // ── Timing signal ─────────────────────────────────────────────────────────
  let timingSignal;
  let whyNow       = [];
  let risk         = "MEDIUM";
  let timeHorizon  = "1–4 weeks";
  let confidence   = 0.5;

  if (urgency >= 80) {
    timingSignal = "BUY_NOW";
    confidence   = 0.80;
    risk         = "LOW";
    timeHorizon  = "Today";
    whyNow       = buildWhyNow({ direction, seasonal, buySignal, dealStrength, demandScore, listingCount });
  } else if (urgency >= 55) {
    timingSignal = "BUY_NOW";
    confidence   = 0.60;
    risk         = "LOW";
    timeHorizon  = "1–3 days";
    whyNow       = buildWhyNow({ direction, seasonal, buySignal, dealStrength, demandScore, listingCount });
  } else if (direction.trend === "falling" && direction.dropPct >= 8) {
    timingSignal = "WAIT";
    confidence   = 0.55;
    risk         = "LOW";
    timeHorizon  = "1–3 weeks";
    whyNow       = [`Price is falling (down ${direction.dropPct}%) — may drop further`, "Set a target price alert"];
  } else if (direction.trend === "rising" && (demandScore || 0) < 40) {
    timingSignal = "PASS";
    confidence   = 0.55;
    risk         = "HIGH";
    timeHorizon  = "N/A";
    whyNow       = ["Price is rising but demand score is low — may correct soon", "Consider alternatives"];
  } else if (seasonal?.isBuyWindow) {
    timingSignal = "WATCH";
    confidence   = 0.50;
    risk         = "MEDIUM";
    timeHorizon  = "2–4 weeks";
    whyNow       = [`You're in a seasonal buy window for ${cat} — monitor for a local dip`, "Price likely to stabilize"];
  } else {
    timingSignal = "WATCH";
    confidence   = 0.45;
    risk         = "MEDIUM";
    timeHorizon  = "1–4 weeks";
    whyNow       = ["No strong timing signal — keep watching", "Set a price alert to be notified"];
  }

  // Holding cost adjustment for WAIT signal
  if (timingSignal === "WAIT" && holdingCost > 0 && currentPrice) {
    const holdPct = (holdingCost / currentPrice) * 100;
    if (holdPct > 5) {
      timingSignal = "BUY_NOW";
      whyNow.push(`Holding cost ($${holdingCost}) offsets waiting — buy now saves more`);
    }
  }

  return {
    timingSignal,
    priceDirection: direction,
    confidence:     round2(confidence),
    whyNow,
    timeHorizon,
    risk,
    seasonContext:  seasonal,
    urgencyScore:   Math.round(urgency),
    generatedAt:    Date.now(),
  };
}

/**
 * Predict price direction from price history.
 * @returns {{ trend, dropPct, risePct, volatility, dataPoints }}
 */
export function predictPriceDirection(priceHistory = [], currentPrice = null) {
  const prices = priceHistory
    .map((h) => Number(h?.price ?? h))
    .filter((p) => Number.isFinite(p) && p > 0);

  if (prices.length < 2) {
    return { trend: "stable", dropPct: 0, risePct: 0, volatility: "unknown", dataPoints: prices.length };
  }

  const latest  = currentPrice ?? prices[0];
  const oldest  = prices[prices.length - 1];
  const delta   = latest - oldest;
  const deltaPct = Math.abs((delta / oldest) * 100);

  // Volatility: std dev / mean
  const mean    = prices.reduce((s, p) => s + p, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;
  const stdDev  = Math.sqrt(variance);
  const cv      = mean > 0 ? stdDev / mean : 0;

  const volatility = cv > 0.25 ? "high" : cv > 0.12 ? "moderate" : "low";

  let trend;
  if (delta < -0.03 * oldest)       trend = "falling";
  else if (delta > 0.03 * oldest)   trend = "rising";
  else                               trend = "stable";

  return {
    trend,
    dropPct:   trend === "falling" ? round2(deltaPct) : 0,
    risePct:   trend === "rising"  ? round2(deltaPct) : 0,
    volatility,
    dataPoints: prices.length,
    recentPrice: round2(latest),
    oldestPrice: round2(oldest),
  };
}

/**
 * Build timing advice for display.
 */
export function buildTimingAdvice(timingIntel = {}) {
  if (!timingIntel?.timingSignal) return null;

  const { timingSignal, whyNow, timeHorizon, risk, confidence, priceDirection, seasonContext } = timingIntel;

  const label = {
    BUY_NOW:  "Buy Now",
    WAIT:     "Wait for Drop",
    WATCH:    "Keep Watching",
    SELL_NOW: "Good Time to Sell",
    PASS:     "Pass on This",
  }[timingSignal] || "Watch";

  const urgencyLabel = timingSignal === "BUY_NOW" ? "URGENT"
                     : timingSignal === "WAIT"     ? "PATIENT"
                     : timingSignal === "SELL_NOW" ? "ACT NOW"
                     : "MONITOR";

  return {
    label,
    urgencyLabel,
    timingSignal,
    timeHorizon,
    risk,
    confidence,
    reasons:      whyNow || [],
    priceDirection: priceDirection?.trend || "stable",
    volatility:   priceDirection?.volatility || "unknown",
    seasonal:     seasonContext?.label || null,
    summary:      buildTimingSummary(timingSignal, whyNow, timeHorizon),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function seasonalContext(season) {
  if (!season) return null;
  const isHighDemand = season.highDemand.includes(NOW_MONTH);
  const isLowDemand  = season.lowDemand.includes(NOW_MONTH);
  const isBuyWindow  = isLowDemand;
  const label        = isHighDemand ? "Peak season — prices elevated"
                     : isLowDemand  ? "Off-season — favorable buying window"
                     : "Mid-season — typical pricing";
  return { isHighDemand, isLowDemand, isBuyWindow, label };
}

function computeUrgency({ buySignal, dealStrength, demandScore, listingCount, direction, seasonal }) {
  let urgency = 0;

  // Buy signal contribution
  if (buySignal === "STRONG BUY")  urgency += 40;
  else if (buySignal === "GOOD DEAL") urgency += 25;
  else if (buySignal === "FAIR")   urgency += 10;
  else return 0; // RISKY/INSUFFICIENT/OVERPRICED = never urgent

  // Deal strength (0–20)
  urgency += Math.min(20, (dealStrength || 0) * 60);

  // Demand (0–15)
  urgency += Math.min(15, ((demandScore || 0) / 100) * 15);

  // Price falling or in buy window → +10
  if (direction?.trend === "falling") urgency += 10;
  if (seasonal?.isBuyWindow)          urgency += 5;

  // Low supply (< 5 listings) → scarcity bump +10
  if (listingCount > 0 && listingCount < 5) urgency += 10;

  return Math.min(100, urgency);
}

function buildWhyNow({ direction, seasonal, buySignal, dealStrength, demandScore, listingCount }) {
  const reasons = [];
  if (buySignal === "STRONG BUY")           reasons.push("All buy conditions met — strong deal signal");
  if (dealStrength >= 0.30)                 reasons.push(`Price is ${Math.round(dealStrength * 100)}% below market median`);
  if (demandScore >= 60)                    reasons.push(`High demand score (${Math.round(demandScore)}) — item moves quickly`);
  if (direction?.trend === "falling")       reasons.push(`Price trending down — currently at recent low`);
  if (seasonal?.isBuyWindow)               reasons.push(seasonal.label);
  if (listingCount > 0 && listingCount < 5) reasons.push(`Only ${listingCount} active listing${listingCount !== 1 ? "s" : ""} — limited supply`);
  return reasons.slice(0, 4);
}

function buildTimingSummary(signal, reasons = [], horizon) {
  if (signal === "BUY_NOW")  return `Move ${horizon === "Today" ? "today" : `within ${horizon}`} — ${reasons[0] || "conditions are favorable"}`;
  if (signal === "WAIT")     return `Hold off ${horizon} — ${reasons[0] || "price may drop"}`;
  if (signal === "SELL_NOW") return `Good time to sell — ${reasons[0] || "market conditions favor sellers"}`;
  if (signal === "PASS")     return reasons[0] || "Price not justified — skip or watch for correction";
  return reasons[0] || "No strong signal — continue monitoring";
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
