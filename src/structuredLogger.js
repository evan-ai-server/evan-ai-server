// src/structuredLogger.js
// Structured Logger — Phase 18: Production-grade event logging.
//
// All scan corrections, violations, affiliate decisions, and anomalies are
// emitted as JSON lines to stdout (grep-able in production) and optionally
// persisted to Redis lists for ops query via /api/ops/logs/:type.
//
// Event types:
//   truth_correction       — TruthGuard mutated a payload field
//   truth_violation        — TruthGuard detected a rule breach
//   consistency_violation  — ConsistencyGuard detected a cross-phase invariant breach
//   anomaly_detected       — AnomalyEngine found a system-level anomaly
//   affiliate_attached     — Affiliate links were attached to a scan response
//   affiliate_blocked      — Affiliate attachment was blocked (signal, trust, or replica)
//
// All entries include: { type, ts, ...eventData }

export const LOG_TYPES = {
  TRUTH_CORRECTION:      "truth_correction",
  TRUTH_VIOLATION:       "truth_violation",
  CONSISTENCY_VIOLATION: "consistency_violation",
  ANOMALY_DETECTED:      "anomaly_detected",
  AFFILIATE_ATTACHED:    "affiliate_attached",
  AFFILIATE_BLOCKED:     "affiliate_blocked",
};

const LOG_TTL    = 7 * 86400;  // 7 days
const LOG_MAX    = 2000;       // max entries per type

/**
 * Emit a structured log entry.
 * Writes JSON to stdout and optionally persists to Redis.
 *
 * @param {string} type    — one of LOG_TYPES.*
 * @param {object} data    — event-specific payload
 * @param {object} [redis] — optional Redis client for persistence
 */
export function logEvent(type, data, redis = null) {
  const entry = { type, ts: new Date().toISOString(), ...data };

  // Always emit JSON to stdout — grep-able in production log aggregators
  console.log(JSON.stringify(entry));

  // Persist to Redis if available
  if (redis) {
    const key = `log:${type}`;
    redis.lpush(key, JSON.stringify(entry)).catch(() => {});
    redis.ltrim(key, 0, LOG_MAX - 1).catch(() => {});
    redis.expire(key, LOG_TTL).catch(() => {});
  }
}

/**
 * Read recent log entries for a given type.
 * Returns array of parsed entries (newest first).
 *
 * @param {object} redis
 * @param {string} type
 * @param {number} [limit=50]
 * @returns {Promise<object[]>}
 */
export async function readLogEntries(redis, type, limit = 50) {
  if (!redis) return [];
  try {
    const raw = await redis.lrange(`log:${type}`, 0, limit - 1).catch(() => []);
    return raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
