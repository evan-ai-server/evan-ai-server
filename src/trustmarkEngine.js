// src/trustmarkEngine.js
// Phase 5 — External Trustmark Engine.
//
// Issues stable, external-facing "Evan-Verified" trustmarks for items that
// have passed full verification. Trustmarks are designed to:
//   - Leave the app (appear in listings, external marketplaces, B2B APIs)
//   - Be auditable by reference ID
//   - Be revocable when new evidence invalidates prior verification
//   - Expire on schedule (category-specific)
//   - Carry frozen evidence metadata so any claim can be traced
//
// A trustmark is distinct from the internal evanVerification record:
//   - evanVerification: internal eligibility object, computed at scan time
//   - trustmark: the externally-referenceable credential, issued on demand
//     from a VERIFIED evanVerification
//
// Non-negotiable:
//   1. Trustmarks may only be issued for VERIFIED items.
//   2. One trustmark per scanId (dedup).
//   3. Revocation is immediate and propagates to listing language.
//   4. Expired trustmarks are NOT re-issued automatically — rescan required.
//   5. No cryptographic signing (yet) — but structure supports future signing.
//   6. Trustmark status must always be checked in real time (not cached by clients).
//
// Redis key layout:
//   tm:record:{trustmarkId}   STRING  trustmark record (3yr TTL)
//   tm:scan:{scanId}          STRING  trustmarkId for this scan (3yr TTL, dedup)
//   tm:active                 ZSET    active trustmarkIds by issuedAt (for audit)
//   tm:revoked                ZSET    revoked trustmarkIds (permanent, for audit trail)
//   tm:ops                    HASH    ops counters

import crypto from "crypto";
import { VERIFY_STATUS, VERIFICATION_VERSION } from "./evanVerifiedEngine.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const TRUSTMARK_STATUS = {
  ACTIVE:      "ACTIVE",
  EXPIRED:     "EXPIRED",
  REVOKED:     "REVOKED",
  SUPERSEDED:  "SUPERSEDED",   // replaced by a newer trustmark for same item
};

export const TRUSTMARK_VERSION = "5.0";

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_RECORD  = id     => `tm:record:${id}`;
const KEY_SCAN    = scanId => `tm:scan:${scanId}`;
const KEY_ACTIVE  = ()     => `tm:active`;
const KEY_REVOKED = ()     => `tm:revoked`;
const KEY_OPS     = ()     => `tm:ops`;

const TM_TTL     = 3 * 365 * 86400;   // 3 years
const ACTIVE_TTL = 2 * 365 * 86400;

// ── Trustmark issuance ────────────────────────────────────────────────────────

/**
 * Issue an external trustmark for a verified item.
 * Idempotent: calling twice for same scanId returns existing trustmark.
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId            {string}
 *   evanVerification  {object}  — must be VERIFIED status
 *   authEvidence      {object}
 *   category          {string}
 *   brand             {string|null}
 * @returns {Promise<{ ok, trustmarkId?, trustmark?, error? }>}
 */
export async function issueTrustmark(redis, {
  scanId,
  evanVerification,
  authEvidence   = {},
  category       = "generic",
  brand          = null,
} = {}) {
  if (!redis || !scanId) {
    return { ok: false, error: "missing_required" };
  }

  // Must be VERIFIED
  if (!evanVerification || evanVerification.status !== VERIFY_STATUS.VERIFIED) {
    return {
      ok: false,
      error: "item_not_verified",
      status: evanVerification?.status || "unknown",
    };
  }

  // Dedup: one trustmark per scan
  try {
    const existingTmId = await redis.get(KEY_SCAN(scanId));
    if (existingTmId) {
      const existingRaw = await redis.get(KEY_RECORD(existingTmId));
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          // Check if existing is still valid
          if (existing.status === TRUSTMARK_STATUS.ACTIVE) {
            if (Date.now() <= existing.expiresAt) {
              return { ok: true, trustmarkId: existingTmId, trustmark: existing, created: false };
            }
            // Expired — fall through to issue new
          }
        } catch { /* fall through */ }
      }
    }
  } catch { /* fall through */ }

  try {
    const trustmarkId = "tm_" + crypto.randomBytes(8).toString("hex");
    const now         = Date.now();
    const expiresAt   = evanVerification.expiresAt || (now + 90 * 86400000);

    // Evidence fingerprint — a stable hash of key evidence fields
    // Not cryptographic — just a stable, non-guessable reference
    const fingerprintInput = JSON.stringify({
      scanId,
      authVerdict:      authEvidence.verdict,
      evidenceStrength: authEvidence.evidenceStrength,
      authScore:        Math.round((authEvidence.authScore || 0) * 100),
      trustState:       evanVerification.trustState,
      expertReviewed:   evanVerification.expertReviewed,
    });
    const evidenceFingerprint = crypto
      .createHash("sha256")
      .update(fingerprintInput)
      .digest("hex")
      .slice(0, 24);

    const trustmark = {
      trustmarkId,
      referenceId:     "EV-" + trustmarkId.toUpperCase().replace("TM_", "").slice(0, 12),
      scanId,
      category,
      brand:           brand || null,
      status:          TRUSTMARK_STATUS.ACTIVE,
      publicClaimText: "Evan-Verified",
      issuedAt:        now,
      expiresAt,
      revokedAt:       null,
      revocationReason:null,
      evidenceFingerprint,
      trustmarkVersion:TRUSTMARK_VERSION,
      verificationSummary: {
        authVerdict:      authEvidence.verdict      || "LIKELY_AUTHENTIC",
        evidenceStrength: authEvidence.evidenceStrength || "MEDIUM",
        trustState:       evanVerification.trustState,
        expertReviewed:   evanVerification.expertReviewed || false,
        expertVerdict:    evanVerification.expertVerdict  || null,
      },
      // Public claim language for external use
      claimLanguage:   evanVerification.claimLanguage || null,
      // Audit trail
      issuedFromVerification: {
        status:             evanVerification.status,
        reasonCodes:        evanVerification.reasonCodes,
        verifiedAt:         evanVerification.verifiedAt,
        verificationVersion:evanVerification.verificationVersion,
      },
    };

    const pipeline = redis.multi();
    pipeline.set(KEY_RECORD(trustmarkId), JSON.stringify(trustmark), { EX: TM_TTL });
    pipeline.set(KEY_SCAN(scanId),        trustmarkId,               { EX: TM_TTL });
    pipeline.zAdd(KEY_ACTIVE(), [{ score: now, value: trustmarkId }]);
    pipeline.expire(KEY_ACTIVE(), ACTIVE_TTL);
    pipeline.hIncrBy(KEY_OPS(), "issued", 1);
    pipeline.hIncrBy(KEY_OPS(), `category.${category}`, 1);
    await pipeline.exec();

    return { ok: true, trustmarkId, trustmark, created: true };
  } catch (err) {
    return { ok: false, error: "trustmark_issue_failed", reason: err?.message };
  }
}

// ── Trustmark lookup ──────────────────────────────────────────────────────────

/**
 * Get a trustmark record, returning real-time status (checking expiry).
 */
export async function getTrustmark(redis, trustmarkId) {
  if (!redis || !trustmarkId) return null;
  try {
    const raw = await redis.get(KEY_RECORD(trustmarkId));
    if (!raw) return null;

    const tm = JSON.parse(raw);
    // Check expiry in real time
    if (tm.status === TRUSTMARK_STATUS.ACTIVE && Date.now() > tm.expiresAt) {
      tm.status = TRUSTMARK_STATUS.EXPIRED;
      redis.set(KEY_RECORD(trustmarkId), JSON.stringify(tm), { EX: TM_TTL }).catch(() => {});
      redis.zRem(KEY_ACTIVE(), trustmarkId).catch(() => {});
    }
    return tm;
  } catch { return null; }
}

/**
 * Get trustmarkId for a given scanId.
 */
export async function getTrustmarkForScan(redis, scanId) {
  if (!redis || !scanId) return null;
  try { return await redis.get(KEY_SCAN(scanId)); } catch { return null; }
}

/**
 * Check trustmark status — public-facing endpoint behavior.
 * Returns a minimal status object suitable for external display.
 */
export async function checkTrustmarkStatus(redis, trustmarkId) {
  const tm = await getTrustmark(redis, trustmarkId);
  if (!tm) {
    return {
      valid:          false,
      trustmarkId,
      status:         null,
      reason:         "not_found",
    };
  }

  const valid = tm.status === TRUSTMARK_STATUS.ACTIVE;
  return {
    valid,
    trustmarkId,
    referenceId:    tm.referenceId,
    status:         tm.status,
    category:       tm.category,
    brand:          tm.brand,
    issuedAt:       tm.issuedAt,
    expiresAt:      tm.expiresAt,
    publicClaimText:valid ? tm.publicClaimText : null,
    expertReviewed: tm.verificationSummary?.expertReviewed || false,
    reason:         !valid ? tm.status.toLowerCase() : null,
    // Evidence summary (no raw scores — just the qualitative level)
    evidenceLevel:  tm.verificationSummary?.evidenceStrength || null,
  };
}

// ── Revocation ────────────────────────────────────────────────────────────────

/**
 * Revoke an active trustmark.
 * Called when: expert confirms counterfeit, ops action, or verification revoked.
 *
 * Revocation reasons:
 *   "expert_confirmed_counterfeit" — highest priority, permanent
 *   "verification_revoked"         — linked evanVerification was revoked
 *   "anomaly_detected"             — unusual pattern detected post-issuance
 *   "ops_action"                   — manual ops revocation
 *
 * @returns {Promise<{ ok, trustmarkId?, revokedAt?, error? }>}
 */
export async function revokeTrustmark(redis, trustmarkId, {
  reason    = "ops_action",
  revokedBy = "system",
} = {}) {
  if (!redis || !trustmarkId) {
    return { ok: false, error: "missing_trustmark_id" };
  }

  try {
    const raw = await redis.get(KEY_RECORD(trustmarkId));
    if (!raw) return { ok: false, error: "trustmark_not_found" };

    const tm = JSON.parse(raw);

    if (tm.status === TRUSTMARK_STATUS.REVOKED) {
      return { ok: true, alreadyRevoked: true, revokedAt: tm.revokedAt };
    }
    if (tm.status === TRUSTMARK_STATUS.EXPIRED) {
      return { ok: true, alreadyExpired: true };
    }

    const now = Date.now();
    tm.status          = TRUSTMARK_STATUS.REVOKED;
    tm.revokedAt       = now;
    tm.revokedBy       = revokedBy;
    tm.revocationReason = reason;
    tm.publicClaimText = null;  // Clear external claim text immediately

    await redis.set(KEY_RECORD(trustmarkId), JSON.stringify(tm), { EX: TM_TTL });
    await redis.zRem(KEY_ACTIVE(), trustmarkId).catch(() => {});
    await redis.zAdd(KEY_REVOKED(), [{ score: now, value: trustmarkId }]);
    await redis.hIncrBy(KEY_OPS(), "revoked", 1);

    return { ok: true, trustmarkId, revokedAt: now, reason };
  } catch (err) {
    return { ok: false, error: "revoke_failed", reason: err?.message };
  }
}

/**
 * Revoke all active trustmarks for a given scanId.
 * Used when a scan's verification is revoked (e.g., expert confirms counterfeit).
 */
export async function revokeTrustmarkForScan(redis, scanId, opts = {}) {
  if (!redis || !scanId) return { ok: false, error: "missing_scan_id" };
  try {
    const trustmarkId = await redis.get(KEY_SCAN(scanId));
    if (!trustmarkId) return { ok: true, nothingToRevoke: true };
    return revokeTrustmark(redis, trustmarkId, opts);
  } catch (err) {
    return { ok: false, error: "revoke_for_scan_failed", reason: err?.message };
  }
}

// ── Governance / ops ──────────────────────────────────────────────────────────

export async function getTrustmarkOps(redis) {
  if (!redis) return {};
  try {
    const [opsRaw, activeCount, revokedCount] = await Promise.all([
      redis.hGetAll(KEY_OPS()).catch(() => ({})),
      redis.zCard(KEY_ACTIVE()).catch(() => 0),
      redis.zCard(KEY_REVOKED()).catch(() => 0),
    ]);

    const ops = {};
    for (const [k, v] of Object.entries(opsRaw || {})) ops[k] = Number(v) || 0;

    return {
      issued:         ops["issued"]  || 0,
      revoked:        ops["revoked"] || 0,
      activeTrustmarks: activeCount,
      revokedTotal:   revokedCount,
      byCategory: {
        sneakers: ops["category.sneakers"] || 0,
        handbags: ops["category.handbags"] || 0,
        watches:  ops["category.watches"]  || 0,
        generic:  ops["category.generic"]  || 0,
      },
    };
  } catch { return {}; }
}

/**
 * Full revocation + downstream cascade.
 * When expert confirms counterfeit post-verification:
 *   1. Revoke trustmark
 *   2. Return summary for caller to revoke evanVerification + guarantee policy
 *
 * @returns {Promise<RevocationCascadeResult>}
 */
export async function cascadeRevocationForScan(redis, scanId, {
  reason    = "expert_confirmed_counterfeit",
  revokedBy = "system",
} = {}) {
  const results = { scanId, trustmarkRevoked: false, errors: [] };

  // Revoke trustmark
  const tmResult = await revokeTrustmarkForScan(redis, scanId, { reason, revokedBy });
  if (tmResult.ok && !tmResult.nothingToRevoke) {
    results.trustmarkRevoked = true;
    results.trustmarkId      = tmResult.trustmarkId || (await redis.get(KEY_SCAN(scanId)).catch(() => null));
  } else if (!tmResult.ok) {
    results.errors.push({ step: "trustmark_revoke", error: tmResult.error });
  }

  return results;
}
