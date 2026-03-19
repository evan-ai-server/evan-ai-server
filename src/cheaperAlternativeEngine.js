// src/cheaperAlternativeEngine.js
// "Don't buy this, buy this instead" — premium vs budget intelligence

// ── Budget alternative registry ───────────────────────────────────────────────
// key: brand+model substring (lowercase), value: alternative spec
const BUDGET_ALTERNATIVES = {
  // ── Sneakers ──
  "air jordan 1": {
    budgetName:   "Puma Court",
    budgetQuery:  "puma court low sneaker",
    savingsEst:   [80, 120],
    reason:       "Same court silhouette at 40% of the price",
    tier:         "budget",
  },
  "nike air force 1": {
    budgetName:   "Vans Old Skool",
    budgetQuery:  "vans old skool white low top",
    savingsEst:   [40, 70],
    reason:       "Clean low-top white silhouette at a fraction of the price",
    tier:         "budget",
  },
  "adidas yeezy": {
    budgetName:   "New Balance 574",
    budgetQuery:  "new balance 574 sneaker",
    savingsEst:   [150, 400],
    reason:       "Chunky sole silhouette under $80",
    tier:         "budget",
  },
  "on running cloudmonster": {
    budgetName:   "HOKA Clifton",
    budgetQuery:  "hoka clifton running shoe",
    savingsEst:   [40, 80],
    reason:       "Max-cushion runner at similar or lower price",
    tier:         "mid",
  },
  "on running cloudstratus": {
    budgetName:   "ASICS Gel-Nimbus",
    budgetQuery:  "asics gel-nimbus running shoe",
    savingsEst:   [30, 80],
    reason:       "Comparable cushioned runner at a better price",
    tier:         "mid",
  },
  "new balance 2002r": {
    budgetName:   "ASICS Gel-Lyte III",
    budgetQuery:  "asics gel-lyte iii retro sneaker",
    savingsEst:   [60, 120],
    reason:       "Retro runner silhouette at a lower premium",
    tier:         "mid",
  },
  // ── Headphones / Audio ──
  "airpods pro": {
    budgetName:   "Soundcore Liberty 4",
    budgetQuery:  "anker soundcore liberty 4 earbuds",
    savingsEst:   [130, 180],
    reason:       "ANC earbuds with comparable specs at 40% of Apple price",
    tier:         "budget",
  },
  "sony wh-1000xm": {
    budgetName:   "Anker Soundcore Q45",
    budgetQuery:  "anker soundcore q45 headphones",
    savingsEst:   [200, 320],
    reason:       "ANC over-ear headphones under $60",
    tier:         "budget",
  },
  "bose quietcomfort": {
    budgetName:   "Jabra Evolve2 55",
    budgetQuery:  "jabra evolve2 55 headphones",
    savingsEst:   [50, 130],
    reason:       "Work-grade ANC at better value-per-dollar",
    tier:         "mid",
  },
  "beats studio pro": {
    budgetName:   "JBL Tune 770NC",
    budgetQuery:  "jbl tune 770nc wireless headphones",
    savingsEst:   [100, 180],
    reason:       "ANC over-ear headphones for under $80",
    tier:         "budget",
  },
  // ── Outerwear ──
  "canada goose parka": {
    budgetName:   "Columbia Omni-Heat",
    budgetQuery:  "columbia omni-heat winter jacket",
    savingsEst:   [600, 1000],
    reason:       "Comparable warmth rating for under $200",
    tier:         "budget",
  },
  "moncler jacket": {
    budgetName:   "North Face Nuptse",
    budgetQuery:  "north face nuptse puffer jacket",
    savingsEst:   [800, 1500],
    reason:       "Iconic puffer at 90% less with equivalent down insulation",
    tier:         "mid",
  },
  "arc'teryx shell": {
    budgetName:   "Patagonia Torrentshell",
    budgetQuery:  "patagonia torrentshell 3l rain jacket",
    savingsEst:   [250, 400],
    reason:       "H2No waterproof shell at half the price",
    tier:         "mid",
  },
  "arc'teryx alpha": {
    budgetName:   "Outdoor Research Helium",
    budgetQuery:  "outdoor research helium rain jacket",
    savingsEst:   [300, 500],
    reason:       "GORE-TEX performance at under $200",
    tier:         "mid",
  },
  "stone island jacket": {
    budgetName:   "Carhartt WIP Active Jacket",
    budgetQuery:  "carhartt wip active jacket",
    savingsEst:   [400, 900],
    reason:       "Utility outerwear with street credibility, fraction of the price",
    tier:         "mid",
  },
  // ── Bags ──
  "louis vuitton neverfull": {
    budgetName:   "Cuyana Classic Tote",
    budgetQuery:  "cuyana classic structured leather tote",
    savingsEst:   [1500, 2500],
    reason:       "Clean structured tote for $150",
    tier:         "mid",
  },
  "gucci dionysus": {
    budgetName:   "Kate Spade Knott Bag",
    budgetQuery:  "kate spade knott structured bag",
    savingsEst:   [1000, 2000],
    reason:       "Structured turnlock bag at 90% less",
    tier:         "mid",
  },
  "coach tabby": {
    budgetName:   "Fossil Remi",
    budgetQuery:  "fossil remi shoulder bag",
    savingsEst:   [200, 350],
    reason:       "Structured leather bag under $100",
    tier:         "budget",
  },
  // ── Eyewear ──
  "ray-ban wayfarer": {
    budgetName:   "Knockaround Fort Knocks",
    budgetQuery:  "knockaround fort knocks sunglasses",
    savingsEst:   [100, 180],
    reason:       "Same wayfarer shape for $30",
    tier:         "budget",
  },
  "ray-ban clubmaster": {
    budgetName:   "Goodr Clubmaster",
    budgetQuery:  "goodr clubmaster style sunglasses",
    savingsEst:   [120, 180],
    reason:       "Browline style for $25",
    tier:         "budget",
  },
  "oakley radar": {
    budgetName:   "Goodr OG",
    budgetQuery:  "goodr og sport sunglasses",
    savingsEst:   [140, 220],
    reason:       "Sport wrap sunglass for under $35",
    tier:         "budget",
  },
  "oakley flak": {
    budgetName:   "Knockaround Sprinter",
    budgetQuery:  "knockaround sprinter sport sunglasses",
    savingsEst:   [140, 200],
    reason:       "Shield sport lens for $30",
    tier:         "budget",
  },
  // ── Watches ──
  "rolex submariner": {
    budgetName:   "Seiko SKX Series",
    budgetQuery:  "seiko skx dive watch",
    savingsEst:   [8000, 15000],
    reason:       "Iconic dive watch silhouette with automatic movement for under $500",
    tier:         "budget",
  },
  "omega seamaster": {
    budgetName:   "Seiko Prospex",
    budgetQuery:  "seiko prospex srpe dive watch",
    savingsEst:   [3000, 5000],
    reason:       "Comparable dive watch story for under $600",
    tier:         "mid",
  },
  "apple watch ultra": {
    budgetName:   "Garmin Instinct 2",
    budgetQuery:  "garmin instinct 2 solar watch",
    savingsEst:   [100, 250],
    reason:       "Rugged GPS smartwatch with dramatically better battery life",
    tier:         "mid",
  },
  "tag heuer carrera": {
    budgetName:   "Hamilton Jazzmaster",
    budgetQuery:  "hamilton jazzmaster automatic watch",
    savingsEst:   [2000, 4000],
    reason:       "Swiss automatic chronograph with equal heritage at half the price",
    tier:         "mid",
  },
};

// ── Brand tier registry (for value score) ────────────────────────────────────
const BRAND_TIER_MAP = {
  luxury:  ["rolex", "patek", "ap", "chanel", "hermes", "louis vuitton", "gucci", "prada",
             "dior", "moncler", "canada goose", "off-white", "fear of god", "supreme",
             "balenciaga", "bottega"],
  premium: ["jordan", "nike", "adidas", "apple", "sony", "bose", "beats", "ray-ban",
             "oakley", "north face", "patagonia", "arc'teryx", "omega", "tag heuer",
             "samsung", "breitling", "maui jim", "stone island"],
  mid:     ["new balance", "asics", "saucony", "anker", "jbl", "jabra", "carhartt",
             "seiko", "citizen", "hamilton", "hoka", "on running", "coach",
             "kate spade", "michael kors", "fossil", "herschel", "goodr", "knockaround",
             "patagonia"],
  budget:  ["skechers", "skullcandy", "soundcore", "fila", "champion", "casio", "timex",
             "shein", "amazon basics", "knockaround", "sungait"],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve the best budget alternative for a scanned item identity.
 */
export function findBudgetAlternative(identity = {}, category = "", scannedPrice = null) {
  const brand   = String(identity?.brand || "").toLowerCase();
  const model   = String(identity?.model || "").toLowerCase();
  const fullKey = `${brand} ${model}`.trim();

  let entry = BUDGET_ALTERNATIVES[fullKey];
  if (!entry) {
    // Partial match: fullKey contains a known key, or brand alone matches
    for (const [key, val] of Object.entries(BUDGET_ALTERNATIVES)) {
      if (fullKey.includes(key) || key.split(" ").every(t => t.length >= 3 && fullKey.includes(t))) {
        entry = val;
        break;
      }
    }
  }
  if (!entry) return null;

  const scanned = finiteOrNull(scannedPrice);
  const [estMin, estMax] = entry.savingsEst;

  return {
    found:            true,
    budgetName:       entry.budgetName,
    budgetQuery:      entry.budgetQuery,
    tier:             entry.tier,
    reason:           entry.reason,
    estimatedSavings: { min: estMin, max: estMax },
    callToAction:     `Don't pay for the label. Try "${entry.budgetName}" instead — save $${estMin}–$${estMax}.`,
    scannedPrice:     scanned,
  };
}

/**
 * Score where this item sits on the premium-vs-value curve.
 */
export function scorePremiumVsValue(identity = {}, scannedPrice = null, uiItems = []) {
  const brand     = String(identity?.brand || "").toLowerCase();
  const brandTier = resolveBrandTier(brand);
  const scanned   = finiteOrNull(scannedPrice);

  const prices    = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean);
  const avgMarket = prices.length
    ? round2(prices.reduce((s, v) => s + v, 0) / prices.length)
    : null;

  const vsMarket = scanned !== null && avgMarket !== null
    ? (scanned < avgMarket * 0.85 ? "below_market"
      : scanned > avgMarket * 1.15 ? "above_market"
      : "at_market")
    : null;

  // Value score: luxury+below = high value (good buy), budget+above = value trap
  const valueScore = (() => {
    if (brandTier === "luxury"  && vsMarket === "below_market") return 0.92;
    if (brandTier === "luxury"  && vsMarket === "at_market")    return 0.70;
    if (brandTier === "premium" && vsMarket === "below_market") return 0.82;
    if (brandTier === "premium" && vsMarket === "at_market")    return 0.60;
    if (brandTier === "mid"     && vsMarket === "below_market") return 0.75;
    if (brandTier === "mid"     && vsMarket === "at_market")    return 0.65;
    if (brandTier === "budget"  && vsMarket === "below_market") return 0.55;
    if (brandTier === "budget"  && vsMarket === "above_market") return 0.10;
    if (vsMarket === "above_market")                            return 0.25;
    return 0.50;
  })();

  const verdict = valueScore >= 0.80 ? "great_value"
                : valueScore >= 0.60 ? "fair_value"
                : valueScore >= 0.35 ? "overpriced"
                : "price_trap";

  return {
    brandTier,
    vsMarket,
    valueScore:      round2(valueScore),
    avgMarketPrice:  avgMarket,
    scannedPrice:    scanned,
    verdict,
    verdictLabel: {
      great_value: "Great value for this brand",
      fair_value:  "Fair price",
      overpriced:  "Overpriced",
      price_trap:  "Price trap — avoid",
    }[verdict] || "Unknown",
  };
}

/**
 * Build the full "don't buy this, buy this instead" payload.
 */
export function buildDontBuyThisPayload({
  identity       = {},
  scannedPrice   = null,
  uiItems        = [],
  category       = "",
  substituteIntel = null,
} = {}) {
  const budgetAlt  = findBudgetAlternative(identity, category, scannedPrice);
  const valueScore = scorePremiumVsValue(identity, scannedPrice, uiItems);

  const isOverpriced = valueScore?.verdict === "price_trap" || valueScore?.verdict === "overpriced";
  const hasBigGap    = (substituteIntel?.platformGap?.gapPct ?? 0) > 25;

  const shouldWarn = !!(
    (budgetAlt?.found && isOverpriced) ||
    hasBigGap
  );

  const message = (() => {
    if (!shouldWarn) return null;
    if (budgetAlt?.found && isOverpriced) {
      return `You're paying for the label. ${budgetAlt.callToAction}`;
    }
    if (hasBigGap) {
      return `Same item is ${substituteIntel.platformGap.gapPct.toFixed(0)}% cheaper on another platform — don't buy here.`;
    }
    return "Better options exist at a lower price.";
  })();

  return {
    shouldWarn,
    message,
    budgetAlternative: budgetAlt   || null,
    valueScore:        valueScore  || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function resolveBrandTier(brand) {
  for (const [tier, brands] of Object.entries(BRAND_TIER_MAP)) {
    if (brands.some(b => brand.includes(b) || b.includes(brand))) return tier;
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
