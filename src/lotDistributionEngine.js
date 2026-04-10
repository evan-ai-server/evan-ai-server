// src/lotDistributionEngine.js
// Phase 10 — Bulk Lot Cost-Basis Distribution Engine.
//
// When a reseller buys a bulk lot of 100+ items for a single lump price,
// the cost basis must be allocated to each child item accurately for:
//   - Correct per-item P&L
//   - Tax-accurate COGS tracking
//   - Signal accuracy measurement (expected vs realized profit delta)
//
// Three distribution strategies:
//
//   EQUAL             — totalPaid / itemCount (no value signals needed)
//   SIGNAL_WEIGHTED   — weights by lot tier score (A=1.5x, B=1.2x, C=1.0, D=0.7x, F=0.4x)
//   MARKET_PROPORTIONAL — weights by estimatedValue from lot scanner output
//
// The default for bulk liquidation lots is SIGNAL_WEIGHTED — it correctly
// assigns more cost basis to the highest-value items in the lot.
//
// Output: array of childItems[], each with:
//   - Allocated acquisitionCost (their share of totalPaid)
//   - Inherited lot metadata (lotId, sourceType, acquisitionDate)
//   - Their original scan/signal data preserved intact
//
// Redis key layout:
//   p10:dist:{lotId}        STRING  distribution record (2yr TTL)
//   p10:dist:ops            HASH    counters

import crypto from "crypto";
import { createInventoryItem, SOURCE_TYPE } from "./inventoryEngine.js";
import { recordPurchase, RELATED_TYPE }     from "./transactionLedger.js";
import { getCategoryMultiplier }            from "./payloadRegistry.js";

// ── Distribution strategy constants ───────────────────────────────────────────

export const DIST_STRATEGY = Object.freeze({
  EQUAL:              "EQUAL",
  SIGNAL_WEIGHTED:    "SIGNAL_WEIGHTED",
  MARKET_PROPORTIONAL:"MARKET_PROPORTIONAL",
});

// Tier weight multipliers for SIGNAL_WEIGHTED distribution
const TIER_WEIGHTS = { A: 1.50, B: 1.20, C: 1.00, D: 0.70, F: 0.40, "?": 0.85 };

const DIST_TTL = 2 * 365 * 86400;
const KEY_DIST = (lotId) => `p10:dist:${lotId}`;
const KEY_OPS  = () => `p10:dist:ops`;

// ── Core distributor ──────────────────────────────────────────────────────────

/**
 * Distribute a lot's total cost across its child items.
 *
 * @param {object} redis
 * @param {object} opts
 *   lotId        {string}          required — parent lot
 *   userId       {string}          required — lot owner
 *   totalPaid    {number}          required — total dollars paid for the lot
 *   items        {object[]}        required — ranked items from lotScanner/lotAssessmentEngine
 *                                  Each item must have: { scanId, itemName, category, tier,
 *                                    lotScore, confidence, estimatedCost?, expectedProfit? }
 *   strategy     {string}          DIST_STRATEGY value (default: SIGNAL_WEIGHTED)
 *   sourceType   {string}          SOURCE_TYPE value for child inventory items
 *   acquiredAt   {number|null}     ms timestamp of lot acquisition
 *   notes        {string|null}
 *   dryRun       {boolean}         if true, compute allocation but don't write inventory
 * @returns {DistributionResult}
 */
export async function distributeLot(redis, {
  lotId,
  userId,
  totalPaid,
  items               = [],
  strategy            = DIST_STRATEGY.SIGNAL_WEIGHTED,
  sourceType          = SOURCE_TYPE.OTHER,
  acquiredAt          = null,
  notes               = null,
  dryRun              = false,
  useCategoryMultiplier = false,  // when true, SIGNAL_WEIGHTED applies payload multipliers
} = {}) {
  if (!redis)      return { ok: false, error: "no_redis" };
  if (!lotId)      return { ok: false, error: "missing_lot_id" };
  if (!userId)     return { ok: false, error: "missing_user_id" };
  if (!items.length) return { ok: false, error: "no_items_to_distribute" };

  const total = Number(totalPaid);
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: "invalid_total_paid" };

  const validStrategy = DIST_STRATEGY[strategy] || DIST_STRATEGY.SIGNAL_WEIGHTED;
  const ts = acquiredAt != null ? Number(acquiredAt) : Date.now();

  // ── Compute raw weights ───────────────────────────────────────────────────
  const weights = _computeWeights(items, validStrategy, useCategoryMultiplier);
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  if (totalWeight <= 0) return { ok: false, error: "zero_weight_distribution" };

  // ── Allocate cost basis ───────────────────────────────────────────────────
  const allocations = items.map((item, i) => {
    const share    = weights[i] / totalWeight;
    const cost     = r2(total * share);
    return { item, cost, share: r2(share * 100) };
  });

  // Fix rounding: ensure sum == totalPaid exactly
  const allocated = allocations.reduce((s, a) => s + a.cost, 0);
  const delta     = r2(total - allocated);
  if (allocations.length > 0 && delta !== 0) {
    allocations[0].cost = r2(allocations[0].cost + delta);
  }

  // ── Build child item records ──────────────────────────────────────────────
  const childItems = [];
  const invIds     = [];
  const errors     = [];

  for (const { item, cost, share } of allocations) {
    const childRecord = {
      scanId:         item.scanId    || null,
      itemName:       item.itemName  || null,
      category:       item.category  || "generic",
      allocatedCost:  cost,
      costSharePct:   share,
      tier:           item.tier      || "?",
      lotScore:       item.lotScore  || 0,
      confidence:     item.confidence|| 0,
      expectedProfit: item.expectedProfit || null,
      flags:          item.flags     || [],
      lotId,
      strategy:       validStrategy,
    };

    if (!dryRun && item.scanId) {
      const inv = await createInventoryItem(redis, {
        userId,
        scanId:        item.scanId,
        category:      item.category  || null,
        itemName:      item.itemName  || null,
        purchasePrice: cost,
        askPrice:      item.estimatedCost || null,
        sourceType,
        signal:        item.signal    || null,
        trustScore:    item.trustScore || null,
        conditionNotes:`Bulk lot ${lotId} | tier ${item.tier} | ${share}% cost share`,
        notes:         notes || null,
      }).catch(() => null);

      if (inv?.ok) {
        childRecord.invId = inv.invId;
        invIds.push(inv.invId);
      } else {
        errors.push({ scanId: item.scanId, error: "inv_create_failed" });
      }
    }

    childItems.push(childRecord);
  }

  // ── Record lot-level purchase in ledger ───────────────────────────────────
  let ledgerEntry = null;
  if (!dryRun) {
    ledgerEntry = await recordPurchase(redis, userId, {
      amount:      total,
      invId:       lotId,             // lot itself as the related entity
      description: `Bulk lot acquisition: ${lotId} (${items.length} items, ${validStrategy} distribution)`,
      recordedBy:  "lotDistributionEngine",
    }).catch(() => null);
  }

  // ── Persist distribution record ───────────────────────────────────────────
  const distRecord = {
    lotId,
    userId,
    totalPaid:    total,
    strategy:     validStrategy,
    itemCount:    items.length,
    childItems,
    invIds,
    errors,
    ledgerEntryId: ledgerEntry?.txnId || null,
    dryRun,
    createdAt:    Date.now(),
  };

  if (!dryRun) {
    await redis.set(KEY_DIST(lotId), JSON.stringify(distRecord), "EX", DIST_TTL).catch(() => {});
    await redis.hincrby(KEY_OPS(), "total_lots_distributed", 1).catch(() => {});
    await redis.hincrby(KEY_OPS(), "total_items_distributed", items.length).catch(() => {});
  }

  return {
    ok:            true,
    lotId,
    strategy:      validStrategy,
    totalPaid:     total,
    itemCount:     items.length,
    itemsCreated:  invIds.length,
    errors,
    childItems,
    ledgerEntryId: ledgerEntry?.txnId || null,
    dryRun,
    summary: {
      avgCostPerItem:  r2(total / items.length),
      minCostAssigned: r2(Math.min(...allocations.map(a => a.cost))),
      maxCostAssigned: r2(Math.max(...allocations.map(a => a.cost))),
      tierDistribution: _tierDistribution(items),
    },
  };
}

/**
 * Retrieve a persisted distribution record.
 */
export async function getDistributionRecord(redis, lotId) {
  if (!redis || !lotId) return null;
  try {
    const raw = await redis.get(KEY_DIST(lotId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Ops counters.
 */
export async function getDistributionOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalLotsDistributed: ops["total_lots_distributed"] || 0,
      totalItemsDistributed: ops["total_items_distributed"] || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _computeWeights(items, strategy, useCategoryMultiplier = false) {
  switch (strategy) {
    case DIST_STRATEGY.EQUAL:
      return items.map(() => 1);

    case DIST_STRATEGY.SIGNAL_WEIGHTED:
      return items.map(item => {
        const tierW = TIER_WEIGHTS[item.tier || "?"] ?? 1.0;
        const confW = item.confidence > 0 ? item.confidence : 0.5;
        // Payload category multiplier: high-demand verticals (designer apparel,
        // vintage electronics) receive heavier cost-basis allocation.
        const catW  = useCategoryMultiplier
          ? getCategoryMultiplier(item.category, item.itemName)
          : 1.0;
        return tierW * confW * catW;
      });

    case DIST_STRATEGY.MARKET_PROPORTIONAL: {
      const values = items.map(item => {
        // Prefer estimatedValue → estimatedCost → fallback to 1
        const est = item.estimatedValue ?? item.estimatedCost ?? null;
        return est != null && Number.isFinite(Number(est)) && Number(est) > 0
          ? Number(est) : 1;
      });
      return values;
    }

    default:
      return items.map(() => 1);
  }
}

function _tierDistribution(items) {
  const counts = {};
  for (const item of items) {
    const t = item.tier || "?";
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
