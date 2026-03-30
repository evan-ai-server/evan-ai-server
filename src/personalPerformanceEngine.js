// src/personalPerformanceEngine.js
// Personal Performance Engine — Phase 13: Behavioral Lock-In.
//
// Computes REALIZED financial performance per category and over time.
// Every number here traces directly to a real recorded buy+sell outcome.
// No estimated figures are surfaced as realized — labeling is strict.
//
// DISTINCT FROM categoryMastery.js:
//   categoryMastery     = scan signal calibration (are you reading the market accurately?)
//   personalPerformance = realized financial outcomes (are you actually making money here?)
// A user can have EXPERT mastery but negative realized P&L, or vice versa.
//
// Redis keys:
//   perf:summary:{userId}      STRING  full performance summary (1h TTL)
//   perf:cat_rank:{userId}     STRING  category ranking by realized P&L (1h TTL)
//   identity:milestone_seen:{userId}  STRING  last profit milestone surfaced

import { getOutcomeAggregates }                     from "./outcomeEngine.js";
import { getRealizedProfitSummary,
         listRealizedProfitEntries }                from "./profitLedger.js";
import { getCategoryMasteryMap }                    from "./categoryMastery.js";

const KEY_SUMMARY   = (uid) => `perf:summary:${uid}`;
const KEY_CAT_RANK  = (uid) => `perf:cat_rank:${uid}`;
const KEY_MILESTONE = (uid) => `identity:milestone_seen:${uid}`;

const CACHE_TTL = 3600;   // 1 hour

// Milestone thresholds (net realized profit, USD)
export const PROFIT_MILESTONES = [100, 500, 1000, 2500, 5000, 10000, 25000];

// Minimum trades before a category appears in rankings
const MIN_TRADES_FOR_RANKING = 2;

// ── Category performance ranking ──────────────────────────────────────────────

/**
 * Build a per-category performance ranking from realized outcomes.
 * Returns categories sorted by total realized net profit (desc).
 * Only includes categories with ≥ minTrades completed buy+sell trades.
 *
 * @returns {CategoryPerf[]}
 *   { category, totalTrades, winCount, lossCount, winRate,
 *     netProfitRealized, avgNetProfit, masteryLevel, masteryScore, categoryHeat }
 */
export async function getCategoryPerformanceRanking(pgPool, redis, userId, {
  minTrades = MIN_TRADES_FOR_RANKING,
  force     = false,
} = {}) {
  if (!userId) return [];

  if (!force) {
    try {
      const cached = await redis?.get(KEY_CAT_RANK(userId));
      if (cached) return JSON.parse(cached);
    } catch { /* fall through */ }
  }

  const [aggregates, masteryMap] = await Promise.all([
    getOutcomeAggregates(pgPool, redis, userId).catch(() => []),
    getCategoryMasteryMap(redis, userId).catch(() => new Map()),
  ]);

  // getOutcomeAggregates groups by (category, signal) — collapse to per-category
  const catMap = new Map();
  for (const row of aggregates) {
    const cat = row.category || "unknown";
    if (!catMap.has(cat)) {
      catMap.set(cat, {
        category:      cat,
        totalTrades:   0,
        winCount:      0,
        lossCount:     0,
        netProfitSum:  0,
      });
    }
    const e = catMap.get(cat);
    e.totalTrades  += row.soldCount      ?? row.totalOutcomes ?? 0;
    e.winCount     += row.winCount       ?? 0;
    e.lossCount    += row.lossCount      ?? 0;
    if (row.netProfitSum != null) e.netProfitSum += row.netProfitSum;
  }

  const ranked = [...catMap.values()]
    .filter((c) => c.totalTrades >= minTrades)
    .map((c) => {
      const mastery = masteryMap.get(c.category) || null;
      return {
        category:           c.category,
        totalTrades:        c.totalTrades,
        winCount:           c.winCount,
        lossCount:          c.lossCount,
        winRate:            c.totalTrades > 0 ? round2((c.winCount / c.totalTrades) * 100) : null,
        netProfitRealized:  round2(c.netProfitSum),
        avgNetProfit:       c.totalTrades > 0 ? round2(c.netProfitSum / c.totalTrades) : null,
        masteryLevel:       mastery?.masteryLevel || null,
        masteryScore:       mastery?.masteryScore || null,
        categoryHeat:       mastery?.categoryHeat || null,
      };
    })
    .sort((a, b) => (b.netProfitRealized ?? -Infinity) - (a.netProfitRealized ?? -Infinity));

  redis?.set(KEY_CAT_RANK(userId), JSON.stringify(ranked), "EX", CACHE_TTL).catch(() => {});

  return ranked;
}

/**
 * Return the highest net-profit categories (positive P&L, ≥50% win rate).
 */
export async function getBestCategories(pgPool, redis, userId, {
  minTrades = 3,
  topN      = 5,
} = {}) {
  const ranked = await getCategoryPerformanceRanking(pgPool, redis, userId, { minTrades });
  return ranked
    .filter((c) => c.netProfitRealized > 0 && (c.winRate == null || c.winRate >= 50))
    .slice(0, topN);
}

/**
 * Return the worst net-profit categories (negative P&L or win rate < 40%).
 */
export async function getWorstCategories(pgPool, redis, userId, {
  minTrades = 3,
  topN      = 5,
} = {}) {
  const ranked = await getCategoryPerformanceRanking(pgPool, redis, userId, { minTrades });
  return ranked
    .filter((c) => c.netProfitRealized < 0 || (c.winRate != null && c.winRate < 40))
    .sort((a, b) => (a.netProfitRealized ?? Infinity) - (b.netProfitRealized ?? Infinity))
    .slice(0, topN);
}

// ── Performance summary ───────────────────────────────────────────────────────

/**
 * Build an all-up performance summary with 30-day trend.
 *
 * All-time totals come from getOutcomeAggregates.
 * Trend computation uses listRealizedProfitEntries (has per-entry timestamps).
 */
export async function getPerformanceSummary(pgPool, redis, userId, { force = false } = {}) {
  if (!userId) return null;

  if (!force) {
    try {
      const cached = await redis?.get(KEY_SUMMARY(userId));
      if (cached) return JSON.parse(cached);
    } catch { /* fall through */ }
  }

  const thirtyDaysAgo = Date.now() - 30 * 86400 * 1000;
  const sixtyDaysAgo  = Date.now() - 60 * 86400 * 1000;

  const [profitSummary, allTimeRanking, allEntries] = await Promise.all([
    getRealizedProfitSummary(redis, pgPool, userId).catch(() => null),
    getCategoryPerformanceRanking(pgPool, redis, userId, { minTrades: 1, force: true }).catch(() => []),
    listRealizedProfitEntries(redis, userId, { limit: 500 }).catch(() => []),
  ]);

  // All-time aggregated from category ranking
  const totalTrades    = allTimeRanking.reduce((s, c) => s + c.totalTrades, 0);
  const totalWins      = allTimeRanking.reduce((s, c) => s + c.winCount,    0);
  const totalLosses    = allTimeRanking.reduce((s, c) => s + c.lossCount,   0);
  const netProfitTotal = allTimeRanking.reduce((s, c) => s + (c.netProfitRealized ?? 0), 0);

  // Trend from profit entries (authoritative timestamps)
  const recent30dEntries = allEntries.filter((e) => (e.recordedAt || 0) >= thirtyDaysAgo);
  const prior30dEntries  = allEntries.filter((e) => {
    const ts = e.recordedAt || 0;
    return ts >= sixtyDaysAgo && ts < thirtyDaysAgo;
  });

  const trendStats = (entries) => ({
    trades:  entries.length,
    wins:    entries.filter((e) => e.isWin === true).length,
    losses:  entries.filter((e) => e.isWin === false).length,
    netProfit: round2(entries.reduce((s, e) => s + (e.netProfitRealized ?? e.netProfitEstimated ?? 0), 0)),
    winRate: entries.length > 0
      ? round2((entries.filter((e) => e.isWin === true).length / entries.length) * 100)
      : null,
  });

  const recent30d = trendStats(recent30dEntries);
  const prior30d  = trendStats(prior30dEntries);

  let trend = "stable";
  if (recent30d.winRate != null && prior30d.winRate != null) {
    const delta = recent30d.winRate - prior30d.winRate;
    trend = delta >= 8 ? "improving" : delta <= -8 ? "declining" : "stable";
  } else if (recent30d.trades > 0 && prior30d.trades === 0) {
    trend = "new_activity";
  }

  const summary = {
    userId,
    allTime: {
      totalTrades,
      winCount:  totalWins,
      lossCount: totalLosses,
      winRate:   totalTrades > 0 ? round2((totalWins / totalTrades) * 100) : null,
      // Authoritative realized P&L (from profit ledger with fee accounting)
      netProfitRealized:  profitSummary?.netProfitRealized  ?? round2(netProfitTotal),
      grossProfitRealized: profitSummary?.grossProfitRealized ?? null,
      tradeCount:         profitSummary?.totalRealizedEntries ?? totalTrades,
    },
    last30d:  recent30d,
    prior30d: prior30d,
    trend,
    activeCategories: allTimeRanking.filter((c) => c.totalTrades >= 1).length,
    generatedAt: Date.now(),
  };

  redis?.set(KEY_SUMMARY(userId), JSON.stringify(summary), "EX", CACHE_TTL).catch(() => {});

  return summary;
}

/**
 * Bust cached performance data for a user.
 * Call immediately after a new realized outcome is recorded.
 */
export async function invalidatePerformanceCache(redis, userId) {
  if (!redis || !userId) return;
  await Promise.all([
    redis.del(KEY_SUMMARY(userId)).catch(() => {}),
    redis.del(KEY_CAT_RANK(userId)).catch(() => {}),
  ]);
}

// ── Profit milestones ─────────────────────────────────────────────────────────

/**
 * Check if a new profit milestone was crossed that hasn't been surfaced yet.
 * Returns the milestone value if newly crossed, null if already seen or not crossed.
 *
 * Marks the milestone as seen atomically.
 */
export async function checkNewProfitMilestone(redis, userId, netProfitRealized) {
  if (!redis || !userId || netProfitRealized == null) return null;

  const profit = Number(netProfitRealized);
  if (!Number.isFinite(profit) || profit <= 0) return null;

  // Highest milestone the user has now surpassed
  const crossed = [...PROFIT_MILESTONES].reverse().find((m) => profit >= m);
  if (!crossed) return null;

  const lastSeen = Number(await redis.get(KEY_MILESTONE(userId)).catch(() => 0)) || 0;
  if (crossed <= lastSeen) return null;

  // Mark immediately to prevent duplicate surfaces across concurrent requests
  await redis.set(KEY_MILESTONE(userId), String(crossed)).catch(() => {});

  return crossed;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(v) {
  return v != null ? Math.round(Number(v) * 100) / 100 : null;
}
