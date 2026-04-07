// src/partnerSandboxEngine.js
// Phase 8 — Partner Sandbox Engine.
//
// Provides a safe, rate-limited, field-filtered sandbox environment for
// partner API key management and request validation.
//
// Responsibilities:
//   - API key issuance and rotation (per partner type + tier)
//   - Per-key rate limiting (requests/hour, requests/day)
//   - Sandbox vs live environment routing
//   - Field-level payload filtering before any partner response
//   - Request logging for audit + abuse detection
//   - Quota enforcement and usage reporting
//
// API key format: evan_pk_{env}_{tier}_{hex12}
//   env:  "sbx" (sandbox) | "live" (production)
//   tier: "free" | "pro" | "enterprise"
//
// Redis key layout:
//   pk:key:{keyId}          HASH   key record (status, partnerId, tier, env, etc.)
//   pk:partner:{partnerId}  SET    keyIds for partner
//   pk:rate:{keyId}:h       STRING hourly request count (TTL: 3600)
//   pk:rate:{keyId}:d       STRING daily request count (TTL: 86400)
//   pk:log:{keyId}          ZSET   recent request log by timestamp (90d TTL)
//   pk:revoked              ZSET   revoked keyIds by timestamp
//   pk:ops                  HASH   aggregate ops counters

import crypto from "crypto";
import { filterPayloadForPartner } from "./partnerAccessEngine.js";

export const SANDBOX_VERSION = "8.0";

// ── Rate limits by tier ───────────────────────────────────────────────────────

const RATE_LIMITS = {
  free:       { perHour: 60,   perDay: 500   },
  pro:        { perHour: 600,  perDay: 10000 },
  enterprise: { perHour: 6000, perDay: 100000 },
};

// ── Partner types (aligned with partnerAccessEngine PARTNER_TYPE) ─────────────

export const SANDBOX_PARTNER_TYPE = {
  MARKETPLACE:    "marketplace",
  CONSIGNMENT:    "consignment",
  INSURANCE:      "insurance",
  LENDER:         "lender",
  RETAILER:       "retailer",
  RESALE_APP:     "resale_app",
  DATA_PARTNER:   "data_partner",
};

// ── API key management ────────────────────────────────────────────────────────

/**
 * Issue a new partner API key.
 *
 * @param {object} redis
 * @param {object} opts
 *   partnerId   {string}
 *   partnerType {string}  — SANDBOX_PARTNER_TYPE.*
 *   tier        {string}  — "free"|"pro"|"enterprise"
 *   env         {string}  — "sbx"|"live"
 *   label       {string|null}  — human label for this key
 * @returns {{ ok, keyId, apiKey, tier, env, rateLimits }}
 */
export async function issuePartnerApiKey(redis, {
  partnerId,
  partnerType = SANDBOX_PARTNER_TYPE.MARKETPLACE,
  tier        = "free",
  env         = "sbx",
  label       = null,
} = {}) {
  if (!redis || !partnerId) return { ok: false, error: "missing_required" };

  const safeTier = RATE_LIMITS[tier] ? tier : "free";
  const safeEnv  = env === "live" ? "live" : "sbx";
  const hex      = crypto.randomBytes(12).toString("hex");
  const keyId    = `pk_${safeEnv}_${safeTier}_${hex}`;
  const apiKey   = `evan_pk_${safeEnv}_${safeTier}_${hex}`;
  const now      = Date.now();

  try {
    await redis.hSet(`pk:key:${keyId}`, {
      keyId,
      apiKey:       _hashKey(apiKey),  // store hash, never plaintext
      partnerId,
      partnerType,
      tier:         safeTier,
      env:          safeEnv,
      label:        label || "",
      status:       "ACTIVE",
      issuedAt:     now,
      lastUsedAt:   0,
      requestCount: 0,
    });

    await redis.sAdd(`pk:partner:${_safe(partnerId)}`, keyId);
    await redis.hIncrBy("pk:ops", "keys_issued", 1);
    await redis.hIncrBy("pk:ops", `tier.${safeTier}`, 1);

    return {
      ok:         true,
      keyId,
      apiKey,     // returned once — never stored in plaintext
      tier:       safeTier,
      env:        safeEnv,
      rateLimits: RATE_LIMITS[safeTier],
      warning:    "Store this API key securely — it will not be shown again.",
    };
  } catch (err) {
    return { ok: false, error: "issue_failed", reason: err?.message };
  }
}

/**
 * Validate a partner API key and check rate limits.
 * Returns enriched request context if allowed.
 *
 * @param {object} redis
 * @param {string} apiKey  — raw key from Authorization header
 * @returns {{ ok, allowed, keyId, partnerId, partnerType, tier, env, remaining }}
 */
export async function validateApiKey(redis, apiKey) {
  if (!redis || !apiKey) return { ok: false, allowed: false, reason: "missing_key" };

  // Keys are stored by hash — must scan for matching hash
  // In production this would use a lookup index; here we use hash prefix
  const keyHash = _hashKey(apiKey);

  // Extract keyId from the key itself (format: evan_pk_{env}_{tier}_{hex})
  const match = apiKey.match(/^evan_pk_(sbx|live)_(free|pro|enterprise)_([0-9a-f]{24})$/);
  if (!match) return { ok: false, allowed: false, reason: "invalid_format" };

  const keyId = `pk_${match[1]}_${match[2]}_${match[3]}`;

  try {
    const record = await redis.hGetAll(`pk:key:${keyId}`);
    if (!record || !record.keyId) return { ok: false, allowed: false, reason: "key_not_found" };
    if (record.status !== "ACTIVE")  return { ok: false, allowed: false, reason: "key_inactive" };

    // Verify hash
    if (record.apiKey !== keyHash) return { ok: false, allowed: false, reason: "key_mismatch" };

    // Check if revoked
    const revoked = await redis.zScore("pk:revoked", keyId);
    if (revoked !== null) return { ok: false, allowed: false, reason: "key_revoked" };

    // Rate limit check
    const limits = RATE_LIMITS[record.tier] || RATE_LIMITS.free;
    const now    = Date.now();

    const [hourlyCount, dailyCount] = await Promise.all([
      redis.get(`pk:rate:${keyId}:h`).then(v => Number(v) || 0),
      redis.get(`pk:rate:${keyId}:d`).then(v => Number(v) || 0),
    ]);

    if (hourlyCount >= limits.perHour) {
      return { ok: false, allowed: false, reason: "rate_limit_hourly", retryAfter: 3600, keyId };
    }
    if (dailyCount >= limits.perDay) {
      return { ok: false, allowed: false, reason: "rate_limit_daily", retryAfter: 86400, keyId };
    }

    // Increment counters
    const pipeline = redis.multi();
    pipeline.incrBy(`pk:rate:${keyId}:h`, 1);
    pipeline.expire(`pk:rate:${keyId}:h`, 3600);
    pipeline.incrBy(`pk:rate:${keyId}:d`, 1);
    pipeline.expire(`pk:rate:${keyId}:d`, 86400);
    pipeline.hSet(`pk:key:${keyId}`, { lastUsedAt: now });
    pipeline.hIncrBy(`pk:key:${keyId}`, "requestCount", 1);
    pipeline.hIncrBy("pk:ops", "total_requests", 1);
    pipeline.hIncrBy("pk:ops", `env.${record.env}`, 1);
    await pipeline.exec();

    // Log request
    await _logRequest(redis, keyId, now);

    return {
      ok:          true,
      allowed:     true,
      keyId,
      partnerId:   record.partnerId,
      partnerType: record.partnerType,
      tier:        record.tier,
      env:         record.env,
      remaining: {
        hourly: limits.perHour - hourlyCount - 1,
        daily:  limits.perDay  - dailyCount  - 1,
      },
    };
  } catch (err) {
    return { ok: false, allowed: false, reason: "validation_error", message: err?.message };
  }
}

/**
 * Rotate (revoke + reissue) a partner API key.
 */
export async function rotatePartnerApiKey(redis, { keyId, partnerId } = {}) {
  if (!redis || !keyId) return { ok: false, error: "missing_required" };

  try {
    const record = await redis.hGetAll(`pk:key:${keyId}`);
    if (!record || record.partnerId !== partnerId) {
      return { ok: false, error: "key_not_found_or_mismatch" };
    }

    // Revoke old key
    await redis.zAdd("pk:revoked", [{ score: Date.now(), value: keyId }]);
    await redis.hSet(`pk:key:${keyId}`, { status: "REVOKED", revokedAt: Date.now() });

    // Issue new key
    const newKey = await issuePartnerApiKey(redis, {
      partnerId:   record.partnerId,
      partnerType: record.partnerType,
      tier:        record.tier,
      env:         record.env,
      label:       record.label ? `${record.label} (rotated)` : null,
    });

    return { ok: true, revokedKeyId: keyId, newKey };
  } catch (err) {
    return { ok: false, error: "rotate_failed", reason: err?.message };
  }
}

/**
 * Revoke a partner API key immediately.
 */
export async function revokePartnerApiKey(redis, { keyId, partnerId, reason = "" } = {}) {
  if (!redis || !keyId) return { ok: false, error: "missing_required" };

  try {
    const record = await redis.hGetAll(`pk:key:${keyId}`);
    if (!record || record.partnerId !== partnerId) {
      return { ok: false, error: "key_not_found_or_mismatch" };
    }

    await redis.zAdd("pk:revoked", [{ score: Date.now(), value: keyId }]);
    await redis.hSet(`pk:key:${keyId}`, { status: "REVOKED", revokedAt: Date.now(), revokedReason: reason });
    await redis.hIncrBy("pk:ops", "keys_revoked", 1);

    return { ok: true, keyId, revokedAt: Date.now() };
  } catch (err) {
    return { ok: false, error: "revoke_failed", reason: err?.message };
  }
}

// ── Filtered sandbox response ─────────────────────────────────────────────────

/**
 * Filter a partner API response payload for safe external delivery.
 * Applies partnerAccessEngine field-level access control.
 * In sandbox mode, strips live data and substitutes mock signals.
 *
 * @param {object} payload      — raw internal payload
 * @param {string} partnerType  — SANDBOX_PARTNER_TYPE.*
 * @param {string} env          — "sbx"|"live"
 * @returns {object}            — filtered payload safe for delivery
 */
export function buildSandboxResponse(payload, partnerType, env = "sbx") {
  if (!payload || typeof payload !== "object") return {};

  // Apply field-level filtering
  const filtered = filterPayloadForPartner(payload, partnerType);

  // In sandbox, replace any live identifiers with mock values
  if (env === "sbx") {
    return _applySandboxMasking(filtered);
  }

  return filtered;
}

// ── Partner key usage report ─────────────────────────────────────────────────

/**
 * Get usage report for a partner's keys.
 */
export async function getPartnerKeyUsage(redis, partnerId) {
  if (!redis || !partnerId) return null;

  try {
    const keyIds = await redis.sMembers(`pk:partner:${_safe(partnerId)}`);
    const keys   = [];

    for (const keyId of keyIds) {
      const record = await redis.hGetAll(`pk:key:${keyId}`);
      if (!record || !record.keyId) continue;

      const [hourly, daily] = await Promise.all([
        redis.get(`pk:rate:${keyId}:h`).then(v => Number(v) || 0),
        redis.get(`pk:rate:${keyId}:d`).then(v => Number(v) || 0),
      ]);

      const limits = RATE_LIMITS[record.tier] || RATE_LIMITS.free;

      keys.push({
        keyId:         record.keyId,
        label:         record.label || null,
        tier:          record.tier,
        env:           record.env,
        status:        record.status,
        issuedAt:      Number(record.issuedAt) || 0,
        lastUsedAt:    Number(record.lastUsedAt) || 0,
        totalRequests: Number(record.requestCount) || 0,
        currentUsage: {
          hourly,
          daily,
          hourlyLimit: limits.perHour,
          dailyLimit:  limits.perDay,
        },
      });
    }

    return { partnerId, keys };
  } catch { return null; }
}

/**
 * Get global sandbox ops summary.
 */
export async function getSandboxOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("pk:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      keysIssued:     ops["keys_issued"]    || 0,
      keysRevoked:    ops["keys_revoked"]   || 0,
      totalRequests:  ops["total_requests"] || 0,
      sandboxRequests:ops["env.sbx"]        || 0,
      liveRequests:   ops["env.live"]       || 0,
      byTier: {
        free:       ops["tier.free"]       || 0,
        pro:        ops["tier.pro"]        || 0,
        enterprise: ops["tier.enterprise"] || 0,
      },
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _hashKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

async function _logRequest(redis, keyId, timestamp) {
  try {
    const logKey = `pk:log:${keyId}`;
    await redis.zAdd(logKey, [{ score: timestamp, value: `req_${timestamp}` }]);
    // Keep last 1000 requests
    await redis.zRemRangeByRank(logKey, 0, -1001);
    await redis.expire(logKey, 90 * 86400);
  } catch { /* non-critical */ }
}

function _applySandboxMasking(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const mask = (obj) => {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k.toLowerCase().includes("userid") || k.toLowerCase() === "userid") {
        result[k] = "sbx_user_xxxx";
      } else if (k === "referenceId" && typeof v === "string") {
        result[k] = v.replace(/^evr_/, "sbx_");
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        result[k] = mask(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  };

  return { ...mask(payload), _sandbox: true, _sandboxNote: "Sandbox response — data is masked for testing." };
}
