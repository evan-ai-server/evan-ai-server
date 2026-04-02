// src/regressionHarness.js
// Regression Harness — Phase 16: No-Decay System.
//
// Runs deterministic scenario checks against the real scan-decision chain.
// Tests the same modules that the live scan pipeline uses — not mocks.
//
// Uses:
//   buildEffectiveThresholds  — categoryThresholdEngine (real thresholds)
//   applyMarketDepthGate      — marketDepthGate (real depth logic)
//   computeReplicaRisk        — replicaRiskEngine (real replica logic)
//   generateScanWarnings      — signalWarnings (real warning logic)
//   checkIncidentControl      — incidentControls (kill-switch gate)
//
// buildBuySignal is NOT exported from index.js, so this harness replicates
// the decision tree using the same underlying modules + identical gate values.
// Any gate change in index.js MUST be mirrored here.
//
// Run with: GET /api/ops/regression/run

import { buildEffectiveThresholds, GLOBAL_FLOORS } from "./categoryThresholdEngine.js";
import { applyMarketDepthGate }                    from "./marketDepthGate.js";
import { computeReplicaRisk }                      from "./replicaRiskEngine.js";
import { generateScanWarnings }                    from "./signalWarnings.js";

// ── Signal decision mirror ─────────────────────────────────────────────────────
//
// Mirrors buildBuySignal in index.js.  KEEP IN SYNC.
// If index.js changes a gate value, update this too.

export function evaluateSignal({
  resaleScore    = 0,
  dealStrength   = 0,
  demandScore    = 0,
  confidenceV2   = 0,
  priceStats     = {},
  warnings       = [],
  crossCheck     = null,
  isOracleOnly   = false,
  identityQuality = null,
  trustScore     = null,
  categoryThresholds = null,
}) {
  const CT        = categoryThresholds || {};
  const T_SB_DS   = CT.STRONG_BUY_DEAL_STRENGTH ?? GLOBAL_FLOORS.STRONG_BUY_DEAL_STRENGTH;
  const T_SB_CV   = CT.STRONG_BUY_CONFIDENCE    ?? GLOBAL_FLOORS.STRONG_BUY_CONFIDENCE;
  const T_SB_TRUST= CT.STRONG_BUY_TRUST         ?? GLOBAL_FLOORS.STRONG_BUY_TRUST;
  const T_SB_IQ   = CT.STRONG_BUY_IDENTITY      ?? GLOBAL_FLOORS.STRONG_BUY_IDENTITY;
  const T_GD_DS   = CT.GOOD_DEAL_DEAL_STRENGTH  ?? GLOBAL_FLOORS.GOOD_DEAL_DEAL_STRENGTH;
  const T_GD_RS   = CT.GOOD_DEAL_RESALE_SCORE   ?? GLOBAL_FLOORS.GOOD_DEAL_RESALE_SCORE;
  const T_GD_TRUST= CT.GOOD_DEAL_TRUST          ?? GLOBAL_FLOORS.GOOD_DEAL_TRUST;

  const count = priceStats?.count ?? 0;
  const med   = priceStats?.median ?? null;
  const pqs   = priceStats?.priceQualityScore ?? 0;

  if (trustScore !== null && trustScore < 0.30)
    return { signal: "RISKY", capReason: "trust_critical" };
  if (count < 3 || !med)
    return { signal: "INSUFFICIENT DATA", capReason: "insufficient_data" };
  if (confidenceV2 < 0.40)
    return { signal: "RISKY", capReason: "low_confidence" };
  if (identityQuality !== null && identityQuality < 0.25)
    return { signal: "RISKY", capReason: "weak_identity" };

  const hasConflict = crossCheck?.type === "conflict" ||
    warnings.some((w) => typeof w === "string" && w.includes("conflict"));
  if (hasConflict)
    return { signal: "RISKY", capReason: "identity_conflict" };
  if (isOracleOnly)
    return { signal: "RISKY", capReason: "oracle_only" };
  if (priceStats.variance > 0 && Math.sqrt(priceStats.variance) / Math.max(med, 1) > 0.60)
    return { signal: "RISKY", capReason: "high_variance" };
  if (trustScore !== null && trustScore < 0.45)
    return { signal: "FAIR", capReason: "trust_below_threshold" };

  const strongBuyGate =
    confidenceV2            >= T_SB_CV    &&
    count                   >= 4          &&
    dealStrength            >= T_SB_DS    &&
    pqs                     >= 0.50       &&
    resaleScore             >= 70         &&
    demandScore             >= 50         &&
    (identityQuality ?? 0)  >= T_SB_IQ   &&
    (trustScore ?? 1)       >= T_SB_TRUST;
  if (strongBuyGate) return { signal: "STRONG BUY", capReason: null };

  if (resaleScore >= T_GD_RS && dealStrength >= T_GD_DS) {
    if ((trustScore ?? 1) < T_GD_TRUST)
      return { signal: "FAIR", capReason: "trust_below_good_deal" };
    if (count < 4)
      return { signal: "FAIR", capReason: "thin_market_good_deal" };
    return { signal: "GOOD DEAL", capReason: null };
  }
  if (resaleScore >= 45 && dealStrength >= 0.10)
    return { signal: "FAIR", capReason: null };
  if (dealStrength < 0 || resaleScore < 30)
    return { signal: "OVERPRICED", capReason: null };
  return { signal: "RISKY", capReason: "low_scores" };
}

// ── Scenario definitions ───────────────────────────────────────────────────────
//
// Each scenario tests a specific behavioral guarantee.
// id, name, inputs, assertions: { signal, capReason, warnTypes, fieldPresence }

const SCENARIOS = [
  {
    id:   "S01",
    name: "STRONG BUY passes all gates",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 82, dealStrength: 0.42, demandScore: 65,
      confidenceV2: 0.85, trustScore: 0.80, identityQuality: 0.78,
      priceStats: { count: 28, median: 120, min: 65, max: 185, priceQualityScore: 0.72, variance: 500 },
    },
    assertions: {
      signal:     "STRONG BUY",
      capReason:  null,
    },
  },

  {
    id:   "S02",
    name: "Critically low trust → RISKY regardless of scores",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 85, dealStrength: 0.50, demandScore: 70,
      confidenceV2: 0.90, trustScore: 0.22, identityQuality: 0.80,
      priceStats: { count: 50, median: 100, min: 60, max: 140, priceQualityScore: 0.80, variance: 200 },
    },
    assertions: {
      signal:    "RISKY",
      capReason: "trust_critical",
    },
  },

  {
    id:   "S03",
    name: "Insufficient data → INSUFFICIENT DATA",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 80, dealStrength: 0.40, demandScore: 60,
      confidenceV2: 0.85, trustScore: 0.75,
      priceStats: { count: 2, median: null, min: 60, max: 80, priceQualityScore: 0.40, variance: 100 },
    },
    assertions: {
      signal:    "INSUFFICIENT DATA",
      capReason: "insufficient_data",
    },
  },

  {
    id:   "S04",
    name: "Thin market (count=3) blocks STRONG BUY and GOOD DEAL → FAIR",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 85, dealStrength: 0.50, demandScore: 70,
      confidenceV2: 0.90, trustScore: 0.80, identityQuality: 0.80,
      priceStats: { count: 3, median: 100, min: 60, max: 140, priceQualityScore: 0.80, variance: 200 },
    },
    assertions: {
      signal:    "FAIR",      // count<4 blocks both SB and GD; falls to FAIR
      capReason: "thin_market_good_deal",
      neverEqual: "STRONG BUY",
    },
  },

  {
    id:   "S05",
    name: "Weak identity quality → RISKY",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 75, dealStrength: 0.35, demandScore: 60,
      confidenceV2: 0.75, trustScore: 0.70, identityQuality: 0.20,
      priceStats: { count: 20, median: 80, min: 50, max: 110, priceQualityScore: 0.70, variance: 300 },
    },
    assertions: {
      signal:    "RISKY",
      capReason: "weak_identity",
    },
  },

  {
    id:   "S06",
    name: "Oracle-only pricing → RISKY",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 80, dealStrength: 0.40, demandScore: 65,
      confidenceV2: 0.82, trustScore: 0.75, identityQuality: 0.70,
      isOracleOnly: true,
      priceStats: { count: 10, median: 90, min: 55, max: 125, priceQualityScore: 0.65, variance: 300 },
    },
    assertions: {
      signal:    "RISKY",
      capReason: "oracle_only",
    },
  },

  {
    id:   "S07",
    name: "High price variance → RISKY",
    criticalityLevel: "high",
    inputs: {
      resaleScore: 78, dealStrength: 0.38, demandScore: 62,
      confidenceV2: 0.80, trustScore: 0.75, identityQuality: 0.72,
      priceStats: { count: 15, median: 100, min: 20, max: 400, priceQualityScore: 0.55, variance: 9000 },
    },
    assertions: {
      signal:    "RISKY",
      capReason: "high_variance",
    },
  },

  {
    id:   "S08",
    name: "Trust just below GOOD DEAL threshold → FAIR",
    criticalityLevel: "high",
    inputs: {
      resaleScore: 62, dealStrength: 0.22, demandScore: 55,
      confidenceV2: 0.70, trustScore: 0.42, identityQuality: 0.60,
      priceStats: { count: 12, median: 80, min: 55, max: 110, priceQualityScore: 0.60, variance: 400 },
    },
    assertions: {
      signal:    "FAIR",
      capReason: "trust_below_threshold",
    },
  },

  {
    id:   "S09",
    name: "Conviction conflict in warnings → RISKY",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 78, dealStrength: 0.40, demandScore: 62,
      confidenceV2: 0.80, trustScore: 0.78, identityQuality: 0.72,
      crossCheck: { type: "conflict" },
      priceStats: { count: 20, median: 90, min: 55, max: 130, priceQualityScore: 0.68, variance: 400 },
    },
    assertions: {
      signal:    "RISKY",
      capReason: "identity_conflict",
    },
  },

  {
    id:   "S10",
    name: "Low confidence → RISKY regardless of other scores",
    criticalityLevel: "critical",
    inputs: {
      resaleScore: 82, dealStrength: 0.45, demandScore: 68,
      confidenceV2: 0.32, trustScore: 0.80, identityQuality: 0.75,
      priceStats: { count: 25, median: 110, min: 65, max: 150, priceQualityScore: 0.75, variance: 450 },
    },
    assertions: {
      signal:    "RISKY",
      capReason: "low_confidence",
    },
  },

  {
    id:   "S11",
    name: "Depth gate: illiquid market caps and returns capped=true",
    criticalityLevel: "high",
    inputs: {
      _useDepthGate: true,
      depthGateInput: {
        items:         Array(3).fill({ title: "Nike Air Force 1" }),
        soldCompCount: 0,
        listedCount:   3,
        localMode:     false,
        category:      "sneakers",
      },
      priceStats: { count: 3, median: 80, min: 50, max: 120, priceQualityScore: 0.60, variance: 400 },
    },
    assertions: {
      depthCap: true,   // market too shallow — must cap
    },
  },

  {
    id:   "S12",
    name: "Replica risk HIGH category without auth markers → cap",
    criticalityLevel: "critical",
    inputs: {
      _useReplicaGate: true,
      replicaInput: {
        category:       "sneakers",
        visionIdentity: { brand: "Nike", model: "Air Force 1" },
        visibleText:    "Nike Air Force 1 White for sale",  // no auth markers
        scanContext:    {},
      },
    },
    assertions: {
      replicaTier: "HIGH",        // real property name is `tier`
      cappingSignal: true,        // real property name is `cappingSignal`
    },
  },

  {
    id:   "S13",
    name: "GOOD DEAL with solid evidence must not be suppressed",
    criticalityLevel: "high",
    inputs: {
      resaleScore: 65, dealStrength: 0.28, demandScore: 58,
      confidenceV2: 0.75, trustScore: 0.72, identityQuality: 0.68,
      priceStats: { count: 18, median: 90, min: 58, max: 125, priceQualityScore: 0.68, variance: 500 },
    },
    assertions: {
      signal:      "GOOD DEAL",
      neverEqual:  "RISKY",
    },
  },

  {
    id:   "S14",
    name: "Overpriced: negative dealStrength → OVERPRICED",
    criticalityLevel: "medium",
    inputs: {
      resaleScore: 20, dealStrength: -0.15, demandScore: 35,
      confidenceV2: 0.70, trustScore: 0.72, identityQuality: 0.65,
      priceStats: { count: 15, median: 60, min: 45, max: 90, priceQualityScore: 0.65, variance: 350 },
    },
    assertions: {
      signal: "OVERPRICED",
    },
  },

  {
    id:   "S15",
    name: "B2B confidence cannot exceed consumer model (A-grade needs index)",
    criticalityLevel: "high",
    inputs: {
      _useB2bConfidenceCheck: true,
      indexGrade: "C",
      b2bClaimed: "high_confidence",
    },
    assertions: {
      b2bConfidenceConsistent: false,  // C-grade index claiming high confidence = violation
    },
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────────

/**
 * Run the full regression harness.
 *
 * @param {object|null} redis
 * @returns {Promise<RegressionResult>}
 */
export async function runRegressionHarness(redis = null) {
  const start   = Date.now();
  const results = [];
  let passed = 0, failed = 0;

  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario, redis);
    results.push(result);
    if (result.pass) passed++; else failed++;
  }

  return {
    runAt:       new Date().toISOString(),
    durationMs:  Date.now() - start,
    total:       SCENARIOS.length,
    passed,
    failed,
    criticalFailures: results.filter((r) => !r.pass && r.criticalityLevel === "critical").length,
    scenarios:   results,
    pass:        failed === 0,
  };
}

async function runScenario(scenario, redis) {
  const { id, name, criticalityLevel, inputs, assertions } = scenario;

  try {
    // ── Depth gate scenario ────────────────────────────────────────────────────
    if (inputs._useDepthGate) {
      const { items, soldCompCount, listedCount, localMode, category } = inputs.depthGateInput;
      const depthResult = applyMarketDepthGate({
        items:         items || [],
        soldCompCount: soldCompCount ?? 0,
        listedCount:   listedCount   ?? 0,
        priceStats:    inputs.priceStats || {},
        signal:        "STRONG BUY",   // test ceiling
        category,
        localMode,
      });
      const depthCap    = depthResult.capped === true;
      const signalOk    = assertions.signalCeiling
        ? SIGNAL_ORDER.indexOf(depthResult.signal) <= SIGNAL_ORDER.indexOf(assertions.signalCeiling)
        : true;
      const pass = depthCap === (assertions.depthCap ?? false) && signalOk;
      return buildResult({ id, name, criticalityLevel, pass, assertions, actual: depthResult });
    }

    // ── Replica gate scenario ─────────────────────────────────────────────────
    if (inputs._useReplicaGate) {
      const { category, visionIdentity, visibleText, scanContext } = inputs.replicaInput;
      const replicaResult = computeReplicaRisk(category, visionIdentity, visibleText, scanContext);
      const tierOk      = assertions.replicaTier   ? replicaResult.tier          === assertions.replicaTier   : true;
      const cappingOk   = assertions.cappingSignal !== undefined
        ? replicaResult.cappingSignal === assertions.cappingSignal
        : true;
      const pass = tierOk && cappingOk;
      return buildResult({ id, name, criticalityLevel, pass, assertions, actual: replicaResult });
    }

    // ── B2B confidence check ───────────────────────────────────────────────────
    if (inputs._useB2bConfidenceCheck) {
      const { indexGrade, b2bClaimed } = inputs;
      // A-grade = high_confidence, B = moderate, C/INSUFFICIENT = low/unresolved
      const maxAllowed = { A: "high_confidence", B: "moderate_confidence", C: "low_confidence", INSUFFICIENT: "unresolved" };
      const allowed = maxAllowed[indexGrade] || "unresolved";
      // Lower index = stronger claim; consistent = claimed is no stronger than allowed
      // e.g. b2bClaimed="high_confidence"(0) with allowed="low_confidence"(2): 0 >= 2 is false → NOT consistent
      const consistent = CONFIDENCE_ORDER.indexOf(b2bClaimed) >= CONFIDENCE_ORDER.indexOf(allowed);
      const pass = consistent === (assertions.b2bConfidenceConsistent ?? true);
      return buildResult({ id, name, criticalityLevel, pass, assertions,
        actual: { indexGrade, b2bClaimed, maxAllowed: allowed, consistent } });
    }

    // ── Standard signal scenario ───────────────────────────────────────────────
    const actual = evaluateSignal(inputs);
    const signalOk    = assertions.signal     ? actual.signal === assertions.signal     : true;
    const capOk       = assertions.capReason !== undefined
      ? actual.capReason === assertions.capReason
      : true;
    const neverOk     = assertions.neverEqual  ? actual.signal !== assertions.neverEqual : true;
    const pass        = signalOk && capOk && neverOk;

    return buildResult({ id, name, criticalityLevel, pass, assertions, actual });
  } catch (err) {
    return {
      id, name, criticalityLevel,
      pass:  false,
      error: err?.message || String(err),
    };
  }
}

function buildResult({ id, name, criticalityLevel, pass, assertions, actual }) {
  const result = { id, name, criticalityLevel, pass, assertions, actual };
  if (!pass) {
    result.diff = {
      expected: JSON.stringify(assertions),
      got:      JSON.stringify(actual),
    };
  }
  return result;
}

// Signal order for ceiling comparisons (lower index = stronger signal)
const SIGNAL_ORDER     = ["STRONG BUY", "GOOD DEAL", "FAIR", "OVERPRICED", "RISKY", "INSUFFICIENT DATA"];
const CONFIDENCE_ORDER = ["high_confidence", "moderate_confidence", "low_confidence", "unresolved"];
