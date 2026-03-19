// src/premiumPriceSources.js
// Feature 71 — Premium Price Sources (StockX / GOAT / Poshmark / Depop)
// Feature 72 — Alt Platform Comps (Poshmark / Depop)
// Uses SERP API to pull real-time prices from StockX, GOAT, Poshmark, and Depop.
// These are the ground-truth price sources for sneakers, streetwear, and apparel.
// "StockX: $340 ask. GOAT: $318 ask. Poshmark last sold: $295."
// Falls back gracefully when unavailable.

import https from "https";

// ── SERP API helper ───────────────────────────────────────────────────────────
function serpSearch(query, serpKey, opts = {}) {
  return new Promise((resolve) => {
    if (!serpKey) { resolve(null); return; }
    const site      = opts.site ? `+site:${opts.site}` : "";
    const country   = opts.gl || "us";
    const encoded   = encodeURIComponent(`${query}${site}`);
    const url       = `https://serpapi.com/search.json?q=${encoded}&gl=${country}&hl=en&num=10&engine=google&api_key=${serpKey}`;
    const timer     = setTimeout(() => resolve(null), 5000);
    https.get(url, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

// ── Price extraction from SERP results ────────────────────────────────────────
const PRICE_REGEX = /\$\s*([\d,]+\.?\d{0,2})/g;

function extractPricesFromSnippets(organicResults = []) {
  const prices = [];
  for (const result of organicResults) {
    const text = [result?.title, result?.snippet, result?.price].filter(Boolean).join(" ");
    let m;
    PRICE_REGEX.lastIndex = 0;
    while ((m = PRICE_REGEX.exec(text)) !== null) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (Number.isFinite(val) && val > 10 && val < 50000) {
        prices.push({ price: val, source: result?.link || "", title: result?.title || "" });
      }
    }
  }
  return prices;
}

function medianOf(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avgOf(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function round2(v) { return Math.round(v * 100) / 100; }

// ── Per-platform fetchers ─────────────────────────────────────────────────────

async function fetchStockXPrices(query, serpKey) {
  const data = await serpSearch(`${query} buy now`, serpKey, { site: "stockx.com" });
  if (!data?.organic_results?.length) return null;

  const priceEntries = extractPricesFromSnippets(data.organic_results);
  const prices       = priceEntries.map(e => e.price);
  if (!prices.length) return null;

  // StockX: filter to reasonable range (remove outliers)
  const med = medianOf(prices);
  const filtered = prices.filter(p => p >= med * 0.4 && p <= med * 3);

  return {
    platform:   "StockX",
    avgAsk:     round2(avgOf(filtered)),
    lowestAsk:  round2(Math.min(...filtered)),
    median:     round2(medianOf(filtered)),
    sampleCount: filtered.length,
    note:       "StockX ask prices via SERP",
  };
}

async function fetchGOATPrices(query, serpKey) {
  const data = await serpSearch(`${query} for sale`, serpKey, { site: "goat.com" });
  if (!data?.organic_results?.length) return null;

  const priceEntries = extractPricesFromSnippets(data.organic_results);
  const prices       = priceEntries.map(e => e.price);
  if (!prices.length) return null;

  const med = medianOf(prices);
  const filtered = prices.filter(p => p >= med * 0.4 && p <= med * 3);

  return {
    platform:   "GOAT",
    avgAsk:     round2(avgOf(filtered)),
    lowestAsk:  round2(Math.min(...filtered)),
    median:     round2(medianOf(filtered)),
    sampleCount: filtered.length,
    note:       "GOAT ask prices via SERP",
  };
}

async function fetchPoshmarkSoldComps(query, serpKey) {
  const data = await serpSearch(`${query} sold`, serpKey, { site: "poshmark.com" });
  if (!data?.organic_results?.length) return null;

  const priceEntries = extractPricesFromSnippets(data.organic_results);
  const prices       = priceEntries.map(e => e.price);
  if (!prices.length) return null;

  const med = medianOf(prices);
  const filtered = prices.filter(p => p >= med * 0.4 && p <= med * 3);

  return {
    platform:    "Poshmark",
    avgSoldPrice: round2(avgOf(filtered)),
    medianSold:  round2(medianOf(filtered)),
    lowestSold:  round2(Math.min(...filtered)),
    sampleCount: filtered.length,
    note:        "Poshmark listing prices via SERP",
  };
}

async function fetchDepopSoldComps(query, serpKey) {
  const data = await serpSearch(`${query}`, serpKey, { site: "depop.com" });
  if (!data?.organic_results?.length) return null;

  const priceEntries = extractPricesFromSnippets(data.organic_results);
  const prices       = priceEntries.map(e => e.price);
  if (!prices.length) return null;

  const med = medianOf(prices);
  const filtered = prices.filter(p => p >= med * 0.4 && p <= med * 3);

  return {
    platform:    "Depop",
    avgPrice:    round2(avgOf(filtered)),
    medianPrice: round2(medianOf(filtered)),
    lowestPrice: round2(Math.min(...filtered)),
    sampleCount: filtered.length,
    note:        "Depop listing prices via SERP",
  };
}

// ── Platform relevance by category ───────────────────────────────────────────
function platformsForCategory(category) {
  const cat = String(category || "").toLowerCase();
  const platforms = new Set(["poshmark", "depop"]);

  if (/sneak|shoe|jordan|nike|adidas|yeezy|dunk|force/i.test(cat)) {
    platforms.add("stockx");
    platforms.add("goat");
  }
  if (/street|supreme|hoodie|tee|apparel|cloth/i.test(cat)) {
    platforms.add("stockx");
  }
  if (/bag|purse|handbag|tote|clutch|wallet/i.test(cat)) {
    // bags more on Poshmark than StockX
  }

  return [...platforms];
}

// ── Core aggregator ───────────────────────────────────────────────────────────

/**
 * Fetch prices from premium platforms in parallel.
 */
export async function fetchPremiumPrices({ query, serpKey, category = null } = {}) {
  if (!query || !serpKey) return buildEmptyResult();

  const platforms = platformsForCategory(category);

  // Run relevant fetchers in parallel
  const [stockx, goat, poshmark, depop] = await Promise.all([
    platforms.includes("stockx") ? fetchStockXPrices(query, serpKey)       : Promise.resolve(null),
    platforms.includes("goat")   ? fetchGOATPrices(query, serpKey)          : Promise.resolve(null),
    platforms.includes("poshmark")? fetchPoshmarkSoldComps(query, serpKey)  : Promise.resolve(null),
    platforms.includes("depop")  ? fetchDepopSoldComps(query, serpKey)      : Promise.resolve(null),
  ]);

  const available = [stockx, goat, poshmark, depop].filter(Boolean);
  if (!available.length) return buildEmptyResult();

  // Cross-platform median price
  const allMedians   = available.map(p => p.median ?? p.medianSold ?? p.medianPrice).filter(Boolean);
  const crossMedian  = allMedians.length ? round2(medianOf(allMedians)) : null;

  // Platform spread (indicator of arbitrage opportunity)
  const allLows      = available.map(p => p.lowestAsk ?? p.lowestSold ?? p.lowestPrice).filter(Boolean);
  const allHighs     = available.map(p => p.avgAsk ?? p.avgSoldPrice ?? p.avgPrice).filter(Boolean);
  const platformSpread = allLows.length && allHighs.length
    ? round2(Math.max(...allHighs) - Math.min(...allLows))
    : null;

  // Best platform to sell (highest average price)
  const platformsWithAvg = available.map(p => ({
    name: p.platform,
    avg:  p.avgAsk ?? p.avgSoldPrice ?? p.avgPrice ?? 0,
  })).sort((a, b) => b.avg - a.avg);

  const bestSellPlatform = platformsWithAvg[0]?.name || null;

  return {
    stockx:        stockx   || null,
    goat:          goat     || null,
    poshmark:      poshmark || null,
    depop:         depop    || null,
    crossMedian,
    platformSpread,
    bestSellPlatform,
    platformsQueried: platforms,
    topSignal:     buildTopSignal(stockx, goat, poshmark, depop, crossMedian, bestSellPlatform),
  };
}

function buildEmptyResult() {
  return { stockx: null, goat: null, poshmark: null, depop: null, crossMedian: null, platformSpread: null, bestSellPlatform: null, topSignal: null };
}

function buildTopSignal(sx, goat, pm, depop, crossMedian, bestPlatform) {
  const parts = [];
  if (sx?.lowestAsk)    parts.push(`StockX ask: $${sx.lowestAsk}`);
  if (goat?.lowestAsk)  parts.push(`GOAT ask: $${goat.lowestAsk}`);
  if (pm?.medianSold)   parts.push(`Poshmark: ~$${pm.medianSold}`);
  if (depop?.medianPrice) parts.push(`Depop: ~$${depop.medianPrice}`);
  if (bestPlatform)     parts.push(`Best to sell: ${bestPlatform}`);
  if (crossMedian)      parts.push(`Cross-platform median: $${crossMedian}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Master payload builder.
 */
export async function buildPremiumPriceSourcesPayload({ query, serpKey, category } = {}) {
  try {
    const result = await fetchPremiumPrices({ query, serpKey, category });
    return { premiumPrices: result, topSignal: result?.topSignal || null };
  } catch {
    return { premiumPrices: null, topSignal: null };
  }
}
