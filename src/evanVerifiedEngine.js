// src/evanVerifiedEngine.js
// Phase 5 — Evan-Verified Item Eligibility Engine.
//
// Determines whether an item is eligible to receive "Evan-Verified" status.
// This is the external-facing trust credential — stricter than internal trust
// states, deterministic, auditable, and category-specific.
//
// Verification statuses:
//   VERIFIED         — All strict conditions met. Item earns Evan-Verified.
//   NOT_VERIFIED     — Conditions not met but no active risk.
//   REVIEW_REQUIRED  — Partially meets conditions. Expert review needed.
//   INELIGIBLE       — Active counterfeit flag, HIGH_RISK_AUTH, or blocking failure.
//
// Non-negotiable rules:
//   1. VERIFIED requires LIKELY_AUTHENTIC verdict — UNCERTAIN is never enough.
//   2. Each category has independent minimum evidence thresholds.
//   3. Guarantee eligibility is a strict subset of verification.
//   4. Verification expiry is category-specific (watches expire faster).
//   5. INELIGIBLE is a hard block — not recoverable by re-scan alone.
//   6. Fail closed: when in doubt, return NOT_VERIFIED or REVIEW_REQUIRED.
//
// Claim language:
//   Also builds structured claim language for downstream use (listing, marketplace,
//   inventory view, B2B API). This is tightly coupled to verification status.
//
// Redis key layout:
//   verify:item:{scanId}      STRING  verification record (category-TTL)
//   verify:user:{userId}      ZSET    scanIds by verifiedAt (max 500, 1yr)
//   verify:ops                HASH    ops counters (verified/denied/ineligible/etc.)

import crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

export const VERIFY_STATUS = {
  VERIFIED:        "VERIFIED",
  NOT_VERIFIED:    "NOT_VERIFIED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  INELIGIBLE:      "INELIGIBLE",
};

export const GUARANTEE_STATUS = {
  ELIGIBLE:        "ELIGIBLE",
  NOT_ELIGIBLE:    "NOT_ELIGIBLE",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
};

export const VERIFICATION_VERSION = "5.0";

// ── Category verification rules ───────────────────────────────────────────────

const CATEGORY_RULES = {
  sneakers: {
    minTrustScore:           0.68,
    allowedEvidenceStrengths: new Set(["STRONG", "MEDIUM"]),
    requiresVerdict:         "LIKELY_AUTHENTIC",
    expertReviewIfPriceAbove: 500,
    blockingCounterfeitMatchScore: 0.50,
    expiresInDays:           90,
    // Guarantee (stricter)
    guarantee: {
      minTrustScore:        0.78,
      requiresEvidenceStrength: "STRONG",
      maxCoverageBand:      [0, 1000],   // [min, max] coverage in $
      expertReviewIfPriceAbove: 300,
    },
  },
  handbags: {
    minTrustScore:           0.72,
    allowedEvidenceStrengths: new Set(["STRONG", "MEDIUM"]),
    requiresVerdict:         "LIKELY_AUTHENTIC",
    expertReviewIfPriceAbove: 1000,
    // At least 1 of these auth markers must be confirmed in extraction
    requiredAuthMarkers:     ["dateCode", "serialNumber", "hardwareCheck", "logoCondition"],
    requiredAuthMarkersMin:  1,
    blockingCounterfeitMatchScore: 0.45,
    expiresInDays:           60,
    guarantee: {
      minTrustScore:        0.80,
      requiresEvidenceStrength: "STRONG",
      maxCoverageBand:      [0, 2000],
      expertReviewIfPriceAbove: 500,
    },
  },
  watches: {
    minTrustScore:           0.75,
    allowedEvidenceStrengths: new Set(["STRONG"]),  // watches require STRONG only
    requiresVerdict:         "LIKELY_AUTHENTIC",
    expertReviewIfPriceAbove: 1000,
    expertMandatoryIfPriceAbove: 2000,              // mandatory for expensive watches
    blockingCounterfeitMatchScore: 0.40,
    expiresInDays:           30,
    guarantee: {
      minTrustScore:        0.82,
      requiresEvidenceStrength: "STRONG",
      maxCoverageBand:      [0, 3000],
      expertMandatory:      true,                   // watches always require expert for guarantee
    },
  },
  generic: {
    minTrustScore:           0.62,
    allowedEvidenceStrengths: new Set(["STRONG", "MEDIUM"]),
    requiresVerdict:         "LIKELY_AUTHENTIC",
    expertReviewIfPriceAbove: 2000,
    blockingCounterfeitMatchScore: 0.60,
    expiresInDays:           180,
    guarantee: {
      minTrustScore:        0.72,
      requiresEvidenceStrength: "MEDIUM",
      maxCoverageBand:      [0, 500],
      expertReviewIfPriceAbove: 1000,
    },
  },
};

function getCategoryRules(category) {
  const c = (category || "").toLowerCase();
  return CATEGORY_RULES[c] || CATEGORY_RULES.generic;
}

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_ITEM  = scanId => `verify:item:${scanId}`;
const KEY_USER  = userId => `verify:user:${userId}`;
const KEY_OPS   = ()     => `verify:ops`;

const USER_TTL    = 1 * 365 * 86400;
const MAX_PER_USER = 500;

// ── Pure eligibility computation ──────────────────────────────────────────────

/**
 * Determine if an item qualifies for Evan-Verified status.
 * Pure function — does not touch Redis.
 *
 * @param {object} opts
 *   authEvidence      {object}  — from authEvidenceModel (Phase 4)
 *   trustState        {string}  — from trustStateEngine (Phase 4)
 *   trustScore        {number}  — final trust score (0-1)
 *   category          {string}
 *   scannedPrice      {number|null}
 *   expertReviewed    {boolean} — whether expert has confirmed (from trust history)
 *   expertVerdict     {string|null} — AUTHENTIC | COUNTERFEIT | UNRESOLVED
 * @returns {EvanVerification}
 */
export function computeEvanVerification({
  authEvidence      = {},
  trustState        = "INSUFFICIENT_EVIDENCE",
  trustScore        = 0.5,
  category          = "generic",
  scannedPrice      = null,
  expertReviewed    = false,
  expertVerdict     = null,
} = {}) {
  const rules   = getCategoryRules(category);
  const verdict = authEvidence.verdict          || "INSUFFICIENT_EVIDENCE";
  const strength= authEvidence.evidenceStrength || "NONE";
  const authScore = authEvidence.authScore      ?? 0.5;
  const reasonCodes = [];

  // ── Hard blocks (INELIGIBLE) ───────────────────────────────────────────────

  // Expert confirmed counterfeit — immediate hard block
  if (expertVerdict === "COUNTERFEIT") {
    reasonCodes.push("EXPERT_CONFIRMED_COUNTERFEIT");
    return _buildResult({
      status: VERIFY_STATUS.INELIGIBLE,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // Counterfeit verdict from model — hard block
  if (verdict === "LIKELY_COUNTERFEIT") {
    reasonCodes.push("AUTH_VERDICT_COUNTERFEIT");
    return _buildResult({
      status: VERIFY_STATUS.INELIGIBLE,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // Trust state: HIGH_RISK_AUTH — hard block
  if (trustState === "HIGH_RISK_AUTH") {
    reasonCodes.push("TRUST_STATE_HIGH_RISK");
    return _buildResult({
      status: VERIFY_STATUS.INELIGIBLE,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // Blocking counterfeit match score for this category
  const topCounterfeitMatch = authEvidence.negativeSignals?.find(s => s.code === "COUNTERFEIT_PATTERN_MATCH");
  if (topCounterfeitMatch) {
    reasonCodes.push("COUNTERFEIT_PATTERN_MATCHED");
    return _buildResult({
      status: VERIFY_STATUS.INELIGIBLE,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // ── No data (NOT_VERIFIED) ─────────────────────────────────────────────────

  if (verdict === "INSUFFICIENT_EVIDENCE" || strength === "NONE") {
    reasonCodes.push("INSUFFICIENT_EVIDENCE");
    return _buildResult({
      status: VERIFY_STATUS.NOT_VERIFIED,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // ── Check for REVIEW_REQUIRED conditions ──────────────────────────────────

  let needsReview = false;

  // Expert review mandatory for this category + price band
  if (rules.expertMandatoryIfPriceAbove && scannedPrice >= rules.expertMandatoryIfPriceAbove && !expertReviewed) {
    reasonCodes.push(`EXPERT_REVIEW_MANDATORY_PRICE_${rules.expertMandatoryIfPriceAbove}`);
    needsReview = true;
  }

  if (rules.guarantee?.expertMandatory && !expertReviewed) {
    // Guarantee expert mandatory doesn't block verification — only guarantee eligibility
  }

  // Price above expert review threshold
  if (!needsReview && rules.expertReviewIfPriceAbove && scannedPrice >= rules.expertReviewIfPriceAbove && !expertReviewed) {
    reasonCodes.push(`EXPERT_REVIEW_RECOMMENDED_PRICE_${rules.expertReviewIfPriceAbove}`);
    needsReview = true;
  }

  // ── Core verification conditions ──────────────────────────────────────────

  // Must have LIKELY_AUTHENTIC verdict
  if (verdict !== rules.requiresVerdict) {
    reasonCodes.push("VERDICT_NOT_LIKELY_AUTHENTIC");
    // Check if REVIEW_REQUIRED makes sense (UNCERTAIN with decent evidence)
    if (verdict === "UNCERTAIN" && (strength === "STRONG" || strength === "MEDIUM") && trustScore >= 0.60) {
      reasonCodes.push("UNCERTAIN_VERDICT_REVIEW_PATH");
      return _buildResult({
        status: VERIFY_STATUS.REVIEW_REQUIRED,
        reasonCodes,
        rules, trustState, authEvidence, expertReviewed, expertVerdict,
        scannedPrice, category, trustScore, strength,
      });
    }
    return _buildResult({
      status: VERIFY_STATUS.NOT_VERIFIED,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // Evidence strength must meet category minimum
  if (!rules.allowedEvidenceStrengths.has(strength)) {
    reasonCodes.push(`EVIDENCE_STRENGTH_BELOW_MINIMUM_${[...rules.allowedEvidenceStrengths][0]}`);
    return _buildResult({
      status: VERIFY_STATUS.NOT_VERIFIED,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // Trust score must meet category minimum
  if (trustScore < rules.minTrustScore) {
    reasonCodes.push(`TRUST_SCORE_BELOW_MIN_${rules.minTrustScore}`);
    // If close to threshold (within 0.07), REVIEW_REQUIRED
    if (trustScore >= rules.minTrustScore - 0.07) {
      reasonCodes.push("TRUST_SCORE_BORDERLINE");
      return _buildResult({
        status: VERIFY_STATUS.REVIEW_REQUIRED,
        reasonCodes,
        rules, trustState, authEvidence, expertReviewed, expertVerdict,
        scannedPrice, category, trustScore, strength,
      });
    }
    return _buildResult({
      status: VERIFY_STATUS.NOT_VERIFIED,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // Category-specific required auth markers (handbags)
  if (rules.requiredAuthMarkers) {
    const attrs = authEvidence._extractedAttributes || {};
    const confirmed = rules.requiredAuthMarkers.filter(m => {
      const val = attrs[m];
      return val !== null && val !== undefined && val !== "" && val !== false;
    });
    if (confirmed.length < rules.requiredAuthMarkersMin) {
      reasonCodes.push("REQUIRED_AUTH_MARKERS_MISSING");
      return _buildResult({
        status: VERIFY_STATUS.REVIEW_REQUIRED,
        reasonCodes,
        rules, trustState, authEvidence, expertReviewed, expertVerdict,
        scannedPrice, category, trustScore, strength,
      });
    }
  }

  // Expert review was flagged as needed
  if (needsReview) {
    return _buildResult({
      status: VERIFY_STATUS.REVIEW_REQUIRED,
      reasonCodes,
      rules, trustState, authEvidence, expertReviewed, expertVerdict,
      scannedPrice, category, trustScore, strength,
    });
  }

  // ── All conditions met — VERIFIED ─────────────────────────────────────────

  reasonCodes.push("ALL_CONDITIONS_MET");
  if (expertReviewed && expertVerdict === "AUTHENTIC") {
    reasonCodes.push("EXPERT_CONFIRMED_AUTHENTIC");
  }

  return _buildResult({
    status: VERIFY_STATUS.VERIFIED,
    reasonCodes,
    rules, trustState, authEvidence, expertReviewed, expertVerdict,
    scannedPrice, category, trustScore, strength,
  });
}

// ── Internal result builder ───────────────────────────────────────────────────

function _buildResult({
  status, reasonCodes, rules, trustState, authEvidence, expertReviewed,
  expertVerdict, scannedPrice, category, trustScore, strength,
}) {
  const now      = Date.now();
  const isVerified = status === VERIFY_STATUS.VERIFIED;
  const expiresAt  = isVerified ? now + rules.expiresInDays * 86400000 : null;

  // Compute guarantee eligibility
  const guarantee = _computeGuaranteeEligibility({
    status, rules, trustScore, strength,
    authEvidence, scannedPrice, expertReviewed,
  });

  // Build claim language
  const claimLanguage = buildClaimLanguage({
    status,
    category,
    authEvidence,
    expertReviewed,
    expertVerdict,
    guaranteeEligible: guarantee.eligible,
  });

  return {
    eligible:             isVerified,
    status,
    reasonCodes,
    trustState,
    authVerdict:          authEvidence.verdict          || "INSUFFICIENT_EVIDENCE",
    evidenceStrength:     authEvidence.evidenceStrength || "NONE",
    expertReviewed,
    expertVerdict:        expertVerdict || null,
    verifiedAt:           isVerified ? now : null,
    expiresAt,
    verificationVersion:  VERIFICATION_VERSION,
    claimText:            isVerified ? "Evan-Verified" : null,
    claimTextSafe:        claimLanguage.listingSafeAuthText,
    guaranteeEligible:    guarantee.eligible,
    guaranteeStatus:      guarantee.status,
    guaranteeReasonCodes: guarantee.reasonCodes,
    claimLanguage,
    categoryRules: {
      minTrustScore:    rules.minTrustScore,
      expiresInDays:    rules.expiresInDays,
      evidenceRequired: [...(rules.allowedEvidenceStrengths || [])],
    },
  };
}

// ── Guarantee eligibility computation ────────────────────────────────────────

function _computeGuaranteeEligibility({
  status, rules, trustScore, strength, authEvidence, scannedPrice, expertReviewed,
}) {
  const grules = rules.guarantee;
  if (!grules) return { eligible: false, status: GUARANTEE_STATUS.NOT_ELIGIBLE, reasonCodes: ["NO_GUARANTEE_RULES"] };

  const reasonCodes = [];

  // Must be at least VERIFIED (not just REVIEW_REQUIRED)
  if (status !== VERIFY_STATUS.VERIFIED) {
    reasonCodes.push("ITEM_NOT_VERIFIED");
    return { eligible: false, status: GUARANTEE_STATUS.NOT_ELIGIBLE, reasonCodes };
  }

  // Trust score must meet guarantee minimum (stricter)
  if (trustScore < grules.minTrustScore) {
    reasonCodes.push(`TRUST_SCORE_BELOW_GUARANTEE_MIN_${grules.minTrustScore}`);
    return { eligible: false, status: GUARANTEE_STATUS.NOT_ELIGIBLE, reasonCodes };
  }

  // Evidence strength must meet guarantee minimum
  const strengthOrder = ["NONE", "WEAK", "MEDIUM", "STRONG"];
  const reqIdx  = strengthOrder.indexOf(grules.requiresEvidenceStrength);
  const currIdx = strengthOrder.indexOf(strength);
  if (currIdx < reqIdx) {
    reasonCodes.push(`EVIDENCE_STRENGTH_BELOW_GUARANTEE_MIN_${grules.requiresEvidenceStrength}`);
    return { eligible: false, status: GUARANTEE_STATUS.NOT_ELIGIBLE, reasonCodes };
  }

  // Watches always require expert review for guarantee
  if (grules.expertMandatory && !expertReviewed) {
    reasonCodes.push("EXPERT_REVIEW_REQUIRED_FOR_GUARANTEE");
    return { eligible: false, status: GUARANTEE_STATUS.REVIEW_REQUIRED, reasonCodes };
  }

  // Price band check — if price > guarantee threshold, need expert review
  if (grules.expertReviewIfPriceAbove && scannedPrice >= grules.expertReviewIfPriceAbove && !expertReviewed) {
    reasonCodes.push(`EXPERT_REVIEW_REQUIRED_FOR_GUARANTEE_PRICE_${grules.expertReviewIfPriceAbove}`);
    return { eligible: false, status: GUARANTEE_STATUS.REVIEW_REQUIRED, reasonCodes };
  }

  // No blocking warnings in evidence
  if (authEvidence.warningCodes?.some(w => w.includes("COUNTERFEIT") || w.includes("HSR_LIKELY"))) {
    reasonCodes.push("BLOCKING_WARNING_PRESENT");
    return { eligible: false, status: GUARANTEE_STATUS.NOT_ELIGIBLE, reasonCodes };
  }

  // Eligible
  const [minCov, maxCov] = grules.maxCoverageBand || [0, 500];
  const coverage = scannedPrice
    ? Math.min(scannedPrice, maxCov)
    : maxCov;

  reasonCodes.push("ALL_GUARANTEE_CONDITIONS_MET");
  return {
    eligible:    true,
    status:      GUARANTEE_STATUS.ELIGIBLE,
    reasonCodes,
    maxCoverage: coverage,
    riskTier:    _deriveRiskTier(trustScore, strength),
  };
}

function _deriveRiskTier(trustScore, strength) {
  if (trustScore >= 0.82 && strength === "STRONG") return "LOW";
  if (trustScore >= 0.75) return "MEDIUM";
  return "HIGH";
}

// ── Claim language builder ────────────────────────────────────────────────────

/**
 * Build structured claim language for a verified item.
 * Used downstream by listing generation, inventory views, B2B API, marketplace export.
 *
 * @param {object} opts
 *   status           {string}  — VERIFIED | NOT_VERIFIED | REVIEW_REQUIRED | INELIGIBLE
 *   category         {string}
 *   authEvidence     {object}
 *   expertReviewed   {boolean}
 *   expertVerdict    {string|null}
 *   guaranteeEligible{boolean}
 * @returns {ClaimLanguage}
 */
export function buildClaimLanguage({
  status           = "NOT_VERIFIED",
  category         = "generic",
  authEvidence     = {},
  expertReviewed   = false,
  expertVerdict    = null,
  guaranteeEligible = false,
} = {}) {
  const verdict  = authEvidence.verdict || "UNCERTAIN";
  const strength = authEvidence.evidenceStrength || "NONE";

  if (status === VERIFY_STATUS.INELIGIBLE || verdict === "LIKELY_COUNTERFEIT") {
    return {
      marketplaceSafeTitleSuffix: null,
      listingSafeAuthText:        "Authentication concerns noted. Independent verification required before purchase.",
      internalConfidenceText:     "INELIGIBLE — authentication blocked",
      prohibitedClaims:           ["authentic", "genuine", "real", "verified", "guaranteed"],
      allowedClaims:              ["sold as-is", "buyer to verify authenticity"],
      requiresDisclaimer:         true,
      disclaimerText:             "Authenticity of this item has not been confirmed. Buyer should independently verify authenticity prior to purchase.",
    };
  }

  if (status === VERIFY_STATUS.VERIFIED) {
    const expertSuffix = expertReviewed && expertVerdict === "AUTHENTIC" ? " · Expert Authenticated" : "";
    const guaranteeSuffix = guaranteeEligible ? " · Guarantee Eligible" : "";
    return {
      marketplaceSafeTitleSuffix: `| Evan-Verified${expertSuffix}`,
      listingSafeAuthText:        `Evan-Verified authentic${expertSuffix}.${guaranteeSuffix ? " Qualifies for Evan Guarantee." : ""}`,
      internalConfidenceText:     `VERIFIED — ${strength} evidence${expertSuffix}`,
      prohibitedClaims:           [],
      allowedClaims:              ["Evan-Verified", "authenticated", "genuine", expertReviewed ? "expert authenticated" : null].filter(Boolean),
      requiresDisclaimer:         false,
      disclaimerText:             null,
    };
  }

  if (status === VERIFY_STATUS.REVIEW_REQUIRED) {
    return {
      marketplaceSafeTitleSuffix: null,
      listingSafeAuthText:        "Authentication review in progress. Evan review indicates likely authentic — awaiting confirmation.",
      internalConfidenceText:     `REVIEW_REQUIRED — ${strength} evidence, verdict: ${verdict}`,
      prohibitedClaims:           ["Evan-Verified", "guaranteed", "expert authenticated"],
      allowedClaims:              ["authentication review pending", verdict === "LIKELY_AUTHENTIC" ? "likely authentic" : null].filter(Boolean),
      requiresDisclaimer:         true,
      disclaimerText:             "Authentication review is pending. Verification status may change after expert review.",
    };
  }

  // NOT_VERIFIED — default
  const canClaimLikelyAuth = verdict === "LIKELY_AUTHENTIC" && (strength === "MEDIUM" || strength === "STRONG");
  return {
    marketplaceSafeTitleSuffix: null,
    listingSafeAuthText:        canClaimLikelyAuth
      ? "Evan analysis indicates likely authentic. Full verification not completed."
      : "Authenticity not independently verified by Evan.",
    internalConfidenceText:     `NOT_VERIFIED — ${strength} evidence, verdict: ${verdict}`,
    prohibitedClaims:           ["Evan-Verified", "guaranteed", "verified authentic"],
    allowedClaims:              canClaimLikelyAuth ? ["likely authentic — buyer to verify"] : ["sold as described"],
    requiresDisclaimer:         !canClaimLikelyAuth,
    disclaimerText:             !canClaimLikelyAuth
      ? "Authenticity of this item has not been independently verified."
      : null,
  };
}

// ── Redis persistence ─────────────────────────────────────────────────────────

const DAY_MS = 86400000;

/**
 * Persist a verification record to Redis.
 * Non-blocking friendly — caller uses .catch(() => {}).
 *
 * @param {object} redis
 * @param {string} scanId
 * @param {object} verification  — result from computeEvanVerification
 * @param {object} [opts]
 *   userId   {string|null}
 *   category {string}
 */
export async function storeVerificationRecord(redis, scanId, verification, {
  userId   = null,
  category = "generic",
} = {}) {
  if (!redis || !scanId || !verification) return;
  try {
    const rules    = getCategoryRules(category);
    const ttlDays  = rules.expiresInDays * 2;  // store 2x expiry for audit
    const ttlSecs  = ttlDays * 86400;
    const record   = { scanId, userId, category, ...verification, storedAt: Date.now() };

    await redis.set(KEY_ITEM(scanId), JSON.stringify(record), { EX: ttlSecs });

    if (userId) {
      const now = Date.now();
      await redis.zAdd(KEY_USER(userId), [{ score: now, value: scanId }]);
      await redis.zRemRangeByRank(KEY_USER(userId), 0, -(MAX_PER_USER + 1));
      await redis.expire(KEY_USER(userId), USER_TTL);
    }

    // Update ops counters
    const opKey = `status.${verification.status}`;
    await redis.hIncrBy(KEY_OPS(), opKey, 1);
    if (verification.guaranteeEligible) {
      await redis.hIncrBy(KEY_OPS(), "guaranteeEligible", 1);
    }
    if (verification.expertReviewed) {
      await redis.hIncrBy(KEY_OPS(), "expertReviewed", 1);
    }
  } catch (err) {
    console.error("[evanVerified] storeVerificationRecord error:", err?.message);
  }
}

/**
 * Retrieve a stored verification record.
 */
export async function getVerificationRecord(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    const raw = await redis.get(KEY_ITEM(scanId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Check whether a stored verification is still valid (not expired, not revoked).
 */
export async function checkVerificationValidity(redis, scanId) {
  const record = await getVerificationRecord(redis, scanId);
  if (!record) return { valid: false, reason: "not_found" };

  if (record.status === VERIFY_STATUS.INELIGIBLE) {
    return { valid: false, reason: "ineligible", record };
  }

  if (record.status !== VERIFY_STATUS.VERIFIED) {
    return { valid: false, reason: `status_${record.status.toLowerCase()}`, record };
  }

  const now = Date.now();
  if (record.expiresAt && now > record.expiresAt) {
    return { valid: false, reason: "expired", expiredAt: record.expiresAt, record };
  }

  if (record._revoked) {
    return { valid: false, reason: "revoked", revokedAt: record._revokedAt, record };
  }

  return { valid: true, record };
}

/**
 * Revoke a stored verification record (e.g., expert confirmed counterfeit post-verification).
 */
export async function revokeVerificationRecord(redis, scanId, { reason, revokedBy = "system" } = {}) {
  if (!redis || !scanId) return { ok: false, error: "missing_scan_id" };
  try {
    const raw = await redis.get(KEY_ITEM(scanId));
    if (!raw) return { ok: false, error: "record_not_found" };

    const record = JSON.parse(raw);
    if (record._revoked) return { ok: true, alreadyRevoked: true };

    record._revoked    = true;
    record._revokedAt  = Date.now();
    record._revokedBy  = revokedBy;
    record._revokeReason = reason || "unspecified";
    record.status      = VERIFY_STATUS.INELIGIBLE;
    record.eligible    = false;
    record.claimText   = null;
    record.updatedAt   = Date.now();

    // Keep existing TTL — don't refresh it, let it expire naturally
    const ttl = await redis.ttl(KEY_ITEM(scanId));
    if (ttl > 0) {
      await redis.set(KEY_ITEM(scanId), JSON.stringify(record), { EX: ttl });
    } else {
      await redis.set(KEY_ITEM(scanId), JSON.stringify(record), { EX: 86400 * 30 });
    }

    await redis.hIncrBy(KEY_OPS(), "revoked", 1);
    return { ok: true, scanId, revokedAt: record._revokedAt, reason };
  } catch (err) {
    return { ok: false, error: "revoke_failed", reason: err?.message };
  }
}

/**
 * Get user's verification history (most recent first).
 */
export async function getUserVerificationHistory(redis, userId, { limit = 20, offset = 0 } = {}) {
  if (!redis || !userId) return { scanIds: [], records: [], total: 0 };
  try {
    const total   = await redis.zCard(KEY_USER(userId));
    const scanIds = await redis.zRange(KEY_USER(userId), offset, offset + limit - 1, { REV: true });
    const raws    = await Promise.all(scanIds.map(id => redis.get(KEY_ITEM(id)).catch(() => null)));
    const records = raws
      .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
    return { scanIds, records, total };
  } catch { return { scanIds: [], records: [], total: 0 }; }
}

/**
 * Get verification ops summary for governance.
 */
export async function getVerificationOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) {
      ops[k] = Number(v) || 0;
    }
    return {
      verified:         ops["status.VERIFIED"]         || 0,
      notVerified:      ops["status.NOT_VERIFIED"]      || 0,
      reviewRequired:   ops["status.REVIEW_REQUIRED"]   || 0,
      ineligible:       ops["status.INELIGIBLE"]        || 0,
      guaranteeEligible:ops["guaranteeEligible"]        || 0,
      expertReviewed:   ops["expertReviewed"]           || 0,
      revoked:          ops["revoked"]                  || 0,
    };
  } catch { return {}; }
}
