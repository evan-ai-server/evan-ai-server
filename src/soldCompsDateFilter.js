// src/soldCompsDateFilter.js
// Feature 70 — Sold Comps Date Filter
// Buckets sold comps into 7 / 30 / 60 / 90 day windows.
// Computes avg/median/count/trend per window.
// "Last 7 days: $240 avg (6 sales). Last 90 days: $195 avg. Trend: RISING +23%"
// This is more valuable than any single price point — it tells you WHERE the
// market is heading, not just where it was.

// ── Date helpers ──────────────────────────────────────────────────────────────
const MS_DAY   = 1000 * 60 * 60 * 24;
const WINDOWS  = [7, 30, 60, 90];

function daysAgo(n) { return Date.now() - n * MS_DAY; }

/**
 * Extract a timestamp from an item using any available date field.
 * Returns null if no reliable date is found.
 */
function extractTimestamp(item) {
  const candidates = [
    item?.soldAt, item?.sold_at, item?.soldDate,
    item?.dateSold, item?.listedAt, item?.createdAt,
    item?.updated_at, item?.timestamp, item?.date,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const ts = typeof c === "number" ? c : Date.parse(String(c));
    if (Number.isFinite(ts) && ts > 0) return ts;
  }
  return null;
}

function itemPrice(item) {
  const p = item?.totalPrice ?? item?.price ?? item?.salePrice;
  return Number.isFinite(Number(p)) && Number(p) > 0 ? Number(p) : null;
}

// ── Statistical helpers ───────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function percentile(arr, pct) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * pct) - 1);
  return sorted[idx];
}

// ── Trend detection ───────────────────────────────────────────────────────────
function detectTrend(d7, d30, d90) {
  // Need at least two windows with data
  const recent  = d7?.median ?? d7?.avg ?? null;
  const mid     = d30?.median ?? d30?.avg ?? null;
  const old     = d90?.median ?? d90?.avg ?? null;

  if (!recent || (!mid && !old)) return { trend: "insufficient_data", pct: null };

  const baseline = old ?? mid;
  const pct      = ((recent - baseline) / baseline) * 100;

  let trend;
  if (pct > 10)       trend = "surging";
  else if (pct > 4)   trend = "rising";
  else if (pct > -4)  trend = "stable";
  else if (pct > -10) trend = "softening";
  else                trend = "falling";

  return { trend, pct: round2(pct), recent, baseline };
}

// ── Core bucketing engine ─────────────────────────────────────────────────────

/**
 * Bucket sold items into date windows and compute stats per window.
 */
export function filterSoldCompsByDate(soldItems = []) {
  if (!Array.isArray(soldItems) || !soldItems.length) {
    return buildEmptyResult();
  }

  const now = Date.now();
  const buckets = {};

  for (const window of WINDOWS) {
    const cutoff = now - window * MS_DAY;
    const inWindow = soldItems
      .map(item => {
        const ts = extractTimestamp(item);
        const price = itemPrice(item);
        if (!price) return null;
        // If no timestamp, assume recent (last 30 days) — degrade to d30 window
        if (!ts) return window === 30 ? { price, ts: null } : null;
        return ts >= cutoff ? { price, ts } : null;
      })
      .filter(Boolean);

    const prices = inWindow.map(i => i.price);
    buckets[`d${window}`] = buildWindowStats(prices, window);
  }

  // Items with no date at all — put them in "undated" bucket
  const undatedPrices = soldItems
    .filter(item => !extractTimestamp(item))
    .map(item => itemPrice(item))
    .filter(Boolean);

  const trendData = detectTrend(buckets.d7, buckets.d30, buckets.d90);

  // Velocity: sales per week
  const d30Count    = buckets.d30?.count ?? 0;
  const salesPerWeek = d30Count > 0 ? round2(d30Count / 4.3) : 0;

  // Best window to trust (most sales + recent)
  const bestWindow  = pickBestWindow(buckets);

  // Price direction signal
  const directionSignal = buildDirectionSignal(trendData, buckets);

  return {
    d7:            buckets.d7,
    d30:           buckets.d30,
    d60:           buckets.d60,
    d90:           buckets.d90,
    undatedCount:  undatedPrices.length,
    trend:         trendData,
    salesPerWeek,
    bestWindow,
    directionSignal,
    topSignal:     buildTopSignal(buckets, trendData, salesPerWeek),
  };
}

function buildWindowStats(prices, windowDays) {
  if (!prices.length) return { count: 0, avg: null, median: null, low: null, high: null, p25: null, p75: null, windowDays };
  return {
    count:      prices.length,
    avg:        round2(avg(prices)),
    median:     round2(median(prices)),
    low:        round2(Math.min(...prices)),
    high:       round2(Math.max(...prices)),
    p25:        round2(percentile(prices, 0.25)),
    p75:        round2(percentile(prices, 0.75)),
    windowDays,
  };
}

function buildEmptyResult() {
  const empty = { count: 0, avg: null, median: null, low: null, high: null, p25: null, p75: null };
  return {
    d7: { ...empty, windowDays: 7 }, d30: { ...empty, windowDays: 30 },
    d60: { ...empty, windowDays: 60 }, d90: { ...empty, windowDays: 90 },
    undatedCount: 0, trend: { trend: "no_data", pct: null },
    salesPerWeek: 0, bestWindow: null, directionSignal: null, topSignal: null,
  };
}

function pickBestWindow(buckets) {
  // Most recent window with at least 3 sales
  for (const w of ["d7", "d30", "d60", "d90"]) {
    if ((buckets[w]?.count ?? 0) >= 3) return w;
  }
  // Fallback: any window with any sales
  for (const w of ["d7", "d30", "d60", "d90"]) {
    if ((buckets[w]?.count ?? 0) > 0) return w;
  }
  return null;
}

function buildDirectionSignal(trendData, buckets) {
  if (trendData.trend === "insufficient_data" || trendData.trend === "no_data") return null;
  const pct = trendData.pct;
  if (!pct) return null;

  const icons = { surging: "🚀", rising: "📈", stable: "➡️", softening: "📉", falling: "⬇️" };
  return `${icons[trendData.trend] || ""} ${trendData.trend.toUpperCase()} (${pct > 0 ? "+" : ""}${pct.toFixed(1)}% vs 90-day avg)`;
}

function buildTopSignal(buckets, trendData, salesPerWeek) {
  const parts = [];
  if (buckets.d7?.count >= 2 && buckets.d7?.median) {
    parts.push(`Last 7 days: $${buckets.d7.median} avg (${buckets.d7.count} sales)`);
  }
  if (buckets.d30?.count >= 3 && buckets.d30?.median) {
    parts.push(`30 days: $${buckets.d30.median}`);
  }
  if (trendData.trend && trendData.trend !== "insufficient_data" && trendData.pct != null) {
    parts.push(`Trend: ${trendData.trend} (${trendData.pct > 0 ? "+" : ""}${trendData.pct.toFixed(1)}%)`);
  }
  if (salesPerWeek > 0) parts.push(`~${salesPerWeek}/week`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Apply date filtering to a full set of market items (mixed sold + active).
 */
export function buildSoldCompsAnalysis(allItems = []) {
  const soldItems = allItems.filter(i =>
    i?.sold === true || String(i?.status || "").toLowerCase() === "sold" || i?.source === "ebay_sold"
  );
  return filterSoldCompsByDate(soldItems);
}

/**
 * Master payload builder.
 */
export function buildSoldCompsDateFilterPayload(allItems = []) {
  const result = buildSoldCompsAnalysis(allItems);
  return {
    soldCompsAnalysis: result,
    topSignal: result.topSignal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
