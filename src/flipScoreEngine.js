// src/flipScoreEngine.js
// Flip Score Engine: the single most important number for resellers.
// Synthesizes profit potential, demand, risk, speed, and timing into a
// 0-100 score with a tier label and one-line action verdict.
// "Flip Score: 91/100 — LEGENDARY. $112 net, sells in ~4 days, low risk."

// ── Dimension weights ─────────────────────────────────────────────────────────
const WEIGHTS = {
  profitPotential: 0.30,  // how much money is on the table
  demandStrength:  0.25,  // how fast this sells
  riskProfile:     0.20,  // auth risk, condition, fake signals
  pricePosition:   0.15,  // how far below market the scanned price is
  marketTiming:    0.10,  // momentum + seasonal signal
};

// ── Score tiers ───────────────────────────────────────────────────────────────
const FLIP_TIERS = [
  { min: 88, tier: "legendary", label: "LEGENDARY",  emoji: "🔥", action: "Buy immediately — exceptional opportunity" },
  { min: 72, tier: "hot",       label: "HOT",        emoji: "⚡", action: "Strong buy — clear margin with fast exit" },
  { min: 55, tier: "solid",     label: "SOLID",      emoji: "✅", action: "Good flip if condition checks out" },
  { min: 38, tier: "weak",      label: "WEAK",       emoji: "⚠️", action: "Marginal — only buy at a discount" },
  { min:  0, tier: "skip",      label: "SKIP",       emoji: "❌", action: "Not worth the risk at this price" },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Score profit potential (0-100) from net profit and ROI.
 */
function scoreProfitPotential(priceTargets = null, profitCalc = null) {
  const netProfit = priceTargets?.targets?.netProfit
    ?? profitCalc?.scenarios?.[0]?.netProfit
    ?? null;
  const roi = priceTargets?.targets?.roi
    ?? profitCalc?.scenarios?.[0]?.roi
    ?? null;

  if (netProfit === null && roi === null) return 50; // neutral

  const profitScore = netProfit !== null
    ? Math.min(100, (netProfit / 50) * 100)   // $50 net = 100 points
    : 50;
  const roiScore = roi !== null
    ? Math.min(100, (roi / 40) * 100)          // 40% ROI = 100 points
    : 50;

  return round2((profitScore + roiScore) / 2);
}

/**
 * Score demand strength (0-100) from demand tier and sell-through.
 */
function scoreDemandStrength(demandSignals = null, marketMomentum = null) {
  const tier = demandSignals?.tier || "warm";
  const baseDemand = tier === "hot"  ? 90
                   : tier === "warm" ? 68
                   : tier === "cool" ? 42
                   : 20; // cold

  // Momentum bonus
  const momentumTier = marketMomentum?.overallTier || "stable";
  const momentumBonus = momentumTier === "surging" ? 10
                      : momentumTier === "rising"  ? 5
                      : momentumTier === "falling" ? -10
                      : 0;

  return Math.max(0, Math.min(100, baseDemand + momentumBonus));
}

/**
 * Score risk profile (0-100, higher = lower risk = better for flip).
 */
function scoreRiskProfile(riskScore = null, fakeDetector = null, authenticityIntel = null) {
  // riskScore is 0-1 where 1 = max risk — invert it
  const riskVal    = riskScore?.score ?? 0.3;
  const baseScore  = round2((1 - riskVal) * 100);

  // Fake detector penalty
  const fakeRisk   = fakeDetector?.listing?.riskScore ?? 0;
  const fakePenalty = fakeRisk >= 45 ? 30
                    : fakeRisk >= 25 ? 15
                    : 0;

  // Auth risk penalty
  const authRisk   = authenticityIntel?.riskTier || "low";
  const authPenalty = authRisk === "extreme" ? 25
                    : authRisk === "high"    ? 15
                    : authRisk === "moderate" ? 5
                    : 0;

  return Math.max(0, Math.min(100, baseScore - fakePenalty - authPenalty));
}

/**
 * Score price position (0-100): how far below market is the scanned price?
 */
function scorePricePosition(dealComparator = null, priceTargets = null) {
  const verdict = dealComparator?.verdict || priceTargets?.targets?.verdict || "fair";

  return verdict === "steal"        ? 95
       : verdict === "STRONG_BUY"   ? 95
       : verdict === "good"         ? 72
       : verdict === "BUY"          ? 72
       : verdict === "fair"         ? 48
       : verdict === "BUY_PERSONAL" ? 35
       : verdict === "high"         ? 15
       : 5; // price trap
}

/**
 * Score market timing (0-100): is now a good time to flip?
 */
function scoreMarketTiming(seasonalFlip = null, marketMomentum = null, trendIntel = null) {
  let score = 50; // neutral baseline

  // Seasonal signal
  const verdict = seasonalFlip?.flipTiming?.verdict;
  if (verdict === "SELL_NOW")  score += 25;
  if (verdict === "BUY_NOW")   score += 15; // good time to accumulate
  if (verdict === "NEUTRAL")   score += 0;

  // Momentum
  const tier = marketMomentum?.overallTier;
  if (tier === "surging" || tier === "rising") score += 15;
  if (tier === "falling" || tier === "softening") score -= 15;

  // Trend phase
  const phase = trendIntel?.phase;
  if (phase === "rising" || phase === "peak") score += 10;
  if (phase === "fading" || phase === "dead") score -= 15;

  return Math.max(0, Math.min(100, score));
}

/**
 * Compute the composite flip score.
 */
export function computeFlipScore({
  priceTargets     = null,
  profitCalc       = null,
  demandSignals    = null,
  marketMomentum   = null,
  riskScore        = null,
  fakeDetector     = null,
  authenticityIntel = null,
  dealComparator   = null,
  seasonalFlip     = null,
  trendIntel       = null,
} = {}) {
  const profitScore  = scoreProfitPotential(priceTargets, profitCalc);
  const demandScore  = scoreDemandStrength(demandSignals, marketMomentum);
  const riskProfileScore = scoreRiskProfile(riskScore, fakeDetector, authenticityIntel);
  const pricePositionScore = scorePricePosition(dealComparator, priceTargets);
  const timingScore  = scoreMarketTiming(seasonalFlip, marketMomentum, trendIntel);

  const composite = round2(
    profitScore          * WEIGHTS.profitPotential +
    demandScore          * WEIGHTS.demandStrength  +
    riskProfileScore     * WEIGHTS.riskProfile     +
    pricePositionScore   * WEIGHTS.pricePosition   +
    timingScore          * WEIGHTS.marketTiming
  );

  const tierData = FLIP_TIERS.find(t => composite >= t.min) || FLIP_TIERS[FLIP_TIERS.length - 1];

  const netProfit  = priceTargets?.targets?.netProfit ?? null;
  const flipWeeks  = priceTargets?.targets?.flipTime?.weeks ?? null;
  const roi        = priceTargets?.targets?.roi ?? null;

  return {
    score:      composite,
    tier:       tierData.tier,
    tierLabel:  tierData.label,
    action:     tierData.action,
    dimensions: {
      profitPotential:  round2(profitScore),
      demandStrength:   round2(demandScore),
      riskProfile:      round2(riskProfileScore),
      pricePosition:    round2(pricePositionScore),
      marketTiming:     round2(timingScore),
    },
    netProfit,
    roi,
    estimatedFlipWeeks: flipWeeks,
    topSignal: `Flip Score: ${composite}/100 — ${tierData.label}. ${
      netProfit !== null ? `$${netProfit.toFixed(2)} net` : ""
    }${flipWeeks ? `, sells in ~${flipWeeks}wk` : ""}${
      roi !== null ? `, ${roi.toFixed(0)}% ROI` : ""
    } — ${tierData.action}`.trim().replace(/\. $/, ""),
  };
}

/**
 * Master flip score payload.
 */
export function buildFlipScorePayload(intelBundle = {}) {
  const result = computeFlipScore(intelBundle);
  return {
    flipScore:  result,
    topSignal:  result.topSignal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) {
  return Math.round(v * 100) / 100;
}
