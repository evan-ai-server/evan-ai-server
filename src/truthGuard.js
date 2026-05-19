// src/truthGuard.js
// Truth Guard — Phase 17 (hardened in Phase 18).
//
// Final pre-response integrity layer. Runs AFTER:
//   assembleProfitIntel → plan gating → category intelligence →
//   consistencyGuard → (Phase 18) THEN affiliateAttach → response
//
// Unlike consistencyGuard (cross-phase invariant detection),
// truthGuard CORRECTS the payload — it is the last line of defense.
//
// Rules (applied in order, earlier rules take precedence):
//   TG-01  Positive signal with critically-low trust → RISKY
//   TG-02  Bias-raised GOOD DEAL when trust < GOOD_DEAL_TRUST floor → revert to FAIR
//   TG-03  Affiliate links must not coexist with a Phase-15 replica red-flag
//   TG-04  expectedProfit must be null / zero on RISKY, OVERPRICED, INSUFFICIENT DATA
//   TG-05  signalCapped=true without capReason → fill fallback "market_safety"
//   TG-06  trustScore must always be hoisted to top-level payload
//   TG-07  Positive signal with zero soldComps AND thin market → add missing warning
//   TG-08  NaN / non-finite numeric fields must be cleared to null / safe defaults
//
// Phase 18 additions:
//   - Structured before/after logging for every correction
//   - payload._corrected + payload._corrections[] flags
//   - All thresholds from truthGuardConfig.js (configurable)
//   - Self-healing hook: persists corrected scan record to Redis

import { logEvent, LOG_TYPES }          from "./structuredLogger.js";
import { getThresholdsForCategory }     from "./truthGuardConfig.js";

const SELF_HEALING_KEY = "tg:corrections"; // Redis ZSET (score = timestamp)
const SELF_HEALING_TTL = 30 * 86400;       // 30 days
const SELF_HEALING_MAX = 5000;             // max entries

/**
 * Apply all truth-guard corrections to a fully-assembled scan payload.
 * Mutates `payload` in-place; always returns safely.
 *
 * @param {object} payload   — fully assembled, consistency-guarded scan response
 * @param {object} [opts]
 *   scanId        {string|null}   — for log correlation
 *   category      {string|null}   — for per-category threshold lookup
 *   soldCompCount {number|null}   — from depthGateResult (sold comps only)
 *   redis         {object|null}   — for structured log persistence + self-healing
 * @returns {{ corrections: string[], violations: Array<{code, message}> }}
 */
export function applyTruthGuard(payload, opts = {}) {
  const corrections = [];
  const violations  = [];

  if (!payload) return { corrections, violations };

  const pi = payload.profitIntel;
  if (!pi)   return { corrections, violations };

  const { scanId = null, category = null, soldCompCount = null, redis = null } = opts;
  const T = getThresholdsForCategory(category);

  // Snapshot BEFORE state for structured logging
  const _before = {
    signal:        pi.buySignal,
    trustScore:    payload.trustScore ?? pi.trustScore ?? null,
    expectedProfit: pi.expectedProfit ?? null,
  };

  let signal     = pi.buySignal;
  const trustScore = payload.trustScore ?? pi.trustScore ?? null;

  // ── TG-08: NaN / non-finite guard (runs first — cleans up compute artifacts) ─
  if (!Number.isFinite(pi.trustScore)) {
    pi.trustScore  = null;
    payload.trustScore = null;
    corrections.push("TG-08:trust_score_nan_cleared");
  }
  if (pi.expectedProfit != null && !Number.isFinite(pi.expectedProfit)) {
    pi.expectedProfit = null;
    corrections.push("TG-08:expected_profit_nan_cleared");
  }
  if (pi.confidenceV2 != null && !Number.isFinite(pi.confidenceV2)) {
    pi.confidenceV2 = null;
    corrections.push("TG-08:confidence_nan_cleared");
  }
  if (pi.priceStats) {
    for (const field of ["median", "min", "max", "variance", "priceQualityScore"]) {
      if (pi.priceStats[field] != null && !Number.isFinite(pi.priceStats[field])) {
        pi.priceStats[field] = null;
        corrections.push(`TG-08:price_stats_${field}_nan_cleared`);
      }
    }
  }
  // Re-read signal after NaN cleanup (NaN could have caused bad values)
  signal = pi.buySignal;

  // ── TG-01: Positive signal with critically-low trust ─────────────────────
  // buildBuySignal has the same check, but outcome-bias can raise FAIR→GOOD DEAL
  // AFTER trust was already below threshold. This is the final catch.
  const POSITIVE = new Set(["STRONG BUY", "GOOD DEAL"]);
  if (POSITIVE.has(signal) && trustScore !== null && trustScore < T.MIN_TRUST_CRITICAL) {
    violations.push({ code: "TG-01", message: `Positive signal ${signal} with critically low trust ${trustScore} — forcing RISKY` });
    pi.buySignal    = "RISKY";
    pi.signalRaw    = pi.signalRaw ?? signal;
    pi.signalCapped = true;
    pi.capReason    = pi.capReason ?? "trust_floor_override";
    pi.primaryAction = "VERIFY_MANUALLY";
    pi.expectedProfit = null;
    corrections.push("TG-01:signal_forced_risky");
    signal = "RISKY";
  }

  // ── TG-02: Bias-raised GOOD DEAL below trust floor ───────────────────────
  if (signal === "GOOD DEAL" && trustScore !== null && trustScore < T.MIN_TRUST_GOOD_DEAL) {
    violations.push({ code: "TG-02", message: `GOOD DEAL with trust ${trustScore} below floor ${T.MIN_TRUST_GOOD_DEAL} — reverting to FAIR` });
    pi.buySignal    = "FAIR";
    pi.signalRaw    = pi.signalRaw ?? signal;
    pi.signalCapped = true;
    pi.capReason    = pi.capReason ?? "trust_floor_override";
    pi.primaryAction = "WATCH";
    pi.expectedProfit = null;
    corrections.push("TG-02:good_deal_reverted_fair");
    signal = "FAIR";
  }

  // ── TG-03: Affiliate links must not coexist with replica red-flag ─────────
  // Phase 15 category intelligence may set categoryReplicaFlag AFTER affiliate
  // links are attached. Strip them defensively here (Phase 18: affiliate now runs
  // AFTER truth guard, so this is a belt-and-suspenders catch for future ordering bugs).
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
      violations.push({ code: "TG-03", message: "Affiliate links stripped — replica red-flag active" });
      corrections.push("TG-03:affiliate_stripped");
    }
  }

  // Re-read signal after possible TG-01/TG-02
  const finalSignal = pi.buySignal;

  // ── TG-04: expectedProfit must not be positive on unsafe signals ──────────
  if (T.UNSAFE_SIGNALS.has(finalSignal) && (pi.expectedProfit ?? 0) > 0) {
    violations.push({ code: "TG-04", message: `expectedProfit $${pi.expectedProfit} cleared on ${finalSignal} signal` });
    pi.expectedProfit = null;
    corrections.push("TG-04:expected_profit_cleared");
  }

  // ── TG-05: signalCapped=true must have a capReason ───────────────────────
  if (pi.signalCapped && !pi.capReason) {
    pi.capReason = "market_safety";
    corrections.push("TG-05:cap_reason_fallback");
  }

  // ── TG-06: trustScore must be on top-level payload ────────────────────────
  if (payload.trustScore == null && pi.trustScore != null) {
    payload.trustScore = pi.trustScore;
    corrections.push("TG-06:trust_score_hoisted");
  }

  // ── TG-07: Positive signal + listed-dominated thin market → warn ──────────
  if (["STRONG BUY", "GOOD DEAL"].includes(finalSignal) &&
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
      violations.push({ code: "TG-07", message: "Added missing LISTED_DOMINATED warning for zero-soldComp positive signal" });
      corrections.push("TG-07:listed_dominated_warning_added");
    }
  }

  // ── Payload flags (Phase 18) ──────────────────────────────────────────────
  const corrected = corrections.length > 0;
  payload._corrected   = corrected;
  payload._corrections = corrections.map((c) => {
    const [rule, ...descParts] = c.split(":");
    return { rule, description: descParts.join(":") };
  });

  // ── Structured logging (Phase 18) ────────────────────────────────────────
  if (violations.length > 0) {
    const _after = {
      signal:        pi.buySignal,
      trustScore:    payload.trustScore ?? pi.trustScore ?? null,
      expectedProfit: pi.expectedProfit ?? null,
    };

    for (const v of violations) {
      // Machine-readable truth_correction log (before/after state)
      logEvent(LOG_TYPES.TRUTH_CORRECTION, {
        scanId,
        rule:   v.code,
        message: v.message,
        before: _before,
        after:  _after,
      }, redis);
    }

    // Aggregate truth_violation log
    logEvent(LOG_TYPES.TRUTH_VIOLATION, {
      scanId,
      corrections,
      violationCount: violations.length,
    }, redis);

    // ── Self-healing hook: persist corrected scan to Redis for replay ────────
    if (redis && scanId) {
      const healingEntry = JSON.stringify({
        scanId,
        category: category || null,
        corrections,
        before: _before,
        after: _after,
        ts: new Date().toISOString(),
      });
      redis.zadd(SELF_HEALING_KEY, Date.now(), healingEntry).catch(() => {});
      redis.zremrangebyrank(SELF_HEALING_KEY, 0, -(SELF_HEALING_MAX + 1)).catch(() => {});
      redis.expire(SELF_HEALING_KEY, SELF_HEALING_TTL).catch(() => {});
    }
  }

  return { corrections, violations };
}

/**
 * Safe wrapper — never throws. Returns empty result on error.
 */
export function applyTruthGuardSafe(payload, opts = {}) {
  try {
    return applyTruthGuard(payload, opts);
  } catch {
    return { corrections: [], violations: [] };
  }
}

/**
 * Get recent truth guard corrections from Redis.
 * Used by ops routes to surface self-healing candidates.
 */
export async function getTruthCorrectionHistory(redis, { limit = 50 } = {}) {
  if (!redis) return [];
  try {
    const raw = await redis.zrevrange(SELF_HEALING_KEY, 0, limit - 1).catch(() => []);
    return raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Get correction rate: (corrected_scans / total_scans) from Redis counters.
 * Returns null if insufficient data.
 */
export async function getCorrectionRate(redis) {
  if (!redis) return null;
  try {
    const [corrections, scans] = await Promise.all([
      redis.get("metrics:truth_corrections:total").catch(() => null),
      redis.get("metrics:scans:total").catch(() => null),
    ]);
    const c = parseInt(corrections || "0");
    const s = parseInt(scans      || "0");
    if (s === 0) return null;
    return { corrections: c, scans: s, rate: c / s };
  } catch { return null; }
}
