// src/exitIntelligence.js
// Exit Intelligence — sell-side guidance for portfolio items.
//
// Answers: when to sell, where to sell, what to price it at.
// All functions are pure/sync — no Redis, no API calls.

// ── Platform routing ──────────────────────────────────────────────────────────

const EXIT_PLATFORM_MAP = {
  sneakers:    (price) => price > 100 ? "StockX"          : "eBay",
  footwear:    (price) => price > 100 ? "StockX"          : "eBay",
  shoes:       (price) => price > 100 ? "StockX"          : "eBay",
  clothing:    ()      => "Poshmark",
  apparel:     ()      => "Poshmark",
  streetwear:  ()      => "Depop",
  electronics: ()      => "eBay",
  watches:     (price) => price > 300 ? "Chrono24"        : "eBay",
  watch:       (price) => price > 300 ? "Chrono24"        : "eBay",
  handbags:    (price) => price > 500 ? "The RealReal"    : "Poshmark",
  handbag:     (price) => price > 500 ? "The RealReal"    : "Poshmark",
  bags:        ()      => "Poshmark",
  bag:         ()      => "Poshmark",
  jewelry:     ()      => "eBay",
  cards:       ()      => "eBay",
  "trading cards": ()  => "eBay",
  collectibles:()      => "eBay",
  furniture:   ()      => "Facebook Marketplace",
  appliances:  ()      => "Facebook Marketplace",
  tools:       ()      => "Facebook Marketplace",
};

const LOCAL_PLATFORM_MAP = {
  furniture:         "Facebook Marketplace",
  appliances:        "Facebook Marketplace",
  exercise_equipment:"Facebook Marketplace",
  large_electronics: "Facebook Marketplace",
  default:           "Facebook Marketplace",
};

const SECONDARY_PLATFORM = {
  "StockX":       "GOAT",
  "Poshmark":     "Depop",
  "Depop":        "Poshmark",
  "eBay":         "Mercari",
  "Chrono24":     "eBay",
  "The RealReal": "Fashionphile",
  "Facebook Marketplace": "OfferUp",
};

function normalizeCat(category) {
  return String(category || "").toLowerCase().trim().replace(/[^a-z0-9 _]/g, "").replace(/\s+/g, "_");
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute the optimal list price based on current market items.
 * Applies a first-mover discount at day 0 to maximize sell-through.
 *
 * @param {string}  category
 * @param {Array}   currentMarketItems   — live market comps
 * @param {string}  condition            — condition string
 * @param {number}  daysHeld             — days item has been held
 * @returns {{ price: number|null, basis: string }}
 */
export function computeOptimalListPrice(category, currentMarketItems, condition, daysHeld = 0) {
  const items = Array.isArray(currentMarketItems) ? currentMarketItems : [];
  const prices = items
    .map(i => Number(i?.totalPrice ?? i?.price ?? i?.currentPrice))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (!prices.length) return { price: null, basis: "no_comps" };

  const median = prices[Math.floor(prices.length / 2)];

  // Condition discount
  const cond = String(condition || "").toLowerCase();
  const condDiscount = /\b(poor|damaged|broken|parts)\b/.test(cond) ? 0.78
    : /\b(fair|worn|used)\b/.test(cond) ? 0.88
    : /\b(good|very\s*good)\b/.test(cond) ? 0.94
    : 1.0; // excellent/like new/mint

  // First-mover discount by days held: sell faster if been sitting
  const urgencyDiscount = daysHeld === 0 ? 0.92    // aggressive to move fast
    : daysHeld < 20  ? 0.95
    : daysHeld < 45  ? 0.93
    : daysHeld < 90  ? 0.88   // need to move
    : 0.82;                   // very stale — aggressive

  const price = round2(median * condDiscount * urgencyDiscount);
  return { price, basis: "current_market_median", medianUsed: round2(median) };
}

/**
 * Select the best exit platform for an item.
 *
 * @param {string}  category
 * @param {number}  price
 * @param {string}  condition
 * @param {string}  resaleMode   — "LOCAL"|"NATIONAL"|"EITHER"
 * @returns {{ primary: string, secondary: string|null, fee: string }}
 */
export function selectExitPlatform(category, price, condition, resaleMode = "NATIONAL") {
  if (resaleMode === "LOCAL") {
    const cat  = normalizeCat(category);
    const plat = LOCAL_PLATFORM_MAP[cat] || LOCAL_PLATFORM_MAP.default;
    return { primary: plat, secondary: "Craigslist", fee: "0–7.9%" };
  }

  const cat      = normalizeCat(category);
  const priceN   = Number(price) || 0;
  const resolver = EXIT_PLATFORM_MAP[cat] || EXIT_PLATFORM_MAP[cat.replace(/_/g, " ")] || null;
  const primary  = resolver ? resolver(priceN) : "eBay";
  const secondary = SECONDARY_PLATFORM[primary] || "Mercari";

  // Platform fee estimates
  const FEE_LABELS = {
    "StockX": "9.5%", "GOAT": "9.5%", "eBay": "13.3%", "Poshmark": "20%",
    "Depop": "10%", "Mercari": "10%", "Chrono24": "6.5%", "The RealReal": "25%",
    "Fashionphile": "20%", "Facebook Marketplace": "5%", "Grailed": "9%",
  };

  return { primary, secondary, fee: FEE_LABELS[primary] || "~10%" };
}

/**
 * Compute hold-or-fold signal for a held item.
 *
 * @param {object} item         — portfolio item with purchasePrice, addedAt, currentPrice
 * @param {number} currentMedian — current market median (null if unavailable)
 * @param {number} daysHeld
 * @returns {"HOLD"|"LIST_NOW"|"DISCOUNT"}
 */
export function computeHoldOrFold(item, currentMedian, daysHeld) {
  const purchase     = Number(item?.purchasePrice) || 0;
  const currentPrice = Number(currentMedian ?? item?.currentPrice) || purchase;
  const days         = Number(daysHeld) || 0;

  if (!purchase) return "HOLD";

  const priceChangeRatio = (currentPrice - purchase) / purchase;
  const priceDropped     = priceChangeRatio < -0.15;

  if (days > 45 || priceDropped)                            return "DISCOUNT";
  if (days >= 20 && Math.abs(priceChangeRatio) <= 0.10)     return "LIST_NOW";
  return "HOLD";
}

/**
 * Returns true if any portfolio item has been held > 45 days.
 * Signal to sell before buying more.
 */
export function shouldSellBeforeBuying(portfolioItems) {
  if (!Array.isArray(portfolioItems)) return false;
  const now = Date.now();
  return portfolioItems.some(item => {
    const addedAt = Number(item?.addedAt ?? item?.purchasedAt);
    if (!addedAt) return false;
    const daysHeld = (now - addedAt) / 86400000;
    return daysHeld > 45;
  });
}

/**
 * Compute daysHeld for a portfolio item.
 */
export function computeDaysHeld(item) {
  const addedAt = Number(item?.addedAt ?? item?.purchasedAt);
  if (!addedAt) return 0;
  return Math.max(0, Math.round((Date.now() - addedAt) / 86400000));
}

// ── Phase 7 enrichment ────────────────────────────────────────────────────────

/**
 * Compute capital risk tier for a held item.
 *
 * Considers: days held, liquidity tier, and unrealized loss position.
 *
 * @param {object} item          — { purchasePrice, currentPrice }
 * @param {number} daysHeld
 * @param {string} liquidityTier — "DEEP"|"ADEQUATE"|"DEVELOPING"|"THIN"|"INSUFFICIENT"
 * @returns {"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"}
 */
export function computeCapitalRisk(item, daysHeld, liquidityTier) {
  const days     = Number(daysHeld) || 0;
  const purchase = Number(item?.purchasePrice) || 0;
  const current  = Number(item?.currentPrice ?? item?.currentMedian) || purchase;

  const lossPct  = purchase > 0 ? ((purchase - current) / purchase) : 0;
  const inLoss   = lossPct > 0.05; // more than 5% below purchase

  const liquidRank = { DEEP: 0, ADEQUATE: 1, DEVELOPING: 2, THIN: 3, INSUFFICIENT: 4 };
  const lRank = liquidRank[liquidityTier] ?? 2;

  // Critical: stale + illiquid + losing money
  if (days > 90 && lRank >= 3 && inLoss)   return "CRITICAL";
  // Critical: extreme age regardless
  if (days > 120)                            return "CRITICAL";
  // High: stale + illiquid OR significant loss
  if ((days > 45 && lRank >= 2) || lossPct > 0.20) return "HIGH";
  // High: illiquid thin market
  if (lRank >= 3 && days > 20)               return "HIGH";
  // Medium: moderately stale or minor loss
  if (days > 20 || inLoss)                   return "MEDIUM";
  return "LOW";
}

/**
 * Compute exit confidence score (0–100) based on market health.
 *
 * Higher = more confident the item will sell at the recommended price.
 *
 * @param {Array}  marketItems     — live market comps array
 * @param {number} liquidityScore  — 0–1 (from marketDepthGate)
 * @param {number} medianDaysToSell — median days to sell for comparable items
 * @returns {number} 0–100
 */
export function computeExitConfidence(marketItems, liquidityScore, medianDaysToSell) {
  const items  = Array.isArray(marketItems) ? marketItems : [];
  const lScore = Number(liquidityScore) || 0;   // 0–1
  const dts    = Number(medianDaysToSell) || 30;

  // Volume component: 0–40pts — more comps = more confidence
  const volPts = Math.min(40, (items.length / 10) * 40);

  // Liquidity component: 0–40pts
  const liqPts = Math.min(40, lScore * 40);

  // Velocity component: 0–20pts — faster days-to-sell = more confidence
  const velPts = dts <= 3  ? 20
    : dts <= 7  ? 16
    : dts <= 14 ? 12
    : dts <= 30 ? 8
    : dts <= 60 ? 4
    : 0;

  return Math.min(100, Math.round(volPts + liqPts + velPts));
}

/**
 * Compute the reprice delta — how much to drop the ask to move the item.
 *
 * Returns null if no reprice is needed (price is already competitive).
 *
 * @param {number} currentAskPrice    — what the seller is asking now
 * @param {number} currentMarketMedian — live median of active comps
 * @param {number} daysHeld
 * @returns {{ dropAmount: number, dropPct: number, newTarget: number, reason: string } | null}
 */
export function computeRepriceDelta(currentAskPrice, currentMarketMedian, daysHeld) {
  const ask    = Number(currentAskPrice)    || 0;
  const median = Number(currentMarketMedian) || 0;
  const days   = Number(daysHeld)            || 0;

  if (!ask || !median) return null;

  const overMarket = (ask - median) / median; // positive = priced above median

  // No reprice needed if priced competitively and not stale
  if (overMarket <= 0.03 && days < 20) return null;

  // Compute target: price to 5% below median to undercut, more aggressively if stale
  const aggressiveness = days > 60 ? 0.12 : days > 30 ? 0.08 : 0.05;
  const newTarget = round2(median * (1 - aggressiveness));

  if (newTarget >= ask) return null; // current price already below target

  const dropAmount = round2(ask - newTarget);
  const dropPct    = round2((dropAmount / ask) * 100);

  const reason = overMarket > 0.15
    ? `Listed ${Math.round(overMarket * 100)}% above market median — repricing needed to compete`
    : days > 45
    ? `${days} days listed without sale — price reduction recommended`
    : `Priced above current market — small reduction recommended`;

  return { dropAmount, dropPct, newTarget, reason };
}

/**
 * Compute relist timing recommendation for a stale or unlisted item.
 *
 * @param {object} item          — { purchasePrice }
 * @param {number} daysHeld
 * @param {number} liquidityScore — 0–1
 * @returns {{ action: "REPRICE"|"REFRESH"|"ABANDON", triggerDays: number, reason: string }}
 */
export function computeRelistTiming(item, daysHeld, liquidityScore) {
  const days    = Number(daysHeld)    || 0;
  const lScore  = Number(liquidityScore) || 0;
  const purchase = Number(item?.purchasePrice) || 0;
  const current  = Number(item?.currentPrice ?? item?.currentMedian) || purchase;
  const lossRatio = purchase > 0 ? (purchase - current) / purchase : 0;

  // Abandon: deeply underwater in a thin market after long hold
  if (days > 90 && lScore < 0.25 && lossRatio > 0.30) {
    return {
      action: "ABANDON",
      triggerDays: 0,
      reason: `${Math.round(lossRatio * 100)}% below entry in a thin market after ${days} days — exit at any price`,
    };
  }

  // Aggressive reprice: stale with moderate loss or illiquid
  if (days > 45 || (days > 20 && lScore < 0.40)) {
    const triggerDays = Math.max(0, 45 - days);
    return {
      action: "REPRICE",
      triggerDays,
      reason: days > 45
        ? `Listed over ${days} days — reprice to 8–12% below market median now`
        : `Low liquidity market — reduce ask to move within ${triggerDays} days`,
    };
  }

  // Normal refresh: standard relist at 30-day mark
  const triggerDays = Math.max(0, 30 - days);
  return {
    action: "REFRESH",
    triggerDays,
    reason: triggerDays === 0
      ? "Refresh listing to surface in search results"
      : `Refresh listing in ${triggerDays} days if no sale`,
  };
}

/**
 * Build the full exit intelligence payload for a portfolio item.
 * This is the single call sites should use — everything composited.
 *
 * @param {object} item — portfolio item: { purchasePrice, currentPrice, condition, category, addedAt, purchasedAt, resaleMode }
 * @param {object} ctx  — { marketMedian?, marketItems?, liquidityScore?, liquidityTier?, medianDaysToSell?, daysHeld? }
 * @returns {object} full exit intel payload
 */
export function buildFullExitIntel(item, ctx = {}) {
  const {
    marketMedian      = null,
    marketItems       = [],
    liquidityScore    = 0,
    liquidityTier     = "DEVELOPING",
    medianDaysToSell  = 30,
  } = ctx;

  const daysHeld = ctx.daysHeld != null
    ? Number(ctx.daysHeld)
    : computeDaysHeld(item);

  const category  = String(item?.category || "").toLowerCase().trim();
  const price     = Number(item?.purchasePrice) || 0;
  const condition = String(item?.condition || "");
  const resaleMode = String(item?.resaleMode || "NATIONAL").toUpperCase();

  // Derive current effective market price
  const effectiveMedian = marketMedian != null
    ? Number(marketMedian)
    : (Array.isArray(marketItems) && marketItems.length > 0
      ? (() => {
          const ps = marketItems.map(i => Number(i?.totalPrice ?? i?.price ?? 0)).filter(n => n > 0).sort((a, b) => a - b);
          return ps.length ? ps[Math.floor(ps.length / 2)] : null;
        })()
      : null);

  const { price: recommendedListPrice, basis: priceBasis, medianUsed } =
    computeOptimalListPrice(category, marketItems, condition, daysHeld);

  const { primary: preferredPlatform, secondary: secondaryPlatform, fee: platformFee } =
    selectExitPlatform(category, recommendedListPrice ?? price, condition, resaleMode);

  const holdOrFold      = computeHoldOrFold(item, effectiveMedian, daysHeld);
  const capitalRisk     = computeCapitalRisk(item, daysHeld, liquidityTier);
  const exitConfidence  = computeExitConfidence(marketItems, liquidityScore, medianDaysToSell);
  const repriceDelta    = computeRepriceDelta(
    Number(item?.currentAskPrice ?? recommendedListPrice ?? price),
    effectiveMedian,
    daysHeld,
  );
  const relistTiming    = computeRelistTiming(item, daysHeld, liquidityScore);
  const staleInventory  = daysHeld > 45;

  // Estimated profit at recommended list price
  const estProfit = recommendedListPrice != null && price > 0
    ? round2(recommendedListPrice - price)
    : null;
  const estMargin = estProfit != null && price > 0
    ? round2((estProfit / price) * 100)
    : null;

  return {
    recommendedListPrice,
    preferredPlatform,
    secondaryPlatform,
    platformFee,
    holdOrFold,
    daysHeld,
    capitalRisk,
    staleInventory,
    exitConfidence,
    repriceDelta:       repriceDelta  || null,
    relistTiming,
    estProfit,
    estMargin,
    effectiveMarketMedian: effectiveMedian != null ? round2(effectiveMedian) : null,
    priceBasis,
    medianUsed:         medianUsed ?? null,
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(Number(v) * 100) / 100; }
