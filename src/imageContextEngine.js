// src/imageContextEngine.js
// Image context intelligence: extracts intent and quality signals from
// vision output — photo type, lighting quality, single-angle warning,
// damage-hiding detection, and multi-item frame detection.

// ── Photo context keywords ────────────────────────────────────────────────────
const WORN_KEYWORDS     = ["wearing", "worn", "on foot", "on feet", "modeled", "lifestyle", "outfit", "ootd"];
const FLATLAY_KEYWORDS  = ["flat lay", "flat-lay", "overhead", "top view", "top-down", "laid out"];
const SHELF_KEYWORDS    = ["shelf", "store", "retail", "display", "rack", "hanger", "closet"];
const STUDIO_KEYWORDS   = ["white background", "clean background", "studio", "product shot", "item photo"];
const OUTDOOR_KEYWORDS  = ["outdoor", "outside", "street", "park", "nature", "sunlight", "natural light"];
const MULTI_ITEM_KEYWORDS = ["and", "with", "bundle", "lot", "set", "pair", "collection", "accessories", "plus"];

// Damage-hiding indicators in photo context
const DARK_KEYWORDS     = ["dark", "low light", "shadow", "dimly lit", "night", "dark background"];
const PARTIAL_KEYWORDS  = ["partial", "close-up", "closeup", "crop", "cropped", "one side", "front only"];
const BLUR_KEYWORDS     = ["blurry", "blur", "out of focus", "unclear"];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Classify the photo presentation type from visible text + style words.
 */
export function classifyPhotoType(visibleText = [], styleWords = []) {
  const allText = [...visibleText, ...styleWords]
    .map(t => String(t).toLowerCase())
    .join(" ");

  if (WORN_KEYWORDS.some(k => allText.includes(k)))    return "worn_lifestyle";
  if (FLATLAY_KEYWORDS.some(k => allText.includes(k))) return "flat_lay";
  if (SHELF_KEYWORDS.some(k => allText.includes(k)))   return "store_shelf";
  if (STUDIO_KEYWORDS.some(k => allText.includes(k)))  return "studio_product";
  if (OUTDOOR_KEYWORDS.some(k => allText.includes(k))) return "outdoor";
  return "unknown";
}

/**
 * Score lighting quality from vision signals.
 * Poor lighting is a damage-hiding signal.
 */
export function scoreLightingQuality(visibleText = [], styleWords = []) {
  const allText = [...visibleText, ...styleWords]
    .map(t => String(t).toLowerCase())
    .join(" ");

  const isDark    = DARK_KEYWORDS.some(k => allText.includes(k));
  const isBlurry  = BLUR_KEYWORDS.some(k => allText.includes(k));
  const isOutdoor = OUTDOOR_KEYWORDS.some(k => allText.includes(k));

  let score = 0.70; // baseline — adequate
  if (isDark)    score -= 0.30;
  if (isBlurry)  score -= 0.25;
  if (isOutdoor) score += 0.05; // natural light is good

  score = Math.max(0, Math.min(1, score));

  const tier = score >= 0.70 ? "good"
             : score >= 0.45 ? "adequate"
             : "poor";

  return {
    score:     round2(score),
    tier,
    isDark,
    isBlurry,
    signal:    tier === "poor"
      ? "Poor lighting or blurry photo — seller may be hiding condition issues. Request better photos."
      : tier === "adequate"
      ? "Adequate lighting — request additional angles for high-value items"
      : null,
    damageSuspicion: tier === "poor",
  };
}

/**
 * Detect if multiple items are visible in the frame.
 * Signals a bundle opportunity or unclear pricing.
 */
export function detectMultiItemFrame(visibleText = [], styleWords = [], visionResult = null) {
  const allText = [...visibleText, ...styleWords]
    .map(t => String(t).toLowerCase())
    .join(" ");

  const hasMultiKeyword  = MULTI_ITEM_KEYWORDS.some(k => allText.includes(k));
  const hasBundle        = /\b(bundle|lot|set|collection|pair)\b/i.test(allText);
  const hasPlural        = /\b(shoes|sneakers|pairs|items|pieces|accessories)\b/i.test(allText);

  return {
    detected:      hasBundle || (hasMultiKeyword && hasPlural),
    isBundle:      hasBundle,
    signal:        hasBundle
      ? "Multiple items detected — bundle pricing may apply. Price each item individually for max value."
      : null,
  };
}

/**
 * Detect single-angle warning: only one side of the item is shown.
 * High-value items should always show 4+ angles.
 */
export function detectSingleAngleWarning(visibleText = [], styleWords = []) {
  const allText = [...visibleText, ...styleWords]
    .map(t => String(t).toLowerCase())
    .join(" ");

  const partialSignal = PARTIAL_KEYWORDS.some(k => allText.includes(k));
  const hasMultiAngle = /\b(all sides|multiple angles|360|front and back|top and bottom)\b/i.test(allText);

  return {
    warning:      partialSignal && !hasMultiAngle,
    hasMultiAngle,
    signal:       partialSignal && !hasMultiAngle
      ? "Only partial/single-angle photo shown — request front, back, sole/bottom, and detail shots before buying"
      : null,
  };
}

/**
 * Score photo intent: is this a buyer-intent listing photo or seller-intent scan?
 * Affects how much we trust the image for condition assessment.
 */
export function scorePhotoIntent(photoType = "unknown", visionConfidence = 0.5) {
  // Professional/studio shots = high trust for ID, lower trust for condition
  // Worn/lifestyle shots = good for condition context, harder to assess details
  // Store shelf = retail context, high ID confidence
  const INTENT_SIGNALS = {
    studio_product:  { trustForId: 0.90, trustForCondition: 0.60, label: "Product listing photo" },
    store_shelf:     { trustForId: 0.85, trustForCondition: 0.50, label: "Retail/store display" },
    flat_lay:        { trustForId: 0.80, trustForCondition: 0.75, label: "Flat lay — good condition view" },
    worn_lifestyle:  { trustForId: 0.65, trustForCondition: 0.80, label: "Worn/lifestyle — good condition context" },
    outdoor:         { trustForId: 0.70, trustForCondition: 0.70, label: "Outdoor photo" },
    unknown:         { trustForId: 0.60, trustForCondition: 0.60, label: "Standard photo" },
  };

  const signals = INTENT_SIGNALS[photoType] || INTENT_SIGNALS.unknown;

  return {
    photoType,
    label:              signals.label,
    trustForId:         round2(signals.trustForId * visionConfidence + (1 - visionConfidence) * 0.50),
    trustForCondition:  round2(signals.trustForCondition),
    signal:             photoType === "store_shelf"
      ? "Retail shelf photo — may be stock image, not actual item. Request real listing photos."
      : photoType === "studio_product"
      ? "Professional product photo — great for ID, verify actual condition separately"
      : null,
  };
}

/**
 * Master image context intelligence payload.
 */
export function buildImageContextPayload({
  visibleText      = [],
  styleWords       = [],
  visionResult     = null,
  visionConfidence = 0.5,
} = {}) {
  const photoType      = classifyPhotoType(visibleText, styleWords);
  const lighting       = scoreLightingQuality(visibleText, styleWords);
  const multiItem      = detectMultiItemFrame(visibleText, styleWords, visionResult);
  const singleAngle    = detectSingleAngleWarning(visibleText, styleWords);
  const intent         = scorePhotoIntent(photoType, visionConfidence);

  // Overall photo quality score
  const qualityScore = round2(
    lighting.score * 0.40 +
    intent.trustForCondition * 0.35 +
    (singleAngle.warning ? 0.40 : 0.80) * 0.25
  );

  const qualityTier = qualityScore >= 0.70 ? "high"
                    : qualityScore >= 0.45 ? "adequate"
                    : "low";

  const warnings = [
    lighting.signal,
    singleAngle.signal,
    intent.signal,
    multiItem.signal,
  ].filter(Boolean);

  return {
    photoType,
    qualityScore,
    qualityTier,
    lighting,
    intent,
    multiItem,
    singleAngle,
    warnings,
    hasWarnings:    warnings.length > 0,
    topWarning:     warnings[0] || null,
    recommendation: qualityTier === "low"
      ? "Low-quality photo signals — request additional photos before making a purchase decision"
      : qualityTier === "adequate" && warnings.length
      ? `Review: ${warnings[0]}`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) {
  return Math.round(v * 100) / 100;
}
