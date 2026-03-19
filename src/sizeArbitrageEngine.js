// src/sizeArbitrageEngine.js
// Size-specific price arbitrage: detects the same item at dramatically different
// prices across sizes, and surfaces buy-low/sell-high size opportunities.

// ── Size demand premium maps ───────────────────────────────────────────────────
// Multiplier vs. size-run average price for each model family.
// >1.0 = premium size, <1.0 = discount size
const SIZE_DEMAND_CURVES = {
  "jordan 1": {
    "4": 0.78, "4.5": 0.80, "5": 0.84, "5.5": 0.86,
    "6": 0.90, "6.5": 0.93, "7": 0.96, "7.5": 0.98,
    "8": 1.04, "8.5": 1.08, "9": 1.14, "9.5": 1.12,
    "10": 1.18, "10.5": 1.15, "11": 1.10, "11.5": 1.06,
    "12": 1.02, "13": 0.96, "14": 0.85, "15": 0.80,
  },
  "jordan 4": {
    "7": 0.95, "7.5": 0.97, "8": 1.03, "8.5": 1.07,
    "9": 1.12, "9.5": 1.10, "10": 1.15, "10.5": 1.12,
    "11": 1.08, "11.5": 1.05, "12": 1.00, "13": 0.93,
  },
  "nike dunk": {
    "5": 0.88, "5.5": 0.90, "6": 0.93, "6.5": 0.95,
    "7": 0.97, "7.5": 0.99, "8": 1.05, "8.5": 1.08,
    "9": 1.12, "9.5": 1.10, "10": 1.14, "10.5": 1.11,
    "11": 1.07, "11.5": 1.03, "12": 0.98, "13": 0.90,
  },
  "adidas yeezy 350": {
    "4": 0.82, "5": 0.86, "6": 0.91, "7": 0.97,
    "8": 1.04, "8.5": 1.08, "9": 1.12, "9.5": 1.10,
    "10": 1.14, "10.5": 1.11, "11": 1.07, "12": 1.01,
    "13": 0.93, "14": 0.85,
  },
  "new balance 990": {
    "7": 0.97, "8": 1.02, "8.5": 1.05, "9": 1.09,
    "9.5": 1.07, "10": 1.11, "10.5": 1.08, "11": 1.04,
    "12": 0.99, "13": 0.92,
  },
  "default": {
    "5": 0.88, "6": 0.92, "7": 0.96, "7.5": 0.98,
    "8": 1.03, "8.5": 1.06, "9": 1.10, "9.5": 1.08,
    "10": 1.12, "10.5": 1.09, "11": 1.05, "12": 1.00,
    "13": 0.93, "14": 0.86,
  },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve the size demand curve for a given item identity.
 */
function resolveSizeCurve(identity = {}) {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const key   = `${brand} ${model}`.trim();

  for (const [curveKey, curve] of Object.entries(SIZE_DEMAND_CURVES)) {
    if (curveKey === "default") continue;
    if (key.includes(curveKey) || curveKey.split(" ").every(t => t.length >= 3 && key.includes(t))) {
      return { curveKey, curve };
    }
  }
  return { curveKey: "default", curve: SIZE_DEMAND_CURVES.default };
}

/**
 * Score a specific size's demand premium vs. run average.
 */
export function scoreSizeDemand(identity = {}, size = "") {
  const sizeStr         = String(size).replace(/[^0-9.]/g, "");
  const { curveKey, curve } = resolveSizeCurve(identity);
  const multiplier      = curve[sizeStr] ?? 1.00;

  const tier = multiplier >= 1.10 ? "premium"
             : multiplier >= 1.04 ? "above_avg"
             : multiplier >= 0.96 ? "average"
             : multiplier >= 0.90 ? "below_avg"
             : "discount";

  return {
    size:       sizeStr,
    multiplier: round2(multiplier),
    tier,
    model:      curveKey,
    signal:     tier === "premium"
      ? `Size ${sizeStr} is in premium demand — commands ${((multiplier - 1) * 100).toFixed(0)}% above average for this model`
      : tier === "discount"
      ? `Size ${sizeStr} is a discount size — expect ${((1 - multiplier) * 100).toFixed(0)}% below average price, harder to sell`
      : null,
  };
}

/**
 * Group market items by size and compute median price per size.
 */
function groupBySize(uiItems = []) {
  const groups = {};
  for (const item of uiItems) {
    const rawSize = String(item?.size || item?.title || "").match(/\b([0-9]{1,2}(?:\.[05])?)\b/)?.[1];
    if (!rawSize) continue;
    const price = finiteOrNull(item?.totalPrice ?? item?.price);
    if (!price) continue;
    if (!groups[rawSize]) groups[rawSize] = [];
    groups[rawSize].push({ price, item });
  }
  return groups;
}

/**
 * Detect size arbitrage: find sizes where the price gap creates a flip opportunity.
 * Buy a discount size cheap, sell to the right buyer at the correct market rate.
 */
export function detectSizeArbitrage(identity = {}, uiItems = []) {
  const sizeGroups = groupBySize(uiItems);
  const sizeKeys   = Object.keys(sizeGroups);
  if (sizeKeys.length < 2) return null;

  const { curve } = resolveSizeCurve(identity);

  // Compute median price per size
  const sizeMedians = {};
  for (const [sz, entries] of Object.entries(sizeGroups)) {
    const prices = entries.map(e => e.price).sort((a, b) => a - b);
    sizeMedians[sz] = round2(prices[Math.floor(prices.length / 2)]);
  }

  // Find cheapest and most expensive sizes
  const sorted = Object.entries(sizeMedians).sort(([, a], [, b]) => a - b);
  if (sorted.length < 2) return null;

  const [cheapSize,     cheapPrice]     = sorted[0];
  const [expensiveSize, expensivePrice] = sorted[sorted.length - 1];

  const gapDollars = round2(expensivePrice - cheapPrice);
  const gapPct     = round2(((expensivePrice - cheapPrice) / cheapPrice) * 100);
  if (gapPct < 15) return null;

  // Validate with demand curve: is the cheap size actually undervalued?
  const cheapMult     = curve[cheapSize]     ?? 1.0;
  const expensiveMult = curve[expensiveSize] ?? 1.0;
  const isGenuineGap  = cheapMult < expensiveMult; // demand curve confirms it

  return {
    detected:      true,
    cheapSize,
    cheapPrice,
    expensiveSize,
    expensivePrice,
    gapDollars,
    gapPct,
    isGenuineGap,
    allSizeMedians: sizeMedians,
    signal: isGenuineGap
      ? `Size ${cheapSize} is ${gapPct.toFixed(0)}% cheaper ($${cheapPrice.toFixed(2)}) than size ${expensiveSize} ($${expensivePrice.toFixed(2)}) — buy sz${cheapSize} and target the right buyer for $${gapDollars.toFixed(2)} upside`
      : `Price gap between sz${cheapSize} ($${cheapPrice.toFixed(2)}) and sz${expensiveSize} ($${expensivePrice.toFixed(2)}) — verify demand before buying discount size`,
  };
}

/**
 * Master size arbitrage payload.
 */
export function buildSizeArbitragePayload({
  identity = {},
  uiItems  = [],
  size     = "",
} = {}) {
  const scannedSizeDemand = size ? scoreSizeDemand(identity, size) : null;
  const arbitrage         = detectSizeArbitrage(identity, uiItems);

  return {
    scannedSize:    size || null,
    sizeDemand:     scannedSizeDemand  || null,
    sizeArbitrage:  arbitrage          || null,
    topSignal:      arbitrage?.signal  || scannedSizeDemand?.signal || null,
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
