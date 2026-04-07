// src/guaranteeExternalEngine.js
// Phase 7 — Guarantee External Infrastructure.
//
// Phase 5 created internal guarantee eligibility and policy issuance.
// Phase 7 prepares the guarantee layer for institutional and external use:
//   - External record format with channel-safe fields
//   - Formal external wording (approved language for listings, partner API, insurance)
//   - Prohibited overclaims
//   - Expiry / revocation behavior for external audiences
//   - Claim instructions for external access
//   - Partner/public distinction on what coverage details are visible
//
// This engine wraps Phase 5 guarantee records — it does NOT replace them.
// It builds the external-facing representation on top of the internal record.
//
// External guarantee record:
//   guaranteeExternalRecord:
//     guaranteeId        — internal policyId
//     subjectType        — "item"
//     subjectReferenceId — extref referenceId (if issued)
//     coverageStatus     — ACTIVE | EXPIRED | REVOKED | CLAIMED
//     coverageType       — "authenticity" (Phase 5 only type)
//     maxCoverage        — coverage cap in dollars
//     startAt            — policy issuedAt
//     expiresAt          — policy expiresAt
//     exclusionsSummary  — human-readable exclusions (no legalistic detail)
//     claimInstructions  — how to file a claim (external-safe)
//     lookupAllowed      — whether /verify/guarantee/:id is enabled
//     publicSafe         — fields safe for public page
//     partnerSafe        — fields safe for partner API
//     policyVersion

import { POLICY_STATUS } from "./guaranteeEngine.js";

export const GUARANTEE_EXTERNAL_VERSION = "7.0";

// ── External wording definitions ──────────────────────────────────────────────

// Approved language for "Evan Guarantee" in external contexts
const APPROVED_EXTERNAL_WORDING = {
  PUBLIC_LISTING: "Covered by Evan Guarantee — verify at {verificationUrl}",
  PARTNER_API:    "Active Evan guarantee policy. Coverage: {maxCoverage}. Expiry: {expiresAt}. Verify: {verificationUrl}",
  INSURANCE:      "Evan Guarantee Policy active. Coverage type: authenticity. Maximum coverage: {maxCoverage}. Issued: {startAt}. Expires: {expiresAt}.",
  CLAIM_FORM:     "This item carries an Evan Guarantee policy (ID: {guaranteeId}). Coverage applies subject to terms. See {verificationUrl} for current status.",
};

// Language that is explicitly prohibited in all external channels
const PROHIBITED_EXTERNAL_CLAIMS = [
  "Unconditionally guaranteed",
  "Fully insured",
  "Money-back guaranteed",
  "100% protected",
  "No questions asked",
  "Evan guarantees this item is authentic",  // guarantee ≠ absolute authenticity claim
  "Covered for any loss",
  "Full replacement guaranteed",
];

// Standard exclusions summary (public-safe, non-legalistic)
const STANDARD_EXCLUSIONS_SUMMARY =
  "Coverage excludes: wear and tear, damage after purchase, items sold outside Evan's platform, " +
  "claims filed after the claim window, claims without proof of purchase.";

// Claim instructions (external-safe, no internal tooling details)
const CLAIM_INSTRUCTIONS_PUBLIC =
  "To file a claim: visit evanai.app/guarantee/claim with your purchase proof and item photos. " +
  "Claims must be filed within the claim window from purchase date.";

const CLAIM_INSTRUCTIONS_PARTNER =
  "To initiate a claim: present the guaranteeId and policy reference to the buyer. " +
  "Buyer must file via evanai.app/guarantee/claim within the claim window. " +
  "Partner integrations may reference the guarantee packet for adjudication support.";

// ── Build external guarantee record ──────────────────────────────────────────

/**
 * Build an external-safe guarantee record from an internal policy record.
 * Does NOT modify the internal policy — read-only export.
 *
 * @param {object} guaranteePolicy    — internal policy from guaranteeEngine.js
 * @param {object} opts
 *   subjectReferenceId {string|null}  — extref referenceId if issued
 *   verificationUrl    {string|null}  — verification URL
 *   channel            {string}       — "PUBLIC"|"PARTNER"|"INSURANCE"|"LENDER"
 * @returns {GuaranteeExternalRecord}
 */
export function buildGuaranteeExternalRecord(guaranteePolicy, {
  subjectReferenceId = null,
  verificationUrl    = null,
  channel            = "PARTNER",
} = {}) {
  if (!guaranteePolicy) return null;

  const isPublicChannel = channel === "PUBLIC";
  const status = _deriveExternalStatus(guaranteePolicy);

  // Coverage visibility: only show max amount in partner/insurance channels
  const showCoverageAmount = !isPublicChannel;

  // Build external record
  const record = {
    guaranteeId:       guaranteePolicy.policyId,
    subjectType:       "item",
    subjectReferenceId,
    coverageStatus:    status,
    coverageType:      "authenticity",
    // Coverage amount only in partner+ contexts
    ...(showCoverageAmount ? { maxCoverage: guaranteePolicy.coverageAmount || null } : {}),
    startAt:           guaranteePolicy.issuedAt,
    expiresAt:         guaranteePolicy.expiresAt || null,
    exclusionsSummary: STANDARD_EXCLUSIONS_SUMMARY,
    claimInstructions: isPublicChannel ? CLAIM_INSTRUCTIONS_PUBLIC : CLAIM_INSTRUCTIONS_PARTNER,
    lookupAllowed:     true,
    verificationUrl:   verificationUrl || null,
    publicSafe:        true,
    partnerSafe:       !isPublicChannel,
    policyVersion:     GUARANTEE_EXTERNAL_VERSION,
  };

  return record;
}

/**
 * Get approved external wording for a given context.
 *
 * @param {string} context   — "PUBLIC_LISTING"|"PARTNER_API"|"INSURANCE"|"CLAIM_FORM"
 * @param {object} vars      — { guaranteeId, maxCoverage, startAt, expiresAt, verificationUrl }
 * @returns {string}
 */
export function getApprovedGuaranteeWording(context, vars = {}) {
  const template = APPROVED_EXTERNAL_WORDING[context];
  if (!template) return null;

  return template
    .replace(/\{guaranteeId\}/g,   vars.guaranteeId   || "[id]")
    .replace(/\{maxCoverage\}/g,   vars.maxCoverage != null ? `$${vars.maxCoverage}` : "[see policy]")
    .replace(/\{startAt\}/g,       vars.startAt       ? new Date(vars.startAt).toLocaleDateString()  : "[date]")
    .replace(/\{expiresAt\}/g,     vars.expiresAt     ? new Date(vars.expiresAt).toLocaleDateString() : "[expiry]")
    .replace(/\{verificationUrl\}/g, vars.verificationUrl || "evanai.app/verify");
}

/**
 * Check if a proposed claim string is prohibited.
 * Returns { safe, violatedRule? }
 */
export function checkGuaranteeClaimSafety(claimText) {
  const claim = (claimText || "").toLowerCase();
  for (const prohibited of PROHIBITED_EXTERNAL_CLAIMS) {
    const pattern = prohibited.toLowerCase();
    if (claim.includes(pattern)) {
      return { safe: false, violatedRule: prohibited };
    }
  }
  return { safe: true };
}

/**
 * Get all prohibited external claims (for partner documentation).
 */
export function getProhibitedGuaranteeClaims() {
  return [...PROHIBITED_EXTERNAL_CLAIMS];
}

/**
 * Get standard exclusions summary.
 */
export function getExclusionsSummary() {
  return STANDARD_EXCLUSIONS_SUMMARY;
}

// ── Public verification payload for /verify/guarantee/:referenceId ────────────

/**
 * Build the public-safe verification payload for a guarantee reference.
 * Served on the public verification page — must not expose coverage amounts or internal policy details.
 */
export function buildGuaranteePublicVerification(guaranteePolicy, {
  referenceId     = null,
  verificationUrl = null,
} = {}) {
  if (!guaranteePolicy) return null;

  const status = _deriveExternalStatus(guaranteePolicy);
  const isActive = status === "ACTIVE";

  return {
    referenceId,
    type:          "guarantee",
    status,
    coverageType:  "authenticity",
    isActive,
    // Only show dates on public page — not coverage amounts
    startAt:       guaranteePolicy.issuedAt,
    expiresAt:     guaranteePolicy.expiresAt || null,
    revokedAt:     guaranteePolicy.revokedAt || null,
    claimable:     isActive,
    verificationUrl,
    exclusionsSummary: isActive ? STANDARD_EXCLUSIONS_SUMMARY : null,
    claimInstructions: isActive ? CLAIM_INSTRUCTIONS_PUBLIC   : null,
    disclaimer:    _getGuaranteeDisclaimer(status),
    policyVersion: GUARANTEE_EXTERNAL_VERSION,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _deriveExternalStatus(policy) {
  // Map internal status to external status string
  if (policy.status === POLICY_STATUS.REVOKED) return "REVOKED";
  if (policy.status === POLICY_STATUS.CLAIMED) return "CLAIMED";
  // Check expiry in real time
  if (policy.expiresAt && Date.now() > policy.expiresAt) return "EXPIRED";
  if (policy.status === POLICY_STATUS.ACTIVE) return "ACTIVE";
  return "INACTIVE";
}

function _getGuaranteeDisclaimer(status) {
  if (status === "REVOKED") return "This guarantee has been revoked and is no longer valid.";
  if (status === "EXPIRED")  return "This guarantee has expired. Coverage is no longer active.";
  if (status === "CLAIMED")  return "A claim has been approved against this guarantee.";
  return "Coverage is active subject to policy terms and exclusions. Verify current status before relying on this credential.";
}
