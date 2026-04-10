// src/lotAssessmentEngine.js
// Phase 10 — Lot Assessment Engine.
//
// Extends Phase 3's lotScanner.js with durable persistence.
// A "lot" is a named, persistent group of scans sourced from a single
// buying event (estate sale, thrift run, pawn shop visit, online lot purchase).
//
// The existing evaluateLot() in lotScanner.js runs an ad-hoc ranked evaluation
// of scan IDs but does not persist the lot record. This engine adds:
//   - Named, persistent lot records stored in Redis
//   - Status lifecycle: DRAFT → ACTIVE → CLOSED
//   - Frozen lot summary snapshot at close time
//   - Per-user lot index for portfolio-level lot P&L
//
// Redis key layout:
//   p10:lot:{lotId}            STRING  full lot JSON (2yr TTL)
//   p10:lot:user:{userId}      ZSET    lotIds scored by createdAt (2yr TTL)
//   p10:lot:ops                HASH    aggregate counters

import crypto from "crypto";
import { evaluateLot } from "./lotScanner.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LOT_TTL = 2 * 365 * 86400;
const MAX_LOTS_PER_USER = 5_000;

export const LOT_STATUS = Object.freeze({
  DRAFT:  "DRAFT",
  ACTIVE: "ACTIVE",
  CLOSED: "CLOSED",
});

export const LOT_SOURCE_TYPE = Object.freeze({
  ESTATE_SALE:   "ESTATE_SALE",
  FLEA_MARKET:   "FLEA_MARKET",
  THRIFT:        "THRIFT",
  PAWN:          "PAWN",
  ONLINE:        "ONLINE",
  CONSIGNMENT:   "CONSIGNMENT",
  AUCTION:       "AUCTION",
  OTHER:         "OTHER",
});

const VALID_SOURCE_TYPES = new Set(Object.values(LOT_SOURCE_TYPE));

// ── Redis key helpers ─────────────────────────────────────────────────────────

const KEY_LOT  = (id)     => `p10:lot:${id}`;
const KEY_USER = (userId) => `p10:lot:user:${userId}`;
const KEY_OPS  = ()       => `p10:lot:ops`;

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a new persistent lot record.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId       {string}          required
 *   name         {string}          required — e.g., "Estate sale - Oak Park March 2026"
 *   sourceType   {string}          LOT_SOURCE_TYPE value
 *   location     {string|null}     where the lot was sourced from
 *   totalPaid    {number|null}     total price paid for the entire lot
 *   notes        {string|null}
 * @returns {Promise<{ ok, lotId, lot }>}
 */
export async function createLot(redis, {
  userId,
  name,
  sourceType = LOT_SOURCE_TYPE.OTHER,
  location   = null,
  totalPaid  = null,
  notes      = null,
} = {}) {
  if (!redis)  return { ok: false, error: "no_redis" };
  if (!userId) return { ok: false, error: "missing_user_id" };
  if (!name)   return { ok: false, error: "missing_name" };

  const srcType = normSourceType(sourceType);
  const now     = Date.now();
  const lotId   = _genLotId();
  const tp      = finiteNonNeg(totalPaid) ?? null;

  const lot = {
    lotId,
    userId,
    name:       String(name).slice(0, 200),
    sourceType: srcType,
    location:   location ? String(location).slice(0, 200) : null,
    totalPaid:  tp,
    notes:      notes ? String(notes).slice(0, 1000) : null,
    status:     LOT_STATUS.DRAFT,
    // Items added via addItemsToLot
    items:      [],
    itemCount:  0,
    // Computed aggregates (populated on addItems and closeLot)
    totalEstimatedValue:  null,
    totalEstimatedProfit: null,
    groupROI:             null,
    buyTargetCount:       null,
    skipCount:            null,
    avgConfidence:        null,
    // Lifecycle
    closedAt:   null,
    closedSummary: null,
    createdAt:  now,
    updatedAt:  now,
  };

  try {
    const pipe = redis.pipeline();
    pipe.set(KEY_LOT(lotId), JSON.stringify(lot), "EX", LOT_TTL);
    pipe.zadd(KEY_USER(userId), now, lotId);
    pipe.zremrangebyrank(KEY_USER(userId), 0, -(MAX_LOTS_PER_USER + 1));
    pipe.expire(KEY_USER(userId), LOT_TTL);
    pipe.hincrby(KEY_OPS(), "total_created", 1);
    await pipe.exec();

    return { ok: true, lotId, lot };
  } catch (err) {
    return { ok: false, error: "lot_create_failed", reason: err?.message };
  }
}

// ── Add items to a lot ────────────────────────────────────────────────────────

/**
 * Evaluate scan IDs and add their assessment to a lot.
 * Calls the existing evaluateLot() from lotScanner.js, then persists results.
 *
 * @param {object} redis
 * @param {string} lotId
 * @param {string[]} scanIds     — up to 50 scan IDs per call
 * @param {object} opts
 *   lotBudget  {number|null}   total cash available (for budget allocation advice)
 *   userId     {string}        required for lotScanner.js
 * @returns {Promise<{ ok, lot, evaluation }>}
 */
export async function addItemsToLot(redis, lotId, scanIds, { lotBudget = null, userId } = {}) {
  if (!redis || !lotId)            return { ok: false, error: "missing_required" };
  if (!Array.isArray(scanIds) || scanIds.length === 0) {
    return { ok: false, error: "no_scan_ids" };
  }

  const lot = await getLot(redis, lotId);
  if (!lot)                        return { ok: false, error: "lot_not_found" };
  if (lot.status === LOT_STATUS.CLOSED) {
    return { ok: false, error: "lot_closed" };
  }

  // Run lotScanner evaluation
  const evaluation = await evaluateLot(redis, {
    userId: userId || lot.userId,
    scanIds,
    lotBudget,
  });

  if (!evaluation.ok) {
    return { ok: false, error: evaluation.error || "evaluation_failed" };
  }

  // Merge new items into lot.items (by scanId, deduplicate)
  const existingIds = new Set((lot.items || []).map(i => i.scanId));
  const newItems = (evaluation.rankedItems || [])
    .filter(i => !existingIds.has(i.scanId))
    .map(i => ({
      scanId:          i.scanId,
      itemName:        i.itemName,
      category:        i.category,
      signal:          i.signal,
      trustScore:      i.trustScore,
      tier:            i.tier,
      lotScore:        i.lotScore,
      confidence:      i.confidence,
      estimatedCost:   i.estimatedCost,
      expectedProfit:  i.expectedProfit,
      flags:           i.flags,
      alreadyOwned:    i.alreadyOwned,
      invId:           i.invId,
      addedAt:         Date.now(),
    }));

  lot.items = [...(lot.items || []), ...newItems];

  // Re-sort by lotScore descending
  lot.items.sort((a, b) => (b.lotScore || 0) - (a.lotScore || 0));

  // Recompute aggregates
  _recomputeAggregates(lot, evaluation);

  lot.status    = LOT_STATUS.ACTIVE;  // auto-activate once items exist
  lot.updatedAt = Date.now();

  try {
    await redis.set(KEY_LOT(lotId), JSON.stringify(lot), "EX", LOT_TTL);
    await redis.hincrby(KEY_OPS(), "total_items_added", newItems.length);
    return { ok: true, lot, evaluation };
  } catch (err) {
    return { ok: false, error: "lot_update_failed", reason: err?.message };
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getLot(redis, lotId) {
  if (!redis || !lotId) return null;
  try {
    const raw = await redis.get(KEY_LOT(lotId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Get lots for a user.
 */
export async function getUserLots(redis, userId, {
  status = null,
  limit  = 20,
  offset = 0,
} = {}) {
  if (!redis || !userId) return { lots: [], total: 0 };
  try {
    const [ids, total] = await Promise.all([
      redis.zrevrangebyscore(KEY_USER(userId), "+inf", "-inf", "LIMIT", offset, limit),
      redis.zcard(KEY_USER(userId)),
    ]);
    if (!ids?.length) return { lots: [], total };

    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_LOT(id));
    const results = await pipe.exec();

    const all = results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);

    const filtered = status ? all.filter(l => l.status === status) : all;
    return { lots: filtered, total };
  } catch { return { lots: [], total: 0 }; }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Close a lot — marks it CLOSED and freezes the summary snapshot.
 * No further items can be added after closing.
 */
export async function closeLot(redis, lotId, { notes = null } = {}) {
  if (!redis || !lotId) return { ok: false, error: "missing_required" };
  const lot = await getLot(redis, lotId);
  if (!lot) return { ok: false, error: "lot_not_found" };
  if (lot.status === LOT_STATUS.CLOSED) return { ok: false, error: "already_closed" };

  const now = Date.now();

  // Freeze summary
  lot.closedSummary = {
    itemCount:            lot.itemCount,
    buyTargetCount:       lot.buyTargetCount,
    skipCount:            lot.skipCount,
    totalEstimatedValue:  lot.totalEstimatedValue,
    totalEstimatedProfit: lot.totalEstimatedProfit,
    groupROI:             lot.groupROI,
    avgConfidence:        lot.avgConfidence,
    topPick:              lot.items?.[0] || null,
    frozenAt:             now,
    notes:                notes ? String(notes).slice(0, 1000) : null,
  };

  lot.status    = LOT_STATUS.CLOSED;
  lot.closedAt  = now;
  lot.updatedAt = now;

  try {
    await redis.set(KEY_LOT(lotId), JSON.stringify(lot), "EX", LOT_TTL);
    await redis.hincrby(KEY_OPS(), "total_closed", 1);
    return { ok: true, lot };
  } catch (err) {
    return { ok: false, error: "lot_close_failed", reason: err?.message };
  }
}

/**
 * Get lot ops counters.
 */
export async function getLotOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalCreated:   ops["total_created"]      || 0,
      totalItemsAdded:ops["total_items_added"]  || 0,
      totalClosed:    ops["total_closed"]        || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Recompute aggregate fields on a lot from its items array + the latest evaluation.
 */
function _recomputeAggregates(lot, evaluation) {
  const items = lot.items || [];
  lot.itemCount        = items.length;
  lot.buyTargetCount   = items.filter(i => i.tier === "A" || i.tier === "B").length;
  lot.skipCount        = items.filter(i => i.tier === "D" || i.tier === "F").length;
  lot.avgConfidence    = items.length > 0
    ? r2(items.reduce((s, i) => s + (i.confidence || 0), 0) / items.length)
    : null;

  // Use evaluation financials if available
  if (evaluation?.financials) {
    lot.totalEstimatedValue  = evaluation.financials.totalExpectedRevenue  || null;
    lot.totalEstimatedProfit = evaluation.financials.totalExpectedProfit   || null;
    lot.groupROI             = evaluation.financials.expectedMarginPct     || null;
  } else {
    // Recompute from items
    const buyTargets = items.filter(i => i.tier === "A" || i.tier === "B");
    const cost       = buyTargets.reduce((s, i) => s + (i.estimatedCost ?? 0), 0);
    const profit     = buyTargets.reduce((s, i) => s + (i.expectedProfit?.mid ?? 0), 0);
    lot.totalEstimatedProfit = r2(profit);
    lot.totalEstimatedValue  = r2(cost + profit);
    lot.groupROI             = cost > 0 ? r2((profit / cost) * 100) : null;
  }
}

function _genLotId() {
  return "lot_" + crypto.randomBytes(8).toString("hex");
}

function normSourceType(v) {
  const u = String(v || "").toUpperCase().trim();
  return VALID_SOURCE_TYPES.has(u) ? u : LOT_SOURCE_TYPE.OTHER;
}

function finiteNonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
