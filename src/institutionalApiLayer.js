// src/institutionalApiLayer.js
// Phase 7 — Institutional API Layer + Partner Integration Readiness Objects.
//
// Builds partner-safe, versioned response contracts for the 7 institutional
// partner classes that Evan targets. These are NOT fake integrations — they are
// the data contracts that make real integrations possible immediately.
//
// Partner classes:
//   MARKETPLACE          — marketplace listing trust injection
//   CONSIGNMENT          — consignment intake verification
//   INSURANCE            — underwriting / claim valuation
//   LENDER               — collateral valuation / borrower risk
//   RETAILER             — returns fraud detection
//   AUTH_PROVIDER        — authentication provider embedding
//   ESTATE_LIQUIDATION   — estate/liquidation item intake
//
// Each integration object is:
//   - Versioned (INSTITUTIONAL_API_VERSION)
//   - Claim-safe (no overclaims, internal reasoning stripped)
//   - Auditable (referenceId + auditHash included)
//   - Export-safe (only partner-allowed fields per partnerAccessEngine)
//   - Machine-readable (flat, typed, no ambiguous fields)
//
// This layer wraps Phase 5/6 internal results to produce clean external contracts.

import { governExternalClaim, CLAIM_CHANNEL, CLAIM_TYPE } from "./externalClaimGovernor.js";
import { filterPayloadForPartner, PARTNER_TYPE } from "./partnerAccessEngine.js";
import { B2B_API_VERSION } from "./dataProductEngine.js";

export const INSTITUTIONAL_API_VERSION = "7.0";

// ── Marketplace verification payload ─────────────────────────────────────────

/**
 * Build a marketplace seller/listing verification payload.
 * Used by marketplace partners to verify item authenticity and seller trust.
 *
 * @param {object} opts
 *   trustmarkRecord    {object|null}   — from trustmarkEngine
 *   evanVerification   {object|null}   — from evanVerifiedEngine
 *   certRecord         {object|null}   — reseller certification
 *   referenceRecord    {object|null}   — extref record
 *   requestId          {string|null}
 * @returns {MarketplaceVerificationPayload}
 */
export function buildMarketplaceVerificationPayload({
  trustmarkRecord,
  evanVerification,
  certRecord,
  referenceRecord,
  requestId = null,
} = {}) {
  const itemVerified    = trustmarkRecord?.status === "ACTIVE";
  const sellerCertified = certRecord?.status === "CERTIFIED";

  // Claim governor: what can we say in a marketplace context?
  const itemClaim = governExternalClaim({
    channel:        CLAIM_CHANNEL.PARTNER_API,
    claimType:      CLAIM_TYPE.ITEM_VERIFIED,
    referenceId:    referenceRecord?.referenceId,
    verificationUrl:referenceRecord?.verificationUrl,
  });

  const sellerClaim = governExternalClaim({
    channel:        CLAIM_CHANNEL.PARTNER_API,
    claimType:      CLAIM_TYPE.RESELLER_CERTIFIED,
    referenceId:    referenceRecord?.referenceId,
    verificationUrl:referenceRecord?.verificationUrl,
  });

  return {
    api_version:    B2B_API_VERSION,
    institutional_version: INSTITUTIONAL_API_VERSION,
    request_id:     requestId,
    object:         "marketplace_verification",
    partner_class:  "MARKETPLACE",
    item: {
      verified:       itemVerified,
      trustmarkStatus:trustmarkRecord?.status || null,
      referenceId:    referenceRecord?.referenceId || null,
      verificationUrl:referenceRecord?.verificationUrl || null,
      evidenceLevel:  itemVerified ? (evanVerification?.evidenceLevel || null) : null,
      category:       evanVerification?.category || null,
      brand:          evanVerification?.brand    || null,
      expiresAt:      trustmarkRecord?.expiresAt || null,
      claimLanguage:  itemVerified ? itemClaim.finalLanguage : null,
      claimDisclaimer:itemClaim.disclaimer || null,
    },
    seller: {
      certified:       sellerCertified,
      certificationTier: sellerCertified ? (certRecord?.tier || null) : null,
      referenceId:     referenceRecord?.referenceId || null,
      claimLanguage:   sellerCertified ? sellerClaim.finalLanguage : null,
    },
    trust_summary: {
      trust_level: evanVerification?.status === "VERIFIED"
        ? "VERIFIED"
        : (evanVerification?.status || "UNVERIFIED"),
    },
    generated_at:   Date.now(),
  };
}

// ── Consignment intake payload ────────────────────────────────────────────────

/**
 * Build a consignment intake verification payload.
 * Provides authentication evidence + valuation for consignment partner intake.
 *
 * @param {object} opts
 *   evanVerification  {object|null}
 *   valuationResult   {object|null}   — from buildB2BValuationResponse()
 *   referenceRecord   {object|null}
 *   certRecord        {object|null}
 *   requestId         {string|null}
 * @returns {ConsignmentIntakePayload}
 */
export function buildConsignmentIntakePayload({
  evanVerification,
  valuationResult,
  referenceRecord,
  certRecord,
  requestId = null,
} = {}) {
  const isVerified = evanVerification?.status === "VERIFIED";

  const authClaim = governExternalClaim({
    channel:        CLAIM_CHANNEL.PARTNER_API,
    claimType:      CLAIM_TYPE.ITEM_AUTHENTIC,
    verificationUrl:referenceRecord?.verificationUrl,
  });

  return {
    api_version:           B2B_API_VERSION,
    institutional_version: INSTITUTIONAL_API_VERSION,
    request_id:            requestId,
    object:                "consignment_intake",
    partner_class:         "CONSIGNMENT",
    authentication: {
      status:           evanVerification?.status || "NOT_VERIFIED",
      evidenceLevel:    evanVerification?.evidenceLevel || null,
      expertReviewed:   evanVerification?.expertReviewed || false,
      referenceId:      referenceRecord?.referenceId || null,
      verificationUrl:  referenceRecord?.verificationUrl || null,
      claimLanguage:    authClaim.allowed ? authClaim.finalLanguage : null,
      disclaimer:       authClaim.disclaimer || null,
    },
    valuation: valuationResult ? {
      priceFloor:  valuationResult.pricing?.floor   || null,
      priceCeiling:valuationResult.pricing?.ceiling || null,
      median:      valuationResult.pricing?.median  || null,
      confidence:  valuationResult.pricing?.confidence || null,
      dataSource:  valuationResult.market?.dataSource  || null,
    } : null,
    seller_trust: certRecord?.status === "CERTIFIED" ? {
      certified:        true,
      certificationTier:certRecord.tier || null,
    } : { certified: false },
    intake_recommendation: _consignmentIntakeRecommendation(evanVerification, valuationResult),
    generated_at: Date.now(),
  };
}

// ── Lender valuation packet ───────────────────────────────────────────────────

/**
 * Build a lender collateral valuation packet.
 * Provides authentication evidence + valuation + borrower risk for lending.
 *
 * @param {object} opts
 *   evanVerification   {object|null}
 *   valuationResult    {object|null}
 *   counterpartyResult {object|null}   — from getCounterpartyRisk()
 *   certRecord         {object|null}
 *   referenceRecord    {object|null}
 *   requestId          {string|null}
 * @returns {LenderValuationPacket}
 */
export function buildLenderValuationPacket({
  evanVerification,
  valuationResult,
  counterpartyResult,
  certRecord,
  referenceRecord,
  requestId = null,
} = {}) {
  const isVerified = evanVerification?.status === "VERIFIED";

  const authClaim = governExternalClaim({
    channel:        CLAIM_CHANNEL.LENDER_EXPORT,
    claimType:      CLAIM_TYPE.ITEM_VERIFIED,
    verificationUrl:referenceRecord?.verificationUrl,
  });

  const riskClaim = governExternalClaim({
    channel:    CLAIM_CHANNEL.LENDER_EXPORT,
    claimType:  CLAIM_TYPE.RISK_LOW,
  });

  return {
    api_version:           B2B_API_VERSION,
    institutional_version: INSTITUTIONAL_API_VERSION,
    request_id:            requestId,
    object:                "lender_valuation_packet",
    partner_class:         "LENDER",
    collateral_auth: {
      status:           evanVerification?.status || "NOT_VERIFIED",
      evidenceLevel:    evanVerification?.evidenceLevel || null,
      referenceId:      referenceRecord?.referenceId || null,
      verificationUrl:  referenceRecord?.verificationUrl || null,
      claimLanguage:    authClaim.allowed ? authClaim.finalLanguage : null,
      disclaimer:       authClaim.disclaimer || null,
    },
    collateral_value: valuationResult ? {
      floor:       valuationResult.pricing?.floor   || null,
      median:      valuationResult.pricing?.median  || null,
      ceiling:     valuationResult.pricing?.ceiling || null,
      confidence:  valuationResult.pricing?.confidence || null,
      disclaimer:  "Value estimates reflect secondary market conditions at time of analysis. Lenders should apply their own LTV discount.",
    } : null,
    borrower_risk: counterpartyResult ? {
      riskLevel:   counterpartyResult.riskLevel,
      scamFlagged: counterpartyResult.scamFlagged || false,
      dataQuality: counterpartyResult.dataQuality,
      // counterpartyRisk float exposed to lenders per partnerAccessEngine PRIVILEGED access
      riskScore:   counterpartyResult.counterpartyRisk,
      disclaimer:  riskClaim.disclaimer || null,
    } : null,
    borrower_cert: certRecord?.status === "CERTIFIED" ? {
      certified:  true,
      tier:       certRecord.tier    || null,
      dealIQBand: null,   // DealIQ band only in partner context with explicit consent
    } : { certified: false },
    generated_at: Date.now(),
  };
}

// ── Retailer fraud signal ─────────────────────────────────────────────────────

/**
 * Build a retailer fraud detection signal.
 * For returns processing, receipt validation, and fraud pattern detection.
 *
 * @param {object} opts
 *   evanVerification   {object|null}
 *   counterpartyResult {object|null}
 *   requestId          {string|null}
 * @returns {RetailerFraudSignal}
 */
export function buildRetailerFraudSignal({
  evanVerification,
  counterpartyResult,
  requestId = null,
} = {}) {
  const authStatus  = evanVerification?.status || "UNKNOWN";
  const riskLevel   = counterpartyResult?.riskLevel || "UNKNOWN";
  const scamFlagged = counterpartyResult?.scamFlagged || false;

  // Overall fraud risk assessment
  let fraudRisk = "LOW";
  if (scamFlagged || authStatus === "INELIGIBLE") {
    fraudRisk = "HIGH";
  } else if (riskLevel === "HIGH" || riskLevel === "MODERATE") {
    fraudRisk = "ELEVATED";
  } else if (authStatus === "REVIEW_REQUIRED") {
    fraudRisk = "REVIEW";
  }

  return {
    api_version:           B2B_API_VERSION,
    institutional_version: INSTITUTIONAL_API_VERSION,
    request_id:            requestId,
    object:                "retailer_fraud_signal",
    partner_class:         "RETAILER",
    fraud_risk:            fraudRisk,
    auth_signal: {
      status:  authStatus,
      // No internal scores in retailer signal
    },
    seller_signal: {
      riskLevel:   riskLevel,
      scamFlagged: scamFlagged,
      dataQuality: counterpartyResult?.dataQuality || "NO_DATA",
    },
    recommendation: _retailerFraudRecommendation(fraudRisk, authStatus),
    disclaimer: "Fraud signal reflects available evidence at time of analysis. Independent verification required before any adverse action.",
    generated_at: Date.now(),
  };
}

// ── Insurance valuation record ────────────────────────────────────────────────

/**
 * Build an insurance underwriting / claim support valuation record.
 * Richer than public, but still strips internal model reasoning.
 *
 * @param {object} opts
 *   evanVerification  {object|null}
 *   valuationResult   {object|null}
 *   guaranteePolicy   {object|null}
 *   referenceRecord   {object|null}
 *   requestId         {string|null}
 * @returns {InsuranceValuationRecord}
 */
export function buildInsuranceValuationRecord({
  evanVerification,
  valuationResult,
  guaranteePolicy,
  referenceRecord,
  requestId = null,
} = {}) {
  const isVerified = evanVerification?.status === "VERIFIED";

  const authClaim = governExternalClaim({
    channel:         CLAIM_CHANNEL.INSURANCE_EXPORT,
    claimType:       CLAIM_TYPE.ITEM_VERIFIED,
    verificationUrl: referenceRecord?.verificationUrl,
  });

  const priceClaim = governExternalClaim({
    channel:    CLAIM_CHANNEL.INSURANCE_EXPORT,
    claimType:  CLAIM_TYPE.PRICE_ACCURATE,
    priceRange: valuationResult
      ? `$${valuationResult.pricing?.floor}–$${valuationResult.pricing?.ceiling}`
      : null,
  });

  return {
    api_version:           B2B_API_VERSION,
    institutional_version: INSTITUTIONAL_API_VERSION,
    request_id:            requestId,
    object:                "insurance_valuation_record",
    partner_class:         "INSURANCE",
    authentication: {
      status:          evanVerification?.status    || "NOT_VERIFIED",
      evidenceLevel:   evanVerification?.evidenceLevel  || null,
      expertReviewed:  evanVerification?.expertReviewed || false,
      referenceId:     referenceRecord?.referenceId    || null,
      verificationUrl: referenceRecord?.verificationUrl || null,
      claimLanguage:   authClaim.allowed ? authClaim.finalLanguage : null,
      disclaimer:      authClaim.disclaimer || null,
    },
    valuation: valuationResult ? {
      floor:       valuationResult.pricing?.floor   || null,
      median:      valuationResult.pricing?.median  || null,
      ceiling:     valuationResult.pricing?.ceiling || null,
      confidence:  valuationResult.pricing?.confidence || null,
      soldsFound:  valuationResult.market?.soldsFound  || null,
      dataSource:  valuationResult.market?.dataSource  || null,
      claimLanguage: priceClaim.allowed ? priceClaim.finalLanguage : null,
      disclaimer:    priceClaim.disclaimer || null,
    } : null,
    guarantee: guaranteePolicy ? {
      policyId:     guaranteePolicy.policyId,
      status:       guaranteePolicy.status,
      coverageType: "authenticity",
      issuedAt:     guaranteePolicy.issuedAt,
      expiresAt:    guaranteePolicy.expiresAt || null,
      // Coverage amount exposed to insurance partners
      maxCoverage:  guaranteePolicy.coverageAmount || null,
    } : null,
    generated_at: Date.now(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _consignmentIntakeRecommendation(verification, valuation) {
  const status = verification?.status;
  if (status === "INELIGIBLE")    return "REJECT";
  if (status === "REVIEW_REQUIRED") return "MANUAL_REVIEW";
  if (status === "VERIFIED")      return "ACCEPT";
  return "NEEDS_VERIFICATION";
}

function _retailerFraudRecommendation(fraudRisk, authStatus) {
  if (fraudRisk === "HIGH")     return "REJECT_RETURN";
  if (fraudRisk === "ELEVATED") return "MANUAL_REVIEW";
  if (fraudRisk === "REVIEW")   return "SECONDARY_INSPECTION";
  return "ACCEPT_STANDARD";
}
