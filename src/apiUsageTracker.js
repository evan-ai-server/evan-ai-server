// src/apiUsageTracker.js
// B2B API Key Management + Usage Tracking — Phase 12: Market Ownership / B2B Foundation.
//
// Manages lifecycle of B2B API keys (create, validate, revoke).
// Tracks per-key, per-day, per-endpoint usage counts.
// Enforces tier-based daily rate limits before each request.
//
// Tiers:
//   starter    — 100 valuations/day,  5 batch-valuate/day,  20 price-index/day
//   growth     — 1,000 valuations/day, 50 batch-valuate/day, 100 price-index/day
//   enterprise — 10,000 valuations/day, 500 batch-valuate/day, 500 price-index/day
//
// Redis keys:
//   b2b:key:{sha256(rawKey)}         STRING  JSON key record  (no TTL — permanent until revoked)
//   b2b:keyid:{keyId}                STRING  sha256 hash (for revocation by keyId)
//   b2b:keys                         ZSET    score=createdAt, member=keyId
//   b2b:usage:{keyId}:{YYYY-MM-DD}   HASH    field=endpoint, value=count  (TTL 35 days)
//
// Security: raw keys are never stored — only SHA-256 hash is kept in Redis.

import { createHash, randomBytes } from "crypto";

// ── Tier definitions ──────────────────────────────────────────────────────────

export const B2B_TIERS = {
  starter: {
    label:  "Starter",
    limits: { valuate: 100, batch_valuate: 5, price_index: 20 },
  },
  growth: {
    label:  "Growth",
    limits: { valuate: 1000, batch_valuate: 50, price_index: 100 },
  },
  enterprise: {
    label:  "Enterprise",
    limits: { valuate: 10000, batch_valuate: 500, price_index: 500 },
  },
};

// ── Redis key helpers ─────────────────────────────────────────────────────────

const KEY_RECORD  = (hash)         => `b2b:key:${hash}`;
const KEY_KEYID   = (keyId)        => `b2b:keyid:${keyId}`;
const KEY_INDEX   = ()             => `b2b:keys`;
const KEY_USAGE   = (keyId, day)   => `b2b:usage:${keyId}:${day}`;

const USAGE_TTL = 35 * 86400;   // usage logs retained 35 days

// ── Key management ────────────────────────────────────────────────────────────

/**
 * Create and store a new B2B API key.
 * The raw key is returned ONCE; only its SHA-256 hash is persisted.
 *
 * @param {object} redis
 * @param {{ orgId, orgName?, tier?, notes? }} opts
 * @returns {{ rawKey, keyId, tier, createdAt }}
 */
export async function createApiKey(redis, { orgId, orgName = "", tier = "starter", notes = "" } = {}) {
  if (!redis)  throw new Error("redis required");
  if (!orgId)  throw new Error("orgId required");
  if (!B2B_TIERS[tier]) throw new Error(`unknown tier: ${tier}. Valid: ${Object.keys(B2B_TIERS).join(", ")}`);

  const rawKey    = "evan_" + randomBytes(24).toString("hex");
  const keyHash   = sha256(rawKey);
  const keyId     = randomBytes(8).toString("hex");
  const createdAt = Date.now();

  const record = {
    keyId,
    keyHash,
    orgId:     String(orgId).slice(0, 128),
    orgName:   String(orgName).slice(0, 128),
    tier,
    active:    true,
    createdAt,
    notes:     String(notes).slice(0, 256),
  };

  await redis.set(KEY_RECORD(keyHash), JSON.stringify(record));
  await redis.set(KEY_KEYID(keyId), keyHash);
  await redis.zadd(KEY_INDEX(), createdAt, keyId);

  return { rawKey, keyId, tier, createdAt };
}

/**
 * Look up a B2B API key by its raw value.
 * Returns the key record, or null if not found or revoked.
 */
export async function lookupApiKey(redis, rawKey) {
  if (!redis || !rawKey) return null;
  try {
    const hash = sha256(String(rawKey).trim());
    const raw  = await redis.get(KEY_RECORD(hash));
    if (!raw) return null;
    const record = JSON.parse(raw);
    return record.active ? record : null;
  } catch { return null; }
}

/**
 * Revoke an API key by keyId.
 * Marks it inactive; usage history is retained for audit.
 */
export async function revokeApiKey(redis, keyId) {
  if (!redis || !keyId) throw new Error("keyId required");

  const hashKey = await redis.get(KEY_KEYID(keyId));
  if (!hashKey) throw new Error(`key not found: ${keyId}`);

  const raw = await redis.get(KEY_RECORD(hashKey));
  if (!raw) throw new Error("key record missing");

  const record     = JSON.parse(raw);
  record.active    = false;
  record.revokedAt = Date.now();
  await redis.set(KEY_RECORD(hashKey), JSON.stringify(record));

  return { ok: true, keyId, revokedAt: record.revokedAt };
}

/**
 * List all API keys (metadata only — no raw keys).
 * Sorted newest-first.
 */
export async function listApiKeys(redis, { limit = 100, includeRevoked = true } = {}) {
  if (!redis) return [];
  try {
    const keyIds  = await redis.zrevrange(KEY_INDEX(), 0, limit - 1);
    const records = await Promise.all(
      keyIds.map(async (keyId) => {
        try {
          const hash = await redis.get(KEY_KEYID(keyId));
          if (!hash) return null;
          const raw  = await redis.get(KEY_RECORD(hash));
          if (!raw) return null;
          const r = JSON.parse(raw);
          if (!includeRevoked && !r.active) return null;
          return {
            keyId:     r.keyId,
            orgId:     r.orgId,
            orgName:   r.orgName,
            tier:      r.tier,
            active:    r.active,
            createdAt: new Date(r.createdAt).toISOString(),
            revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
            notes:     r.notes,
          };
        } catch { return null; }
      })
    );
    return records.filter(Boolean);
  } catch { return []; }
}

// ── Usage tracking ────────────────────────────────────────────────────────────

/**
 * Check whether a key has remaining budget for an endpoint.
 * @param {object}  redis
 * @param {object}  keyRecord — from lookupApiKey
 * @param {string}  endpoint  — "valuate" | "batch_valuate" | "price_index"
 * @returns {{ allowed, used, limit, remaining, tier }}
 */
export async function checkUsageBudget(redis, keyRecord, endpoint) {
  if (!redis || !keyRecord) return { allowed: false, used: 0, limit: 0, remaining: 0 };

  const tier = B2B_TIERS[keyRecord.tier];
  if (!tier)  return { allowed: false, used: 0, limit: 0, remaining: 0, reason: "unknown_tier" };

  const limit = tier.limits[endpoint];
  if (limit == null) return { allowed: true, used: 0, limit: Infinity, remaining: Infinity };

  const usageKey = KEY_USAGE(keyRecord.keyId, utcDay());
  const used     = Number(await redis.hget(usageKey, endpoint).catch(() => 0)) || 0;
  const remaining = Math.max(0, limit - used);

  return { allowed: used < limit, used, limit, remaining, tier: keyRecord.tier };
}

/**
 * Increment the usage counter for an endpoint.
 * Call AFTER a successful response.
 */
export async function incrementUsage(redis, keyRecord, endpoint) {
  if (!redis || !keyRecord) return;
  try {
    const usageKey = KEY_USAGE(keyRecord.keyId, utcDay());
    await redis.hincrby(usageKey, endpoint, 1);
    await redis.expire(usageKey, USAGE_TTL);
  } catch { /* non-fatal */ }
}

/**
 * Get today's usage summary for a key, including remaining budget per endpoint.
 */
export async function getTodayUsage(redis, keyRecord) {
  if (!redis || !keyRecord) return {};
  try {
    const tier     = B2B_TIERS[keyRecord.tier] || {};
    const limits   = tier.limits || {};
    const usageKey = KEY_USAGE(keyRecord.keyId, utcDay());
    const counts   = await redis.hgetall(usageKey).catch(() => null) || {};
    return Object.fromEntries(
      Object.keys(limits).map((ep) => [
        ep,
        {
          used:      Number(counts[ep] || 0),
          limit:     limits[ep],
          remaining: Math.max(0, limits[ep] - Number(counts[ep] || 0)),
        },
      ])
    );
  } catch { return {}; }
}

/**
 * Get usage history for a key over the last N days (max 35).
 * Returns array of { date, counts: { endpoint: n }, total } sorted oldest-first.
 */
export async function getUsageHistory(redis, keyId, { days = 30 } = {}) {
  if (!redis || !keyId) return [];
  const results = [];
  const now     = new Date();
  for (let i = Math.min(days, 35) - 1; i >= 0; i--) {
    const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const day = d.toISOString().slice(0, 10);
    try {
      const counts = await redis.hgetall(KEY_USAGE(keyId, day));
      if (counts && Object.keys(counts).length > 0) {
        const parsed = Object.fromEntries(
          Object.entries(counts).map(([k, v]) => [k, Number(v)])
        );
        results.push({
          date:   day,
          counts: parsed,
          total:  Object.values(parsed).reduce((s, v) => s + v, 0),
        });
      }
    } catch { /* skip day on error */ }
  }
  return results;
}

/**
 * Get aggregate usage stats across all keys for ops inspection.
 * Returns { keyId, orgId, tier, today: { used, limit, remaining }, thirtyDayTotal }
 */
export async function getAggregateUsageStats(redis) {
  if (!redis) return [];
  const keys = await listApiKeys(redis, { limit: 200, includeRevoked: false });
  return Promise.all(
    keys.map(async (k) => {
      const todayKey = KEY_USAGE(k.keyId, utcDay());
      const counts   = await redis.hgetall(todayKey).catch(() => null) || {};
      const todayTotal = Object.values(counts).reduce((s, v) => s + Number(v), 0);
      return {
        keyId:         k.keyId,
        orgId:         k.orgId,
        orgName:       k.orgName,
        tier:          k.tier,
        todayTotal,
        createdAt:     k.createdAt,
      };
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256(str) {
  return createHash("sha256").update(str).digest("hex");
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}
