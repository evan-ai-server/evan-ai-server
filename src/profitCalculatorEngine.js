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

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
