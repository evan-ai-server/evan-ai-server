// src/priceIndexEngine.js
// Category Price Index Engine — Phase 12: Market Ownership / B2B Foundation.
//
// Builds and maintains per-category price indexes from Evan's accumulated market data.
// Each successful consumer scan feeds the index; the B2B valuation API reads from it.
//
// Index grades (based on sample depth):
//   A — ≥ 100 price samples, calibrated signals
//   B — ≥ 30 samples
//   C — ≥ 10 samples, limited confidence
//   INSUFFICIENT — < 10 samples (not enterprise-ready, returns failure reason)
//
// Redis keys:
//   price_idx_samples:{category}   ZSET   score=timestamp, member=JSON{median,p25,p75,count}
//   price_idx_cache:{category}     STRING  computed index JSON (1h TTL)
//
// Retention: 90 days of price samples, newest 500 per category.

import { getCategoryCalibration }  from "./signalCalibrator.js";
import { assessCalibrationHealth } from "./calibrationCurveEngine.js";

const SAMPLE_TTL   = 90 * 86400;    // 90d
const CACHE_TTL    = 3600;           // 1h computed index cache
const MAX_SAMPLES  = 500;

const GRADE_A_MIN  = 100;
const GRADE_B_MIN  = 30;
const GRADE_C_MIN  = 10;

const KEY_SAMPLES = (cat) => `price_idx_samples:${normalizeCat(cat)}`;
const KEY_CACHE   = (cat) => `price_idx_cache:${normalizeCat(cat)}`;

// ── Recording ─────────────────────────────────────────────────────────────────

/**
 * Record a price snapshot from a consumer scan into the category index.
 * Called after assembleProfitIntel produces a priceStats with a valid median.
 *
 * @param {object} redis
 * @param {string} category
 * @param {{ median, min, max, count, priceQualityScore }} priceStats — from assembleProfitIntel
 */
export async function recordPriceIndexSample(redis, category, priceStats) {
  if (!redis || !category) return;
  const median = priceStats?.median;
  if (!median || median <= 0) return;

  const key   = KEY_SAMPLES(category);
  const entry = JSON.stringify({
    median,
    p25:   priceStats?.min  ?? null,   // approximation; full quartile from distribution
    p75:   priceStats?.max  ?? null,
    count: priceStats?.count ?? 0,
    pqs:   priceStats?.priceQualityScore ?? 0,
  });

  try {
    await redis.zadd(key, Date.now(), entry);
    await redis.expire(key, SAMPLE_TTL);
    await redis.zremrangebyrank(key, 0, -(MAX_SAMPLES + 1));
  } catch { /* non-fatal */ }
}

// ── Index Computation ─────────────────────────────────────────────────────────

/**
 * Compute the price index for a category from stored samples.
 * Returns an object with grade, distribution stats, and calibration quality.
 * Returns INSUFFICIENT index when samples < GRADE_C_MIN.
 */
export async function computePriceIndex(redis, category, { userId = null } = {}) {
  if (!redis || !category) return null;

  const cutoff = Date.now() - SAMPLE_TTL * 1000;
  let samples  = [];
  try {
    const raw = await redis.zrangebyscore(KEY_SAMPLES(category), cutoff, "+inf");
    samples = raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { /* non-fatal */ }

  const sampleCount = samples.length;

  if (sampleCount < GRADE_C_MIN) {
    return {
      category,
      indexGrade:      "INSUFFICIENT",
      sampleCount,
      medianPrice:     null,
      p25:             null,
      p75:             null,
      priceRange:      null,
      spread:          null,
      avgPriceQuality: null,
      calibration:     null,
      lastUpdated:     new Date().toISOString(),
      _reason:         `${sampleCount} price samples (minimum ${GRADE_C_MIN} required)`,
    };
  }

  // Compute distribution across all stored medians (each scan contributes one median)
  const medians = samples.map((s) => s.median).filter((v) => v > 0).sort((a, b) => a - b);

  const medianPrice = quantile(medians, 0.50);
  const p25         = quantile(medians, 0.25);
  const p75         = quantile(medians, 0.75);
  const spread      = medianPrice > 0 ? round2((p75 - p25) / medianPrice) : null;
  const priceRange  = { min: round2(medians[0]), max: round2(medians[medians.length - 1]) };

  const avgPqs = samples.length
    ? round2(samples.reduce((s, x) => s + (x.pqs || 0), 0) / samples.length)
    : null;

  // Calibration quality (win rates, suppression state)
  let calibration = null;
  try {
    const [calData, health] = await Promise.all([
      getCategoryCalibration(redis, userId || "_global", category).catch(() => null),
      assessCalibrationHealth(redis, category).catch(() => null),
    ]);
    if (calData) {
      calibration = {
        sbWinRate:    calData.sbWinRate    ?? null,
        gdWinRate:    calData.gdWinRate    ?? null,
        isCalibrated: calData.isCalibrated ?? false,
        health:       health               ?? null,
        calSamples:   calData.totalSamples ?? null,
      };
    }
  } catch { /* calibration unavailable — proceed without it */ }

  const grade = sampleCount >= GRADE_A_MIN ? "A"
    : sampleCount >= GRADE_B_MIN ? "B"
    : "C";

  return {
    category,
    indexGrade:      grade,
    sampleCount,
    medianPrice:     round2(medianPrice),
    p25:             round2(p25),
    p75:             round2(p75),
    priceRange,
    spread,
    avgPriceQuality: avgPqs,
    calibration,
    lastUpdated:     new Date().toISOString(),
  };
}

/**
 * Get the cached price index for a category, recomputing if stale.
 * Pass force: true to bypass cache.
 */
export async function getCategoryPriceIndex(redis, category, { force = false } = {}) {
  if (!redis || !category) return null;
  const cacheKey = KEY_CACHE(category);

  if (!force) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* fall through */ }
  }

  const index = await computePriceIndex(redis, category);
  if (index) {
    redis.set(cacheKey, JSON.stringify(index), "EX", CACHE_TTL).catch(() => {});
  }
  return index;
}

/**
 * Bust the cached index for a category (call after seeding or manual update).
 */
export async function invalidatePriceIndexCache(redis, category) {
  if (!redis || !category) return;
  await redis.del(KEY_CACHE(category)).catch(() => {});
}

// ── Eligibility ───────────────────────────────────────────────────────────────

/**
 * Determine if a category is enterprise-ready for B2B valuation.
 * @param {object|null} priceIndex — from getCategoryPriceIndex
 * @returns {{ ready: boolean, grade: string, reason: string|null }}
 */
export function assessValuationEligibility(priceIndex) {
  if (!priceIndex) {
    return { ready: false, grade: "INSUFFICIENT", reason: "no_price_data" };
  }
  if (priceIndex.indexGrade === "INSUFFICIENT") {
    return {
      ready:  false,
      grade:  "INSUFFICIENT",
      reason: priceIndex._reason || "insufficient_samples",
    };
  }
  return {
    ready:  true,
    grade:  priceIndex.indexGrade,
    reason: priceIndex.indexGrade === "C" ? "limited_sample_depth" : null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}

function round2(v) {
  return v != null ? Math.round(Number(v) * 100) / 100 : null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const idx = q * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export { GRADE_A_MIN, GRADE_B_MIN, GRADE_C_MIN };
