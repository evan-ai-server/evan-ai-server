// src/publicVerificationEngine.js
// Phase 7 — Public Verification Page / Lookup Model.
//
// Builds the public-safe, external-facing verification objects that power:
//   /verify/item/:referenceId       — item trust/auth verification
//   /verify/reseller/:referenceId   — reseller certification verification
//   /verify/guarantee/:referenceId  — guarantee coverage verification
//
// Each verification object:
//   - Shows only information safe for the general public
//   - Never exposes internal scores, model details, or unsafe reasoning
//   - Carries the current live status (not cached from when issued)
//   - Includes a disclaimer appropriate to the credential type
//   - Includes an auditHash from the original reference for tamper resistance
//
// This engine orchestrates across: externalTrustReferenceEngine,
//   resellerIdentityEngine, guaranteeExternalEngine, trustTimelineEngine.

import {
  getExternalReference,
  getPublicVerificationPayload,
  REFERENCE_TYPE,
  REFERENCE_STATUS,
  EXTREF_VERSION,
} from "./externalTrustReferenceEngine.js";

import {
  buildPublicResellerProfile,
  IDENTITY_VERSION,
} from "./resellerIdentityEngine.js";

import {
  buildGuaranteePublicVerification,
} from "./guaranteeExternalEngine.js";

import {
  getPublicTimeline,
  TIMELINE_ENTITY_TYPE,
} from "./trustTimelineEngine.js";

export const VERIFICATION_LOOKUP_VERSION = "7.0";

// ── Item verification lookup ──────────────────────────────────────────────────

/**
 * Build the full public verification payload for /verify/item/:referenceId.
 * Combines external reference + public-safe trust evidence.
 *
 * @param {object} redis
 * @param {string} referenceId
 * @param {object} opts
 *   trustmarkRecord   {object|null}  — from getTrustmark()
 *   evanVerification  {object|null}  — from getVerificationRecord()
 * @returns {object} PublicItemVerification
 */
export async function buildItemVerificationLookup(redis, referenceId, {
  trustmarkRecord  = null,
  evanVerification = null,
} = {}) {
  if (!redis || !referenceId) return _notFound(referenceId, "ITEM_VERIFICATION");

  const base = await getPublicVerificationPayload(redis, referenceId);
  if (!base) return _notFound(referenceId, "ITEM_VERIFICATION");

  // If reference is not for an item/trustmark, return mismatch
  if (base.referenceType !== REFERENCE_TYPE.ITEM_VERIFICATION &&
      base.referenceType !== REFERENCE_TYPE.TRUSTMARK) {
    return _typeMismatch(referenceId, "ITEM_VERIFICATION");
  }

  const isActive = base.verified && base.status === REFERENCE_STATUS.ACTIVE;

  // Evidence summary — qualitative only, never raw scores
  let evidenceBlock = null;
  if (isActive && evanVerification) {
    evidenceBlock = {
      evidenceLevel:  evanVerification.evidenceLevel  || null,
      expertReviewed: evanVerification.expertReviewed || false,
      category:       evanVerification.category       || null,
      brand:          evanVerification.brand          || null,
      // Never include trustScore, authScore, counterfeitMatchScore
    };
  }

  return {
    lookupType:      "ITEM_VERIFICATION",
    referenceId:     base.referenceId,
    status:          base.status,
    verified:        base.verified,
    issuedAt:        base.issuedAt,
    expiresAt:       base.expiresAt,
    revokedAt:       base.revokedAt   || null,
    revokedReason:   base.revokedReason ? "Credential revoked — new evidence or issuer action." : null,
    verificationUrl: base.verificationUrl,
    summary:         isActive ? base.summary : null,
    evidenceSummary: evidenceBlock,
    // Trustmark-specific
    trustmarkStatus: trustmarkRecord?.status || null,
    // Audit proof
    auditHash:       base.auditHash,
    disclaimer:      base.disclaimer,
    lookedUpAt:      Date.now(),
    lookupVersion:   VERIFICATION_LOOKUP_VERSION,
  };
}

// ── Reseller verification lookup ──────────────────────────────────────────────

/**
 * Build the full public verification payload for /verify/reseller/:referenceId.
 * Combines external reference + public reseller profile + public timeline.
 *
 * @param {object} redis
 * @param {string} referenceId
 * @param {object} opts
 *   userId     {string|null}  — internal userId (resolved from reference.ownerId)
 * @returns {object} PublicResellerVerification
 */
export async function buildResellerVerificationLookup(redis, referenceId, {
  userId = null,
} = {}) {
  if (!redis || !referenceId) return _notFound(referenceId, "RESELLER_CERT");

  const base = await getPublicVerificationPayload(redis, referenceId);
  if (!base) return _notFound(referenceId, "RESELLER_CERT");

  if (base.referenceType !== REFERENCE_TYPE.RESELLER_CERT) {
    return _typeMismatch(referenceId, "RESELLER_CERT");
  }

  const isActive   = base.verified && base.status === REFERENCE_STATUS.ACTIVE;
  const resolvedId = userId || base.ownerId || null;

  // Public reseller profile — only if active and userId available
  let publicProfile = null;
  let publicTimeline = [];
  if (isActive && resolvedId) {
    try {
      publicTimeline = await getPublicTimeline(redis, TIMELINE_ENTITY_TYPE.RESELLER, resolvedId, 5);
      publicProfile = await buildPublicResellerProfile(redis, resolvedId, {
        referenceId,
        verificationUrl: base.verificationUrl,
        publicTimeline,
      });
    } catch {}
  }

  return {
    lookupType:          "RESELLER_CERT",
    referenceId:         base.referenceId,
    status:              base.status,
    verified:            base.verified,
    issuedAt:            base.issuedAt,
    expiresAt:           base.expiresAt,
    revokedAt:           base.revokedAt || null,
    verificationUrl:     base.verificationUrl,
    // Public profile fields (null if not eligible or not active)
    displayName:         publicProfile?.displayName          || null,
    certificationStatus: isActive ? (publicProfile?.certificationStatus || base.publicSafeFields?.certificationStatus || null) : null,
    certificationTier:   isActive ? (publicProfile?.certificationTier   || null) : null,
    certifiedAt:         isActive ? (publicProfile?.certifiedAt         || null) : null,
    dealIQBand:          isActive ? (publicProfile?.dealIQBand          || null) : null,
    categorySpecialties: isActive ? (publicProfile?.categorySpecialties || [])   : [],
    trustLevel:          isActive ? (publicProfile?.trustLevel          || null) : null,
    badgeSet:            isActive ? (publicProfile?.badgeSet            || [])   : [],
    recentTrustEvents:   isActive ? publicTimeline : [],
    auditHash:           base.auditHash,
    disclaimer:          base.disclaimer,
    disclaimers:         isActive ? (publicProfile?.disclaimers || []) : ["This credential is no longer active."],
    lookedUpAt:          Date.now(),
    lookupVersion:       VERIFICATION_LOOKUP_VERSION,
  };
}

// ── Guarantee verification lookup ─────────────────────────────────────────────

/**
 * Build the full public verification payload for /verify/guarantee/:referenceId.
 *
 * @param {object} redis
 * @param {string} referenceId
 * @param {object} opts
 *   guaranteePolicy {object|null}  — from getGuaranteePolicy()
 * @returns {object} PublicGuaranteeVerification
 */
export async function buildGuaranteeVerificationLookup(redis, referenceId, {
  guaranteePolicy = null,
} = {}) {
  if (!redis || !referenceId) return _notFound(referenceId, "GUARANTEE");

  const base = await getPublicVerificationPayload(redis, referenceId);
  if (!base) return _notFound(referenceId, "GUARANTEE");

  if (base.referenceType !== REFERENCE_TYPE.GUARANTEE) {
    return _typeMismatch(referenceId, "GUARANTEE");
  }

  const isActive = base.verified && base.status === REFERENCE_STATUS.ACTIVE;

  // Guarantee-specific public block
  const guaranteeBlock = guaranteePolicy
    ? buildGuaranteePublicVerification(guaranteePolicy, {
        referenceId,
        verificationUrl: base.verificationUrl,
      })
    : null;

  return {
    lookupType:         "GUARANTEE",
    referenceId:        base.referenceId,
    status:             base.status,
    verified:           base.verified,
    issuedAt:           base.issuedAt,
    expiresAt:          base.expiresAt,
    revokedAt:          base.revokedAt || null,
    verificationUrl:    base.verificationUrl,
    // Guarantee-specific (public-safe only)
    coverageType:       isActive ? "authenticity" : null,
    coverageActive:     isActive,
    startAt:            guaranteeBlock?.startAt || base.issuedAt,
    guaranteeExpiresAt: guaranteeBlock?.expiresAt || null,
    claimable:          isActive,
    exclusionsSummary:  isActive ? guaranteeBlock?.exclusionsSummary : null,
    claimInstructions:  isActive ? guaranteeBlock?.claimInstructions : null,
    // NO coverage amount on public page
    auditHash:          base.auditHash,
    disclaimer:         guaranteeBlock?.disclaimer || base.disclaimer,
    lookedUpAt:         Date.now(),
    lookupVersion:      VERIFICATION_LOOKUP_VERSION,
  };
}

// ── Generic lookup dispatcher ─────────────────────────────────────────────────

/**
 * Dispatch to the correct lookup function based on referenceType found in the record.
 * Used by the generic /verify/:type/:referenceId handler.
 */
export async function dispatchVerificationLookup(redis, referenceId, opts = {}) {
  const record = await getExternalReference(redis, referenceId);
  if (!record) return _notFound(referenceId, "UNKNOWN");

  switch (record.referenceType) {
    case REFERENCE_TYPE.ITEM_VERIFICATION:
    case REFERENCE_TYPE.TRUSTMARK:
      return buildItemVerificationLookup(redis, referenceId, opts);
    case REFERENCE_TYPE.RESELLER_CERT:
      return buildResellerVerificationLookup(redis, referenceId, opts);
    case REFERENCE_TYPE.GUARANTEE:
      return buildGuaranteeVerificationLookup(redis, referenceId, opts);
    default:
      return _notFound(referenceId, record.referenceType);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _notFound(referenceId, expectedType) {
  return {
    lookupType:    expectedType,
    referenceId,
    status:        "NOT_FOUND",
    verified:      false,
    disclaimer:    "This reference ID was not found. The credential may not exist or may have been removed.",
    lookedUpAt:    Date.now(),
    lookupVersion: VERIFICATION_LOOKUP_VERSION,
  };
}

function _typeMismatch(referenceId, expectedType) {
  return {
    lookupType:    expectedType,
    referenceId,
    status:        "TYPE_MISMATCH",
    verified:      false,
    disclaimer:    "This reference ID is not of the expected credential type.",
    lookedUpAt:    Date.now(),
    lookupVersion: VERIFICATION_LOOKUP_VERSION,
  };
}
