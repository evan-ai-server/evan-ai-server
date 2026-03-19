function finite(n) {
  return Number.isFinite(Number(n)) ? Number(n) : null;
}

export function buildDealHunterPayload(query, items = [], opts = {}) {
  const scannedPrice = finite(opts?.scannedPrice);
  const marketAvg = finite(opts?.marketAvg);
  const marketHeat = finite(opts?.marketHeat) ?? 0;

  const ranked = (Array.isArray(items) ? items : [])
    .filter((it) => finite(it?.totalPrice ?? it?.price) !== null)
    .map((it) => {
      const total = finite(it?.totalPrice ?? it?.price);
      const historicalAvg = finite(opts?.historicalAvg);
      const baseline =
        marketAvg ?? historicalAvg ?? scannedPrice ?? total;

      const expectedProfit =
        Number.isFinite(baseline) && Number.isFinite(total)
          ? Math.max(0, baseline - total)
          : 0;

      const confidence = Math.max(
        Number(it?.dealScore || 0),
        Number(it?.flipScore || 0),
        Number(it?.trustModelScore || 0) * 0.7
      );

      return {
        title: it?.title || null,
        source: it?.source || null,
        url: it?.url || it?.buyLink || it?.link || null,
        totalPrice: total,
        expectedProfit,
        confidence,
      };
    })
    .sort((a, b) => {
      if (b.expectedProfit !== a.expectedProfit) {
        return b.expectedProfit - a.expectedProfit;
      }
      return b.confidence - a.confidence;
    });

  const top = ranked[0] || null;

  return {
    query: query || null,
    marketHeat,
    totalCandidates: ranked.length,
    bestDeal: top,
    buySignal:
      top && top.expectedProfit >= 25 && top.confidence >= 0.62
        ? "STRONG"
        : top && top.expectedProfit >= 10
        ? "WATCH"
        : "WEAK",
    opportunities: ranked.slice(0, 5),
  };
}
