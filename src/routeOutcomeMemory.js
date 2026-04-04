// src/routeOutcomeMemory.js
// Phase 6 — Route Outcome Memory + Marketplace Leverage Metrics.
//
// Closes the feedback loop: when a user sells an item, records the actual outcome
// vs. the Evan recommendation. This data drives:
//   - Route accuracy scoring (did we recommend the right platform?)
//   - Platform leverage metrics (which platforms are actually performing for users?)
//   - Velocity calibration feedback (are our velocity estimates accurate?)
//   - Net estimation accuracy (are our fee/net estimates right?)
//
// Redis key layout:
//   ro:outcome:{scanId}           STRING  outcome record (2yr TTL)
//   ro:leverage:{platformId}      HASH    running aggregate metrics per platform
//   ro:recent                     ZSET    recent outcomeIds by recordedAt (for audit)
//   ro:ops                        HASH    ops counters

// ── Constants ─────────────────────────────────────────────────────────────────

export const OUTCOME_VERSION = "6.0";
const OUTCOME_TTL  = 2 * 365 * 86400;   // 2 years
const RECENT_TTL   = 90  * 86400;       // recent index: 90 days

// Route accuracy thresholds
const ACCURACY_MATCH_TOLERANCE_PCT = 0.08;  // ±8% net accuracy = "accurate"

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_OUTCOME  = scanId     => `ro:outcome:${scanId}`;
const KEY_LEVERAGE = platformId => `ro:leverage:${platformId}`;
const KEY_RECENT   = ()         => `ro:recent`;
const KEY_OPS      = ()         => `ro:ops`;

// ── Record an outcome ─────────────────────────────────────────────────────────

/**
 * Record the actual outcome of a sale.
 * Call this when a user confirms they sold an item (or the outcome is known).
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId              {string}    — Evan scan ID this outcome is for
 *   recommendedPlatform {string}    — platform Evan recommended
 *   actualPlatform      {string}    — platform the user actually sold on
 *   expectedNet         {number}    — Evan's riskAdjustedNet estimate for the actual platform
 *   actualNet           {number}    — actual net proceeds the seller received
 *   expectedDays        {number}    — Evan's velocity estimate for the actual platform
 *   actualDays          {number}    — actual days the item took to sell
 *   category            {string}
 *   price               {number}    — original list/ask price
 *   condition           {string}
 *   notes               {string|null}
 *   reportedBy          {string}    — "user"|"platform_sync"|"system"
 * @returns {Promise<{ ok, outcomeId?, record?, routeAccuracyScore? }>}
 */
export async function recordRouteOutcome(redis, {
  scanId,
  recommendedPlatform = null,
  actualPlatform      = null,
  expectedNet         = null,
  actualNet           = null,
  expectedDays        = null,
  actualDays          = null,
  category            = "generic",
  price               = null,
  condition           = null,
  notes               = null,
  reportedBy          = "user",
} = {}) {
  if (!redis || !scanId) {
    return { ok: false, error: "missing_required" };
  }
  if (!actualPlatform) {
    return { ok: false, error: "actual_platform_required" };
  }

  try {
    const now            = Date.now();
    const outcomeId      = `ro_${scanId}`;
    const followedRoute  = recommendedPlatform
      ? actualPlatform === recommendedPlatform
      : null;  // null if no recommendation was made

    // Route accuracy score (0-1)
    const routeAccuracyScore = _computeRouteAccuracyScore({
      followedRoute,
      expectedNet,
      actualNet,
      expectedDays,
      actualDays,
    });

    // Net estimation error
    const netError        = (expectedNet != null && actualNet != null)
      ? Math.round((actualNet - expectedNet) * 100) / 100
      : null;
    const netErrorPct     = (expectedNet && expectedNet > 0 && netError != null)
      ? Math.round(netError / expectedNet * 1000) / 10
      : null;

    // Velocity estimation error
    const daysError       = (expectedDays != null && actualDays != null)
      ? actualDays - expectedDays
      : null;

    const record = {
      outcomeId,
      scanId,
      recommendedPlatform,
      actualPlatform,
      followedRoute,
      expectedNet,
      actualNet,
      netError,
      netErrorPct,
      expectedDays,
      actualDays,
      daysError,
      category,
      price,
      condition,
      routeAccuracyScore,
      notes,
      reportedBy,
      recordedAt: now,
      outcomeVersion: OUTCOME_VERSION,
    };

    // Store outcome
    await redis.set(KEY_OUTCOME(scanId), JSON.stringify(record), { EX: OUTCOME_TTL });
    await redis.zAdd(KEY_RECENT(), [{ score: now, value: outcomeId }]);
    await redis.expire(KEY_RECENT(), RECENT_TTL);
    await redis.hIncrBy(KEY_OPS(), "total_outcomes", 1);
    await redis.hIncrBy(KEY_OPS(), `category.${category}`, 1);
    if (followedRoute === true)  await redis.hIncrBy(KEY_OPS(), "route_followed",     1);
    if (followedRoute === false) await redis.hIncrBy(KEY_OPS(), "route_not_followed", 1);

    // Update leverage metrics for the actual platform
    await _updateLeverageMetrics(redis, actualPlatform, {
      netError,
      daysError,
      actualNet,
      price,
      routeAccuracyScore,
      category,
    });

    return { ok: true, outcomeId, record, routeAccuracyScore };
  } catch (err) {
    return { ok: false, error: "outcome_record_failed", reason: err?.message };
  }
}

// ── Leverage metrics per platform ─────────────────────────────────────────────

async function _updateLeverageMetrics(redis, platformId, {
  netError, daysError, actualNet, price, routeAccuracyScore, category,
}) {
  try {
    const key = KEY_LEVERAGE(platformId);
    const pipeline = redis.multi();

    pipeline.hIncrBy(key, "total_outcomes", 1);
    pipeline.hIncrBy(key, `category.${category}`, 1);

    if (actualNet != null) {
      // Running sum for average net (divide at read time by total_outcomes)
      pipeline.hIncrByFloat(key, "sum_actual_net", actualNet);
    }
    if (netError != null) {
      pipeline.hIncrByFloat(key, "sum_net_error", netError);
      pipeline.hIncrBy(key, "net_error_count", 1);
      if (Math.abs(netError) / (price || 1) <= ACCURACY_MATCH_TOLERANCE_PCT) {
        pipeline.hIncrBy(key, "accurate_net_count", 1);
      }
    }
    if (daysError != null) {
      pipeline.hIncrByFloat(key, "sum_days_error", daysError);
      pipeline.hIncrBy(key, "days_error_count", 1);
    }
    if (routeAccuracyScore != null) {
      pipeline.hIncrByFloat(key, "sum_accuracy_score", routeAccuracyScore);
    }

    await pipeline.exec();
    // No TTL on leverage metrics — they're cumulative
  } catch { /* non-fatal */ }
}

// ── Read leverage metrics ─────────────────────────────────────────────────────

/**
 * Get aggregate leverage metrics for a platform.
 * Shows how well Evan's routing and estimates performed on this platform.
 */
export async function getPlatformLeverageMetrics(redis, platformId) {
  if (!redis || !platformId) return null;
  try {
    const raw = await redis.hGetAll(KEY_LEVERAGE(platformId));
    if (!raw || Object.keys(raw).length === 0) return null;

    const n              = Number(raw["total_outcomes"]) || 0;
    const sumNet         = parseFloat(raw["sum_actual_net"]) || 0;
    const sumNetError    = parseFloat(raw["sum_net_error"]) || 0;
    const netErrCount    = Number(raw["net_error_count"]) || 0;
    const accurateCount  = Number(raw["accurate_net_count"]) || 0;
    const sumDaysError   = parseFloat(raw["sum_days_error"]) || 0;
    const daysErrCount   = Number(raw["days_error_count"]) || 0;
    const sumAccuracy    = parseFloat(raw["sum_accuracy_score"]) || 0;

    // Category breakdown
    const byCategory = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("category.")) {
        byCategory[k.replace("category.", "")] = Number(v) || 0;
      }
    }

    return {
      platformId,
      totalOutcomes:    n,
      avgActualNet:     n > 0      ? Math.round(sumNet / n * 100) / 100          : null,
      avgNetError:      netErrCount > 0 ? Math.round(sumNetError / netErrCount * 100) / 100 : null,
      netAccuracyRate:  netErrCount > 0 ? Math.round(accurateCount / netErrCount * 100) / 100 : null,
      avgDaysError:     daysErrCount > 0 ? Math.round(sumDaysError / daysErrCount * 10) / 10 : null,
      avgRouteAccuracy: n > 0      ? Math.round(sumAccuracy / n * 100) / 100     : null,
      byCategory,
      dataQuality:      n >= 50 ? "RICH" : n >= 10 ? "MODERATE" : n >= 3 ? "SPARSE" : "INSUFFICIENT",
    };
  } catch { return null; }
}

/**
 * Get aggregate leverage metrics for all platforms in a single call.
 */
export async function getAllLeverageMetrics(redis) {
  if (!redis) return {};
  try {
    const { PLATFORMS } = await import("./platformIntelligence.js");
    const platformIds = Object.keys(PLATFORMS);
    const results = await Promise.all(
      platformIds.map(pid => getPlatformLeverageMetrics(redis, pid))
    );
    const out = {};
    platformIds.forEach((pid, i) => {
      if (results[i]) out[pid] = results[i];
    });
    return out;
  } catch { return {}; }
}

// ── Read outcome record ────────────────────────────────────────────────────────

export async function getRouteOutcome(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    const raw = await redis.get(KEY_OUTCOME(scanId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Aggregate ops and accuracy summary across all recorded outcomes.
 */
export async function getRouteOutcomeOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    const total      = ops["total_outcomes"] || 0;
    const followed   = ops["route_followed"] || 0;
    const notFollowed = ops["route_not_followed"] || 0;
    return {
      totalOutcomes:    total,
      routeFollowRate:  total > 0 ? Math.round(followed / total * 100) / 100 : null,
      routeNotFollowed: notFollowed,
      byCategory: Object.fromEntries(
        Object.entries(ops)
          .filter(([k]) => k.startsWith("category."))
          .map(([k, v]) => [k.replace("category.", ""), v])
      ),
    };
  } catch { return {}; }
}

// ── Route accuracy scoring ─────────────────────────────────────────────────────

function _computeRouteAccuracyScore({
  followedRoute,
  expectedNet,
  actualNet,
  expectedDays,
  actualDays,
}) {
  let score = 0.5;  // baseline: we made a recommendation

  // Platform accuracy
  if (followedRoute === true)  score += 0.20;   // user followed our recommendation
  if (followedRoute === false) score -= 0.05;   // user chose differently (may be fine)
  if (followedRoute === null)  score += 0.00;   // no recommendation was made

  // Net estimation accuracy
  if (expectedNet != null && actualNet != null && expectedNet > 0) {
    const errorPct = Math.abs(actualNet - expectedNet) / expectedNet;
    if (errorPct <= 0.05) score += 0.20;       // within 5% — excellent
    else if (errorPct <= 0.10) score += 0.12;  // within 10% — good
    else if (errorPct <= 0.20) score += 0.05;  // within 20% — acceptable
    else score -= 0.10;                         // >20% off — poor estimate
  }

  // Velocity accuracy
  if (expectedDays != null && actualDays != null) {
    const daysDelta = Math.abs(actualDays - expectedDays);
    if (daysDelta <= 2)  score += 0.10;   // within 2 days — excellent
    else if (daysDelta <= 5)  score += 0.05;
    else if (daysDelta <= 14) score += 0.00;
    else score -= 0.05;                   // off by >2 weeks
  }

  return Math.min(1, Math.max(0, Math.round(score * 100) / 100));
}
