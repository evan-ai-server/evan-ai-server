// src/insightsEngine.js
// Phase 3 — Price Movement & Re-Engagement Insights.
//
// Reads the user's scan history, compares across time, and surfaces:
//   - Items the user PASSED on that were good deals (missed opportunities)
//   - Active inventory items held longer than typical (holding alerts)
//   - Categories where the user consistently wins or loses
//   - Items the user scanned multiple times (price trending up or down)
//
// Everything is derived from stored Phase 1 + Phase 3 data.
// No live API calls — fast reads from Redis.

import { getUserLoop } from "./closedLoopEngine.js";
import { getUserInventory } from "./inventoryEngine.js";

const MAX_INSIGHTS = 20;
const HOLDING_ALERT_DAYS = 30;   // flag inventory held > 30 days
const PRICE_MOVE_THRESHOLD = 0.15; // 15% price change = notable movement

// ── Main insights generator ───────────────────────────────────────────────────

/**
 * Generate personalized insights for a user.
 *
 * @param {object} redis
 * @param {string} userId
 * @returns {InsightsResult}
 */
export async function generateUserInsights(redis, userId) {
  if (!redis || !userId) return _empty();
  try {
    const [loopData, inventoryData] = await Promise.all([
      getUserLoop(redis, userId, { limit: 200 }),
      getUserInventory(redis, userId, { status: "ACTIVE", limit: 200 }),
    ]);

    const scans     = loopData.scans || [];
    const inventory = inventoryData.items || [];
    const now       = Date.now();

    const insights = [];

    // 1. Missed opportunities — PASS decisions on STRONG BUY / GOOD DEAL signals
    const missedOps = findMissedOpportunities(scans);
    insights.push(...missedOps);

    // 2. Holding alerts — items in ACTIVE inventory past the holding threshold
    const holdingAlerts = findHoldingAlerts(inventory, now);
    insights.push(...holdingAlerts);

    // 3. Price movement — same brand/model scanned multiple times at different prices
    const priceMovements = findPriceMovements(scans);
    insights.push(...priceMovements);

    // 4. Pattern insights — consistent wins/losses by category or source type
    const patterns = findBehavioralPatterns(scans);
    insights.push(...patterns);

    // 5. Override outcome analysis — decisions that went against Evan's signal
    const overrideAnalysis = analyzeOverrides(scans);
    if (overrideAnalysis) insights.push(overrideAnalysis);

    // 6. Capital concentration warning
    const capitalWarning = analyzeCapitalConcentration(inventory);
    if (capitalWarning) insights.push(capitalWarning);

    // Sort by priority then recency
    insights.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    return {
      ok:       true,
      userId,
      count:    Math.min(insights.length, MAX_INSIGHTS),
      insights: insights.slice(0, MAX_INSIGHTS),
      generatedAt: now,
    };
  } catch (err) {
    console.error("[insightsEngine] error:", err?.message);
    return _empty();
  }
}

// ── Missed opportunity detector ───────────────────────────────────────────────

function findMissedOpportunities(scans) {
  const insights = [];
  const positive  = new Set(["STRONG BUY", "GREAT FLIP", "GOOD DEAL"]);

  for (const scan of scans) {
    if (!scan.decision || scan.decision.decision !== "PASS") continue;
    if (!scan.signal || !positive.has(scan.signal)) continue;
    if (!scan.ts) continue;

    const daysAgo = Math.round((Date.now() - scan.ts) / 86400000);
    const trust   = scan.trustScore ?? 0;
    if (trust < 0.45) continue;   // low-trust signals aren't worth surfacing

    insights.push({
      type:     "missed_opportunity",
      priority: scan.signal === "STRONG BUY" ? 8 : 6,
      title:    `You passed on a ${scan.signal} ${daysAgo}d ago`,
      body:     buildMissedOpBody(scan, daysAgo),
      scanId:   scan.scanId,
      itemName: scan.itemName,
      category: scan.category,
      signal:   scan.signal,
      trustScore: trust,
      daysAgo,
      ts:       scan.ts,
      actionable: true,
      action:   "rescan",
    });
  }

  return insights.slice(0, 5);
}

function buildMissedOpBody(scan, daysAgo) {
  const item = scan.itemName || scan.category || "that item";
  const sig  = scan.signal;
  return sig === "STRONG BUY"
    ? `Evan rated ${item} STRONG BUY ${daysAgo}d ago but you passed. If it's still available, this may still be worth grabbing.`
    : `${item} was a ${sig} ${daysAgo}d ago. Check if it's still available — similar items at this price are profitable.`;
}

// ── Holding alert detector ────────────────────────────────────────────────────

function findHoldingAlerts(inventory, now) {
  const insights = [];

  for (const item of inventory) {
    if (!item.acquiredAt) continue;
    const heldDays = Math.round((now - item.acquiredAt) / 86400000);
    if (heldDays < HOLDING_ALERT_DAYS) continue;

    const capital = item.purchasePrice || 0;
    insights.push({
      type:     "holding_alert",
      priority: heldDays > 90 ? 9 : heldDays > 60 ? 7 : 5,
      title:    `${item.itemName || "Item"} held ${heldDays} days`,
      body:     buildHoldingBody(item, heldDays),
      invId:    item.invId,
      itemName: item.itemName,
      category: item.category,
      capitalTied: capital,
      heldDays,
      acquiredAt: item.acquiredAt,
      actionable: true,
      action:   "list_now",
    });
  }

  return insights.sort((a, b) => b.heldDays - a.heldDays).slice(0, 5);
}

function buildHoldingBody(item, heldDays) {
  const cap  = item.purchasePrice ? `$${item.purchasePrice}` : "capital";
  const name = item.itemName || "This item";
  if (heldDays > 90) {
    return `${name} has been in inventory ${heldDays} days with ${cap} tied up. Consider listing or marking dead if unsellable.`;
  }
  return `${name} (${cap} cost) has been sitting ${heldDays} days. Time to list — markets shift.`;
}

// ── Price movement detector ───────────────────────────────────────────────────

function findPriceMovements(scans) {
  // Group scans by itemName (normalized) that appear 2+ times
  const grouped = {};
  for (const scan of scans) {
    if (!scan.itemName) continue;
    const key = scan.itemName.toLowerCase().trim();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(scan);
  }

  const insights = [];
  for (const [key, group] of Object.entries(grouped)) {
    if (group.length < 2) continue;

    // Sort by time ascending
    const sorted = group.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const first  = sorted[0];
    const last   = sorted[sorted.length - 1];

    // We don't store price in signal snapshot — use trustScore movement as a proxy signal
    // Surface if user bought on first scan and it appeared again
    const firstBought = first.decision?.decision === "BUY";
    const lastSignal  = last.signal;
    const daysSpan    = last.ts && first.ts ? Math.round((last.ts - first.ts) / 86400000) : null;

    if (firstBought && last.decision?.decision !== "BUY" && daysSpan && daysSpan > 7) {
      insights.push({
        type:     "rescan_detected",
        priority: 4,
        title:    `You scanned "${first.itemName}" again ${daysSpan}d later`,
        body:     `First scan: ${first.signal || "unknown signal"} → bought. Latest scan: ${lastSignal || "no signal"}. Market may have moved.`,
        scanId:   last.scanId,
        itemName: first.itemName,
        category: first.category,
        scanCount: group.length,
        daysSpan,
        ts:       last.ts,
        actionable: false,
      });
    }
  }

  return insights.slice(0, 3);
}

// ── Behavioral pattern analysis ───────────────────────────────────────────────

function findBehavioralPatterns(scans) {
  const insights = [];
  const catStats  = {};

  for (const scan of scans) {
    if (!scan.decision || !scan.category) continue;
    const cat = scan.category;
    if (!catStats[cat]) catStats[cat] = { buys: 0, sold: 0, wins: 0, totalProfit: 0 };
    if (scan.decision.decision === "BUY") catStats[cat].buys++;
    if (scan.outcome?.outcomeStatus === "SOLD") {
      catStats[cat].sold++;
      const np = scan.outcome.netProfit ?? 0;
      catStats[cat].totalProfit += np;
      if (np > 0) catStats[cat].wins++;
    }
  }

  // Find best and worst performing categories
  const entries = Object.entries(catStats).filter(([, s]) => s.sold >= 3);
  if (entries.length === 0) return insights;

  entries.sort((a, b) => b[1].totalProfit - a[1].totalProfit);
  const best  = entries[0];
  const worst = entries[entries.length - 1];

  if (best && best[1].totalProfit > 0) {
    const wr = r2((best[1].wins / best[1].sold) * 100);
    insights.push({
      type:     "category_strength",
      priority: 3,
      title:    `${best[0]} is your best category`,
      body:     `${best[1].sold} sells, ${wr}% win rate, $${r2(best[1].totalProfit)} total profit. Double down here.`,
      category: best[0],
      winRate:  wr,
      totalProfit: r2(best[1].totalProfit),
      actionable: false,
    });
  }

  if (worst && worst[1].totalProfit < 0 && worst[0] !== best[0]) {
    insights.push({
      type:     "category_weakness",
      priority: 5,
      title:    `${worst[0]} is dragging your P&L`,
      body:     `${worst[1].sold} sells, $${r2(worst[1].totalProfit)} net. Consider avoiding ${worst[0]} until you find better sources.`,
      category: worst[0],
      totalProfit: r2(worst[1].totalProfit),
      actionable: false,
    });
  }

  return insights;
}

// ── Override outcome analysis ─────────────────────────────────────────────────

function analyzeOverrides(scans) {
  const overrideScans = scans.filter(s => s.decision?.wasOverride && s.outcome?.outcomeStatus === "SOLD");
  if (overrideScans.length < 3) return null;

  const positiveOverrides = overrideScans.filter(s => {
    const orig = s.decision.originalSignal;
    return ["RISKY", "INSUFFICIENT DATA", "OVERPRICED"].includes(orig) && s.decision.decision === "BUY";
  });
  const wins = positiveOverrides.filter(s => (s.outcome?.netProfit ?? 0) > 0).length;
  const winRate = positiveOverrides.length > 0 ? r2((wins / positiveOverrides.length) * 100) : null;

  if (positiveOverrides.length >= 2) {
    return {
      type:     "override_pattern",
      priority: winRate && winRate > 60 ? 3 : 6,
      title:    winRate && winRate > 60
        ? `You beat Evan's signal ${winRate}% of the time — your instincts are sharp`
        : `Buying against Evan's signal is costing you`,
      body: winRate && winRate > 60
        ? `${positiveOverrides.length} times you bought when Evan said risky/insufficient — ${wins} were profitable. Your domain expertise adds real edge.`
        : `${positiveOverrides.length} override buys against negative signals — only ${wins} profitable. Trust the signal more in this category.`,
      overrideCount:   positiveOverrides.length,
      winRate,
      actionable: false,
    };
  }
  return null;
}

// ── Capital concentration warning ─────────────────────────────────────────────

function analyzeCapitalConcentration(inventory) {
  if (inventory.length === 0) return null;
  const totalCapital = inventory.reduce((s, i) => s + (i.purchasePrice || 0), 0);
  if (totalCapital < 100) return null;

  const catTotals = {};
  for (const item of inventory) {
    const cat = item.category || "unknown";
    catTotals[cat] = (catTotals[cat] || 0) + (item.purchasePrice || 0);
  }

  const topCat  = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
  const topPct  = r2((topCat[1] / totalCapital) * 100);

  if (topPct > 70 && inventory.length > 3) {
    return {
      type:     "capital_concentration",
      priority: 6,
      title:    `${topPct}% of your capital is in ${topCat[0]}`,
      body:     `$${r2(topCat[1])} of $${r2(totalCapital)} total inventory capital is concentrated in ${topCat[0]}. Diversify to reduce risk.`,
      category: topCat[0],
      pct:      topPct,
      totalCapital: r2(totalCapital),
      actionable: false,
    };
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _empty() {
  return { ok: true, count: 0, insights: [], generatedAt: Date.now() };
}

function r2(n) { return Math.round(n * 100) / 100; }
