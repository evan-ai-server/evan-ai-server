// src/categoryIdentityEngines/watches.js
// Watch Identity Engine — Phase 15: Category Immortality.
//
// Scores user expertise at the brand + reference + complication level.
// Watch expertise is highly specific: knowing Submariner ≠ knowing Daytona.
//
// Redis keys:
//   catid:watches:{userId}:brand:{brand}      HASH  (180d TTL)
//   catid:watches:{userId}:ref:{brand}:{ref}  HASH  (180d TTL)
//   catid:watches:{userId}:tier:{tier}        HASH  price tier expertise (180d TTL)

const KEY_BRAND = (uid, brand)      => `catid:watches:${uid}:brand:${n(brand)}`;
const KEY_REF   = (uid, brand, ref) => `catid:watches:${uid}:ref:${n(brand)}:${n(ref)}`;
const KEY_TIER  = (uid, tier)       => `catid:watches:${uid}:tier:${n(tier)}`;
const TTL = 180 * 86400;

// Price tiers for watch expertise
const WATCH_PRICE_TIERS = [
  { label: "entry",   max: 500 },
  { label: "mid",     max: 2000 },
  { label: "premium", max: 8000 },
  { label: "luxury",  max: 30000 },
  { label: "grail",   max: Infinity },
];

function getPriceTier(price) {
  const p = Number(price) || 0;
  return WATCH_PRICE_TIERS.find((t) => p <= t.max)?.label || "grail";
}

// ── Record ─────────────────────────────────────────────────────────────────────

/**
 * Record a realized watch outcome.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} outcome
 *   brand      {string}  e.g. "rolex", "omega", "seiko"
 *   reference  {string}  e.g. "116610ln", "311.30.42.30.01.005"
 *   isWin      {boolean}
 *   netProfit  {number}
 *   buyPrice   {number}
 */
export async function recordWatchOutcome(redis, userId, {
  brand     = null,
  reference = null,
  isWin     = false,
  netProfit = 0,
  buyPrice  = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const pipe = redis.pipeline();
    const pnl  = Number(netProfit) || 0;
    const tier = getPriceTier(buyPrice);

    function pipeRecord(key) {
      pipe.hincrby(key,      "tradeCount", 1);
      pipe.hincrby(key,      isWin ? "wins" : "losses", 1);
      pipe.hincrbyfloat(key, "netPnl", pnl);
      if (buyPrice != null) pipe.hincrbyfloat(key, "totalCapital", Number(buyPrice));
      pipe.expire(key, TTL);
    }

    if (brand)               pipeRecord(KEY_BRAND(userId, brand));
    if (brand && reference)  pipeRecord(KEY_REF(userId, brand, reference));
    pipeRecord(KEY_TIER(userId, tier));

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Score ──────────────────────────────────────────────────────────────────────

/**
 * Compute watch identity score.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} ctx — { brand, reference, buyPrice }
 */
export async function computeWatchIdentityScore(redis, userId, {
  brand     = null,
  reference = null,
  buyPrice  = null,
} = {}) {
  if (!redis || !userId) return null;
  try {
    const tier = getPriceTier(buyPrice);

    const [brandHash, refHash, tierHash] = await Promise.all([
      brand               ? redis.hgetall(KEY_BRAND(userId, brand)).catch(() => null)          : null,
      brand && reference  ? redis.hgetall(KEY_REF(userId, brand, reference)).catch(() => null) : null,
      redis.hgetall(KEY_TIER(userId, tier)).catch(() => null),
    ]);

    const brandDim = parseDimension(brandHash);
    const refDim   = parseDimension(refHash);
    const tierDim  = parseDimension(tierHash);

    // Ref (60%) > brand (30%) > tier (10%)
    let score = 0, totalWeight = 0;
    if (refDim   && refDim.tradeCount >= 1)   { score += refDim.winScore   * 60; totalWeight += 60; }
    if (brandDim && brandDim.tradeCount >= 1)  { score += brandDim.winScore  * 30; totalWeight += 30; }
    if (tierDim  && tierDim.tradeCount >= 1)   { score += tierDim.winScore   * 10; totalWeight += 10; }

    if (totalWeight === 0) return null;

    const finalScore = Math.round(score / totalWeight);
    const totalTrades = (refDim?.tradeCount || 0) + (brandDim?.tradeCount || 0);
    const confidence  = totalTrades >= 4 ? "high" : totalTrades >= 2 ? "medium" : "low";

    return {
      score:      finalScore,
      confidence,
      dimensions: {
        brand:     brandDim,
        reference: refDim,
        tier:      tierDim,
      },
      signal: buildSignal({ brand, reference, tier, score: finalScore, brandDim, refDim }),
    };
  } catch { return null; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDimension(h) {
  if (!h || !h.tradeCount) return null;
  const tradeCount  = parseInt(h.tradeCount) || 0;
  const wins        = parseInt(h.wins)        || 0;
  const netPnl      = parseFloat(h.netPnl)    || 0;
  const winRate     = tradeCount > 0 ? wins / tradeCount : 0;
  const tradeFactor = Math.min(1, tradeCount / 6);
  const winScore    = winRate * 0.7 + tradeFactor * 0.3;
  return { tradeCount, wins, winRate: Math.round(winRate * 100), netPnl: round2(netPnl), winScore };
}

function buildSignal({ brand, reference, tier, score, brandDim, refDim }) {
  if (refDim && refDim.tradeCount >= 2) {
    const name = [brand, reference].filter(Boolean).join(" ");
    if (score >= 70) return `You've traded ${name} before — your judgment here is calibrated.`;
    if (score >= 45) return `Moderate experience with ${name}. Verify reference and condition carefully.`;
    return `Limited success with ${name || "this reference"} — consider condition risk and liquidity.`;
  }
  if (brandDim && brandDim.tradeCount >= 2) {
    if (score >= 70) return `Strong ${brand || "brand"} trade history — ${brandDim.winRate}% win rate.`;
    return `Variable ${brand || "brand"} results in your past trades.`;
  }
  if (tier === "grail" || tier === "luxury") {
    return "High-tier watch — verify reference, papers, and service history carefully.";
  }
  return null;
}

function n(s) { return String(s || "").toLowerCase().trim().slice(0, 50).replace(/[\s.]/g, "_"); }
function round2(v) { return Math.round(Number(v) * 100) / 100; }
