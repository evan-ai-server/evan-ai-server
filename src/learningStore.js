// src/learningStore.js
// Learning Store — Phase 19: Self-Learning Core.
//
// Persists per-scan learning data for:
//   - category performance tracking (correction rate, avg trust, signal distribution)
//   - adaptive threshold input
//   - self-healing trigger input
//   - future outcome correlation (hook-ready)
//
// Redis keys:
//   learn:scan_history          ZSET (score=timestamp) — recent scan records
//   metrics:category:{cat}:*    STRING counters per category
//   learn:healing_cycles        LIST — self-healing run history

const SCAN_HISTORY_KEY = "learn:scan_history";
const SCAN_HISTORY_TTL = 90 * 86400;   // 90 days
const SCAN_HISTORY_MAX = 10_000;
const CATEGORY_KEY_TTL = 90 * 86400;   // 90 days

/**
 * Canonical category key normalisation.
 * Shared by learningStore, anomalyEngine, adaptiveThresholds, truthGuardConfig, selfHealingWorker.
 * Rule: lowercase + trim + collapse internal whitespace to single space.
 * Spaces are preserved (not replaced with underscores) so Redis key reads and writes match.
 *
 * @param {string} category
 * @returns {string}
 */
export function normalizeCategory(category) {
  return String(category).toLowerCase().trim().replace(/\s{2,}/g, " ").slice(0, 40);
}

/**
 * Persist a scan's learning record.
 * Fire-and-forget — never throws, never blocks.
 *
 * @param {object} redis
 * @param {{ scanId, category, signal, trustScore, expectedProfit, corrected, corrections, latencyMs }} opts
 */
export function storeScanLearning(redis, {
  scanId, category, signal, trustScore, expectedProfit,
  corrected, corrections, latencyMs,
} = {}) {
  if (!redis) return;
  // Reject malformed / incomplete entries — partial scans pollute learning data
  if (!signal || typeof signal !== "string") return;
  if (trustScore == null || !Number.isFinite(trustScore)) return;
  try {
    // ScanId deduplication: skip if this exact scanId was already stored.
    // Uses a compact Redis SET with a short TTL to track recent scanIds.
    if (scanId) {
      const dedupKey = `learn:scan_seen:${scanId}`;
      redis.set(dedupKey, "1", "EX", 86400, "NX").then((res) => {
        if (res === null) return; // NX returned null → key existed → duplicate, skip
        const entry = JSON.stringify({
          scanId:         scanId,
          category:       category ? normalizeCategory(category) : null,
          signal:         signal,
          trustScore:     trustScore,
          expectedProfit: Number.isFinite(expectedProfit) ? expectedProfit : null,
          corrected:      corrected ?? false,
          corrections:    Array.isArray(corrections) ? corrections.slice(0, 20) : [],
          latencyMs:      Number.isFinite(latencyMs) ? latencyMs : null,
          ts:             new Date().toISOString(),
        });
        redis.zadd(SCAN_HISTORY_KEY, Date.now(), entry).catch(() => {});
        redis.zremrangebyrank(SCAN_HISTORY_KEY, 0, -(SCAN_HISTORY_MAX + 1)).catch(() => {});
        redis.expire(SCAN_HISTORY_KEY, SCAN_HISTORY_TTL).catch(() => {});
      }).catch(() => {});
      return;
    }
    // No scanId: write directly (can't dedup, but still validate above)
    const entry = JSON.stringify({
      scanId:         null,
      category:       category ? normalizeCategory(category) : null,
      signal:         signal,
      trustScore:     trustScore,
      expectedProfit: Number.isFinite(expectedProfit) ? expectedProfit : null,
      corrected:      corrected ?? false,
      corrections:    Array.isArray(corrections) ? corrections.slice(0, 20) : [],
      latencyMs:      Number.isFinite(latencyMs) ? latencyMs : null,
      ts:             new Date().toISOString(),
    });
    redis.zadd(SCAN_HISTORY_KEY, Date.now(), entry).catch(() => {});
    redis.zremrangebyrank(SCAN_HISTORY_KEY, 0, -(SCAN_HISTORY_MAX + 1)).catch(() => {});
    redis.expire(SCAN_HISTORY_KEY, SCAN_HISTORY_TTL).catch(() => {});
  } catch { /* non-fatal */ }
}

/**
 * Get per-category performance statistics.
 *
 * @param {object} redis
 * @param {string} category
 * @returns {Promise<object|null>}
 */
export async function getCategoryPerformance(redis, category) {
  if (!redis || !category) return null;
  const cat = normalizeCategory(category);
  try {
    const [totalStr, corrStr, trustSumStr, riskyStr, goodDealStr, sbStr, fairStr] = await Promise.all([
      redis.get(`metrics:category:${cat}:total_scans`).catch(() => null),
      redis.get(`metrics:category:${cat}:corrections`).catch(() => null),
      redis.get(`metrics:category:${cat}:trust_sum`).catch(() => null),
      redis.get(`metrics:category:${cat}:signal:risky`).catch(() => null),
      redis.get(`metrics:category:${cat}:signal:good_deal`).catch(() => null),
      redis.get(`metrics:category:${cat}:signal:strong_buy`).catch(() => null),
      redis.get(`metrics:category:${cat}:signal:fair`).catch(() => null),
    ]);
    const total = parseInt(totalStr || "0");
    if (total === 0) return null;
    const corrections = parseInt(corrStr    || "0");
    const trustSum    = parseFloat(trustSumStr || "0");
    return {
      category:         cat,
      totalScans:       total,
      correctionCount:  corrections,
      correctionRate:   corrections / total,
      avgTrust:         trustSum / total,
      signalDistribution: {
        "STRONG BUY":      parseInt(sbStr       || "0"),
        "GOOD DEAL":       parseInt(goodDealStr  || "0"),
        "FAIR":            parseInt(fairStr      || "0"),
        "RISKY":           parseInt(riskyStr     || "0"),
      },
    };
  } catch { return null; }
}

/**
 * Get top failing categories (highest correction rate, min scan threshold).
 *
 * @param {object} redis
 * @param {{ limit, minScans }} opts
 * @returns {Promise<object[]>}
 */
export async function getTopFailingCategories(redis, { limit = 10, minScans = 20 } = {}) {
  if (!redis) return [];
  try {
    const keys = await redis.keys("metrics:category:*:total_scans").catch(() => []);
    const results = [];
    for (const key of keys.slice(0, 100)) {
      const cat  = key.replace("metrics:category:", "").replace(":total_scans", "");
      const perf = await getCategoryPerformance(redis, cat);
      if (perf && perf.totalScans >= minScans) results.push(perf);
    }
    return results
      .sort((a, b) => b.correctionRate - a.correctionRate)
      .slice(0, limit);
  } catch { return []; }
}

/**
 * Get recent scan learning records.
 *
 * @param {object} redis
 * @param {{ limit }} opts
 * @returns {Promise<object[]>}
 */
export async function getRecentLearningScans(redis, { limit = 100 } = {}) {
  if (!redis) return [];
  try {
    const raw = await redis.zrevrange(SCAN_HISTORY_KEY, 0, limit - 1).catch(() => []);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Future hook: record user feedback on a scan outcome.
 * Stub in Phase 19 — real implementation connects to outcome engine.
 *
 * @param {object} redis
 * @param {{ scanId, userId, outcome, notes }} opts
 */
export async function recordUserFeedback(redis, { scanId, userId, outcome, notes } = {}) {
  if (!redis || !scanId) return;
  try {
    const entry = JSON.stringify({ scanId, userId: userId || null, outcome, notes: notes || null, ts: new Date().toISOString() });
    redis.lpush("learn:user_feedback", entry).catch(() => {});
    redis.ltrim("learn:user_feedback", 0, 4999).catch(() => {});
    redis.expire("learn:user_feedback", 90 * 86400).catch(() => {});
  } catch { /* non-fatal */ }
}

/**
 * Future hook: record price tracking observation for an item.
 * Stub in Phase 19 — real implementation tracks price over time.
 *
 * @param {object} redis
 * @param {{ scanId, category, observedPrice, observedAt }} opts
 */
export async function recordPriceObservation(redis, { scanId, category, observedPrice, observedAt } = {}) {
  if (!redis || !scanId) return;
  try {
    const entry = JSON.stringify({ scanId, category: category || null, observedPrice, observedAt: observedAt || new Date().toISOString() });
    redis.lpush("learn:price_observations", entry).catch(() => {});
    redis.ltrim("learn:price_observations", 0, 9999).catch(() => {});
    redis.expire("learn:price_observations", 90 * 86400).catch(() => {});
  } catch { /* non-fatal */ }
}
