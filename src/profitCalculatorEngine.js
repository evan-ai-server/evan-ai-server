// src/profitCalculatorEngine.js
// Full resale P&L engine: buy → fees → shipping → net profit, break-even,
// ROI comparison across platforms, and multi-scenario modeling.

// ── Platform fee registry ─────────────────────────────────────────────────────
const PLATFORM_FEES = {
  stockx:    { selling: 0.095, payment: 0.030, fixed: 0.00, label: "StockX"    },
  goat:      { selling: 0.095, payment: 0.030, fixed: 0.00, label: "GOAT"      },
  grailed:   { selling: 0.090, payment: 0.029, fixed: 0.00, label: "Grailed"   },
  ebay:      { selling: 0.133, payment: 0.030, fixed: 0.30, label: "eBay"      },
  poshmark:  { selling: 0.200, payment: 0.000, fixed: 0.00, label: "Poshmark"  },
  depop:     { selling: 0.100, payment: 0.029, fixed: 0.00, label: "Depop"     },
  mercari:   { selling: 0.100, payment: 0.029, fixed: 0.00, label: "Mercari"   },
  facebook:  { selling: 0.050, payment: 0.000, fixed: 0.00, label: "FB Marketplace" },
  etsy:      { selling: 0.065, payment: 0.030, fixed: 0.20, label: "Etsy"      },
  "the real real": { selling: 0.25, payment: 0.00, fixed: 0.00, label: "The RealReal" },
  fashionphile: { selling: 0.20, payment: 0.00, fixed: 0.00, label: "Fashionphile" },
  chrono24:  { selling: 0.065, payment: 0.030, fixed: 0.00, label: "Chrono24"  },
  local:     { selling: 0.000, payment: 0.000, fixed: 0.00, label: "Local/Cash" },
};

// Shipping cost estimates by category + item weight tier
const SHIPPING_ESTIMATES = {
  sneakers:     { light: 12, standard: 15, heavy: 18 },
  apparel:      { light: 6,  standard: 9,  heavy: 14 },
  bag:          { light: 10, standard: 14, heavy: 20 },
  electronics:  { light: 8,  standard: 12, heavy: 20 },
  watch:        { light: 10, standard: 12, heavy: 15 },
  eyewear:      { light: 6,  standard: 8,  heavy: 10 },
  collectibles: { light: 6,  standard: 10, heavy: 15 },
  default:      { light: 8,  standard: 12, heavy: 16 },
};

// Self-employment tax estimate for resellers (US, rough)
const RESELLER_TAX_RATE = 0.15;

// ── Realized-profit friction tables ──────────────────────────────────────────
const CATEGORY_RETURN_RATES = {
  sneakers: 0.04, footwear: 0.04, clothing: 0.18, apparel: 0.18,
  streetwear: 0.12, electronics: 0.12, handbags: 0.08, handbag: 0.08,
  watches: 0.05, jewelry: 0.06, tools: 0.03, collectibles: 0.04, default: 0.08,
};

const CATEGORY_RELIST_RATES = {
  clothing: 0.25, apparel: 0.25, electronics: 0.20, sneakers: 0.10,
  footwear: 0.10, handbags: 0.12, watches: 0.08, default: 0.15,
};

export const CATEGORY_DAYS_TO_SALE = {
  sneakers: 7, footwear: 10, clothing: 14, apparel: 14, streetwear: 10,
  electronics: 7, handbags: 12, watches: 21, jewelry: 18, tools: 21,
  collectibles: 28, furniture: 14, appliances: 10, default: 14,
};

const LOCAL_PLATFORM_FEES = {
  facebook:   { selling: 0.050, payment: 0.000, fixed: 0.00, label: "FB Marketplace" },
  craigslist: { selling: 0.000, payment: 0.000, fixed: 0.00, label: "Craigslist"     },
  offerup:    { selling: 0.079, payment: 0.000, fixed: 0.00, label: "OfferUp"        },
  nextdoor:   { selling: 0.000, payment: 0.000, fixed: 0.00, label: "Nextdoor"       },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute net profit for a single platform scenario.
 */
export function computePlatformProfit({
  buyPrice      = null,
  sellPrice     = null,
  platform      = "ebay",
  category      = "",
  shippingPaid  = null,   // what seller charges buyer for shipping
  shippingCost  = null,   // actual shipping cost to seller
  includeTax    = false,
} = {}) {
  const buy  = finiteOrNull(buyPrice);
  const sell = finiteOrNull(sellPrice);
  if (!buy || !sell) return null;

  const fees     = PLATFORM_FEES[platform] || PLATFORM_FEES.ebay;
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const shipEst  = SHIPPING_ESTIMATES[cat] || SHIPPING_ESTIMATES.default;

  // Platform fees
  const sellingFee  = round2(sell * fees.selling);
  const paymentFee  = round2(sell * fees.payment + fees.fixed);
  const totalFees   = round2(sellingFee + paymentFee);

  // Shipping: if seller charges buyer, net 0; otherwise it's a cost
  const shipCost    = finiteOrNull(shippingCost) ?? shipEst.standard;
  const shipCharged = finiteOrNull(shippingPaid) ?? 0;
  const netShipping = round2(shipCost - shipCharged);

  // Gross profit
  const grossProfit = round2(sell - buy - totalFees - netShipping);

  // Tax (optional)
  const taxAmount   = includeTax && grossProfit > 0
    ? round2(grossProfit * RESELLER_TAX_RATE)
    : 0;

  const netProfit   = round2(grossProfit - taxAmount);
  const roi         = buy > 0 ? round2((netProfit / buy) * 100) : null;
  const margin      = sell > 0 ? round2((netProfit / sell) * 100) : null;

  return {
    platform:     fees.label,
    buyPrice:     round2(buy),
    sellPrice:    round2(sell),
    fees: {
      sellingFee,
      paymentFee,
      totalFees,
      effectiveFeePct: round2((totalFees / sell) * 100),
    },
    shipping: {
      cost:      round2(shipCost),
      charged:   round2(shipCharged),
      netCost:   netShipping,
    },
    grossProfit,
    taxAmount,
    netProfit,
    roi,
    margin,
    breakEven:   round2(buy + totalFees + netShipping + taxAmount),
    profitable:  netProfit > 0,
  };
}

/**
 * Compare profit across multiple platforms for the same sale.
 */
export function comparePlatformProfits({
  buyPrice     = null,
  sellPrice    = null,
  category     = "",
  platforms    = ["ebay", "grailed", "stockx", "poshmark", "local"],
  includeTax   = false,
} = {}) {
  const results = platforms
    .map(platform => computePlatformProfit({ buyPrice, sellPrice, platform, category, includeTax }))
    .filter(Boolean)
    .sort((a, b) => (b.netProfit ?? -999) - (a.netProfit ?? -999));

  const best  = results[0] || null;
  const worst = results[results.length - 1] || null;

  return {
    best,
    worst,
    all:            results,
    profitSpread:   best && worst ? round2(best.netProfit - worst.netProfit) : null,
    recommendation: best
      ? `List on ${best.platform} for best return: $${best.netProfit.toFixed(2)} net (${best.roi?.toFixed(0) ?? "?"}% ROI)`
      : null,
  };
}

/**
 * Compute break-even sell price (minimum to avoid a loss).
 */
export function computeBreakEven({
  buyPrice  = null,
  platform  = "ebay",
  category  = "",
  includeTax = false,
} = {}) {
  const buy  = finiteOrNull(buyPrice);
  if (!buy) return null;

  const fees    = PLATFORM_FEES[platform] || PLATFORM_FEES.ebay;
  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const ship    = (SHIPPING_ESTIMATES[cat] || SHIPPING_ESTIMATES.default).standard;

  // Break-even: sell = buy + fees(sell) + ship + tax(profit)
  // Solving: sell*(1 - sellingRate - paymentRate) - fixed = buy + ship
  // => sell = (buy + ship + fixed) / (1 - sellingRate - paymentRate)
  const feeRate   = fees.selling + fees.payment;
  const taxAdj    = includeTax ? (1 - RESELLER_TAX_RATE) : 1;
  const breakEven = round2((buy + ship + fees.fixed) / (feeRate < 1 ? (1 - feeRate) * taxAdj : 0.70));

  return {
    platform:   fees.label,
    buyPrice:   round2(buy),
    breakEven,
    shippingEst: round2(ship),
    effectiveFeeRate: round2(feeRate * 100),
    signal:     `Must sell above $${breakEven.toFixed(2)} on ${fees.label} to break even`,
  };
}

/**
 * Model multiple profit scenarios: fast flip vs. patient hold.
 */
export function buildProfitScenarios({
  buyPrice     = null,
  medianMarket = null,
  category     = "",
  platform     = "ebay",
  includeTax   = false,
} = {}) {
  const buy    = finiteOrNull(buyPrice);
  const median = finiteOrNull(medianMarket);
  if (!buy || !median) return null;

  const scenarios = [
    { label: "Quick sell (5% below median)", sellPrice: round2(median * 0.95), daysEst: "1–7 days"  },
    { label: "At market (median price)",     sellPrice: round2(median),         daysEst: "7–14 days" },
    { label: "Patient hold (5% above)",      sellPrice: round2(median * 1.05),  daysEst: "14–30 days"},
    { label: "Premium list (15% above)",     sellPrice: round2(median * 1.15),  daysEst: "30–60 days"},
  ];

  return scenarios.map(s => ({
    ...s,
    ...computePlatformProfit({ buyPrice: buy, sellPrice: s.sellPrice, platform, category, includeTax }),
  }));
}

/**
 * Master profit calculator payload.
 */
export function buildProfitCalculatorPayload({
  buyPrice     = null,
  medianMarket = null,
  scannedPrice = null,
  category     = "",
  platform     = "ebay",
  platforms    = ["ebay", "grailed", "stockx", "poshmark", "mercari", "local"],
  includeTax   = false,
} = {}) {
  const effectiveBuy = finiteOrNull(buyPrice) || finiteOrNull(scannedPrice);
  const sellTarget   = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);

  const bestPlatform = comparePlatformProfits({
    buyPrice:  effectiveBuy,
    sellPrice: sellTarget,
    category,
    platforms,
    includeTax,
  });

  const breakEven = computeBreakEven({
    buyPrice: effectiveBuy,
    platform: bestPlatform?.best?.platform?.toLowerCase().replace(/\s/g, "") || platform,
    category,
    includeTax,
  });

  const scenarios = buildProfitScenarios({
    buyPrice:     effectiveBuy,
    medianMarket: sellTarget,
    category,
    platform:     bestPlatform?.best?.platform?.toLowerCase().replace(/\s/g, "") || platform,
    includeTax,
  });

  return {
    buyPrice:       effectiveBuy ? round2(effectiveBuy) : null,
    sellTarget:     sellTarget   ? round2(sellTarget)   : null,
    bestPlatform,
    breakEven,
    scenarios:      scenarios || null,
    topSignal:      bestPlatform?.recommendation || breakEven?.signal || null,
  };
}

// ── Realized profit range ─────────────────────────────────────────────────────

/**
 * Compute optimistic / realistic / pessimistic profit range.
 * Accounts for return rates, relisting costs, and capital lock-up.
 *
 * @param {number} buyPrice
 * @param {number} sellPrice           — expected sell price (market median)
 * @param {string} platform            — platform key
 * @param {string} category
 * @param {number} medianDaysToSale    — from calibrator or static table
 * @param {boolean} resaleMode         — "LOCAL" suppresses shipping cost
 * @returns {{ optimistic, realistic, pessimistic, currency }}
 */
export function computeProfitRange({
  buyPrice, sellPrice, platform = "ebay", category = "",
  medianDaysToSale = null, resaleMode = "NATIONAL",
} = {}) {
  const base = computePlatformProfit({ buyPrice, sellPrice, platform, category });
  if (!base) return null;

  const catKey      = normalizeCatKey(category);
  const returnRate  = CATEGORY_RETURN_RATES[catKey]  ?? CATEGORY_RETURN_RATES.default;
  const relistRate  = CATEGORY_RELIST_RATES[catKey]  ?? CATEGORY_RELIST_RATES.default;
  const daysToSale  = medianDaysToSale ?? CATEGORY_DAYS_TO_SALE[catKey] ?? CATEGORY_DAYS_TO_SALE.default;

  const cat    = String(category || "").toLowerCase().replace(/s$/, "");
  const shipEst = (SHIPPING_ESTIMATES[cat] || SHIPPING_ESTIMATES.default).standard;
  const relistCost = resaleMode === "LOCAL" ? 0 : shipEst; // relist = reshipping the returned item

  // Capital lock-up cost: 2% of buy price per 30 days held
  const holdCost = (v, days) => 0.02 * (finiteOrNull(buyPrice) || 0) * (days / 30);

  const optimistic  = round2(base.netProfit);
  const realistic   = round2(
    optimistic * (1 - returnRate)
    - relistCost * relistRate
    - holdCost(base.netProfit, daysToSale)
  );
  const pessimistic = round2(
    optimistic * (1 - returnRate * 1.5)
    - relistCost * relistRate * 1.5
    - holdCost(base.netProfit, daysToSale * 1.5)
  );

  return {
    optimistic,
    realistic,
    pessimistic,
    currency: "USD",
  };
}

/**
 * Build holdEstimate from calibrator data or static fallback.
 */
export function buildHoldEstimate(category, medianDaysToSale = null) {
  const catKey = normalizeCatKey(category);
  const median = medianDaysToSale ?? CATEGORY_DAYS_TO_SALE[catKey] ?? CATEGORY_DAYS_TO_SALE.default;
  return {
    minDays:    Math.round(median * 0.4),
    medianDays: median,
    maxDays:    Math.round(median * 2.5),
    source:     medianDaysToSale != null ? "empirical" : "estimate",
  };
}

/**
 * Build returnRisk object.
 */
export function buildReturnRisk(category) {
  const catKey = normalizeCatKey(category);
  const pct    = CATEGORY_RETURN_RATES[catKey] ?? CATEGORY_RETURN_RATES.default;
  return { pct, source: "estimate" };
}

function normalizeCatKey(category) {
  return String(category || "").toLowerCase().trim().replace(/[^a-z]/g, "");
}

// ── LOCAL mode profit computation ─────────────────────────────────────────────

/**
 * Compute platform profit for a LOCAL-mode sale (no shipping, local fees).
 */
export function computeLocalPlatformProfit({ buyPrice, sellPrice, localPlatform = "facebook" } = {}) {
  const buy  = finiteOrNull(buyPrice);
  const sell = finiteOrNull(sellPrice);
  if (!buy || !sell) return null;

  const fees       = LOCAL_PLATFORM_FEES[localPlatform.toLowerCase()] ?? LOCAL_PLATFORM_FEES.facebook;
  const sellingFee = round2(sell * fees.selling);
  const totalFees  = round2(sellingFee + fees.fixed);
  const netProfit  = round2(sell - buy - totalFees); // no shipping

  return {
    platform:    fees.label,
    buyPrice:    round2(buy),
    sellPrice:   round2(sell),
    totalFees,
    shipCost:    0,
    netProfit,
    roi:         buy > 0 ? round2((netProfit / buy) * 100) : null,
    profitable:  netProfit > 0,
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
