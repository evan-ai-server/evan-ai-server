// src/smartPriceTargetEngine.js
// Smart price target engine: synthesizes all available intel into three
// precise price targets — max buy price, hold price, and optimal sell price —
// plus a time-to-flip estimate and "buy under $X, flip for $Y in N weeks."

// ── Liquidity multipliers by category ────────────────────────────────────────
// How many weeks to flip at market price
const CATEGORY_FLIP_WEEKS = {
  sneakers:    { fast: 1, median: 3, slow: 8  },
  electronics: { fast: 1, median: 2, slow: 6  },
  bag:         { fast: 2, median: 5, slow: 14 },
  watch:       { fast: 2, median: 6, slow: 16 },
  apparel:     { fast: 1, median: 4, slow: 12 },
  eyewear:     { fast: 2, median: 5, slow: 14 },
  default:     { fast: 2, median: 4, slow: 10 },
};

// ── Platform fee constants ─────────────────────────────────────────────────────
const DEFAULT_SELL_FEE  = 0.133; // eBay blended
const DEFAULT_SHIP_COST = 12;

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute the maximum price to pay for a specific profit target.
 */
export function computeMaxBuyPrice({
  targetSellPrice = null,
  profitTargetPct = 15,   // desired profit %
  sellFeePct      = DEFAULT_SELL_FEE,
  shippingCost    = DEFAULT_SHIP_COST,
} = {}) {
  const sell = finiteOrNull(targetSellPrice);
  if (!sell) return null;

  const netSell = sell * (1 - sellFeePct) - shippingCost;
  const maxBuy  = round2(netSell / (1 + profitTargetPct / 100));
  return maxBuy > 0 ? maxBuy : null;
}

/**
 * Compute optimal sell price given buy price + platform + desired ROI.
 */
export function computeOptimalSellPrice({
  buyPrice    = null,
  profitTargetPct = 20,
  sellFeePct  = DEFAULT_SELL_FEE,
  shippingCost = DEFAULT_SHIP_COST,
  medianMarket = null,
} = {}) {
  const buy    = finiteOrNull(buyPrice);
  const market = finiteOrNull(medianMarket);
  if (!buy) return null;

  // Formula: sellPrice * (1 - fee) - shipping = buy * (1 + profit%)
  const targetNet   = buy * (1 + profitTargetPct / 100);
  const rawSellPrice = round2((targetNet + shippingCost) / (1 - sellFeePct));

  // Cap at 1.4x market to avoid unrealistic pricing
  const ceiling = market ? round2(market * 1.40) : rawSellPrice;
  return Math.min(rawSellPrice, ceiling);
}

/**
 * Estimate time to flip based on demand tier and category.
 */
export function estimateFlipTime(category = "", demandTier = "warm") {
  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const windows = CATEGORY_FLIP_WEEKS[cat] || CATEGORY_FLIP_WEEKS.default;

  const weeks = demandTier === "hot"  ? windows.fast
              : demandTier === "warm" ? windows.median
              : demandTier === "cool" ? Math.round((windows.median + windows.slow) / 2)
              : windows.slow;

  return { weeks, rangeLabel: `${windows.fast}–${windows.slow} weeks` };
}

/**
 * Build complete price targets from all available intel.
 */
export function buildPriceTargets({
  scannedPrice     = null,
  medianMarket     = null,
  dealVerdict      = null,
  demandTier       = "warm",
  conditionImpact  = 0,      // % to deduct from market for condition
  depreciationRate = 0,      // annual %
  category         = "",
  profitTarget     = 20,     // desired profit %
  sellFeePct       = DEFAULT_SELL_FEE,
  shippingCost     = DEFAULT_SHIP_COST,
  isReseller       = true,
} = {}) {
  const scanned = finiteOrNull(scannedPrice);
  const market  = finiteOrNull(medianMarket);
  const base    = market || scanned;
  if (!base) return null;

  // Condition-adjusted fair value
  const conditionFair = round2(base * (1 - conditionImpact / 100));

  // Depreciation-adjusted hold price (6-month projection)
  const sixMonthDepreciation = depreciationRate > 0 ? depreciationRate / 2 : 0;
  const holdPrice = round2(conditionFair * (1 - sixMonthDepreciation / 100));

  // Max buy price for target profit
  const sellTarget = conditionFair;
  const maxBuyForProfit = computeMaxBuyPrice({
    targetSellPrice: sellTarget,
    profitTargetPct: profitTarget,
    sellFeePct,
    shippingCost,
  });

  // Conservative max buy (for personal use — just needs to be under market)
  const maxBuyPersonal = round2(conditionFair * 0.95);

  // Optimal sell price
  const optimalSell = computeOptimalSellPrice({
    buyPrice:       scanned,
    profitTargetPct: profitTarget,
    sellFeePct,
    shippingCost,
    medianMarket:   market,
  });

  // Flip time
  const flipTime = estimateFlipTime(category, demandTier);

  // Net profit if buying at scanned price and selling at market
  const netProfit = scanned && market
    ? round2(market * (1 - sellFeePct) - shippingCost - scanned)
    : null;

  const roi = netProfit && scanned
    ? round2((netProfit / scanned) * 100)
    : null;

  const verdict = !scanned ? "NEEDS_PRICE"
    : dealVerdict === "steal" ? "STRONG_BUY"
    : dealVerdict === "good"  ? "BUY"
    : dealVerdict === "fair"  ? "BUY_PERSONAL"
    : dealVerdict === "high"  ? "SKIP"
    : netProfit && netProfit > 0 ? "BUY"
    : "PASS";

  return {
    conditionFair,
    holdPrice,
    maxBuyReseller:  maxBuyForProfit,
    maxBuyPersonal,
    optimalSellPrice: optimalSell,
    netProfit,
    roi,
    flipTime,
    profitTarget,
    verdict,
    signal: verdict === "STRONG_BUY" || verdict === "BUY"
      ? `Buy under $${maxBuyForProfit?.toFixed(2) ?? conditionFair?.toFixed(2)} — target flip at $${optimalSell?.toFixed(2) ?? market?.toFixed(2)} in ~${flipTime.weeks}wk (~$${netProfit?.toFixed(2) ?? "?"} net, ${roi?.toFixed(0) ?? "?"}% ROI)`
      : verdict === "BUY_PERSONAL"
      ? `Fair for personal use — buy under $${maxBuyPersonal?.toFixed(2)}, fair value $${conditionFair?.toFixed(2)}`
      : `Skip or negotiate — not enough margin at current price`,
  };
}

/**
 * Master smart price target payload.
 */
export function buildSmartPriceTargetPayload({
  scannedPrice     = null,
  medianMarket     = null,
  dealVerdict      = null,
  demandSignals    = null,
  conditionPricing = null,
  depreciationCurve = null,
  category         = "",
  profitTarget     = 20,
} = {}) {
  const demandTier     = demandSignals?.tier          || "warm";
  const conditionImpact = conditionPricing?.totalImpactPct || 0;
  const depreciationRate = depreciationCurve?.annualDepreciationPct || 0;

  const targets = buildPriceTargets({
    scannedPrice,
    medianMarket,
    dealVerdict,
    demandTier,
    conditionImpact,
    depreciationRate,
    category,
    profitTarget,
  });

  return {
    targets:    targets   || null,
    topSignal:  targets?.signal || null,
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
