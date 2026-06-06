// src/visionCategoryPolicy.js
//
// Vision-path category policy.
//
// HIGH_STAKES_CATEGORIES in index.js is the market-side filter set — it includes
// "collectible"/"collectibles" for market-result filtering. Here we define a
// VISION-specific policy that distinguishes truly auth-sensitive categories from
// brand-useful collectibles where the visible brand IS the search identity.
//
// Pure sync functions, no I/O, no side effects.
//
// The key insight:
//   Auth-sensitive (luxury/sneakers/watches/jewelry/electronics/cards):
//     Brand auth is the CLAIM we're evaluating → master consensus is required.
//   Brand-useful collectible (diecast planes, toy models, figurines, books):
//     The visible brand/model text ("Hawaiian Airlines", "Boeing 787") IS the
//     identity token, not an auth claim. query_fast can safely seed the search;
//     aircraft-family identity locks still protect against drift.

// Vision true-high-stakes: always requires master consensus regardless of brand.
// Intentionally excludes "collectible"/"collectibles": a diecast model plane's
// airline livery is its identity token, not a luxury/auth claim.
const _VISION_TRUE_HIGH_STAKES = new Set([
  "luxury",
  "handbag",
  "handbags",
  "sneakers",
  "sneaker",
  "watches",
  "watch",
  "jewelry",
  "jewellery",
  "electronics",
  "trading_cards",
  "trading_card",
  "coin",
  "coins",
  "sports_card",
  "sports_cards",
]);

/**
 * Returns true for categories where the visible brand/model text IS the
 * search identity — so high brandCertainty is a helpful signal, not a risk.
 * Used to bypass the brand-certainty gate in the vision fast path.
 */
export function isBrandUsefulCategory(category) {
  if (!category) return false;
  const c = String(category).trim().toLowerCase();
  if (c.includes("model") || c.includes("diecast") || c.includes("die cast")) return true;
  if (c.includes("toy") || c.includes("collectible") || c.includes("figurine")) return true;
  if (c.includes("book") || c.includes("dvd") || c.includes("cd") || c.includes("blu")) return true;
  if (c.includes("game") || c.includes("puzzle")) return true;
  if (c.includes("tool") || c.includes("camera") || c.includes("appliance")) return true;
  return false;
}

/**
 * Returns true for categories where master consensus is ALWAYS required.
 * Excludes "collectible"/"collectibles" — those are brand-useful (the brand
 * text is the item identity, not an auth claim requiring full consensus).
 */
export function isTrueHighStakesVisionCategory(category) {
  if (!category) return false;
  const c = String(category).trim().toLowerCase();
  return _VISION_TRUE_HIGH_STAKES.has(c);
}

/**
 * Returns a composite policy object for VISION_CATEGORY_POLICY logging.
 *
 * @param {string} category - raw category string from the model
 * @returns {{ category: string, trueHighStakes: boolean, brandUseful: boolean,
 *             brandUsefulCollectible: boolean, reason: string }}
 */
export function getVisionCategoryPolicy(category) {
  const c = String(category || "").trim().toLowerCase();
  const trueHighStakes = isTrueHighStakesVisionCategory(c);
  const brandUseful = isBrandUsefulCategory(c);
  // "brand-useful collectible" = appeared in market HIGH_STAKES but is safe for
  // the vision fast lane because brand is identity, not an auth claim.
  const brandUsefulCollectible = !trueHighStakes && brandUseful;
  const reason = trueHighStakes
    ? "auth_sensitive_requires_master"
    : brandUsefulCollectible
      ? "brand_is_identity_fast_lane_ok"
      : brandUseful
        ? "brand_useful_not_high_stakes"
        : "standard";
  return { category: c, trueHighStakes, brandUseful, brandUsefulCollectible, reason };
}
