function finite(n) {
  return Number.isFinite(Number(n)) ? Number(n) : null;
}

export function buildSellSideEstimate(query, items = [], opts = {}) {
  const prices = (Array.isArray(items) ? items : [])
    .map((x) => finite(x?.totalPrice ?? x?.price))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!prices.length) {
    return {
      query: query || null,
      estimatedSellPrice: null,
      suggestedListPrice: null,
      quickSalePrice: null,
      bestMarketplace: null,
      expectedSellWindowDays: null,
      confidence: 0,
    };
  }

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const p25 = prices[Math.max(0, Math.floor(prices.length * 0.25) - 1)] ?? prices[0];
  const p75 = prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.75))] ?? prices[prices.length - 1];

  const sourceCounts = new Map();
  for (const it of items) {
    const src = String(it?.source || "").trim();
    if (!src) continue;
    sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
  }

  const bestMarketplace =
    [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const marketHeat = Number(opts?.marketHeat || 0);
  const expectedSellWindowDays =
    marketHeat >= 0.8 ? 3 :
    marketHeat >= 0.5 ? 5 :
    marketHeat >= 0.25 ? 8 :
    12;

  const confidence =
    Math.max(
      0.35,
      Math.min(1, 0.45 + prices.length * 0.03 + marketHeat * 0.2)
    );

  return {
    query: query || null,
    estimatedSellPrice: Math.round(avg * 100) / 100,
    suggestedListPrice: Math.round(p75 * 100) / 100,
    quickSalePrice: Math.round(p25 * 100) / 100,
    bestMarketplace,
    expectedSellWindowDays,
    confidence,
  };
}
