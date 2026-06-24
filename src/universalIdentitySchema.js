// src/universalIdentitySchema.js
// Phase 5B.1 — Universal identity schema foundation.
// Enriches the existing vision identity with structured confidence labels,
// high-stakes flags, evidence metadata, and query-safety metadata.
// Pure sync functions, no I/O, no side effects.

import { isTrueHighStakesVisionCategory } from "./visionCategoryPolicy.js";
import { resolveBrandTier } from "./brandTierClassifier.js";

export const CONFIDENCE_LABELS = [
  "confirmed",
  "likely",
  "possible",
  "unknown",
  "insufficient_evidence",
];

export function isHighStakesBrand(brandName) {
  if (!brandName || typeof brandName !== "string") return false;
  const resolved = resolveBrandTier(brandName);
  if (!resolved) return false;
  return resolved.tier === "ultra_luxury" || resolved.tier === "luxury";
}

export function computeConfidenceLabel({
  confidence = 0,
  attributeCertainty = {},
  visibleText = [],
  authenticityFlags = [],
  highStakes = false,
  brand = null,
  model = null,
} = {}) {
  const conf = Number(confidence) || 0;
  const brandCert = Number(attributeCertainty.brand || 0);
  const modelCert = Number(attributeCertainty.model || 0);
  const catCert = Number(attributeCertainty.category || 0);
  const hasText = Array.isArray(visibleText) && visibleText.some((t) => t && String(t).trim().length > 0);
  const hasNegativeAuth = Array.isArray(authenticityFlags) && authenticityFlags.some((f) =>
    typeof f === "string" && /logo_proportions_off|font_wrong|stitching_uneven|monogram_misaligned|hardware_lightweight/.test(f)
  );

  if (conf < 0.15) return "insufficient_evidence";

  if (highStakes) {
    if (
      conf >= 0.85 &&
      brandCert >= 0.80 &&
      brand &&
      hasText &&
      !hasNegativeAuth
    ) {
      return "confirmed";
    }
    if (
      conf >= 0.65 &&
      (brandCert >= 0.55 || modelCert >= 0.55) &&
      (hasText || brandCert >= 0.70)
    ) {
      return "likely";
    }
    if (conf >= 0.40 && (brandCert >= 0.30 || catCert >= 0.50)) {
      return "possible";
    }
    return "unknown";
  }

  if (
    conf >= 0.85 &&
    (brandCert >= 0.75 || modelCert >= 0.75 || (catCert >= 0.80 && hasText))
  ) {
    return "confirmed";
  }
  if (conf >= 0.65 && (brandCert >= 0.50 || modelCert >= 0.50)) {
    return "likely";
  }
  if (conf >= 0.40 && (brandCert >= 0.30 || catCert >= 0.50)) {
    return "possible";
  }
  if (conf >= 0.15) {
    return "unknown";
  }
  return "insufficient_evidence";
}

function computeMissingEvidence(identity) {
  const missing = [];
  if (!identity.brand) missing.push("brand not identified");
  if (!identity.model) missing.push("model/title not identified");
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  if (!vt.some((t) => t && String(t).trim().length > 0)) {
    missing.push("no readable text detected");
  }
  if (!identity.condition) missing.push("condition not assessed");
  return missing;
}

function computeEvidenceSource(identity, attributeCertainty) {
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const hasText = vt.some((t) => t && String(t).trim().length > 0);
  const brandCert = Number(attributeCertainty?.brand || 0);

  if (hasText) return "visible_text";
  if (brandCert >= 0.45 || identity.brand) return "logo_or_mark";
  if (identity.itemType || identity.category) return "inferred";
  return null;
}

function computeQueryTermsAllowed(identity, confidenceLabel, authenticityClaimAllowed, highStakes) {
  const terms = [];
  if (identity.itemType) terms.push(identity.itemType);
  if (identity.category) terms.push(identity.category);
  if (Array.isArray(identity.colors)) {
    for (const c of identity.colors) if (c) terms.push(c);
  }
  if (Array.isArray(identity.materials)) {
    for (const m of identity.materials) if (m) terms.push(m);
  }
  if (identity.subtype) terms.push(identity.subtype);

  let brandAllowed;
  if (highStakes) {
    brandAllowed = authenticityClaimAllowed;
  } else {
    brandAllowed =
      authenticityClaimAllowed ||
      confidenceLabel === "likely" || confidenceLabel === "confirmed";
  }
  if (identity.brand && brandAllowed) terms.push(identity.brand);

  const modelAllowed = highStakes
    ? authenticityClaimAllowed
    : (confidenceLabel === "likely" || confidenceLabel === "confirmed");
  if (identity.model && modelAllowed) terms.push(identity.model);

  return terms;
}

function computeQueryTermsBlocked(identity, highStakes, authenticityClaimAllowed, confidenceLabel, evidenceSource) {
  const blocked = [];
  if (!identity.brand) return blocked;

  const weakEvidence =
    confidenceLabel === "possible" ||
    confidenceLabel === "unknown" ||
    confidenceLabel === "insufficient_evidence";
  const inferredOnly = evidenceSource === "inferred" || evidenceSource === "logo_or_mark";

  if (highStakes && !authenticityClaimAllowed && weakEvidence) {
    blocked.push(identity.brand);
    if (identity.model) blocked.push(identity.model);
  } else if (isHighStakesBrand(identity.brand) && !authenticityClaimAllowed && inferredOnly) {
    blocked.push(identity.brand);
  }

  return blocked;
}

function computeIdentityWarnings(identity, highStakes, confidenceLabel, authenticityClaimAllowed, evidenceSource) {
  const warnings = [];

  if (identity.brand && !authenticityClaimAllowed && highStakes) {
    warnings.push("Luxury/high-stakes item requires stronger evidence before brand/model claims.");
  }

  if (identity.brand && evidenceSource !== "visible_text" && (confidenceLabel === "possible" || confidenceLabel === "unknown")) {
    warnings.push("Brand claim is not confirmed from readable text or strong logo evidence.");
  }

  if (highStakes && (confidenceLabel === "possible" || confidenceLabel === "unknown")) {
    warnings.push("Visual similarity alone is not enough for authenticity.");
  }

  return warnings;
}

export function enrichIdentityWithSchema(identity = {}, options = {}) {
  const id = identity && typeof identity === "object" ? identity : {};
  const attributeCertainty = options.attributeCertainty || {};
  const authenticityFlags = Array.isArray(options.authenticityFlags) ? options.authenticityFlags : [];
  const overallConfidence = Number(options.overallConfidence || 0);

  const highStakes = isTrueHighStakesVisionCategory(id.category);

  const confidenceLabel = computeConfidenceLabel({
    confidence: overallConfidence,
    attributeCertainty,
    visibleText: id.visibleText || [],
    authenticityFlags,
    highStakes,
    brand: id.brand,
    model: id.model,
  });

  const luxuryBrand = isHighStakesBrand(id.brand);
  const luxurySegment =
    id.marketSegment === "luxury" || id.marketSegment === "premium";
  const brandNotConfirmed =
    confidenceLabel === "possible" ||
    confidenceLabel === "unknown" ||
    confidenceLabel === "insufficient_evidence";
  const luxuryCandidate =
    (highStakes || luxurySegment || luxuryBrand) && brandNotConfirmed;

  let authenticityClaimAllowed;
  if (highStakes) {
    authenticityClaimAllowed = confidenceLabel === "confirmed";
  } else {
    authenticityClaimAllowed =
      confidenceLabel === "confirmed" || confidenceLabel === "likely";
  }

  const missingEvidence = computeMissingEvidence(id);
  const evidenceSource = computeEvidenceSource(id, attributeCertainty);

  if (highStakes && id.brand && !authenticityClaimAllowed) {
    const hasBrandEvidence = missingEvidence.every(
      (m) => m !== "no readable text detected"
    );
    if (!hasBrandEvidence) {
      missingEvidence.push("high-stakes brand evidence not strong enough");
    }
  }

  const rawQueryTermsAllowed = computeQueryTermsAllowed(
    id, confidenceLabel, authenticityClaimAllowed, highStakes
  );
  const queryTermsBlocked = computeQueryTermsBlocked(
    id, highStakes, authenticityClaimAllowed, confidenceLabel, evidenceSource
  );
  const identityWarnings = computeIdentityWarnings(
    id, highStakes, confidenceLabel, authenticityClaimAllowed, evidenceSource
  );

  const blockedSet = new Set(queryTermsBlocked);
  const queryTermsAllowed = rawQueryTermsAllowed.filter((t) => !blockedSet.has(t));

  return {
    ...id,
    subtype: id.subtype ?? null,
    series: id.series ?? null,
    genderTarget: id.genderTarget ?? null,
    distinguishingFeatures: id.distinguishingFeatures ?? [],
    missingEvidence,
    evidenceSource,
    confidenceLabel,
    highStakes,
    luxuryCandidate,
    authenticityClaimAllowed,
    queryTermsAllowed,
    queryTermsBlocked,
    identityWarnings,
    conditionNotes: id.conditionNotes ?? null,
    broadQuery: id.broadQuery ?? null,
    categoryFallbackQuery: id.categoryFallbackQuery ?? null,
    visualDescriptorQuery: id.visualDescriptorQuery ?? null,
  };
}
