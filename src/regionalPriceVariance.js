// src/regionalPriceVariance.js
// Feature 76 — Regional Price Variance
// Compares US vs UK vs EU vs JP prices for the same item.
// Detects arbitrage opportunities (Nike Japan exclusives, EU Gucci, etc.)
// Uses SERP API with regional parameters (gl, hl, location).

import https from "https";

// ── Region definitions ────────────────────────────────────────────────────────
const REGIONS = {
  us: { gl: "us", hl: "en", currency: "USD", symbol: "$",   label: "United States" },
  uk: { gl: "gb", hl: "en", currency: "GBP", symbol: "£",   label: "United Kingdom" },
  eu: { gl: "de", hl: "de", currency: "EUR", symbol: "€",   label: "Europe (DE)" },
  jp: { gl: "jp", hl: "ja", currency: "JPY", symbol: "¥",   label: "Japan" },
  ca: { gl: "ca", hl: "en", currency: "CAD", symbol: "C$",  label: "Canada" },
  au: { gl: "au", hl: "en", currency: "AUD", symbol: "A$",  label: "Australia" },
};

// Exchange rates to USD (approximate, updated periodically — no live feed needed here)
// These are directional proxies, not live FX
const TO_USD_RATES = {
  USD: 1.00,
  GBP: 1.27,
  EUR: 1.09,
  JPY: 0.0067,
  CAD: 0.74,
  AUD: 0.65,
};

// ── SERP helper ───────────────────────────────────────────────────────────────
function serpRegionalSearch(query, region, serpKey) {
  const cfg = REGIONS[region];
  if (!cfg || !serpKey) return Promise.resolve(null);

  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const url = `https://serpapi.com/search.json?q=${encoded}&gl=${cfg.gl}&hl=${cfg.hl}&num=10&engine=google&api_key=${serpKey}`;
    const timer = setTimeout(() => resolve(null), 6000);
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

// ── Price extraction ──────────────────────────────────────────────────────────
const PRICE_PATTERNS = {
  USD: /\$\s*([\d,]+\.?\d{0,2})/g,
  GBP: /£\s*([\d,]+\.?\d{0,2})/g,
  EUR: /€\s*([\d,]+\.?\d{0,2})/g,
  JPY: /[¥￥]\s*([\d,]+)/g,
  CAD: /C\$\s*([\d,]+\.?\d{0,2})/g,
  AUD: /A\$\s*([\d,]+\.?\d{0,2})/g,
};

function extractPrices(text, currency) {
  const pattern = PRICE_PATTERNS[currency];
  if (!pattern) return [];
  const prices = [];
  let m;
  pattern.lastIndex = 0;
  while ((m = pattern.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(val) && val > 1) prices.push(val);
  }
  return prices;
}

function extractFromSerpResults(results = [], currency) {
  const prices = [];
  for (const r of results) {
    const text = [r?.title, r?.snippet, r?.price].filter(Boolean).join(" ");
    prices.push(...extractPrices(text, currency));
  }
  return prices;
}

function medianOf(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function avgOf(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function round2(v) { return Math.round(v * 100) / 100; }

// ── Per-region fetcher ────────────────────────────────────────────────────────

async function fetchRegionPrice(query, regionKey, serpKey) {
  const cfg = REGIONS[regionKey];
  if (!cfg) return null;

  const data = await serpRegionalSearch(`${query} price`, regionKey, serpKey);
  if (!data?.organic_results?.length) return null;

  const localPrices = extractFromSerpResults(data.organic_results, cfg.currency);
  if (!localPrices.length) return null;

  // Filter outliers: keep within 3x median
  const med = medianOf(localPrices);
  const filtered = localPrices.filter(p => p >= med * 0.3 && p <= med * 3);
  if (!filtered.length) return null;

  const localMedian = round2(medianOf(filtered));
  const usdRate = TO_USD_RATES[cfg.currency] ?? 1;
  const usdEquivalent = round2(localMedian * usdRate);

  return {
    region:        regionKey,
    label:         cfg.label,
    currency:      cfg.currency,
    symbol:        cfg.symbol,
    localMedian,
    usdEquivalent,
    sampleCount:   filtered.length,
    exchangeRate:  usdRate,
  };
}

// ── Arbitrage detector ────────────────────────────────────────────────────────

function detectArbitrage(regionResults) {
  const withData = regionResults.filter(r => r?.usdEquivalent);
  if (withData.length < 2) return null;

  const sorted = [...withData].sort((a, b) => a.usdEquivalent - b.usdEquivalent);
  const cheapest = sorted[0];
  const mostExpensive = sorted[sorted.length - 1];

  const spreadUsd = round2(mostExpensive.usdEquivalent - cheapest.usdEquivalent);
  const spreadPct = round2((spreadUsd / cheapest.usdEquivalent) * 100);

  // Flag as arbitrage opportunity if spread > 20%
  const isOpportunity = spreadPct >= 20;

  return {
    cheapestRegion:    cheapest.region,
    cheapestLabel:     cheapest.label,
    cheapestUsd:       cheapest.usdEquivalent,
    cheapestLocal:     `${cheapest.symbol}${cheapest.localMedian}`,
    mostExpensiveRegion: mostExpensive.region,
    mostExpensiveUsd:  mostExpensive.usdEquivalent,
    spreadUsd,
    spreadPct,
    isOpportunity,
    signal: isOpportunity
      ? `Arbitrage: ${cheapest.label} (${cheapest.symbol}${cheapest.localMedian} ≈ $${cheapest.usdEquivalent}) vs ${mostExpensive.label} ($${mostExpensive.usdEquivalent}). Spread: $${spreadUsd} (${spreadPct}%)`
      : null,
  };
}

// ── Category-aware region selection ──────────────────────────────────────────
function regionsForCategory(category) {
  const cat = String(category || "").toLowerCase();
  // Always check US + UK + EU
  const regions = new Set(["us", "uk", "eu"]);

  if (/sneak|nike|jordan|adidas|yeezy/i.test(cat)) {
    regions.add("jp"); // Nike Japan exclusives, JP sneaker market
  }
  if (/watch|rolex|omega|seiko/i.test(cat)) {
    regions.add("jp"); // Japanese watch market
    regions.add("au");
  }
  if (/gucci|lv|louis|prada|chanel|hermes/i.test(cat)) {
    regions.add("jp"); // Japanese luxury resale market
  }

  return [...regions];
}

// ── Core aggregator ───────────────────────────────────────────────────────────

export async function fetchRegionalPrices({ query, serpKey, category = null, regions = null } = {}) {
  if (!query || !serpKey) return buildEmptyResult();

  const targetRegions = regions || regionsForCategory(category);

  const results = await Promise.all(
    targetRegions.map(r => fetchRegionPrice(query, r, serpKey))
  );

  const available = results.filter(Boolean);
  if (!available.length) return buildEmptyResult();

  const arbitrage = detectArbitrage(available);

  // USD price index (all normalized to USD for comparison)
  const usdPrices = available.map(r => r.usdEquivalent).filter(Boolean);
  const globalMedianUsd = usdPrices.length ? round2(medianOf(usdPrices)) : null;

  return {
    regions:         available,
    globalMedianUsd,
    arbitrage,
    regionsQueried:  targetRegions,
    topSignal:       buildTopSignal(available, arbitrage, globalMedianUsd),
  };
}

function buildEmptyResult() {
  return { regions: [], globalMedianUsd: null, arbitrage: null, regionsQueried: [], topSignal: null };
}

function buildTopSignal(regions, arbitrage, globalMedian) {
  if (arbitrage?.isOpportunity) return arbitrage.signal;
  if (!regions.length) return null;

  const parts = regions
    .filter(r => r.usdEquivalent)
    .map(r => `${r.label}: ${r.symbol}${r.localMedian}`);

  if (globalMedian) parts.unshift(`Global median: $${globalMedian}`);
  return parts.slice(0, 4).join(" · ");
}

// ── Master payload builder ─────────────────────────────────────────────────────

export async function buildRegionalPricePayload({ query, serpKey, category = null, regions = null } = {}) {
  try {
    const result = await fetchRegionalPrices({ query, serpKey, category, regions });
    return { regionalPrices: result, topSignal: result?.topSignal || null };
  } catch {
    return { regionalPrices: null, topSignal: null };
  }
}
