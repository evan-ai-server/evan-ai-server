// src/guaranteeEngine.js
// Phase 5 — Guarantee Eligibility + Policy Engine.
//
// Manages guarantee eligibility checks and issues frozen, auditable policy
// snapshots. A policy is the permanent record that backs any future protection
// claim — it freezes the exact trust state at issuance so no ambiguity exists
// if a buyer later disputes the purchase.
//
// Guarantee eligibility is stricter than verification (see evanVerifiedEngine.js).
// A policy can only be issued for items that are guarantee-eligible.
//
// Policy lifecycle:
//   ACTIVE  → EXPIRED (automatic by expiresAt)
//            REVOKED  (counterfeit confirmed post-issue, or ops action)
//            CLAIMED  (a claim was approved against this policy)
//
// Non-negotiable:
//   1. A policy may only be issued if item is VERIFIED + guarantee-eligible.
//   2. Policy snapshot is immutable after issuance.
//   3. Revocation is immediate and permanent — no un-revoke.
//   4. Coverage amount is capped by category rules.
//   5. Fail closed: any uncertainty → deny policy.
//
// Redis key layout:
//   guar:pol:{policyId}       STRING  frozen policy record (3yr TTL)
//   guar:scan:{scanId}        STRING  policyId for this scan (3yr TTL, dedup)
//   guar:user:{userId}        ZSET    policyIds by issuedAt (max 200, 2yr)
//   guar:active               ZSET    active policyIds by issuedAt (for audit)
//   guar:ops                  HASH    ops counters

import crypto from "crypto";
import { VERIFY_STATUS, GUARANTEE_STATUS, VERIFICATION_VERSION } from "./evanVerifiedEngine.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const POLICY_STATUS = {
  ACTIVE:  "ACTIVE",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  CLAIMED: "CLAIMED",
};

export const POLICY_VERSION = "5.0";
const POLICY_TTL    = 3 * 365 * 86400;   // 3 years (policies persist long)
const USER_TTL      = 2 * 365 * 86400;   // 2 years
const MAX_PER_USER  = 200;
const CLAIM_WINDOW_DAYS = 30;            // default days to file a claim

// Risk tier → coverage multiplier
const RISK_TIER_COVERAGE = {
  LOW:      1.00,
  MEDIUM:   0.80,
  HIGH:     0.50,
  CRITICAL: 0.00,
};

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_POL    = id     => `guar:pol:${id}`;
const KEY_SCAN   = scanId => `guar:scan:${scanId}`;
const KEY_USER   = userId => `guar:user:${userId}`;
const KEY_ACTIVE = ()     => `guar:active`;
const KEY_OPS    = ()     => `guar:ops`;

// ── Policy issuance ───────────────────────────────────────────────────────────

/**
 * Issue a guarantee policy for a verified, guarantee-eligible item.
 * Freezes the trust state snapshot at issuance — immutable after this point.
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId              {string}
 *   userId              {string}
 *   category            {string}
 *   evanVerification    {object}   — from computeEvanVerification
 *   authEvidence        {object}   — from authEvidenceModel
 *   trustExplanation    {object|null} — from trustExplanationEngine
 *   scannedPrice        {number|null}
 *   modelVersion        {string}   — current model version tag
 * @returns {Promise<{ ok, policy?, policyId?, error? }>}
 */
export async function issueGuaranteePolicy(redis, {
  scanId,
  userId,
  category        = "generic",
  evanVerification,
  authEvidence    = {},
  trustExplanation = null,
  scannedPrice    = null,
  modelVersion    = "5.0",
} = {}) {
  if (!redis || !scanId || !userId) {
    return { ok: false, error: "missing_required" };
  }

  // Fail closed: item must be verified AND guarantee-eligible
  if (!evanVerification) {
    return { ok: false, error: "no_verification_data" };
  }
  if (evanVerification.status !== VERIFY_STATUS.VERIFIED) {
    return { ok: false, error: "item_not_verified", status: evanVerification.status };
  }
  if (!evanVerification.guaranteeEligible) {
    return { ok: false, error: "not_guarantee_eligible", reasonCodes: evanVerification.guaranteeReasonCodes };
  }

  // Dedup: one policy per scan
  try {
    const existingPolicyId = await redis.get(KEY_SCAN(scanId));
    if (existingPolicyId) {
      const existingRaw = await redis.get(KEY_POL(existingPolicyId));
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          return { ok: true, policyId: existingPolicyId, policy: existing, created: false };
        } catch { /* fall through */ }
      }
    }
  } catch { /* fall through */ }

  try {
    const policyId  = "pol_" + crypto.randomBytes(8).toString("hex");
    const now       = Date.now();
    const riskTier  = evanVerification.guaranteeReasonCodes?.includes("ALL_GUARANTEE_CONDITIONS_MET")
      ? (evanVerification.guaranteeRiskTier || "MEDIUM")
      : "HIGH";

    // Coverage amount — capped by risk tier and max from verification
    const maxCovFromVerif   = evanVerification.guaranteeMaxCoverage ?? null;
    const riskMultiplier    = RISK_TIER_COVERAGE[riskTier] ?? 0.5;
    const rawCoverage       = scannedPrice
      ? Math.min(scannedPrice, maxCovFromVerif ?? scannedPrice)
      : (maxCovFromVerif ?? 0);
    const coverageAmount    = Math.floor(rawCoverage * riskMultiplier);

    const claimWindowDays  = _categoryClaimWindow(category);
    const policyExpiryDays = _categoryPolicyExpiry(category);

    // Exclusions — standard + category-specific
    const exclusions = [
      "counterfeit_confirmed_post_issuance",
      "buyer_damaged",
      "normal_wear",
      "altered_item",
      "change_of_mind",
    ];
    if (category === "watches") exclusions.push("movement_serviced_post_purchase");
    if (category === "handbags") exclusions.push("lining_wear", "hardware_tarnish");

    const policy = {
      policyId,
      scanId,
      userId,
      category,
      status:              POLICY_STATUS.ACTIVE,

      // Frozen snapshot — immutable after issuance
      verificationSnapshot: {
        status:           evanVerification.status,
        reasonCodes:      evanVerification.reasonCodes,
        trustState:       evanVerification.trustState,
        authVerdict:      evanVerification.authVerdict,
        evidenceStrength: evanVerification.evidenceStrength,
        expertReviewed:   evanVerification.expertReviewed,
        expertVerdict:    evanVerification.expertVerdict,
        verifiedAt:       evanVerification.verifiedAt,
        expiresAt:        evanVerification.expiresAt,
        verificationVersion: evanVerification.verificationVersion,
      },
      guaranteeSnapshot: {
        eligible:     true,
        riskTier,
        reasonCodes:  evanVerification.guaranteeReasonCodes,
        coverageAmount,
        maxCoverage:  maxCovFromVerif,
      },
      authEvidenceSummary: {
        verdict:         authEvidence.verdict,
        evidenceStrength:authEvidence.evidenceStrength,
        authScore:       authEvidence.authScore,
        reviewRecommended: authEvidence.reviewRecommended,
        warningCodes:    authEvidence.warningCodes,
      },
      trustExplanationSummary: trustExplanation ? {
        overallTrustScore: trustExplanation.overallTrustScore,
        evidenceLevel:     trustExplanation.evidenceLevel,
        finalReasonSummary: trustExplanation.finalReasonSummary,
      } : null,

      coverageAmount,
      riskTier,
      claimWindowDays,
      exclusions,
      modelVersion,
      policyVersion:   POLICY_VERSION,
      issuedAt:        now,
      expiresAt:       now + policyExpiryDays * 86400000,
      claimsFiledCount: 0,
      scannedPrice,
    };

    const pipeline = redis.multi();
    pipeline.set(KEY_POL(policyId), JSON.stringify(policy), { EX: POLICY_TTL });
    pipeline.set(KEY_SCAN(scanId),  policyId,               { EX: POLICY_TTL });
    pipeline.zAdd(KEY_USER(userId), [{ score: now, value: policyId }]);
    pipeline.zRemRangeByRank(KEY_USER(userId), 0, -(MAX_PER_USER + 1));
    pipeline.expire(KEY_USER(userId), USER_TTL);
    pipeline.zAdd(KEY_ACTIVE(), [{ score: now, value: policyId }]);
    pipeline.hIncrBy(KEY_OPS(), "issued", 1);
    pipeline.hIncrBy(KEY_OPS(), `category.${category}`, 1);
    await pipeline.exec();

    return { ok: true, policyId, policy, created: true };
  } catch (err) {
    return { ok: false, error: "policy_issue_failed", reason: err?.message };
  }
}

/**
 * Retrieve a policy record.
 */
export async function getGuaranteePolicy(redis, policyId) {
  if (!redis || !policyId) return null;
  try {
    const raw = await redis.get(KEY_POL(policyId));
    if (!raw) return null;
    const policy = JSON.parse(raw);
    // Check if expired
    if (policy.status === POLICY_STATUS.ACTIVE && Date.now() > policy.expiresAt) {
      policy.status = POLICY_STATUS.EXPIRED;
      // Update in place (best effort)
      redis.set(KEY_POL(policyId), JSON.stringify(policy), { EX: POLICY_TTL }).catch(() => {});
    }
    return policy;
  } catch { return null; }
}

/**
 * Get policyId for a given scanId.
 */
export async function getPolicyForScan(redis, scanId) {
  if (!redis || !scanId) return null;
  try { return await redis.get(KEY_SCAN(scanId)); } catch { return null; }
}

/**
 * Get user's policies (most recent first).
 */
export async function getUserPolicies(redis, userId, { limit = 20, offset = 0 } = {}) {
  if (!redis || !userId) return { policyIds: [], policies: [], total: 0 };
  try {
    const total      = await redis.zCard(KEY_USER(userId));
    const policyIds  = await redis.zRange(KEY_USER(userId), offset, offset + limit - 1, { REV: true });
    const raws       = await Promise.all(policyIds.map(id => redis.get(KEY_POL(id)).catch(() => null)));
    const policies   = raws
      .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
    return { policyIds, policies, total };
  } catch { return { policyIds: [], policies: [], total: 0 }; }
}

/**
 * Revoke a policy.
 * Called when: expert confirms counterfeit post-issuance, ops revocation,
 * or the linked verification is revoked.
 */
export async function revokeGuaranteePolicy(redis, policyId, {
  reason    = "unspecified",
  revokedBy = "system",
} = {}) {
  if (!redis || !policyId) return { ok: false, error: "missing_policy_id" };
  try {
    const raw = await redis.get(KEY_POL(policyId));
    if (!raw) return { ok: false, error: "policy_not_found" };

    const policy = JSON.parse(raw);
    if (policy.status === POLICY_STATUS.REVOKED) {
      return { ok: true, alreadyRevoked: true };
    }
    if (policy.status === POLICY_STATUS.CLAIMED) {
      return { ok: false, error: "cannot_revoke_claimed_policy" };
    }

    policy.status     = POLICY_STATUS.REVOKED;
    policy.revokedAt  = Date.now();
    policy.revokedBy  = revokedBy;
    policy.revokeReason = reason;

    await redis.set(KEY_POL(policyId), JSON.stringify(policy), { EX: POLICY_TTL });
    await redis.zRem(KEY_ACTIVE(), policyId).catch(() => {});
    await redis.hIncrBy(KEY_OPS(), "revoked", 1);

    return { ok: true, policyId, revokedAt: policy.revokedAt, reason };
  } catch (err) {
    return { ok: false, error: "revoke_failed", reason: err?.message };
  }
}

/**
 * Mark policy as CLAIMED (a claim was approved).
 * Called by claimDisputeEngine when a claim is approved.
 */
export async function markPolicyClaimed(redis, policyId, { claimId } = {}) {
  if (!redis || !policyId) return { ok: false, error: "missing_policy_id" };
  try {
    const raw = await redis.get(KEY_POL(policyId));
    if (!raw) return { ok: false, error: "policy_not_found" };

    const policy = JSON.parse(raw);
    if (policy.status === POLICY_STATUS.REVOKED) {
      return { ok: false, error: "cannot_claim_revoked_policy" };
    }
    if (Date.now() > policy.expiresAt) {
      return { ok: false, error: "policy_expired" };
    }

    policy.status           = POLICY_STATUS.CLAIMED;
    policy.claimedAt        = Date.now();
    policy.linkedClaimId    = claimId || null;
    policy.claimsFiledCount = (policy.claimsFiledCount || 0) + 1;

    await redis.set(KEY_POL(policyId), JSON.stringify(policy), { EX: POLICY_TTL });
    await redis.zRem(KEY_ACTIVE(), policyId).catch(() => {});
    await redis.hIncrBy(KEY_OPS(), "claimed", 1);

    return { ok: true, policyId, claimedAt: policy.claimedAt };
  } catch (err) {
    return { ok: false, error: "mark_claimed_failed", reason: err?.message };
  }
}

/**
 * Get guarantee ops summary for governance.
 */
export async function getGuaranteeOps(redis) {
  if (!redis) return {};
  try {
    const [opsRaw, activeCount] = await Promise.all([
      redis.hGetAll(KEY_OPS()).catch(() => ({})),
      redis.zCard(KEY_ACTIVE()).catch(() => 0),
    ]);

    const ops = {};
    for (const [k, v] of Object.entries(opsRaw || {})) {
      ops[k] = Number(v) || 0;
    }

    // Estimate total payout exposure from active policies (approx — read active policyIds)
    let totalExposure = 0;
    try {
      const activePolicyIds = await redis.zRange(KEY_ACTIVE(), 0, 999, { REV: true });
      const raws = await Promise.all(activePolicyIds.map(id => redis.get(KEY_POL(id)).catch(() => null)));
      for (const raw of raws) {
        if (!raw) continue;
        try {
          const p = JSON.parse(raw);
          if (p.status === POLICY_STATUS.ACTIVE) {
            totalExposure += p.coverageAmount || 0;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return {
      issued:         ops["issued"]  || 0,
      revoked:        ops["revoked"] || 0,
      claimed:        ops["claimed"] || 0,
      activePolicies: activeCount,
      estimatedTotalExposure: totalExposure,
      byCategory: {
        sneakers: ops["category.sneakers"] || 0,
        handbags: ops["category.handbags"] || 0,
        watches:  ops["category.watches"]  || 0,
        generic:  ops["category.generic"]  || 0,
      },
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _categoryClaimWindow(category) {
  // Days after issuance to file a claim
  const windows = { sneakers: 30, handbags: 14, watches: 14, generic: 30 };
  return windows[(category || "").toLowerCase()] ?? 30;
}

function _categoryPolicyExpiry(category) {
  // Days policy remains active (covers the claim window + buffer)
  const expiry = { sneakers: 45, handbags: 30, watches: 21, generic: 60 };
  return expiry[(category || "").toLowerCase()] ?? 45;
}
