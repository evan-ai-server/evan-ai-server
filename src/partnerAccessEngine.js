// src/partnerAccessEngine.js
// Phase 7 — Partner Access & Permission Model.
//
// Defines what each partner class can see, call, and export from Evan's systems.
// Institutional distribution requires explicit access control — every partner
// interaction must resolve against a policy before data leaves Evan.
//
// Partner types (distinct trust/access levels):
//   MARKETPLACE          — listing/seller verification integrations
//   INSURANCE            — underwriting, claims support
//   LENDER               — pawn/collateral valuation
//   RETAILER             — fraud detection, returns processing
//   CONSIGNMENT          — intake verification, item authentication
//   INTERNAL_OPS         — Evan internal tools, ops, review dashboards
//   PUBLIC_ANONYMOUS     — unauthenticated public /verify/* lookups
//
// Access control model:
//   - Each partner type has an allowedEndpoints list
//   - Each field class (trust score, model detail, etc.) has an exposure level
//   - filterPayloadForPartner() removes all fields the partner cannot see
//   - rateLimits and contractRequired are infrastructure signals for Phase 8
//
// Non-negotiables:
//   1. Public anonymous access is always the most restricted.
//   2. Insurance and lender access never exposes internal model scores.
//   3. deniedFields are absolute blocks — no override.
//   4. All access policy objects carry policyVersion.

export const PARTNER_TYPE = {
  MARKETPLACE:     "MARKETPLACE",
  INSURANCE:       "INSURANCE",
  LENDER:          "LENDER",
  RETAILER:        "RETAILER",
  CONSIGNMENT:     "CONSIGNMENT",
  INTERNAL_OPS:    "INTERNAL_OPS",
  PUBLIC_ANONYMOUS:"PUBLIC_ANONYMOUS",
};

export const PARTNER_ACCESS_VERSION = "7.0";

// ── Field exposure classification ─────────────────────────────────────────────
//
// Every field in Evan's trust outputs falls into one of:
//   PUBLIC       — safe for all partners and public pages
//   PARTNER      — safe for contracted partners; not public
//   PRIVILEGED   — safe only for specific partner classes + internal
//   INTERNAL     — never leaves Evan to external partners

export const FIELD_CLASS = {
  PUBLIC:    "PUBLIC",
  PARTNER:   "PARTNER",
  PRIVILEGED:"PRIVILEGED",
  INTERNAL:  "INTERNAL",
};

// Maps field paths to their exposure classification.
// Used by filterPayloadForPartner() to strip unsafe fields.
const FIELD_EXPOSURE_MAP = {
  // ── Always public ──────────────────────────────────────────
  "referenceId":              FIELD_CLASS.PUBLIC,
  "referenceType":            FIELD_CLASS.PUBLIC,
  "status":                   FIELD_CLASS.PUBLIC,
  "verified":                 FIELD_CLASS.PUBLIC,
  "issuedAt":                 FIELD_CLASS.PUBLIC,
  "expiresAt":                FIELD_CLASS.PUBLIC,
  "revokedAt":                FIELD_CLASS.PUBLIC,
  "verificationUrl":          FIELD_CLASS.PUBLIC,
  "summary":                  FIELD_CLASS.PUBLIC,
  "disclaimer":               FIELD_CLASS.PUBLIC,
  "auditHash":                FIELD_CLASS.PUBLIC,
  "category":                 FIELD_CLASS.PUBLIC,
  "brand":                    FIELD_CLASS.PUBLIC,

  // ── Partner-safe (not public) ──────────────────────────────
  "evidenceLevel":            FIELD_CLASS.PARTNER,
  "evidenceSummary":          FIELD_CLASS.PARTNER,
  "certificationStatus":      FIELD_CLASS.PARTNER,
  "certificationTier":        FIELD_CLASS.PARTNER,
  "dealIQBand":               FIELD_CLASS.PARTNER,
  "categorySpecialties":      FIELD_CLASS.PARTNER,
  "trustLevel":               FIELD_CLASS.PARTNER,
  "riskLevel":                FIELD_CLASS.PARTNER,
  "scamFlagged":              FIELD_CLASS.PARTNER,
  "guaranteeStatus":          FIELD_CLASS.PARTNER,
  "coverageType":             FIELD_CLASS.PARTNER,
  "maxCoverage":              FIELD_CLASS.PARTNER,
  "claimInstructions":        FIELD_CLASS.PARTNER,
  "exclusionsSummary":        FIELD_CLASS.PARTNER,
  "priceFloor":               FIELD_CLASS.PARTNER,
  "priceCeiling":             FIELD_CLASS.PARTNER,
  "marketMedian":             FIELD_CLASS.PARTNER,
  "confidence":               FIELD_CLASS.PARTNER,
  "dataSource":               FIELD_CLASS.PARTNER,
  "soldsFound":               FIELD_CLASS.PARTNER,
  "recommendedPlatform":      FIELD_CLASS.PARTNER,
  "routeConfidence":          FIELD_CLASS.PARTNER,
  "netExpected":              FIELD_CLASS.PARTNER,
  "expectedDaysToSale":       FIELD_CLASS.PARTNER,

  // ── Privileged (specific partner classes only) ─────────────
  "dealIQScore":              FIELD_CLASS.PRIVILEGED,   // raw score — lender only
  "counterpartyRisk":         FIELD_CLASS.PRIVILEGED,   // risk float — insurance/lender
  "disputeRate":              FIELD_CLASS.PRIVILEGED,   // lender/insurance
  "authMismatchRate":         FIELD_CLASS.PRIVILEGED,   // insurance/consignment
  "routeAccuracy":            FIELD_CLASS.PRIVILEGED,   // partner API

  // ── Internal only — NEVER external ────────────────────────
  "rawTrustScore":            FIELD_CLASS.INTERNAL,
  "authScore":                FIELD_CLASS.INTERNAL,
  "counterfeitMatchScore":    FIELD_CLASS.INTERNAL,
  "modelVersion":             FIELD_CLASS.INTERNAL,
  "visionPassCount":          FIELD_CLASS.INTERNAL,
  "oracleDecision":           FIELD_CLASS.INTERNAL,
  "oracleRawScores":          FIELD_CLASS.INTERNAL,
  "categoryRuleThresholds":   FIELD_CLASS.INTERNAL,
  "signalDebug":              FIELD_CLASS.INTERNAL,
  "internalNotes":            FIELD_CLASS.INTERNAL,
  "expertReviewQueue":        FIELD_CLASS.INTERNAL,
  "counterfeitPatternDetails":FIELD_CLASS.INTERNAL,
  "decayWeights":             FIELD_CLASS.INTERNAL,
};

// ── Per-partner access policies ───────────────────────────────────────────────

const PARTNER_POLICIES = {
  [PARTNER_TYPE.PUBLIC_ANONYMOUS]: {
    partnerType:          PARTNER_TYPE.PUBLIC_ANONYMOUS,
    displayName:          "Public / Anonymous",
    allowedEndpoints: [
      "GET /verify/item/:referenceId",
      "GET /verify/reseller/:referenceId",
      "GET /verify/guarantee/:referenceId",
    ],
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC],
    deniedFields: [
      "dealIQScore", "counterpartyRisk", "disputeRate", "authMismatchRate",
      "rawTrustScore", "authScore", "counterfeitMatchScore", "modelVersion",
    ],
    requiresContract:     false,
    requiresUserConsent:  false,
    requiresCertification:false,
    allowedUseCases:      ["verification_lookup"],
    retentionPolicy:      "no_storage",      // must not store lookup results
    rateLimits:           { perMinute: 30, perDay: 500 },
    auditRequired:        false,
    policyVersion:        PARTNER_ACCESS_VERSION,
  },

  [PARTNER_TYPE.MARKETPLACE]: {
    partnerType:          PARTNER_TYPE.MARKETPLACE,
    displayName:          "Marketplace Partner",
    allowedEndpoints: [
      "POST /api/b2b/trust-verify",
      "POST /api/b2b/seller-risk",
      "POST /api/b2b/valuate",
      "GET  /verify/item/:referenceId",
      "GET  /verify/reseller/:referenceId",
      "POST /api/b2b/route-recommend",
    ],
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC, FIELD_CLASS.PARTNER],
    deniedFields: [
      "dealIQScore", "rawTrustScore", "authScore", "counterfeitMatchScore",
      "modelVersion", "categoryRuleThresholds", "oracleDecision", "oracleRawScores",
      "decayWeights",
    ],
    requiresContract:     true,
    requiresUserConsent:  false,    // seller consents during onboarding
    requiresCertification:false,
    allowedUseCases:      ["seller_verification", "listing_trust", "valuation", "routing"],
    retentionPolicy:      "90_days",
    rateLimits:           { perMinute: 120, perDay: 10000 },
    auditRequired:        true,
    policyVersion:        PARTNER_ACCESS_VERSION,
  },

  [PARTNER_TYPE.INSURANCE]: {
    partnerType:          PARTNER_TYPE.INSURANCE,
    displayName:          "Insurance Partner",
    allowedEndpoints: [
      "POST /api/b2b/trust-verify",
      "POST /api/b2b/valuate",
      "GET  /verify/item/:referenceId",
      "POST /api/institutional/insurance-valuation",
      "POST /api/institutional/portable-trust-packet",
    ],
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC, FIELD_CLASS.PARTNER, FIELD_CLASS.PRIVILEGED],
    deniedFields: [
      "rawTrustScore", "authScore", "counterfeitMatchScore", "modelVersion",
      "oracleDecision", "oracleRawScores", "categoryRuleThresholds", "decayWeights",
    ],
    requiresContract:     true,
    requiresUserConsent:  true,     // user must consent to insurance data share
    requiresCertification:false,
    allowedUseCases:      ["underwriting", "claim_support", "valuation", "fraud_detection"],
    retentionPolicy:      "7_years",   // insurance regulatory requirement
    rateLimits:           { perMinute: 60, perDay: 5000 },
    auditRequired:        true,
    policyVersion:        PARTNER_ACCESS_VERSION,
  },

  [PARTNER_TYPE.LENDER]: {
    partnerType:          PARTNER_TYPE.LENDER,
    displayName:          "Lender / Pawn Partner",
    allowedEndpoints: [
      "POST /api/b2b/trust-verify",
      "POST /api/b2b/valuate",
      "POST /api/b2b/seller-risk",
      "GET  /verify/item/:referenceId",
      "POST /api/institutional/lender-valuation",
    ],
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC, FIELD_CLASS.PARTNER, FIELD_CLASS.PRIVILEGED],
    deniedFields: [
      "rawTrustScore", "authScore", "counterfeitMatchScore", "modelVersion",
      "oracleDecision", "oracleRawScores", "categoryRuleThresholds", "decayWeights",
    ],
    requiresContract:     true,
    requiresUserConsent:  true,
    requiresCertification:false,
    allowedUseCases:      ["collateral_valuation", "borrower_risk", "item_authentication"],
    retentionPolicy:      "7_years",
    rateLimits:           { perMinute: 30, perDay: 2000 },
    auditRequired:        true,
    policyVersion:        PARTNER_ACCESS_VERSION,
  },

  [PARTNER_TYPE.RETAILER]: {
    partnerType:          PARTNER_TYPE.RETAILER,
    displayName:          "Retailer / Returns Partner",
    allowedEndpoints: [
      "POST /api/b2b/trust-verify",
      "POST /api/institutional/retailer-fraud-signal",
      "GET  /verify/item/:referenceId",
    ],
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC, FIELD_CLASS.PARTNER],
    deniedFields: [
      "dealIQScore", "dealIQBand", "rawTrustScore", "authScore", "counterfeitMatchScore",
      "modelVersion", "categoryRuleThresholds",
    ],
    requiresContract:     true,
    requiresUserConsent:  false,
    requiresCertification:false,
    allowedUseCases:      ["returns_fraud", "item_verification", "resale_intelligence"],
    retentionPolicy:      "90_days",
    rateLimits:           { perMinute: 60, perDay: 5000 },
    auditRequired:        false,
    policyVersion:        PARTNER_ACCESS_VERSION,
  },

  [PARTNER_TYPE.CONSIGNMENT]: {
    partnerType:          PARTNER_TYPE.CONSIGNMENT,
    displayName:          "Consignment Partner",
    allowedEndpoints: [
      "POST /api/b2b/trust-verify",
      "POST /api/b2b/valuate",
      "POST /api/institutional/consignment-intake",
      "GET  /verify/item/:referenceId",
    ],
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC, FIELD_CLASS.PARTNER],
    deniedFields: [
      "rawTrustScore", "authScore", "counterfeitMatchScore", "modelVersion",
      "categoryRuleThresholds", "oracleDecision",
    ],
    requiresContract:     true,
    requiresUserConsent:  false,
    requiresCertification:false,
    allowedUseCases:      ["intake_verification", "valuation", "seller_trust"],
    retentionPolicy:      "2_years",
    rateLimits:           { perMinute: 60, perDay: 5000 },
    auditRequired:        true,
    policyVersion:        PARTNER_ACCESS_VERSION,
  },

  [PARTNER_TYPE.INTERNAL_OPS]: {
    partnerType:          PARTNER_TYPE.INTERNAL_OPS,
    displayName:          "Internal Ops",
    allowedEndpoints:     ["*"],   // all internal endpoints
    allowedFieldClasses:  [FIELD_CLASS.PUBLIC, FIELD_CLASS.PARTNER, FIELD_CLASS.PRIVILEGED, FIELD_CLASS.INTERNAL],
    deniedFields:         [],      // nothing denied internally
    requiresContract:     false,
    requiresUserConsent:  false,
    requiresCertification:false,
    allowedUseCases:      ["*"],
    retentionPolicy:      "indefinite",
    rateLimits:           { perMinute: 1000, perDay: 100000 },
    auditRequired:        true,    // internal ops are still audited
    policyVersion:        PARTNER_ACCESS_VERSION,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the full access policy for a partner type.
 */
export function getPartnerAccessPolicy(partnerType) {
  return PARTNER_POLICIES[partnerType] || null;
}

/**
 * Get all partner access policies.
 */
export function getAllPartnerPolicies() {
  return Object.values(PARTNER_POLICIES);
}

/**
 * Check if a partner can access a specific field.
 * Returns { allowed, fieldClass, reason }
 */
export function checkFieldAccess(partnerType, fieldPath) {
  const policy = PARTNER_POLICIES[partnerType];
  if (!policy) return { allowed: false, reason: "unknown_partner_type" };

  // Absolute denied fields
  if (policy.deniedFields.includes(fieldPath)) {
    return { allowed: false, fieldClass: FIELD_CLASS.INTERNAL, reason: "field_denied" };
  }

  const fieldClass = FIELD_EXPOSURE_MAP[fieldPath] || FIELD_CLASS.PARTNER;
  const allowed    = policy.allowedFieldClasses.includes(fieldClass);

  return {
    allowed,
    fieldClass,
    reason: allowed ? null : `field_class_${fieldClass}_not_allowed`,
  };
}

/**
 * Filter a payload object, removing all fields the partner cannot access.
 * Recursively handles nested objects.
 * Does NOT handle deep-nested arrays of objects — treat as opaque if complex.
 *
 * @param {object} payload
 * @param {string} partnerType
 * @returns {object} filtered payload
 */
export function filterPayloadForPartner(payload, partnerType) {
  if (!payload || typeof payload !== "object") return payload;
  const policy = PARTNER_POLICIES[partnerType];
  if (!policy) return {};
  if (partnerType === PARTNER_TYPE.INTERNAL_OPS) return payload; // no filtering for internal

  const filtered = {};
  for (const [key, value] of Object.entries(payload)) {
    const { allowed } = checkFieldAccess(partnerType, key);
    if (allowed) {
      // Recursively filter nested objects but not arrays (preserve arrays as-is)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        filtered[key] = filterPayloadForPartner(value, partnerType);
      } else {
        filtered[key] = value;
      }
    }
  }
  return filtered;
}

/**
 * Check if a partner can access an endpoint.
 */
export function checkEndpointAccess(partnerType, endpoint) {
  const policy = PARTNER_POLICIES[partnerType];
  if (!policy) return { allowed: false, reason: "unknown_partner_type" };
  if (policy.allowedEndpoints.includes("*")) return { allowed: true };

  const allowed = policy.allowedEndpoints.some(allowed => {
    // Simple substring match on path pattern
    const pattern = allowed.replace(/^(GET|POST|PUT|DELETE)\s+/i, "");
    const method  = allowed.match(/^(GET|POST|PUT|DELETE)/i)?.[1]?.toUpperCase();
    const [reqMethod, reqPath] = endpoint.split(" ");
    if (method && method !== (reqMethod || "").toUpperCase()) return false;
    // Replace :param with wildcard match
    const regexStr = pattern.replace(/:[\w]+/g, "[^/]+");
    const regex    = new RegExp(`^${regexStr}$`);
    return regex.test(reqPath || endpoint);
  });

  return {
    allowed,
    reason: allowed ? null : "endpoint_not_allowed",
    policy: {
      requiresContract:     policy.requiresContract,
      requiresUserConsent:  policy.requiresUserConsent,
    },
  };
}
