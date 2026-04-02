// src/badCallReplay.js
// Bad-Call Replay — Phase 16: No-Decay System.
//
// Pulls confirmed wrong calls from Redis, reconstructs the scan context as
// closely as possible, re-runs through current signal logic, and compares
// THEN vs NOW to show whether the system is learning or repeating mistakes.
//
// Wrong calls are stored by calibrationReport.js:
//   wrong_call:{userId}  ZSET  (score=ts, member=JSON)
//
// Each wrong-call record shape (from calibrationReport.js):
//   { scanId, signal, category, gateSuspected, scannedAt, userId? }
//
// Replay output groups failures by fingerprint class so ops can see patterns.

import { evaluateSignal }   from "./regressionHarness.js";
import { listWrongCalls }   from "./calibrationReport.js";
import { loadFailureFingerprints } from "./failureFingerprintEngine.js";

// Fingerprint classes — which gate most likely caused the wrong call
const FINGERPRINT_CLASSES = {
  identity_ambiguity:      "Identity quality too low to trust signal",
  thin_market:             "Market depth insufficient — listed-dominated or low count",
  replica_risk:            "High-replica-risk category without authentication",
  local_pricing_mismatch:  "Local item priced against national comps",
  drifted_thresholds:      "Category thresholds may have drifted since call",
  weak_calibration:        "Category uncalibrated at time of call",
  trust_floor_miss:        "Trust score was near the floor — marginal call",
  oracle_influence:        "Oracle pricing may have inflated confidence",
  unknown:                 "Pattern unclear — manual review needed",
};

// ── Replay ────────────────────────────────────────────────────────────────────

/**
 * Replay recent wrong calls and compare then vs now.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId  {string|null}  — replay for a specific user or global sample
 *   limit   {number}       — max calls to replay (default 20)
 *   category {string|null} — filter to a single category
 * @returns {Promise<ReplayResult>}
 */
export async function replayWrongCalls(redis, {
  userId   = null,
  limit    = 20,
  category = null,
} = {}) {
  if (!redis) return emptyResult();

  const start = Date.now();

  // Pull wrong calls
  const rawCalls = await fetchWrongCalls(redis, userId, limit);
  const calls    = category
    ? rawCalls.filter((c) => c.category === category)
    : rawCalls;

  if (calls.length === 0) {
    return { ...emptyResult(), durationMs: Date.now() - start, message: "No wrong calls found" };
  }

  const replays     = [];
  const byFingerprint = {};
  let improved = 0, unchanged = 0, worsened = 0;

  for (const call of calls) {
    const replay = await replayOneCall(redis, call);
    replays.push(replay);

    // Tally improvement
    const changed = replay.signalChanged;
    const nowBetter = changed && SIGNAL_BETTER_THAN(replay.signalNow, replay.signalThen);
    if (!changed)            unchanged++;
    else if (nowBetter)      improved++;
    else                     worsened++;

    // Group by fingerprint
    const fp = replay.fingerprint;
    if (!byFingerprint[fp]) byFingerprint[fp] = [];
    byFingerprint[fp].push({ scanId: call.scanId, signalThen: call.signal, signalNow: replay.signalNow });
  }

  // Summarize fingerprint groups
  const fingerprintSummary = Object.entries(byFingerprint).map(([fp, items]) => ({
    fingerprint:  fp,
    description:  FINGERPRINT_CLASSES[fp] || fp,
    count:        items.length,
    examples:     items.slice(0, 3),
    resolved:     items.filter((i) => SIGNAL_BETTER_THAN(i.signalNow, i.signalThen)).length,
  })).sort((a, b) => b.count - a.count);

  return {
    runAt:       new Date().toISOString(),
    durationMs:  Date.now() - start,
    total:       calls.length,
    improved,
    unchanged,
    worsened,
    resolvedRate: calls.length > 0 ? Math.round((improved / calls.length) * 100) : 0,
    byFingerprint: fingerprintSummary,
    replays,
  };
}

// ── Single call replay ─────────────────────────────────────────────────────────

async function replayOneCall(redis, call) {
  const {
    scanId, signal: signalThen, category, gateSuspected, scannedAt,
    userId,
    // Reconstructed context fields (stored at time of wrong call)
    resaleScore, dealStrength, demandScore, confidenceV2,
    trustScore, identityQuality, priceStats, isOracleOnly,
  } = call;

  // Re-run current logic with whatever context was stored
  let signalNow = null;
  let nowResult = null;
  let replayError = null;

  try {
    // Only replay if we have enough context
    if (resaleScore != null || dealStrength != null) {
      nowResult = evaluateSignal({
        resaleScore:     resaleScore    ?? 50,
        dealStrength:    dealStrength   ?? 0.20,
        demandScore:     demandScore    ?? 50,
        confidenceV2:    confidenceV2   ?? 0.65,
        trustScore:      trustScore     ?? null,
        identityQuality: identityQuality ?? null,
        isOracleOnly:    isOracleOnly   ?? false,
        priceStats:      priceStats     || { count: 5, median: 80, min: 50, max: 120, priceQualityScore: 0.60, variance: 400 },
      });
      signalNow = nowResult.signal;
    } else {
      signalNow = "REPLAY_INSUFFICIENT_CONTEXT";
    }
  } catch (err) {
    replayError = err?.message;
    signalNow   = "REPLAY_ERROR";
  }

  const signalChanged = signalNow !== signalThen && signalNow !== "REPLAY_INSUFFICIENT_CONTEXT";
  const fingerprint   = classifyFingerprint(call, nowResult);

  return {
    scanId,
    category:      category || "unknown",
    scannedAt,
    signalThen,
    signalNow,
    capReasonNow:  nowResult?.capReason || null,
    signalChanged,
    improved:      signalChanged && SIGNAL_BETTER_THAN(signalNow, signalThen),
    fingerprint,
    gateSuspected: gateSuspected || null,
    replayError:   replayError || null,
  };
}

// ── Fingerprint classifier ─────────────────────────────────────────────────────

function classifyFingerprint(call, nowResult) {
  const gs  = call.gateSuspected || "";
  const cap = nowResult?.capReason || "";
  const iq  = call.identityQuality ?? 1;
  const ts  = call.trustScore       ?? 1;
  const cnt = call.priceStats?.count ?? 5;
  const oo  = call.isOracleOnly;

  if (oo)                                         return "oracle_influence";
  if (iq < 0.30)                                  return "identity_ambiguity";
  if (cnt < 5 || gs.includes("thin"))             return "thin_market";
  if (gs.includes("replica"))                     return "replica_risk";
  if (gs.includes("local"))                       return "local_pricing_mismatch";
  if (gs.includes("calibrat") || gs.includes("threshold")) return "drifted_thresholds";
  if (ts !== null && ts < 0.50)                   return "trust_floor_miss";
  if (cap === "oracle_only")                      return "oracle_influence";
  if (cap === "weak_identity" || cap === "low_confidence") return "identity_ambiguity";
  return "unknown";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchWrongCalls(redis, userId, limit) {
  if (userId) {
    // Per-user wrong calls via calibrationReport.js
    return listWrongCalls(redis, userId, limit).catch(() => []);
  }
  // Global: scan wrong_call:{*} keys — sample across recent users
  try {
    const keys = await redis.keys("wrong_call:*").catch(() => []);
    if (!keys.length) return [];
    const allCalls = [];
    for (const key of keys.slice(0, 10)) {  // cap to 10 users
      const uid    = key.replace("wrong_call:", "");
      const calls  = await listWrongCalls(redis, uid, Math.ceil(limit / 5)).catch(() => []);
      allCalls.push(...calls.map((c) => ({ ...c, userId: uid })));
    }
    return allCalls.slice(0, limit);
  } catch { return []; }
}

// "Better" = signal moved toward safety (STRONG BUY → GOOD DEAL is better when it was a wrong call)
const SAFETY_ORDER = { "RISKY": 0, "INSUFFICIENT DATA": 1, "FAIR": 2, "OVERPRICED": 3, "GOOD DEAL": 4, "STRONG BUY": 5 };
function SIGNAL_BETTER_THAN(now, then) {
  // If the wrong call was too optimistic (STRONG BUY when it should have been lower),
  // "better" means now returns a MORE conservative signal
  return (SAFETY_ORDER[now] ?? 3) < (SAFETY_ORDER[then] ?? 3);
}

function emptyResult() {
  return {
    runAt:         new Date().toISOString(),
    durationMs:    0,
    total:         0,
    improved:      0,
    unchanged:     0,
    worsened:      0,
    resolvedRate:  0,
    byFingerprint: [],
    replays:       [],
  };
}
