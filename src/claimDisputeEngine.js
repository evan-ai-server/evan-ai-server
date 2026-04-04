// src/claimDisputeEngine.js
// Phase 5 — Claim & Dispute Foundation.
//
// Backend infrastructure for the Evan protection product.
// When a buyer followed Evan's signal under a guaranteed item and suffered a
// loss (e.g., item turned out to be counterfeit), they can file a claim against
// the guarantee policy issued at time of purchase.
//
// Claim lifecycle:
//   OPEN → UNDER_REVIEW → APPROVED | DENIED | PARTIALLY_APPROVED
//
// Non-negotiable:
//   1. A claim requires a valid, ACTIVE policy at time of creation.
//   2. The claim window (from policy issuedAt) must not be exceeded.
//   3. The policy snapshot at claim creation is frozen — it cannot change retroactively.
//   4. Payout ≤ policy.coverageAmount — no over-payment.
//   5. Approved claim marks the policy as CLAIMED — no second claim on same policy.
//
// Redis key layout:
//   claim:record:{claimId}    STRING  claim record (5yr TTL)
//   claim:policy:{policyId}   SET     claimIds for this policy (5yr TTL)
//   claim:user:{userId}       ZSET    claimIds by createdAt (max 500, 5yr)
//   claim:open                ZSET    open claimIds by priority/createdAt (no TTL)
//   claim:ops                 HASH    ops counters

import crypto from "crypto";
import { getGuaranteePolicy, markPolicyClaimed, POLICY_STATUS } from "./guaranteeEngine.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CLAIM_STATUS = {
  OPEN:                "OPEN",
  UNDER_REVIEW:        "UNDER_REVIEW",
  APPROVED:            "APPROVED",
  DENIED:              "DENIED",
  PARTIALLY_APPROVED:  "PARTIALLY_APPROVED",
};

const TERMINAL_STATUSES = new Set(["APPROVED", "DENIED", "PARTIALLY_APPROVED"]);
const VALID_TRANSITIONS = {
  OPEN:         new Set(["UNDER_REVIEW", "DENIED"]),
  UNDER_REVIEW: new Set(["APPROVED", "DENIED", "PARTIALLY_APPROVED"]),
};

const CLAIM_TTL     = 5 * 365 * 86400;   // 5 years
const USER_TTL      = 5 * 365 * 86400;
const MAX_PER_USER  = 500;

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_CLAIM  = id       => `claim:record:${id}`;
const KEY_POLICY = policyId => `claim:policy:${policyId}`;
const KEY_USER   = userId   => `claim:user:${userId}`;
const KEY_OPEN   = ()       => `claim:open`;
const KEY_OPS    = ()       => `claim:ops`;

// ── Create claim ──────────────────────────────────────────────────────────────

/**
 * Create a new claim against a guarantee policy.
 *
 * @param {object} redis
 * @param {object} opts
 *   policyId         {string}
 *   userId           {string}    — must match policy.userId
 *   reason           {string}    — user-provided reason for the claim
 *   claimType        {string}    — "counterfeit" | "not_as_described" | "other"
 *   evidenceMetadata {object[]}  — attachment descriptors (not actual files)
 *   requestedPayout  {number|null} — buyer's requested amount (capped by policy)
 * @returns {Promise<{ ok, claimId?, claim?, error? }>}
 */
export async function createClaim(redis, {
  policyId,
  userId,
  reason           = "",
  claimType        = "other",
  evidenceMetadata = [],
  requestedPayout  = null,
} = {}) {
  if (!redis || !policyId || !userId) {
    return { ok: false, error: "missing_required" };
  }
  if (!reason?.trim()) {
    return { ok: false, error: "reason_required" };
  }

  // Fetch and validate policy
  const policy = await getGuaranteePolicy(redis, policyId);
  if (!policy) return { ok: false, error: "policy_not_found" };
  if (policy.userId !== userId) return { ok: false, error: "policy_user_mismatch" };

  if (policy.status === POLICY_STATUS.REVOKED) {
    return { ok: false, error: "policy_revoked", policyStatus: policy.status };
  }
  if (policy.status === POLICY_STATUS.EXPIRED) {
    return { ok: false, error: "policy_expired", expiredAt: policy.expiresAt };
  }
  if (policy.status === POLICY_STATUS.CLAIMED) {
    return { ok: false, error: "policy_already_claimed", linkedClaimId: policy.linkedClaimId };
  }

  // Check claim window
  const claimDeadline = policy.issuedAt + policy.claimWindowDays * 86400000;
  if (Date.now() > claimDeadline) {
    return {
      ok: false,
      error: "claim_window_expired",
      claimDeadline,
      windowDays: policy.claimWindowDays,
    };
  }

  // Cap requested payout to policy coverage
  const cappedPayout = requestedPayout != null
    ? Math.min(Math.max(0, requestedPayout), policy.coverageAmount)
    : policy.coverageAmount;

  try {
    const claimId = "clm_" + crypto.randomBytes(8).toString("hex");
    const now     = Date.now();

    const claim = {
      claimId,
      policyId,
      scanId:          policy.scanId,
      userId,
      category:        policy.category,
      claimType:       _sanitizeClaimType(claimType),
      reason:          reason.trim().slice(0, 2000),
      status:          CLAIM_STATUS.OPEN,
      reviewerNotes:   null,
      evidenceMetadata: (Array.isArray(evidenceMetadata) ? evidenceMetadata : []).slice(0, 20),
      requestedPayout: cappedPayout,
      approvedPayout:  null,
      resolutionReason:null,
      createdAt:       now,
      updatedAt:       now,
      resolvedAt:      null,
      statusHistory:   [{ status: CLAIM_STATUS.OPEN, at: now, by: "user" }],
      // Frozen policy snapshot at claim creation time
      policySnapshot: {
        policyId:        policy.policyId,
        coverageAmount:  policy.coverageAmount,
        riskTier:        policy.riskTier,
        issuedAt:        policy.issuedAt,
        expiresAt:       policy.expiresAt,
        verificationSnapshot: policy.verificationSnapshot,
        authEvidenceSummary:  policy.authEvidenceSummary,
      },
    };

    const pipeline = redis.multi();
    pipeline.set(KEY_CLAIM(claimId), JSON.stringify(claim), { EX: CLAIM_TTL });
    pipeline.sAdd(KEY_POLICY(policyId), claimId);
    pipeline.expire(KEY_POLICY(policyId), CLAIM_TTL);
    pipeline.zAdd(KEY_USER(userId), [{ score: now, value: claimId }]);
    pipeline.zRemRangeByRank(KEY_USER(userId), 0, -(MAX_PER_USER + 1));
    pipeline.expire(KEY_USER(userId), USER_TTL);
    pipeline.zAdd(KEY_OPEN(), [{ score: now, value: claimId }]);
    pipeline.hIncrBy(KEY_OPS(), "created", 1);
    pipeline.hIncrBy(KEY_OPS(), `type.${claim.claimType}`, 1);
    await pipeline.exec();

    return { ok: true, claimId, claim };
  } catch (err) {
    return { ok: false, error: "claim_create_failed", reason: err?.message };
  }
}

// ── Update claim status ───────────────────────────────────────────────────────

/**
 * Update claim status (reviewer workflow).
 *
 * @param {object} redis
 * @param {string} claimId
 * @param {object} opts
 *   status          {string}  — new status (must be valid transition)
 *   reviewerNotes   {string|null}
 *   resolutionReason{string|null}
 *   approvedPayout  {number|null} — actual payout (for APPROVED/PARTIALLY_APPROVED)
 *   reviewer        {string}  — reviewer identifier
 * @returns {Promise<{ ok, claim?, error? }>}
 */
export async function updateClaimStatus(redis, claimId, {
  status,
  reviewerNotes    = null,
  resolutionReason = null,
  approvedPayout   = null,
  reviewer         = "reviewer",
} = {}) {
  if (!redis || !claimId || !status) {
    return { ok: false, error: "missing_required" };
  }

  try {
    const raw = await redis.get(KEY_CLAIM(claimId));
    if (!raw) return { ok: false, error: "claim_not_found" };

    const claim = JSON.parse(raw);

    // Validate transition
    if (TERMINAL_STATUSES.has(claim.status)) {
      return { ok: false, error: "claim_already_resolved", currentStatus: claim.status };
    }
    const validNext = VALID_TRANSITIONS[claim.status];
    if (!validNext || !validNext.has(status)) {
      return {
        ok: false,
        error: "invalid_status_transition",
        from: claim.status,
        to: status,
        allowed: validNext ? [...validNext] : [],
      };
    }

    const now = Date.now();
    claim.status          = status;
    claim.updatedAt       = now;
    claim.reviewerNotes   = reviewerNotes  || claim.reviewerNotes;
    claim.resolutionReason= resolutionReason || claim.resolutionReason;
    claim.statusHistory.push({ status, at: now, by: reviewer });

    if (TERMINAL_STATUSES.has(status)) {
      claim.resolvedAt = now;
      // Remove from open queue
      await redis.zRem(KEY_OPEN(), claimId).catch(() => {});
    }

    // Handle approved payout
    if (status === CLAIM_STATUS.APPROVED || status === CLAIM_STATUS.PARTIALLY_APPROVED) {
      if (approvedPayout != null) {
        const cap = claim.policySnapshot?.coverageAmount ?? Infinity;
        claim.approvedPayout = Math.min(Math.max(0, approvedPayout), cap);
      }

      // Mark the policy as CLAIMED (non-blocking)
      markPolicyClaimed(redis, claim.policyId, { claimId })
        .catch(err => console.error("[claimDispute] markPolicyClaimed error:", err?.message));

      await redis.hIncrBy(KEY_OPS(), "approved", 1);
      if (claim.approvedPayout) {
        await redis.hIncrBy(KEY_OPS(), "totalPayoutCents",
          Math.round((claim.approvedPayout || 0) * 100));
      }
    }

    if (status === CLAIM_STATUS.DENIED) {
      await redis.hIncrBy(KEY_OPS(), "denied", 1);
    }

    await redis.set(KEY_CLAIM(claimId), JSON.stringify(claim), { EX: CLAIM_TTL });
    return { ok: true, claimId, claim };
  } catch (err) {
    return { ok: false, error: "update_failed", reason: err?.message };
  }
}

// ── Read operations ───────────────────────────────────────────────────────────

export async function getClaimRecord(redis, claimId) {
  if (!redis || !claimId) return null;
  try {
    const raw = await redis.get(KEY_CLAIM(claimId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function getUserClaims(redis, userId, { limit = 20, offset = 0 } = {}) {
  if (!redis || !userId) return { claimIds: [], claims: [], total: 0 };
  try {
    const total    = await redis.zCard(KEY_USER(userId));
    const claimIds = await redis.zRange(KEY_USER(userId), offset, offset + limit - 1, { REV: true });
    const raws     = await Promise.all(claimIds.map(id => redis.get(KEY_CLAIM(id)).catch(() => null)));
    const claims   = raws
      .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
    return { claimIds, claims, total };
  } catch { return { claimIds: [], claims: [], total: 0 }; }
}

export async function getClaimsForPolicy(redis, policyId) {
  if (!redis || !policyId) return [];
  try {
    const claimIds = await redis.sMembers(KEY_POLICY(policyId));
    const raws     = await Promise.all(claimIds.map(id => redis.get(KEY_CLAIM(id)).catch(() => null)));
    return raws
      .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export async function getOpenClaims(redis, { limit = 50 } = {}) {
  if (!redis) return [];
  try {
    const claimIds = await redis.zRange(KEY_OPEN(), 0, limit - 1, { REV: true });
    const raws     = await Promise.all(claimIds.map(id => redis.get(KEY_CLAIM(id)).catch(() => null)));
    return raws
      .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Get claim ops summary for governance.
 */
export async function getClaimOps(redis) {
  if (!redis) return {};
  try {
    const [opsRaw, openCount] = await Promise.all([
      redis.hGetAll(KEY_OPS()).catch(() => ({})),
      redis.zCard(KEY_OPEN()).catch(() => 0),
    ]);
    const ops = {};
    for (const [k, v] of Object.entries(opsRaw || {})) {
      ops[k] = Number(v) || 0;
    }
    return {
      created:         ops["created"]  || 0,
      approved:        ops["approved"] || 0,
      denied:          ops["denied"]   || 0,
      openQueueDepth:  openCount,
      totalPayoutUsd:  Math.round((ops["totalPayoutCents"] || 0) / 100 * 100) / 100,
      byType: {
        counterfeit:      ops["type.counterfeit"]      || 0,
        notAsDescribed:   ops["type.not_as_described"] || 0,
        other:            ops["type.other"]            || 0,
      },
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sanitizeClaimType(t) {
  const valid = new Set(["counterfeit", "not_as_described", "other"]);
  const normalized = (t || "other").toLowerCase().replace(/[^a-z_]/g, "");
  return valid.has(normalized) ? normalized : "other";
}
