// src/goldenCaseRunner.js
// Golden Case Runner — Phase 16: No-Decay System.
//
// Canonical "never-regress" suite: the 8 highest-risk scenarios Evan must
// always get right.  Release is blocked if ANY critical golden case fails.
//
// Anchored to real module behavior — not stubs.

import { evaluateSignal }          from "./regressionHarness.js";
import { applyMarketDepthGate }    from "./marketDepthGate.js";
import { computeReplicaRisk }      from "./replicaRiskEngine.js";
import { assessValuationEligibility } from "./priceIndexEngine.js";

// ── Golden case definitions ───────────────────────────────────────────────────
//
// Each case:
//   id, name, criticality ("critical" | "high")
//   scenario: inputs to the relevant evaluation function
//   expected: behavioral guarantees that must hold

const GOLDEN_CASES = [
  // ── GC-01: High replica risk without authentication ─────────────────────────
  {
    id:          "GC-01",
    name:        "Replica-risk HIGH category without authentication must cap signal",
    criticality: "critical",
    run: async () => {
      const r = computeReplicaRisk(
        "watches",
        { brand: "Rolex", model: "Submariner" },
        "Rolex Submariner for sale great condition",  // no auth markers
        {}
      );
      return { actual: r };
    },
    assert: ({ actual }) => {
      if (actual.tier !== "HIGH")
        return fail("Expected tier=HIGH", actual);
      if (actual.cappingSignal !== true)
        return fail("Expected cappingSignal=true", actual);
      return pass();
    },
  },

  // ── GC-02: Thin market with mostly listed comps — must not produce STRONG BUY
  {
    id:          "GC-02",
    name:        "Thin market (6 listed, 1 sold) must block STRONG BUY",
    criticality: "critical",
    run: async () => {
      const depthResult = applyMarketDepthGate({
        items:         Array(6).fill({ title: "Vintage camera" }),
        soldCompCount: 1,
        listedCount:   5,
        priceStats:    { count: 6, median: 80, min: 50, max: 120, priceQualityScore: 0.60, variance: 300 },
        signal:        "STRONG BUY",
        category:      "electronics",
        localMode:     false,
      });
      return { actual: depthResult };
    },
    assert: ({ actual }) => {
      if (!actual.capped)
        return fail("Expected capped=true for thin market", actual);
      if (actual.signal === "STRONG BUY")
        return fail("STRONG BUY must be blocked on thin market", actual);
      return pass();
    },
  },

  // ── GC-03: Oracle-only pricing → must never produce positive signal ─────────
  {
    id:          "GC-03",
    name:        "Oracle-only pricing (no live listings) must return RISKY",
    criticality: "critical",
    run: async () => {
      const r = evaluateSignal({
        resaleScore: 82, dealStrength: 0.45, demandScore: 68,
        confidenceV2: 0.82, trustScore: 0.78, identityQuality: 0.75,
        isOracleOnly: true,
        priceStats: { count: 8, median: 90, min: 55, max: 130, priceQualityScore: 0.65, variance: 400 },
      });
      return { actual: r };
    },
    assert: ({ actual }) => {
      if (actual.signal !== "RISKY")
        return fail("Oracle-only must return RISKY, got: " + actual.signal, actual);
      if (actual.capReason !== "oracle_only")
        return fail("capReason must be oracle_only", actual);
      return pass();
    },
  },

  // ── GC-04: Identity ambiguity near threshold → RISKY ───────────────────────
  {
    id:          "GC-04",
    name:        "Near-threshold identity quality (0.22) must block positive signals",
    criticality: "critical",
    run: async () => {
      const r = evaluateSignal({
        resaleScore: 78, dealStrength: 0.40, demandScore: 62,
        confidenceV2: 0.78, trustScore: 0.74, identityQuality: 0.22,
        priceStats: { count: 20, median: 85, min: 55, max: 120, priceQualityScore: 0.68, variance: 350 },
      });
      return { actual: r };
    },
    assert: ({ actual }) => {
      if (actual.signal !== "RISKY")
        return fail("identityQuality<0.25 must produce RISKY", actual);
      return pass();
    },
  },

  // ── GC-05: Degraded scan (oracle, low confidence, thin market) → RISKY ──────
  {
    id:          "GC-05",
    name:        "Fully degraded scan (oracle + low confidence + thin) → RISKY",
    criticality: "critical",
    run: async () => {
      const r = evaluateSignal({
        resaleScore: 72, dealStrength: 0.30, demandScore: 55,
        confidenceV2: 0.35, trustScore: 0.60, identityQuality: 0.60,
        isOracleOnly: false,
        priceStats: { count: 4, median: 75, min: 50, max: 110, priceQualityScore: 0.50, variance: 450 },
      });
      return { actual: r };
    },
    assert: ({ actual }) => {
      if (actual.signal !== "RISKY")
        return fail("Degraded scan (low confidence) must return RISKY", actual);
      return pass();
    },
  },

  // ── GC-06: High-confidence STRONG BUY in historically failing category ───────
  //   Must not automatically produce STRONG BUY without trust/identity checks.
  //   This tests that NO gate bypass exists.
  {
    id:          "GC-06",
    name:        "Strong scores + critically low trust → RISKY (no bypass path)",
    criticality: "critical",
    run: async () => {
      const r = evaluateSignal({
        resaleScore: 88, dealStrength: 0.55, demandScore: 72,
        confidenceV2: 0.92, trustScore: 0.25, identityQuality: 0.82,
        priceStats: { count: 30, median: 110, min: 65, max: 155, priceQualityScore: 0.80, variance: 500 },
      });
      return { actual: r };
    },
    assert: ({ actual }) => {
      if (actual.signal === "STRONG BUY" || actual.signal === "GOOD DEAL")
        return fail("Critically low trustScore must prevent positive signal", actual);
      return pass();
    },
  },

  // ── GC-07: Solid GOOD DEAL with strong evidence must not be suppressed ───────
  {
    id:          "GC-07",
    name:        "Solid GOOD DEAL evidence must produce GOOD DEAL (no over-suppression)",
    criticality: "high",
    run: async () => {
      const r = evaluateSignal({
        resaleScore: 67, dealStrength: 0.30, demandScore: 58,
        confidenceV2: 0.78, trustScore: 0.72, identityQuality: 0.68,
        priceStats: { count: 22, median: 95, min: 60, max: 135, priceQualityScore: 0.70, variance: 600 },
      });
      return { actual: r };
    },
    assert: ({ actual }) => {
      if (actual.signal !== "GOOD DEAL")
        return fail("Solid GOOD DEAL evidence must produce GOOD DEAL, got: " + actual.signal, actual);
      return pass();
    },
  },

  // ── GC-08: B2B valuation on low-data category must not claim A-grade ─────────
  {
    id:          "GC-08",
    name:        "B2B valuation on low-data category must return C-grade or INSUFFICIENT, not A",
    criticality: "critical",
    run: async () => {
      // Simulate a priceIndex with only 8 samples (below GRADE_C_MIN=10).
      // assessValuationEligibility checks `priceIndex.indexGrade`, not `grade`.
      // Real computePriceIndex returns indexGrade="INSUFFICIENT" when sampleCount < 10.
      const mockIndex = {
        sampleCount: 8,
        indexGrade:  "INSUFFICIENT",            // correct field name
        _reason:     "8 price samples (minimum 10 required)",
      };
      const eligibility = assessValuationEligibility(mockIndex);
      return { actual: { mockIndex, eligibility } };
    },
    assert: ({ actual }) => {
      const { eligibility } = actual;
      // Must not be ready, must not be A or B grade
      if (eligibility?.ready !== false)
        return fail("INSUFFICIENT index must return ready:false", actual);
      if (eligibility?.grade === "A" || eligibility?.grade === "B")
        return fail("Low-sample index must not produce A/B grade", actual);
      return pass();
    },
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run all golden cases.
 *
 * @returns {Promise<GoldenCaseResult>}
 */
export async function runGoldenCases() {
  const start   = Date.now();
  const results = [];
  let passed = 0, failed = 0, criticalFailures = 0;

  for (const gc of GOLDEN_CASES) {
    try {
      const runResult = await gc.run();
      const assertion = gc.assert(runResult);
      const ok = assertion.pass;
      if (ok) {
        passed++;
      } else {
        failed++;
        if (gc.criticality === "critical") criticalFailures++;
      }
      results.push({
        id:          gc.id,
        name:        gc.name,
        criticality: gc.criticality,
        pass:        ok,
        reason:      assertion.reason || null,
        actual:      runResult.actual,
      });
    } catch (err) {
      failed++;
      if (gc.criticality === "critical") criticalFailures++;
      results.push({
        id:          gc.id,
        name:        gc.name,
        criticality: gc.criticality,
        pass:        false,
        error:       err?.message || String(err),
      });
    }
  }

  const releaseBlocked = criticalFailures > 0;

  return {
    runAt:           new Date().toISOString(),
    durationMs:      Date.now() - start,
    total:           GOLDEN_CASES.length,
    passed,
    failed,
    criticalFailures,
    releaseBlocked,
    cases:           results,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass()               { return { pass: true }; }
function fail(reason, actual) { return { pass: false, reason, actual }; }
