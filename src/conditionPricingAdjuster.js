// src/conditionPricingAdjuster.js
// Condition-to-price calibration: correct market price for actual condition,
// "listed as Good but priced as New" mismatch alerts, negotiation anchors.

// ── Condition depreciation curves by category ─────────────────────────────────
// Multiplier applied to "new" market price to get fair resale value per condition
// Conditions: new / like_new / good / fair / poor
const CONDITION_DEPRECIATION = {
  sneakers: {
    new:       1.00,
    like_new:  0.88,
    good:      0.72,
    fair:      0.52,
    poor:      0.30,
    note: "Sneakers lose value fast — deadstock (DS) commands full premium",
  },
  apparel: {
    new:       1.00,
    like_new:  0.82,
    good:      0.65,
    fair:      0.45,
    poor:      0.20,
    note: "NWT apparel holds best; worn drops significantly",
  },
  bag: {
    new:       1.00,
    like_new:  0.88,
    good:      0.73,
    fair:      0.55,
    poor:      0.30,
    note: "Luxury bags hold value well — even used bags command strong prices",
  },
  electronics: {
    new:       1.00,
    like_new:  0.82,
    good:      0.65,
    fair:      0.45,
    poor:      0.22,
    note: "Electronics depreciate quickly; unlocked and factory reset matters",
  },
  watch: {
    new:       1.00,
    like_new:  0.92,
    good:      0.80,
    fair:      0.65,
    poor:      0.45,
    note: "Watches hold condition value better than most — service history helps",
  },
  eyewear: {
    new:       1.00,
    like_new:  0.80,
    good:      0.60,
    fair:      0.40,
    poor:      0.18,
    note: "Scratched lenses tank value — condition is paramount for eyewear",
  },
  collectibles: {
    new:       1.00,
    like_new:  0.90,
    good:      0.72,
    fair:      0.50,
    poor:      0.25,
    note: "Collectibles: graded/certified items command significant premiums",
  },
  default: {
    new:       1.00,
    like_new:  0.84,
    good:      0.68,
    fair:      0.50,
    poor:      0.28,
  },
};

// Condition label normalization
const CONDITION_ALIASES = {
  new:         ["new", "brand new", "nwt", "bnwt", "deadstock", "ds", "sealed", "unworn", "nos", "brand-new"],
  like_new:    ["like new", "vnds", "excellent", "mint", "near mint", "nearly new", "open box", "9/10", "10/10"],
  good:        ["good", "guc", "euc", "very good", "lightly used", "8/10", "7/10"],
  fair:        ["fair", "worn", "gently worn", "used", "5/10", "6/10"],
  poor:        ["poor", "heavily worn", "damaged", "for parts", "rough", "3/10", "4/10"],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Normalize a condition string to a canonical key.
 */
export function normalizeConditionKey(conditionLabel = "") {
  const c = String(conditionLabel || "").toLowerCase().trim();
  for (const [key, aliases] of Object.entries(CONDITION_ALIASES)) {
    if (aliases.some(a => c.includes(a))) return key;
  }
  return "good"; // safe default
}

/**
 * Compute the fair market value for an item given its condition.
 */
export function computeConditionAdjustedPrice(newMarketPrice, conditionLabel = "", category = "") {
  const newPrice = finiteOrNull(newMarketPrice);
  if (!newPrice) return null;

  const condKey  = normalizeConditionKey(conditionLabel);
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const curve    = CONDITION_DEPRECIATION[cat] || CONDITION_DEPRECIATION.default;

  const multiplier   = curve[condKey] ?? curve.good;
  const adjustedPrice = round2(newPrice * multiplier);

  return {
    conditionKey:     condKey,
    multiplier:       round2(multiplier),
    newMarketPrice:   round2(newPrice),
    adjustedPrice,
    depreciationPct:  round2((1 - multiplier) * 100),
    note:             curve.note || null,
  };
}

/**
 * Detect condition/price mismatch: is this item priced like a better condition than it is?
 * e.g. "Listed as Good but priced like New"
 */
export function detectConditionPriceMismatch({
  listingPrice     = null,
  conditionLabel   = "",
  newMarketPrice   = null,
  category         = "",
} = {}) {
  const listed    = finiteOrNull(listingPrice);
  const newPrice  = finiteOrNull(newMarketPrice);
  if (!listed || !newPrice) return null;

  const condKey      = normalizeConditionKey(conditionLabel);
  const cat          = String(category || "").toLowerCase().replace(/s$/, "");
  const curve        = CONDITION_DEPRECIATION[cat] || CONDITION_DEPRECIATION.default;

  const fairMultiplier   = curve[condKey] ?? curve.good;
  const fairPrice        = round2(newPrice * fairMultiplier);
  const premium          = round2(listed - fairPrice);
  const premiumPct       = round2((premium / fairPrice) * 100);

  // Determine implied condition based on listed price
  let impliedCondition = "new";
  let closestDelta     = Infinity;
  for (const [cKey, mult] of Object.entries(curve)) {
    if (typeof mult !== "number") continue;
    const impliedPrice = newPrice * mult;
    const delta        = Math.abs(impliedPrice - listed);
    if (delta < closestDelta) {
      closestDelta     = delta;
      impliedCondition = cKey;
    }
  }

  const hasMismatch = impliedCondition !== condKey && premiumPct > 10;

  return {
    hasMismatch,
    listedCondition:  condKey,
    impliedCondition,
    listingPrice:     listed,
    fairPrice,
    premium,
    premiumPct,
    signal: hasMismatch
      ? `Listed as "${condKey}" but priced like "${impliedCondition}" — ${premiumPct.toFixed(0)}% above fair condition value. Fair price: $${fairPrice.toFixed(2)}`
      : premiumPct > 15
      ? `Priced ${premiumPct.toFixed(0)}% above fair condition value — room to negotiate`
      : null,
  };
}

/**
 * Generate condition-based negotiation anchors.
 * Returns a fair offer range based on true condition.
 */
export function buildConditionNegotiationAnchors({
  listingPrice   = null,
  conditionLabel = "",
  newMarketPrice = null,
  category       = "",
} = {}) {
  const listed   = finiteOrNull(listingPrice);
  const newPrice = finiteOrNull(newMarketPrice) || listed;
  if (!newPrice) return null;

  const condKey  = normalizeConditionKey(conditionLabel);
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const curve    = CONDITION_DEPRECIATION[cat] || CONDITION_DEPRECIATION.default;

  const fairMult    = curve[condKey]      ?? 0.68;
  const lowBallMult = (curve[condKey] ?? 0.68) * 0.90; // 10% below fair
  const highMult    = (curve[condKey] ?? 0.68) * 1.05; // 5% above fair

  const fairOffer     = round2(newPrice * fairMult);
  const lowballOffer  = round2(newPrice * lowBallMult);
  const maxFairOffer  = round2(newPrice * highMult);

  return {
    conditionKey:  condKey,
    fairOffer,
    lowballOffer,
    maxFairOffer,
    listedPrice:   listed,
    discountFromListed: listed ? round2(((listed - fairOffer) / listed) * 100) : null,
    offerScript:   `Offer $${fairOffer.toFixed(2)} (fair for ${condKey} condition). Walk away above $${maxFairOffer.toFixed(2)}.`,
    walkAwayAbove: maxFairOffer,
  };
}

/**
 * Master condition pricing adjuster payload.
 */
export function buildConditionPricingPayload({
  listingPrice   = null,
  conditionLabel = "",
  newMarketPrice = null,
  medianMarket   = null,
  category       = "",
} = {}) {
  const basePrice   = finiteOrNull(newMarketPrice) || finiteOrNull(medianMarket);
  const adjusted    = computeConditionAdjustedPrice(basePrice, conditionLabel, category);
  const mismatch    = detectConditionPriceMismatch({ listingPrice, conditionLabel, newMarketPrice: basePrice, category });
  const anchors     = buildConditionNegotiationAnchors({ listingPrice, conditionLabel, newMarketPrice: basePrice, category });

  return {
    conditionKey:  normalizeConditionKey(conditionLabel),
    adjusted:      adjusted  || null,
    mismatch:      mismatch  || null,
    anchors:       anchors   || null,
    topSignal:     mismatch?.signal || (adjusted ? `Fair ${normalizeConditionKey(conditionLabel)} price: $${adjusted.adjustedPrice.toFixed(2)}` : null),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
