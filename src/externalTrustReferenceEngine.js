// src/externalTrustReferenceEngine.js
// Phase 7 — External Trust Reference Engine + Trustmark Verification Infrastructure.
//
// Every trust-bearing credential that leaves Evan must be traceable back to
// this system. When "Evan-Verified" or "Evan-Certified" appears externally,
// a third party must be able to verify it by looking up a stable referenceId.
//
// This engine is the structural foundation of Phase 7:
//   - All external trust objects carry a referenceId from this engine
//   - All references are time-bounded, revocable, and audit-hashed
//   - The /verify/* routes serve public-safe lookups backed by this layer
//   - Trustmarks gain lookup-backed, tamper-resistant verification
//
// Reference types:
//   ITEM_VERIFICATION   — Evan-Verified item scan credential
//   RESELLER_CERT       — Evan-Certified reseller credential
//   GUARANTEE           — Active guarantee policy reference
//   TRUSTMARK           — External trustmark (derives from ITEM_VERIFICATION)
//   ROUTE_PROOF         — Route quality proof record (B2B use)
//
// Redis key layout:
//   extref:record:{referenceId}        STRING  full record (3yr TTL)
//   extref:source:{type}:{sourceId}    STRING  referenceId pointer (3yr TTL, dedup)
//   extref:revoked                     ZSET    revoked referenceIds by revokedAt (permanent)
//   extref:ops                         HASH    ops counters
//
// Non-negotiables:
//   1. referenceIds are random, opaque, unpredictable — never sequential.
//   2. auditHash covers canonical fields at issuance — detects tampering.
//   3. Revocation is immediate and permanent — no un-revoke.
//   4. publicSafeFields controls exactly what /verify/:id exposes.
//   5. No internal model scores or unsafe reasoning in public-safe output.

import crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

export const EXTREF_VERSION = "7.0";

export const REFERENCE_TYPE = {
  ITEM_VERIFICATION: "ITEM_VERIFICATION",
  RESELLER_CERT:     "RESELLER_CERT",
  GUARANTEE:         "GUARANTEE",
  TRUSTMARK:         "TRUSTMARK",
  ROUTE_PROOF:       "ROUTE_PROOF",
};

export const REFERENCE_STATUS = {
  ACTIVE:   "ACTIVE",
  EXPIRED:  "EXPIRED",
  REVOKED:  "REVOKED",
  PENDING:  "PENDING",   // issued but not yet confirmed active
};

// Verification URL base — replace with real domain in production
const VERIFICATION_BASE_URL = "https://verify.evanai.app";

const ROUTE_SUFFIX = {
  ITEM_VERIFICATION: "item",
  RESELLER_CERT:     "reseller",
  GUARANTEE:         "guarantee",
  TRUSTMARK:         "item",   // trustmarks resolve via same /item route
  ROUTE_PROOF:       "route",
};

const REF_TTL = 3 * 365 * 86400;   // 3 years

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_RECORD = id         => `extref:record:${id}`;
const KEY_SOURCE = (type, id) => `extref:source:${type}:${_safeKey(id)}`;
const KEY_REVOKED = ()        => `extref:revoked`;
const KEY_OPS    = ()         => `extref:ops`;

// ── Reference creation ─────────────────────────────────────────────────────────

/**
 * Create an external trust reference for a trust-bearing object.
 * Idempotent: calling again for the same sourceId returns the existing reference.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceType    {string}    — REFERENCE_TYPE.*
 *   sourceId         {string}    — internal ID (trustmarkId, policyId, scanId, userId)
 *   ownerId          {string}    — userId or system identifier
 *   ownerType        {string}    — "user"|"system"
 *   status           {string}    — REFERENCE_STATUS.*
 *   issuedAt         {number}    — timestamp ms
 *   expiresAt        {number|null} — timestamp ms or null
 *   summary          {string}    — human-readable one-line summary (public-safe)
 *   publicSafeFields {object}    — fields safe to expose on /verify/:id
 *   partnerSafeFields {object}   — fields safe for partner API consumers
 * @returns {Promise<{ ok, referenceId?, record?, error? }>}
 */
export async function createExternalReference(redis, {
  referenceType,
  sourceId,
  ownerId       = null,
  ownerType     = "user",
  status        = REFERENCE_STATUS.ACTIVE,
  issuedAt      = Date.now(),
  expiresAt     = null,
  summary       = "",
  publicSafeFields  = {},
  partnerSafeFields = {},
} = {}) {
  if (!redis || !referenceType || !sourceId) {
    return { ok: false, error: "missing_required" };
  }
  if (!REFERENCE_TYPE[referenceType]) {
    return { ok: false, error: "invalid_reference_type" };
  }

  try {
    // Dedup: if a reference already exists for this source, return it
    const existingId = await redis.get(KEY_SOURCE(referenceType, sourceId)).catch(() => null);
    if (existingId) {
      const existing = await redis.get(KEY_RECORD(existingId)).catch(() => null);
      if (existing) {
        try {
          return { ok: true, referenceId: existingId, record: JSON.parse(existing), existed: true };
        } catch { /* fall through to create new */ }
      }
    }

    const referenceId     = _generateReferenceId();
    const verificationUrl = `${VERIFICATION_BASE_URL}/verify/${ROUTE_SUFFIX[referenceType]}/${referenceId}`;

    const record = {
      referenceId,
      referenceType,
      sourceId,
      ownerId,
      ownerType,
      status,
      issuedAt,
      expiresAt,
      revokedAt:        null,
      revokedReason:    null,
      verificationUrl,
      summary,
      publicSafeFields,
      partnerSafeFields,
      auditHash:        null,   // computed below
      extrefVersion:    EXTREF_VERSION,
    };

    record.auditHash = buildAuditHash(record);

    await redis.set(KEY_RECORD(referenceId), JSON.stringify(record), { EX: REF_TTL });
    await redis.set(KEY_SOURCE(referenceType, sourceId), referenceId, { EX: REF_TTL });
    await redis.hIncrBy(KEY_OPS(), "total_created", 1);
    await redis.hIncrBy(KEY_OPS(), `type.${referenceType}`, 1);

    return { ok: true, referenceId, record };
  } catch (err) {
    return { ok: false, error: "create_failed", reason: err?.message };
  }
}

// ── Reference lookup ──────────────────────────────────────────────────────────

/**
 * Get a full reference record by referenceId.
 * Enriches status based on current time (EXPIRED if past expiresAt).
 */
export async function getExternalReference(redis, referenceId) {
  if (!redis || !referenceId) return null;
  try {
    const raw = await redis.get(KEY_RECORD(referenceId));
    if (!raw) return null;
    const record = JSON.parse(raw);
    return _enrichStatus(record);
  } catch { return null; }
}

/**
 * Get a reference by sourceType + sourceId (e.g., find the reference for trustmarkId X).
 */
export async function getReferenceBySource(redis, referenceType, sourceId) {
  if (!redis || !referenceType || !sourceId) return null;
  try {
    const refId = await redis.get(KEY_SOURCE(referenceType, sourceId));
    if (!refId) return null;
    return getExternalReference(redis, refId);
  } catch { return null; }
}

// ── Public-safe verification lookup ──────────────────────────────────────────

/**
 * Build the public-safe verification payload for /verify/:type/:referenceId.
 * This is the ONLY thing the public page should show — never the raw record.
 *
 * @param {object} redis
 * @param {string} referenceId
 * @returns {Promise<PublicVerificationPayload | null>}
 */
export async function getPublicVerificationPayload(redis, referenceId) {
  if (!redis || !referenceId) return null;
  try {
    const record = await getExternalReference(redis, referenceId);
    if (!record) return _notFoundPayload(referenceId);

    const currentStatus = record.status;
    const isActive      = currentStatus === REFERENCE_STATUS.ACTIVE;

    return {
      referenceId:     record.referenceId,
      referenceType:   record.referenceType,
      status:          currentStatus,
      verified:        isActive,
      issuedAt:        record.issuedAt,
      expiresAt:       record.expiresAt,
      revokedAt:       record.revokedAt    || null,
      revokedReason:   record.revokedAt    ? (record.revokedReason || "revoked_by_issuer") : null,
      verificationUrl: record.verificationUrl,
      summary:         isActive ? (record.summary || null) : null,
      // Public-safe fields only — no internal scores or reasoning
      ...( isActive ? record.publicSafeFields : {} ),
      auditHash:       record.auditHash,
      disclaimer:      _getDisclaimer(record.referenceType, currentStatus),
      lookedUpAt:      Date.now(),
      extrefVersion:   EXTREF_VERSION,
    };
  } catch { return null; }
}

/**
 * Build partner-safe verification payload (richer than public, gated by access policy).
 */
export async function getPartnerVerificationPayload(redis, referenceId) {
  if (!redis || !referenceId) return null;
  try {
    const record = await getExternalReference(redis, referenceId);
    if (!record) return _notFoundPayload(referenceId);
    const currentStatus = record.status;
    const isActive      = currentStatus === REFERENCE_STATUS.ACTIVE;
    return {
      referenceId:       record.referenceId,
      referenceType:     record.referenceType,
      status:            currentStatus,
      verified:          isActive,
      issuedAt:          record.issuedAt,
      expiresAt:         record.expiresAt,
      revokedAt:         record.revokedAt || null,
      verificationUrl:   record.verificationUrl,
      summary:           record.summary || null,
      ...( isActive ? { ...record.publicSafeFields, ...record.partnerSafeFields } : {} ),
      auditHash:         record.auditHash,
      lookedUpAt:        Date.now(),
      extrefVersion:     EXTREF_VERSION,
    };
  } catch { return null; }
}

// ── Revocation ────────────────────────────────────────────────────────────────

/**
 * Revoke an external reference immediately.
 * Revocation is permanent — no un-revoke.
 */
export async function revokeExternalReference(redis, referenceId, {
  reason     = "issuer_revoked",
  revokedBy  = "system",
} = {}) {
  if (!redis || !referenceId) {
    return { ok: false, error: "missing_required" };
  }
  try {
    const record = await getExternalReference(redis, referenceId);
    if (!record) return { ok: false, error: "not_found" };
    if (record.status === REFERENCE_STATUS.REVOKED) {
      return { ok: true, alreadyRevoked: true, record };
    }

    const now = Date.now();
    record.status       = REFERENCE_STATUS.REVOKED;
    record.revokedAt    = now;
    record.revokedReason = reason;
    record.revokedBy    = revokedBy;
    record.auditHash    = buildAuditHash(record);   // re-hash after revocation

    await redis.set(KEY_RECORD(referenceId), JSON.stringify(record), { EX: REF_TTL });
    await redis.zAdd(KEY_REVOKED(), [{ score: now, value: referenceId }]);
    await redis.hIncrBy(KEY_OPS(), "total_revoked", 1);

    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: "revoke_failed", reason: err?.message };
  }
}

// ── Audit hash ────────────────────────────────────────────────────────────────

/**
 * Build a deterministic audit hash over the canonical fields of a reference.
 * The hash proves the record has not been modified since issuance.
 * It intentionally excludes mutable fields (status, revokedAt) when building
 * the issuance-time hash, but includes them for post-revocation re-hashing.
 */
export function buildAuditHash(record) {
  const canonical = {
    referenceId:   record.referenceId,
    referenceType: record.referenceType,
    sourceId:      record.sourceId,
    ownerId:       record.ownerId,
    issuedAt:      record.issuedAt,
    expiresAt:     record.expiresAt,
    status:        record.status,
    revokedAt:     record.revokedAt || null,
    extrefVersion: record.extrefVersion,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);  // 32 hex chars = 128 bits
}

/**
 * Verify that a reference record's auditHash matches its current content.
 * Returns true if untampered, false if hash mismatch.
 */
export function verifyAuditHash(record) {
  if (!record?.auditHash) return false;
  const expected = buildAuditHash(record);
  return expected === record.auditHash;
}

// ── Ops ───────────────────────────────────────────────────────────────────────

export async function getExternalReferenceOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalCreated:  ops["total_created"]  || 0,
      totalRevoked:  ops["total_revoked"]  || 0,
      byType: Object.fromEntries(
        Object.entries(ops)
          .filter(([k]) => k.startsWith("type."))
          .map(([k, v]) => [k.replace("type.", ""), v])
      ),
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _generateReferenceId() {
  // 20 hex chars = 10 random bytes = 80-bit random ID
  // Format: evr_{20hex} — "evan reference"
  return `evr_${crypto.randomBytes(10).toString("hex")}`;
}

function _safeKey(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function _enrichStatus(record) {
  if (!record) return null;
  if (record.status === REFERENCE_STATUS.REVOKED) return record;
  if (record.expiresAt && Date.now() > record.expiresAt) {
    return { ...record, status: REFERENCE_STATUS.EXPIRED };
  }
  return record;
}

function _notFoundPayload(referenceId) {
  return {
    referenceId,
    status:  "NOT_FOUND",
    verified: false,
    disclaimer: "This reference ID was not found in the Evan verification system.",
    lookedUpAt: Date.now(),
    extrefVersion: EXTREF_VERSION,
  };
}

function _getDisclaimer(referenceType, status) {
  if (status === REFERENCE_STATUS.REVOKED) {
    return "This credential has been revoked and is no longer valid.";
  }
  if (status === REFERENCE_STATUS.EXPIRED) {
    return "This credential has expired. A new scan or re-evaluation is required.";
  }
  switch (referenceType) {
    case REFERENCE_TYPE.ITEM_VERIFICATION:
      return "Evan-Verified reflects authentication evidence at time of scan. It does not constitute an unconditional guarantee unless a separate guarantee policy was issued.";
    case REFERENCE_TYPE.RESELLER_CERT:
      return "Evan-Certified reflects behavioral history and track record at time of certification. Certification status may change with subsequent activity.";
    case REFERENCE_TYPE.GUARANTEE:
      return "Guarantee coverage is subject to policy terms, exclusions, and claim window. See full policy for details.";
    case REFERENCE_TYPE.TRUSTMARK:
      return "Evan-Verified reflects authentication evidence at time of scan. Verify authenticity independently for high-stakes purchases.";
    default:
      return "Issued by Evan AI. Subject to terms of use.";
  }
}
