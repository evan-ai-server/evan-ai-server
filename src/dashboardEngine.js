// src/dashboardEngine.js
// Phase 3 — User Dashboard Aggregation Engine.
//
// Single endpoint aggregation: GET /dashboard/:userId
//
// Computes and returns a complete business snapshot in one call:
//   - inventory summary (active, deployed capital, oldest item)
//   - financial performance (profit, ROI, win rate)
//   - category breakdown (best/worst)
//   - recent activity (last 5 scans with outcomes)
//   - watchlist alerts (triggered)
//   - recommendations (actionable, computed from data)
//
// Optimized for speed: parallel Redis reads, no blocking.

import { getInventoryCounts, getInventoryMetrics, getUserInventory } from "./inventoryEngine.js";
import { getUserMetrics, getUserLoop } from "./closedLoopEngine.js";
import { getUserAlerts } from "./watchlistEngine.js";
import { generateUserInsights } from "./insightsEngine.js";

/**
 * Build the full dashboard for a user.
 *
 * @param {object} redis
 * @param {string} userId
 * @returns {DashboardResult}
 */
export async function buildUserDashboard(redis, userId) {
  if (!redis || !userId) return _empty(userId);

  try {
    const now = Date.now();

    // Fire all reads in parallel
    const [
      counts,
      invMetrics,
      loopMetrics,
      recentLoop,
      activeInventory,
      alerts,
      insights,
    ] = await Promise.allSettled([
      getInventoryCounts(redis, userId),
      getInventoryMetrics(redis, userId),
      getUserMetrics(redis, userId),
      getUserLoop(redis, userId, { limit: 8 }),
      getUserInventory(redis, userId, { status: "ACTIVE", limit: 10 }),
      getUserAlerts(redis, userId, { limit: 10 }),
      generateUserInsights(redis, userId),
    ]);

    const inv      = value(counts,         {});
    const invMet   = value(invMetrics,     {});
    const loop     = value(loopMetrics,    {});
    const recent   = value(recentLoop,     { scans: [] });
    const active   = value(activeInventory,{ items: [] });
    const alertsV  = value(alerts,         []);
    const insightsV= value(insights,       { insights: [] });

    // ── Inventory summary ─────────────────────────────────────────────────────
    const activeItems  = active.items || [];
    const oldestActive = activeItems.length > 0
      ? activeItems.reduce((a, b) => (a.acquiredAt < b.acquiredAt ? a : b))
      : null;
    const oldestHeldDays = oldestActive
      ? Math.round((now - oldestActive.acquiredAt) / 86400000)
      : null;

    const inventory = {
      active:         inv.active    ?? 0,
      sold:           inv.sold      ?? 0,
      dead:           inv.dead      ?? 0,
      returned:       inv.returned  ?? 0,
      total:          inv.total     ?? 0,
      capitalDeployed: invMet.capitalDeployed ?? 0,
      oldestHeldDays,
      oldestItem: oldestActive ? {
        invId:        oldestActive.invId,
        itemName:     oldestActive.itemName,
        category:     oldestActive.category,
        purchasePrice:oldestActive.purchasePrice,
        heldDays:     oldestHeldDays,
      } : null,
    };

    // ── Financials — prefer inventory metrics (source of truth for Phase 3) ─
    // Fall back to loop metrics for scans not yet in inventory
    const totalProfit  = invMet.totalProfit  ?? loop.totalProfit  ?? 0;
    const totalSpent   = invMet.totalSpent   ?? loop.totalSpent   ?? 0;
    const totalRevenue = invMet.totalRevenue ?? loop.totalRevenue ?? 0;

    const financials = {
      totalSpent:        r2(totalSpent),
      totalRevenue:      r2(totalRevenue),
      totalProfit:       r2(totalProfit),
      roi:               invMet.roi        ?? loop.avgROI ?? null,
      winRate:           invMet.winRate    ?? loop.winRate ?? null,
      avgTimeToSaleDays: invMet.avgTimeToSaleDays ?? loop.avgTimeToSaleDays ?? null,
      totalSold:         (invMet.totalSold ?? 0) || (loop.totalSold ?? 0),
    };

    // ── Category performance ──────────────────────────────────────────────────
    const catBreakdown = (invMet.categoryBreakdown || loop.categoryBreakdown || []).slice(0, 8);
    const sortedCats   = catBreakdown.slice().sort((a, b) => b.profit - a.profit);
    const topCategories    = sortedCats.filter(c => c.profit > 0).slice(0, 3);
    const bottomCategories = sortedCats.filter(c => c.profit <= 0).slice(-3).reverse();

    // ── Recent activity ───────────────────────────────────────────────────────
    const recentScans = (recent.scans || []).slice(0, 5).map(scan => ({
      scanId:    scan.scanId,
      itemName:  scan.itemName,
      category:  scan.category,
      signal:    scan.signal,
      decision:  scan.decision?.decision || null,
      outcome:   scan.outcome?.outcomeStatus || null,
      netProfit: scan.outcome?.netProfit ?? null,
      ts:        scan.ts,
    }));

    const recentWins = recentScans.filter(s => (s.netProfit ?? 0) > 0);
    const recentLoss = recentScans.filter(s => (s.netProfit ?? -1) < 0 && s.outcome === "SOLD");

    // ── Recommendations (fast, data-driven) ───────────────────────────────────
    const recommendations = buildRecommendations({
      inventory, financials, catBreakdown, activeItems, alertsV, insightsV,
    });

    // ── Platform performance ──────────────────────────────────────────────────
    const platformBreakdown = (invMet.platformBreakdown || loop.platformBreakdown || []).slice(0, 5);

    // ── Source performance ────────────────────────────────────────────────────
    const sourceBreakdown = (invMet.sourceBreakdown || []).slice(0, 5);

    return {
      ok:     true,
      userId,
      inventory,
      financials,
      categories: {
        breakdown:   catBreakdown,
        topCategories,
        bottomCategories,
      },
      platforms:  platformBreakdown,
      sources:    sourceBreakdown,
      recentActivity: {
        scans:      recentScans,
        recentWins,
        recentLosses: recentLoss,
      },
      alerts:         alertsV.slice(0, 5),
      alertCount:     alertsV.length,
      topInsights:    insightsV.insights.slice(0, 3),
      recommendations,
      generatedAt:    now,
    };
  } catch (err) {
    console.error("[dashboardEngine] error:", err?.message);
    return _empty(userId);
  }
}

// ── Recommendations engine ────────────────────────────────────────────────────

function buildRecommendations({ inventory, financials, catBreakdown, activeItems, alertsV, insightsV }) {
  const recs = [];

  // 1. Stale inventory
  if (inventory.oldestHeldDays && inventory.oldestHeldDays > 45) {
    const item = inventory.oldestItem;
    recs.push({
      priority: 9,
      type:     "list_stale_inventory",
      title:    `List ${item?.itemName || "your oldest item"} — held ${inventory.oldestHeldDays} days`,
      action:   "generate_listing",
      invId:    item?.invId || null,
    });
  }

  // 2. High capital concentration
  const totalCap = inventory.capitalDeployed || 0;
  if (totalCap > 200 && inventory.active > 0) {
    const avgHold = activeItems.length > 0
      ? r2(activeItems.reduce((s, i) => s + (Date.now() - i.acquiredAt), 0) / activeItems.length / 86400000)
      : null;
    if (avgHold && avgHold > 21) {
      recs.push({
        priority: 8,
        type:     "reduce_hold_time",
        title:    `$${totalCap} deployed — avg hold time ${avgHold}d`,
        action:   "list_active_inventory",
      });
    }
  }

  // 3. No inventory but scanning actively
  if (inventory.active === 0 && (financials.totalSold || 0) > 0) {
    recs.push({
      priority: 5,
      type:     "start_sourcing",
      title:    "No active inventory — time to source",
      action:   "scan_new_items",
    });
  }

  // 4. Profitable category — push more
  const topCat = catBreakdown.find(c => c.profit > 0);
  if (topCat && financials.winRate && financials.winRate > 60) {
    recs.push({
      priority: 6,
      type:     "double_down_category",
      title:    `${topCat.category} is working — source more`,
      body:     `${financials.winRate}% win rate in ${topCat.category}. Your highest-margin channel.`,
      action:   "source_category",
      category: topCat.category,
    });
  }

  // 5. New alerts available
  if (alertsV.length > 0) {
    recs.push({
      priority: 7,
      type:     "check_alerts",
      title:    `${alertsV.length} watchlist alert(s) waiting`,
      action:   "review_alerts",
    });
  }

  // 6. First-time user nudge
  if (inventory.total === 0 && (financials.totalSpent || 0) === 0) {
    recs.push({
      priority: 10,
      type:     "onboard_buy",
      title:    "Mark your first buy to start tracking",
      body:     "Scan an item → tap 'Bought it' → Evan tracks your profit automatically.",
      action:   "scan_and_buy",
    });
  }

  return recs.sort((a, b) => b.priority - a.priority).slice(0, 5);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function value(settled, fallback) {
  return settled.status === "fulfilled" ? (settled.value ?? fallback) : fallback;
}

function _empty(userId) {
  return {
    ok: true, userId,
    inventory: { active: 0, sold: 0, total: 0, capitalDeployed: 0 },
    financials: { totalSpent: 0, totalRevenue: 0, totalProfit: 0, roi: null, winRate: null },
    categories: { breakdown: [], topCategories: [], bottomCategories: [] },
    recentActivity: { scans: [], recentWins: [], recentLosses: [] },
    alerts: [], alertCount: 0, topInsights: [],
    recommendations: [], generatedAt: Date.now(),
  };
}

function r2(n) { return Math.round(n * 100) / 100; }
