// src/bundleIntelligence.js
// Bundle & accessory intelligence: what to pair with this item to increase sell price.
// Detects bundle opportunities, estimates bundle premium, and generates bundle titles.

// ── Bundle accessory registry ─────────────────────────────────────────────────
// Maps item category/brand/model → known accessories that increase bundle value
const BUNDLE_REGISTRY = {
  // ── Sneakers ──
  sneakers: {
    default: [
      { item: "Original box",           addedValueEst: [20, 50],  required: false, signal: "Box adds 15-30% to resale value" },
      { item: "Extra laces",            addedValueEst: [5, 15],   required: false, signal: "OG laces command premium on deadstock" },
      { item: "Dust bags",              addedValueEst: [5, 10],   required: false },
      { item: "Insoles (original)",     addedValueEst: [10, 20],  required: false },
      { item: "Shoe trees",             addedValueEst: [5, 15],   required: false },
    ],
    jordan: [
      { item: "Hang tag",               addedValueEst: [10, 30],  required: false, signal: "J-tag intact = OG pair premium" },
      { item: "Receipt or proof of purchase", addedValueEst: [20, 60], required: false },
    ],
    rolex: [], // handled under watch
  },
  // ── Watches ──
  watch: {
    default: [
      { item: "Box",                    addedValueEst: [50, 200],  required: false, signal: "Watch box adds 10-20% to value" },
      { item: "Papers / warranty card", addedValueEst: [200, 1000],required: false, signal: "Papers can double resale value on luxury watches" },
      { item: "Original bracelet",      addedValueEst: [50, 500],  required: false, signal: "Original bracelet preferred by collectors" },
      { item: "Extra links",            addedValueEst: [20, 100],  required: false },
      { item: "Hang tags",              addedValueEst: [10, 30],   required: false },
      { item: "Service papers",         addedValueEst: [50, 200],  required: false, signal: "Service history documents add buyer confidence" },
    ],
    rolex: [
      { item: "Green Rolex box + papers", addedValueEst: [500, 3000], required: false, signal: "Full set adds 20-40% to Rolex value" },
      { item: "Rolex swing tag",          addedValueEst: [50, 200],   required: false },
    ],
  },
  // ── Bags ──
  bag: {
    default: [
      { item: "Dust bag",               addedValueEst: [30, 100],  required: false, signal: "Dust bag expected by luxury buyers" },
      { item: "Authentication card",    addedValueEst: [50, 200],  required: false, signal: "Auth card increases buyer confidence significantly" },
      { item: "Original receipt",       addedValueEst: [100, 400], required: false },
      { item: "Lock and key",           addedValueEst: [20, 80],   required: false, signal: "Complete set — lock+key adds value" },
      { item: "Strap(s)",               addedValueEst: [30, 150],  required: false, signal: "Extra strap(s) widen buyer appeal" },
      { item: "Shopping bag (original)",addedValueEst: [10, 30],   required: false },
    ],
  },
  // ── Electronics ──
  electronics: {
    default: [
      { item: "Original box",           addedValueEst: [10, 30],   required: false },
      { item: "Charger (original)",     addedValueEst: [10, 30],   required: false, signal: "Missing charger = price drop on electronics" },
      { item: "Cable (original)",       addedValueEst: [5, 15],    required: false },
      { item: "Earpods/EarBuds (original)", addedValueEst: [10, 25], required: false },
      { item: "AppleCare documentation",addedValueEst: [20, 60],   required: false, signal: "Remaining AppleCare = buyer premium" },
    ],
    apple: [
      { item: "Original sealed box",    addedValueEst: [20, 50],   required: false, signal: "Sealed or near-sealed condition = premium pricing" },
      { item: "Apple stickers",         addedValueEst: [0, 5],     required: false },
    ],
  },
  // ── Apparel ──
  apparel: {
    default: [
      { item: "Original tags (NWT)",    addedValueEst: [15, 40],   required: false, signal: "NWT adds 20-40% vs. worn" },
      { item: "Hanger",                 addedValueEst: [0, 5],     required: false },
      { item: "Original packaging",     addedValueEst: [10, 25],   required: false },
    ],
    supreme: [
      { item: "Supreme bag",            addedValueEst: [10, 30],   required: false, signal: "Supreme paper bag = legit signal" },
      { item: "Receipt",                addedValueEst: [20, 60],   required: false },
    ],
  },
  // ── Eyewear ──
  eyewear: {
    default: [
      { item: "Hard case (original)",   addedValueEst: [10, 25],   required: false, signal: "Case = condition assurance for buyer" },
      { item: "Cleaning cloth",         addedValueEst: [2, 8],     required: false },
      { item: "Certificate of authenticity", addedValueEst: [10, 30], required: false },
      { item: "Lens cloth + solution",  addedValueEst: [5, 10],    required: false },
    ],
  },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve bundle accessories for a scanned item.
 */
export function resolveBundleAccessories(identity = {}, category = "") {
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");
  const brand = String(identity?.brand || "").toLowerCase();

  const pool = BUNDLE_REGISTRY[cat];
  if (!pool) return [];

  // Merge default + brand-specific accessories
  const accessories = [...(pool.default || [])];
  for (const [brandKey, items] of Object.entries(pool)) {
    if (brandKey !== "default" && brand.includes(brandKey)) {
      accessories.push(...items);
    }
  }

  return accessories;
}

/**
 * Compute the total potential bundle premium.
 */
export function computeBundlePremium(accessories = [], basePrice = null) {
  const base = finiteOrNull(basePrice);

  const totalMin = accessories.reduce((s, a) => s + (a.addedValueEst[0] || 0), 0);
  const totalMax = accessories.reduce((s, a) => s + (a.addedValueEst[1] || 0), 0);

  const pctMin = base ? round2((totalMin / base) * 100) : null;
  const pctMax = base ? round2((totalMax / base) * 100) : null;

  return {
    totalAddedMin: totalMin,
    totalAddedMax: totalMax,
    pctOfBaseMin:  pctMin,
    pctOfBaseMax:  pctMax,
    withBundleMin: base ? round2(base + totalMin) : null,
    withBundleMax: base ? round2(base + totalMax) : null,
  };
}

/**
 * Generate a bundle listing title from base item + key accessories.
 */
export function buildBundleTitle(identity = {}, category = "", accessories = []) {
  const brand = toTitleCase(identity?.brand || "");
  const model = toTitleCase(identity?.model || "");

  const topAccessories = accessories
    .filter(a => (a.addedValueEst[1] || 0) > 20)
    .slice(0, 3)
    .map(a => a.item);

  const suffix = topAccessories.length
    ? `w/ ${topAccessories.join(" + ")}`
    : "Full Set";

  return `${brand} ${model} ${suffix}`.replace(/\s{2,}/g, " ").trim().slice(0, 80);
}

/**
 * Build the full bundle intelligence payload.
 */
export function buildBundleIntelPayload({
  identity     = {},
  category     = "",
  scannedPrice = null,
  medianMarket = null,
} = {}) {
  const accessories = resolveBundleAccessories(identity, category);
  if (!accessories.length) {
    return { available: false, accessories: [], bundlePremium: null, bundleTitle: null, signal: null };
  }

  const basePrice    = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  const premium      = computeBundlePremium(accessories, basePrice);
  const bundleTitle  = buildBundleTitle(identity, category, accessories);

  // Top-signal accessories (highest value adds)
  const topAdds = [...accessories]
    .sort((a, b) => (b.addedValueEst[1] || 0) - (a.addedValueEst[1] || 0))
    .slice(0, 3);

  const keySignals = topAdds
    .filter(a => a.signal)
    .map(a => a.signal);

  return {
    available:      true,
    accessories,
    topAccessories: topAdds,
    bundlePremium:  premium,
    bundleTitle,
    keySignals,
    signal: premium.withBundleMax && basePrice
      ? `Bundle with ${topAdds[0]?.item || "accessories"} to list at $${premium.withBundleMax.toFixed(2)} (+$${premium.totalAddedMax} vs. solo)`
      : `Include ${topAdds[0]?.item || "original accessories"} to maximize resale value`,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function toTitleCase(str) {
  return String(str || "").replace(/\b\w/g, c => c.toUpperCase());
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
