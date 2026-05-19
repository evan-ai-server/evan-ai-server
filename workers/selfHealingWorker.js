// workers/selfHealingWorker.js
// Self-Healing Worker — Phase 19: Self-Learning Core.
//
// Runs periodically to analyze system health, adapt thresholds,
// trigger auto-suppressions for degraded categories, and log all actions.
//
// Actions taken (most to least aggressive):
//   - computeAndStoreAdaptiveThresholds: tighten trust floors (always safe)
//   - triggerModelReview: flag category for ops review
//   - auto-suppress STRONG BUY: applied only at very high correction rates
//
// All suppressions are time-limited (48h) and logged.
// This worker never deletes data or permanently changes config.

import { getTopFailingCategories } from "../src/learningStore.js";
import {
  computeAndStoreAdaptiveThresholds,
  refreshThresholdCache,
  triggerModelReview,
} from "../src/adaptiveThresholds.js";
import { suppressCategory, checkIncidentControl, CONTROL_TYPES } from "../src/incidentControls.js";
import { runAnomalyDetection } from "../src/anomalyEngine.js";

// Thresholds for auto-actions
const AUTO_SUPPRESS_CORRECTION_RATE = 0.30;  // > 30% → auto-suppress STRONG BUY
const AUTO_SUPPRESS_MIN_SCANS       = 50;    // need 50+ scans to trigger
const AUTO_REVIEW_CORRECTION_RATE   = 0.15;  // > 15% → trigger model review flag
const AUTO_SUPPRESS_TTL_SECONDS     = 48 * 3600; // 48h auto-expiry
// Cooldown: do not re-trigger suppression if existing suppress has > 24h remaining TTL.
// Prevents per-cycle audit log spam and repeated Redis writes for stable suppressions.
const AUTO_SUPPRESS_COOLDOWN_TTL    = 24 * 3600; // 24h — re-suppress only when < 24h remains

/**
 * Run one self-healing cycle.
 * Analyze categories, adapt thresholds, suppress if needed, refresh cache.
 *
 * @param {object} redis
 * @param {{ log }} opts
 * @returns {Promise<{ ok, runAt, durationMs, actions, errors }>}
 */
export async function runSelfHealingCycle(redis, { log = () => {} } = {}) {
  if (!redis) return { ok: false, reason: "no_redis" };

  const start   = Date.now();
  const actions = [];
  const errors  = [];

  log(`[selfHealing] Starting cycle at ${new Date().toISOString()}`);

  try {
    // 1. Run anomaly detection to refresh the active anomaly snapshot
    const anomalyReport = await runAnomalyDetection(redis).catch(() => null);
    if (anomalyReport) {
      log(`[selfHealing] Anomaly scan: ${anomalyReport.total} anomalies (${anomalyReport.criticalCount} critical)`);
    }

    // 2. Get top failing categories by correction rate
    const failing = await getTopFailingCategories(redis, {
      limit:    20,
      minScans: AUTO_SUPPRESS_MIN_SCANS,
    });
    log(`[selfHealing] ${failing.length} categories with ≥${AUTO_SUPPRESS_MIN_SCANS} scans analysed`);

    for (const perf of failing) {
      const { category, correctionRate, totalScans } = perf;

      // 3. Always: compute and store adaptive threshold adjustments
      try {
        const adaptation = await computeAndStoreAdaptiveThresholds(redis, category);
        if (adaptation.adjusted) {
          actions.push({ type: "threshold_adjusted", category, trustBoost: adaptation.trustBoost, reason: adaptation.reason });
          log(`[selfHealing] Thresholds adjusted for ${category}: +${adaptation.trustBoost} (${adaptation.reason})`);
        }
      } catch (err) {
        errors.push({ category, action: "threshold_adjusted", error: err?.message });
      }

      // 4. High correction rate: trigger model review flag
      if (correctionRate >= AUTO_REVIEW_CORRECTION_RATE) {
        await triggerModelReview(redis, category, `correction_rate_${(correctionRate * 100).toFixed(0)}pct_${totalScans}scans`);
        actions.push({ type: "model_review_triggered", category, correctionRate, totalScans });
        log(`[selfHealing] Model review triggered for ${category} (${(correctionRate * 100).toFixed(0)}% correction rate)`);
      }

      // 5. Very high correction rate: auto-suppress STRONG BUY (time-limited, cooldown-gated)
      if (correctionRate >= AUTO_SUPPRESS_CORRECTION_RATE) {
        try {
          // Cooldown check: skip re-suppress if existing suppression still has healthy TTL.
          // Prevents per-2h audit log spam for persistently degraded categories.
          // Uses actual Redis TTL (not stored expiresAt) — authoritative source for key lifetime.
          const existing = await checkIncidentControl(redis, CONTROL_TYPES.CAT_SUPPRESS, category).catch(() => null);
          let remainingTtlMs = 0;
          if (existing) {
            const suppressKey = `incident:cat_suppress:${String(category).toLowerCase().trim().replace(/\s+/g, "_")}`;
            const ttlSec = await redis.ttl(suppressKey).catch(() => -1);
            remainingTtlMs = ttlSec > 0 ? ttlSec * 1000 : 0;
          }
          if (existing && remainingTtlMs > AUTO_SUPPRESS_COOLDOWN_TTL * 1000) {
            actions.push({ type: "auto_suppressed_skipped_cooldown", category, correctionRate, remainingHours: Math.round(remainingTtlMs / 3600_000) });
            log(`[selfHealing] Skip re-suppress ${category}: already active, ${Math.round(remainingTtlMs / 3600_000)}h remaining`);
          } else {
            await suppressCategory(redis, category, {
              reason:      `auto_suppress:correction_rate_${(correctionRate * 100).toFixed(0)}pct_${totalScans}scans`,
              triggeredBy: "selfHealingWorker",
              ttlSeconds:  AUTO_SUPPRESS_TTL_SECONDS,
            });
            actions.push({ type: "auto_suppressed", category, signal: "STRONG BUY (category-wide)", correctionRate, totalScans, ttlHours: AUTO_SUPPRESS_TTL_SECONDS / 3600 });
            log(`[selfHealing] Auto-suppressed ${category}: ${(correctionRate * 100).toFixed(0)}% correction rate over ${totalScans} scans (48h TTL)`);
          }
        } catch (err) {
          errors.push({ category, action: "auto_suppress", error: err?.message });
          log(`[selfHealing] Auto-suppress failed for ${category}: ${err?.message}`);
        }
      }
    }

    // 6. Refresh in-memory adaptive cache so TruthGuard picks up new thresholds
    await refreshThresholdCache(redis).catch(() => {});
    log(`[selfHealing] Adaptive threshold cache refreshed`);

  } catch (err) {
    errors.push({ action: "main_cycle", error: err?.message });
    log(`[selfHealing] Main cycle error: ${err?.message}`);
  }

  const result = {
    ok:         errors.length === 0,
    runAt:      new Date().toISOString(),
    durationMs: Date.now() - start,
    actions,
    errors,
  };

  // Persist cycle result for ops visibility
  try {
    redis.lpush("learn:healing_cycles", JSON.stringify(result)).catch(() => {});
    redis.ltrim("learn:healing_cycles", 0, 99).catch(() => {});
    redis.expire("learn:healing_cycles", 30 * 86400).catch(() => {});
  } catch { /* non-fatal */ }

  log(`[selfHealing] Cycle complete: ${actions.length} action(s), ${errors.length} error(s) in ${result.durationMs}ms`);
  return result;
}

/**
 * Get self-healing cycle history from Redis.
 *
 * @param {object} redis
 * @param {{ limit }} opts
 * @returns {Promise<object[]>}
 */
export async function getHealingHistory(redis, { limit = 20 } = {}) {
  if (!redis) return [];
  try {
    const raw = await redis.lrange("learn:healing_cycles", 0, limit - 1).catch(() => []);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Get pending model review queue.
 * Items are flagged categories awaiting ops investigation or ML retraining.
 *
 * @param {object} redis
 * @param {{ limit }} opts
 * @returns {Promise<object[]>}
 */
export async function getModelReviewQueue(redis, { limit = 50 } = {}) {
  if (!redis) return [];
  try {
    const raw = await redis.lrange("learn:model_review_queue", 0, limit - 1).catch(() => []);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
