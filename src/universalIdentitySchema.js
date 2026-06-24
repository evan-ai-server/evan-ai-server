// src/universalIdentitySchema.js
// Phase 5B.1+5B.2+5B.3B — Universal identity schema foundation.
// Enriches the existing vision identity with structured confidence labels,
// high-stakes flags, evidence metadata, query-safety metadata,
// book/video-game recognition, and headphone taxonomy enrichment.
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

const BOOK_KEYWORDS = /\b(book|paperback|hardcover|hardback|novel|textbook|manga|comic|graphic novel)\b/i;
const VIDEO_GAME_KEYWORDS = /\b(video game|game case|game cartridge|disc game|nintendo switch game|playstation game|xbox game)\b/i;

export function isBookIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  return fields.some((f) => f && typeof f === "string" && BOOK_KEYWORDS.test(f));
}

export function isVideoGameIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  return fields.some((f) => f && typeof f === "string" && VIDEO_GAME_KEYWORDS.test(f));
}

const AUTHOR_BYLINE_RE = /\bby\s+([A-Z][A-Za-z'.]+(?:\s+[A-Z][A-Za-z'.]+){0,4})/;

export function deriveBookAuthor(visibleText) {
  if (!Array.isArray(visibleText)) return null;
  for (const t of visibleText) {
    if (!t || typeof t !== "string") continue;
    const m = t.match(AUTHOR_BYLINE_RE);
    if (m) return m[1].trim();
  }
  return null;
}

const ISBN13_RE = /(?:^|\D)(97[89]\d{10})(?:\D|$)/;
const ISBN10_RE = /(?:^|\D)(\d{9}[\dX])(?:\D|$)/;

export function deriveIsbn(visibleText) {
  if (!Array.isArray(visibleText)) return null;
  for (const t of visibleText) {
    if (!t || typeof t !== "string") continue;
    const normalized = t.replace(/[-\s]/g, "");
    const m13 = normalized.match(ISBN13_RE);
    if (m13) return m13[1];
    const m10 = normalized.match(ISBN10_RE);
    if (m10) return m10[1];
  }
  return null;
}

const GAME_PLATFORMS = [
  "Nintendo Switch 2",
  "Nintendo Switch",
  "Nintendo 3DS",
  "Wii",
  "PlayStation 5",
  "PlayStation 4",
  "PlayStation 3",
  "Xbox Series X",
  "Xbox Series S",
  "Xbox One",
  "Xbox 360",
  "PS5",
  "PS4",
  "PS3",
  "Steam",
  "PC",
];

export function deriveGamePlatform(visibleText) {
  if (!Array.isArray(visibleText)) return null;
  for (const t of visibleText) {
    if (!t || typeof t !== "string") continue;
    const upper = t.toUpperCase();
    for (const plat of GAME_PLATFORMS) {
      if (upper.includes(plat.toUpperCase())) return plat;
    }
  }
  return null;
}

// --- Headphone taxonomy (Phase 5B.3B) ---

const HEADPHONE_DEVICE_RE = /\b(headphone|headphones|earbud|earbuds|earphone|earphones|in-ear|in ear|on-ear|on ear|over-ear|over ear|around-ear|around ear|circumaural|supra-aural|iem|in-ear monitor|headset|gaming headset|audio headset|wireless headset|bluetooth headset)\b/i;
const HEADPHONE_ACCESSORY_RE = /\b(stand|case|cable|holder|hanger|hook|mount|bracket|adapter|splitter|jack|amp|amplifier|dac|receiver|ear pad|ear pads|earpad|earpads|cushion|cover|replacement|wall)\b/i;
const VR_AR_RE = /\b(vr|virtual reality|ar|augmented)\b/i;
const BARE_HEADSET_RE = /\bheadset\b/i;

export function isHeadphoneIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  if (!HEADPHONE_DEVICE_RE.test(joined)) return false;
  if (HEADPHONE_ACCESSORY_RE.test(joined)) return false;
  // Bare "headset" without audio qualifier — check for VR/AR veto
  const hasOnlyHeadset = BARE_HEADSET_RE.test(joined) &&
    !(/\b(headphone|headphones|earbud|earbuds|earphone|earphones|in-ear|in ear|on-ear|on ear|over-ear|over ear|around-ear|around ear|circumaural|supra-aural|iem|in-ear monitor|gaming headset|audio headset|wireless headset|bluetooth headset)\b/i.test(joined));
  if (hasOnlyHeadset && VR_AR_RE.test(joined)) return false;
  return true;
}

const EARBUD_RE = /\b(earbud|earbuds|earphone|earphones|in-ear|in ear|iem|in-ear monitor)\b/i;
const HEADPHONE_KIND_RE = /\b(headphone|headphones|headset|over-ear|over ear|on-ear|on ear|around-ear|around ear|circumaural|supra-aural)\b/i;

export function deriveAudioKind(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (EARBUD_RE.test(joined)) return "earbuds";
  if (HEADPHONE_KIND_RE.test(joined)) return "headphones";
  return null;
}

const FIT_OVER_EAR_RE = /\b(over-ear|over ear|around-ear|around ear|circumaural)\b/i;
const FIT_ON_EAR_RE = /\b(on-ear|on ear|supra-aural)\b/i;
const FIT_IN_EAR_RE = /\b(in-ear|in ear|earbuds|earphones|iem|in-ear monitor)\b/i;

export function deriveHeadphoneFit(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (FIT_OVER_EAR_RE.test(joined)) return "over_ear";
  if (FIT_ON_EAR_RE.test(joined)) return "on_ear";
  if (FIT_IN_EAR_RE.test(joined)) return "in_ear";
  return null;
}

const BACK_OPEN_RE = /\b(open-back|open back)\b/i;
const BACK_CLOSED_RE = /\b(closed-back|closed back)\b/i;

export function deriveHeadphoneBackType(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ") +
    " " + vt.filter((t) => t && typeof t === "string").join(" ");
  if (BACK_OPEN_RE.test(joined)) return "open_back";
  if (BACK_CLOSED_RE.test(joined)) return "closed_back";
  return null;
}

const WIRELESS_RE = /\b(wireless|bluetooth|true wireless|tws)\b/i;

export function deriveHeadphoneWireless(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const sw = Array.isArray(identity.styleWords) ? identity.styleWords : [];
  const joined = vt.filter((t) => t && typeof t === "string").join(" ") +
    " " + sw.filter((s) => s && typeof s === "string").join(" ");
  if (WIRELESS_RE.test(joined)) return true;
  return null;
}

const NC_RE = /\b(noise cancelling|noise-cancelling|noise canceling|active noise cancelling|active noise cancellation|anc)\b/i;

export function deriveHeadphoneNoiseCancelling(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const sw = Array.isArray(identity.styleWords) ? identity.styleWords : [];
  const joined = vt.filter((t) => t && typeof t === "string").join(" ") +
    " " + sw.filter((s) => s && typeof s === "string").join(" ");
  if (NC_RE.test(joined)) return true;
  return null;
}

const BLUETOOTH_RE = /\bbluetooth\b/i;
const WIRELESS_FEAT_RE = /\bwireless\b/i;
const MIC_RE = /\b(mic|microphone)\b/i;
const FOLDABLE_RE = /\b(foldable|folding)\b/i;

export function deriveHeadphoneFeatures(identity) {
  if (!isHeadphoneIdentity(identity)) return [];
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const sw = Array.isArray(identity.styleWords) ? identity.styleWords : [];
  const joined = vt.filter((t) => t && typeof t === "string").join(" ") +
    " " + sw.filter((s) => s && typeof s === "string").join(" ");
  const features = [];
  if (BLUETOOTH_RE.test(joined)) features.push("bluetooth");
  if (WIRELESS_FEAT_RE.test(joined) && !BLUETOOTH_RE.test(joined)) features.push("wireless");
  if (NC_RE.test(joined)) features.push("noise_cancelling");
  if (MIC_RE.test(joined)) features.push("microphone");
  if (FOLDABLE_RE.test(joined)) features.push("foldable");
  return features;
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

  const bookDetected = isBookIdentity(id);
  const gameDetected = isVideoGameIdentity(id);
  const mediaKind = bookDetected ? "book" : gameDetected ? "video_game" : null;

  const vt = Array.isArray(id.visibleText) ? id.visibleText : [];
  const author = bookDetected ? deriveBookAuthor(vt) : null;
  const isbn = bookDetected ? deriveIsbn(vt) : null;
  const platform = gameDetected ? deriveGamePlatform(vt) : null;

  if (bookDetected) {
    if (!id.model) missingEvidence.push("book title not readable");
    if (!author) missingEvidence.push("author not identified");
    if (!isbn) missingEvidence.push("ISBN not visible or not readable");
  }
  if (gameDetected) {
    if (!id.model) missingEvidence.push("video game title not readable");
    if (!platform) missingEvidence.push("game platform not identified");
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

  if (bookDetected && !id.model) {
    identityWarnings.push("Book title is not confirmed from readable cover text.");
  }
  if (gameDetected && !platform) {
    identityWarnings.push("Platform not confirmed — do not infer from case color.");
  }

  if (bookDetected && (confidenceLabel === "confirmed" || confidenceLabel === "likely")) {
    if (author && !rawQueryTermsAllowed.includes(author)) rawQueryTermsAllowed.push(author);
    if (isbn && !rawQueryTermsAllowed.includes(isbn)) rawQueryTermsAllowed.push(isbn);
  }
  if (gameDetected && (confidenceLabel === "confirmed" || confidenceLabel === "likely")) {
    if (platform && !rawQueryTermsAllowed.includes(platform)) rawQueryTermsAllowed.push(platform);
  }

  // --- Headphone taxonomy enrichment (Phase 5B.3B) ---
  const headphoneDetected = isHeadphoneIdentity(id);
  let audioKind = null;
  let headphoneFit = null;
  let headphoneBackType = null;
  let headphoneWireless = null;
  let headphoneNoiseCancelling = null;
  let headphoneFeatures = [];
  let headphoneEvidence = [];

  if (headphoneDetected) {
    audioKind = deriveAudioKind(id);
    headphoneFit = deriveHeadphoneFit(id);
    headphoneBackType = deriveHeadphoneBackType(id);
    headphoneWireless = deriveHeadphoneWireless(id);
    headphoneNoiseCancelling = deriveHeadphoneNoiseCancelling(id);
    headphoneFeatures = deriveHeadphoneFeatures(id);

    const evidence = [];
    if (headphoneFit) evidence.push(`fit:${headphoneFit}`);
    if (headphoneBackType) evidence.push(`back_type:${headphoneBackType}`);
    if (headphoneWireless === true) {
      const vt = Array.isArray(id.visibleText) ? id.visibleText : [];
      const sw = Array.isArray(id.styleWords) ? id.styleWords : [];
      const j = vt.filter((t) => t && typeof t === "string").join(" ") +
        " " + sw.filter((s) => s && typeof s === "string").join(" ");
      evidence.push(/\bbluetooth\b/i.test(j) ? "wireless:bluetooth" : "wireless:true");
    }
    if (headphoneNoiseCancelling === true) {
      const vt = Array.isArray(id.visibleText) ? id.visibleText : [];
      const sw = Array.isArray(id.styleWords) ? id.styleWords : [];
      const j = vt.filter((t) => t && typeof t === "string").join(" ") +
        " " + sw.filter((s) => s && typeof s === "string").join(" ");
      evidence.push(/\banc\b/i.test(j) ? "noise_cancelling:anc" : "noise_cancelling:true");
    }
    headphoneEvidence = evidence;
  }

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
    mediaKind,
    author,
    isbn,
    platform,
    edition: null,
    region: null,
    rating: null,
    publisher: null,
    developer: null,
    audioKind,
    headphoneFit,
    headphoneBackType,
    headphoneWireless,
    headphoneNoiseCancelling,
    headphoneFeatures,
    headphoneEvidence,
  };
}
