// src/categoryIdentityEngines/handbags.js
// Handbag Identity Engine — Phase 15: Category Immortality.
//
// Scores expertise at brand + model + material level.
// Handbag value is highly brand/model/hardware specific — Birkin ≠ Neverfull.
// Hardware color (gold vs. palladium) is a meaningful price differentiator.
//
// Redis keys:
//   catid:handbags:{userId}:brand:{brand}              HASH (180d TTL)
//   catid:handbags:{userId}:model:{brand}:{model}      HASH (180d TTL)
//   catid:handbags:{userId}:material:{material}        HASH (180d TTL)

const KEY_BRAND    = (uid, brand)         => `catid:handbags:${uid}:brand:${n(brand)}`;
const KEY_MODEL    = (uid, brand, model)  => `catid:handbags:${uid}:model:${n(brand)}:${n(model)}`;
const KEY_MATERIAL = (uid, material)      => `catid:handbags:${uid}:material:${n(material)}`;
const TTL = 180 * 86400;

// Luxury brands: extra replica risk weight
const LUXURY_BRANDS = new Set([
  "hermès", "hermes", "chanel", "louis vuitton", "lv", "gucci",
  "prada", "dior", "fendi", "celine", "balenciaga", "bottega veneta",
  "givenchy", "valentino", "saint laurent", "ysl",
]);

// ── Record ─────────────────────────────────────────────────────────────────────

/**
 * Record a realized handbag outcome.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} outcome
 *   brand     {string}  e.g. "louis vuitton", "coach"
 *   model     {string}  e.g. "neverfull mm", "birkin 30"
 *   material  {string}  e.g. "monogram canvas", "lambskin", "togo leather"
 *   hardware  {string}  e.g. "gold", "palladium", "silver"
 *   isWin     {boolean}
 *   netProfit {number}
 *   buyPrice  {number}
 */
export async function recordHandbagOutcome(redis, userId, {
  brand     = null,
  model     = null,
  material  = null,
  hardware  = null,
  isWin     = false,
  netProfit = 0,
  buyPrice  = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const pipe = redis.pipeline();
    const pnl  = Number(netProfit) || 0;
    const isLuxury = LUXURY_BRANDS.has(String(brand || "").toLowerCase());

    function pipeRecord(key) {
      pipe.hincrby(key,      "tradeCount", 1);
      pipe.hincrby(key,      isWin ? "wins" : "losses", 1);
      pipe.hincrbyfloat(key, "netPnl", pnl);
      if (isLuxury)  pipe.hincrby(key, "luxuryTrades", 1);
      if (buyPrice != null) pipe.hincrbyfloat(key, "totalCapital", Number(buyPrice));
      pipe.expire(key, TTL);
    }

    if (brand)             pipeRecord(KEY_BRAND(userId, brand));
    if (brand && model)    pipeRecord(KEY_MODEL(userId, brand, model));
    if (material)          pipeRecord(KEY_MATERIAL(userId, material));

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Score ──────────────────────────────────────────────────────────────────────

/**
 * Compute handbag identity score.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} ctx — { brand, model, material, hardware }
 */
export async function computeHandbagIdentityScore(redis, userId, {
  brand    = null,
  model    = null,
  material = null,
  hardware = null,
} = {}) {
  if (!redis || !userId) return null;
  try {
    const [brandHash, modelHash, materialHash] = await Promise.all([
      brand              ? redis.hgetall(KEY_BRAND(userId, brand)).catch(() => null)       : null,
      brand && model     ? redis.hgetall(KEY_MODEL(userId, brand, model)).catch(() => null): null,
      material           ? redis.hgetall(KEY_MATERIAL(userId, material)).catch(() => null) : null,
    ]);

    const brandDim    = parseDimension(brandHash);
    const modelDim    = parseDimension(modelHash);
    const materialDim = parseDimension(materialHash);

    // Model (55%) > brand (35%) > material (10%)
    let score = 0, totalWeight = 0;
    if (modelDim    && modelDim.tradeCount >= 1)    { score += modelDim.winScore    * 55; totalWeight += 55; }
    if (brandDim    && brandDim.tradeCount >= 1)     { score += brandDim.winScore    * 35; totalWeight += 35; }
    if (materialDim && materialDim.tradeCount >= 1)  { score += materialDim.winScore * 10; totalWeight += 10; }

    if (totalWeight === 0) return null;

    const finalScore  = Math.round(score / totalWeight);
    const totalTrades = (modelDim?.tradeCount || 0) + (brandDim?.tradeCount || 0);
    const confidence  = totalTrades >= 4 ? "high" : totalTrades >= 2 ? "medium" : "low";
    const isLuxury    = LUXURY_BRANDS.has(String(brand || "").toLowerCase());

    return {
      score:      finalScore,
      confidence,
      isLuxury,
      dimensions: {
        brand:    brandDim,
        model:    modelDim,
        material: materialDim,
      },
      signal: buildSignal({ brand, model, material, hardware, score: finalScore, brandDim, modelDim, isLuxury }),
    };
  } catch { return null; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDimension(h) {
  if (!h || !h.tradeCount) return null;
  const tradeCount  = parseInt(h.tradeCount)   || 0;
  const wins        = parseInt(h.wins)           || 0;
  const netPnl      = parseFloat(h.netPnl)       || 0;
  const luxuryTrades = parseInt(h.luxuryTrades)  || 0;
  const winRate     = tradeCount > 0 ? wins / tradeCount : 0;
  const tradeFactor = Math.min(1, tradeCount / 6);
  const winScore    = winRate * 0.7 + tradeFactor * 0.3;
  return { tradeCount, wins, winRate: Math.round(winRate * 100), netPnl: round2(netPnl), luxuryTrades, winScore };
}

function buildSignal({ brand, model, material, hardware, score, brandDim, modelDim, isLuxury }) {
  const name = [brand, model].filter(Boolean).join(" ") || "this bag";

  if (modelDim && modelDim.tradeCount >= 2) {
    if (score >= 70) return `You've built real expertise with ${name} — ${modelDim.winRate}% win rate.`;
    if (score >= 45) return `Variable results with ${name}. Authentication and condition are key.`;
    return `You've had difficulty with ${name}. Verify authenticity markers before buying.`;
  }
  if (brandDim && brandDim.tradeCount >= 2) {
    if (score >= 70) return `Strong ${brand || "brand"} track record — ${brandDim.winRate}% win rate.`;
    return `Mixed ${brand || "brand"} history. Condition and hardware color matter significantly.`;
  }
  if (isLuxury && (!modelDim || modelDim.tradeCount < 2)) {
    return `First ${name} trade. Verify: dust bag, auth card, serial/date stamp, and stitching.`;
  }
  if (hardware === "gold" || hardware === "palladium") {
    return `${hardware === "gold" ? "Gold" : "Palladium"} hardware commands a premium — verify against current comps.`;
  }
  return null;
}

function n(s) { return String(s || "").toLowerCase().trim().slice(0, 50).replace(/\s+/g, "_"); }
function round2(v) { return Math.round(Number(v) * 100) / 100; }
