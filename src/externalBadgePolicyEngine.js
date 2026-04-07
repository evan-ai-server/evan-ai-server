// src/externalBadgePolicyEngine.js
// Phase 7 — External Badge Policy Engine.
//
// Formalizes the display rules for every Evan-issued credential or badge:
//   - Who can receive it
//   - Where it can be displayed (public page, marketplace listing, partner API, etc.)
//   - What exact claim language is allowed
//   - What is prohibited
//   - Expiry / renewal behavior
//   - Revocation rules
//   - Whether a lookup is required before displaying
//
// Badge types:
//   EVAN_VERIFIED          — Item passed full Evan authentication
//   EVAN_CERTIFIED         — Reseller holds Evan-Certified status
//   DEALIQ_BAND            — DealIQ professional score band (not raw score)
//   GUARANTEE_COVERED      — Item has an active Evan guarantee policy
//   CATEGORY_SPECIALIST    — Certified reseller with dominant category focus
//   TRUSTED_RESELLER       — Reseller certified + clean dispute record
//   ROUTE_VERIFIED         — Routing recommendation backed by outcome data
//
// Non-negotiables:
//   1. Prohibited claims are hard blocks — no override possible.
//   2. requiresLookup = true means the badge must be verified in real-time.
//   3. Disclaimer text is required whenever disclaimerRequired = true.
//   4. All badge policies are versioned — consumers must check policyVersion.

export const BADGE_TYPE = {
  EVAN_VERIFIED:       "EVAN_VERIFIED",
  EVAN_CERTIFIED:      "EVAN_CERTIFIED",
  DEALIQ_BAND:         "DEALIQ_BAND",
  GUARANTEE_COVERED:   "GUARANTEE_COVERED",
  CATEGORY_SPECIALIST: "CATEGORY_SPECIALIST",
  TRUSTED_RESELLER:    "TRUSTED_RESELLER",
  ROUTE_VERIFIED:      "ROUTE_VERIFIED",
};

export const DISPLAY_CHANNEL = {
  PUBLIC_PAGE:          "PUBLIC_PAGE",
  MARKETPLACE_LISTING:  "MARKETPLACE_LISTING",
  SELLER_BIO:           "SELLER_BIO",
  PARTNER_API:          "PARTNER_API",
  INSURANCE_EXPORT:     "INSURANCE_EXPORT",
  LENDER_EXPORT:        "LENDER_EXPORT",
  INTERNAL_ONLY:        "INTERNAL_ONLY",
};

export const BADGE_POLICY_VERSION = "7.0";

// ── Badge policy definitions ──────────────────────────────────────────────────

const BADGE_POLICIES = {
  [BADGE_TYPE.EVAN_VERIFIED]: {
    badgeType:              BADGE_TYPE.EVAN_VERIFIED,
    displayName:            "Evan-Verified",
    description:            "Item passed Evan's multi-signal authentication analysis.",
    // Eligibility: only items with VERIFIED status from evanVerifiedEngine
    eligibilityRequires:    ["evanVerification.status === VERIFIED", "trustmark.status === ACTIVE"],
    // Where it can appear
    publicDisplayAllowed:   true,
    partnerDisplayAllowed:  true,
    marketplaceDisplayAllowed: true,
    insuranceExportAllowed: true,
    lenderExportAllowed:    true,
    // Lookup requirement
    requiresLookup:         true,   // MUST verify referenceId before displaying
    lookupEndpoint:         "/verify/item/:referenceId",
    // Timing
    validForDays:           90,     // per category default; watches may be shorter
    revocable:              true,
    expirable:              true,
    autoRenewable:          false,  // requires new scan
    // Language
    allowedClaimLanguage: [
      "Evan-Verified",
      "Authentication verified by Evan AI",
      "Verified authentic by Evan AI — see {verificationUrl}",
    ],
    prohibitedClaims: [
      "100% authentic",
      "Guaranteed authentic",
      "Certified authentic",
      "Authenticated by Evan",  // must say "Verified" not "Authenticated" standalone
      "Evan guarantees",        // guarantee is a separate credential
      "Evan certified",         // certification is reseller-only
    ],
    disclaimerRequired: true,
    disclaimer: "Evan-Verified reflects authentication evidence at time of scan and does not constitute an unconditional guarantee of authenticity.",
    policyVersion: BADGE_POLICY_VERSION,
  },

  [BADGE_TYPE.EVAN_CERTIFIED]: {
    badgeType:              BADGE_TYPE.EVAN_CERTIFIED,
    displayName:            "Evan-Certified Reseller",
    description:            "Reseller has demonstrated consistent, verifiable deal quality through Evan's platform.",
    eligibilityRequires:    ["certRecord.status === CERTIFIED", "certRecord.tier !== NONE"],
    publicDisplayAllowed:   true,
    partnerDisplayAllowed:  true,
    marketplaceDisplayAllowed: true,
    insuranceExportAllowed: false,   // certification is reseller, not item credential
    lenderExportAllowed:    true,    // lenders may want seller credibility
    requiresLookup:         true,
    lookupEndpoint:         "/verify/reseller/:referenceId",
    validForDays:           365,
    revocable:              true,
    expirable:              true,
    autoRenewable:          false,
    allowedClaimLanguage: [
      "Evan-Certified Reseller",
      "Certified by Evan AI",
      "Evan-Certified — see {verificationUrl}",
    ],
    prohibitedClaims: [
      "Evan-Verified",           // certification ≠ item verification
      "Guaranteed by Evan",
      "Evan-authenticated",
      "Evan 5-star seller",
      "Top Evan seller",         // tier labels not for external display
    ],
    disclaimerRequired: true,
    disclaimer: "Evan-Certified reflects behavioral history at time of certification. Certification may be updated or revoked based on subsequent activity.",
    policyVersion: BADGE_POLICY_VERSION,
  },

  [BADGE_TYPE.DEALIQ_BAND]: {
    badgeType:              BADGE_TYPE.DEALIQ_BAND,
    displayName:            "DealIQ",
    description:            "DealIQ band represents professional deal quality — shown as A/B/C/D band, never raw score.",
    eligibilityRequires:    ["certRecord.status === CERTIFIED", "certRecord.dealIQ.band !== null"],
    publicDisplayAllowed:   false,   // DealIQ band is NOT for public pages by default
    partnerDisplayAllowed:  true,    // partners with contract may see band
    marketplaceDisplayAllowed: false, // never on marketplace listings
    insuranceExportAllowed: false,
    lenderExportAllowed:    true,    // lenders may use it for underwriting
    requiresLookup:         true,
    lookupEndpoint:         "/verify/reseller/:referenceId",
    validForDays:           180,
    revocable:              true,
    expirable:              true,
    autoRenewable:          false,
    allowedClaimLanguage: [
      "DealIQ Band: {band}",
      "Evan DealIQ: {band}",
    ],
    prohibitedClaims: [
      "DealIQ Score: {rawScore}",  // never show raw float
      "Evan score: {rawScore}",
      "Top-rated",
      "5-star",
      "Evan-Verified",
    ],
    disclaimerRequired: true,
    disclaimer: "DealIQ band is derived from behavioral outcomes and is subject to change. Not a guarantee of future performance.",
    policyVersion: BADGE_POLICY_VERSION,
  },

  [BADGE_TYPE.GUARANTEE_COVERED]: {
    badgeType:              BADGE_TYPE.GUARANTEE_COVERED,
    displayName:            "Evan Guarantee",
    description:            "Item has an active Evan guarantee policy. Coverage subject to terms.",
    eligibilityRequires:    ["guaranteePolicy.status === ACTIVE"],
    publicDisplayAllowed:   true,
    partnerDisplayAllowed:  true,
    marketplaceDisplayAllowed: true,
    insuranceExportAllowed: true,
    lenderExportAllowed:    false,
    requiresLookup:         true,   // guarantee must be looked up in real time
    lookupEndpoint:         "/verify/guarantee/:referenceId",
    validForDays:           null,   // matches policy expiresAt
    revocable:              true,
    expirable:              true,
    autoRenewable:          false,
    allowedClaimLanguage: [
      "Evan Guarantee active — see {verificationUrl}",
      "Covered by Evan Guarantee",
      "Evan-protected transaction",
    ],
    prohibitedClaims: [
      "Unconditionally guaranteed",
      "Fully insured",
      "Money-back guaranteed",     // must reference specific coverage/terms
      "Evan guarantees authenticity", // can only say "Guarantee active"
      "100% protected",
    ],
    disclaimerRequired: true,
    disclaimer: "Evan Guarantee coverage is subject to policy terms, exclusions, and claim window. Verify current coverage status before relying on this credential.",
    policyVersion: BADGE_POLICY_VERSION,
  },

  [BADGE_TYPE.CATEGORY_SPECIALIST]: {
    badgeType:              BADGE_TYPE.CATEGORY_SPECIALIST,
    displayName:            "Category Specialist",
    description:            "Evan-Certified reseller with demonstrated depth in a specific category.",
    eligibilityRequires:    ["certRecord.status === CERTIFIED", "categorySpecialties.length > 0"],
    publicDisplayAllowed:   true,
    partnerDisplayAllowed:  true,
    marketplaceDisplayAllowed: true,
    insuranceExportAllowed: false,
    lenderExportAllowed:    false,
    requiresLookup:         false,   // derived from certification, no separate lookup
    validForDays:           365,
    revocable:              true,
    expirable:              true,
    autoRenewable:          false,
    allowedClaimLanguage: [
      "Evan-Certified {category} Specialist",
      "Verified {category} expertise by Evan AI",
    ],
    prohibitedClaims: [
      "Expert in {category}",   // too broad, not verifiable
      "Best {category} seller",
    ],
    disclaimerRequired: false,
    disclaimer: null,
    policyVersion: BADGE_POLICY_VERSION,
  },

  [BADGE_TYPE.TRUSTED_RESELLER]: {
    badgeType:              BADGE_TYPE.TRUSTED_RESELLER,
    displayName:            "Trusted Reseller",
    description:            "Certified reseller with clean dispute record and consistent track record.",
    eligibilityRequires:    [
      "certRecord.status === CERTIFIED",
      "counterpartyRisk.riskLevel in [MINIMAL, LOW]",
      "certRecord.dealIQ.disputeRisk < 0.10",
    ],
    publicDisplayAllowed:   true,
    partnerDisplayAllowed:  true,
    marketplaceDisplayAllowed: true,
    insuranceExportAllowed: false,
    lenderExportAllowed:    true,
    requiresLookup:         true,
    lookupEndpoint:         "/verify/reseller/:referenceId",
    validForDays:           180,
    revocable:              true,
    expirable:              true,
    autoRenewable:          false,
    allowedClaimLanguage: [
      "Evan Trusted Reseller",
      "Trusted by Evan AI",
    ],
    prohibitedClaims: [
      "Zero disputes",
      "100% positive feedback",
      "Evan-Verified",
    ],
    disclaimerRequired: true,
    disclaimer: "Trusted Reseller status reflects Evan's assessment at time of certification. Always exercise independent judgment in transactions.",
    policyVersion: BADGE_POLICY_VERSION,
  },

  [BADGE_TYPE.ROUTE_VERIFIED]: {
    badgeType:              BADGE_TYPE.ROUTE_VERIFIED,
    displayName:            "Route Verified",
    description:            "Routing recommendation backed by actual outcome data from Evan's platform.",
    eligibilityRequires:    ["routeOutcomeData.dataQuality in [RICH, MODERATE]"],
    publicDisplayAllowed:   false,   // internal/partner only
    partnerDisplayAllowed:  true,
    marketplaceDisplayAllowed: false,
    insuranceExportAllowed: false,
    lenderExportAllowed:    false,
    requiresLookup:         false,
    validForDays:           30,
    revocable:              false,
    expirable:              true,
    autoRenewable:          false,
    allowedClaimLanguage: [
      "Route recommendation backed by verified outcome data",
    ],
    prohibitedClaims: [
      "Best platform guaranteed",
      "Guaranteed fastest sale",
    ],
    disclaimerRequired: true,
    disclaimer: "Route Verified reflects historical performance data and is not a guarantee of future results.",
    policyVersion: BADGE_POLICY_VERSION,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the full policy definition for a badge type.
 */
export function getBadgePolicy(badgeType) {
  return BADGE_POLICIES[badgeType] || null;
}

/**
 * Get all badge policies.
 */
export function getAllBadgePolicies() {
  return Object.values(BADGE_POLICIES);
}

/**
 * Check if a badge can be displayed in a given channel.
 * Returns: { allowed, disclaimer, prohibitedClaims, lookupRequired, policy }
 *
 * @param {string} badgeType
 * @param {string} channel — DISPLAY_CHANNEL.*
 * @returns {{ allowed, disclaimer, lookupRequired, policy }}
 */
export function checkBadgeDisplayAllowed(badgeType, channel) {
  const policy = BADGE_POLICIES[badgeType];
  if (!policy) {
    return { allowed: false, reason: "unknown_badge_type" };
  }

  let allowed = false;
  switch (channel) {
    case DISPLAY_CHANNEL.PUBLIC_PAGE:
      allowed = policy.publicDisplayAllowed;
      break;
    case DISPLAY_CHANNEL.MARKETPLACE_LISTING:
      allowed = policy.marketplaceDisplayAllowed;
      break;
    case DISPLAY_CHANNEL.SELLER_BIO:
      // Seller bio: same as public + partner but not insurance/lender
      allowed = policy.publicDisplayAllowed || policy.partnerDisplayAllowed;
      break;
    case DISPLAY_CHANNEL.PARTNER_API:
      allowed = policy.partnerDisplayAllowed;
      break;
    case DISPLAY_CHANNEL.INSURANCE_EXPORT:
      allowed = policy.insuranceExportAllowed;
      break;
    case DISPLAY_CHANNEL.LENDER_EXPORT:
      allowed = policy.lenderExportAllowed;
      break;
    case DISPLAY_CHANNEL.INTERNAL_ONLY:
      allowed = true;   // everything allowed internally
      break;
    default:
      allowed = false;
  }

  return {
    allowed,
    disclaimer:      allowed && policy.disclaimerRequired ? policy.disclaimer : null,
    lookupRequired:  allowed ? policy.requiresLookup : false,
    lookupEndpoint:  allowed ? policy.lookupEndpoint : null,
    prohibitedClaims: policy.prohibitedClaims,
    allowedClaims:   allowed ? policy.allowedClaimLanguage : [],
    policy,
  };
}

/**
 * Validate a proposed external claim against the badge policy.
 * Returns { allowed, violatedRule } where violatedRule is the first prohibited match.
 *
 * @param {string} badgeType
 * @param {string} claimText    — the proposed claim string
 * @returns {{ valid, violatedRule? }}
 */
export function validateClaimText(badgeType, claimText) {
  const policy = BADGE_POLICIES[badgeType];
  if (!policy) return { valid: false, violatedRule: "unknown_badge_type" };

  const claim = (claimText || "").toLowerCase();
  for (const prohibited of policy.prohibitedClaims) {
    // Simple substring check — case-insensitive, strip interpolation placeholders
    const pattern = prohibited.replace(/\{[^}]+\}/g, "").toLowerCase().trim();
    if (pattern && claim.includes(pattern)) {
      return { valid: false, violatedRule: prohibited };
    }
  }
  return { valid: true };
}
