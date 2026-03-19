// src/substituteIntel.js
// Same-item-for-less + same-look-for-less substitute detection

// ── Brand tier registry ───────────────────────────────────────────────────────
const BRAND_TIER = {
  // sneakers
  "jordan": "premium",         "nike": "premium",           "adidas": "premium",
  "new balance": "premium",    "on running": "premium",     "asics": "mid",
  "saucony": "mid",            "brooks": "mid",             "hoka": "mid",
  "vans": "mid",               "converse": "mid",           "reebok": "mid",
  "puma": "mid",               "champion": "budget",        "fila": "budget",
  "skechers": "budget",
  // apparel
  "supreme": "luxury",         "palace": "luxury",          "off-white": "luxury",
  "fear of god": "luxury",     "stone island": "luxury",    "acne": "luxury",
  "arc'teryx": "luxury",       "canada goose": "luxury",    "moncler": "luxury",
  "north face": "premium",     "patagonia": "premium",
  "carhartt": "mid",           "dickies": "mid",            "uniqlo": "mid",
  "gap": "mid",                "hm": "budget",              "shein": "budget",
  // electronics
  "apple": "premium",          "samsung": "premium",        "sony": "premium",
  "bose": "premium",           "beats": "premium",
  "anker": "mid",              "jbl": "mid",                "jabra": "mid",
  "skullcandy": "budget",      "soundcore": "budget",
  // bags
  "louis vuitton": "luxury",   "gucci": "luxury",           "chanel": "luxury",
  "prada": "luxury",           "hermes": "luxury",          "dior": "luxury",
  "coach": "premium",          "kate spade": "premium",     "michael kors": "premium",
  "fossil": "mid",             "herschel": "mid",
  // watches
  "rolex": "luxury",           "patek philippe": "luxury",  "ap": "luxury",
  "omega": "premium",          "tag heuer": "premium",      "breitling": "premium",
  "hamilton": "mid",           "seiko": "mid",              "citizen": "mid",
  "casio": "budget",           "timex": "budget",
  // eyewear
  "oakley": "premium",         "ray-ban": "premium",        "maui jim": "premium",
  "costa": "premium",          "persol": "premium",
  "goodr": "mid",              "knockaround": "mid",        "sungait": "budget",
};

// ── Same-look alternatives by category ───────────────────────────────────────
// Map: premium brand key → budget look-alike suggestions
const SAME_LOOK_MAP = {
  sneakers: [
    { premiumBrand: "jordan",      budgetBrand: "puma",        lookKey: "court_low_top",    label: "Puma Clyde / Court for less" },
    { premiumBrand: "nike",        budgetBrand: "new balance", lookKey: "chunky_runner",    label: "New Balance 550 alternative" },
    { premiumBrand: "adidas",      budgetBrand: "saucony",     lookKey: "retro_runner",     label: "Saucony Jazz retro runner" },
    { premiumBrand: "air force 1", budgetBrand: "vans",        lookKey: "low_clean_white",  label: "Vans SK8-Lo clean white" },
    { premiumBrand: "on running",  budgetBrand: "hoka",        lookKey: "performance_runner",label: "HOKA Clifton at lower cost" },
    { premiumBrand: "new balance", budgetBrand: "asics",       lookKey: "chunky_retro",     label: "ASICS Gel-Lyte retro runner" },
  ],
  eyewear: [
    { premiumBrand: "ray-ban",  budgetBrand: "knockaround", lookKey: "aviator",       label: "Knockaround Aviator dupe" },
    { premiumBrand: "ray-ban",  budgetBrand: "goodr",       lookKey: "wrap_sport",    label: "Goodr sport wrap" },
    { premiumBrand: "oakley",   budgetBrand: "knockaround", lookKey: "sport_shield",  label: "Knockaround sport shield" },
    { premiumBrand: "persol",   budgetBrand: "goodr",       lookKey: "round_classic", label: "Goodr round classic" },
  ],
  bag: [
    { premiumBrand: "louis vuitton", budgetBrand: "coach",      lookKey: "monogram_tote",      label: "Coach monogram tote" },
    { premiumBrand: "gucci",         budgetBrand: "kate spade", lookKey: "structured_shoulder", label: "Kate Spade structured bag" },
    { premiumBrand: "prada",         budgetBrand: "fossil",     lookKey: "nylon_zip",           label: "Fossil nylon zip bag" },
  ],
  apparel: [
    { premiumBrand: "canada goose", budgetBrand: "north face", lookKey: "down_puffer",     label: "North Face Nuptse puffer" },
    { premiumBrand: "moncler",      budgetBrand: "north face", lookKey: "quilted_puffer",  label: "North Face quilted jacket" },
    { premiumBrand: "north face",   budgetBrand: "carhartt",   lookKey: "work_jacket",     label: "Carhartt active jacket" },
    { premiumBrand: "arc'teryx",    budgetBrand: "patagonia",  lookKey: "technical_shell", label: "Patagonia Torrentshell" },
    { premiumBrand: "stone island", budgetBrand: "carhartt",   lookKey: "utility_jacket",  label: "Carhartt WIP utility jacket" },
  ],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Find same/identical item listed cheaper across existing market results.
 */
export function findSameItemCheaper(identity = {}, uiItems = [], scannedPrice = null) {
  if (!Array.isArray(uiItems) || !uiItems.length) return null;

  const brand       = String(identity?.brand || "").toLowerCase().trim();
  const model       = String(identity?.model || "").toLowerCase().trim();
  const scanned     = finiteOrNull(scannedPrice);

  const brandTokens = brand.split(/\s+/).filter(Boolean);
  const modelTokens = model.split(/\s+/).filter(t => t.length >= 3);

  const candidates = uiItems.filter(item => {
    const t          = String(item?.title || "").toLowerCase();
    const brandMatch = brandTokens.length > 0 && brandTokens.every(tk => t.includes(tk));
    const modelMatch = modelTokens.length > 0 && modelTokens.some(tk => t.includes(tk));
    return brandMatch && modelMatch;
  });

  if (!candidates.length) return null;

  const sorted     = [...candidates].sort((a, b) =>
    (finiteOrNull(a?.totalPrice ?? a?.price) ?? 9999) - (finiteOrNull(b?.totalPrice ?? b?.price) ?? 9999)
  );
  const cheapest      = sorted[0];
  const cheapestPrice = finiteOrNull(cheapest?.totalPrice ?? cheapest?.price);
  if (!cheapestPrice) return null;

  const savings    = scanned !== null ? round2(scanned - cheapestPrice) : null;
  const savingsPct = scanned !== null && scanned > 0
    ? round2(((scanned - cheapestPrice) / scanned) * 100)
    : null;

  // Only surface if genuinely cheaper by at least 5%
  if (savingsPct !== null && savingsPct < 5) return null;

  return {
    found:          true,
    type:           "same_item_cheaper",
    cheapestItem:   cheapest,
    cheapestPrice,
    savingsDollars: savings,
    savingsPct,
    platform:       cheapest?.source || cheapest?.platform || "unknown",
    signal:         `Same item found ${savingsPct !== null ? savingsPct.toFixed(0) + "% ($" + (savings ?? 0).toFixed(2) + ")" : ""} cheaper on ${cheapest?.source || "another platform"}`,
  };
}

/**
 * Find visually similar but cheaper substitute (same look, different brand).
 */
export function findVisualSubstitutes(identity = {}, category = "", uiItems = [], scannedPrice = null) {
  const brand = String(identity?.brand || "").toLowerCase().trim();
  // Normalize category: remove plural, lower
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");

  const pool = SAME_LOOK_MAP[cat] || [];
  const matches = pool.filter(entry =>
    brand.includes(entry.premiumBrand) || entry.premiumBrand.split(" ").every(t => brand.includes(t))
  );

  if (!matches.length) return null;

  const tierOfScanned = resolveBrandTier(brand);

  return {
    found:       true,
    type:        "same_look_cheaper",
    brandTier:   tierOfScanned,
    suggestions: matches.map(opt => ({
      budgetBrand:          opt.budgetBrand,
      label:                opt.label,
      lookKey:              opt.lookKey,
      suggestedSearchQuery: `${opt.budgetBrand} ${opt.lookKey.replace(/_/g, " ")}`,
    })),
    signal: `Same aesthetic, lower price — try: ${matches[0]?.label || "a budget alternative"}`,
  };
}

/**
 * Detect significant price gaps between platforms inside the result set.
 */
export function detectCheaperPlatformListing(uiItems = [], scannedPrice = null) {
  if (!Array.isArray(uiItems) || uiItems.length < 2) return null;
  const scanned = finiteOrNull(scannedPrice);

  const priced = uiItems
    .map(i => ({ ...i, _p: finiteOrNull(i?.totalPrice ?? i?.price) }))
    .filter(i => i._p !== null)
    .sort((a, b) => a._p - b._p);

  if (priced.length < 2) return null;

  const cheapest      = priced[0];
  const mostExpensive = priced[priced.length - 1];
  const gap           = mostExpensive._p - cheapest._p;
  const gapPct        = mostExpensive._p > 0 ? round2((gap / mostExpensive._p) * 100) : 0;

  if (gapPct < 15) return null;

  const baseline     = scanned !== null ? scanned : mostExpensive._p;
  const savings      = round2(baseline - cheapest._p);
  const savingsPct   = round2((savings / baseline) * 100);

  return {
    found:          true,
    type:           "platform_price_gap",
    cheapest:       { price: cheapest._p, platform: cheapest?.source || "unknown", url: cheapest?.url || null },
    mostExpensive:  { price: mostExpensive._p, platform: mostExpensive?.source || "unknown" },
    gapDollars:     round2(gap),
    gapPct,
    savingsDollars: savings,
    savingsPct,
    signal:         `Buy on ${cheapest?.source || "cheapest platform"} and save $${savings.toFixed(2)} (${savingsPct.toFixed(0)}%)`,
  };
}

/**
 * Master substitute intelligence payload — attached to every scan response.
 */
export function buildSubstituteIntelPayload({
  identity     = {},
  uiItems      = [],
  scannedPrice = null,
  category     = "",
} = {}) {
  const sameItemCheaper = findSameItemCheaper(identity, uiItems, scannedPrice);
  const sameLookCheaper = findVisualSubstitutes(identity, category, uiItems, scannedPrice);
  const platformGap     = detectCheaperPlatformListing(uiItems, scannedPrice);

  const hasSavings = !!(sameItemCheaper?.found || sameLookCheaper?.found || platformGap?.found);

  let topSavingsDollars = null;
  const signals = [];

  if (sameItemCheaper?.found) {
    signals.push(sameItemCheaper.signal);
    if (sameItemCheaper.savingsDollars != null)
      topSavingsDollars = Math.max(topSavingsDollars ?? 0, sameItemCheaper.savingsDollars);
  }
  if (sameLookCheaper?.found) signals.push(sameLookCheaper.signal);
  if (platformGap?.found) {
    signals.push(platformGap.signal);
    if (platformGap.savingsDollars != null)
      topSavingsDollars = Math.max(topSavingsDollars ?? 0, platformGap.savingsDollars);
  }

  return {
    hasSavings,
    topSavingsDollars,
    signals,
    sameItemCheaper:  sameItemCheaper  || null,
    sameLookCheaper:  sameLookCheaper  || null,
    platformGap:      platformGap      || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function resolveBrandTier(brand) {
  for (const [key, tier] of Object.entries(BRAND_TIER)) {
    if (brand.includes(key) || key.includes(brand)) return tier;
  }
  return "unknown";
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
