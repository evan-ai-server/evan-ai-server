// src/riskScoreEngine.js
// Unified purchase risk score: aggregates all intel signals into a single
// "should I buy this?" verdict with top risk factors surfaced.

// ── Risk factor weights ───────────────────────────────────────────────────────
const WEIGHTS = {
  authenticityRisk:   0.30, // highest weight — fake = total loss
  conditionMismatch:  0.20, // paying new price for worn item
  priceFloorViolation:0.15, // price below brand floor = likely fake
  dealVerdict:        0.15, // overpriced / price_trap adds risk
  demandTier:         0.10, // cold demand = illiquid = holding risk
  trendPhase:         0.10, // fading/dead trend = depreciation risk
};

// ── Scoring maps ──────────────────────────────────────────────────────────────
const AUTH_TIER_TO_RISK = {
  critical: 1.00,
  high:     0.75,
  moderate: 0.40,
  low:      0.10,
};

const DEAL_VERDICT_TO_RISK = {
  steal:      0.00,
  good_deal:  0.05,
  fair:       0.15,
  overpriced: 0.55,
  price_trap: 0.85,
};

const DEMAND_TIER_TO_RISK = {
  hot:  0.05,
  warm: 0.20,
  cool: 0.50,
  cold: 0.75,
};

const TREND_PHASE_TO_RISK = {
  emerging:  0.20,
  rising:    0.10,
  peak:      0.30,
  fading:    0.55,
  dead:      0.85,
  evergreen: 0.10,
  stable:    0.15,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute the unified purchase risk score from all available intel payloads.
 *
 * All intel payloads are optional — only present signals are weighted in.
 */
export function computePurchaseRiskScore({
  authenticityIntel  = null,
  conditionPricing   = null,
  dealComparator     = null,
  demandSignals      = null,
  trendIntel         = null,
  scannedPrice       = null,
} = {}) {
  const factors  = [];
  let   weighted = 0;
  let   totalW   = 0;

  // ── Auth risk ──────────────────────────────────────────────────────────────
  const authTier = authenticityIntel?.tier || null;
  if (authTier) {
    const score = AUTH_TIER_TO_RISK[authTier] ?? 0.25;
    weighted += score * WEIGHTS.authenticityRisk;
    totalW   += WEIGHTS.authenticityRisk;
    if (score >= 0.40) {
      factors.push({
        key:      "authenticity_risk",
        severity: score >= 0.75 ? "critical" : "high",
        label:    `Authenticity risk: ${authTier}`,
        detail:   authenticityIntel?.recommendation || null,
        score,
      });
    }
  }

  // ── Price floor violation ──────────────────────────────────────────────────
  // The previous `else { totalW += W }` branches on each missing factor padded
  // total weight without contributing score, diluting real risk signals into
  // "safe" (e.g. auth=high alone scored 0.23 because 5 phantom dimensions
  // voted 0). Missing factors must be excluded from the average, not zeroed.
  const floorCheck = authenticityIntel?.priceFloorCheck || conditionPricing?.mismatch || null;
  if (floorCheck?.violated) {
    const score = floorCheck.riskLevel === "critical" ? 0.95 : 0.70;
    weighted += score * WEIGHTS.priceFloorViolation;
    totalW   += WEIGHTS.priceFloorViolation;
    factors.push({
      key:      "price_floor_violation",
      severity: floorCheck.riskLevel || "high",
      label:    "Price below authentic brand floor",
      detail:   floorCheck.warning || null,
      score,
    });
  }

  // ── Condition mismatch ────────────────────────────────────────────────────
  const mismatch = conditionPricing?.mismatch || null;
  if (mismatch?.hasMismatch) {
    const score = Math.min(0.90, (mismatch.premiumPct || 0) / 100);
    weighted += score * WEIGHTS.conditionMismatch;
    totalW   += WEIGHTS.conditionMismatch;
    factors.push({
      key:      "condition_price_mismatch",
      severity: score >= 0.50 ? "high" : "moderate",
      label:    `Condition mismatch: listed as "${mismatch.listedCondition}" priced like "${mismatch.impliedCondition}"`,
      detail:   mismatch.signal || null,
      score,
    });
  }

  // ── Deal verdict risk ─────────────────────────────────────────────────────
  const verdict = dealComparator?.verdict?.verdict || null;
  if (verdict) {
    const score = DEAL_VERDICT_TO_RISK[verdict] ?? 0.15;
    weighted += score * WEIGHTS.dealVerdict;
    totalW   += WEIGHTS.dealVerdict;
    if (score >= 0.40) {
      factors.push({
        key:      "deal_verdict",
        severity: score >= 0.70 ? "high" : "moderate",
        label:    `Overpriced: ${dealComparator?.verdict?.verdictLabel || verdict}`,
        detail:   dealComparator?.verdict?.actionableSignal || null,
        score,
      });
    }
  }

  // ── Demand / liquidity risk ───────────────────────────────────────────────
  const demandTier = demandSignals?.demandTier || null;
  if (demandTier) {
    const score = DEMAND_TIER_TO_RISK[demandTier] ?? 0.30;
    weighted += score * WEIGHTS.demandTier;
    totalW   += WEIGHTS.demandTier;
    if (score >= 0.50) {
      factors.push({
        key:      "low_demand",
        severity: score >= 0.70 ? "high" : "moderate",
        label:    `Demand is ${demandTier} — hard to resell`,
        detail:   demandSignals?.sellerAdvice || null,
        score,
      });
    }
  }

  // ── Trend risk ────────────────────────────────────────────────────────────
  const trendPhase = trendIntel?.phase || null;
  if (trendPhase) {
    const score = TREND_PHASE_TO_RISK[trendPhase] ?? 0.20;
    weighted += score * WEIGHTS.trendPhase;
    totalW   += WEIGHTS.trendPhase;
    if (score >= 0.50) {
      factors.push({
        key:      "trend_risk",
        severity: score >= 0.75 ? "high" : "moderate",
        label:    `Trend phase: ${trendPhase} — value may depreciate`,
        detail:   trendIntel?.signal || null,
        score,
      });
    }
  }

  // No factors evaluated → no opinion. Returning a default 0.25 here would
  // map to "safe", which downstream consumers read as "Safe to buy — no major
  // risk signals" — a fabricated all-clear on no data.
  if (totalW === 0) {
    return {
      riskScore:  null,
      tier:       "unknown",
      verdict:    "Not enough data to assess risk",
      topFactors: [],
      allFactors: [],
      shouldBuy:  false,
      signal:     "Risk unknown — not enough evidence",
    };
  }

  // Normalize to 0-1
  const riskScore = round2(weighted / totalW);

  const tier = riskScore >= 0.70 ? "avoid"
             : riskScore >= 0.50 ? "risky"
             : riskScore >= 0.30 ? "caution"
             : "safe";

  // Sort factors by severity, take top 3
  const topFactors = [...factors]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const TIER_VERDICTS = {
    safe:    "Safe to buy — no major risk signals",
    caution: "Proceed with caution — review risk factors before buying",
    risky:   "High risk purchase — authenticate and verify before committing",
    avoid:   "Do NOT buy — critical risk signals present",
  };

  return {
    riskScore,
    tier,
    verdict:     TIER_VERDICTS[tier],
    topFactors,
    allFactors:  factors,
    shouldBuy:   tier === "safe" || tier === "caution",
    signal:      `${tier.toUpperCase()}: ${TIER_VERDICTS[tier]}`,
  };
}

/**
 * Master risk score payload.
 */
export function buildRiskScorePayload(intelPayloads = {}) {
  return computePurchaseRiskScore(intelPayloads);
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) {
  return Math.round(v * 100) / 100;
}
