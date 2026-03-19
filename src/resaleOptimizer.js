// src/resaleOptimizer.js
// Resale listing optimizer: generates optimal title, price ladder,
// best platform, best day to list, and keyword formula per category.

// ── Platform fee registry ─────────────────────────────────────────────────────
const PLATFORM_FEES = {
  stockx:   0.095,  ebay:     0.133,  grailed:  0.09,
  poshmark: 0.20,   depop:    0.10,   mercari:  0.10,
  goat:     0.095,  facebook: 0.05,   etsy:     0.065,
};

// ── Best platform by category + condition ────────────────────────────────────
const PLATFORM_BY_CATEGORY = {
  sneakers: {
    new:       ["stockx", "goat", "ebay"],
    used:      ["ebay", "grailed", "facebook"],
    deadstock: ["stockx", "goat"],
  },
  apparel: {
    new:   ["grailed", "depop", "poshmark"],
    used:  ["depop", "poshmark", "grailed"],
    luxury:["the real real", "vestiaire", "grailed"],
  },
  bag: {
    new:    ["the real real", "fashionphile", "ebay"],
    used:   ["poshmark", "the real real", "ebay"],
    luxury: ["fashionphile", "vestiaire", "the real real"],
  },
  electronics: {
    new:   ["ebay", "swappa", "facebook"],
    used:  ["ebay", "swappa", "facebook"],
    parts: ["ebay"],
  },
  watch: {
    new:    ["chrono24", "ebay", "watchuseek"],
    used:   ["chrono24", "ebay", "watchuseek"],
    luxury: ["bob's watches", "chrono24", "ebay"],
  },
  eyewear: {
    new:  ["ebay", "poshmark", "depop"],
    used: ["ebay", "depop"],
  },
  collectibles: {
    new:  ["ebay", "grailed"],
    used: ["ebay"],
  },
};

// ── Best days to list by category ────────────────────────────────────────────
// Based on buyer browsing patterns — Sunday/Monday for fashion, Thu/Fri for electronics
const BEST_LIST_DAYS = {
  sneakers:     ["Sunday", "Monday", "Thursday"],
  apparel:      ["Sunday", "Monday", "Saturday"],
  bag:          ["Sunday", "Tuesday", "Thursday"],
  electronics:  ["Thursday", "Friday", "Sunday"],
  watch:        ["Sunday", "Wednesday", "Thursday"],
  eyewear:      ["Sunday", "Monday"],
  collectibles: ["Sunday", "Saturday"],
  default:      ["Sunday", "Thursday"],
};

// ── Title keyword formulas by category ───────────────────────────────────────
// Formula: [required tokens] + [condition token] + [size/spec token] + [platform keywords]
const TITLE_FORMULAS = {
  sneakers: {
    template: "{brand} {model} {colorway} {size} {condition} {year}",
    powerKeywords: ["DS", "Deadstock", "OG All", "Retro", "sz", "W/Box", "NO BOX", "VNDS"],
    conditionMap: { new: "DS", like_new: "VNDS", good: "GUC", fair: "Worn" },
    maxLen: 80,
  },
  apparel: {
    template: "{brand} {model} {size} {color} {condition} {fit}",
    powerKeywords: ["vintage", "rare", "sample", "grail", "BNWT", "NWT", "archive"],
    conditionMap: { new: "NWT", like_new: "BNWT", good: "EUC", fair: "GUC" },
    maxLen: 80,
  },
  bag: {
    template: "{brand} {model} {color} {hardware} {condition} {size}",
    powerKeywords: ["authentic", "w/dustbag", "w/receipt", "full set", "serial"],
    conditionMap: { new: "Brand New", like_new: "Excellent", good: "Good", fair: "Fair" },
    maxLen: 80,
  },
  electronics: {
    template: "{brand} {model} {storage} {color} {condition} {carrier}",
    powerKeywords: ["unlocked", "factory reset", "iCloud clear", "original box", "w/charger", "tested working"],
    conditionMap: { new: "Brand New Sealed", like_new: "Like New Open Box", good: "Good Working", fair: "Fair Tested" },
    maxLen: 80,
  },
  watch: {
    template: "{brand} {model} {reference} {condition} {year} {papers}",
    powerKeywords: ["box and papers", "B&P", "full set", "service papers", "original bracelet"],
    conditionMap: { new: "Unworn", like_new: "Mint", good: "Very Good", fair: "Good" },
    maxLen: 80,
  },
  eyewear: {
    template: "{brand} {model} {color} {lens} {condition}",
    powerKeywords: ["polarized", "authentic", "w/case", "w/cloth", "original"],
    conditionMap: { new: "NWT", like_new: "Like New", good: "EUC", fair: "GUC" },
    maxLen: 80,
  },
};

// ── Price ladder profiles ─────────────────────────────────────────────────────
// Strategy: list high, drop by X% after Y days, clear at Z% of median
const PRICE_LADDER_PROFILES = {
  high_liquidity: {
    day0:   1.10, // 10% above median
    day7:   1.00, // at median
    day14:  0.93,
    day30:  0.85,
    label: "Hot market — start above median, drop weekly",
  },
  moderate_liquidity: {
    day0:   1.05,
    day7:   0.97,
    day14:  0.90,
    day30:  0.82,
    label: "Moderate market — price near median, patience pays",
  },
  low_liquidity: {
    day0:   0.98,
    day7:   0.92,
    day14:  0.85,
    day30:  0.75,
    label: "Slow market — price slightly below median from day one",
  },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Build the optimal listing title for a scanned item.
 */
export function buildOptimalListingTitle(identity = {}, category = "", conditionLabel = "") {
  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const formula = TITLE_FORMULAS[cat] || TITLE_FORMULAS["apparel"];

  const brand = titleCase(identity?.brand || "");
  const model = titleCase(identity?.model || "");
  const color = titleCase(identity?.color || identity?.colorway || "");
  const size  = identity?.size  ? `sz ${identity.size}` : "";
  const year  = identity?.year  ? String(identity.year) : "";

  const condKey  = resolveConditionKey(conditionLabel);
  const condWord = formula.conditionMap[condKey] || conditionLabel || "";

  // Build title from template token substitution
  let title = formula.template
    .replace("{brand}",     brand)
    .replace("{model}",     model)
    .replace("{colorway}",  color)
    .replace("{color}",     color)
    .replace("{size}",      size)
    .replace("{condition}", condWord)
    .replace("{year}",      year)
    .replace(/\{[^}]+\}/g, "") // strip unfilled tokens
    .replace(/\s{2,}/g, " ")
    .trim();

  // Truncate to platform max
  if (title.length > formula.maxLen) {
    title = title.slice(0, formula.maxLen).trim();
  }

  return {
    title,
    powerKeywords: formula.powerKeywords.slice(0, 4),
    conditionWord: condWord,
    note: `Add size, colorway, or condition details to improve visibility`,
  };
}

/**
 * Compute a price ladder: what to list at on day 0, 7, 14, 30.
 */
export function buildPriceLadder(medianMarketPrice, liquidityTier = "moderate") {
  const median = finiteOrNull(medianMarketPrice);
  if (!median) return null;

  const profileKey = liquidityTier === "high"   ? "high_liquidity"
                   : liquidityTier === "low"    ? "low_liquidity"
                   : "moderate_liquidity";
  const profile = PRICE_LADDER_PROFILES[profileKey];

  return {
    liquidityTier,
    profileLabel:  profile.label,
    ladder: {
      day0:  round2(median * profile.day0),
      day7:  round2(median * profile.day7),
      day14: round2(median * profile.day14),
      day30: round2(median * profile.day30),
    },
    medianMarket: round2(median),
    signal: `List at $${round2(median * profile.day0).toFixed(2)} — drop to $${round2(median * profile.day14).toFixed(2)} if not sold in 14 days`,
  };
}

/**
 * Recommend the best platform(s) to list on given category + condition.
 */
export function recommendListingPlatform(category = "", conditionLabel = "", isLuxury = false) {
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const condKey  = resolveConditionKey(conditionLabel);
  const lookup   = PLATFORM_BY_CATEGORY[cat];

  let platforms = [];
  if (lookup) {
    if (isLuxury && lookup.luxury) {
      platforms = lookup.luxury;
    } else {
      platforms = lookup[condKey] || lookup.used || [];
    }
  }

  if (!platforms.length) platforms = ["ebay", "mercari"];

  return {
    primary:   platforms[0],
    secondary: platforms[1] || null,
    tertiary:  platforms[2] || null,
    all:       platforms,
    feeEstimatePct: round2((PLATFORM_FEES[platforms[0]] || 0.10) * 100),
    signal: `Best platform for this item: ${platforms[0]}`,
  };
}

/**
 * Build the full resale optimizer payload.
 */
export function buildResaleOptimizerPayload({
  identity      = {},
  category      = "",
  scannedPrice  = null,
  medianMarket  = null,
  conditionLabel = "",
  liquidityTier = "moderate",
  isLuxury      = false,
} = {}) {
  const cat             = String(category || "").toLowerCase().replace(/s$/, "");
  const listingTitle    = buildOptimalListingTitle(identity, cat, conditionLabel);
  const priceLadder     = buildPriceLadder(medianMarket || scannedPrice, liquidityTier);
  const platformRec     = recommendListingPlatform(cat, conditionLabel, isLuxury);
  const bestDays        = BEST_LIST_DAYS[cat] || BEST_LIST_DAYS.default;

  const profitEstimate = (() => {
    if (!priceLadder || !scannedPrice) return null;
    const buyPrice   = finiteOrNull(scannedPrice);
    const listPrice  = priceLadder.ladder.day0;
    const feeRate    = PLATFORM_FEES[platformRec.primary] || 0.10;
    const netRevenue = round2(listPrice * (1 - feeRate));
    const profit     = round2(netRevenue - (buyPrice || 0));
    const roi        = buyPrice ? round2((profit / buyPrice) * 100) : null;
    return { listPrice, netRevenue, profit, roi, feeRate: round2(feeRate * 100) };
  })();

  return {
    listingTitle,
    priceLadder,
    platformRecommendation: platformRec,
    bestDaysToList: bestDays,
    profitEstimate: profitEstimate || null,
    topSignal: priceLadder
      ? `List on ${platformRec.primary} at $${priceLadder.ladder.day0.toFixed(2)} on ${bestDays[0]}`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function resolveConditionKey(conditionLabel) {
  const c = String(conditionLabel || "").toLowerCase();
  if (c.includes("new") || c.includes("ds") || c.includes("deadstock") || c.includes("unworn")) return "new";
  if (c.includes("like new") || c.includes("vnds") || c.includes("excellent"))                   return "like_new";
  if (c.includes("good") || c.includes("euc") || c.includes("guc"))                              return "good";
  return "fair";
}

function titleCase(str) {
  return String(str || "").replace(/\b\w/g, c => c.toUpperCase());
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
