// src/resaleModeClassifier.js
// Resale Mode Classifier — determines whether an item's exit market is
// LOCAL (must sell in-person / metro), NATIONAL (can ship), or EITHER.
//
// This matters because national eBay comps are wrong for items that
// cannot practically be shipped: furniture, appliances, exercise equipment.
// Using the wrong comp pool overstates resale value and generates bad signals.

// ── Static classification table ───────────────────────────────────────────────

const RESALE_MODE_MAP = {
  // LOCAL — shipping cost would exceed practical threshold
  furniture:          "LOCAL",
  couch:              "LOCAL",
  sofa:               "LOCAL",
  dresser:            "LOCAL",
  mattress:           "LOCAL",
  appliances:         "LOCAL",
  appliance:          "LOCAL",
  refrigerator:       "LOCAL",
  washer:             "LOCAL",
  dryer:              "LOCAL",
  dishwasher:         "LOCAL",
  exercise_equipment: "LOCAL",
  treadmill:          "LOCAL",
  elliptical:         "LOCAL",
  "weight bench":     "LOCAL",
  large_electronics:  "LOCAL",
  television:         "LOCAL",
  tv:                 "LOCAL",
  monitor:            "LOCAL",
  desk:               "LOCAL",
  bicycle:            "LOCAL",
  bike:               "LOCAL",
  scooter:            "LOCAL",

  // NATIONAL — ships economically, deep liquid markets
  sneakers:           "NATIONAL",
  footwear:           "NATIONAL",
  shoes:              "NATIONAL",
  clothing:           "NATIONAL",
  apparel:            "NATIONAL",
  streetwear:         "NATIONAL",
  watches:            "NATIONAL",
  watch:              "NATIONAL",
  handbags:           "NATIONAL",
  handbag:            "NATIONAL",
  bags:               "NATIONAL",
  bag:                "NATIONAL",
  jewelry:            "NATIONAL",
  "trading cards":    "NATIONAL",
  trading_cards:      "NATIONAL",
  cards:              "NATIONAL",
  collectibles:       "NATIONAL",
  figures:            "NATIONAL",
  toys:               "NATIONAL",
  electronics:        "NATIONAL",  // small electronics ship fine
  phones:             "NATIONAL",
  laptops:            "NATIONAL",
  cameras:            "NATIONAL",
  headphones:         "NATIONAL",

  // EITHER — context-dependent
  books:              "EITHER",
  tools:              "EITHER",
  vintage:            "EITHER",
  instruments:        "EITHER",
  art:                "EITHER",
  records:            "EITHER",
  games:              "EITHER",
};

// Shipping cost as fraction of item value above which we force LOCAL
const LOCAL_SHIPPING_COST_THRESHOLD = 0.25;

// Estimated shipping costs by weight tier (USD)
const WEIGHT_SHIPPING_EST = {
  under_2lb:  12,
  under_5lb:  18,
  under_10lb: 28,
  under_20lb: 45,
  over_20lb:  80,
};

// ── Core exports ──────────────────────────────────────────────────────────────

/**
 * Classify resale mode from category and optional weight/price context.
 *
 * @param {string} category
 * @param {number} estimatedWeightLbs  — optional weight estimate
 * @param {number} estimatedSellPrice  — optional sell price (used for shipping ratio check)
 * @returns {"LOCAL"|"NATIONAL"|"EITHER"}
 */
export function classifyResaleMode(category, estimatedWeightLbs = null, estimatedSellPrice = null) {
  const key = normalizeCat(category);

  // Direct match
  if (RESALE_MODE_MAP[key])                      return RESALE_MODE_MAP[key];

  // Partial match
  for (const [k, mode] of Object.entries(RESALE_MODE_MAP)) {
    const kn = k.replace(/ /g, "_");
    if (key.includes(kn) || kn.includes(key))   return mode;
  }

  // Weight-based override: if shipping > 25% of estimated sell price → LOCAL
  if (estimatedWeightLbs != null && estimatedSellPrice != null) {
    const shipEst = estimatedWeightLbs < 2  ? WEIGHT_SHIPPING_EST.under_2lb
      : estimatedWeightLbs < 5  ? WEIGHT_SHIPPING_EST.under_5lb
      : estimatedWeightLbs < 10 ? WEIGHT_SHIPPING_EST.under_10lb
      : estimatedWeightLbs < 20 ? WEIGHT_SHIPPING_EST.under_20lb
      : WEIGHT_SHIPPING_EST.over_20lb;

    const ratio = shipEst / Math.max(1, estimatedSellPrice);
    if (ratio > LOCAL_SHIPPING_COST_THRESHOLD) return "LOCAL";
  }

  return "NATIONAL"; // default
}

/**
 * Build a note string explaining why LOCAL mode was applied.
 * Returns null when mode is NATIONAL or EITHER.
 */
export function buildResaleModeNote(category, resaleMode) {
  if (resaleMode !== "LOCAL") return null;
  return `${String(category || "This item")} typically sells locally — national shipping costs make eBay uneconomical. Pricing reflects local market only.`;
}

/**
 * Filter and weight items by resale mode.
 * For LOCAL: suppress eBay items, weight Facebook items 2x.
 * Returns an adjusted items array.
 */
export function applyResaleModeToItems(items, resaleMode, localResultCount = null) {
  if (!Array.isArray(items)) return items;
  if (resaleMode !== "LOCAL") return items;

  const expanded = [];
  for (const item of items) {
    const src = String(item?.source || item?.marketplace || "").toLowerCase();
    if (src.includes("ebay") || src.includes("e-bay")) continue; // suppress eBay for LOCAL
    expanded.push(item);
    if (src.includes("facebook") || src.includes("fb") || src.includes("marketplace")) {
      expanded.push(item); // weight 2x by duplicating
    }
  }
  return expanded;
}

/**
 * Returns the local fee table for profit calculation in LOCAL mode.
 * Keyed by platform name (lowercase).
 */
export const LOCAL_FEE_TABLE = {
  facebook:   { selling: 0.050, payment: 0.000, fixed: 0.00, label: "FB Marketplace" },
  "facebook marketplace": { selling: 0.050, payment: 0.000, fixed: 0.00, label: "FB Marketplace" },
  craigslist: { selling: 0.000, payment: 0.000, fixed: 0.00, label: "Craigslist" },
  offerup:    { selling: 0.079, payment: 0.000, fixed: 0.00, label: "OfferUp" },
  nextdoor:   { selling: 0.000, payment: 0.000, fixed: 0.00, label: "Nextdoor" },
};

export const LOCAL_PLATFORMS = ["Facebook Marketplace", "Craigslist", "OfferUp", "Nextdoor"];

// ── Helper ────────────────────────────────────────────────────────────────────
function normalizeCat(category) {
  return String(category || "").toLowerCase().trim()
    .replace(/[^a-z0-9 _]/g, "").replace(/\s+/g, "_");
}
