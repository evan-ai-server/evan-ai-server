// src/scanToListPipeline.js
// Scan-to-List Pipeline: scan once → ready-to-post listing for eBay, StockX,
// Depop, Poshmark, Mercari, and Instagram. Each listing is platform-optimized
// with correct title length, SEO keywords, price strategy, and tone.
// "Scan → paste → sold."

// ── Platform specs ────────────────────────────────────────────────────────────
const PLATFORM_SPECS = {
  ebay: {
    titleMaxLen:   80,
    tone:          "formal",
    includesPrice: true,
    hasSKU:        false,
    descStyle:     "bullet_points",
    shippingNote:  true,
  },
  stockx: {
    titleMaxLen:   60,
    tone:          "minimal",
    includesPrice: false, // StockX uses ask/bid, not fixed price
    hasSKU:        true,
    descStyle:     "none",
    shippingNote:  false,
  },
  depop: {
    titleMaxLen:   50,
    tone:          "casual",
    includesPrice: true,
    hasSKU:        false,
    descStyle:     "casual_paragraph",
    shippingNote:  true,
  },
  poshmark: {
    titleMaxLen:   50,
    tone:          "friendly",
    includesPrice: false,
    hasSKU:        false,
    descStyle:     "friendly_paragraph",
    shippingNote:  false, // Poshmark handles shipping
  },
  mercari: {
    titleMaxLen:   40,
    tone:          "neutral",
    includesPrice: false,
    hasSKU:        false,
    descStyle:     "short_paragraph",
    shippingNote:  true,
  },
};

// ── Category-specific SEO keyword sets ───────────────────────────────────────
const CATEGORY_SEO_KEYWORDS = {
  sneakers:    ["authentic", "deadstock", "OG all", "fast ship", "worn once", "VNDS"],
  bag:         ["authentic", "dust bag included", "serial number", "gold hardware", "clean interior"],
  watch:       ["running well", "box and papers", "original bracelet", "lume intact", "polished"],
  electronics: ["unlocked", "iCloud off", "no scratches", "fully functional", "clean ESN"],
  apparel:     ["no stains", "no pulls", "measurements in photos", "smoke free", "gently worn"],
  eyewear:     ["authentic", "case included", "no scratches on lens", "original box"],
};

// ── Condition label map ───────────────────────────────────────────────────────
const CONDITION_LABELS = {
  new:         { ebay: "New with tags",  depop: "New with tags",    poshmark: "NWT",         mercari: "New" },
  like_new:    { ebay: "Like New",       depop: "Like new",         poshmark: "Like New",    mercari: "Like New" },
  very_good:   { ebay: "Very Good",      depop: "Excellent",        poshmark: "Excellent",   mercari: "Good" },
  good:        { ebay: "Good",           depop: "Good",             poshmark: "Good",        mercari: "Fair" },
  fair:        { ebay: "Acceptable",     depop: "Fair",             poshmark: "Fair",        mercari: "Poor" },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Build an optimized title for a platform given item identity.
 */
function buildTitle(identity = {}, platform = "ebay", maxLen = 80) {
  const brand    = identity?.brand    || "";
  const model    = identity?.model    || "";
  const colorway = identity?.colorway || identity?.color || "";
  const size     = identity?.size     || "";
  const year     = identity?.year     || "";
  const condition = identity?.condition || "";
  const style    = PLATFORM_SPECS[platform]?.tone || "formal";

  const parts = [brand, model, colorway, size ? `Sz ${size}` : "", year].filter(Boolean);

  if (style === "casual") {
    // Depop: lowercase friendly
    return parts.join(" ").slice(0, maxLen);
  }
  if (style === "minimal") {
    // StockX: clean model name only
    return `${brand} ${model} ${colorway}`.trim().slice(0, maxLen);
  }
  // Formal/friendly: add condition signal
  const conditionTag = condition.toLowerCase().includes("new") ? "New" : "";
  return [conditionTag, ...parts].filter(Boolean).join(" ").slice(0, maxLen);
}

/**
 * Build platform-specific description.
 */
function buildDescription(identity = {}, platform = "ebay", conditionForensics = null, category = "") {
  const brand     = identity?.brand    || "Item";
  const model     = identity?.model    || "";
  const color     = identity?.colorway || identity?.color || "";
  const size      = identity?.size     || "";
  const condition = identity?.condition || "Good";
  const style     = PLATFORM_SPECS[platform]?.descStyle || "bullet_points";

  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const seoKeys = (CATEGORY_SEO_KEYWORDS[cat] || []).slice(0, 3);

  const conditionNote = conditionForensics?.detections?.length
    ? `\n\nCondition notes: ${conditionForensics.detections.slice(0, 2).map(d => d.label).join(", ")}.`
    : "";

  if (style === "none") return "";

  if (style === "bullet_points") {
    return [
      `${brand} ${model} ${color}`.trim(),
      size       ? `• Size: ${size}`             : null,
      condition  ? `• Condition: ${condition}`   : null,
      `• ${seoKeys.join(" • ")}`,
      conditionNote,
      "\nShips within 1-2 business days. Please review all photos before purchasing.",
    ].filter(Boolean).join("\n");
  }

  if (style === "casual_paragraph") {
    return `${brand} ${model}${color ? " in " + color : ""}${size ? ", size " + size : ""}. ${
      condition ? "Condition: " + condition + ". " : ""
    }${seoKeys[0] ? seoKeys[0].charAt(0).toUpperCase() + seoKeys[0].slice(1) + ". " : ""}${conditionNote}\n\nMessage me with any questions! Ships fast 🚀`;
  }

  if (style === "friendly_paragraph") {
    return `Selling my ${brand} ${model}${color ? " in " + color : ""}${size ? " (size " + size + ")" : ""}. ${
      condition ? condition + " condition. " : ""
    }${conditionNote}\n\nBundle discount available! Feel free to make an offer. 💕`;
  }

  // short_paragraph (Mercari)
  return `${brand} ${model} ${color}${size ? " Sz " + size : ""}. ${condition} condition. ${seoKeys.slice(0, 2).join(", ")}.${conditionNote}`;
}

/**
 * Compute the recommended listing price for a platform.
 * Platform-specific strategies: eBay slightly below median, StockX at ask floor, etc.
 */
function computeListingPrice(medianMarket = null, scannedPrice = null, platform = "ebay", conditionImpact = 0) {
  const market  = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  if (!market) return null;

  const adjusted = round2(market * (1 - conditionImpact / 100));

  const strategy = {
    ebay:     round2(adjusted * 0.97),  // slightly below median to beat competition
    stockx:   round2(adjusted * 0.99),  // near ask floor
    depop:    round2(adjusted * 0.95),  // slightly lower for faster Depop velocity
    poshmark: round2(adjusted * 1.05),  // Poshmark shoppers expect to offer down
    mercari:  round2(adjusted * 0.93),  // lowest fees, price accordingly
  };

  return strategy[platform] ?? adjusted;
}

/**
 * Generate hashtags for social/Depop listings.
 */
function buildHashtags(identity = {}, category = "") {
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");
  const brand = String(identity?.brand || "").toLowerCase().replace(/\s+/g, "");
  const model = String(identity?.model || "").toLowerCase().replace(/\s+/g, "");
  const color = String(identity?.colorway || identity?.color || "").toLowerCase().replace(/\s+/g, "");

  const base = ["resale", "thrift", "secondhand", "vintagefashion", "ootd"];
  const catTags = {
    sneaker:     ["sneakerhead", "sneakers", "kicks", "sneakercommunity"],
    bag:         ["luxuryfashion", "designerbag", "handbag", "authenticluxury"],
    watch:       ["watchcommunity", "watches", "wristwatch", "horology"],
    electronics: ["tech", "apple", "gadgets"],
    apparel:     ["streetwear", "fashion", "vintage"],
    eyewear:     ["sunglasses", "eyewear", "shades"],
  };

  const tags = [brand, model, color, ...base, ...(catTags[cat] || [])]
    .filter(Boolean)
    .slice(0, 15)
    .map(t => `#${t}`);

  return tags.join(" ");
}

/**
 * Generate a complete listing for a single platform.
 */
export function generatePlatformListing(platform = "ebay", {
  identity         = {},
  category         = "",
  scannedPrice     = null,
  medianMarket     = null,
  conditionForensics = null,
  conditionImpact  = 0,
} = {}) {
  const spec  = PLATFORM_SPECS[platform];
  if (!spec)  return null;

  const title       = buildTitle(identity, platform, spec.titleMaxLen);
  const description = buildDescription(identity, platform, conditionForensics, category);
  const price       = computeListingPrice(medianMarket, scannedPrice, platform, conditionImpact);
  const condKey     = String(identity?.condition || "good").toLowerCase().replace(/\s+/g, "_");
  const condLabel   = CONDITION_LABELS[condKey]?.[platform] || identity?.condition || "Good";
  const hashtags    = ["depop", "instagram"].includes(platform) ? buildHashtags(identity, category) : null;

  const sku         = spec.hasSKU
    ? [identity?.brand, identity?.model, identity?.colorway, identity?.size].filter(Boolean).join("-").replace(/\s+/g, "-").toUpperCase()
    : null;

  return {
    platform,
    title,
    description,
    price,
    conditionLabel: condLabel,
    sku,
    hashtags,
    readyToPaste: true,
  };
}

/**
 * Master scan-to-list payload: generates listings for all platforms at once.
 */
export function buildScanToListPayload({
  identity         = {},
  category         = "",
  scannedPrice     = null,
  medianMarket     = null,
  conditionForensics = null,
  conditionPricing = null,
  resaleOptimizer  = null,
} = {}) {
  const conditionImpact = conditionPricing?.totalImpactPct || 0;
  const platforms = ["ebay", "stockx", "depop", "poshmark", "mercari"];

  const listings = {};
  for (const platform of platforms) {
    listings[platform] = generatePlatformListing(platform, {
      identity,
      category,
      scannedPrice: finiteOrNull(scannedPrice),
      medianMarket: finiteOrNull(medianMarket),
      conditionForensics,
      conditionImpact,
    });
  }

  // Best platform recommendation from resaleOptimizer
  const recommended = resaleOptimizer?.bestPlatform?.platform
    || Object.keys(listings)[0];

  return {
    listings,
    recommendedPlatform: recommended,
    recommendedListing:  listings[recommended] || null,
    topSignal: `Ready to list on ${platforms.length} platforms — best platform: ${recommended} at $${listings[recommended]?.price?.toFixed(2) ?? "market price"}`,
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
