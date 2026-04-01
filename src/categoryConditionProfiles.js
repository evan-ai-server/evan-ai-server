// src/categoryConditionProfiles.js
// Category Condition Profiles — Phase 15: Category Immortality.
//
// Per-category condition tier definitions, value retention curves, and
// condition-text classifiers. Replaces/extends the generic conditionTierPricer
// with category-aware scoring.
//
// Each category has:
//   tiers        — ordered list of condition tiers (best → worst)
//   retentionMap — map of tier slug → fraction of "like-new" value retained
//   textMatcher  — function(text) → tier slug
//
// Non-negotiable: condition scoring is DESCRIPTIVE (what the item is worth
// in this condition), never aspirational (never bumps a price up).

import { CAT } from "./categoryRegistry.js";

// ── Tier definitions ──────────────────────────────────────────────────────────

const CONDITION_PROFILES = {
  [CAT.SNEAKERS]: {
    tiers: ["deadstock", "vnds", "used_excellent", "used_good", "beater"],
    retentionMap: {
      deadstock:       1.00,
      vnds:            0.85,
      used_excellent:  0.70,
      used_good:       0.55,
      beater:          0.30,
    },
    labels: {
      deadstock:       "Deadstock (DS)",
      vnds:            "Very Near Deadstock (VNDS)",
      used_excellent:  "Used — Excellent",
      used_good:       "Used — Good",
      beater:          "Beater",
    },
    textMatcher(text = "") {
      const t = text.toLowerCase();
      if (/\b(ds|deadstock|new\s*in\s*box|nib|unworn|brand\s*new)\b/.test(t)) return "deadstock";
      if (/\b(vnds|very\s*near\s*deadstock|tried\s*on|worn\s*once|worn\s*twice)\b/.test(t)) return "vnds";
      if (/\b(excellent|like\s*new|minimal\s*wear|light\s*wear|8\/10|9\/10)\b/.test(t)) return "used_excellent";
      if (/\b(good|normal\s*wear|moderate\s*wear|7\/10|6\/10)\b/.test(t)) return "used_good";
      if (/\b(beater|heavily\s*worn|beat|damaged|worn|5\/10|4\/10)\b/.test(t)) return "beater";
      return null;
    },
  },

  [CAT.WATCHES]: {
    tiers: ["new_full_set", "excellent", "very_good", "good", "fair"],
    retentionMap: {
      new_full_set:  1.00,
      excellent:     0.88,
      very_good:     0.75,
      good:          0.60,
      fair:          0.40,
    },
    labels: {
      new_full_set:  "New — Full Set (Box & Papers)",
      excellent:     "Excellent — Minor Signs of Wear",
      very_good:     "Very Good — Light Scratches",
      good:          "Good — Visible Wear",
      fair:          "Fair — Heavy Wear/Service Needed",
    },
    textMatcher(text = "") {
      const t = text.toLowerCase();
      if (/\b(box\s*and\s*papers|b&p|full\s*set|new\s*old\s*stock|nos|unworn)\b/.test(t)) return "new_full_set";
      if (/\b(excellent|mint|near\s*mint|no\s*scratch|barely\s*worn)\b/.test(t)) return "excellent";
      if (/\b(very\s*good|light\s*scratch|minor\s*wear|well\s*kept)\b/.test(t)) return "very_good";
      if (/\b(good|some\s*wear|visible\s*scratch|moderate)\b/.test(t)) return "good";
      if (/\b(fair|heavy\s*wear|worn|service|needs\s*service|polished)\b/.test(t)) return "fair";
      return null;
    },
  },

  [CAT.ELECTRONICS]: {
    tiers: ["new_sealed", "open_box", "excellent", "good", "fair", "parts_only"],
    retentionMap: {
      new_sealed:   1.00,
      open_box:     0.90,
      excellent:    0.80,
      good:         0.65,
      fair:         0.45,
      parts_only:   0.15,
    },
    labels: {
      new_sealed:   "New — Factory Sealed",
      open_box:     "Open Box",
      excellent:    "Excellent — No Visible Damage",
      good:         "Good — Minor Cosmetic Wear",
      fair:         "Fair — Functional, Visible Damage",
      parts_only:   "For Parts / Not Working",
    },
    textMatcher(text = "") {
      const t = text.toLowerCase();
      if (/\b(factory\s*sealed|brand\s*new\s*sealed|never\s*opened|unopened)\b/.test(t)) return "new_sealed";
      if (/\b(open\s*box|opened|like\s*new)\b/.test(t)) return "open_box";
      if (/\b(excellent|mint|no\s*scratch|flawless|perfect)\b/.test(t)) return "excellent";
      if (/\b(good|minor\s*scratch|light\s*scratch|normal\s*use)\b/.test(t)) return "good";
      if (/\b(fair|cracked|damaged|dent|broken\s*screen|crack)\b/.test(t)) return "fair";
      if (/\b(parts|not\s*working|for\s*repair|broken|dead)\b/.test(t)) return "parts_only";
      return null;
    },
  },

  [CAT.HANDBAGS]: {
    tiers: ["pristine", "excellent", "very_good", "good", "fair"],
    retentionMap: {
      pristine:     1.00,
      excellent:    0.85,
      very_good:    0.70,
      good:         0.55,
      fair:         0.35,
    },
    labels: {
      pristine:     "Pristine — With Dustbag/Auth Card",
      excellent:    "Excellent — Barely Used",
      very_good:    "Very Good — Light Signs of Use",
      good:         "Good — Visible Wear",
      fair:         "Fair — Heavy Wear/Repairs Needed",
    },
    textMatcher(text = "") {
      const t = text.toLowerCase();
      if (/\b(pristine|never\s*used|new\s*with\s*tags|nwt|deadstock)\b/.test(t)) return "pristine";
      if (/\b(excellent|barely\s*used|like\s*new|mint)\b/.test(t)) return "excellent";
      if (/\b(very\s*good|gently\s*used|minor\s*wear|light\s*use)\b/.test(t)) return "very_good";
      if (/\b(good|some\s*wear|moderate\s*wear|visible\s*wear)\b/.test(t)) return "good";
      if (/\b(fair|heavy\s*wear|worn|stain|repair|damaged)\b/.test(t)) return "fair";
      return null;
    },
  },

  [CAT.TRADING_CARDS]: {
    tiers: ["psa10", "psa9", "bgs95", "bgs9", "ungraded_nm", "ungraded_played"],
    retentionMap: {
      psa10:           1.00,
      psa9:            0.40,
      bgs95:           0.65,
      bgs9:            0.30,
      ungraded_nm:     0.15,
      ungraded_played: 0.05,
    },
    labels: {
      psa10:           "PSA 10 Gem Mint",
      psa9:            "PSA 9 Mint",
      bgs95:           "BGS 9.5 Gem Mint",
      bgs9:            "BGS 9 Mint",
      ungraded_nm:     "Ungraded — Near Mint",
      ungraded_played: "Ungraded — Played",
    },
    textMatcher(text = "") {
      const t = text.toLowerCase();
      if (/\bpsa\s*10\b/.test(t)) return "psa10";
      if (/\bpsa\s*9\b/.test(t))  return "psa9";
      if (/\bbgs\s*9\.5\b/.test(t)) return "bgs95";
      if (/\bbgs\s*9\b/.test(t))  return "bgs9";
      if (/\b(nm|near\s*mint|nm-?mt|mint|raw)\b/.test(t)) return "ungraded_nm";
      if (/\b(played|lp|mp|hp|poor|damaged)\b/.test(t)) return "ungraded_played";
      return null;
    },
  },
};

// Generic fallback
const GENERIC_PROFILE = {
  tiers: ["new", "like_new", "good", "fair", "poor"],
  retentionMap: {
    new:      1.00,
    like_new: 0.85,
    good:     0.65,
    fair:     0.45,
    poor:     0.20,
  },
  labels: {
    new:      "New",
    like_new: "Like New",
    good:     "Good",
    fair:     "Fair",
    poor:     "Poor / For Parts",
  },
  textMatcher(text = "") {
    const t = text.toLowerCase();
    if (/\b(new|brand\s*new|sealed)\b/.test(t)) return "new";
    if (/\b(like\s*new|excellent|mint|lightly\s*used)\b/.test(t)) return "like_new";
    if (/\b(good|gently\s*used|used)\b/.test(t)) return "good";
    if (/\b(fair|worn|moderate\s*wear)\b/.test(t)) return "fair";
    if (/\b(poor|heavily\s*worn|damaged|for\s*parts|broken)\b/.test(t)) return "poor";
    return null;
  },
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Get the condition profile for a canonical category.
 */
export function getConditionProfile(canonicalCategory) {
  return CONDITION_PROFILES[canonicalCategory] || GENERIC_PROFILE;
}

/**
 * Classify condition from text using the category-specific matcher.
 * Returns { tier, label, retention, confidence }.
 * confidence: "high" if matcher found a match, "low" if using default.
 *
 * @param {string} canonicalCategory
 * @param {string} text — item title + description
 * @param {string|null} [fallbackTier] — tier to use if text is ambiguous
 */
export function classifyConditionForCategory(canonicalCategory, text = "", fallbackTier = null) {
  const profile = getConditionProfile(canonicalCategory);
  const tier = profile.textMatcher(text) || fallbackTier || profile.tiers[Math.floor(profile.tiers.length / 2)];

  return {
    tier,
    label:      profile.labels[tier]      || tier,
    retention:  profile.retentionMap[tier] ?? 0.5,
    confidence: profile.textMatcher(text) ? "high" : "low",
    allTiers:   profile.tiers.map((t) => ({
      tier:      t,
      label:     profile.labels[t],
      retention: profile.retentionMap[t],
    })),
  };
}

/**
 * Given a price and a condition tier, estimate the "like-new" equivalent price.
 * Useful for normalizing comps across condition tiers.
 *
 * @param {string} canonicalCategory
 * @param {string} tier
 * @param {number} price
 * @returns {number|null} estimated like-new price
 */
export function estimateLikeNewPrice(canonicalCategory, tier, price) {
  if (price == null) return null;
  const profile = getConditionProfile(canonicalCategory);
  const retention = profile.retentionMap[tier] ?? 0.65;
  if (retention <= 0) return null;
  return Math.round((price / retention) * 100) / 100;
}

/**
 * Check whether condition A is better than condition B for a category.
 * Used to warn when a buyer is getting a worse condition than expected.
 */
export function isConditionBetter(canonicalCategory, tierA, tierB) {
  const profile = getConditionProfile(canonicalCategory);
  const idxA = profile.tiers.indexOf(tierA);
  const idxB = profile.tiers.indexOf(tierB);
  if (idxA === -1 || idxB === -1) return null;
  return idxA < idxB; // lower index = better condition
}
