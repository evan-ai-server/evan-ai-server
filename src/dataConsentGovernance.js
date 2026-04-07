// src/dataConsentGovernance.js
// Phase 7 — User Consent + Data Portability Governance.
//
// Because Phase 7 touches external usage of user-generated trust data,
// consent and portability rules must be explicit. Every data type must
// have a clear answer to:
//   - Can this data be used externally?
//   - Does the user need to consent first?
//   - Which partner classes can see it?
//   - Can the user revoke consent / request deletion?
//   - Is this data anonymizable?
//
// This is not a compliance system — it's a structural policy layer that
// makes consent decisions consistent across the entire external trust stack.
//
// Data types covered:
//   VERIFICATION_RECORD     — item scan/auth result (user-generated)
//   TRUSTMARK               — issued external credential
//   CERTIFICATION_STATUS    — reseller certification + tier
//   DEALIQ_SCORE            — DealIQ professional score
//   GUARANTEE_POLICY        — issued guarantee policy
//   CLAIM_RECORD            — filed dispute/claim
//   ROUTE_OUTCOME           — actual sale outcome (user-reported)
//   COUNTERPARTY_RECORD     — seller risk record (about another party)
//   IDENTITY_PROFILE        — reseller identity + public profile
//   TIMELINE_EVENTS         — trust timeline history
//   PRICE_FLOOR_DATA        — aggregated price data (contributed)
//   ECOSYSTEM_METRICS       — aggregate platform metrics

export const CONSENT_VERSION = "7.0";

export const DATA_TYPE = {
  VERIFICATION_RECORD:  "VERIFICATION_RECORD",
  TRUSTMARK:            "TRUSTMARK",
  CERTIFICATION_STATUS: "CERTIFICATION_STATUS",
  DEALIQ_SCORE:         "DEALIQ_SCORE",
  GUARANTEE_POLICY:     "GUARANTEE_POLICY",
  CLAIM_RECORD:         "CLAIM_RECORD",
  ROUTE_OUTCOME:        "ROUTE_OUTCOME",
  COUNTERPARTY_RECORD:  "COUNTERPARTY_RECORD",
  IDENTITY_PROFILE:     "IDENTITY_PROFILE",
  TIMELINE_EVENTS:      "TIMELINE_EVENTS",
  PRICE_FLOOR_DATA:     "PRICE_FLOOR_DATA",
  ECOSYSTEM_METRICS:    "ECOSYSTEM_METRICS",
};

export const EXPORTABILITY = {
  PUBLIC:         "PUBLIC",         // can appear on public pages
  PARTNER_SAFE:   "PARTNER_SAFE",   // can be sent to contracted partners
  CONSENT_GATED:  "CONSENT_GATED",  // requires explicit user consent for each export
  INTERNAL_ONLY:  "INTERNAL_ONLY",  // never exported outside Evan systems
  ANONYMIZED_OK:  "ANONYMIZED_OK",  // can be exported only if anonymized/aggregated
};

// ── Consent policy definitions ────────────────────────────────────────────────

const CONSENT_POLICIES = {
  [DATA_TYPE.VERIFICATION_RECORD]: {
    dataType:                DATA_TYPE.VERIFICATION_RECORD,
    description:             "Item authentication/verification result including trust evidence.",
    externalUseAllowed:      true,
    explicitConsentRequired: false,   // user implicitly consents by scanning and requesting verification
    partnerClassesAllowed:   ["MARKETPLACE", "CONSIGNMENT", "INSURANCE", "LENDER"],
    revocableByUser:         true,    // user can request deletion of their scan record
    retentionLimit:          "2_years",
    exportability:           EXPORTABILITY.PARTNER_SAFE,
    anonymizable:            false,   // verification is item-specific, not anonymizable
    publicSafeFields:        ["status", "evidenceLevel", "category", "brand", "referenceId", "verificationUrl"],
    internalOnlyFields:      ["rawTrustScore", "authScore", "counterfeitMatchScore", "modelVersion", "oracleDecision"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.TRUSTMARK]: {
    dataType:                DATA_TYPE.TRUSTMARK,
    description:             "External trustmark credential issued for a verified item.",
    externalUseAllowed:      true,
    explicitConsentRequired: false,   // trustmark is explicitly intended to be external
    partnerClassesAllowed:   ["MARKETPLACE", "CONSIGNMENT", "INSURANCE", "LENDER", "AUTH_PROVIDER", "PUBLIC_ANONYMOUS"],
    revocableByUser:         false,   // trustmarks follow item evidence, not user preference
    retentionLimit:          "3_years",
    exportability:           EXPORTABILITY.PUBLIC,
    anonymizable:            false,
    publicSafeFields:        ["trustmarkId", "status", "issuedAt", "expiresAt", "revokedAt", "verificationUrl", "referenceId"],
    internalOnlyFields:      ["evidenceSnapshot", "verificationSummary.rawScores"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.CERTIFICATION_STATUS]: {
    dataType:                DATA_TYPE.CERTIFICATION_STATUS,
    description:             "Reseller certification status (CERTIFIED/PROBATION/etc.) and tier.",
    externalUseAllowed:      true,
    explicitConsentRequired: false,   // resellers consent during certification enrollment
    partnerClassesAllowed:   ["MARKETPLACE", "LENDER", "CONSIGNMENT"],
    revocableByUser:         false,   // certification is system-computed, not user-controlled
    retentionLimit:          "2_years",
    exportability:           EXPORTABILITY.PUBLIC,
    anonymizable:            false,
    publicSafeFields:        ["status", "tier", "certifiedAt", "expiresAt"],
    internalOnlyFields:      ["componentScores", "evaluationData", "disqualifyingEvents"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.DEALIQ_SCORE]: {
    dataType:                DATA_TYPE.DEALIQ_SCORE,
    description:             "DealIQ professional score (raw float and component breakdown).",
    externalUseAllowed:      true,    // but only band, never raw score
    explicitConsentRequired: true,    // for any external use beyond band display
    partnerClassesAllowed:   ["LENDER"],  // only lenders get band; raw score = never
    revocableByUser:         false,
    retentionLimit:          "2_years",
    exportability:           EXPORTABILITY.CONSENT_GATED,
    anonymizable:            false,
    publicSafeFields:        [],      // raw score never public — band is in certification_status
    internalOnlyFields:      ["overallScore", "componentScores", "signalAdherenceQuality", "authCallAccuracy"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.GUARANTEE_POLICY]: {
    dataType:                DATA_TYPE.GUARANTEE_POLICY,
    description:             "Issued guarantee policy with coverage amount and terms.",
    externalUseAllowed:      true,
    explicitConsentRequired: false,
    partnerClassesAllowed:   ["MARKETPLACE", "INSURANCE", "CONSIGNMENT", "PUBLIC_ANONYMOUS"],
    revocableByUser:         false,   // policies are system-issued; user cannot retract
    retentionLimit:          "3_years",
    exportability:           EXPORTABILITY.PARTNER_SAFE,
    anonymizable:            false,
    publicSafeFields:        ["status", "coverageType", "issuedAt", "expiresAt", "verificationUrl"],
    internalOnlyFields:      ["trustSnapshot", "guaranteeEligibility.rawScores", "coverageAmount"],  // amount = partner only
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.CLAIM_RECORD]: {
    dataType:                DATA_TYPE.CLAIM_RECORD,
    description:             "Filed dispute/claim record against a guarantee policy.",
    externalUseAllowed:      false,   // claims are private by default
    explicitConsentRequired: true,    // user must explicitly consent to share claim data
    partnerClassesAllowed:   ["INSURANCE"],  // only insurance with consent
    revocableByUser:         true,
    retentionLimit:          "5_years",  // legal retention requirement
    exportability:           EXPORTABILITY.CONSENT_GATED,
    anonymizable:            false,
    publicSafeFields:        [],
    internalOnlyFields:      ["claimId", "payout", "reviewer", "internalNotes", "adjudicationDetails"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.ROUTE_OUTCOME]: {
    dataType:                DATA_TYPE.ROUTE_OUTCOME,
    description:             "Actual sale outcome reported by user (platform, net proceeds, days to sale).",
    externalUseAllowed:      true,    // in aggregate only
    explicitConsentRequired: false,   // users consent when reporting outcomes
    partnerClassesAllowed:   [],      // no per-record partner access; aggregate only
    revocableByUser:         true,
    retentionLimit:          "2_years",
    exportability:           EXPORTABILITY.ANONYMIZED_OK,
    anonymizable:            true,    // can be exported as aggregate platform stats
    publicSafeFields:        [],      // no individual records public
    internalOnlyFields:      ["scanId", "actualNet", "expectedNet", "actualDays", "userId"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.COUNTERPARTY_RECORD]: {
    dataType:                DATA_TYPE.COUNTERPARTY_RECORD,
    description:             "Seller/buyer risk record (reported behavioral signals).",
    externalUseAllowed:      true,    // via b2b/seller-risk endpoint
    explicitConsentRequired: false,   // subject of record (the seller) does not consent
    partnerClassesAllowed:   ["MARKETPLACE", "LENDER"],
    revocableByUser:         false,   // counterparty records are about third parties
    retentionLimit:          "1_year",
    exportability:           EXPORTABILITY.PARTNER_SAFE,
    anonymizable:            false,
    publicSafeFields:        ["riskLevel", "scamFlagged"],
    internalOnlyFields:      ["events", "decayedRates", "sumNetError"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.IDENTITY_PROFILE]: {
    dataType:                DATA_TYPE.IDENTITY_PROFILE,
    description:             "Reseller identity profile including trust level, badges, and track record.",
    externalUseAllowed:      true,    // public profile is explicitly opt-in
    explicitConsentRequired: true,    // public profile requires explicit opt-in from user
    partnerClassesAllowed:   ["MARKETPLACE", "LENDER", "CONSIGNMENT"],
    revocableByUser:         true,    // user can make profile private
    retentionLimit:          "2_years",
    exportability:           EXPORTABILITY.CONSENT_GATED,
    anonymizable:            false,
    publicSafeFields:        ["displayName", "certificationStatus", "certificationTier", "dealIQBand", "categorySpecialties", "trustLevel", "badgeSet"],
    internalOnlyFields:      ["verificationHistory", "guaranteeHistory.rawClaims", "outcomeMetrics.rawData"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.TIMELINE_EVENTS]: {
    dataType:                DATA_TYPE.TIMELINE_EVENTS,
    description:             "Trust timeline events (verified issued, certified, revoked, etc.).",
    externalUseAllowed:      true,
    explicitConsentRequired: false,
    partnerClassesAllowed:   ["MARKETPLACE"],
    revocableByUser:         false,   // timeline is an audit record
    retentionLimit:          "2_years",
    exportability:           EXPORTABILITY.PARTNER_SAFE,
    anonymizable:            false,
    publicSafeFields:        ["eventType", "eventSummary", "changedAt"],
    internalOnlyFields:      ["metadata", "changedBy", "internalContext"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.PRICE_FLOOR_DATA]: {
    dataType:                DATA_TYPE.PRICE_FLOOR_DATA,
    description:             "Aggregated price floor / market data (contributed by user scans).",
    externalUseAllowed:      true,    // in aggregate only; never per-user
    explicitConsentRequired: false,
    partnerClassesAllowed:   ["MARKETPLACE", "INSURANCE", "LENDER", "CONSIGNMENT"],
    revocableByUser:         false,   // aggregate data cannot be individually revoked
    retentionLimit:          "indefinite",
    exportability:           EXPORTABILITY.ANONYMIZED_OK,
    anonymizable:            true,
    publicSafeFields:        ["category", "p10", "p25", "median", "sampleSize", "windowDays", "computedAt"],
    internalOnlyFields:      ["individualScanIds", "perUserData"],
    policyVersion:           CONSENT_VERSION,
  },

  [DATA_TYPE.ECOSYSTEM_METRICS]: {
    dataType:                DATA_TYPE.ECOSYSTEM_METRICS,
    description:             "Aggregate platform metrics (lookup counts, adoption signals, etc.).",
    externalUseAllowed:      true,
    explicitConsentRequired: false,
    partnerClassesAllowed:   ["INTERNAL_OPS"],
    revocableByUser:         false,
    retentionLimit:          "indefinite",
    exportability:           EXPORTABILITY.INTERNAL_ONLY,
    anonymizable:            true,
    publicSafeFields:        [],
    internalOnlyFields:      ["*"],
    policyVersion:           CONSENT_VERSION,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the consent policy for a data type.
 */
export function getConsentPolicy(dataType) {
  return CONSENT_POLICIES[dataType] || null;
}

/**
 * Get all consent policies.
 */
export function getAllConsentPolicies() {
  return Object.values(CONSENT_POLICIES);
}

/**
 * Check if a data type can be shared with a given partner class.
 * Returns { allowed, requiresConsent, exportability }
 */
export function checkDataSharePermission(dataType, partnerClass) {
  const policy = CONSENT_POLICIES[dataType];
  if (!policy) return { allowed: false, reason: "unknown_data_type" };

  if (!policy.externalUseAllowed) {
    return { allowed: false, reason: "external_use_not_allowed", requiresConsent: true };
  }

  const partnerAllowed = policy.partnerClassesAllowed.includes(partnerClass);
  if (!partnerAllowed) {
    return { allowed: false, reason: "partner_class_not_allowed" };
  }

  return {
    allowed:          true,
    requiresConsent:  policy.explicitConsentRequired,
    exportability:    policy.exportability,
    retentionLimit:   policy.retentionLimit,
  };
}

/**
 * Get the public-safe fields for a data type.
 * These are the ONLY fields that should appear on /verify/* pages.
 */
export function getPublicSafeFields(dataType) {
  return CONSENT_POLICIES[dataType]?.publicSafeFields || [];
}

/**
 * Get the internal-only fields for a data type.
 * These must NEVER appear in any external payload.
 */
export function getInternalOnlyFields(dataType) {
  return CONSENT_POLICIES[dataType]?.internalOnlyFields || [];
}

/**
 * Build a summary of all data export permissions for a given partner class.
 * Returns which data types they can access and under what conditions.
 */
export function getPartnerDataAccessSummary(partnerClass) {
  const accessible = [];
  const restricted = [];

  for (const policy of Object.values(CONSENT_POLICIES)) {
    const check = checkDataSharePermission(policy.dataType, partnerClass);
    if (check.allowed) {
      accessible.push({
        dataType:        policy.dataType,
        requiresConsent: check.requiresConsent,
        exportability:   check.exportability,
        retentionLimit:  check.retentionLimit,
      });
    } else {
      restricted.push({
        dataType: policy.dataType,
        reason:   check.reason,
      });
    }
  }

  return {
    partnerClass,
    accessible,
    restricted,
    policyVersion: CONSENT_VERSION,
  };
}
