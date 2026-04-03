// src/lotScanner.js
// Phase 3 — Lot Scanner.
//
// Batch evaluation of multiple scan IDs as a group.
// Resellers buy in lots — evaluate 20 thrift store items in 10 minutes.
// Evan ranks them, flags risk, and computes expected group margin.
//
// Input:  POST /lot/evaluate { userId, scanIds[], opts }
// Output: ranked items, total expected margin, group confidence, warnings
//
// Uses:
//   - Signal snapshots from Phase 1 (loop:signal:{scanId})
//   - Source records from Phase 1 (loop:source:{scanId}) — if already bought
//   - Category domination data via live assessment
//   - Inventory data (already-bought items get OWNED flag)

import { getSignalSnapshot, getSource, getDecision } from "./closedLoopEngine.js";
import { getInvIdForScan, getInventoryItem } from "./inventoryEngine.js";

// ── Signal → expected metrics map ────────────────────────────────────────────
// Based on observed outcome distributions from closed-loop data.
// These are conservative estimates — actual outcomes vary.
const SIGNAL_EXPECTATIONS = {
  "STRONG BUY":        { minMarginPct: 40, maxMarginPct: 120, confidence: 0.82, tier: "A" },
  "GREAT FLIP":        { minMarginPct: 35, maxMarginPct: 100, confidence: 0.80, tier: "A" },
  "GOOD DEAL":         { minMarginPct: 15, maxMarginPct:  50, confidence: 0.65, tier: "B" },
  "FAIR":              { minMarginPct:  0, maxMarginPct:  20, confidence: 0.45, tier: "C" },
  "OVERPRICED":        { minMarginPct:-20, maxMarginPct:   0, confidence: 0.35, tier: "D" },
  "RISKY":             { minMarginPct:-50, maxMarginPct:  10, confidence: 0.25, tier: "F" },
  "INSUFFICIENT DATA": { minMarginPct: -5, maxMarginPct:  25, confidence: 0.30, tier: "C" },
};

const TIER_ORDER = { A: 0, B: 1, C: 2, D: 3, F: 4, "?": 5 };

// ── Main evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate a batch of scan IDs as a group (lot).
 *
 * @param {object} redis
 * @param {object} opts
 *   userId      {string}
 *   scanIds     {string[]}   up to 50 scan IDs
 *   lotBudget   {number|null} total cash available (for allocation advice)
 * @returns {LotEvaluationResult}
 */
export async function evaluateLot(redis, { userId, scanIds = [], lotBudget = null } = {}) {
  if (!redis || !userId) return _emptyLot("missing_redis_or_user");
  if (!Array.isArray(scanIds) || scanIds.length === 0) {
    return _emptyLot("no_scan_ids");
  }

  const ids = [...new Set(scanIds)].slice(0, 50);  // deduplicate, cap at 50

  // ── Fetch all data in parallel ─────────────────────────────────────────────
  const [signals, sources, decisions, invIds] = await Promise.all([
    fetchAll(ids, id => getSignalSnapshot(redis, id)),
    fetchAll(ids, id => getSource(redis, id)),
    fetchAll(ids, id => getDecision(redis, id)),
    fetchAll(ids, id => getInvIdForScan(redis, id)),
  ]);

  // Fetch inventory items for those that have been purchased
  const invItems = await Promise.all(
    invIds.map(invId => invId ? getInventoryItem(redis, invId) : null)
  );

  // ── Score each item ────────────────────────────────────────────────────────
  const scored = ids.map((scanId, i) => {
    const signal    = signals[i];
    const source    = sources[i];
    const decision  = decisions[i];
    const invId     = invIds[i];
    const invItem   = invItems[i];

    return scoreLotItem({ scanId, signal, source, decision, invId, invItem });
  });

  // ── Sort: tier (A→F) then lotScore descending ─────────────────────────────
  scored.sort((a, b) => {
    const tierDiff = (TIER_ORDER[a.tier] ?? 5) - (TIER_ORDER[b.tier] ?? 5);
    return tierDiff !== 0 ? tierDiff : b.lotScore - a.lotScore;
  });

  // ── Group aggregations ────────────────────────────────────────────────────
  const owned       = scored.filter(i => i.alreadyOwned);
  const buyTargets  = scored.filter(i => i.tier === "A" || i.tier === "B");
  const skipItems   = scored.filter(i => i.tier === "D" || i.tier === "F");
  const uncertain   = scored.filter(i => i.tier === "C" || i.tier === "?");

  const totalEstimatedCost = buyTargets.reduce((s, i) => s + (i.estimatedCost ?? 0), 0);
  const totalExpectedProfit = buyTargets.reduce((s, i) => s + (i.expectedProfit?.mid ?? 0), 0);
  const totalExpectedRevenue = totalEstimatedCost + totalExpectedProfit;
  const groupROI = totalEstimatedCost > 0
    ? r2((totalExpectedProfit / totalEstimatedCost) * 100)
    : null;

  // Budget allocation advice
  let budgetAdvice = null;
  if (lotBudget != null && Number.isFinite(lotBudget) && lotBudget > 0) {
    const affordable = buyTargets.filter(i => (i.estimatedCost ?? 0) <= lotBudget);
    const remaining  = lotBudget - affordable.reduce((s, i) => s + (i.estimatedCost ?? 0), 0);
    budgetAdvice = {
      budget:             r2(lotBudget),
      affordableBuys:     affordable.length,
      totalCostOfBuys:    r2(affordable.reduce((s, i) => s + (i.estimatedCost ?? 0), 0)),
      budgetRemaining:    r2(Math.max(0, remaining)),
      expectedProfitOnBuys: r2(affordable.reduce((s, i) => s + (i.expectedProfit?.mid ?? 0), 0)),
    };
  }

  // Group-level warnings
  const warnings = [];
  const riskyCount = skipItems.length;
  const totalCount = scored.length;
  if (riskyCount / totalCount > 0.5) {
    warnings.push("More than half the lot is risky or overpriced — selective buying recommended");
  }
  const avgConfidence = scored.reduce((s, i) => s + i.confidence, 0) / scored.length;
  if (avgConfidence < 0.40) {
    warnings.push("Group-wide confidence is low — many items lack clear identity signals");
  }
  if (owned.length > 0) {
    warnings.push(`${owned.length} item(s) are already in your inventory`);
  }

  return {
    ok:           true,
    totalScanned: ids.length,
    rankedItems:  scored,

    summary: {
      buyTargets:     buyTargets.length,
      skipItems:      skipItems.length,
      uncertain:      uncertain.length,
      alreadyOwned:   owned.length,
      avgConfidence:  r2(avgConfidence),
      groupROI,
    },

    financials: {
      totalEstimatedCost:   r2(totalEstimatedCost),
      totalExpectedRevenue: r2(totalExpectedRevenue),
      totalExpectedProfit:  r2(totalExpectedProfit),
      expectedMarginPct:    groupROI,
    },

    budgetAdvice,
    warnings,

    topPick:   scored[0] || null,
    worstPick: scored[scored.length - 1] || null,
  };
}

// ── Item scorer ───────────────────────────────────────────────────────────────

function scoreLotItem({ scanId, signal, source, decision, invId, invItem }) {
  const sigStr     = signal?.signal || null;
  const trust      = signal?.trustScore ?? 0.5;
  const category   = signal?.category   || null;
  const itemName   = signal?.itemName   || null;
  const expectations = SIGNAL_EXPECTATIONS[sigStr] || null;

  // Already owned → flag, don't score for buying
  const alreadyOwned  = Boolean(invId && invItem);
  const invStatus     = invItem?.status || null;

  // Purchase price (from source if already bought, or from signal scan price estimate)
  const purchasePrice = source?.purchasePrice ?? null;

  // Estimate cost if not purchased yet
  const estimatedCost = purchasePrice ?? null;

  // Expected profit range
  let expectedProfit = null;
  if (expectations && estimatedCost != null) {
    expectedProfit = {
      low: r2(estimatedCost * (expectations.minMarginPct / 100)),
      mid: r2(estimatedCost * ((expectations.minMarginPct + expectations.maxMarginPct) / 200)),
      high: r2(estimatedCost * (expectations.maxMarginPct / 100)),
    };
  } else if (expectations) {
    // No price known — use signal expectations qualitatively
    expectedProfit = {
      low: null,
      mid: null,
      high: null,
    };
  }

  // Lot score: 0-1 combining signal quality + trust
  const sigScore = expectations ? (1 - (TIER_ORDER[expectations.tier] ?? 5) / 5) : 0.3;
  const lotScore = r2(sigScore * 0.65 + trust * 0.35);

  const tier       = expectations?.tier ?? "?";
  const confidence = r2((expectations?.confidence ?? 0.30) * (0.6 + trust * 0.4));

  // Item-level flags
  const flags = [];
  if (!sigStr) flags.push("no_signal");
  if (trust < 0.4) flags.push("low_trust");
  if (sigStr === "RISKY") flags.push("counterfeit_risk");
  if (sigStr === "OVERPRICED") flags.push("overpriced");
  if (decision?.decision === "PASS") flags.push("previously_passed");
  if (decision?.decision === "BUY" && !alreadyOwned) flags.push("decided_buy_not_tracked");
  if (alreadyOwned) flags.push("already_owned");
  if (invStatus && invStatus !== "ACTIVE") flags.push(`inventory_${invStatus.toLowerCase()}`);

  return {
    scanId,
    itemName,
    category,
    signal:       sigStr,
    trustScore:   trust,
    tier,
    lotScore,
    confidence,
    estimatedCost,
    expectedProfit,
    flags,
    alreadyOwned,
    invId:        invId || null,
    decision:     decision?.decision || null,
    purchasedAt:  source?.capturedAt || null,
    purchasePrice,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchAll(ids, fetchFn) {
  return Promise.all(ids.map(id => fetchFn(id).catch(() => null)));
}

function _emptyLot(error) {
  return { ok: false, error, totalScanned: 0, rankedItems: [], summary: null, financials: null };
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
