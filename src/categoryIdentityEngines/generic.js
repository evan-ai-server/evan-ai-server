// src/categoryIdentityEngines/generic.js
// Generic Identity Engine — Phase 15: Category Immortality.
//
// Fallback identity scorer for categories without a specialized engine.
// Builds user identity from brand/model/condition patterns across all trades.
//
// Redis keys:
//   catid:generic:{userId}:{brand}   HASH  tradeCount, wins, losses, netPnl (180d TTL)

const KEY_BRAND = (userId, brand) =>
  `catid:generic:${userId}:${normalizeBrand(brand)}`;
const BRAND_TTL = 180 * 86400;

// ── Record ────────────────────────────────────────────────────────────────────

/**
 * Record a realized outcome into the generic identity tracker.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} outcome  — { brand, isWin, netProfit }
 */
export async function recordGenericOutcome(redis, userId, {
  brand     = null,
  isWin     = false,
  netProfit = 0,
} = {}) {
  if (!redis || !userId) return;
  try {
    const b    = normalizeBrand(brand) || "unknown";
    const key  = KEY_BRAND(userId, b);
    const pipe = redis.pipeline();
    pipe.hincrby(key, "tradeCount", 1);
    pipe.hincrby(key, isWin ? "wins" : "losses", 1);
    pipe.hincrbyfloat(key, "netPnl", Number(netProfit) || 0);
    pipe.expire(key, BRAND_TTL);
    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Score ─────────────────────────────────────────────────────────────────────

/**
 * Compute a generic category identity score for a user given a brand.
 * Returns { score 0–100, confidence, tradeCount, winRate, signal }.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string|null} brand
 */
export async function computeGenericIdentityScore(redis, userId, brand = null) {
  if (!redis || !userId) return null;
  try {
    const b   = normalizeBrand(brand) || "unknown";
    const key = KEY_BRAND(userId, b);
    const h   = await redis.hgetall(key).catch(() => null);
    if (!h || !h.tradeCount) return null;

    const tradeCount = parseInt(h.tradeCount) || 0;
    const wins       = parseInt(h.wins)        || 0;
    const netPnl     = parseFloat(h.netPnl)    || 0;
    const winRate    = tradeCount > 0 ? wins / tradeCount : 0;

    // Score: blend of win rate (60%) + trade count factor (40%)
    const tradeFactor = Math.min(1, tradeCount / 10);
    const score       = Math.round((winRate * 0.6 + tradeFactor * 0.4) * 100);
    const confidence  = tradeCount >= 5 ? "medium" : "low";

    return {
      score,
      confidence,
      tradeCount,
      winRate:    Math.round(winRate * 100),
      netPnl:     Math.round(netPnl * 100) / 100,
      signal:     buildGenericSignal(brand, score, winRate, tradeCount),
    };
  } catch { return null; }
}

function buildGenericSignal(brand, score, winRate, tradeCount) {
  if (tradeCount < 3) return null;
  const pct = Math.round(winRate * 100);
  if (score >= 70) return `You've won ${pct}% of ${brand || "these"} trades — solid track record here.`;
  if (score >= 45) return `Mixed results with ${brand || "this brand"} — proceed with caution.`;
  return `You've struggled with ${brand || "this category"} in the past (${pct}% win rate).`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeBrand(b) {
  return String(b || "").toLowerCase().trim().slice(0, 40).replace(/\s+/g, "_");
}
