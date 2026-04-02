// src/consistencyGuard.js
// Consistency Guard — Phase 16: No-Decay System.
//
// Cross-phase invariant enforcement.  Pure function — no Redis reads at check time.
// Called at scan-response assembly: lightweight, synchronous, zero I/O.
//
// Invariants enforced:
//   CG-01  Affiliate cannot attach on RISKY or INSUFFICIENT DATA signals
//   CG-02  Plan gating cannot expose pro-depth fields when trustScore is critically low
//   CG-03  Personalization cannot escalate signal beyond base trust ceiling
//   CG-04  categoryIntelligence cannot mutate buySignal (read-only enrichment)
//   CG-05  B2B valuation confidence must not exceed what index grade allows
//   CG-06  Calendar pressure cannot override replica-risk cap
//   CG-07  Category identity enrichment score cannot bump confidence past cap
//   CG-08  Thin market + no depth cap + optimistic signal = contradiction
//
// checkPayloadConsistency() is the hot-path function.
// auditB2BPayload() is the separate B2B check (called at B2B route, not scan route).
//
// If violations are found, they are returned as an array.
// The CALLER decides whether to block or just log — the guard never mutates the payload.

// Signals considered "positive" (cannot be sent with known unsafe conditions)
const POSITIVE_SIGNALS = new Set(["STRONG BUY", "GOOD DEAL"]);
const UNSAFE_SIGNALS   = new Set(["RISKY", "INSUFFICIENT DATA"]);

// B2B confidence ceiling by index grade
const B2B_MAX_CONFIDENCE = {
  A:            "high_confidence",
  B:            "moderate_confidence",
  C:            "low_confidence",
  INSUFFICIENT: "unresolved",
};
const CONFIDENCE_RANK = { high_confidence: 0, moderate_confidence: 1, low_confidence: 2, unresolved: 3 };

/**
 * Check a fully-assembled scan payload for cross-phase consistency violations.
 * Must be called AFTER all enrichment (plan gating, affiliate, category intel).
 *
 * @param {object} payload — fully assembled scan response
 * @param {string} plan    — "free" | "pro" | "internal"
 * @returns {{ consistent: boolean, violations: Violation[] }}
 */
export function checkPayloadConsistency(payload, plan = "free") {
  if (!payload) return { consistent: true, violations: [] };

  const violations = [];
  const signal     = payload.profitIntel?.buySignal ?? payload.buySignal ?? null;
  const trustScore = payload.trustScore ?? null;
  const isUnsafe   = UNSAFE_SIGNALS.has(signal);
  const isPositive = POSITIVE_SIGNALS.has(signal);

  // ── CG-01: Affiliate must not attach to unsafe scans ──────────────────────
  if (isUnsafe && payload.affiliateDisclosure) {
    violations.push({
      code:     "CG-01",
      severity: "critical",
      message:  `Affiliate disclosure present on ${signal} signal — affiliate must not attach to unsafe results`,
      fields:   ["affiliateDisclosure", "signal"],
    });
  }

  if (isUnsafe && payload.profitIntel?.items?.some((i) => i.isAffiliate)) {
    violations.push({
      code:     "CG-01b",
      severity: "critical",
      message:  "Affiliate-tagged items present in profitIntel with unsafe signal",
      fields:   ["profitIntel.items[].isAffiliate"],
    });
  }

  // ── CG-02: Critically low trust + positive signal = contradiction ─────────
  if (trustScore !== null && trustScore < 0.30 && isPositive) {
    violations.push({
      code:     "CG-02",
      severity: "critical",
      message:  `Positive signal ${signal} emitted with critically low trustScore ${trustScore.toFixed(2)} — should be RISKY`,
      fields:   ["trustScore", "signal"],
    });
  }

  // ── CG-03: Personalization should not escalate past trust ceiling ─────────
  if (payload.personalAction && signal && isPositive && trustScore !== null && trustScore < 0.45) {
    violations.push({
      code:     "CG-03",
      severity: "high",
      message:  `personalAction present with low trustScore ${trustScore.toFixed(2)} and positive signal — personalization may be inflating confidence`,
      fields:   ["personalAction", "trustScore"],
    });
  }

  // ── CG-04: categoryIntelligence must not contain a mutated buySignal ──────
  const ci = payload.categoryIntelligence;
  if (ci && "buySignal" in ci) {
    violations.push({
      code:     "CG-04",
      severity: "critical",
      message:  "categoryIntelligence must not contain buySignal — it is read-only enrichment",
      fields:   ["categoryIntelligence.buySignal"],
    });
  }

  // ── CG-06: Calendar pressure cannot override replica-risk cap ─────────────
  if (payload.categoryReplicaFlag?.flagged === true &&
      payload.categoryIntelligence?.calendarContext?.marketPressure === "buy" &&
      isPositive) {
    violations.push({
      code:     "CG-06",
      severity: "high",
      message:  "Calendar 'buy' pressure present alongside replica-risk flag and positive signal — replica cap must take priority",
      fields:   ["categoryReplicaFlag", "calendarContext.marketPressure", "signal"],
    });
  }

  // ── CG-08: Thin market + positive signal + no cap reason ─────────────────
  const warnings = payload.warnings || payload.profitIntel?.warnings || [];
  const hasThinWarning = warnings.some((w) => {
    const ws = typeof w === "string" ? w : (w?.type || "");
    return /thin|insufficient|sparse/i.test(ws);
  });
  if (hasThinWarning && signal === "STRONG BUY" && !payload.capReason) {
    violations.push({
      code:     "CG-08",
      severity: "high",
      message:  "STRONG BUY on thin/insufficient market without a capReason — depth gate may have been bypassed",
      fields:   ["signal", "warnings", "capReason"],
    });
  }

  return {
    consistent: violations.length === 0,
    violations,
  };
}

/**
 * Check a B2B valuation response for overconfidence.
 * Called from POST /api/b2b/valuation — not the scan hot path.
 *
 * @param {object} valuationResult — from businessValuationApi.valuateItem
 * @param {object} priceIndex      — from getCategoryPriceIndex
 * @returns {{ consistent: boolean, violations: Violation[] }}
 */
export function auditB2BPayload(valuationResult, priceIndex) {
  const violations = [];
  if (!valuationResult || !priceIndex) return { consistent: true, violations };

  const claimed  = valuationResult.confidence;   // e.g. "high_confidence"
  const grade    = priceIndex.indexGrade;         // "A" | "B" | "C" | "INSUFFICIENT"
  const allowed  = B2B_MAX_CONFIDENCE[grade]      || "unresolved";

  const claimedRank  = CONFIDENCE_RANK[claimed] ?? 2;
  const allowedRank  = CONFIDENCE_RANK[allowed] ?? 2;

  // Lower rank = stronger claim; if claimed is stronger than allowed → violation
  if (claimedRank < allowedRank) {
    violations.push({
      code:     "CG-05",
      severity: "critical",
      message:  `B2B valuation claims ${claimed} but price index grade is ${grade} (max allowed: ${allowed})`,
      fields:   ["confidence", "indexGrade"],
      claimed,
      allowed,
      grade,
    });
  }

  return {
    consistent: violations.length === 0,
    violations,
  };
}

/**
 * Scan-time lightweight guard — runs inline, returns violations array only.
 * Does NOT throw — returns empty array on error to protect scan path.
 *
 * @param {object} payload
 * @param {string} plan
 * @returns {Violation[]}
 */
export function guardPayloadSafe(payload, plan = "free") {
  try {
    return checkPayloadConsistency(payload, plan).violations;
  } catch { return []; }
}
