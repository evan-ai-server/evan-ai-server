// src/financialIdentityEngine.js
// Financial Identity Engine — Phase 13: Behavioral Lock-In.
//
// Assembles a user's financial identity from REAL outcomes only.
// This is the core lock-in mechanism: leaving Evan means losing a calibration
// profile built from actual buy/sell trades — not streaks, XP, or social rank.
//
// Identity maturity tiers (based on realized trade count):
//   SEED        — <5 realized trades  (profile not meaningful yet)
//   DEVELOPING  — 5–19 trades         (pattern emerging)
//   ESTABLISHED — 20–49 trades        (real signal)
//   ADVANCED    — 50+ trades          (strong, trusted identity)
//
// Non-negotiables:
//   - No estimated profit masquerading as realized profit
//   - No streaks, XP, or leaderboard
//   - Best/worst categories only surface with ≥ MIN_TRADES_FOR_RANKING trades
//   - Every text field is derived from actual data, never invented
//
// Redis keys:
//   identity:snapshot:{userId}          STRING  full identity snapshot (1h TTL)
//   feed:cat_strength:{userId}:{cat}    STRING  feed suppression (7d TTL)
//   feed:cat_weakness:{userId}:{cat}    STRING  feed suppression (3d TTL)

import {
  getPerformanceSummary,
  getCategoryPerformanceRanking,
  getBestCategories,
  getWorstCategories,
  checkNewProfitMilestone,
  PROFIT_MILESTONES,
}                               from "./personalPerformanceEngine.js";
import {
  getTacticSummary,
  getSignatureTactics,
}                               from "./tacticWinRateEngine.js";
import { getCategoryMasteryMap } from "./categoryMastery.js";
import { computeUserOperatingMode } from "./personalDecisionEngine.js";

const KEY_SNAPSHOT    = (uid) => `identity:snapshot:${uid}`;
const KEY_CAT_STR_SUP = (uid, cat) => `feed:cat_strength:${uid}:${normalizeCat(cat)}`;
const KEY_CAT_WEK_SUP = (uid, cat) => `feed:cat_weakness:${uid}:${normalizeCat(cat)}`;

const SNAPSHOT_TTL     = 3600;         // 1h
const CAT_STR_SUP_TTL  = 7  * 86400;   // re-surface category strength max 1× / 7d
const CAT_WEK_SUP_TTL  = 3  * 86400;   // re-surface category weakness max 1× / 3d

// Minimum trades for a category to appear in best/worst
const MIN_TRADES_FOR_RANKING = 3;

// Identity maturity thresholds
const MATURITY_LEVELS = [
  { tier: "ADVANCED",    minTrades: 50 },
  { tier: "ESTABLISHED", minTrades: 20 },
  { tier: "DEVELOPING",  minTrades: 5  },
  { tier: "SEED",        minTrades: 0  },
];

// ── Financial identity ────────────────────────────────────────────────────────

/**
 * Build the full financial identity for a user.
 *
 * @returns {FinancialIdentity}
 *   userId, maturity, dataPoints, realizedPnl, bestCategories, worstCategories,
 *   signatureTactics, operatingMode, categoryMastery, generatedAt
 */
export async function buildFinancialIdentity(pgPool, redis, userId) {
  if (!userId) return null;

  const [
    summary,
    best,
    worst,
    sigTactics,
    masteryMap,
    operatingMode,
  ] = await Promise.all([
    getPerformanceSummary(pgPool, redis, userId, { force: false }).catch(() => null),
    getBestCategories(pgPool, redis, userId, { minTrades: MIN_TRADES_FOR_RANKING }).catch(() => []),
    getWorstCategories(pgPool, redis, userId, { minTrades: MIN_TRADES_FOR_RANKING }).catch(() => []),
    getSignatureTactics(redis, userId, { minEvents: 3, topN: 3 }).catch(() => []),
    getCategoryMasteryMap(redis, userId).catch(() => new Map()),
    computeUserOperatingMode(redis, userId).catch(() => null),
  ]);

  const tradeCount = summary?.allTime?.tradeCount ?? summary?.allTime?.totalTrades ?? 0;
  const maturity   = assessIdentityMaturity(tradeCount);

  // Mastery map → serialize to a plain object (map key = category)
  const masteryByCategory = {};
  for (const [cat, m] of masteryMap.entries()) {
    masteryByCategory[cat] = {
      masteryLevel: m.masteryLevel,
      masteryScore: m.masteryScore,
      isSafeAutonomous: m.isSafeAutonomous,
    };
  }

  // Data points = realized trades + outcome signals in mastery
  const masteryDataPoints = [...masteryMap.values()]
    .reduce((s, m) => s + (m.totalSamples ?? 0), 0);
  const dataPoints = tradeCount + Math.floor(masteryDataPoints * 0.3);

  const identity = {
    userId,
    maturity: {
      tier:        maturity.tier,
      tradeCount,
      dataPoints,
      description: maturity.description,
    },
    realizedPnl: summary?.allTime
      ? {
          netProfitRealized:   summary.allTime.netProfitRealized,
          grossProfitRealized: summary.allTime.grossProfitRealized ?? null,
          winCount:            summary.allTime.winCount,
          lossCount:           summary.allTime.lossCount,
          winRate:             summary.allTime.winRate,
          totalTrades:         tradeCount,
        }
      : null,
    trend: summary
      ? {
          direction:    summary.trend,
          last30d:      summary.last30d,
          prior30d:     summary.prior30d,
        }
      : null,
    bestCategories:  best,
    worstCategories: worst,
    signatureTactics: sigTactics,
    operatingMode:   operatingMode?.mode ?? operatingMode?.derivedMode ?? null,
    categoryMastery: masteryByCategory,
    generatedAt: Date.now(),
  };

  return identity;
}

/**
 * Get a cached identity snapshot, recomputing if stale.
 */
export async function getFinancialIdentity(pgPool, redis, userId, { force = false } = {}) {
  if (!userId) return null;

  if (!force) {
    try {
      const cached = await redis?.get(KEY_SNAPSHOT(userId));
      if (cached) return JSON.parse(cached);
    } catch { /* fall through */ }
  }

  const identity = await buildFinancialIdentity(pgPool, redis, userId);
  if (identity) {
    redis?.set(KEY_SNAPSHOT(userId), JSON.stringify(identity), "EX", SNAPSHOT_TTL).catch(() => {});
  }
  return identity;
}

/**
 * Invalidate the cached identity snapshot.
 * Call after a new realized outcome is recorded.
 */
export async function invalidateIdentityCache(redis, userId) {
  if (!redis || !userId) return;
  await redis.del(KEY_SNAPSHOT(userId)).catch(() => {});
}

// ── Identity maturity ─────────────────────────────────────────────────────────

/**
 * Assess the maturity tier of a user's financial identity.
 * Based purely on realized trade count — never fabricated.
 */
export function assessIdentityMaturity(tradeCount) {
  const n = Number(tradeCount) || 0;
  const level = MATURITY_LEVELS.find((l) => n >= l.minTrades);
  const descriptions = {
    ADVANCED:    "Strong, trusted identity built from 50+ realized trades.",
    ESTABLISHED: "Clear financial identity — real patterns across 20+ trades.",
    DEVELOPING:  "Pattern emerging — keep trading to sharpen your profile.",
    SEED:        "Not enough realized trades yet for a meaningful profile.",
  };
  return {
    tier:        level?.tier || "SEED",
    description: descriptions[level?.tier || "SEED"],
  };
}

// ── Feed item builders ────────────────────────────────────────────────────────

/**
 * Build CATEGORY_STRENGTH feed items for categories where the user is
 * performing well (positive P&L, high win rate, COMPETENT/EXPERT mastery).
 *
 * Suppressed per-category for 7 days after last surface to prevent spam.
 * Returns array of feed items (may be empty).
 */
export async function buildCategoryStrengthFeedItems(pgPool, redis, userId, { maxItems = 2 } = {}) {
  if (!redis || !userId) return [];
  const best = await getBestCategories(pgPool, redis, userId, {
    minTrades: MIN_TRADES_FOR_RANKING,
    topN: 5,
  }).catch(() => []);

  const items = [];
  for (const cat of best) {
    if (items.length >= maxItems) break;

    // Only surface COMPETENT/EXPERT categories
    if (!["COMPETENT", "EXPERT"].includes(cat.masteryLevel)) continue;

    // Check suppression
    const suppKey = KEY_CAT_STR_SUP(userId, cat.category);
    const seen    = await redis.get(suppKey).catch(() => null);
    if (seen) continue;

    // Surface it — set suppression immediately
    await redis.set(suppKey, "1", "EX", CAT_STR_SUP_TTL).catch(() => {});

    items.push({
      type:     "CATEGORY_STRENGTH",
      category: cat.category,
      data: {
        category:          cat.category,
        netProfitRealized: cat.netProfitRealized,
        winRate:           cat.winRate,
        totalTrades:       cat.totalTrades,
        masteryLevel:      cat.masteryLevel,
      },
    });
  }
  return items;
}

/**
 * Build CATEGORY_WEAKNESS feed items for categories where the user is
 * consistently losing money (negative P&L or win rate < 40%).
 *
 * Suppressed per-category for 3 days.
 */
export async function buildCategoryWeaknessFeedItems(pgPool, redis, userId, { maxItems = 2 } = {}) {
  if (!redis || !userId) return [];
  const worst = await getWorstCategories(pgPool, redis, userId, {
    minTrades: MIN_TRADES_FOR_RANKING,
    topN: 5,
  }).catch(() => []);

  const items = [];
  for (const cat of worst) {
    if (items.length >= maxItems) break;

    const suppKey = KEY_CAT_WEK_SUP(userId, cat.category);
    const seen    = await redis.get(suppKey).catch(() => null);
    if (seen) continue;

    await redis.set(suppKey, "1", "EX", CAT_WEK_SUP_TTL).catch(() => {});

    items.push({
      type:     "CATEGORY_WEAKNESS",
      category: cat.category,
      data: {
        category:          cat.category,
        netProfitRealized: cat.netProfitRealized,
        winRate:           cat.winRate,
        totalTrades:       cat.totalTrades,
        lossCount:         cat.lossCount,
      },
    });
  }
  return items;
}

/**
 * Build a PROFIT_MILESTONE feed item if a new milestone was just crossed.
 * Returns the item or null.
 */
export async function buildProfitMilestoneFeedItem(pgPool, redis, userId) {
  if (!redis || !userId) return null;

  const summary = await getPerformanceSummary(pgPool, redis, userId, { force: false }).catch(() => null);
  const netProfit = summary?.allTime?.netProfitRealized;
  if (netProfit == null) return null;

  const milestone = await checkNewProfitMilestone(redis, userId, netProfit);
  if (!milestone) return null;

  // Find the next milestone to give context
  const nextMilestone = PROFIT_MILESTONES.find((m) => m > milestone) || null;

  return {
    type:      "PROFIT_MILESTONE",
    milestone,
    data: {
      milestone,
      netProfitRealized: round2(netProfit),
      nextMilestone,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}

function round2(v) {
  return v != null ? Math.round(Number(v) * 100) / 100 : null;
}
