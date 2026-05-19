// src/evanSummaryEngine.js
// Synthesizes all intel into one human-readable verdict.
// Buy-side recommendation: BUY / HOLD / PASS (three states, no qualifiers).
// Sell-side recommendation: SELL NOW / SELL SOON / HOLD / CLEAR INVENTORY.
// Plus bullet-point top signals and the Evan Score (0-100 composite).

// ── Evan Score weight registry ────────────────────────────────────────────────
const EVAN_SCORE_WEIGHTS = {
  dealQuality:      0.20, // steal → 100, price trap → 0
  authConfidence:   0.18, // low auth risk → high score
  demandHealth:     0.12, // hot demand → high score
  trendMomentum:    0.10, // rising/evergreen → high score
  conditionFairness:0.10, // fair pricing for condition → high score
  liquidityStrength:0.10, // liquid market → high score
  riskInverse:      0.12, // low purchase risk → high score
  substituteValue:  0.08, // no better substitute → high score (has substitute = lower)
};

// ── Scoring maps ──────────────────────────────────────────────────────────────
const DEAL_VERDICT_SCORE = {
  steal:      1.00,
  good_deal:  0.80,
  fair:       0.60,
  overpriced: 0.25,
  price_trap: 0.00,
};

const AUTH_TIER_SCORE = {
  low:      1.00,
  moderate: 0.65,
  high:     0.25,
  critical: 0.00,
};

const DEMAND_TIER_SCORE = {
  hot:  1.00,
  warm: 0.70,
  cool: 0.35,
  cold: 0.10,
};

const TREND_PHASE_SCORE = {
  emerging:  0.80,
  rising:    1.00,
  peak:      0.60,
  fading:    0.25,
  dead:      0.00,
  evergreen: 0.90,
  stable:    0.65,
};

const LIQUIDITY_TIER_SCORE = {
  high:     1.00,
  moderate: 0.65,
  low:      0.30,
};

const RISK_TIER_SCORE = {
  safe:    1.00,
  caution: 0.70,
  risky:   0.30,
  avoid:   0.00,
};

// ── Recommendation logic ──────────────────────────────────────────────────────
function deriveRecommendation({
  evanScore,
  riskTier,
  authTier,
  dealVerdict,
  trendPhase,
  demandTier,
  hasCriticalAuth,
}) {
  // Hard overrides — both collapse to PASS in the user-facing 3-state surface.
  // (Critical auth and risk-avoid both mean "do not buy"; the explanation lives
  // in the supporting copy, not in a fourth verdict word.)
  if (hasCriticalAuth || authTier === "critical") return "PASS";
  if (riskTier === "avoid")                        return "PASS";

  // Three-state recommendation. No "BUY WITH CAUTION" — if the call isn't
  // clean enough to land BUY, it's HOLD. The user is treated as an adult.
  if (evanScore >= 78) return "BUY";
  if (evanScore >= 55) {
    if (dealVerdict === "good_deal" || dealVerdict === "steal") return "BUY";
    if (trendPhase === "rising" || trendPhase === "evergreen")  return "BUY";
    return "HOLD";
  }
  if (evanScore >= 35) {
    if (dealVerdict === "overpriced" || dealVerdict === "price_trap") return "PASS";
    if (trendPhase === "fading" || trendPhase === "dead")              return "PASS";
    return "HOLD";
  }
  return "PASS";
}

function deriveSellRecommendation({ evanScore, trendPhase, demandTier, liquidityTier }) {
  // No data on either trend or demand → can't recommend a sell action.
  if (trendPhase === "unknown" && demandTier === "unknown") return "HOLD";
  if (trendPhase === "peak" && demandTier !== "cold") return "SELL NOW";
  if (trendPhase === "fading")                        return "SELL SOON";
  if (trendPhase === "dead")                          return "CLEAR INVENTORY";
  if (demandTier === "hot" && liquidityTier === "high") return "SELL NOW — PEAK DEMAND";
  if (evanScore >= 60)                                return "HOLD";
  return "SELL";
}

// ── Signal extraction ─────────────────────────────────────────────────────────
function extractTopSignals(intelPayloads, limit = 5) {
  const {
    dealComparator, authenticityIntel, arbitrageIntel, trendIntel,
    demandSignals, conditionPricing, substituteIntel, priceHistoryIntel,
    riskScore, negotiationIntel, bundleIntel, resaleOptimizer,
    categoryIntel, smartAlerts, dontBuyThis,
  } = intelPayloads;

  const candidates = [];

  // Deal verdict
  if (dealComparator?.verdict?.signal)
    candidates.push({ priority: 10, signal: dealComparator.verdict.signal, source: "deal" });

  // Auth risk (always surface if elevated)
  if (authenticityIntel?.topSignal && authenticityIntel?.tier !== "low")
    candidates.push({ priority: 9, signal: authenticityIntel.topSignal, source: "auth" });

  // Risk score
  if (riskScore?.signal)
    candidates.push({ priority: 8, signal: riskScore.signal, source: "risk" });

  // Arbitrage
  if (arbitrageIntel?.platformArbitrage?.signal)
    candidates.push({ priority: 7, signal: arbitrageIntel.platformArbitrage.signal, source: "arbitrage" });

  // Buy opportunity
  if (arbitrageIntel?.buyOpportunity?.signal)
    candidates.push({ priority: 7, signal: arbitrageIntel.buyOpportunity.signal, source: "buy_opp" });

  // Trend
  if (trendIntel?.signal && trendIntel?.available)
    candidates.push({ priority: 6, signal: trendIntel.signal, source: "trend" });

  // Don't buy this
  if (dontBuyThis?.shouldWarn && dontBuyThis?.message)
    candidates.push({ priority: 6, signal: dontBuyThis.message, source: "alt" });

  // Demand
  if (demandSignals?.signals?.[0])
    candidates.push({ priority: 5, signal: demandSignals.signals[0], source: "demand" });

  // Condition mismatch
  if (conditionPricing?.mismatch?.signal)
    candidates.push({ priority: 5, signal: conditionPricing.mismatch.signal, source: "condition" });

  // Price history
  if (priceHistoryIntel?.verdictSignal)
    candidates.push({ priority: 4, signal: priceHistoryIntel.verdictSignal, source: "timing" });

  // Negotiation
  if (negotiationIntel?.topSignal)
    candidates.push({ priority: 4, signal: negotiationIntel.topSignal, source: "negotiate" });

  // Bundle
  if (bundleIntel?.signal && bundleIntel?.available)
    candidates.push({ priority: 3, signal: bundleIntel.signal, source: "bundle" });

  // Category-specific
  const catSignals = [
    categoryIntel?.colorwayDemand?.signal,
    categoryIntel?.sizeDemand?.signal,
    categoryIntel?.reference?.signal,
    categoryIntel?.movement?.signal,
    categoryIntel?.hardware?.signal,
    categoryIntel?.iCloudLock?.signal,
    categoryIntel?.carrierLock?.signal,
  ].filter(Boolean);
  if (catSignals[0])
    candidates.push({ priority: 3, signal: catSignals[0], source: "category" });

  // Resale optimizer top signal
  if (resaleOptimizer?.topSignal)
    candidates.push({ priority: 2, signal: resaleOptimizer.topSignal, source: "resale" });

  return candidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit)
    .map(c => c.signal);
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute the Evan Score (0–100) from all available intel.
 */
export function computeEvanScore(intelPayloads = {}) {
  const {
    dealComparator, authenticityIntel, demandSignals, trendIntel,
    conditionPricing, liquidityScore, riskScore, substituteIntel,
  } = intelPayloads;

  let weighted = 0;
  let totalW   = 0;

  const add = (key, value) => {
    const w = EVAN_SCORE_WEIGHTS[key] || 0;
    weighted += clamp01(value) * w;
    totalW   += w;
  };

  // Deal quality
  const dv = dealComparator?.verdict?.verdict;
  if (dv) add("dealQuality", DEAL_VERDICT_SCORE[dv] ?? 0.50);

  // Auth confidence
  const at = authenticityIntel?.tier;
  if (at) add("authConfidence", AUTH_TIER_SCORE[at] ?? 0.50);

  // Demand health
  const dt = demandSignals?.demandTier;
  if (dt) add("demandHealth", DEMAND_TIER_SCORE[dt] ?? 0.50);

  // Trend momentum
  const tp = trendIntel?.phase;
  if (tp) add("trendMomentum", TREND_PHASE_SCORE[tp] ?? 0.50);

  // Condition fairness (no mismatch = fair). Only contribute when we have a
  // condition payload at all — without one, "fair condition" is fabricated.
  if (conditionPricing) {
    const hasMismatch = conditionPricing?.mismatch?.hasMismatch;
    add("conditionFairness", hasMismatch === true ? 0.30 : hasMismatch === false ? 0.85 : 0.60);
  }

  // Liquidity
  const lt = liquidityScore?.tier;
  if (lt && lt !== "unknown") add("liquidityStrength", LIQUIDITY_TIER_SCORE[lt] ?? 0.50);

  // Risk inverse
  const rt = riskScore?.tier;
  if (rt && rt !== "unknown") add("riskInverse", RISK_TIER_SCORE[rt] ?? 0.50);

  // Substitute value (no substitute found = higher score for this item).
  // Only contribute when substitute intel was actually computed.
  if (substituteIntel) {
    const hasSub = substituteIntel?.hasSavings;
    add("substituteValue", hasSub ? 0.30 : 0.80);
  }

  const raw  = totalW > 0 ? weighted / totalW : 0.50;
  return Math.round(clamp01(raw) * 100);
}

/**
 * Build the full Evan Summary — the master output of the entire platform.
 */
export function buildEvanSummary(intelPayloads = {}) {
  const evanScore = computeEvanScore(intelPayloads);

  const {
    dealComparator, authenticityIntel, demandSignals, trendIntel,
    riskScore, liquidityScore, negotiationIntel, resaleOptimizer,
    smartAlerts,
  } = intelPayloads;

  // Default missing tiers to "unknown" — never to optimistic values. Absence
  // of an intel payload must not look like "we evaluated it and it's fine."
  const authTier      = authenticityIntel?.tier         || "unknown";
  const riskTier      = riskScore?.tier                 || "unknown";
  const dealVerdict   = dealComparator?.verdict?.verdict || "unknown";
  const trendPhase    = trendIntel?.phase               || "unknown";
  const demandTier    = demandSignals?.demandTier        || "unknown";
  const liquidityTier = liquidityScore?.tier            || "unknown";
  const hasCriticalAuth = (authenticityIntel?.criticalFlags?.length ?? 0) > 0
    || authTier === "critical";

  const buyRecommendation  = deriveRecommendation({
    evanScore, riskTier, authTier, dealVerdict, trendPhase, demandTier, hasCriticalAuth,
  });
  const sellRecommendation = deriveSellRecommendation({
    evanScore, trendPhase, demandTier, liquidityTier,
  });

  const topSignals = extractTopSignals(intelPayloads, 5);

  // Score tier label
  const scoreTier = evanScore >= 80 ? "Exceptional"
                  : evanScore >= 65 ? "Strong"
                  : evanScore >= 50 ? "Average"
                  : evanScore >= 35 ? "Weak"
                  : "Poor";

  // One-liner summary — three states, plain language.
  // PASS leads with the *actual* signal that forced PASS so the user knows
  // why. The "no evidence" gate only applies on the HOLD path, since that's
  // the genuinely-undecided case.
  const oneLiner = (() => {
    if (buyRecommendation === "BUY") {
      return `${dealVerdict.replace("_", " ")} on recent comps with ${demandTier} demand`;
    }
    if (buyRecommendation === "PASS") {
      if (authTier === "critical" || authTier === "high") return `Authenticity risk: ${authTier}`;
      if (riskTier === "avoid")                           return "High purchase risk";
      if (dealVerdict === "price_trap" || dealVerdict === "overpriced") {
        return `Priced ${dealVerdict.replace("_", " ")}`;
      }
      return `${riskTier} risk, ${dealVerdict.replace("_", " ")} on recent comps`;
    }
    // HOLD — admit when there's nothing to decide on
    if (riskTier === "unknown" && dealVerdict === "unknown" && demandTier === "unknown") {
      return "Not enough evidence yet — clearer photo or wait for more comps";
    }
    return `Need more comps to lock the call`;
  })();

  return {
    evanScore,
    scoreTier,
    buyRecommendation,
    sellRecommendation,
    oneLiner,
    topSignals,
    breakdown: {
      dealVerdict,
      authTier,
      riskTier,
      demandTier,
      trendPhase,
      liquidityTier,
    },
    negotiationSummary: negotiationIntel?.topSignal || null,
    listingSummary:     resaleOptimizer?.topSignal  || null,
    alertCount:         smartAlerts?.alertCount     || 0,
    primaryAlert:       smartAlerts?.primaryAlert   || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}
