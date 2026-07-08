// src/entitlementStore.js
// Phase B1: server-side entitlement source of truth.
//
// auth-users/*.json (on the Railway volume) is the durable source of truth
// for a user's plan. Redis is a short-TTL acceleration cache only — never
// the sole source. The authidx:{userId} Redis key is a best-effort lookup
// accelerator for readAuthUserById; on a miss we fall back to scanning
// AUTH_USERS_DIR, since auth-user files are keyed by sha256(email), not
// userId (see authUserFilePath in index.js), so userId -> file isn't a
// direct lookup without an index.

import fs from "fs/promises";
import path from "path";

const DEFAULT_AUTH_USERS_DIR = path.join(".", "storage", "auth-users");
const ENTITLEMENT_CACHE_TTL_SEC = 300;
const AUTH_INDEX_TTL_SEC = 30 * 86400;
const AUTH_INDEX_PREFIX = "authidx:";
const ENTITLEMENT_CACHE_PREFIX = "entitlement:";

const VALID_PLANS = new Set(["free", "hunter", "pro", "internal"]);

function normalizeIncomingPlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  return VALID_PLANS.has(p) ? p : "free";
}

// ── Directory scan fallback ────────────────────────────────────────────────
// O(n) in user count — acceptable at beta scale. Revisit if this becomes a
// hot path (e.g. maintain a durable userId->filename map on disk instead of
// only in Redis).
async function scanForUserFile(userId, authUsersDir) {
  let files;
  try {
    files = await fs.readdir(authUsersDir);
  } catch {
    return null;
  }

  for (const file of files) {
    if (!file.endsWith(".json") || file.includes(".tmp-")) continue;
    const filePath = path.join(authUsersDir, file);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const record = JSON.parse(raw);
      if (record?.userId === userId) return { filePath, record };
    } catch {
      // Corrupt or partially-written file — skip, don't crash the scan.
    }
  }
  return null;
}

/**
 * Find a user's auth-user record by backend userId.
 * Redis authidx is an accelerator only; always falls back to a directory
 * scan on a cache miss so a cold/unavailable Redis never makes a real user
 * unreachable.
 */
export async function readAuthUserById(userId, { redisClient = null, authUsersDir = DEFAULT_AUTH_USERS_DIR } = {}) {
  if (!userId) return null;

  if (redisClient) {
    try {
      const cachedPath = await redisClient.get(`${AUTH_INDEX_PREFIX}${userId}`);
      if (cachedPath) {
        try {
          const raw = await fs.readFile(cachedPath, "utf8");
          const record = JSON.parse(raw);
          if (record?.userId === userId) return { filePath: cachedPath, record };
        } catch {
          // Stale index entry (file moved/deleted) — fall through to scan.
        }
      }
    } catch {
      // Redis unavailable — fall through to scan.
    }
  }

  const found = await scanForUserFile(userId, authUsersDir);
  if (found && redisClient) {
    redisClient
      .set(`${AUTH_INDEX_PREFIX}${userId}`, found.filePath, "EX", AUTH_INDEX_TTL_SEC)
      .catch(() => {});
  }
  return found;
}

/**
 * Atomically update a user's plan on the durable auth-user record.
 * Last-write-wins by eventTsMs — an event older than what's already stored
 * is rejected so out-of-order webhook delivery can't downgrade a newer
 * state. Returns { ok:false, reason:"user_not_found" } rather than faking
 * a record — callers must not create entitlement state for an unmapped id.
 */
export async function writeAuthUserPlan(
  userId,
  { plan, planExpiresAt = null, source = null, eventTsMs = Date.now() },
  { redisClient = null, authUsersDir = DEFAULT_AUTH_USERS_DIR } = {}
) {
  const found = await readAuthUserById(userId, { redisClient, authUsersDir });
  if (!found) {
    return { ok: false, reason: "user_not_found" };
  }

  const { filePath, record } = found;

  const storedTs = Number(record.entitlementUpdatedAt || 0);
  if (eventTsMs && storedTs && eventTsMs < storedTs) {
    return { ok: false, reason: "stale_event", storedTs, eventTsMs };
  }

  const updated = {
    ...record,
    plan: normalizeIncomingPlan(plan),
    planExpiresAt: planExpiresAt ?? null,
    entitlementSource: source ?? null,
    entitlementUpdatedAt: eventTsMs,
  };

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);

  if (redisClient) {
    redisClient.del(`${ENTITLEMENT_CACHE_PREFIX}${userId}`).catch(() => {});
  }

  return { ok: true, plan: updated.plan };
}

/**
 * Resolve a user's live, trusted plan for request-time enforcement.
 * Returns null (not "free") on any lookup failure or unknown user, so the
 * caller can distinguish "no opinion, keep the JWT hint" from a confirmed
 * free plan.
 */
export async function resolveLivePlan(userId, redisClient, { authUsersDir = DEFAULT_AUTH_USERS_DIR } = {}) {
  if (!userId) return null;

  try {
    if (redisClient) {
      const cached = await redisClient.get(`${ENTITLEMENT_CACHE_PREFIX}${userId}`).catch(() => null);
      if (cached) {
        try {
          return JSON.parse(cached).plan || "free";
        } catch {
          // Corrupt cache entry — fall through to a real read.
        }
      }
    }

    const found = await readAuthUserById(userId, { redisClient, authUsersDir });
    if (!found) return null; // Unknown user — caller keeps the JWT claim.

    const { record } = found;
    let plan = normalizeIncomingPlan(record.plan);

    if (plan !== "free" && plan !== "internal" && record.planExpiresAt) {
      const expiresAt = new Date(record.planExpiresAt).getTime();
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        plan = "free";
      }
    }

    if (redisClient) {
      redisClient
        .set(`${ENTITLEMENT_CACHE_PREFIX}${userId}`, JSON.stringify({ plan }), "EX", ENTITLEMENT_CACHE_TTL_SEC)
        .catch(() => {});
    }

    return plan;
  } catch {
    return null; // Fail safe — caller falls back to the JWT claim.
  }
}

// Events that grant/renew an entitlement — map active entitlement ids to a plan.
const ENTITLEMENT_GRANTING_EVENTS = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "TRANSFER",
  "SUBSCRIPTION_EXTENDED",
]);

// EXPIRATION explicitly ends access now. CANCELLATION is intentionally NOT
// here — cancelling auto-renew does not revoke the period the user already
// paid for; access lapses naturally via planExpiresAt (set by the prior
// granting event) once the real EXPIRATION event fires or time passes.
const ENTITLEMENT_REVOKING_EVENTS = new Set(["EXPIRATION"]);

/**
 * Map a RevenueCat webhook event to a plan decision.
 * changed:false means "no entitlement decision to make" (e.g. CANCELLATION,
 * BILLING_ISSUE, unknown event types) — caller should log and no-op, not
 * write a plan.
 */
export function mapRevenueCatEventToPlan(event, { entitlementHunterId = "hunter", entitlementProId = "pro" } = {}) {
  const type = String(event?.type || "").toUpperCase();

  if (ENTITLEMENT_REVOKING_EVENTS.has(type)) {
    return { plan: "free", changed: true };
  }

  if (!ENTITLEMENT_GRANTING_EVENTS.has(type)) {
    return { plan: null, changed: false };
  }

  const rawIds = event?.entitlement_ids ?? (event?.entitlement_id ? [event.entitlement_id] : []);
  const activeSet = new Set((Array.isArray(rawIds) ? rawIds : [rawIds]).filter(Boolean));

  if (activeSet.has(entitlementProId)) return { plan: "pro", changed: true };
  if (activeSet.has(entitlementHunterId)) return { plan: "hunter", changed: true };
  return { plan: "free", changed: true };
}
