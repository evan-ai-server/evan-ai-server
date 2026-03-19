// src/trendIntelEngine.js
// Hype cycle + trend detection: is this item trending up, peaking, or cooling?
// Produces "buy the dip" / "sell before it fades" / "missed the wave" signals.

// ── Hype cycle registry ───────────────────────────────────────────────────────
// Each entry: { phase, direction, signal, buyAdvice, sellAdvice }
// Phases: emerging | rising | peak | fading | dead | evergreen
const ITEM_HYPE_REGISTRY = {
  // Sneakers
  "jordan 1 retro high": { phase: "evergreen", direction: "stable",  signal: "Blue-chip sneaker — always liquid" },
  "jordan 4 retro":      { phase: "rising",    direction: "up",      signal: "J4 demand consistently rising" },
  "nike dunk low":       { phase: "fading",    direction: "down",    signal: "Dunk market oversaturated — slowing" },
  "adidas yeezy 350":    { phase: "fading",    direction: "down",    signal: "Yeezy market flooded after Kanye split" },
  "new balance 990":     { phase: "rising",    direction: "up",      signal: "990 series gaining premium status" },
  "new balance 2002r":   { phase: "peak",      direction: "stable",  signal: "At peak hype — may soften" },
  "on running cloud":    { phase: "rising",    direction: "up",      signal: "On Running growing fast in performance/lifestyle" },
  "samba adidas":        { phase: "peak",      direction: "down",    signal: "Samba at hype peak — sell window narrowing" },
  "asics gel-lyte":      { phase: "emerging",  direction: "up",      signal: "ASICS retros emerging as next wave" },
  "new balance 1906r":   { phase: "rising",    direction: "up",      signal: "1906R gaining traction with sneakerheads" },
  // Streetwear
  "supreme box logo":    { phase: "evergreen", direction: "stable",  signal: "BOGO always resells — wait for right price" },
  "stone island":        { phase: "rising",    direction: "up",      signal: "SI demand up with menswear revival" },
  "carhartt wip":        { phase: "rising",    direction: "up",      signal: "Utility workwear crossover moment" },
  "palace":              { phase: "fading",    direction: "down",    signal: "Palace hype cooling from 2021 peak" },
  "stussy":              { phase: "evergreen", direction: "stable",  signal: "Core Stussy always has a buyer" },
  // Electronics
  "apple watch ultra":   { phase: "peak",      direction: "stable",  signal: "Ultra at saturation — used market softening" },
  "airpods pro 2":       { phase: "fading",    direction: "down",    signal: "AirPods Pro 2 deprecating with AirPods 4" },
  "iphone 15 pro":       { phase: "fading",    direction: "down",    signal: "iPhone 15 dropping fast now iPhone 16 is out" },
  "iphone 16 pro":       { phase: "rising",    direction: "up",      signal: "iPhone 16 Pro still near retail premium" },
  "meta quest 3":        { phase: "rising",    direction: "up",      signal: "MQ3 demand up as VR market grows" },
  // Bags
  "louis vuitton onthego": { phase: "evergreen", direction: "stable", signal: "LV OnTheGo consistently holds value" },
  "bottega veneta pouch":  { phase: "fading",    direction: "down",   signal: "Bottega Pouch past peak, softening" },
  "prada re-edition":      { phase: "fading",    direction: "down",   signal: "Prada Re-Edition past its 2021 peak" },
  // Watches
  "rolex submariner":    { phase: "evergreen", direction: "up",      signal: "Sub is the benchmark — always appreciates" },
  "rolex daytona":       { phase: "evergreen", direction: "up",      signal: "Daytona appreciation is near-certain" },
  "ap royal oak":        { phase: "peak",      direction: "stable",  signal: "ROO grey-market premium shrinking" },
  "patek nautilus":      { phase: "evergreen", direction: "up",      signal: "Nautilus blue-chip — never not in demand" },
  "seiko skx":           { phase: "rising",    direction: "up",      signal: "SKX discontinued — scarcity driving up value" },
};

// Category-level trend overrides (used when no item match found)
const CATEGORY_TREND = {
  sneakers:     { phase: "fading",    direction: "down",    note: "General sneaker market cooling from 2021-22 highs" },
  streetwear:   { phase: "fading",    direction: "down",    note: "Hypebeast market consolidating" },
  electronics:  { phase: "stable",    direction: "stable",  note: "Consumer electronics follow release cycles" },
  watch:        { phase: "fading",    direction: "down",    note: "Watch grey-market premiums compressing" },
  bag:          { phase: "stable",    direction: "stable",  note: "Luxury bags holding value better than most categories" },
  apparel:      { phase: "rising",    direction: "up",      note: "Vintage and workwear crossover trending" },
  collectibles: { phase: "rising",    direction: "up",      note: "Collectibles and trading cards still growing" },
};

// Hype-phase action matrix
const PHASE_ACTIONS = {
  emerging:  { buyAdvice: "Buy early — emerging trend with upside",            sellAdvice: "Hold — best gains ahead" },
  rising:    { buyAdvice: "Strong buy window — trend still has momentum",      sellAdvice: "Hold or sell near peak" },
  peak:      { buyAdvice: "Caution — at peak, limited upside",                 sellAdvice: "Sell now before the fade" },
  fading:    { buyAdvice: "Buy the dip only if blue-chip brand",               sellAdvice: "Sell soon — window closing" },
  dead:      { buyAdvice: "Avoid unless sentimental value",                    sellAdvice: "Clear inventory ASAP" },
  evergreen: { buyAdvice: "Safe buy — always liquid at fair price",            sellAdvice: "Hold or sell when you need cash" },
  stable:    { buyAdvice: "Buy at market or below",                            sellAdvice: "List at market — consistent demand" },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Look up hype cycle data for an item by identity.
 */
export function resolveHypeCycle(identity = {}, category = "") {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const key   = `${brand} ${model}`.trim();

  // Try exact or partial item-level match
  let entry = null;
  for (const [registryKey, val] of Object.entries(ITEM_HYPE_REGISTRY)) {
    if (key.includes(registryKey) || registryKey.split(" ").every(t => t.length >= 3 && key.includes(t))) {
      entry = val;
      break;
    }
  }

  // Fall back to category-level trend
  if (!entry) {
    const cat = String(category || "").toLowerCase().replace(/s$/, "");
    entry = CATEGORY_TREND[cat] || null;
  }

  return entry || null;
}

/**
 * Build the full trend intelligence payload.
 */
export function buildTrendIntelPayload({
  identity     = {},
  category     = "",
  scannedPrice = null,
  uiItems      = [],
  consensus    = null,
} = {}) {
  const hype = resolveHypeCycle(identity, category);

  if (!hype) {
    return {
      available:   false,
      phase:       null,
      direction:   null,
      signal:      null,
      buyAdvice:   null,
      sellAdvice:  null,
      priceOutlook: null,
    };
  }

  const actions      = PHASE_ACTIONS[hype.phase] || PHASE_ACTIONS["stable"];
  const medianMarket = finiteOrNull(consensus?.medianPrice) || computeMedian(uiItems);

  // Price outlook: directional estimate based on phase
  const priceOutlook = (() => {
    if (hype.direction === "up")     return { direction: "up",    estChangePct: hype.phase === "emerging" ? "+15-40%" : "+5-15%" };
    if (hype.direction === "down")   return { direction: "down",  estChangePct: hype.phase === "dead"     ? "-30-50%" : "-5-20%" };
    return { direction: "stable", estChangePct: "0-5%" };
  })();

  // "Buy the dip" signal: fading but blue-chip = opportunity
  const bluechipBrands = new Set(["jordan", "rolex", "louis vuitton", "supreme", "stone island", "patek", "ap"]);
  const brand          = String(identity?.brand || "").toLowerCase();
  const isBluechip     = [...bluechipBrands].some(b => brand.includes(b));
  const buyTheDip      = hype.phase === "fading" && isBluechip;

  return {
    available:   true,
    phase:       hype.phase,
    direction:   hype.direction,
    signal:      hype.signal || hype.note || null,
    buyAdvice:   buyTheDip
      ? `Blue-chip in a dip — ${actions.buyAdvice} (buy the dip opportunity)`
      : actions.buyAdvice,
    sellAdvice:  actions.sellAdvice,
    priceOutlook,
    isBluechip,
    buyTheDip,
    medianMarket: medianMarket ? round2(medianMarket) : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function computeMedian(uiItems) {
  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return prices.length ? prices[Math.floor(prices.length / 2)] : null;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
