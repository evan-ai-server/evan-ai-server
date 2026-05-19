// src/embeddedFailsafeEngine.js
// Phase 9 — Embedded Failsafe Engine.
//
// Handles stale cache, revoked, and expired trust gracefully.
// When a trust reference enters a degraded state the failsafe serves
// a controlled "DEGRADED" response instead of surfacing raw errors or
// exposing stale trust claims.
//
// Failsafe states:
//   STALE_CACHE      — cached data is older than the stale threshold
//   REVOKED          — reference was revoked (immediate hard stop)
//   EXPIRED          — reference passed its expiresAt date
//   SOURCE_UNAVAILABLE — Redis or upstream unavailable (circuit-open)
//   RATE_LIMITED     — partner exceeded rate limit
//
// Degradation modes:
//   SILENT_DEGRADE   — remove trust claims, show neutral state (no badge)
//   WARN_DEGRADE     — show badge with "verification pending" state
//   HARD_BLOCK       — replace with hard error (for REVOKED)
//
// Circuit breaker:
//   If source error rate exceeds CIRCUIT_THRESHOLD in the last window,
//   open the circuit and serve from stale cache or hard-degrade.
//
// Redis key layout:
//   p9:fs:circuit:{source}    STRING  circuit state (OPEN/CLOSED) + TTL
//   p9:fs:stale:{refId}       STRING  last known good payload (24h TTL)
//   p9:fs:ops                 HASH    counters

export const FAILSAFE_VERSION = "9.0";

export const FAILSAFE_STATE = {
  STALE_CACHE:        "STALE_CACHE",
  REVOKED:            "REVOKED",
  EXPIRED:            "EXPIRED",
  SOURCE_UNAVAILABLE: "SOURCE_UNAVAILABLE",
  RATE_LIMITED:       "RATE_LIMITED",
};

export const DEGRADATION_MODE = {
  SILENT_DEGRADE: "SILENT_DEGRADE",
  WARN_DEGRADE:   "WARN_DEGRADE",
  HARD_BLOCK:     "HARD_BLOCK",
};

const STALE_THRESHOLD_MS     = 10 * 60 * 1000;  // 10 min
const STALE_CACHE_TTL        = 24 * 3600;        // 24h
const CIRCUIT_OPEN_TTL       = 30;               // seconds
const CIRCUIT_THRESHOLD      = 5;                // errors before circuit opens

// ── Core failsafe check ───────────────────────────────────────────────────

/**
 * Check a trust payload for failsafe conditions.
 * Call this before returning any trust data to a partner embed.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceId   {string}
 *   payload       {object|null}  — current trust payload (may be null if fetch failed)
 *   cachedAt      {number|null}  — timestamp of cached data
 *   status        {string|null}  — REFERENCE_STATUS from externalTrustReferenceEngine
 *   fetchError    {string|null}  — error from upstream fetch (if any)
 * @returns {FailsafeResult}
 */
export async function checkFailsafe(redis, {
  referenceId,
  payload      = null,
  cachedAt     = null,
  status       = null,
  fetchError   = null,
} = {}) {
  if (!redis || !referenceId) {
    return _degradedResponse(FAILSAFE_STATE.SOURCE_UNAVAILABLE, DEGRADATION_MODE.WARN_DEGRADE, null);
  }

  // 1. Hard revocation check — always hard block
  if (status === "REVOKED") {
    await _incrOps(redis, "revoked_blocks");
    return _degradedResponse(FAILSAFE_STATE.REVOKED, DEGRADATION_MODE.HARD_BLOCK, null, {
      message: "This verification has been revoked and is no longer valid.",
    });
  }

  // 2. Expiry check
  if (status === "EXPIRED" || _isExpired(payload)) {
    await _incrOps(redis, "expired_serves");
    // Try stale cache
    const stale = await _getStaleCache(redis, referenceId);
    return _degradedResponse(FAILSAFE_STATE.EXPIRED, DEGRADATION_MODE.WARN_DEGRADE, stale, {
      message: "Verification expired — rescan required for current status.",
      expiredAt: payload?.expiresAt || null,
    });
  }

  // 3. Source unavailable — check circuit, serve stale
  if (fetchError || !payload) {
    await _recordCircuitError(redis, "trust_reference");
    const isOpen = await _isCircuitOpen(redis, "trust_reference");
    const stale  = await _getStaleCache(redis, referenceId);

    if (isOpen || !stale) {
      await _incrOps(redis, "source_unavailable_blocks");
      return _degradedResponse(FAILSAFE_STATE.SOURCE_UNAVAILABLE, DEGRADATION_MODE.WARN_DEGRADE, stale, {
        message: "Verification service temporarily unavailable — showing last known status.",
        fromStale: !!stale,
      });
    }

    // Circuit not open yet, serve stale
    await _incrOps(redis, "stale_serves");
    return _degradedResponse(FAILSAFE_STATE.STALE_CACHE, DEGRADATION_MODE.WARN_DEGRADE, stale, {
      message: "Showing cached verification — live data temporarily unavailable.",
      fromStale: true,
    });
  }

  // 4. Stale cache check
  if (cachedAt && (Date.now() - cachedAt) > STALE_THRESHOLD_MS) {
    // Save as new last-known-good before we degrade
    await _saveStaleCache(redis, referenceId, payload);
    // Still serve — just flag as stale
    await _incrOps(redis, "stale_flagged");
    return {
      ok:           true,
      pass:         true,
      failsafeState: FAILSAFE_STATE.STALE_CACHE,
      degraded:     false,
      staleFlag:    true,
      payload,
      message:      null,
    };
  }

  // 5. All clear — save as last-known-good and pass through
  await _saveStaleCache(redis, referenceId, payload);
  await _resetCircuit(redis, "trust_reference");

  return {
    ok:           true,
    pass:         true,
    failsafeState: null,
    degraded:     false,
    staleFlag:    false,
    payload,
    message:      null,
  };
}

/**
 * Mark a delivery as rate-limited (called by partner auth tier engine).
 */
export async function markRateLimited(redis, { referenceId, partnerId } = {}) {
  if (!redis) return;
  await _incrOps(redis, "rate_limited_blocks");
  return _degradedResponse(FAILSAFE_STATE.RATE_LIMITED, DEGRADATION_MODE.WARN_DEGRADE, null, {
    message: "Rate limit exceeded. Please retry after a short pause.",
    partnerId,
  });
}

/**
 * Get failsafe ops.
 */
export async function getFailsafeOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:fs:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      revokedBlocks:           ops["revoked_blocks"]            || 0,
      expiredServes:           ops["expired_serves"]            || 0,
      staleServes:             ops["stale_serves"]              || 0,
      staleFlagged:            ops["stale_flagged"]             || 0,
      sourceUnavailableBlocks: ops["source_unavailable_blocks"] || 0,
      rateLimitedBlocks:       ops["rate_limited_blocks"]       || 0,
    };
  } catch { return {}; }
}

// ── Circuit breaker ───────────────────────────────────────────────────────

async function _recordCircuitError(redis, source) {
  if (!redis) return;
  try {
    const count = await redis.incr(`p9:fs:circuit:errors:${source}`);
    await redis.expire(`p9:fs:circuit:errors:${source}`, 60);  // rolling 60s window
    if (Number(count) >= CIRCUIT_THRESHOLD) {
      await redis.set(`p9:fs:circuit:${source}`, "OPEN", "EX", CIRCUIT_OPEN_TTL);
    }
  } catch { /* non-critical */ }
}

async function _isCircuitOpen(redis, source) {
  if (!redis) return false;
  try {
    return (await redis.get(`p9:fs:circuit:${source}`)) === "OPEN";
  } catch { return false; }
}

async function _resetCircuit(redis, source) {
  if (!redis) return;
  try {
    await redis.del(`p9:fs:circuit:${source}`);
    await redis.del(`p9:fs:circuit:errors:${source}`);
  } catch { /* non-critical */ }
}

// ── Stale cache ───────────────────────────────────────────────────────────

async function _saveStaleCache(redis, referenceId, payload) {
  if (!redis || !payload) return;
  try {
    await redis.set(
      `p9:fs:stale:${_safe(referenceId)}`,
      JSON.stringify({ payload, savedAt: Date.now() }),
      { EX: STALE_CACHE_TTL }
    );
  } catch { /* non-critical */ }
}

async function _getStaleCache(redis, referenceId) {
  if (!redis) return null;
  try {
    const raw = await redis.get(`p9:fs:stale:${_safe(referenceId)}`);
    if (!raw) return null;
    const { payload } = JSON.parse(raw);
    return payload;
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _isExpired(payload) {
  if (!payload?.expiresAt) return false;
  return Date.now() > Number(payload.expiresAt);
}

function _degradedResponse(state, mode, stalPayload, extra = {}) {
  return {
    ok:           mode !== DEGRADATION_MODE.HARD_BLOCK,
    pass:         false,
    degraded:     true,
    failsafeState: state,
    degradationMode: mode,
    payload:      mode === DEGRADATION_MODE.HARD_BLOCK ? null : (stalPayload || null),
    fromStale:    !!stalPayload,
    failsafeVersion: FAILSAFE_VERSION,
    ...extra,
  };
}

async function _incrOps(redis, counter) {
  if (!redis) return;
  try { await redis.hIncrBy("p9:fs:ops", counter, 1); } catch { /* non-critical */ }
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
