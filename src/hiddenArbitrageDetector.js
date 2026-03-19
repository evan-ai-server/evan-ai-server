// src/hiddenArbitrageDetector.js
// Hidden marketplace arbitrage: buy low on one platform, sell high on another

// ── Platform fee registry ────────────────────────────────────────────────────
const PLATFORM_FEES = {
  ebay:      0.133,   // 13.3% final value fee
  etsy:      0.065,   // 6.5% transaction + listing
  walmart:   0.15,    // marketplace referral
  bestbuy:   0.0,     // retail, not resale
  facebook:  0.05,    // 5% selling fee
  mercari:   0.10,
  depop:     0.10,
  poshmark:  0.20,
  grailed:   0.09,
  stockx:    0.095,
  goat:      0.095,
};

// Best resale platforms by category (sell side)
const SELL_PLATFORMS_BY_CATEGORY = {
  sneakers:     ["stockx", "goat", "grailed", "ebay"],
  apparel:      ["grailed", "depop", "poshmark", "ebay"],
  electronics:  ["ebay", "facebook", "mercari"],
  eyewear:      ["ebay", "poshmark", "depop"],
  watch:        ["ebay", "grailed"],
  bag:          ["poshmark", "grailed", "ebay"],
  collectibles: ["ebay", "grailed"],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Detect price gaps across platforms in the result set.
 * Returns the optimal buy platform → sell platform arbitrage opportunity.
 */
export function detectPlatformArbitrage(uiItems = [], category = "", scannedPrice = null) {
  if (!Array.isArray(uiItems) || uiItems.length < 2) return null;

  // Build per-platform price arrays
  const byPlatform = {};
  for (const item of uiItems) {
    const src   = String(item?.source || item?.platform || "unknown").toLowerCase().trim();
    const price = finiteOrNull(item?.totalPrice ?? item?.price);
    if (!price) continue;
    if (!byPlatform[src]) byPlatform[src] = [];
    byPlatform[src].push(price);
  }

  // Compute median per platform
  const medians = {};
  for (const [src, prices] of Object.entries(byPlatform)) {
    if (!prices.length) continue;
    const sorted = [...prices].sort((a, b) => a - b);
    medians[src] = sorted[Math.floor(sorted.length / 2)];
  }

  const entries = Object.entries(medians).sort(([, a], [, b]) => a - b);
  if (entries.length < 2) return null;

  const [buyPlatform, buyPrice]   = entries[0];
  const [sellPlatform, sellPrice] = entries[entries.length - 1];

  const gapRaw  = sellPrice - buyPrice;
  const gapPct  = round2((gapRaw / buyPrice) * 100);
  if (gapPct < 10) return null; // not actionable

  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const sellFee  = PLATFORM_FEES[sellPlatform] ?? 0.10;
  const sellNet  = round2(sellPrice * (1 - sellFee));
  const netProfit = round2(sellNet - buyPrice);
  const roi       = buyPrice > 0 ? round2((netProfit / buyPrice) * 100) : 0;

  const suggestedSellPlatforms = (SELL_PLATFORMS_BY_CATEGORY[cat] || ["ebay", "poshmark"])
    .filter(p => p !== buyPlatform);

  return {
    found:                   true,
    type:                    "platform_arbitrage",
    buyPlatform,
    buyPrice:                round2(buyPrice),
    sellPlatform,
    sellPrice:               round2(sellPrice),
    gapDollars:              round2(gapRaw),
    gapPct,
    netProfit,
    roi,
    sellFeeEstimatePct:      round2(sellFee * 100),
    suggestedSellPlatforms,
    allPlatformMedians:      medians,
    signal: `Buy on ${buyPlatform} ($${round2(buyPrice).toFixed(2)}) → flip on ${suggestedSellPlatforms[0] || sellPlatform} — est. $${netProfit.toFixed(2)} net (${roi.toFixed(0)}% ROI)`,
  };
}

/**
 * Detect if the scanned price is a meaningful buy opportunity vs. the live market.
 */
export function detectBuyOpportunity(scannedPrice, uiItems = [], consensus = null) {
  const scanned = finiteOrNull(scannedPrice);
  if (!scanned) return null;

  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const medianMarket = finiteOrNull(consensus?.medianPrice)
    ?? (prices.length ? prices[Math.floor(prices.length / 2)] : null);

  if (!medianMarket) return null;

  const discount    = round2(medianMarket - scanned);
  const discountPct = round2((discount / medianMarket) * 100);

  if (discountPct < 10) return null;

  const tier = discountPct >= 40 ? "screaming_deal"
             : discountPct >= 25 ? "strong_deal"
             : "mild_deal";

  return {
    found:           true,
    type:            "buy_opportunity",
    scannedPrice:    scanned,
    medianMarket:    round2(medianMarket),
    discountDollars: discount,
    discountPct,
    tier,
    signal: `${discountPct.toFixed(0)}% below market median ($${round2(medianMarket).toFixed(2)}) — ${
      tier === "screaming_deal" ? "BUY NOW" :
      tier === "strong_deal"    ? "strong buy" :
      "worth buying"
    }`,
  };
}

/**
 * Detect supply/demand momentum from price distribution shape.
 * Wide spread + many cheap listings = market is dropping.
 */
export function detectMarketMomentum(uiItems = []) {
  if (!Array.isArray(uiItems) || uiItems.length < 3) return null;

  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (prices.length < 3) return null;

  const low  = prices[0];
  const high = prices[prices.length - 1];
  const p25  = prices[Math.floor(prices.length * 0.25)];
  const p75  = prices[Math.floor(prices.length * 0.75)];

  const spread = round2(((high - low) / low) * 100);
  const iqr    = p75 - p25;

  const mean       = prices.reduce((s, v) => s + v, 0) / prices.length;
  const median     = prices[Math.floor(prices.length / 2)];
  const skew       = round2((mean - median) / (iqr || 1));

  const cheapCount     = prices.filter(p => p < median * 0.85).length;
  const expensiveCount = prices.filter(p => p > median * 1.15).length;
  const supplyPressure = cheapCount > expensiveCount * 1.5;

  const momentum = (skew < -0.3 || supplyPressure) ? "dropping"
                 : skew > 0.5                        ? "rising"
                 : spread > 80                       ? "volatile"
                 : "stable";

  return {
    listingCount:      uiItems.length,
    priceRange:        { low: round2(low), high: round2(high), p25: round2(p25), p75: round2(p75) },
    iqr:               round2(iqr),
    spreadPct:         spread,
    skew,
    supplyPressure,
    cheapListings:     cheapCount,
    expensiveListings: expensiveCount,
    momentum,
    signal: momentum === "dropping" ? "Prices trending down — consider waiting before buying"
          : momentum === "rising"   ? "Prices trending up — buy now before market rises further"
          : momentum === "volatile" ? "Market is volatile — prices vary wildly, compare carefully"
          : "Stable liquid market — safe to buy or sell now",
  };
}

/**
 * Master arbitrage intelligence payload — attached to every market search response.
 */
export function buildArbitrageIntelPayload({
  uiItems      = [],
  scannedPrice = null,
  category     = "",
  consensus    = null,
} = {}) {
  const platformArbitrage = detectPlatformArbitrage(uiItems, category, scannedPrice);
  const buyOpportunity    = detectBuyOpportunity(scannedPrice, uiItems, consensus);
  const momentum          = detectMarketMomentum(uiItems);

  const hasArbitrage = !!(platformArbitrage?.found || buyOpportunity?.found);

  const signals = [];
  if (platformArbitrage?.found) signals.push(platformArbitrage.signal);
  if (buyOpportunity?.found)    signals.push(buyOpportunity.signal);
  if (momentum?.signal)         signals.push(momentum.signal);

  return {
    hasArbitrage,
    signals,
    platformArbitrage: platformArbitrage || null,
    buyOpportunity:    buyOpportunity    || null,
    momentum:          momentum          || null,
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
