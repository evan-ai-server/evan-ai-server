// src/alternativeMarketplaceRadar.js
// Hidden marketplace radar: surfaces non-obvious platforms where the item
// is routinely cheaper. Category-specific hidden markets with trust scores,
// fee rates, and "save X% by checking here first" signals.

// ── Alternative marketplace registry ─────────────────────────────────────────
// Each platform: trust (0-1), sellerFee, typicalDiscount vs. eBay, notes
const ALTERNATIVE_MARKETPLACES = {
  // ── Electronics ──
  backmarket: {
    label:           "Back Market",
    url:             "https://www.backmarket.com",
    categories:      ["electronics"],
    trust:           0.88,
    sellerFeeEst:    0.12,
    typicalDiscount: 0.30, // 30% cheaper than eBay on average
    buyerProtection: true,
    note:            "Certified refurb electronics — 30-40% cheaper than eBay with warranty",
    searchUrl:       (q) => `https://www.backmarket.com/en-us/search?q=${encodeURIComponent(q)}`,
  },
  swappa: {
    label:           "Swappa",
    url:             "https://swappa.com",
    categories:      ["electronics"],
    trust:           0.85,
    sellerFeeEst:    0.03,
    typicalDiscount: 0.15,
    buyerProtection: true,
    note:            "Peer-to-peer electronics — no carrier locks allowed, verified listings",
    searchUrl:       (q) => `https://swappa.com/sell/buy/${encodeURIComponent(q.replace(/\s+/g, "-").toLowerCase())}`,
  },
  bstock: {
    label:           "B-Stock",
    url:             "https://bstock.com",
    categories:      ["electronics"],
    trust:           0.80,
    sellerFeeEst:    0.00, // buyer pays, no seller fee
    typicalDiscount: 0.45,
    buyerProtection: false,
    note:            "Liquidation/overstock — pallets and individual units 40-60% below retail",
    searchUrl:       (q) => `https://bstock.com/search?q=${encodeURIComponent(q)}`,
  },
  // ── Luxury fashion ──
  vestiaire: {
    label:           "Vestiaire Collective",
    url:             "https://www.vestiairecollective.com",
    categories:      ["bag", "apparel", "watch", "eyewear"],
    trust:           0.90,
    sellerFeeEst:    0.12,
    typicalDiscount: 0.20,
    buyerProtection: true,
    note:            "Authenticated luxury resale — often 20% cheaper than eBay for high-end items",
    searchUrl:       (q) => `https://www.vestiairecollective.com/search/?q=${encodeURIComponent(q)}`,
  },
  fashionphile: {
    label:           "Fashionphile",
    url:             "https://www.fashionphile.com",
    categories:      ["bag"],
    trust:           0.92,
    sellerFeeEst:    0.20,
    typicalDiscount: 0.15,
    buyerProtection: true,
    note:            "Specialist luxury bag reseller — deep authenticated LV, Chanel, Gucci inventory",
    searchUrl:       (q) => `https://www.fashionphile.com/search#q=${encodeURIComponent(q)}`,
  },
  "the real real": {
    label:           "The RealReal",
    url:             "https://www.therealreal.com",
    categories:      ["bag", "apparel", "watch", "eyewear"],
    trust:           0.87,
    sellerFeeEst:    0.25,
    typicalDiscount: 0.22,
    buyerProtection: true,
    note:            "Consignment luxury — authenticated, often 20-25% below eBay comparables",
    searchUrl:       (q) => `https://www.therealreal.com/products?q=${encodeURIComponent(q)}`,
  },
  // ── Apparel / clothing ──
  thredup: {
    label:           "ThredUp",
    url:             "https://www.thredup.com",
    categories:      ["apparel"],
    trust:           0.78,
    sellerFeeEst:    0.15,
    typicalDiscount: 0.35,
    buyerProtection: true,
    note:            "Used clothing 30-50% below retail — less premium streetwear but great for everyday brands",
    searchUrl:       (q) => `https://www.thredup.com/search?search_text=${encodeURIComponent(q)}`,
  },
  swap: {
    label:           "Swap.com",
    url:             "https://www.swap.com",
    categories:      ["apparel"],
    trust:           0.75,
    sellerFeeEst:    0.20,
    typicalDiscount: 0.40,
    buyerProtection: true,
    note:            "Secondhand clothing — very aggressive pricing, great for basics/casualwear",
    searchUrl:       (q) => `https://www.swap.com/s/search?q=${encodeURIComponent(q)}`,
  },
  // ── Sneakers ──
  goat: {
    label:           "GOAT",
    url:             "https://www.goat.com",
    categories:      ["sneakers"],
    trust:           0.92,
    sellerFeeEst:    0.095,
    typicalDiscount: 0.05,
    buyerProtection: true,
    note:            "Authenticated sneaker marketplace — often slightly cheaper than StockX for used/G-grade",
    searchUrl:       (q) => `https://www.goat.com/search?query=${encodeURIComponent(q)}`,
  },
  // ── Watches ──
  chrono24: {
    label:           "Chrono24",
    url:             "https://www.chrono24.com",
    categories:      ["watch"],
    trust:           0.90,
    sellerFeeEst:    0.065,
    typicalDiscount: 0.12,
    buyerProtection: true,
    note:            "Global watch marketplace — lower fees than eBay for watches, broader international selection",
    searchUrl:       (q) => `https://www.chrono24.com/search/index.htm?query=${encodeURIComponent(q)}`,
  },
  // ── General ──
  offerup: {
    label:           "OfferUp",
    url:             "https://offerup.com",
    categories:      ["electronics", "sneakers", "apparel"],
    trust:           0.72,
    sellerFeeEst:    0.099,
    typicalDiscount: 0.25,
    buyerProtection: false,
    note:            "Local-first marketplace — cash deals, 20-30% below eBay but no buyer protection",
    searchUrl:       (q) => `https://offerup.com/search/?q=${encodeURIComponent(q)}`,
  },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Get recommended alternative marketplaces for a category.
 */
export function getAlternativeMarkets(category = "") {
  const cat = String(category || "").toLowerCase().replace(/s$/, "");

  return Object.entries(ALTERNATIVE_MARKETPLACES)
    .filter(([, m]) => m.categories.some(c => c === cat || c === "all"))
    .map(([key, m]) => ({ key, ...m }))
    .sort((a, b) => b.typicalDiscount - a.typicalDiscount);
}

/**
 * Compute the expected savings on each alternative marketplace
 * given the current market price.
 */
export function computeAlternativeMarketSavings(category = "", currentMarketPrice = null) {
  const markets  = getAlternativeMarkets(category);
  const price    = finiteOrNull(currentMarketPrice);

  return markets.map(m => {
    const expectedPrice    = price ? round2(price * (1 - m.typicalDiscount)) : null;
    const savingsDollars   = price ? round2(price - expectedPrice)            : null;
    const feeSavingsDollars = price ? round2(price * 0.133 - price * m.sellerFeeEst) : null; // vs. eBay fee

    return {
      key:              m.key,
      label:            m.label,
      url:              m.url,
      trust:            m.trust,
      buyerProtection:  m.buyerProtection,
      sellerFeeEst:     round2(m.sellerFeeEst * 100),
      typicalDiscount:  round2(m.typicalDiscount * 100),
      expectedPrice,
      savingsDollars,
      feeSavingsDollars,
      note:             m.note,
      searchUrl:        m.searchUrl ? m.searchUrl("") : null,
    };
  });
}

/**
 * Build search links for a specific item on all relevant alternative platforms.
 */
export function buildAlternativeSearchLinks(identity = {}, category = "") {
  const brand = identity?.brand || "";
  const model = identity?.model || "";
  const query = [brand, model].filter(Boolean).join(" ").trim();
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");

  const relevant = Object.entries(ALTERNATIVE_MARKETPLACES)
    .filter(([, m]) => m.categories.some(c => c === cat))
    .map(([key, m]) => ({
      key,
      label:    m.label,
      searchUrl:m.searchUrl ? m.searchUrl(query) : null,
      trust:    m.trust,
      discount: round2(m.typicalDiscount * 100),
      note:     m.note,
    }))
    .sort((a, b) => b.discount - a.discount);

  return relevant;
}

/**
 * Master alternative marketplace radar payload.
 */
export function buildAlternativeMarketplacePayload({
  identity     = {},
  category     = "",
  scannedPrice = null,
  medianMarket = null,
} = {}) {
  const effectivePrice = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  const savings        = computeAlternativeMarketSavings(category, effectivePrice);
  const searchLinks    = buildAlternativeSearchLinks(identity, category);

  const bestSaving     = savings.sort((a, b) => (b.savingsDollars ?? 0) - (a.savingsDollars ?? 0))[0];

  return {
    markets:      savings,
    searchLinks,
    bestMarket:   bestSaving || null,
    topSignal:    bestSaving?.savingsDollars
      ? `Check ${bestSaving.label} — typically ${bestSaving.typicalDiscount}% cheaper (~$${bestSaving.expectedPrice?.toFixed(2)}, save ~$${bestSaving.savingsDollars?.toFixed(2)})`
      : searchLinks.length
      ? `${searchLinks.length} alternative platform${searchLinks.length !== 1 ? "s" : ""} available for this category`
      : null,
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
