// src/adaptiveThresholds.js
// Adaptive Thresholds — Phase 19: Self-Learning Core.
//
// Dynamically adjusts TruthGuard thresholds based on:
//   - per-category correction rates
//   - anomaly detection counts
//   - average trust score trends
//
// Safety invariants:
//   - Thresholds can only be RAISED (tightened), never lowered below base
//   - Maximum boost capped at +0.20 above base threshold
//   - All adjustments are logged and time-limited (7-day TTL)
//   - Falls back to static thresholds if Redis unavailable
//
// Integration: calls setAdaptiveCache (from truthGuardConfig.js) to make
// adjustments available synchronously inside TruthGuard without async overhead.

import { TRUTH_THRESHOLDS }                    from "./truthGuardConfig.js";
import { setAdaptiveCache }                    from "./truthGuardConfig.js";
import { getCategoryPerformance, normalizeCategory } from "./learningStore.js";

const ADAPTIVE_KEY_PREFIX = "adaptive:thresholds:";
const ADAPTIVE_TTL        = 7 * 86400;   // 7-day TTL
const MAX_TRUST_BOOST     = 0.20;        // hard cap on threshold raises

/**
 * Compute and store adaptive threshold adjustments for a single category.
 * Higher correction rate or lower avg trust → raises trust floors.
 *
 * @param {object} redis
 * @param {string} category
 * @returns {Promise<{ adjusted, trustBoost, reason }>}
 */
export async function computeAndStoreAdaptiveThresholds(redis, category) {
  if (!redis || !category) return { adjusted: false, trustBoost: 0, reason: "no_redis_or_category" };
  const cat = normalizeCategory(category);

  try {
    const perf = await getCategoryPerformance(redis, cat);
    if (!perf || perf.totalScans < 30) {
      return { adjusted: false, trustBoost: 0, reason: "insufficient_data" };
    }

    let trustBoost = 0;
    let reason     = "within_normal";

    if (perf.correctionRate >= 0.20) {
      trustBoost = 0.15;
      reason     = `high_correction_rate_${(perf.correctionRate * 100).toFixed(0)}pct`;
    } else if (perf.correctionRate >= 0.10) {
      trustBoost = 0.08;
      reason     = `elevated_correction_rate_${(perf.correctionRate * 100).toFixed(0)}pct`;
    } else if (perf.correctionRate >= 0.05) {
      trustBoost = 0.04;
      reason     = `mild_correction_rate_${(perf.correctionRate * 100).toFixed(0)}pct`;
    }

    // Low average trust compounds the boost
    if (perf.avgTrust !== null && perf.avgTrust < 0.50) {
      const extraBoost = 0.05;
      trustBoost = Math.min(trustBoost + extraBoost, MAX_TRUST_BOOST);
      reason     = `${reason}+low_avg_trust_${perf.avgTrust.toFixed(2)}`;
    }

    const entry = JSON.stringify({
      trustBoost,
      reason,
      computedAt: new Date().toISOString(),
      stats: {
        correctionRate: perf.correctionRate,
        avgTrust:       perf.avgTrust,
        totalScans:     perf.totalScans,
      },
    });
    await redis.set(`${ADAPTIVE_KEY_PREFIX}${cat}`, entry, "EX", ADAPTIVE_TTL);

    return { adjusted: trustBoost > 0, trustBoost, reason };
  } catch { return { adjusted: false, trustBoost: 0, reason: "error" }; }
}

/**
 * Refresh the in-memory adaptive threshold cache from Redis.
 * Called at startup and periodically by the self-healing worker.
 * This makes adaptive thresholds available synchronously in TruthGuard.
 *
 * @param {object} redis
 */
export async function refreshThresholdCache(redis) {
  if (!redis) return;
  try {
    const keys  = await redis.keys(`${ADAPTIVE_KEY_PREFIX}*`).catch(() => []);
    const cache = {};
    for (const key of keys) {
      const val = await redis.get(key).catch(() => null);
      if (val) {
        try {
          const cat  = key.replace(ADAPTIVE_KEY_PREFIX, "");
          cache[cat] = JSON.parse(val);
        } catch { /* skip malformed entry */ }
      }
    }
    setAdaptiveCache(cache);
  } catch { /* non-fatal */ }
}

/**
 * Get all active adaptive threshold overrides.
 * Used by /api/ops/learning/summary and the release gate.
 *
 * @param {object} redis
 * @returns {Promise<object[]>}
 */
export async function getAllAdaptiveOverrides(redis) {
  if (!redis) return [];
  try {
    const keys     = await redis.keys(`${ADAPTIVE_KEY_PREFIX}*`).catch(() => []);
    const overrides = [];
    for (const key of keys) {
      const val = await redis.get(key).catch(() => null);
      if (val) {
        try {
          const cat = key.replace(ADAPTIVE_KEY_PREFIX, "");
          overrides.push({ category: cat, ...JSON.parse(val) });
        } catch { /* skip */ }
      }
    }
    return overrides.sort((a, b) => (b.trustBoost ?? 0) - (a.trustBoost ?? 0));
  } catch { return []; }
}

/**
 * Hook: trigger model review signal when anomaly or correction spike detected.
 * Phase 19: logs structured signal + persists to Redis queue for ops visibility.
 * Future phases can connect this queue to a real ML pipeline.
 *
 * @param {object} redis
 * @param {string} category
 * @param {string} reason
 */
export async function triggerModelReview(redis, category, reason) {
  try {
    console.log(JSON.stringify({
      type:        "model_review_trigger",
      category:    category || null,
      reason:      reason   || null,
      ts:          new Date().toISOString(),
    }));
    if (!redis) return;
    const entry = JSON.stringify({
      category:    category || null,
      reason:      reason   || null,
      triggeredAt: new Date().toISOString(),
      action:      "model_review_flagged",
    });
    redis.lpush("learn:model_review_queue", entry).catch(() => {});
    redis.ltrim("learn:model_review_queue", 0, 499).catch(() => {});
    redis.expire("learn:model_review_queue", 30 * 86400).catch(() => {});
  } catch { /* non-fatal */ }
}
