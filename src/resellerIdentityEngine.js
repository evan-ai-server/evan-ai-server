// src/resellerIdentityEngine.js
// Phase 7 — Reseller Identity Layer + Public Profile Foundation.
//
// Creates a first-class professional identity for high-trust resellers.
// This is NOT social fluff — it's a verifiable professional credential layer:
//   - Portable identity across platforms
//   - Externally verifiable status
//   - Increases switching costs: resellers build reputation inside Evan
//   - Foundation for marketplace co-sell, partner underwriting, B2B trust
//
// Two layers:
//   1. resellerIdentityProfile — full internal identity record (all data)
//   2. publicResellerProfile   — public-safe subset for /verify/reseller/:id
//
// DealIQ band (for public display — never raw score):
//   A  — 85-100: elite track record
//   B  — 70-84:  solid, certified performance
//   C  — 55-69:  developing track record
//   D  — <55:    insufficient or weak history
//
// Redis key layout:
//   rid:profile:{userId}       STRING  full identity profile (2yr TTL, refreshed)
//   rid:public:{userId}        STRING  public-safe profile (24hr cache, refreshed)
//   rid:ops                    HASH    ops counters

import crypto from "crypto";
import { CERT_STATUS, CERT_TIER } from "./resellerCertificationEngine.js";

export const IDENTITY_VERSION = "7.0";

export const TRUST_LEVEL = {
  ELITE:          "ELITE",
  HIGH:           "HIGH",
  ESTABLISHED:    "ESTABLISHED",
  BUILDING:       "BUILDING",
  INSUFFICIENT:   "INSUFFICIENT",
};

export const DEALIQ_BAND = {
  A: "A",   // 85-100
  B: "B",   // 70-84
  C: "C",   // 55-69
  D: "D",   // < 55
};

const PROFILE_TTL     = 2 * 365 * 86400;   // 2 years
const PUBLIC_CACHE_TTL = 24 * 3600;         // 24 hours

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_PROFILE = userId => `rid:profile:${_safeKey(userId)}`;
const KEY_PUBLIC  = userId => `rid:public:${_safeKey(userId)}`;
const KEY_OPS     = ()     => `rid:ops`;

// ── Build / update identity profile ──────────────────────────────────────────

/**
 * Build and persist the full reseller identity profile for a user.
 * Called whenever certification, verification history, or outcome data changes.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts
 *   certRecord          {object|null}    — from getCertificationRecord()
 *   verificationHistory {Array}          — from getUserVerificationHistory()
 *   outcomeMetrics      {object|null}    — from getPlatformLeverageMetrics() or similar
 *   trustHistorySummary {object|null}    — from trustHistoryEngine
 *   displayName         {string|null}    — user-set display name
 *   categorySpecialties {string[]}       — detected from cert/history
 *   guaranteeHistory    {object|null}    — summary of guarantee/claim history
 * @returns {Promise<{ ok, profile? }>}
 */
export async function buildResellerIdentityProfile(redis, userId, {
  certRecord          = null,
  verificationHistory = [],
  outcomeMetrics      = null,
  trustHistorySummary = null,
  displayName         = null,
  categorySpecialties = [],
  guaranteeHistory    = null,
} = {}) {
  if (!redis || !userId) {
    return { ok: false, error: "missing_required" };
  }

  try {
    const now = Date.now();

    const certStatus = certRecord?.status || CERT_STATUS.NONE;
    const certTier   = certRecord?.tier   || CERT_TIER.NONE;
    const dealIQ     = certRecord?.dealIQ || null;
    const dealIQScore = dealIQ?.overallScore ?? null;
    const dealIQBandValue = _scoreToBand(dealIQScore);

    // Revocation flags — critical for external trust
    const revocationFlags = _computeRevocationFlags(certRecord, verificationHistory);

    // Trust level from cert + DealIQ
    const trustLevel = _computeTrustLevel(certStatus, certTier, dealIQScore, revocationFlags);

    // Public profile eligibility
    const publicEligible = _isPublicEligible(certStatus, revocationFlags, trustLevel);

    // Badge set — what this reseller can display
    const badgeSet = _computeBadgeSet(certStatus, certTier, dealIQBandValue, categorySpecialties, trustLevel);

    const profile = {
      resellerId:             userId,
      displayName:            displayName || null,
      certificationStatus:    certStatus,
      certificationTier:      certTier,
      certifiedAt:            certRecord?.certifiedAt || null,
      expiresAt:              certRecord?.expiresAt   || null,
      dealIQ: {
        band:                 dealIQBandValue,
        // Never store raw score in identity profile — only band
        lastUpdated:          certRecord?.evaluatedAt || null,
      },
      categorySpecialties,
      trustLevel,
      publicProfileEligible:  publicEligible,
      badgeSet,
      revocationFlags,
      // Summary counts — never raw event arrays
      verificationHistory: {
        totalVerified:        verificationHistory.filter(v => v?.status === "VERIFIED").length,
        totalScans:           verificationHistory.length,
        lastVerifiedAt:       verificationHistory[0]?.verifiedAt || null,
      },
      guaranteeHistory: {
        totalPoliciesIssued:  guaranteeHistory?.totalIssued  || 0,
        totalClaimsApproved:  guaranteeHistory?.totalClaimed || 0,
        claimRate:            guaranteeHistory?.claimRate    || 0,
      },
      outcomeTrackRecord: outcomeMetrics ? {
        platformsUsed:        Object.keys(outcomeMetrics).length,
        dataQualityBand:      _bestDataQuality(outcomeMetrics),
        // No raw net errors or route accuracy floats for external use
      } : null,
      trustHistorySummary: trustHistorySummary ? {
        totalEvents:          trustHistorySummary.totalEvents || 0,
        revocations:          trustHistorySummary.revocations || 0,
        disputes:             trustHistorySummary.disputes    || 0,
      } : null,
      updatedAt:              now,
      identityVersion:        IDENTITY_VERSION,
    };

    await redis.set(KEY_PROFILE(userId), JSON.stringify(profile), { EX: PROFILE_TTL });
    await redis.del(KEY_PUBLIC(userId));  // invalidate public cache
    await redis.hIncrBy(KEY_OPS(), "profiles_built", 1);

    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: "build_failed", reason: err?.message };
  }
}

/**
 * Get the full identity profile for a user.
 */
export async function getResellerIdentityProfile(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(KEY_PROFILE(userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Public profile ────────────────────────────────────────────────────────────

/**
 * Build and return the public-safe profile for a reseller.
 * This is served on /verify/reseller/:referenceId.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts
 *   referenceId       {string|null}   — extref referenceId
 *   verificationUrl   {string|null}   — verification URL
 *   publicTimeline    {Array}         — public timeline events
 * @returns {object} publicResellerProfile
 */
export async function buildPublicResellerProfile(redis, userId, {
  referenceId     = null,
  verificationUrl = null,
  publicTimeline  = [],
} = {}) {
  if (!redis || !userId) return null;

  // Check cache
  try {
    const cached = await redis.get(KEY_PUBLIC(userId));
    if (cached) return JSON.parse(cached);
  } catch {}

  const profile = await getResellerIdentityProfile(redis, userId);
  if (!profile || !profile.publicProfileEligible) return null;

  const publicProfile = {
    resellerReferenceId:  referenceId,
    displayName:          profile.displayName || null,
    certificationStatus:  profile.certificationStatus,
    certificationTier:    profile.certificationTier,
    certifiedAt:          profile.certifiedAt,
    expiresAt:            profile.expiresAt,
    dealIQBand:           profile.dealIQ.band,
    categorySpecialties:  profile.categorySpecialties,
    trustLevel:           profile.trustLevel,
    badgeSet:             profile.badgeSet,
    // Aggregated counts — never individual scan records
    verifiedTransactionsCount: profile.verificationHistory.totalVerified,
    guaranteeClaimRateBand:   _claimRateToBand(profile.guaranteeHistory.claimRate),
    outcomeTrackRecordSummary: profile.outcomeTrackRecord?.dataQualityBand || null,
    // Timeline (public events only)
    recentTrustEvents:    (publicTimeline || []).slice(0, 5),
    profileVisibility:    "PUBLIC",
    verificationUrl,
    disclaimers: [
      "This profile reflects Evan AI's assessment at time of publication. Status may change.",
      "Certification and track record data is based on verified activity within Evan's platform.",
    ],
    generatedAt:    Date.now(),
    identityVersion: IDENTITY_VERSION,
  };

  try {
    await redis.set(KEY_PUBLIC(userId), JSON.stringify(publicProfile), { EX: PUBLIC_CACHE_TTL });
  } catch {}

  return publicProfile;
}

// ── Ops ───────────────────────────────────────────────────────────────────────

export async function getIdentityOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      profilesBuilt:  ops["profiles_built"] || 0,
      publicViews:    ops["public_views"]    || 0,
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _scoreToBand(score) {
  if (score == null) return null;
  if (score >= 85)   return DEALIQ_BAND.A;
  if (score >= 70)   return DEALIQ_BAND.B;
  if (score >= 55)   return DEALIQ_BAND.C;
  return DEALIQ_BAND.D;
}

function _computeTrustLevel(certStatus, certTier, dealIQScore, revocationFlags) {
  if (revocationFlags.hasActiveRevocation || revocationFlags.hasCounterfeitHistory) {
    return TRUST_LEVEL.INSUFFICIENT;
  }
  if (certStatus === CERT_STATUS.CERTIFIED && certTier === CERT_TIER.ELITE && dealIQScore >= 85) {
    return TRUST_LEVEL.ELITE;
  }
  if (certStatus === CERT_STATUS.CERTIFIED && (certTier === CERT_TIER.CERTIFIED_PLUS || dealIQScore >= 70)) {
    return TRUST_LEVEL.HIGH;
  }
  if (certStatus === CERT_STATUS.CERTIFIED) {
    return TRUST_LEVEL.ESTABLISHED;
  }
  if (certStatus === CERT_STATUS.PROBATION) {
    return TRUST_LEVEL.BUILDING;
  }
  return TRUST_LEVEL.INSUFFICIENT;
}

function _isPublicEligible(certStatus, revocationFlags, trustLevel) {
  if (revocationFlags.hasActiveRevocation) return false;
  if (revocationFlags.hasCounterfeitHistory) return false;
  if (certStatus === CERT_STATUS.INELIGIBLE) return false;
  return trustLevel === TRUST_LEVEL.ELITE ||
         trustLevel === TRUST_LEVEL.HIGH  ||
         trustLevel === TRUST_LEVEL.ESTABLISHED;
}

function _computeRevocationFlags(certRecord, verificationHistory) {
  const revocations   = (verificationHistory || []).filter(v => v?.status === "REVOKED");
  const counterfeits  = (verificationHistory || []).filter(v => v?.hadCounterfeitConfirm);
  return {
    hasActiveRevocation:    certRecord?.status === CERT_STATUS.INELIGIBLE,
    hasPastRevocation:      revocations.length > 0,
    hasCounterfeitHistory:  counterfeits.length > 0,
    revocationCount:        revocations.length,
  };
}

function _computeBadgeSet(certStatus, certTier, dealIQBand, categorySpecialties, trustLevel) {
  const badges = [];
  if (certStatus === CERT_STATUS.CERTIFIED) {
    badges.push("EVAN_CERTIFIED");
    if (dealIQBand === DEALIQ_BAND.A || dealIQBand === DEALIQ_BAND.B) {
      badges.push("DEALIQ_BAND");
    }
    if (categorySpecialties.length > 0) {
      badges.push("CATEGORY_SPECIALIST");
    }
    if (trustLevel === TRUST_LEVEL.ELITE || trustLevel === TRUST_LEVEL.HIGH) {
      badges.push("TRUSTED_RESELLER");
    }
  }
  return badges;
}

function _bestDataQuality(outcomeMetrics) {
  if (!outcomeMetrics) return null;
  const qualities = Object.values(outcomeMetrics).map(m => m?.dataQuality);
  if (qualities.includes("RICH"))     return "RICH";
  if (qualities.includes("MODERATE")) return "MODERATE";
  if (qualities.includes("SPARSE"))   return "SPARSE";
  return "INSUFFICIENT";
}

function _claimRateToBand(rate) {
  if (rate == null) return null;
  if (rate === 0)    return "ZERO";
  if (rate <= 0.02)  return "VERY_LOW";
  if (rate <= 0.05)  return "LOW";
  if (rate <= 0.10)  return "MODERATE";
  return "HIGH";
}

function _safeKey(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
