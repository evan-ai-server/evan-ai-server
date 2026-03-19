// src/brandTierClassifier.js
// Brand tier classifier: maps brands to tier (ultra_luxury → budget), computes
// brand equity score, resale retention rate, and cross-tier upgrade/downgrade
// intelligence. "This is a mid-tier brand priced at luxury levels — for $50
// more you get the real thing."

// ── Brand tier registry ───────────────────────────────────────────────────────
// tiers: ultra_luxury, luxury, premium, mid_tier, budget
// resaleRetention: % of original price retained after 1 year of use
const BRAND_REGISTRY = {
  // ── Ultra Luxury ──────────────────────────────────────────────────────────
  hermès:         { tier: "ultra_luxury", equity: 98, resaleRetention: 1.10, categories: ["bag", "watch", "apparel"] },
  chanel:         { tier: "ultra_luxury", equity: 96, resaleRetention: 1.05, categories: ["bag", "apparel", "eyewear"] },
  rolex:          { tier: "ultra_luxury", equity: 97, resaleRetention: 1.08, categories: ["watch"] },
  patek:          { tier: "ultra_luxury", equity: 99, resaleRetention: 1.20, categories: ["watch"] },
  "patek philippe":{ tier: "ultra_luxury", equity: 99, resaleRetention: 1.20, categories: ["watch"] },
  "audemars piguet":{ tier: "ultra_luxury", equity: 96, resaleRetention: 1.10, categories: ["watch"] },
  "richard mille":{ tier: "ultra_luxury", equity: 95, resaleRetention: 1.15, categories: ["watch"] },
  "louis vuitton":{ tier: "ultra_luxury", equity: 93, resaleRetention: 0.85, categories: ["bag", "apparel", "eyewear"] },
  lv:             { tier: "ultra_luxury", equity: 93, resaleRetention: 0.85, categories: ["bag", "apparel", "eyewear"] },
  dior:           { tier: "ultra_luxury", equity: 91, resaleRetention: 0.80, categories: ["bag", "apparel", "eyewear"] },
  gucci:          { tier: "ultra_luxury", equity: 88, resaleRetention: 0.72, categories: ["bag", "apparel", "eyewear"] },
  "bottega veneta":{ tier: "ultra_luxury", equity: 87, resaleRetention: 0.78, categories: ["bag", "apparel"] },
  prada:          { tier: "ultra_luxury", equity: 86, resaleRetention: 0.70, categories: ["bag", "apparel", "eyewear"] },
  "saint laurent":{ tier: "ultra_luxury", equity: 84, resaleRetention: 0.68, categories: ["bag", "apparel"] },
  ysl:            { tier: "ultra_luxury", equity: 84, resaleRetention: 0.68, categories: ["bag", "apparel"] },
  balenciaga:     { tier: "ultra_luxury", equity: 83, resaleRetention: 0.65, categories: ["bag", "apparel", "sneakers"] },
  "off-white":    { tier: "ultra_luxury", equity: 80, resaleRetention: 0.60, categories: ["sneakers", "apparel"] },
  "chrome hearts":{ tier: "ultra_luxury", equity: 82, resaleRetention: 0.90, categories: ["apparel", "eyewear"] },

  // ── Luxury ────────────────────────────────────────────────────────────────
  "tag heuer":    { tier: "luxury", equity: 72, resaleRetention: 0.55, categories: ["watch"] },
  omega:          { tier: "luxury", equity: 78, resaleRetention: 0.65, categories: ["watch"] },
  cartier:        { tier: "luxury", equity: 82, resaleRetention: 0.70, categories: ["watch", "eyewear"] },
  "iwc":          { tier: "luxury", equity: 76, resaleRetention: 0.60, categories: ["watch"] },
  "a. lange":     { tier: "luxury", equity: 90, resaleRetention: 0.95, categories: ["watch"] },
  versace:        { tier: "luxury", equity: 70, resaleRetention: 0.55, categories: ["bag", "apparel", "eyewear"] },
  "dolce gabbana":{ tier: "luxury", equity: 68, resaleRetention: 0.50, categories: ["bag", "apparel"] },
  fendi:          { tier: "luxury", equity: 72, resaleRetention: 0.58, categories: ["bag", "apparel"] },
  celine:         { tier: "luxury", equity: 74, resaleRetention: 0.60, categories: ["bag", "apparel"] },
  givenchy:       { tier: "luxury", equity: 70, resaleRetention: 0.55, categories: ["bag", "apparel"] },
  "ray-ban":      { tier: "luxury", equity: 65, resaleRetention: 0.50, categories: ["eyewear"] },
  rayban:         { tier: "luxury", equity: 65, resaleRetention: 0.50, categories: ["eyewear"] },
  "oliver peoples":{ tier: "luxury", equity: 70, resaleRetention: 0.55, categories: ["eyewear"] },
  "tom ford":     { tier: "luxury", equity: 73, resaleRetention: 0.58, categories: ["eyewear", "apparel"] },

  // ── Premium ───────────────────────────────────────────────────────────────
  jordan:         { tier: "premium", equity: 82, resaleRetention: 0.95, categories: ["sneakers", "apparel"] },
  nike:           { tier: "premium", equity: 78, resaleRetention: 0.75, categories: ["sneakers", "apparel"] },
  adidas:         { tier: "premium", equity: 72, resaleRetention: 0.65, categories: ["sneakers", "apparel"] },
  yeezy:          { tier: "premium", equity: 76, resaleRetention: 0.70, categories: ["sneakers", "apparel"] },
  "new balance":  { tier: "premium", equity: 70, resaleRetention: 0.68, categories: ["sneakers", "apparel"] },
  apple:          { tier: "premium", equity: 85, resaleRetention: 0.60, categories: ["electronics"] },
  samsung:        { tier: "premium", equity: 72, resaleRetention: 0.50, categories: ["electronics"] },
  sony:           { tier: "premium", equity: 74, resaleRetention: 0.52, categories: ["electronics"] },
  supreme:        { tier: "premium", equity: 76, resaleRetention: 0.80, categories: ["apparel", "sneakers"] },
  "stone island": { tier: "premium", equity: 72, resaleRetention: 0.68, categories: ["apparel"] },
  "arc'teryx":    { tier: "premium", equity: 75, resaleRetention: 0.70, categories: ["apparel"] },
  "canada goose": { tier: "premium", equity: 70, resaleRetention: 0.60, categories: ["apparel"] },
  moncler:        { tier: "premium", equity: 72, resaleRetention: 0.62, categories: ["apparel"] },
  "a bathing ape":{ tier: "premium", equity: 68, resaleRetention: 0.65, categories: ["apparel", "sneakers"] },
  bape:           { tier: "premium", equity: 68, resaleRetention: 0.65, categories: ["apparel", "sneakers"] },
  "stussy":       { tier: "premium", equity: 62, resaleRetention: 0.60, categories: ["apparel"] },

  // ── Mid tier ──────────────────────────────────────────────────────────────
  vans:           { tier: "mid_tier", equity: 52, resaleRetention: 0.45, categories: ["sneakers", "apparel"] },
  converse:       { tier: "mid_tier", equity: 50, resaleRetention: 0.42, categories: ["sneakers", "apparel"] },
  reebok:         { tier: "mid_tier", equity: 48, resaleRetention: 0.40, categories: ["sneakers", "apparel"] },
  puma:           { tier: "mid_tier", equity: 50, resaleRetention: 0.42, categories: ["sneakers", "apparel"] },
  asics:          { tier: "mid_tier", equity: 55, resaleRetention: 0.48, categories: ["sneakers"] },
  hoka:           { tier: "mid_tier", equity: 58, resaleRetention: 0.50, categories: ["sneakers"] },
  "on running":   { tier: "mid_tier", equity: 60, resaleRetention: 0.52, categories: ["sneakers"] },
  saucony:        { tier: "mid_tier", equity: 54, resaleRetention: 0.46, categories: ["sneakers"] },
  "michael kors": { tier: "mid_tier", equity: 48, resaleRetention: 0.35, categories: ["bag", "watch"] },
  "coach":        { tier: "mid_tier", equity: 50, resaleRetention: 0.38, categories: ["bag"] },
  "kate spade":   { tier: "mid_tier", equity: 46, resaleRetention: 0.35, categories: ["bag"] },
  "fossil":       { tier: "mid_tier", equity: 42, resaleRetention: 0.30, categories: ["watch"] },
  "mvmt":         { tier: "mid_tier", equity: 38, resaleRetention: 0.28, categories: ["watch"] },

  // ── Budget ────────────────────────────────────────────────────────────────
  "h&m":          { tier: "budget", equity: 20, resaleRetention: 0.15, categories: ["apparel"] },
  zara:           { tier: "budget", equity: 25, resaleRetention: 0.18, categories: ["apparel"] },
  "forever 21":   { tier: "budget", equity: 15, resaleRetention: 0.10, categories: ["apparel"] },
  shein:          { tier: "budget", equity: 10, resaleRetention: 0.05, categories: ["apparel"] },
  "fashion nova":  { tier: "budget", equity: 12, resaleRetention: 0.08, categories: ["apparel"] },
};

// ── Tier metadata ─────────────────────────────────────────────────────────────
const TIER_META = {
  ultra_luxury: { label: "Ultra Luxury",  priceFloor: 500,  priceCeil: null,  upgradeNote: null },
  luxury:       { label: "Luxury",        priceFloor: 200,  priceCeil: 2000,  upgradeNote: "For significantly more, consider an ultra-luxury option" },
  premium:      { label: "Premium",       priceFloor: 80,   priceCeil: 800,   upgradeNote: "For a moderate premium, you can step up to luxury" },
  mid_tier:     { label: "Mid-Tier",      priceFloor: 30,   priceCeil: 300,   upgradeNote: "For ~20-40% more you access the premium tier" },
  budget:       { label: "Budget",        priceFloor: 0,    priceCeil: 100,   upgradeNote: "A mid-tier option delivers dramatically better resale retention" },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve a brand's tier data.
 */
export function resolveBrandTier(brand = "") {
  const b = String(brand || "").toLowerCase().trim();
  for (const [key, data] of Object.entries(BRAND_REGISTRY)) {
    if (b === key || b.includes(key) || key.includes(b)) {
      return { brand: key, ...data, tierMeta: TIER_META[data.tier] };
    }
  }
  return null;
}

/**
 * Detect pricing tier mismatch: is this brand priced above or below its tier?
 */
export function detectBrandPriceMismatch(brand = "", scannedPrice = null, category = "") {
  const brandData = resolveBrandTier(brand);
  if (!brandData) return null;

  const price = finiteOrNull(scannedPrice);
  if (!price) return null;

  const { tier, tierMeta } = brandData;
  const floor = tierMeta?.priceFloor ?? 0;
  const ceil  = tierMeta?.priceCeil  ?? Infinity;

  const aboveTier = price > ceil * 1.30;
  const belowTier = ceil !== Infinity && price < floor * 0.60;

  if (aboveTier) {
    // Find what brand would normally command this price
    const nextTier = tier === "budget" ? "mid_tier" : tier === "mid_tier" ? "premium" : tier === "premium" ? "luxury" : null;
    return {
      mismatch:   "priced_above_tier",
      tier,
      price,
      expected:   `$${floor}–$${ceil}`,
      signal:     `${brand} is a ${TIER_META[tier].label} brand but priced at ${tier === "budget" ? "mid-tier" : tier === "mid_tier" ? "premium" : "luxury"} levels${nextTier ? ` — consider an actual ${TIER_META[nextTier].label} brand for better value` : ""}`,
      nextTier,
    };
  }

  return null;
}

/**
 * Find upgrade/downgrade suggestions for a given brand and price.
 * Returns same-category brands one tier up (upgrade) and one tier down (downgrade).
 */
export function findTierAlternatives(brand = "", category = "") {
  const brandData = resolveBrandTier(brand);
  if (!brandData) return { upgrades: [], downgrades: [] };

  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const tiers   = ["budget", "mid_tier", "premium", "luxury", "ultra_luxury"];
  const tierIdx = tiers.indexOf(brandData.tier);

  const upgradeTier   = tiers[tierIdx + 1] || null;
  const downgradeTier = tiers[tierIdx - 1] || null;

  const upgrades   = [];
  const downgrades = [];

  for (const [key, data] of Object.entries(BRAND_REGISTRY)) {
    if (key === brand.toLowerCase()) continue;
    if (!data.categories.includes(cat)) continue;

    if (data.tier === upgradeTier)   upgrades.push({ brand: key, ...data, tierMeta: TIER_META[data.tier] });
    if (data.tier === downgradeTier) downgrades.push({ brand: key, ...data, tierMeta: TIER_META[data.tier] });
  }

  return {
    upgrades:   upgrades.slice(0, 3),
    downgrades: downgrades.slice(0, 3),
  };
}

/**
 * Master brand tier classifier payload.
 */
export function buildBrandTierPayload({
  identity     = {},
  category     = "",
  scannedPrice = null,
  medianMarket = null,
} = {}) {
  const brand      = identity?.brand || "";
  const brandData  = resolveBrandTier(brand);
  const mismatch   = detectBrandPriceMismatch(brand, finiteOrNull(scannedPrice) || finiteOrNull(medianMarket), category);
  const alts       = brandData ? findTierAlternatives(brand, category) : { upgrades: [], downgrades: [] };

  const resaleRetention = brandData?.resaleRetention ?? null;
  const retainedValue   = resaleRetention && (finiteOrNull(scannedPrice) || finiteOrNull(medianMarket))
    ? round2((finiteOrNull(scannedPrice) || finiteOrNull(medianMarket)) * resaleRetention)
    : null;

  return {
    brand:            brand || null,
    tier:             brandData?.tier         || null,
    tierLabel:        brandData?.tierMeta?.label || null,
    equity:           brandData?.equity       || null,
    resaleRetention:  resaleRetention ? round2(resaleRetention * 100) : null,
    retainedValue,
    mismatch:         mismatch       || null,
    alternatives:     alts,
    topSignal: mismatch?.signal
      || (brandData
          ? `${brand || "Item"} is ${brandData.tierMeta?.label || brandData.tier} — ${Math.round((brandData.resaleRetention || 0) * 100)}% resale retention`
          : null),
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
