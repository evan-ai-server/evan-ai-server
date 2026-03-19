// src/queryArbitrageEngine.js
// Naming gap arbitrage: the same item is listed under different names on different
// platforms, creating exploitable price gaps. Generates the optimal search query
// per platform and detects mislabeling/misspelling arbitrage opportunities.

// ── Platform-specific naming conventions ─────────────────────────────────────
// Maps canonical item keys to platform-optimized search strings
const PLATFORM_QUERY_TEMPLATES = {
  // ── Jordan ──
  "jordan 1 chicago": {
    stockx:   "Jordan 1 Retro High OG Chicago",
    goat:     "Air Jordan 1 Retro High OG 'Chicago'",
    ebay:     "Air Jordan 1 Chicago 555088-101",
    grailed:  "jordan 1 chicago og",
    facebook: "jordan 1 chicago size",
    mercari:  "air jordan 1 chicago retro",
    poshmark: "jordan 1 chicago red white",
    depop:    "jordan 1 chicago colourway",
  },
  "jordan 1 bred": {
    stockx:   "Jordan 1 Retro High OG Bred",
    goat:     "Air Jordan 1 Retro High OG 'Bred'",
    ebay:     "Air Jordan 1 Bred 555088-610",
    grailed:  "jordan 1 bred og",
    facebook: "jordan 1 bred black red",
    mercari:  "air jordan 1 bred toe",
  },
  "jordan 4 bred": {
    stockx:   "Jordan 4 Retro Bred",
    goat:     "Air Jordan 4 Retro 'Bred'",
    ebay:     "Air Jordan 4 Bred 308497-060",
    grailed:  "jordan 4 bred",
  },
  // ── Nike Dunk ──
  "nike dunk low panda": {
    stockx:   "Nike Dunk Low Retro White Black Panda",
    goat:     "Nike Dunk Low 'Panda'",
    ebay:     "Nike Dunk Low White Black DD1391-100",
    grailed:  "dunk low panda white black",
    facebook: "nike dunk low white black panda",
    mercari:  "nike dunk low panda white black",
    poshmark: "nike dunk low white black",
    stockx2:  "Nike Dunk Low DD1391-100",
  },
  // ── Yeezy ──
  "yeezy 350 zebra": {
    stockx:   "adidas Yeezy Boost 350 V2 Zebra",
    goat:     "Yeezy Boost 350 V2 'Zebra'",
    ebay:     "Adidas Yeezy 350 V2 Zebra CP9654",
    grailed:  "yeezy 350 v2 zebra",
  },
  // ── New Balance ──
  "new balance 990v3": {
    ebay:     "New Balance 990v3 M990",
    grailed:  "new balance 990 v3",
    poshmark: "new balance 990 grey",
    mercari:  "new balance 990v3 made in usa",
  },
  // ── Apple ──
  "iphone 15 pro": {
    ebay:     "Apple iPhone 15 Pro 128GB Unlocked",
    swappa:   "iPhone 15 Pro",
    facebook: "iphone 15 pro unlocked",
    mercari:  "apple iphone 15 pro factory unlocked",
    backmarket:"iPhone 15 Pro",
  },
  "airpods pro 2": {
    ebay:     "Apple AirPods Pro 2nd Generation MQD83LL/A",
    walmart:  "AirPods Pro 2nd Generation",
    amazon:   "Apple AirPods Pro (2nd generation)",
    mercari:  "airpods pro 2nd gen usb-c",
  },
  // ── Rolex ──
  "rolex submariner": {
    chrono24: "Rolex Submariner Date 126610LN",
    ebay:     "Rolex Submariner 126610 Ceramic Bezel",
    watchuseek:"Rolex Sub Date ceramic",
    grailed:  "rolex submariner 126610",
  },
  // ── Bags ──
  "louis vuitton neverfull mm": {
    ebay:           "Louis Vuitton Neverfull MM Monogram",
    poshmark:       "Louis Vuitton Neverfull MM",
    "the real real":"LV Neverfull MM",
    fashionphile:   "Neverfull MM",
  },
  // ── Streetwear ──
  "supreme box logo hoodie": {
    grailed:  "Supreme Box Logo Hooded Sweatshirt BOGO",
    ebay:     "Supreme BOGO Box Logo Hoodie FW",
    depop:    "supreme box logo hoodie bogo",
    poshmark: "supreme hoodie box logo",
  },
};

// ── Misspelling / mislabeling arbitrage registry ──────────────────────────────
// Items commonly mislabeled on cheaper platforms creating search gaps
const MISLABELING_PATTERNS = [
  { correct: "Air Jordan 1",       misspellings: ["jordan ones", "jordans 1", "jordan retros 1", "jordan highs"] },
  { correct: "Nike Dunk Low",      misspellings: ["nike dunks", "dunk lows", "dunks low", "dunks"] },
  { correct: "New Balance 990v3",  misspellings: ["new balance 990", "nb 990", "new balance nineties"] },
  { correct: "Adidas Yeezy 350 V2",misspellings: ["yeezys", "yeezy boost", "350 v2", "kanye shoes"] },
  { correct: "Louis Vuitton",      misspellings: ["lv bag", "l.v.", "louie vuitton", "louis v"] },
  { correct: "Rolex Submariner",   misspellings: ["rolex sub", "submariner watch", "rolex diver"] },
  { correct: "Supreme Box Logo",   misspellings: ["supreme bogo", "supreme boxlogo", "supreme hoodie box"] },
];

// Platform base search URLs for generating clickable links
const PLATFORM_SEARCH_URLS = {
  stockx:    (q) => `https://stockx.com/search?s=${encodeURIComponent(q)}`,
  goat:      (q) => `https://www.goat.com/search?query=${encodeURIComponent(q)}`,
  ebay:      (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  grailed:   (q) => `https://www.grailed.com/shop/search?query=${encodeURIComponent(q)}`,
  poshmark:  (q) => `https://poshmark.com/search?query=${encodeURIComponent(q)}`,
  depop:     (q) => `https://www.depop.com/search/?q=${encodeURIComponent(q)}`,
  mercari:   (q) => `https://www.mercari.com/search/?keyword=${encodeURIComponent(q)}`,
  facebook:  (q) => `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(q)}`,
  chrono24:  (q) => `https://www.chrono24.com/search/index.htm?query=${encodeURIComponent(q)}`,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve the canonical item key from an identity.
 */
function resolveCanonicalKey(identity = {}) {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const color = String(identity?.color || identity?.colorway || "").toLowerCase();
  const key   = `${brand} ${model} ${color}`.trim().toLowerCase();

  for (const templateKey of Object.keys(PLATFORM_QUERY_TEMPLATES)) {
    if (key.includes(templateKey) || templateKey.split(" ").every(t => t.length >= 3 && key.includes(t))) {
      return templateKey;
    }
  }
  return null;
}

/**
 * Generate platform-optimized search queries for an item.
 */
export function generatePlatformQueries(identity = {}, category = "") {
  const canonicalKey = resolveCanonicalKey(identity);
  const templates    = canonicalKey ? PLATFORM_QUERY_TEMPLATES[canonicalKey] : null;

  if (!templates) {
    // Fallback: build a generic optimized query
    const brand = identity?.brand || "";
    const model = identity?.model || "";
    const color = identity?.color || identity?.colorway || "";
    const fallback = [brand, model, color].filter(Boolean).join(" ").trim();

    return {
      canonicalKey:  null,
      queries:       Object.fromEntries(
        Object.keys(PLATFORM_SEARCH_URLS).map(p => [p, { query: fallback, url: PLATFORM_SEARCH_URLS[p]?.(fallback) || null, isOptimized: false }])
      ),
      hasOptimizedQueries: false,
    };
  }

  const queries = {};
  for (const [platform, query] of Object.entries(templates)) {
    const cleanPlatform = platform.replace(/\d+$/, ""); // remove trailing numbers (stockx2 → stockx)
    if (!queries[cleanPlatform]) {
      queries[cleanPlatform] = {
        query,
        url:         PLATFORM_SEARCH_URLS[cleanPlatform]?.(query) || null,
        isOptimized: true,
      };
    }
  }

  return {
    canonicalKey,
    queries,
    hasOptimizedQueries: true,
  };
}

/**
 * Detect mislabeling arbitrage: find if this item is commonly listed under
 * cheaper/misspelled names that create price gaps.
 */
export function detectMislabelingArbitrage(identity = {}) {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const key   = `${brand} ${model}`.trim();

  const matches = MISLABELING_PATTERNS.filter(p =>
    key.includes(p.correct.toLowerCase()) ||
    p.correct.toLowerCase().split(" ").every(t => t.length >= 3 && key.includes(t))
  );

  if (!matches.length) return null;

  const entry = matches[0];

  return {
    detected:        true,
    correctName:     entry.correct,
    misspelledTerms: entry.misspellings,
    arbitrageTip:    `Search "${entry.misspellings[0]}" on eBay/Facebook Marketplace — mislabeled listings often go for less than properly titled ones`,
    searchQueries:   entry.misspellings.map(term => ({
      term,
      ebayUrl:    PLATFORM_SEARCH_URLS.ebay(term),
      facebookUrl:PLATFORM_SEARCH_URLS.facebook(term),
      mercariUrl: PLATFORM_SEARCH_URLS.mercari(term),
    })),
  };
}

/**
 * Detect price gap across platforms using platform query optimization.
 * Identifies where naming conventions cause price disparities.
 */
export function detectNamingGapArbitrage(identity = {}, uiItems = []) {
  // Group uiItems by platform and compute median per platform
  const byPlatform = {};
  for (const item of uiItems) {
    const src   = String(item?.source || "unknown").toLowerCase();
    const price = Number(item?.totalPrice ?? item?.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!byPlatform[src]) byPlatform[src] = [];
    byPlatform[src].push(price);
  }

  const medians = {};
  for (const [src, prices] of Object.entries(byPlatform)) {
    const sorted = [...prices].sort((a, b) => a - b);
    medians[src] = round2(sorted[Math.floor(sorted.length / 2)]);
  }

  const entries = Object.entries(medians).sort(([, a], [, b]) => a - b);
  if (entries.length < 2) return null;

  const [cheapestPlatform, cheapestPrice]  = entries[0];
  const [expensivePlatform, expensivePrice] = entries[entries.length - 1];

  const gapPct = round2(((expensivePrice - cheapestPrice) / cheapestPrice) * 100);
  if (gapPct < 12) return null;

  const platformQueries = generatePlatformQueries(identity);
  const cheapQuery      = platformQueries.queries[cheapestPlatform] || null;

  return {
    detected:          true,
    cheapestPlatform,
    cheapestPrice,
    expensivePlatform,
    expensivePrice,
    gapPct,
    gapDollars:        round2(expensivePrice - cheapestPrice),
    optimizedQuery:    cheapQuery?.query || null,
    searchUrl:         cheapQuery?.url   || null,
    signal:            `Same item is ${gapPct.toFixed(0)}% cheaper on ${cheapestPlatform} ($${cheapestPrice.toFixed(2)}) vs ${expensivePlatform} ($${expensivePrice.toFixed(2)}) — likely a naming/listing gap`,
  };
}

/**
 * Master query arbitrage payload.
 */
export function buildQueryArbitragePayload({
  identity = {},
  category = "",
  uiItems  = [],
} = {}) {
  const platformQueries      = generatePlatformQueries(identity, category);
  const mislabelingArbitrage = detectMislabelingArbitrage(identity);
  const namingGapArbitrage   = detectNamingGapArbitrage(identity, uiItems);

  const hasArbitrage = !!(mislabelingArbitrage?.detected || namingGapArbitrage?.detected);

  return {
    hasArbitrage,
    platformQueries,
    mislabelingArbitrage: mislabelingArbitrage || null,
    namingGapArbitrage:   namingGapArbitrage   || null,
    topSignal: namingGapArbitrage?.signal || mislabelingArbitrage?.arbitrageTip || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) {
  return Math.round(v * 100) / 100;
}
