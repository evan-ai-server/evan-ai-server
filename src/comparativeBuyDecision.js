// src/comparativeBuyDecision.js
// Comparative Buy Decision: given two full scan results (itemA and itemB),
// produces a definitive side-by-side verdict with a single clear winner.
// "Buy A — 34% cheaper, same demand tier, lower risk. Skip B."

// ── Dimension weights ─────────────────────────────────────────────────────────
const COMPARE_WEIGHTS = {
  priceVsMarket:    0.28,
  profitPotential:  0.25,
  riskAndAuth:      0.20,
  demandStrength:   0.15,
  conditionValue:   0.12,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Extract a normalized score (0-100) for a single dimension from an intel bundle.
 */
function extractDimensionScore(bundle = {}, dimension = "") {
  switch (dimension) {
    case "priceVsMarket": {
      const verdict = bundle?.dealComparator?.verdict || bundle?.priceTargets?.targets?.verdict || "fair";
      return verdict === "steal"      ? 95
           : verdict === "STRONG_BUY" ? 95
           : verdict === "good"       ? 72
           : verdict === "BUY"        ? 72
           : verdict === "fair"       ? 48
           : verdict === "high"       ? 18
           : 5;
    }

    case "profitPotential": {
      const net = bundle?.priceTargets?.targets?.netProfit ?? null;
      const roi = bundle?.priceTargets?.targets?.roi ?? null;
      if (net === null && roi === null) return 50;
      const ns = net !== null ? Math.min(100, (net / 50) * 100) : 50;
      const rs = roi !== null ? Math.min(100, (roi / 40) * 100) : 50;
      return round2((ns + rs) / 2);
    }

    case "riskAndAuth": {
      const riskVal  = bundle?.riskScore?.score ?? 0.3;
      const fakeRisk = bundle?.fakeDetector?.listing?.riskScore ?? 0;
      const base     = round2((1 - riskVal) * 100);
      const penalty  = fakeRisk >= 45 ? 30 : fakeRisk >= 25 ? 15 : 0;
      return Math.max(0, Math.min(100, base - penalty));
    }

    case "demandStrength": {
      const tier = bundle?.demandSignals?.tier || "warm";
      return tier === "hot" ? 90 : tier === "warm" ? 65 : tier === "cool" ? 38 : 15;
    }

    case "conditionValue": {
      const impact = bundle?.conditionPricing?.totalImpactPct ?? 0;
      return Math.max(0, 100 - impact * 2); // 50% condition impact = score 0
    }

    default: return 50;
  }
}

/**
 * Compute composite comparison score for a single item.
 */
function computeItemScore(bundle = {}) {
  let total = 0;
  for (const [dim, weight] of Object.entries(COMPARE_WEIGHTS)) {
    total += extractDimensionScore(bundle, dim) * weight;
  }
  return round2(total);
}

/**
 * Build a one-line reason summary for a winner.
 */
function buildWinReasons(winner = {}, loser = {}, winnerLabel = "A", loserLabel = "B") {
  const reasons = [];

  // Price
  const wVerdict = winner?.dealComparator?.verdict || winner?.priceTargets?.targets?.verdict;
  const lVerdict = loser?.dealComparator?.verdict  || loser?.priceTargets?.targets?.verdict;
  if (wVerdict === "steal" || wVerdict === "good")  reasons.push("better price vs. market");
  if (lVerdict === "high")                          reasons.push(`item ${loserLabel} is overpriced`);

  // Profit
  const wNet = winner?.priceTargets?.targets?.netProfit ?? null;
  const lNet = loser?.priceTargets?.targets?.netProfit  ?? null;
  if (wNet !== null && (lNet === null || wNet > lNet)) {
    reasons.push(`$${wNet.toFixed(2)} vs $${(lNet ?? 0).toFixed(2)} net profit`);
  }

  // Risk
  const wRisk = winner?.riskScore?.tier || "safe";
  const lRisk = loser?.riskScore?.tier  || "safe";
  const riskRank = { safe: 0, caution: 1, risky: 2, avoid: 3 };
  if ((riskRank[wRisk] ?? 0) < (riskRank[lRisk] ?? 0)) {
    reasons.push(`lower risk (${wRisk} vs ${lRisk})`);
  }

  // Demand
  const wDem = winner?.demandSignals?.tier || "warm";
  const lDem = loser?.demandSignals?.tier  || "warm";
  const demRank = { hot: 3, warm: 2, cool: 1, cold: 0 };
  if ((demRank[wDem] ?? 2) > (demRank[lDem] ?? 2)) reasons.push("stronger demand");

  // Condition
  const wImpact = winner?.conditionPricing?.totalImpactPct ?? 0;
  const lImpact = loser?.conditionPricing?.totalImpactPct  ?? 0;
  if (wImpact < lImpact) reasons.push(`better condition (${wImpact}% vs ${lImpact}% impact)`);

  return reasons.slice(0, 3).join(", ");
}

/**
 * Compare two intel bundles and return a verdict.
 */
export function compareItems(itemABundle = {}, itemBBundle = {}, labelA = "Item A", labelB = "Item B") {
  const scoreA = computeItemScore(itemABundle);
  const scoreB = computeItemScore(itemBBundle);
  const diff   = round2(Math.abs(scoreA - scoreB));
  const isTie  = diff < 5;

  const winner       = scoreA >= scoreB ? "A" : "B";
  const winnerBundle = winner === "A" ? itemABundle : itemBBundle;
  const loserBundle  = winner === "A" ? itemBBundle : itemABundle;
  const winnerLabel  = winner === "A" ? labelA : labelB;
  const loserLabel   = winner === "A" ? labelB : labelA;

  const verdict = isTie
    ? "TIE_BUY_CHEAPER"
    : winner === "A" ? "BUY_A" : "BUY_B";

  const reasons = isTie
    ? "Scores are nearly identical — buy whichever is cheaper or easier to acquire"
    : buildWinReasons(winnerBundle, loserBundle, winnerLabel, loserLabel);

  const dimensionBreakdown = {};
  for (const dim of Object.keys(COMPARE_WEIGHTS)) {
    dimensionBreakdown[dim] = {
      A: extractDimensionScore(itemABundle, dim),
      B: extractDimensionScore(itemBBundle, dim),
    };
  }

  return {
    verdict,
    winner:         isTie ? null : winner,
    winnerLabel:    isTie ? null : winnerLabel,
    scoreA,
    scoreB,
    scoreDiff:      diff,
    isTie,
    reasons,
    dimensionBreakdown,
    topSignal: isTie
      ? `Too close to call (${scoreA} vs ${scoreB}) — buy the cheaper one`
      : `Buy ${winnerLabel} (${scoreA > scoreB ? scoreA : scoreB}/100) — ${reasons}. Skip ${loserLabel} (${scoreA < scoreB ? scoreA : scoreB}/100).`,
  };
}

/**
 * Master comparative buy decision payload.
 */
export function buildComparativeBuyDecisionPayload({
  itemA      = {},
  itemB      = {},
  labelA     = "Item A",
  labelB     = "Item B",
} = {}) {
  if (!itemA || !itemB) return null;
  const comparison = compareItems(itemA, itemB, labelA, labelB);
  return {
    comparison,
    topSignal: comparison.topSignal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) {
  return Math.round(v * 100) / 100;
}
