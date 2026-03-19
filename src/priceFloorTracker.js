// src/priceFloorTracker.js
// Feature 73 — Price Floor Tracker
// Tracks the historical minimum sold price per item/query over a 90-day window.
// Redis-backed. "Never seen this item sell under $X in 90 days."
// Protects users from listing too low and identifies underpriced listings.

const FLOOR_TTL_SEC = 90 * 24 * 60 * 60; // 90 days
const FLOOR_KEY_PREFIX = "pfloor:";
const FLOOR_HISTORY_LIMIT = 200; // max price points stored per item

// ── Key builder ───────────────────────────────────────────────────────────────
function floorKey(queryOrSku) {
  const normalized = String(queryOrSku || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\-]/g, "")
    .slice(0, 80);
  return `${FLOOR_KEY_PREFIX}${normalized}`;
}

// ── Statistical helpers ───────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }

function computeFloorStats(prices) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const len = sorted.length;
  const mid = Math.floor(len / 2);
  const median = len % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const avg = prices.reduce((a, b) => a + b, 0) / len;
  // p10 = true floor (bottom 10th percentile of sold prices)
  const p10idx = Math.max(0, Math.floor(len * 0.10) - 1);
  const p10 = sorted[p10idx];
  const p25idx = Math.max(0, Math.floor(len * 0.25) - 1);
  const p25 = sorted[p25idx];

  return {
    floor:     round2(Math.min(...prices)),        // absolute minimum
    p10Floor:  round2(p10),                        // statistical floor (p10)
    p25:       round2(p25),
    median:    round2(median),
    avg:       round2(avg),
    high:      round2(Math.max(...prices)),
    count:     len,
  };
}

// ── Core: ingest sold prices ───────────────────────────────────────────────────

/**
 * Record sold prices into the Redis floor tracker.
 * soldItems: array of { price, soldAt? } objects or raw numbers.
 */
export async function recordSoldPrices(queryOrSku, soldItems, redis) {
  if (!redis || !queryOrSku || !Array.isArray(soldItems) || !soldItems.length) return;

  const key = floorKey(queryOrSku);
  const now = Date.now();

  const pipeline = redis.pipeline();
  for (const item of soldItems) {
    const price = typeof item === "number" ? item : Number(item?.price ?? item?.totalPrice ?? item?.salePrice);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ts = item?.soldAt ? Date.parse(String(item.soldAt)) : now;
    const validTs = Number.isFinite(ts) && ts > 0 ? ts : now;
    // Store as sorted set: score=timestamp, member=price:timestamp
    pipeline.zadd(key, validTs, `${price}:${validTs}`);
  }
  // Trim to last FLOOR_HISTORY_LIMIT entries
  pipeline.zremrangebyrank(key, 0, -(FLOOR_HISTORY_LIMIT + 1));
  // Reset TTL to 90 days on every write
  pipeline.expire(key, FLOOR_TTL_SEC);
  await pipeline.exec().catch(() => null);
}

/**
 * Retrieve the price floor data for a given query/SKU.
 */
export async function getPriceFloor(queryOrSku, redis) {
  if (!redis || !queryOrSku) return buildEmptyFloor(queryOrSku);

  const key = floorKey(queryOrSku);
  const cutoff90 = Date.now() - 90 * 24 * 60 * 60 * 1000;

  try {
    // Get all entries within 90 days (score = timestamp)
    const entries = await redis.zrangebyscore(key, cutoff90, "+inf", "WITHSCORES");
    if (!entries || !entries.length) return buildEmptyFloor(queryOrSku);

    // Parse entries: ["price:ts", score, ...]
    const prices = [];
    for (let i = 0; i < entries.length; i += 2) {
      const member = entries[i];
      const price = parseFloat(member.split(":")[0]);
      if (Number.isFinite(price) && price > 0) prices.push(price);
    }

    if (!prices.length) return buildEmptyFloor(queryOrSku);

    const stats = computeFloorStats(prices);
    return {
      queryOrSku,
      ...stats,
      floorSignal: buildFloorSignal(stats),
      hasFloor: true,
      windowDays: 90,
    };
  } catch {
    return buildEmptyFloor(queryOrSku);
  }
}

/**
 * Check if a given price is below the established floor (underpriced signal).
 */
export function isPriceBelowFloor(price, floorResult) {
  const floor = floorResult?.p10Floor ?? floorResult?.floor;
  if (!floor || !Number.isFinite(Number(price))) return false;
  return Number(price) < floor;
}

/**
 * Compute how far a price deviates from the floor (negative = below floor).
 */
export function priceVsFloor(price, floorResult) {
  const floor = floorResult?.p10Floor ?? floorResult?.floor;
  if (!floor || !Number.isFinite(Number(price))) return null;
  const pct = ((Number(price) - floor) / floor) * 100;
  return round2(pct);
}

// ── Auto-ingest from market search results ────────────────────────────────────

/**
 * Extract sold prices from uiItems (market search result array) and record them.
 */
export async function ingestMarketItemsIntoFloor(queryOrSku, uiItems, redis) {
  if (!Array.isArray(uiItems) || !uiItems.length) return;
  const soldItems = uiItems
    .filter(item => item?.sold === true || String(item?.status || "").toLowerCase() === "sold")
    .map(item => ({
      price: item?.totalPrice ?? item?.price,
      soldAt: item?.soldAt ?? item?.dateSold ?? null,
    }))
    .filter(item => Number.isFinite(Number(item.price)) && Number(item.price) > 0);

  await recordSoldPrices(queryOrSku, soldItems, redis);
}

// ── Master payload builder ─────────────────────────────────────────────────────

/**
 * Full pipeline: ingest new sold data, then return floor analysis.
 */
export async function buildPriceFloorPayload({ queryOrSku, uiItems = [], currentPrice = null, redis } = {}) {
  if (!queryOrSku) return { priceFloor: null, topSignal: null };

  // Ingest any new sold prices from current search
  await ingestMarketItemsIntoFloor(queryOrSku, uiItems, redis);

  // Read current floor
  const floorResult = await getPriceFloor(queryOrSku, redis);

  // Analysis vs current price
  let priceAnalysis = null;
  if (currentPrice && floorResult.hasFloor) {
    const vsFloorPct = priceVsFloor(currentPrice, floorResult);
    const belowFloor = isPriceBelowFloor(currentPrice, floorResult);
    priceAnalysis = {
      currentPrice: round2(Number(currentPrice)),
      vsFloorPct,
      belowFloor,
      signal: belowFloor
        ? `UNDERPRICED: $${currentPrice} is ${Math.abs(vsFloorPct).toFixed(1)}% below 90-day floor ($${floorResult.p10Floor})`
        : vsFloorPct !== null
          ? `Price is ${vsFloorPct > 0 ? "+" : ""}${vsFloorPct.toFixed(1)}% vs 90-day floor`
          : null,
    };
  }

  const topSignal = buildFullTopSignal(floorResult, priceAnalysis);

  return {
    priceFloor: floorResult.hasFloor ? floorResult : null,
    priceAnalysis,
    topSignal,
  };
}

// ── Signal builders ───────────────────────────────────────────────────────────

function buildFloorSignal(stats) {
  if (!stats) return null;
  const parts = [];
  if (stats.floor) parts.push(`90-day floor: $${stats.floor}`);
  if (stats.p10Floor && stats.p10Floor !== stats.floor) parts.push(`P10 floor: $${stats.p10Floor}`);
  if (stats.median) parts.push(`median: $${stats.median}`);
  if (stats.count) parts.push(`${stats.count} data points`);
  return parts.join(" · ");
}

function buildFullTopSignal(floorResult, priceAnalysis) {
  if (!floorResult?.hasFloor) return null;
  if (priceAnalysis?.signal) return priceAnalysis.signal;
  return floorResult.floorSignal;
}

function buildEmptyFloor(queryOrSku) {
  return { queryOrSku, floor: null, p10Floor: null, p25: null, median: null, avg: null, high: null, count: 0, hasFloor: false, floorSignal: null, windowDays: 90 };
}
