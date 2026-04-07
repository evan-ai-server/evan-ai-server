// src/platformFeeEngine.js
// Institutional Bridge — Platform Fee Engine.
//
// Generates the platform_fee_payload consumed by Phase 10 (P&L / Empire Engine).
// Provides category-specific fee schedules for every major resale platform,
// so that listing export bundles and P&L calculations reflect real cash value —
// not gross price.
//
// Fee model per platform:
//   finalValueFee  — % of sale price taken by platform
//   paymentFee     — % of sale price for payment processing (where applicable)
//   shippingOffset — standard shipping cost estimate (USD) for category
//   listingFee     — flat listing fee per item (USD), 0 for most platforms
//   totalFeeRate   — combined effective rate (finalValueFee + paymentFee)
//
// Category overrides:
//   Some categories have non-standard fee rates (e.g. eBay motors, luxury goods).
//   This engine resolves the correct rate for the item's category.
//
// Output (platform_fee_payload):
//   {
//     platforms: {
//       ebay:     { feeRate, estimatedFee, netProceeds, netProceedsAfterShipping },
//       grailed:  { ... },
//       poshmark: { ... },
//       mercari:  { ... },
//       facebook: { ... },
//       stockx:   { ... },
//       goat:     { ... },
//     },
//     bestNetPlatform:    "grailed",
//     bestNetProceeds:    182.50,
//     categoryFeeClass:   "standard"|"luxury"|"sneakers"|"electronics"|"jewelry",
//     computedAt:         <timestamp>,
//     feeVersion:         "bridge_1.0",
//   }

export const FEE_ENGINE_VERSION = "bridge_1.0";

// ── Platform fee tables ───────────────────────────────────────────────────────
// All rates as decimals. Updated to reflect current market rates.

const BASE_FEES = {
  ebay: {
    finalValueFee:  0.1325,   // 13.25% for most categories (as of 2024)
    paymentFee:     0.000,    // Included in FVF since managed payments
    listingFee:     0.00,
    shippingOffset: { default: 8, heavy: 18, bulky: 25, small: 5 },
  },
  grailed: {
    finalValueFee:  0.09,     // 9% seller fee
    paymentFee:     0.029,    // ~2.9% + $0.30 payment processing
    listingFee:     0.00,
    shippingOffset: { default: 7, heavy: 14, bulky: 20, small: 5 },
    fixedPaymentFee: 0.30,
  },
  poshmark: {
    finalValueFee:  0.20,     // 20% for sales >= $15; flat $2.95 under $15
    paymentFee:     0.00,     // Included
    listingFee:     0.00,
    shippingOffset: { default: 0, heavy: 0, bulky: 0, small: 0 },  // buyer pays shipping
    flatFeeUnder15: 2.95,     // flat fee for sales under $15
  },
  mercari: {
    finalValueFee:  0.10,     // 10% selling fee
    paymentFee:     0.029,    // 2.9% payment processing
    listingFee:     0.00,
    shippingOffset: { default: 0, heavy: 0, bulky: 0, small: 0 },  // seller chooses
    fixedPaymentFee: 0.30,
  },
  facebook: {
    finalValueFee:  0.05,     // 5% selling fee (or $0.40 flat for under $8)
    paymentFee:     0.00,
    listingFee:     0.00,
    shippingOffset: { default: 8, heavy: 18, bulky: 25, small: 5 },
    flatFeeUnder8:  0.40,
  },
  stockx: {
    finalValueFee:  0.09,     // 9% transaction fee (level dependent — using base)
    paymentFee:     0.03,     // 3% payment fee
    listingFee:     0.00,
    shippingOffset: { default: 0, heavy: 0, bulky: 0, small: 0 },  // StockX handles shipping
  },
  goat: {
    finalValueFee:  0.098,    // 9.8% commission (varies 5.5–15% based on seller level)
    paymentFee:     0.029,    // payment processing
    listingFee:     0.00,
    shippingOffset: { default: 0, heavy: 0, bulky: 0, small: 0 },
  },
};

// ── Category-specific fee overrides ──────────────────────────────────────────

const CATEGORY_FEE_OVERRIDES = {
  // eBay category-specific FVF overrides (2024 schedule)
  ebay: {
    sneakers:     0.08,     // 8% for sneakers >$100 (eBay authenticated)
    watches:      0.065,    // 6.5% for watches >$1000 (eBay authenticated)
    handbags:     0.09,     // 9% luxury handbags
    jewelry:      0.1225,   // 12.25% jewelry
    electronics:  0.1325,   // standard
    clothing:     0.1325,
    sports:       0.1325,
    collectibles: 0.1325,
    default:      0.1325,
  },
};

// ── Category shipping weight classification ───────────────────────────────────

function _shippingClass(category, price) {
  const cat = (category || "").toLowerCase();
  if (cat.includes("watch") || cat.includes("jewelry"))  return "small";
  if (cat.includes("sneaker") || cat.includes("shoe"))   return "default";
  if (cat.includes("handbag") || cat.includes("bag"))    return "default";
  if (cat.includes("furniture") || cat.includes("sofa")) return "bulky";
  if (cat.includes("electronics") && price > 500)        return "heavy";
  if (cat.includes("electronics"))                       return "default";
  if (cat.includes("clothing") || cat.includes("apparel")) return "default";
  return "default";
}

// ── Category fee class ────────────────────────────────────────────────────────

function _categoryFeeClass(category) {
  const cat = (category || "").toLowerCase();
  if (cat.includes("sneaker") || cat.includes("shoe"))           return "sneakers";
  if (cat.includes("watch") || cat.includes("horology"))         return "luxury";
  if (cat.includes("handbag") || cat.includes("purse") || cat.includes("bag")) return "luxury";
  if (cat.includes("jewelry") || cat.includes("jewel"))          return "jewelry";
  if (cat.includes("electronics") || cat.includes("tech"))       return "electronics";
  return "standard";
}

// ── Core fee computation ──────────────────────────────────────────────────────

function _computePlatformFee(platformId, config, price, category) {
  if (!price || price <= 0) return null;

  const cat    = (category || "").toLowerCase();
  const catKey = _matchCategoryKey(cat, platformId);
  const feeClass = _categoryFeeClass(category);
  const shipClass = _shippingClass(category, price);

  // Resolve effective final value fee
  const fvfOverride = CATEGORY_FEE_OVERRIDES[platformId]?.[catKey];
  const fvf = fvfOverride ?? config.finalValueFee;

  // Poshmark: flat fee for under $15
  if (platformId === "poshmark" && price < 15) {
    const fee = config.flatFeeUnder15 || 2.95;
    const net = Math.max(0, price - fee);
    const shipping = config.shippingOffset[shipClass] || config.shippingOffset.default || 0;
    return {
      feeRate:                  Math.round((fee / price) * 1000) / 1000,
      estimatedFee:             round2(fee),
      netProceeds:              round2(net),
      netProceedsAfterShipping: round2(net - shipping),
      shippingCost:             shipping,
      feeBreakdown: { finalValueFee: fee, paymentFee: 0, listingFee: 0 },
    };
  }

  // Facebook: flat fee for under $8
  if (platformId === "facebook" && price < 8) {
    const fee = config.flatFeeUnder8 || 0.40;
    const net = Math.max(0, price - fee);
    const shipping = config.shippingOffset[shipClass] || 0;
    return {
      feeRate:                  Math.round((fee / price) * 1000) / 1000,
      estimatedFee:             round2(fee),
      netProceeds:              round2(net),
      netProceedsAfterShipping: round2(net - shipping),
      shippingCost:             shipping,
      feeBreakdown: { finalValueFee: fee, paymentFee: 0, listingFee: 0 },
    };
  }

  const fvfAmount      = price * fvf;
  const paymentAmount  = price * (config.paymentFee || 0) + (config.fixedPaymentFee || 0);
  const listingFee     = config.listingFee || 0;
  const totalFee       = fvfAmount + paymentAmount + listingFee;
  const feeRate        = totalFee / price;
  const netProceeds    = Math.max(0, price - totalFee);
  const shipping       = (config.shippingOffset[shipClass] ?? config.shippingOffset.default) || 0;
  const netAfterShip   = Math.max(0, netProceeds - shipping);

  return {
    feeRate:                  Math.round(feeRate * 1000) / 1000,
    estimatedFee:             round2(totalFee),
    netProceeds:              round2(netProceeds),
    netProceedsAfterShipping: round2(netAfterShip),
    shippingCost:             shipping,
    feeBreakdown: {
      finalValueFee:  round2(fvfAmount),
      paymentFee:     round2(paymentAmount),
      listingFee:     listingFee,
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the platform_fee_payload for a given item price + category.
 * This is the Phase 10 / P&L anchor.
 *
 * @param {object} opts
 *   price     {number}       — sale/listing price in USD
 *   category  {string|null}  — item category
 *   platforms {string[]}     — which platforms to include (default: all)
 * @returns {PlatformFeePayload}
 */
export function buildPlatformFeePayload({
  price,
  category  = null,
  platforms = ["all"],
} = {}) {
  const safePrice = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  if (!safePrice) {
    return {
      ok:              false,
      reason:          "price_required",
      platforms:       {},
      feeVersion:      FEE_ENGINE_VERSION,
    };
  }

  const doAll     = platforms.includes("all");
  const wantedIds = doAll ? Object.keys(BASE_FEES) : platforms.filter(p => BASE_FEES[p]);
  const feeClass  = _categoryFeeClass(category);
  const result    = {};

  for (const pid of wantedIds) {
    const cfg = BASE_FEES[pid];
    const fee = _computePlatformFee(pid, cfg, safePrice, category);
    if (fee) result[pid] = { platformId: pid, price: safePrice, ...fee };
  }

  // Best net platform (highest netProceedsAfterShipping)
  let bestPlatform = null;
  let bestNet      = -Infinity;
  for (const [pid, data] of Object.entries(result)) {
    if ((data.netProceedsAfterShipping ?? data.netProceeds) > bestNet) {
      bestNet      = data.netProceedsAfterShipping ?? data.netProceeds;
      bestPlatform = pid;
    }
  }

  return {
    ok:               true,
    price:            safePrice,
    category,
    platforms:        result,
    bestNetPlatform:  bestPlatform,
    bestNetProceeds:  bestNet > 0 ? round2(bestNet) : null,
    categoryFeeClass: feeClass,
    computedAt:       Date.now(),
    feeVersion:       FEE_ENGINE_VERSION,
  };
}

/**
 * Quick fee estimate for a single platform.
 * Used by inline P&L calculations without building full payload.
 */
export function estimatePlatformFee(platformId, price, category = null) {
  const cfg = BASE_FEES[platformId];
  if (!cfg || !price) return null;
  return _computePlatformFee(platformId, cfg, price, category);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _matchCategoryKey(cat, platformId) {
  if (cat.includes("sneaker") || cat.includes("shoe"))    return "sneakers";
  if (cat.includes("watch"))                              return "watches";
  if (cat.includes("handbag") || cat.includes("bag"))     return "handbags";
  if (cat.includes("jewelry") || cat.includes("jewel"))   return "jewelry";
  if (cat.includes("electronics") || cat.includes("tech"))return "electronics";
  if (cat.includes("clothing") || cat.includes("apparel"))return "clothing";
  if (cat.includes("collect"))                            return "collectibles";
  return "default";
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
