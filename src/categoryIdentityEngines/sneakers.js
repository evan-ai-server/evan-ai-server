// src/categoryIdentityEngines/sneakers.js
// Sneaker Identity Engine — Phase 15: Category Immortality.
//
// Scores user identity across sneaker trades at the brand + model + colorway level.
// Each dimension builds independently so expertise in Jordan 1s is separate from Yeezys.
//
// Redis keys:
//   catid:sneakers:{userId}:brand:{brand}          HASH  (180d TTL)
//   catid:sneakers:{userId}:model:{brand}:{model}  HASH  (180d TTL)
//   catid:sneakers:{userId}:colorway:{cw}          HASH  (180d TTL)

const KEY_BRAND    = (uid, brand)         => `catid:sneakers:${uid}:brand:${nb(brand)}`;
const KEY_MODEL    = (uid, brand, model)  => `catid:sneakers:${uid}:model:${nb(brand)}:${nm(model)}`;
const KEY_COLORWAY = (uid, cw)            => `catid:sneakers:${uid}:colorway:${nc(cw)}`;
const TTL = 180 * 86400;

const OUTCOME_FIELDS = ["tradeCount", "wins", "losses", "netPnl", "avgBuyPrice", "avgSellPrice"];

// ── Record ─────────────────────────────────────────────────────────────────────

/**
 * Record a realized sneaker outcome into the identity store.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} outcome
 *   brand    {string}  e.g. "nike", "jordan", "adidas"
 *   model    {string}  e.g. "air jordan 1", "dunk low", "yeezy 350"
 *   colorway {string}  e.g. "bred", "chicago", "zebra"
 *   isWin    {boolean}
 *   netProfit {number}
 *   buyPrice  {number}
 *   sellPrice {number}
 */
export async function recordSneakerOutcome(redis, userId, {
  brand     = null,
  model     = null,
  colorway  = null,
  isWin     = false,
  netProfit = 0,
  buyPrice  = null,
  sellPrice = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const pipe = redis.pipeline();
    const win  = isWin ? 1 : 0;
    const loss = isWin ? 0 : 1;
    const pnl  = Number(netProfit) || 0;

    function pipeRecord(key) {
      pipe.hincrby(key,      "tradeCount", 1);
      pipe.hincrby(key,      isWin ? "wins" : "losses", 1);
      pipe.hincrbyfloat(key, "netPnl", pnl);
      if (buyPrice  != null) pipe.hincrbyfloat(key, "totalBuyPrice",  Number(buyPrice));
      if (sellPrice != null) pipe.hincrbyfloat(key, "totalSellPrice", Number(sellPrice));
      pipe.expire(key, TTL);
    }

    if (brand)   pipeRecord(KEY_BRAND(userId, brand));
    if (brand && model) pipeRecord(KEY_MODEL(userId, brand, model));
    if (colorway) pipeRecord(KEY_COLORWAY(userId, colorway));

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Score ──────────────────────────────────────────────────────────────────────

/**
 * Compute a sneaker identity score for the given item context.
 * Returns { score, confidence, dimensions, signal } or null.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} ctx — { brand, model, colorway }
 */
export async function computeSneakerIdentityScore(redis, userId, {
  brand    = null,
  model    = null,
  colorway = null,
} = {}) {
  if (!redis || !userId) return null;
  try {
    const [brandHash, modelHash, cwHash] = await Promise.all([
      brand                ? redis.hgetall(KEY_BRAND(userId, brand)).catch(() => null)        : null,
      brand && model       ? redis.hgetall(KEY_MODEL(userId, brand, model)).catch(() => null) : null,
      colorway             ? redis.hgetall(KEY_COLORWAY(userId, colorway)).catch(() => null)  : null,
    ]);

    const brandDim    = parseDimension(brandHash);
    const modelDim    = parseDimension(modelHash);
    const colorwayDim = parseDimension(cwHash);

    // Weight: model (50%) > brand (30%) > colorway (20%)
    // Use the most specific available dimension
    let score = 0;
    let totalWeight = 0;

    if (modelDim && modelDim.tradeCount >= 1)    { score += modelDim.winScore * 50;    totalWeight += 50; }
    if (brandDim && brandDim.tradeCount >= 1)    { score += brandDim.winScore * 30;    totalWeight += 30; }
    if (colorwayDim && colorwayDim.tradeCount >= 1) { score += colorwayDim.winScore * 20; totalWeight += 20; }

    if (totalWeight === 0) return null;

    const finalScore = Math.round(score / totalWeight);
    const totalTrades = (modelDim?.tradeCount || 0) + (brandDim?.tradeCount || 0);
    const confidence  = totalTrades >= 5 ? "high" : totalTrades >= 2 ? "medium" : "low";

    const signal = buildSignal({ brand, model, colorway, score: finalScore, brandDim, modelDim, colorwayDim });

    return {
      score:      finalScore,
      confidence,
      dimensions: {
        brand:    brandDim,
        model:    modelDim,
        colorway: colorwayDim,
      },
      signal,
    };
  } catch { return null; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDimension(h) {
  if (!h || !h.tradeCount) return null;
  const tradeCount  = parseInt(h.tradeCount)           || 0;
  const wins        = parseInt(h.wins)                  || 0;
  const netPnl      = parseFloat(h.netPnl)              || 0;
  const winRate     = tradeCount > 0 ? wins / tradeCount : 0;
  // Score 0–1: blend of win rate + trade depth
  const tradeFactor = Math.min(1, tradeCount / 8);
  const winScore    = winRate * 0.7 + tradeFactor * 0.3;

  return { tradeCount, wins, winRate: Math.round(winRate * 100), netPnl: round2(netPnl), winScore };
}

function buildSignal({ brand, model, colorway, score, brandDim, modelDim, colorwayDim }) {
  // Most specific signal wins
  if (modelDim && modelDim.tradeCount >= 3) {
    const name = [brand, model].filter(Boolean).join(" ");
    const pct  = modelDim.winRate;
    if (score >= 70) return `You've won ${pct}% of ${name} trades — you know this shoe.`;
    if (score >= 45) return `Mixed record with ${name}. Double-check condition and colorway demand.`;
    return `You've struggled with ${name} trades in the past. Proceed carefully.`;
  }
  if (brandDim && brandDim.tradeCount >= 3) {
    const pct = brandDim.winRate;
    if (score >= 70) return `Strong ${brand || "brand"} track record — ${pct}% win rate.`;
    if (score >= 45) return `Mixed ${brand || "brand"} results historically.`;
    return `You've had difficulty with ${brand || "this brand"} in the past.`;
  }
  if (colorwayDim && colorwayDim.tradeCount >= 2) {
    return colorwayDim.winRate >= 60
      ? `You've done well with ${colorway} colorways.`
      : `${colorway} colorways have been tricky for you — check demand carefully.`;
  }
  return null;
}

function nb(s) { return String(s || "").toLowerCase().trim().slice(0, 40).replace(/\s+/g, "_"); }
function nm(s) { return String(s || "").toLowerCase().trim().slice(0, 60).replace(/\s+/g, "_"); }
function nc(s) { return String(s || "").toLowerCase().trim().slice(0, 40).replace(/\s+/g, "_"); }
function round2(v) { return Math.round(Number(v) * 100) / 100; }
