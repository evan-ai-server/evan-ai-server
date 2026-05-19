// src/portfolioCapitalEngine.js
// Portfolio Capital Allocator — identifies trapped capital and blocks new buys
// when the user's existing inventory demands action first.
//
// Design rules:
//   - Reads BOUGHT/LISTED items from Redis outcome states
//   - Ranks by capital risk: CRITICAL > HIGH > MEDIUM > LOW
//   - Emits a SELL_FIRST block signal when urgency threshold is met
//   - Never touches Postgres directly — delegates persistence to outcomeEngine
//   - All blocking decisions are explainable in plain text

import { computeDaysHeld, buildFullExitIntel, computeCapitalRisk } from "./exitIntelligence.js";

// Redis key patterns (mirror outcomeEngine.js)
const KEY_OUTCOME_STATE = (uid, sid) => `outcome:state:${uid}:${sid}`;
const KEY_OUTCOME_IDX   = (uid)       => `outcome:idx:${uid}`;

// Capital block thresholds
const BLOCK_CRITICAL_COUNT  = 1;  // any CRITICAL item → SELL_FIRST block
const BLOCK_HIGH_COUNT      = 3;  // 3+ HIGH items → SELL_FIRST block
const BLOCK_TOTAL_CAPITAL   = 500; // $500+ trapped at HIGH/CRITICAL risk → block

/**
 * Load all active (BOUGHT or LISTED) outcome states for a user from Redis.
 *
 * @returns {Array<object>} array of outcome state objects
 */
async function loadActivePortfolioItems(redis, userId) {
  if (!redis || !userId) return [];
  try {
    const scanIds = await redis.smembers(KEY_OUTCOME_IDX(userId)).catch(() => []);
    if (!scanIds?.length) return [];

    const raw = await Promise.all(
      scanIds.map(sid => redis.get(KEY_OUTCOME_STATE(userId, sid)).catch(() => null))
    );

    return raw
      .filter(Boolean)
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(item => item && ["BOUGHT", "LISTED"].includes(item.lifecycleState));
  } catch { return []; }
}

/**
 * Analyze the user's portfolio for trapped capital.
 * Enriches each active item with exit intel and capital risk tier.
 *
 * @returns {{
 *   items: Array<object>,  — enriched portfolio items
 *   criticalCount: number,
 *   highCount: number,
 *   totalTrappedCapital: number,  — sum of purchasePrice for HIGH+CRITICAL items
 *   oldestItem: object | null,
 *   dominantRisk: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"
 * }}
 */
export async function analyzePortfolioCapital(redis, userId) {
  const _empty = {
    items: [], criticalCount: 0, highCount: 0,
    totalTrappedCapital: 0, oldestItem: null, dominantRisk: "LOW",
  };

  if (!redis || !userId) return _empty;

  try {
    const activeItems = await loadActivePortfolioItems(redis, userId);
    if (!activeItems.length) return _empty;

    const enriched = activeItems.map(item => {
      const daysHeld    = computeDaysHeld(item);
      // Use stored liquidityTier if available, default DEVELOPING
      const liquidityTier = item.liquidityTier || "DEVELOPING";
      const capitalRisk = computeCapitalRisk(item, daysHeld, liquidityTier);

      const exitIntel = buildFullExitIntel(item, {
        daysHeld,
        liquidityTier,
        liquidityScore: item.liquidityScore ?? 0,
        medianDaysToSell: item.medianDaysToSell ?? 30,
        marketMedian: item.currentMedian ?? null,
        marketItems: [],
      });

      return { ...item, daysHeld, capitalRisk, exitIntel };
    });

    const criticalCount = enriched.filter(i => i.capitalRisk === "CRITICAL").length;
    const highCount     = enriched.filter(i => i.capitalRisk === "HIGH").length;
    const totalTrapped  = enriched
      .filter(i => ["HIGH", "CRITICAL"].includes(i.capitalRisk))
      .reduce((s, i) => s + (Number(i.purchasePrice) || 0), 0);

    const oldestItem = enriched.reduce((oldest, item) => {
      if (!oldest) return item;
      return item.daysHeld > oldest.daysHeld ? item : oldest;
    }, null);

    const dominantRisk = criticalCount > 0 ? "CRITICAL"
      : highCount > 0           ? "HIGH"
      : enriched.some(i => i.capitalRisk === "MEDIUM") ? "MEDIUM"
      : "LOW";

    return {
      items:               enriched,
      criticalCount,
      highCount,
      totalTrappedCapital: round2(totalTrapped),
      oldestItem,
      dominantRisk,
    };
  } catch { return _empty; }
}

/**
 * Rank portfolio items by urgency of capital release.
 * CRITICAL first, then HIGH, then by daysHeld descending within each tier.
 *
 * @param {Array<object>} portfolioItems — already enriched by analyzePortfolioCapital
 * @returns {Array<object>} sorted items
 */
export function rankCapitalReleaseOpportunities(portfolioItems) {
  if (!Array.isArray(portfolioItems)) return [];

  const rankMap = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return [...portfolioItems].sort((a, b) => {
    const rDiff = (rankMap[a.capitalRisk] ?? 3) - (rankMap[b.capitalRisk] ?? 3);
    if (rDiff !== 0) return rDiff;
    return (b.daysHeld || 0) - (a.daysHeld || 0); // older first within tier
  });
}

/**
 * Determine if a new buy should be blocked due to trapped capital.
 *
 * Returns null if no block is warranted.
 *
 * @param {{ criticalCount, highCount, totalTrappedCapital, oldestItem, dominantRisk }} portfolioSummary
 * @returns {{ shouldBlock: true, reason: string, urgentItems: Array<object>, urgencyLevel: "CRITICAL"|"HIGH" } | null}
 */
export function buildCapitalBlockSignal(portfolioSummary) {
  if (!portfolioSummary) return null;

  const { criticalCount, highCount, totalTrappedCapital, items = [], oldestItem } = portfolioSummary;

  // Block on any CRITICAL item
  if (criticalCount >= BLOCK_CRITICAL_COUNT) {
    const urgentItems = (items || [])
      .filter(i => i.capitalRisk === "CRITICAL")
      .slice(0, 3);
    const oldest = urgentItems[0];
    const reason = oldest
      ? `You have ${criticalCount} stale item${criticalCount > 1 ? "s" : ""} at critical capital risk — sell first (${oldest.category || "item"}, held ${oldest.daysHeld} days)`
      : `${criticalCount} item${criticalCount > 1 ? "s" : ""} at critical capital risk — exit before buying more`;
    return { shouldBlock: true, reason, urgentItems, urgencyLevel: "CRITICAL" };
  }

  // Block on 3+ HIGH-risk items
  if (highCount >= BLOCK_HIGH_COUNT) {
    const urgentItems = (items || [])
      .filter(i => ["HIGH", "CRITICAL"].includes(i.capitalRisk))
      .sort((a, b) => (b.daysHeld || 0) - (a.daysHeld || 0))
      .slice(0, 3);
    const reason = `${highCount} items at high capital risk — free up capital before buying more`;
    return { shouldBlock: true, reason, urgentItems, urgencyLevel: "HIGH" };
  }

  // Block on significant trapped capital in risky positions
  if (totalTrappedCapital >= BLOCK_TOTAL_CAPITAL && (criticalCount + highCount) >= 2) {
    const urgentItems = (items || [])
      .filter(i => ["HIGH", "CRITICAL"].includes(i.capitalRisk))
      .slice(0, 3);
    const reason = `$${Math.round(totalTrappedCapital)} in high-risk inventory — list items before committing more capital`;
    return { shouldBlock: true, reason, urgentItems, urgencyLevel: "HIGH" };
  }

  return null;
}

/**
 * Build the full portfolio capital allocator payload for a route response.
 *
 * @param {Array<object>} portfolioItems — enriched items from analyzePortfolioCapital
 * @returns {object} allocator payload
 */
export function buildCapitalAllocatorPayload(portfolioItems) {
  if (!Array.isArray(portfolioItems) || !portfolioItems.length) {
    return {
      ranked: [],
      totalItems: 0,
      totalCapitalDeployed: 0,
      totalTrappedCapital: 0,
      riskBreakdown: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
      topAction: null,
    };
  }

  const ranked = rankCapitalReleaseOpportunities(portfolioItems);

  const totalCapital = portfolioItems.reduce((s, i) => s + (Number(i.purchasePrice) || 0), 0);
  const trappedCapital = portfolioItems
    .filter(i => ["HIGH", "CRITICAL"].includes(i.capitalRisk))
    .reduce((s, i) => s + (Number(i.purchasePrice) || 0), 0);

  const riskBreakdown = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const item of portfolioItems) {
    if (riskBreakdown[item.capitalRisk] != null) riskBreakdown[item.capitalRisk]++;
  }

  // Top action = what to do with the most urgent item
  const topItem   = ranked[0];
  const topAction = topItem
    ? { scanId: topItem.scanId, category: topItem.category, action: topItem.exitIntel?.holdOrFold || "HOLD", capitalRisk: topItem.capitalRisk, daysHeld: topItem.daysHeld, recommendedListPrice: topItem.exitIntel?.recommendedListPrice || null, preferredPlatform: topItem.exitIntel?.preferredPlatform || null }
    : null;

  return {
    ranked: ranked.map(i => ({
      scanId:              i.scanId,
      category:            i.category,
      lifecycleState:      i.lifecycleState,
      daysHeld:            i.daysHeld,
      capitalRisk:         i.capitalRisk,
      purchasePrice:       Number(i.purchasePrice) || null,
      exitIntel:           i.exitIntel,
    })),
    totalItems:           portfolioItems.length,
    totalCapitalDeployed: round2(totalCapital),
    totalTrappedCapital:  round2(trappedCapital),
    riskBreakdown,
    topAction,
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(Number(v) * 100) / 100; }
