// src/categoryRegistry.js
// Category Registry — Phase 15: Category Immortality.
//
// Single source of truth for:
//   - Canonical category names + alias normalization
//   - Per-category profile (replica risk, condition logic, event calendar, identity engine)
//   - Feature flag toggles per category (which Phase 15 systems are active)
//
// All other Phase 15 modules import CANONICAL names from here, never raw strings.

// ── Canonical names ────────────────────────────────────────────────────────────

export const CAT = {
  SNEAKERS:       "sneakers",
  WATCHES:        "watches",
  ELECTRONICS:    "electronics",
  HANDBAGS:       "handbags",
  TRADING_CARDS:  "trading_cards",
  CLOTHING:       "clothing",
  JEWELRY:        "jewelry",
  TOOLS:          "tools",
  FURNITURE:      "furniture",
  COLLECTIBLES:   "collectibles",
  BOOKS:          "books",
  SPORTS_EQUIPMENT: "sports_equipment",
  EYEWEAR:        "eyewear",
  GENERIC:        "generic",
};

// ── Alias → canonical map ──────────────────────────────────────────────────────

const ALIAS_MAP = {
  // sneakers
  sneaker:        CAT.SNEAKERS,
  shoe:           CAT.SNEAKERS,
  shoes:          CAT.SNEAKERS,
  footwear:       CAT.SNEAKERS,
  kicks:          CAT.SNEAKERS,
  trainers:       CAT.SNEAKERS,
  "athletic shoes": CAT.SNEAKERS,
  "running shoes":  CAT.SNEAKERS,
  // watches
  watch:          CAT.WATCHES,
  timepiece:      CAT.WATCHES,
  wristwatch:     CAT.WATCHES,
  horology:       CAT.WATCHES,
  // electronics
  electronic:     CAT.ELECTRONICS,
  tech:           CAT.ELECTRONICS,
  gadget:         CAT.ELECTRONICS,
  gadgets:        CAT.ELECTRONICS,
  smartphone:     CAT.ELECTRONICS,
  phone:          CAT.ELECTRONICS,
  laptop:         CAT.ELECTRONICS,
  console:        CAT.ELECTRONICS,
  gaming:         CAT.ELECTRONICS,
  tablet:         CAT.ELECTRONICS,
  camera:         CAT.ELECTRONICS,
  headphones:     CAT.ELECTRONICS,
  audio:          CAT.ELECTRONICS,
  // handbags
  handbag:        CAT.HANDBAGS,
  bag:            CAT.HANDBAGS,
  bags:           CAT.HANDBAGS,
  purse:          CAT.HANDBAGS,
  purses:         CAT.HANDBAGS,
  tote:           CAT.HANDBAGS,
  clutch:         CAT.HANDBAGS,
  backpack:       CAT.HANDBAGS,
  wallet:         CAT.HANDBAGS,
  "designer bag": CAT.HANDBAGS,
  // trading cards
  "trading cards": CAT.TRADING_CARDS,
  "trading card":  CAT.TRADING_CARDS,
  cards:          CAT.TRADING_CARDS,
  card:           CAT.TRADING_CARDS,
  tcg:            CAT.TRADING_CARDS,
  pokemon:        CAT.TRADING_CARDS,
  mtg:            CAT.TRADING_CARDS,
  "magic the gathering": CAT.TRADING_CARDS,
  "sports cards": CAT.TRADING_CARDS,
  // clothing
  clothes:        CAT.CLOTHING,
  apparel:        CAT.CLOTHING,
  streetwear:     CAT.CLOTHING,
  jacket:         CAT.CLOTHING,
  shirt:          CAT.CLOTHING,
  hoodie:         CAT.CLOTHING,
  pants:          CAT.CLOTHING,
  vintage:        CAT.CLOTHING,
  "vintage clothing": CAT.CLOTHING,
  // jewelry
  jewellery:      CAT.JEWELRY,
  necklace:       CAT.JEWELRY,
  ring:           CAT.JEWELRY,
  bracelet:       CAT.JEWELRY,
  earrings:       CAT.JEWELRY,
  // tools
  tool:           CAT.TOOLS,
  hardware:       CAT.TOOLS,
  power_tools:    CAT.TOOLS,
  "power tools":  CAT.TOOLS,
  // furniture
  chair:          CAT.FURNITURE,
  desk:           CAT.FURNITURE,
  table:          CAT.FURNITURE,
  sofa:           CAT.FURNITURE,
  couch:          CAT.FURNITURE,
  // collectibles
  collectible:    CAT.COLLECTIBLES,
  figure:         CAT.COLLECTIBLES,
  figures:        CAT.COLLECTIBLES,
  toy:            CAT.COLLECTIBLES,
  toys:           CAT.COLLECTIBLES,
  vintage_toy:    CAT.COLLECTIBLES,
  // books
  book:           CAT.BOOKS,
  textbook:       CAT.BOOKS,
  // sports equipment
  "sports equipment": CAT.SPORTS_EQUIPMENT,
  sport:          CAT.SPORTS_EQUIPMENT,
  sports:         CAT.SPORTS_EQUIPMENT,
  bike:           CAT.SPORTS_EQUIPMENT,
  bicycle:        CAT.SPORTS_EQUIPMENT,
  // eyewear
  glasses:        CAT.EYEWEAR,
  sunglasses:     CAT.EYEWEAR,
  eyeglasses:     CAT.EYEWEAR,
  frames:         CAT.EYEWEAR,
};

/**
 * Normalize a raw category string to a canonical CAT key.
 * Returns CAT.GENERIC if no match.
 */
export function normalizeCategory(raw) {
  if (!raw) return CAT.GENERIC;
  const s = String(raw).toLowerCase().trim().replace(/_/g, " ").replace(/\s+/g, " ");
  if (Object.values(CAT).includes(s.replace(/ /g, "_"))) return s.replace(/ /g, "_");
  if (Object.values(CAT).includes(s)) return s;
  return ALIAS_MAP[s] || CAT.GENERIC;
}

// ── Category profiles ─────────────────────────────────────────────────────────

/**
 * Per-category profile.
 * All booleans default to false; override per category only for active features.
 */
const CATEGORY_PROFILES = {
  [CAT.SNEAKERS]: {
    replicaRisk:          "HIGH",
    hasIdentityEngine:    true,
    hasConditionProfile:  true,
    hasEventCalendar:     true,
    hasKnowledgeBase:     true,
    hasLocalMarketAdj:    true,
    identityFields:       ["brand", "model", "colorway", "size", "condition"],
    conditionTiers:       ["deadstock", "vnds", "used_excellent", "used_good", "beater"],
    minDataPointsForSignal: 3,
  },
  [CAT.WATCHES]: {
    replicaRisk:          "HIGH",
    hasIdentityEngine:    true,
    hasConditionProfile:  true,
    hasEventCalendar:     true,
    hasKnowledgeBase:     true,
    hasLocalMarketAdj:    false,
    identityFields:       ["brand", "model", "reference", "caseMaterial", "dialColor", "complications"],
    conditionTiers:       ["new_full_set", "excellent", "very_good", "good", "fair"],
    minDataPointsForSignal: 2,
  },
  [CAT.ELECTRONICS]: {
    replicaRisk:          "MEDIUM",
    hasIdentityEngine:    true,
    hasConditionProfile:  true,
    hasEventCalendar:     true,
    hasKnowledgeBase:     true,
    hasLocalMarketAdj:    false,
    identityFields:       ["brand", "model", "storageGB", "color", "carrier", "condition"],
    conditionTiers:       ["new_sealed", "open_box", "excellent", "good", "fair", "parts_only"],
    minDataPointsForSignal: 3,
  },
  [CAT.HANDBAGS]: {
    replicaRisk:          "HIGH",
    hasIdentityEngine:    true,
    hasConditionProfile:  true,
    hasEventCalendar:     false,
    hasKnowledgeBase:     true,
    hasLocalMarketAdj:    false,
    identityFields:       ["brand", "model", "material", "color", "hardware", "size"],
    conditionTiers:       ["pristine", "excellent", "very_good", "good", "fair"],
    minDataPointsForSignal: 2,
  },
  [CAT.TRADING_CARDS]: {
    replicaRisk:          "HIGH",
    hasIdentityEngine:    true,
    hasConditionProfile:  true,
    hasEventCalendar:     true,
    hasKnowledgeBase:     true,
    hasLocalMarketAdj:    false,
    identityFields:       ["game", "set", "cardName", "cardNumber", "grade", "gradingService", "parallel"],
    conditionTiers:       ["psa10", "psa9", "bgs95", "bgs9", "ungraded_nm", "ungraded_played"],
    minDataPointsForSignal: 3,
  },
  [CAT.CLOTHING]: {
    replicaRisk:          "LOW",
    hasIdentityEngine:    false,
    hasConditionProfile:  true,
    hasEventCalendar:     false,
    hasKnowledgeBase:     false,
    hasLocalMarketAdj:    false,
    identityFields:       ["brand", "model", "size", "color", "condition"],
    conditionTiers:       ["new_with_tags", "like_new", "good", "fair"],
    minDataPointsForSignal: 5,
  },
  [CAT.JEWELRY]: {
    replicaRisk:          "MEDIUM",
    hasIdentityEngine:    false,
    hasConditionProfile:  true,
    hasEventCalendar:     false,
    hasKnowledgeBase:     false,
    hasLocalMarketAdj:    false,
    identityFields:       ["brand", "material", "stones", "weight"],
    conditionTiers:       ["new", "excellent", "good", "fair"],
    minDataPointsForSignal: 5,
  },
  [CAT.EYEWEAR]: {
    replicaRisk:          "MEDIUM",
    hasIdentityEngine:    false,
    hasConditionProfile:  true,
    hasEventCalendar:     false,
    hasKnowledgeBase:     false,
    hasLocalMarketAdj:    false,
    identityFields:       ["brand", "model", "color", "frameSize"],
    conditionTiers:       ["new_in_case", "like_new", "good", "fair"],
    minDataPointsForSignal: 5,
  },
};

const DEFAULT_PROFILE = {
  replicaRisk:          "LOW",
  hasIdentityEngine:    false,
  hasConditionProfile:  false,
  hasEventCalendar:     false,
  hasKnowledgeBase:     false,
  hasLocalMarketAdj:    false,
  identityFields:       ["brand", "model", "condition"],
  conditionTiers:       ["new", "like_new", "good", "fair", "poor"],
  minDataPointsForSignal: 5,
};

/**
 * Get the category profile for a canonical category.
 */
export function getCategoryProfile(canonicalCategory) {
  return CATEGORY_PROFILES[canonicalCategory] || DEFAULT_PROFILE;
}

/**
 * Check whether a given canonical category has an active identity engine.
 */
export function hasIdentityEngine(canonicalCategory) {
  return getCategoryProfile(canonicalCategory).hasIdentityEngine === true;
}

/**
 * List all canonical categories that have active identity engines.
 */
export function getIdentityEngineCats() {
  return Object.entries(CATEGORY_PROFILES)
    .filter(([, p]) => p.hasIdentityEngine)
    .map(([cat]) => cat);
}
