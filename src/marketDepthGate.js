// src/marketDepthGate.js
// Market Depth Gate — caps buy signals based on comparable listing count.
//
// The core problem: a STRONG BUY based on 6 comps is a fiction.
// With <5 comps the median is not statistically meaningful.
// With 5–14 comps (thin market) confidence intervals are too wide for STRONG BUY.
//
// Thresholds (derived from empirical price variance data):
//   INSUFFICIENT (< 5):   Force INSUFFICIENT DATA, no signal
//   THIN        (5–14):   Cap at GOOD DEAL, add thin-market warning
//   DEVELOPING  (15–19):  Cap at GOOD DEAL unless liquidity >= 55
//   ADEQUATE    (20–49):  No cap — STRONG BUY allowed
//   DEEP        (50+):    No cap — highest confidence tier
//
// Liquidity score interacts:
//   liquidityScore < 20 → max signal is FAIR regardless of depth
//   liquidityScore < 40 → max signal is GOOD DEAL regardless of depth
//   liquidityScore >= 40 → normal depth gate applies

// ── Depth tier classification ─────────────────────────────────────────────────

export const DEPTH_TIERS = {
  INSUFFICIENT: { label: "Insufficient",  minCount: 0,  maxCount: 4  },
  THIN:         { label: "Thin Market",   minCount: 5,  maxCount: 14 },
  DEVELOPING:   { label: "Developing",    minCount: 15, maxCount: 19 },
  ADEQUATE:     { label: "Adequate",      minCount: 20, maxCount: 49 },
  DEEP:         { label: "Deep Market",   minCount: 50, maxCount: Infinity },
};

const SIGNAL_RANK = {
  "STRONG BUY":        5,
  "GOOD DEAL":         4,
  "FAIR":              3,
  "OVERPRICED":        2,
  "RISKY":             1,
  "INSUFFICIENT DATA": 0,
};

// ── Classify market depth ─────────────────────────────────────────────────────

export function classifyMarketDepth(count = 0) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n >= 50)  return { tier: "DEEP",         ...DEPTH_TIERS.DEEP,         count: n };
  if (n >= 20)  return { tier: "ADEQUATE",      ...DEPTH_TIERS.ADEQUATE,     count: n };
  if (n >= 15)  return { tier: "DEVELOPING",    ...DEPTH_TIERS.DEVELOPING,   count: n };
  if (n >= 5)   return { tier: "THIN",          ...DEPTH_TIERS.THIN,         count: n };
  return          { tier: "INSUFFICIENT",   ...DEPTH_TIERS.INSUFFICIENT, count: n };
}

// ── Core gate ─────────────────────────────────────────────────────────────────

/**
 * Apply market depth + liquidity caps to a raw buy signal.
 *
 * @param {object} params
 *   signal          — raw buy signal ("STRONG BUY", "GOOD DEAL", ...)
 *   compsCount      — total comparable listings (listed + sold)
 *   soldCompCount   — confirmed-sold subset (optional; improves effective depth)
 *   liquidityScore  — 0–100 from liquidityEngine
 *
 * @returns {{
 *   signal:          string,
 *   capped:          boolean,
 *   capReason:       string|null,
 *   depthTier:       string,
 *   depthLabel:      string,
 *   depthCount:      number,
 *   effectiveCount:  number,
 *   soldCompCount:   number,
 *   listedDominated: boolean,
 *   liquidityLabel:  string,
 *   warning:         string|null,
 * }}
 */
export function applyMarketDepthGate({ signal, compsCount, soldCompCount = null, liquidityScore }) {
  const rawCount = Math.max(0, Math.floor(Number(compsCount) || 0));
  const liq      = Number(liquidityScore) || 0;

  // ── Effective depth: sold comps weighted 1.0, listed-only at 0.5 ──────────
  let effectiveCount  = rawCount;
  let soldN           = rawCount; // assume all sold when soldCompCount not provided
  let listedDominated = false;

  if (soldCompCount != null) {
    soldN            = Math.max(0, Math.floor(Number(soldCompCount) || 0));
    const listedOnly = Math.max(0, rawCount - soldN);
    effectiveCount   = Math.round(soldN + listedOnly * 0.5);
    listedDominated  = rawCount > 0 && effectiveCount < rawCount * 0.60;
  }

  const depth = classifyMarketDepth(effectiveCount);

  let finalSignal = signal;
  let capped      = false;
  let capReason   = null;

  // ── Gate 1: Liquidity hard caps — no exceptions ────────────────────────────
  if (liq < 35) {
    // liq < 35: STRONG BUY is not credible in this market
    finalSignal = capTo(finalSignal, "GOOD DEAL");
    if (finalSignal !== signal) {
      capped    = true;
      capReason = `Low liquidity (${liq}/100) — market does not trade frequently enough for STRONG BUY`;
    }
  } else if (liq < 55) {
    // liq 35–54: STRONG BUY specifically blocked; other signals pass
    if (finalSignal === "STRONG BUY") {
      finalSignal = "GOOD DEAL";
      capped      = true;
      capReason   = `Liquidity score (${liq}/100) below STRONG BUY threshold (55)`;
    }
  }

  // ── Gate 2: Market depth cap (uses effective count) ────────────────────────
  if (depth.tier === "INSUFFICIENT") {
    const floor = "INSUFFICIENT DATA";
    if (SIGNAL_RANK[finalSignal] > SIGNAL_RANK[floor]) {
      finalSignal = floor;
      capped      = true;
      capReason   = capReason ?? `Only ${effectiveCount} confirmed comp${effectiveCount !== 1 ? "s" : ""} — need 5+ for meaningful pricing`;
    }
  } else if (depth.tier === "THIN") {
    const capped2 = capTo(finalSignal, "GOOD DEAL");
    if (capped2 !== finalSignal) {
      finalSignal = capped2;
      capped      = true;
      capReason   = capReason ?? `Thin market (${effectiveCount} effective comps) — price estimate has wide uncertainty`;
    }
  } else if (depth.tier === "DEVELOPING" && finalSignal === "STRONG BUY" && liq < 55) {
    finalSignal = "GOOD DEAL";
    capped      = true;
    capReason   = capReason ?? `Developing market (${effectiveCount} comps) with moderate liquidity`;
  }

  // ── Listed-dominated: mostly wishful-seller pricing ───────────────────────
  if (listedDominated && finalSignal === "STRONG BUY") {
    finalSignal = "GOOD DEAL";
    capped      = true;
    capReason   = capReason ?? `Most comps are unsold listings (${soldN} sold of ${rawCount} total) — market may not clear at this price`;
  }

  const warning = capped ? capReason : null;

  return {
    signal:          finalSignal,
    capped,
    capReason,
    depthTier:       depth.tier,
    depthLabel:      depth.label,
    depthCount:      rawCount,
    effectiveCount,
    soldCompCount:   soldN,
    listedDominated,
    liquidityLabel:  liquidityLabel(liq),
    warning,
  };
}

// ── Minimum comps required for a given signal ─────────────────────────────────

export function minCompsForSignal(signal) {
  if (signal === "STRONG BUY") return 20;
  if (signal === "GOOD DEAL")  return 5;
  return 0;
}

// ── Build depth context for API response ─────────────────────────────────────

export function buildDepthContext(compsCount, liquidityScore) {
  const depth = classifyMarketDepth(compsCount);
  const liq   = Number(liquidityScore) || 0;

  const depthNote = depth.tier === "INSUFFICIENT"
    ? `Only ${depth.count} listings found — sample too small to price reliably`
    : depth.tier === "THIN"
    ? `${depth.count} listings found — thin market, expect wider price swings`
    : depth.tier === "DEVELOPING"
    ? `${depth.count} listings found — developing market`
    : depth.tier === "ADEQUATE"
    ? `${depth.count} listings — solid sample for pricing`
    : `${depth.count}+ listings — deep, liquid market`;

  return {
    depthTier:    depth.tier,
    depthLabel:   depth.label,
    depthCount:   depth.count,
    depthNote,
    liquidityScore: liq,
    liquidityLabel: liquidityLabel(liq),
    canStrongBuy: depth.count >= 20 && liq >= 40,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function capTo(signal, maxAllowed) {
  const current = SIGNAL_RANK[signal] ?? 0;
  const max     = SIGNAL_RANK[maxAllowed] ?? 0;
  return current > max ? maxAllowed : signal;
}

function liquidityLabel(score) {
  if (score >= 82) return "hot";
  if (score >= 66) return "liquid";
  if (score >= 48) return "moderate";
  if (score >= 30) return "slow";
  return "illiquid";
}
