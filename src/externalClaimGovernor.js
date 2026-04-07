// src/externalClaimGovernor.js
// Phase 7 — External Claim-Safety Governor.
//
// Every external trust claim must pass through this governor before leaving Evan.
// The governor is channel-aware: what is safe on a public verification page may
// not be safe in a lender export, and vice versa.
//
// This layer complements the internal claim language from evanVerifiedEngine.js
// and listingAssistEngine.js — those handle internal/listing language, this handles
// external channel safety.
//
// Channels:
//   PUBLIC_VERIFICATION   — /verify/* public pages, no auth required
//   MARKETPLACE_LISTING   — seller listing text (eBay, Grailed, Poshmark, etc.)
//   SELLER_BIO            — reseller profile bio text
//   PARTNER_API           — contracted B2B partner response
//   INSURANCE_EXPORT      — insurance underwriting / claim support
//   LENDER_EXPORT         — pawn/lending collateral valuation
//   INTERNAL_ONLY         — ops, review, internal dashboards
//
// Claim types:
//   ITEM_AUTHENTIC        — "this item is authentic"
//   ITEM_VERIFIED         — "Evan verified this item"
//   RESELLER_CERTIFIED    — "this reseller is certified"
//   GUARANTEE_ACTIVE      — "guarantee covers this item"
//   PRICE_ACCURATE        — "this price estimate is accurate"
//   RISK_LOW              — "this transaction is low risk"
//   COUNTERFEIT_SAFE      — "no counterfeit risk"
//
// Non-negotiables:
//   1. Claims are softened or blocked — never upgraded beyond evidence.
//   2. PUBLIC and MARKETPLACE channels face the strictest softening.
//   3. INTERNAL_ONLY claims are unfiltered.
//   4. Every output includes the policyVersion so consumers can track changes.

import { BADGE_TYPE, checkBadgeDisplayAllowed, DISPLAY_CHANNEL } from "./externalBadgePolicyEngine.js";

export const CLAIM_GOVERNOR_VERSION = "7.0";

export const CLAIM_CHANNEL = {
  PUBLIC_VERIFICATION:  "PUBLIC_VERIFICATION",
  MARKETPLACE_LISTING:  "MARKETPLACE_LISTING",
  SELLER_BIO:           "SELLER_BIO",
  PARTNER_API:          "PARTNER_API",
  INSURANCE_EXPORT:     "INSURANCE_EXPORT",
  LENDER_EXPORT:        "LENDER_EXPORT",
  INTERNAL_ONLY:        "INTERNAL_ONLY",
};

export const CLAIM_TYPE = {
  ITEM_AUTHENTIC:     "ITEM_AUTHENTIC",
  ITEM_VERIFIED:      "ITEM_VERIFIED",
  RESELLER_CERTIFIED: "RESELLER_CERTIFIED",
  GUARANTEE_ACTIVE:   "GUARANTEE_ACTIVE",
  PRICE_ACCURATE:     "PRICE_ACCURATE",
  RISK_LOW:           "RISK_LOW",
  COUNTERFEIT_SAFE:   "COUNTERFEIT_SAFE",
};

// ── Channel permission matrix ─────────────────────────────────────────────────
//
// For each [channel][claimType]: { allowed, softening, referenceRequired, disclaimerRequired }
//
// softening levels:
//   NONE      — claim passes as-is
//   MODERATE  — rephrase to hedged language
//   HEAVY     — significant softening required
//   BLOCK     — claim must not appear in this channel

const CLAIM_MATRIX = {
  [CLAIM_CHANNEL.PUBLIC_VERIFICATION]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
  },
  [CLAIM_CHANNEL.MARKETPLACE_LISTING]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: true,  softening: "HEAVY",    referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: false },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
  },
  [CLAIM_CHANNEL.SELLER_BIO]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
  },
  [CLAIM_CHANNEL.PARTNER_API]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: true,  softening: "MODERATE", referenceRequired: false, disclaimerRequired: true  },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: true,  softening: "MODERATE", referenceRequired: false, disclaimerRequired: true  },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
  },
  [CLAIM_CHANNEL.INSURANCE_EXPORT]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: true,  softening: "HEAVY",    referenceRequired: false, disclaimerRequired: true  },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: true,  softening: "HEAVY",    referenceRequired: false, disclaimerRequired: true  },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
  },
  [CLAIM_CHANNEL.LENDER_EXPORT]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: true,  softening: "MODERATE", referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: true,  softening: "NONE",     referenceRequired: true,  disclaimerRequired: true  },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: true,  softening: "HEAVY",    referenceRequired: false, disclaimerRequired: true  },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: true,  softening: "HEAVY",    referenceRequired: false, disclaimerRequired: true  },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: false, softening: "BLOCK",    referenceRequired: false, disclaimerRequired: false },
  },
  [CLAIM_CHANNEL.INTERNAL_ONLY]: {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:     { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.ITEM_VERIFIED]:      { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.RESELLER_CERTIFIED]: { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:   { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.PRICE_ACCURATE]:     { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.RISK_LOW]:           { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
    [CLAIM_TYPE.COUNTERFEIT_SAFE]:   { allowed: true, softening: "NONE", referenceRequired: false, disclaimerRequired: false },
  },
};

// ── Softened language templates ───────────────────────────────────────────────

const SOFTENED_LANGUAGE = {
  [CLAIM_TYPE.ITEM_AUTHENTIC]: {
    NONE:     "This item is authentic.",
    MODERATE: "Evan's analysis found authentication evidence consistent with a genuine item.",
    HEAVY:    "Authentication signals were reviewed by Evan AI at time of scan. Independent verification recommended.",
  },
  [CLAIM_TYPE.ITEM_VERIFIED]: {
    NONE:     "Evan-Verified.",
    MODERATE: "Authentication verified by Evan AI — reference: {verificationUrl}",
    HEAVY:    "Authentication evidence reviewed by Evan AI. See {verificationUrl} for current status.",
  },
  [CLAIM_TYPE.RESELLER_CERTIFIED]: {
    NONE:     "Evan-Certified Reseller.",
    MODERATE: "Certified by Evan AI — see {verificationUrl} for current status.",
    HEAVY:    "Holds Evan-Certified Reseller status as of {issuedAt}. Status subject to change.",
  },
  [CLAIM_TYPE.GUARANTEE_ACTIVE]: {
    NONE:     "Evan Guarantee active.",
    MODERATE: "Covered by Evan Guarantee — see {verificationUrl} for terms and current status.",
    HEAVY:    "An Evan Guarantee policy was active at time of issue. Verify current status at {verificationUrl}.",
  },
  [CLAIM_TYPE.PRICE_ACCURATE]: {
    NONE:     "Price estimate: {price}.",
    MODERATE: "Evan estimated value range: {priceRange}. Estimates reflect market data at time of analysis.",
    HEAVY:    "Indicative value based on Evan market data at time of scan. Market conditions change; verify independently.",
  },
  [CLAIM_TYPE.RISK_LOW]: {
    NONE:     "Risk level: low.",
    MODERATE: "Risk indicators were consistent with a standard transaction at time of analysis.",
    HEAVY:    "No elevated risk signals detected at time of scan. Risk assessment is probabilistic, not a guarantee.",
  },
};

// ── Core governor function ────────────────────────────────────────────────────

/**
 * Govern an external claim for a given channel.
 *
 * @param {object} opts
 *   channel          {string}  — CLAIM_CHANNEL.*
 *   claimType        {string}  — CLAIM_TYPE.*
 *   rawClaim         {string|null}  — proposed raw claim text
 *   referenceId      {string|null}  — reference to inject into language
 *   verificationUrl  {string|null}  — URL to inject into language
 *   issuedAt         {number|null}  — for date substitution
 *   priceRange       {string|null}  — for price claim substitution
 * @returns {ExternalClaimPolicyResult}
 */
export function governExternalClaim({
  channel,
  claimType,
  rawClaim      = null,
  referenceId   = null,
  verificationUrl = null,
  issuedAt      = null,
  priceRange    = null,
} = {}) {
  const channelRules = CLAIM_MATRIX[channel];
  if (!channelRules) {
    return _blocked(channel, claimType, "unknown_channel");
  }

  const rule = channelRules[claimType];
  if (!rule) {
    return _blocked(channel, claimType, "unknown_claim_type");
  }

  if (!rule.allowed) {
    return _blocked(channel, claimType, "blocked_for_channel");
  }

  // Build softened/final language
  const templates = SOFTENED_LANGUAGE[claimType] || {};
  let finalLanguage = templates[rule.softening] || rawClaim || null;

  // Inject substitution variables
  if (finalLanguage) {
    finalLanguage = finalLanguage
      .replace(/\{verificationUrl\}/g, verificationUrl || "[verify at evanai.app]")
      .replace(/\{referenceId\}/g,    referenceId     || "[reference]")
      .replace(/\{issuedAt\}/g,       issuedAt ? new Date(issuedAt).toLocaleDateString() : "[date]")
      .replace(/\{priceRange\}/g,     priceRange      || "[see listing]");
  }

  const disclaimer = rule.disclaimerRequired
    ? _getClaimDisclaimer(claimType, channel)
    : null;

  return {
    channel,
    claimType,
    allowed:          true,
    softening:        rule.softening,
    finalLanguage,
    disclaimer,
    referenceRequired: rule.referenceRequired,
    blockedReason:    null,
    policyVersion:    CLAIM_GOVERNOR_VERSION,
  };
}

/**
 * Run a batch of claim checks for a given channel.
 * Returns an array of ExternalClaimPolicyResult objects.
 */
export function governClaimBatch(claims, channel) {
  return (claims || []).map(claim =>
    governExternalClaim({ channel, ...claim })
  );
}

/**
 * Check which channels a given claim type is allowed on.
 * Useful for deciding where to publish a trust credential.
 */
export function getClaimChannelPermissions(claimType) {
  const result = {};
  for (const [channel, rules] of Object.entries(CLAIM_MATRIX)) {
    const rule = rules[claimType];
    result[channel] = rule ? {
      allowed:  rule.allowed,
      softening: rule.softening,
      referenceRequired: rule.referenceRequired,
    } : { allowed: false, reason: "unknown_claim_type" };
  }
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _blocked(channel, claimType, reason) {
  return {
    channel,
    claimType,
    allowed:          false,
    softening:        "BLOCK",
    finalLanguage:    null,
    disclaimer:       null,
    referenceRequired: false,
    blockedReason:    reason,
    policyVersion:    CLAIM_GOVERNOR_VERSION,
  };
}

function _getClaimDisclaimer(claimType, channel) {
  const base = {
    [CLAIM_TYPE.ITEM_AUTHENTIC]:
      "Authentication evidence was assessed by Evan AI at time of scan. This does not constitute an unconditional guarantee.",
    [CLAIM_TYPE.ITEM_VERIFIED]:
      "Evan-Verified status reflects conditions at time of scan. Verify current status before relying on this credential.",
    [CLAIM_TYPE.RESELLER_CERTIFIED]:
      "Certification reflects behavioral history at time of assessment. Certification may change with subsequent activity.",
    [CLAIM_TYPE.GUARANTEE_ACTIVE]:
      "Guarantee coverage is subject to policy terms, exclusions, and claim window. Verify current status.",
    [CLAIM_TYPE.PRICE_ACCURATE]:
      "Price estimates are based on market data at time of analysis and do not guarantee future sale price.",
    [CLAIM_TYPE.RISK_LOW]:
      "Risk assessment is probabilistic and based on available signals. Not a guarantee of transaction safety.",
  };
  return base[claimType] || "Issued by Evan AI. Subject to terms of use.";
}
