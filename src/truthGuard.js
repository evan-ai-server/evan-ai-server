// src/truthGuard.js
// Truth Guard — Phase 17: Adversarial Hardening.
//
// Final pre-response integrity layer. Runs AFTER:
//   assembleProfitIntel → plan gating → affiliate attachment →
//   Phase 15 category intelligence → Phase 16 consistency guard
//
// Unlike consistencyGuard (cross-phase invariant detection),
// truthGuard CORRECTS the payload — it is the last line of defense.
//
// Rules (applied in order, earlier rules take precedence):
//   TG-01  Positive signal (STRONG BUY / GOOD DEAL) with critically-low trust → RISKY
//   TG-02  Bias-raised GOOD DEAL when trustScore < GOOD_DEAL_TRUST floor → revert to FAIR
//   TG-03  Affiliate links must not coexist with a Phase-15 replica red-flag
//   TG-04  expectedProfit must be null / zero on RISKY, OVERPRICED, INSUFFICIENT DATA
//   TG-05  signalCapped=true without capReason → fill fallback "market_safety"
//   TG-06  trustScore must always be hoisted to top-level payload
//   TG-07  Positive signal with zero soldComps AND thin market → add missing warning
//
// Every correction is logged as a structured entry.
// The caller decides whether to log or increment a metric — the guard only
// mutates the payload and returns { corrections, violations }.
//
// Performance: synchronous, zero I/O, O(items) in TG-03.

const POSITIVE_SIGNALS  = new Set(["STRONG BUY", "GOOD DEAL"]);
const UNSAFE_SIGNALS    = new Set(["RISKY", "INSUFFICIENT DATA", "OVERPRICED"]);
const GOOD_DEAL_TRUST_FLOOR = 0.45;   // mirrors buildBuySignal T_GD_TRUST
const STRONG_BUY_TRUST_FLOOR = 0.55;  // mirrors buildBuySignal T_SB_TRUST
const CRITICAL_TRUST    = 0.30;       // mirrors buildBuySignal hard-override-0

/**
 * Apply all truth-guard corrections to a fully-assembled scan payload.
 * Mutates `payload` in-place; always returns safely.
 *
 * @param {object} payload   — fully assembled, consistency-guarded scan response
 * @param {object} [opts]
 *   soldCompCount {number|null}  — from depthGateResult (sold comps only)
 * @returns {{ corrections: string[], violations: Array<{code, message}> }}
 */
export function applyTruthGuard(payload, opts = {}) {
  const corrections = [];
  const violations  = [];

  if (!payload) return { corrections, violations };

  const pi = payload.profitIntel;
  if (!pi)   return { corrections, violations };

  const signal     = pi.buySignal;
  const trustScore = payload.trustScore ?? pi.trustScore ?? null;
  const { soldCompCount = null } = opts;

  // ── TG-01: Positive signal with critically-low trust ─────────────────────
  // buildBuySignal has the same check, but outcome-bias can raise FAIR→GOOD DEAL
  // AFTER trust was already below threshold. This is the final catch.
  if (POSITIVE_SIGNALS.has(signal) && trustScore !== null && trustScore < CRITICAL_TRUST) {
    violations.push({
      code:    "TG-01",
      message: `Positive signal ${signal} with critically low trust ${trustScore} — overriding to RISKY`,
    });
    pi.buySignal    = "RISKY";
    pi.signalRaw    = pi.signalRaw ?? signal;
    pi.signalCapped = true;
    pi.capReason    = pi.capReason ?? "trust_floor_override";
    pi.primaryAction = "VERIFY_MANUALLY";
    pi.expectedProfit = null;
    corrections.push("TG-01:signal_forced_risky");
  }

  // ── TG-02: Bias-raised GOOD DEAL below trust floor ───────────────────────
  // applyOutcomeBiasesToDecision can raise FAIR→GOOD DEAL for experienced users
  // even when trustScore < GOOD_DEAL_TRUST_FLOOR. Revert it.
  const signalAfterTG01 = pi.buySignal;
  if (signalAfterTG01 === "GOOD DEAL" && trustScore !== null && trustScore < GOOD_DEAL_TRUST_FLOOR) {
    violations.push({
      code:    "TG-02",
      message: `GOOD DEAL emitted with trustScore ${trustScore} below floor ${GOOD_DEAL_TRUST_FLOOR} — reverting to FAIR`,
    });
    pi.buySignal    = "FAIR";
    pi.signalRaw    = pi.signalRaw ?? signalAfterTG01;
    pi.signalCapped = true;
    pi.capReason    = pi.capReason ?? "trust_floor_override";
    pi.primaryAction = "WATCH";
    pi.expectedProfit = null;
    corrections.push("TG-02:good_deal_reverted_fair");
  }

  // ── TG-03: Affiliate links must not coexist with replica red-flag ─────────
  // Phase 15 may flag replica risk AFTER affiliate links were attached.
  // Strip them defensively — the Phase 16 consistency guard will have logged it.
  if (payload.categoryReplicaFlag?.flagged) {
    let stripped = false;
    if (payload.affiliateDisclosure) {
      delete payload.affiliateDisclosure;
      stripped = true;
    }
    if (Array.isArray(pi.items)) {
      pi.items = pi.items.map((item) => {
        if (!item.isAffiliate) return item;
        stripped = true;
        const clean = { ...item, isAffiliate: false };
        delete clean.affiliateProgram;
        delete clean._originalUrl;
        return clean;
      });
    }
    if (stripped) {
      violations.push({
        code:    "TG-03",
        message: "Affiliate links stripped — Phase 15 replica red-flag was set after affiliate attachment",
      });
      corrections.push("TG-03:affiliate_stripped");
    }
  }

  // Re-read signal after possible TG-01/TG-02 corrections
  const finalSignal = pi.buySignal;

  // ── TG-04: expectedProfit must not be positive on unsafe signals ──────────
  if (UNSAFE_SIGNALS.has(finalSignal) && (pi.expectedProfit ?? 0) > 0) {
    violations.push({
      code:    "TG-04",
      message: `expectedProfit $${pi.expectedProfit} cleared on ${finalSignal} signal`,
    });
    pi.expectedProfit = null;
    corrections.push("TG-04:expected_profit_cleared");
  }

  // ── TG-05: signalCapped=true must have a capReason ───────────────────────
  if (pi.signalCapped && !pi.capReason) {
    pi.capReason = "market_safety";
    corrections.push("TG-05:cap_reason_fallback");
  }

  // ── TG-06: trustScore must be on top-level payload ────────────────────────
  // The affiliate gate uses `responsePayload.trustScore ?? 1` (fail-open).
  // Ensure it's always present so the gate works correctly.
  if (payload.trustScore == null && pi.trustScore != null) {
    payload.trustScore = pi.trustScore;
    corrections.push("TG-06:trust_score_hoisted");
  }

  // ── TG-07: Positive signal + listed-dominated thin market → warn ──────────
  // If soldCompCount is 0 or null and depth is THIN/DEVELOPING, positive signals
  // may be based entirely on unsold listings. Add a warning if not already present.
  if (POSITIVE_SIGNALS.has(finalSignal) &&
      soldCompCount != null && soldCompCount === 0 &&
      pi.depthTier && (pi.depthTier === "THIN" || pi.depthTier === "DEVELOPING")) {
    const alreadyWarned = Array.isArray(pi.structuredWarnings) &&
      pi.structuredWarnings.some((w) => w?.type === "LISTED_DOMINATED");
    if (!alreadyWarned) {
      const sw = Array.isArray(pi.structuredWarnings) ? pi.structuredWarnings : [];
      sw.push({
        type:     "LISTED_DOMINATED",
        severity: "HIGH",
        message:  "No confirmed sold comps — all price data is from unsold listings.",
        detail:   "Price confidence is reduced. Verify actual sales before buying.",
      });
      pi.structuredWarnings = sw;
      violations.push({
        code:    "TG-07",
        message: "Added missing LISTED_DOMINATED warning for zero-soldComp positive signal",
      });
      corrections.push("TG-07:listed_dominated_warning_added");
    }
  }

  return { corrections, violations };
}

/**
 * Safe wrapper — never throws. Returns empty result on error.
 *
 * @param {object} payload
 * @param {object} [opts]
 * @returns {{ corrections: string[], violations: Array<{code, message}> }}
 */
export function applyTruthGuardSafe(payload, opts = {}) {
  try {
    return applyTruthGuard(payload, opts);
  } catch {
    return { corrections: [], violations: [] };
  }
}
