// src/sealTagDetector.js
// Feature 68 — Seal / Tag / Sticker Detector
// Analyzes vision output for presence of original tags, hang tags, manufacturer
// seals, dust bags, authentication stickers, CoA cards, and original box.
// "Tag still attached = new condition confidence boost"
// "Original box present = +$15-40 premium on most items"
// Outputs: detected tags array, condition upgrade signal, price premium estimate.

// ── Tag/Seal vocabulary by evidence type ─────────────────────────────────────
const TAG_EVIDENCE = {
  // Original retail tags
  hang_tag: {
    keywords:   ["hang tag", "hangtag", "price tag", "retail tag", "original tag", "tags attached", "tag on", "tags on", "with tags", "nwt", "nwot", "new with tags", "new without tags", "unworn tag"],
    conditionBoost: "like_new",
    label:      "Original hang tag attached",
    pricePremium: 0.08,  // +8% vs same item without tag
    authWeight:  0.15,
  },
  // Manufacturer box
  original_box: {
    keywords:   ["original box", "og box", "with box", "in box", "w/box", "deadstock box", "ds box", "box included", "box lid", "box insert", "lace bag", "tissue paper", "original packaging"],
    conditionBoost: "new",
    label:      "Original box present",
    pricePremium: 0.12,
    authWeight:  0.20,
  },
  // Dust bag (luxury bags, shoes)
  dust_bag: {
    keywords:   ["dust bag", "dustbag", "sleeper", "pouch included", "storage bag", "cloth bag", "flannel bag"],
    conditionBoost: null,  // no condition change, but indicates care
    label:      "Dust bag / sleeper included",
    pricePremium: 0.06,
    authWeight:  0.10,
  },
  // Authentication sticker / certificate
  auth_sticker: {
    keywords:   ["authentication sticker", "auth sticker", "hologram sticker", "serial sticker", "coa", "certificate of authenticity", "auth card", "legit check", "legit checked", "stockx tag", "goat verified", "real authentication cert", "entrupy cert"],
    conditionBoost: null,
    label:      "Authentication certificate / sticker present",
    pricePremium: 0.10,
    authWeight:  0.40,
  },
  // Manufacturer seal
  manufacturer_seal: {
    keywords:   ["factory sealed", "sealed box", "unopened", "shrink wrap", "plastic seal", "tamper seal", "security seal", "original seal"],
    conditionBoost: "new",
    label:      "Factory / manufacturer seal intact",
    pricePremium: 0.15,
    authWeight:  0.25,
  },
  // Receipt / proof of purchase
  receipt: {
    keywords:   ["receipt included", "proof of purchase", "original receipt", "store receipt", "retail receipt", "purchase receipt"],
    conditionBoost: null,
    label:      "Receipt / proof of purchase included",
    pricePremium: 0.04,
    authWeight:  0.15,
  },
  // Extra laces / accessories
  extras: {
    keywords:   ["extra laces", "extra set", "replacement laces", "all accessories", "all inserts", "all cards", "all straps", "extra straps", "extra bands", "extra links"],
    conditionBoost: null,
    label:      "Extras / accessories included",
    pricePremium: 0.03,
    authWeight:  0.05,
  },
};

// ── Condition hierarchy (for upgrades) ───────────────────────────────────────
const CONDITION_RANK = { new: 5, like_new: 4, good: 3, fair: 2, poor: 1 };

function upgradeCondition(current, targetUpgrade) {
  if (!targetUpgrade) return current;
  const currentRank = CONDITION_RANK[current] ?? 3;
  const targetRank  = CONDITION_RANK[targetUpgrade] ?? 3;
  return targetRank > currentRank ? targetUpgrade : current;
}

// ── Price premium lookup by category ─────────────────────────────────────────
const BOX_PREMIUM_BY_CATEGORY = {
  sneakers:    35,  // original box = ~$35 premium for sneakers
  watch:       50,  // box + papers = major premium
  bag:         20,
  electronics: 15,
  apparel:     10,
  default:     15,
};

// ── Core detection engine ─────────────────────────────────────────────────────

/**
 * Detect tags/seals from all available text evidence.
 */
export function detectSealsAndTags({
  visibleText    = [],
  styleWords     = [],
  conditionFlags = [],
  title          = "",
  description    = "",
  category       = null,
} = {}) {
  const allText = [
    ...visibleText,
    ...styleWords,
    ...conditionFlags,
    title,
    description,
  ].join(" ").toLowerCase();

  const detections = [];
  let totalPricePremiumPct  = 0;
  let totalAuthBoost        = 0;
  let bestConditionUpgrade  = null;

  for (const [type, spec] of Object.entries(TAG_EVIDENCE)) {
    const matched = spec.keywords.some(kw => allText.includes(kw.toLowerCase()));
    if (matched) {
      detections.push({
        type,
        label:         spec.label,
        pricePremiumPct: spec.pricePremium,
        authWeightBoost: spec.authWeight,
        conditionBoost:  spec.conditionBoost,
      });
      totalPricePremiumPct += spec.pricePremium;
      totalAuthBoost       += spec.authWeight;
      if (spec.conditionBoost) {
        bestConditionUpgrade = spec.conditionBoost === "new"
          ? "new"
          : bestConditionUpgrade ?? spec.conditionBoost;
      }
    }
  }

  // Cap at 35% total premium
  totalPricePremiumPct = Math.min(0.35, totalPricePremiumPct);

  // Absolute box premium by category
  const cat = String(category || "").toLowerCase().replace(/s$/, "");
  const boxPremiumDollars = detections.some(d => d.type === "original_box")
    ? (BOX_PREMIUM_BY_CATEGORY[cat] ?? BOX_PREMIUM_BY_CATEGORY.default)
    : 0;

  const hasAnyTag = detections.length > 0;

  return {
    detections,
    hasAnyTag,
    hasOriginalBox:       detections.some(d => d.type === "original_box"),
    hasHangTag:           detections.some(d => d.type === "hang_tag"),
    hasAuthSticker:       detections.some(d => d.type === "auth_sticker"),
    hasManufacturerSeal:  detections.some(d => d.type === "manufacturer_seal"),
    hasDustBag:           detections.some(d => d.type === "dust_bag"),
    hasReceipt:           detections.some(d => d.type === "receipt"),
    conditionUpgrade:     bestConditionUpgrade,
    totalPricePremiumPct: round2(totalPricePremiumPct),
    boxPremiumDollars,
    authBoost:            round2(Math.min(0.5, totalAuthBoost)),
  };
}

/**
 * Apply condition upgrade based on tag detections to a vision identity.
 */
export function applyConditionUpgrade(currentCondition, sealResult) {
  if (!sealResult?.conditionUpgrade) return currentCondition;
  return upgradeCondition(currentCondition || "good", sealResult.conditionUpgrade);
}

/**
 * Compute adjusted price with tag premium applied.
 */
export function computeTagAdjustedPrice(basePrice, sealResult) {
  const base = Number(basePrice);
  if (!Number.isFinite(base) || base <= 0 || !sealResult?.totalPricePremiumPct) return base;
  return round2(base * (1 + sealResult.totalPricePremiumPct));
}

/**
 * Master payload builder.
 */
export function buildSealTagPayload({
  visibleText    = [],
  styleWords     = [],
  conditionFlags = [],
  title          = "",
  description    = "",
  category       = null,
  currentCondition = null,
  basePrice      = null,
} = {}) {
  const result = detectSealsAndTags({ visibleText, styleWords, conditionFlags, title, description, category });
  const upgradedCondition  = applyConditionUpgrade(currentCondition, result);
  const tagAdjustedPrice   = computeTagAdjustedPrice(basePrice, result);
  const conditionUpgraded  = upgradedCondition !== currentCondition;

  const topSignal = buildTagSignal(result, conditionUpgraded, upgradedCondition, tagAdjustedPrice, basePrice);

  return {
    sealTags:           result,
    conditionUpgraded,
    upgradedCondition:  conditionUpgraded ? upgradedCondition : null,
    tagAdjustedPrice:   tagAdjustedPrice !== basePrice ? tagAdjustedPrice : null,
    topSignal,
  };
}

function buildTagSignal(result, conditionUpgraded, upgradedCondition, adjustedPrice, basePrice) {
  if (!result.hasAnyTag) return null;
  const parts = [];
  if (result.hasOriginalBox) parts.push("Original box");
  if (result.hasHangTag)     parts.push("Tags attached");
  if (result.hasAuthSticker) parts.push("Auth cert present");
  if (result.hasDustBag)     parts.push("Dust bag included");
  if (conditionUpgraded)     parts.push(`→ condition upgraded to ${upgradedCondition}`);
  if (adjustedPrice > basePrice) parts.push(`→ ~${(result.totalPricePremiumPct * 100).toFixed(0)}% price premium`);
  return parts.join(". ");
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
