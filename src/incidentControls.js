// src/incidentControls.js
// Incident Controls — Phase 16: No-Decay System.
//
// Kill switches and emergency controls for every major system.
// All controls are:
//   - Redis-backed (no deploy required)
//   - TTL-bounded (auto-expire after 24h unless extended)
//   - Fully logged (every activation and clear is recorded)
//   - Reversible (clearControl / clearAllControls)
//
// Control types and Redis key pattern:
//   incident:cat_suppress:{category}     — suppress all positive signals for category
//   incident:signal_suppress:{signal}    — suppress a signal tier globally
//   incident:force_downgrade:{category}  — force all signals one tier down for category
//   incident:no_oracle:{category}        — disable oracle pricing for category
//   incident:no_affiliate:{category}     — disable affiliate attach for category
//   incident:no_b2b:{category}           — disable B2B valuation for category
//   incident:observe_only:{category}     — mark category observe-only (logs but won't cap)
//   incident:log                         — ZSET log of all incident events (90d TTL)

const PREFIX = "incident:";
const LOG_KEY = "incident:log";

const CONTROL_TYPES = {
  CAT_SUPPRESS:   "cat_suppress",
  SIGNAL_SUPPRESS:"signal_suppress",
  FORCE_DOWNGRADE:"force_downgrade",
  NO_ORACLE:      "no_oracle",
  NO_AFFILIATE:   "no_affiliate",
  NO_B2B:         "no_b2b",
  OBSERVE_ONLY:   "observe_only",
};
export { CONTROL_TYPES };

const DEFAULT_TTL    = 24  * 3600;   // 24h default — must be manually extended
const MAX_TTL        = 7   * 86400;  // hard cap: 7 days
const LOG_TTL        = 90  * 86400;  // 90d
const LOG_MAX        = 2000;

// ── Write controls ─────────────────────────────────────────────────────────────

/**
 * Suppress all positive signals for a category.
 * Use when a category is producing a cluster of wrong calls.
 */
export async function suppressCategory(redis, category, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.CAT_SUPPRESS, category, { reason, triggeredBy, ttlSeconds });
}

/**
 * Suppress a specific signal tier globally (e.g., "STRONG BUY").
 * Use when a signal tier has a system-wide accuracy collapse.
 */
export async function suppressSignalTier(redis, signal, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.SIGNAL_SUPPRESS, signal, { reason, triggeredBy, ttlSeconds });
}

/**
 * Force all signals for a category one tier down.
 * STRONG BUY → GOOD DEAL, GOOD DEAL → FAIR.
 */
export async function forceDowngrade(redis, category, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.FORCE_DOWNGRADE, category, { reason, triggeredBy, ttlSeconds });
}

/**
 * Disable oracle pricing for a category.
 * Use when AI-estimated prices are causing bad calls in a specific category.
 */
export async function disableOracle(redis, category, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.NO_ORACLE, category, { reason, triggeredBy, ttlSeconds });
}

/**
 * Disable affiliate link attachment for a category.
 * Use when category has replica-risk spike or trust collapse.
 */
export async function disableAffiliate(redis, category, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.NO_AFFILIATE, category, { reason, triggeredBy, ttlSeconds });
}

/**
 * Disable B2B valuation for a category.
 * Use when price index grade is degraded.
 */
export async function disableB2B(redis, category, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.NO_B2B, category, { reason, triggeredBy, ttlSeconds });
}

/**
 * Mark a category as observe-only.
 * Signals are computed normally but flagged for manual review.
 */
export async function markObserveOnly(redis, category, { reason, triggeredBy = "ops", ttlSeconds = DEFAULT_TTL } = {}) {
  return setControl(redis, CONTROL_TYPES.OBSERVE_ONLY, category, { reason, triggeredBy, ttlSeconds });
}

/**
 * Clear a specific control.
 */
export async function clearControl(redis, type, target, { reason, triggeredBy = "ops" } = {}) {
  if (!redis || !type || !target) return;
  const key = controlKey(type, target);
  try {
    await redis.del(key);
    await logEvent(redis, { action: "cleared", type, target, reason, triggeredBy });
    return { ok: true, key };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

/**
 * Clear ALL active incident controls (emergency reset).
 * Logs each cleared control.
 */
export async function clearAllControls(redis, { reason, triggeredBy = "ops" } = {}) {
  if (!redis) return { ok: false, error: "no_redis" };
  try {
    const keys = await redis.keys(`${PREFIX}*`).catch(() => []);
    const incidentKeys = keys.filter((k) => k !== LOG_KEY && !k.includes(":log"));
    for (const key of incidentKeys) {
      await redis.del(key).catch(() => {});
    }
    await logEvent(redis, { action: "cleared_all", count: incidentKeys.length, reason, triggeredBy });
    return { ok: true, cleared: incidentKeys.length, keys: incidentKeys };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

// ── Read controls ──────────────────────────────────────────────────────────────

/**
 * Check if a specific control is active.
 * Returns the control record or null.
 *
 * @param {object} redis
 * @param {string} type   — CONTROL_TYPES.*
 * @param {string} target — category or signal name
 */
export async function checkIncidentControl(redis, type, target) {
  if (!redis || !type || !target) return null;
  try {
    const raw = await redis.get(controlKey(type, target));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * Check multiple control types for a target in a single call.
 * Returns an object keyed by control type with the active record or null.
 *
 * @param {object} redis
 * @param {string} target  — category name
 * @returns {object}  { cat_suppress: null|record, force_downgrade: null|record, ... }
 */
export async function checkAllControlsForTarget(redis, target) {
  if (!redis || !target) return {};
  try {
    const types   = Object.values(CONTROL_TYPES);
    const results = await Promise.all(
      types.map((t) => redis.get(controlKey(t, target)).catch(() => null))
    );
    const out = {};
    types.forEach((t, i) => {
      out[t] = results[i]
        ? (() => { try { return JSON.parse(results[i]); } catch { return null; } })()
        : null;
    });
    return out;
  } catch { return {}; }
}

/**
 * Get all currently active incident controls.
 * Returns array of control records.
 */
export async function getActiveControls(redis) {
  if (!redis) return [];
  try {
    const keys = await redis.keys(`${PREFIX}*`).catch(() => []);
    const incidentKeys = keys.filter((k) => k !== LOG_KEY && !k.includes(":log"));
    const records = await Promise.all(
      incidentKeys.map((k) =>
        redis.get(k).then((v) => {
          if (!v) return null;
          try {
            const rec = JSON.parse(v);
            rec._key = k;
            return rec;
          } catch { return null; }
        }).catch(() => null)
      )
    );
    return records.filter(Boolean);
  } catch { return []; }
}

/**
 * Get the incident event log (most recent N entries).
 */
export async function getIncidentLog(redis, { limit = 50 } = {}) {
  if (!redis) return [];
  try {
    const raw = await redis.zrevrange(LOG_KEY, 0, limit - 1, "WITHSCORES");
    const items = [];
    for (let i = 0; i < raw.length; i += 2) {
      try { items.push(JSON.parse(raw[i])); } catch { /* skip malformed */ }
    }
    return items;
  } catch { return []; }
}

// ── Core helper ───────────────────────────────────────────────────────────────

async function setControl(redis, type, target, { reason, triggeredBy, ttlSeconds }) {
  if (!redis || !type || !target) return { ok: false, error: "missing_args" };

  const ttl     = Math.min(Number(ttlSeconds) || DEFAULT_TTL, MAX_TTL);
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  const record = {
    type,
    target:      String(target).toLowerCase().trim(),
    reason:      reason || "no reason provided",
    triggeredBy: triggeredBy || "ops",
    activatedAt: new Date().toISOString(),
    expiresAt,
    ttlSeconds:  ttl,
  };

  const key = controlKey(type, record.target);
  try {
    await redis.set(key, JSON.stringify(record), "EX", ttl);
    await logEvent(redis, { action: "activated", ...record });
    return { ok: true, key, record };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

function controlKey(type, target) {
  const t = String(target).toLowerCase().trim().replace(/\s+/g, "_");
  return `${PREFIX}${type}:${t}`;
}

async function logEvent(redis, event) {
  try {
    const entry = JSON.stringify({ ...event, loggedAt: new Date().toISOString() });
    await redis.zadd(LOG_KEY, Date.now(), entry);
    await redis.zremrangebyrank(LOG_KEY, 0, -(LOG_MAX + 1));
    await redis.expire(LOG_KEY, LOG_TTL);
  } catch { /* non-fatal */ }
}
