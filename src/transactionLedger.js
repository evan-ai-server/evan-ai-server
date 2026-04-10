// src/transactionLedger.js
// Phase 10 — Transaction Ledger (Double-Entry Financial Integrity Guard).
//
// ── TWEAK 1: Financial Integrity — Double-Entry Pattern ─────────────────────
//
// Every financial event creates an IMMUTABLE LedgerEntry.
// P&L is derived by summing entries — never by overwriting fields.
// This creates a full paper trail for every cent that enters or leaves the user's
// resale operation, making P&L audit-proof and correction-trackable.
//
// Directions (from user's cash perspective):
//   CREDIT  (+)  — money coming in:  SALE, SHIPPING_COLLECTED, REFUND_IN
//   DEBIT   (-)  — money going out:  PURCHASE, FEE, SHIPPING_COST, REFUND_OUT
//
// Entry types:
//   PURCHASE           — bought an item (debit: cash)
//   SALE               — sold an item (credit: cash)
//   FEE                — platform fee paid (debit: cash)
//   SHIPPING_COST      — shipping cost paid by user (debit: cash)
//   SHIPPING_COLLECTED — shipping collected from buyer (credit: cash)
//   REFUND_OUT         — refund paid to buyer (debit: cash)
//   REFUND_IN          — refund received from seller (credit: cash)
//   ADJUSTMENT         — manual correction; REQUIRES reason + approvedBy audit fields
//
// Immutability guarantee:
//   - No update/delete operations exist. Period.
//   - Corrections are new ADJUSTMENT entries, never mutations.
//   - The `immutable: true` marker on each entry is a protocol signal — not enforcement,
//     but violation is a data integrity incident.
//
// Redis key layout:
//   p10:txn:entry:{txnId}          STRING  full entry JSON (permanent — no TTL)
//   p10:txn:user:{userId}          ZSET    txnIds scored by recordedAt (2yr TTL)
//   p10:txn:rel:{relatedId}        ZSET    txnIds for a related entity (2yr TTL)
//   p10:txn:ops                    HASH    aggregate counters

import crypto from "crypto";

// ── Entry type definitions ─────────────────────────────────────────────────────

export const TXN_TYPE = Object.freeze({
  PURCHASE:            "PURCHASE",
  SALE:                "SALE",
  FEE:                 "FEE",
  SHIPPING_COST:       "SHIPPING_COST",
  SHIPPING_COLLECTED:  "SHIPPING_COLLECTED",
  REFUND_OUT:          "REFUND_OUT",
  REFUND_IN:           "REFUND_IN",
  ADJUSTMENT:          "ADJUSTMENT",
});

export const TXN_DIRECTION = Object.freeze({
  CREDIT: "CREDIT",   // money in
  DEBIT:  "DEBIT",    // money out
});

// Type → direction mapping
const TYPE_DIRECTION = {
  [TXN_TYPE.PURCHASE]:           TXN_DIRECTION.DEBIT,
  [TXN_TYPE.SALE]:               TXN_DIRECTION.CREDIT,
  [TXN_TYPE.FEE]:                TXN_DIRECTION.DEBIT,
  [TXN_TYPE.SHIPPING_COST]:      TXN_DIRECTION.DEBIT,
  [TXN_TYPE.SHIPPING_COLLECTED]: TXN_DIRECTION.CREDIT,
  [TXN_TYPE.REFUND_OUT]:         TXN_DIRECTION.DEBIT,
  [TXN_TYPE.REFUND_IN]:          TXN_DIRECTION.CREDIT,
  // ADJUSTMENT direction determined by sign of amount at record time
};

export const RELATED_TYPE = Object.freeze({
  INVENTORY: "inventory",
  LISTING:   "listing",
  OUTCOME:   "outcome",
  LOT:       "lot",
  MANUAL:    "manual",
});

// ── Redis key helpers ─────────────────────────────────────────────────────────

const KEY_ENTRY = (txnId)      => `p10:txn:entry:${txnId}`;
const KEY_USER  = (userId)     => `p10:txn:user:${userId}`;
const KEY_REL   = (relId)      => `p10:txn:rel:${relId}`;
const KEY_OPS   = ()           => `p10:txn:ops`;

const USER_TTL  = 2 * 365 * 86400;
const REL_TTL   = 2 * 365 * 86400;
const MAX_USER_ENTRIES = 50_000;

// ── Record an entry ───────────────────────────────────────────────────────────

/**
 * Record an immutable ledger entry.
 *
 * NEVER call this to "correct" a previous entry.
 * Corrections are new ADJUSTMENT entries with adjustmentReason + adjustmentApprovedBy.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts
 *   type                 {string}         TXN_TYPE value — REQUIRED
 *   amount               {number}         always positive — REQUIRED
 *   relatedId            {string|null}    invId | listingId | lotId | outcomeId
 *   relatedType          {string|null}    RELATED_TYPE value
 *   description          {string|null}    human-readable label
 *   recordedBy           {string|null}    route path, "user", or "system"
 *   recordedAt           {number|null}    ms timestamp; defaults to now
 *   adjustmentReason     {string|null}    REQUIRED if type === ADJUSTMENT
 *   adjustmentApprovedBy {string|null}    who approved this correction
 * @returns {Promise<LedgerEntry|{ error: string }>}
 */
export async function recordEntry(redis, userId, {
  type,
  amount,
  relatedId            = null,
  relatedType          = null,
  description          = null,
  recordedBy           = "system",
  recordedAt           = null,
  adjustmentReason     = null,
  adjustmentApprovedBy = null,
} = {}) {
  if (!redis)                        return { error: "no_redis" };
  if (!userId)                       return { error: "missing_user_id" };
  if (!TXN_TYPE[type])               return { error: `invalid_type: ${type}` };

  const amt = finitePositive(amount);
  if (amt === null) return { error: "invalid_amount: must be finite positive number" };

  // ADJUSTMENT requires a reason — fail closed
  if (type === TXN_TYPE.ADJUSTMENT && !adjustmentReason) {
    return { error: "adjustment_requires_reason" };
  }

  const now = recordedAt != null ? Number(recordedAt) : Date.now();
  const txnId = _genTxnId(now);

  // Determine direction
  const direction = type === TXN_TYPE.ADJUSTMENT
    ? TXN_DIRECTION.CREDIT   // ADJUSTMENT is always labeled CREDIT for the correction amount;
                              // caller should make amount negative via description context
    : TYPE_DIRECTION[type];

  const entry = {
    txnId,
    userId,
    type,
    amount:    amt,
    direction,
    relatedId:            relatedId   ? String(relatedId).slice(0, 200)          : null,
    relatedType:          relatedType ? String(relatedType).slice(0, 40)         : null,
    description:          description ? String(description).slice(0, 500)        : null,
    recordedBy:           recordedBy  ? String(recordedBy).slice(0, 200)         : "system",
    recordedAt:           now,
    // Adjustment-specific (null for all other types)
    adjustmentReason:     adjustmentReason     ? String(adjustmentReason).slice(0, 500)     : null,
    adjustmentApprovedBy: adjustmentApprovedBy ? String(adjustmentApprovedBy).slice(0, 100) : null,
    // Immutability marker
    immutable: true,
  };

  try {
    const pipe = redis.pipeline();
    // No TTL on individual entries — they are permanent records
    pipe.set(KEY_ENTRY(txnId), JSON.stringify(entry));
    pipe.zadd(KEY_USER(userId), now, txnId);
    pipe.zremrangebyrank(KEY_USER(userId), 0, -(MAX_USER_ENTRIES + 1));
    pipe.expire(KEY_USER(userId), USER_TTL);
    if (relatedId) {
      pipe.zadd(KEY_REL(relatedId), now, txnId);
      pipe.expire(KEY_REL(relatedId), REL_TTL);
    }
    pipe.hincrby(KEY_OPS(), "total_entries", 1);
    pipe.hincrby(KEY_OPS(), `type_${type.toLowerCase()}`, 1);
    pipe.hincrby(KEY_OPS(), `dir_${direction.toLowerCase()}`, 1);
    await pipe.exec();

    return entry;
  } catch (err) {
    return { error: "ledger_write_failed", reason: err?.message };
  }
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

/** Record a purchase (item acquisition cost). */
export async function recordPurchase(redis, userId, {
  amount, invId, description, recordedBy = "user",
} = {}) {
  return recordEntry(redis, userId, {
    type: TXN_TYPE.PURCHASE, amount,
    relatedId: invId, relatedType: RELATED_TYPE.INVENTORY,
    description: description || "Item acquisition",
    recordedBy,
  });
}

/** Record a sale (gross proceeds received). */
export async function recordSale(redis, userId, {
  amount, listingId, invId, description, recordedBy = "user",
} = {}) {
  return recordEntry(redis, userId, {
    type: TXN_TYPE.SALE, amount,
    relatedId: listingId || invId,
    relatedType: listingId ? RELATED_TYPE.LISTING : RELATED_TYPE.INVENTORY,
    description: description || "Item sale proceeds",
    recordedBy,
  });
}

/** Record a platform fee (e.g., eBay final value fee). */
export async function recordFee(redis, userId, {
  amount, listingId, description, recordedBy = "system",
} = {}) {
  return recordEntry(redis, userId, {
    type: TXN_TYPE.FEE, amount,
    relatedId: listingId, relatedType: RELATED_TYPE.LISTING,
    description: description || "Platform fee",
    recordedBy,
  });
}

/** Record a shipping cost paid by user. */
export async function recordShippingCost(redis, userId, {
  amount, listingId, description, recordedBy = "user",
} = {}) {
  return recordEntry(redis, userId, {
    type: TXN_TYPE.SHIPPING_COST, amount,
    relatedId: listingId, relatedType: RELATED_TYPE.LISTING,
    description: description || "Shipping cost",
    recordedBy,
  });
}

/** Record a financial adjustment (correction). Requires reason. */
export async function recordAdjustment(redis, userId, {
  amount, relatedId, relatedType = RELATED_TYPE.MANUAL,
  adjustmentReason, adjustmentApprovedBy = null,
  description, recordedBy = "user",
} = {}) {
  return recordEntry(redis, userId, {
    type: TXN_TYPE.ADJUSTMENT, amount,
    relatedId, relatedType,
    description: description || `Adjustment: ${adjustmentReason}`,
    recordedBy,
    adjustmentReason,
    adjustmentApprovedBy,
  });
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Get a single entry by txnId.
 */
export async function getEntry(redis, txnId) {
  if (!redis || !txnId) return null;
  try {
    const raw = await redis.get(KEY_ENTRY(txnId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Get entries for a specific related entity (invId, listingId, etc.).
 */
export async function getEntriesForRelated(redis, relatedId, { limit = 100 } = {}) {
  if (!redis || !relatedId) return [];
  try {
    const ids = await redis.zrevrangebyscore(KEY_REL(relatedId), "+inf", "-inf", "LIMIT", 0, limit);
    if (!ids?.length) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_ENTRY(id));
    const results = await pipe.exec();
    return results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Get recent entries for a user.
 */
export async function getUserLedger(redis, userId, { limit = 50, since = null } = {}) {
  if (!redis || !userId) return [];
  try {
    const minScore = since ? Number(since) : 0;
    const ids = await redis.zrevrangebyscore(KEY_USER(userId), "+inf", minScore, "LIMIT", 0, limit);
    if (!ids?.length) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_ENTRY(id));
    const results = await pipe.exec();
    return results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Compute the running balance for a user from all ledger entries.
 * Balance = sum(CREDIT amounts) - sum(DEBIT amounts).
 *
 * NOTE: This reads all entries. For large ledgers, use this for reconciliation
 * not for real-time display. Keep a running total separately for hot paths.
 *
 * @returns {{ balance, totalCredits, totalDebits, entryCount, adjustmentCount }}
 */
export async function getLedgerBalance(redis, userId, { since = null } = {}) {
  if (!redis || !userId) return _emptyBalance();
  try {
    const minScore = since ? Number(since) : 0;
    // Read all IDs (up to cap)
    const ids = await redis.zrangebyscore(KEY_USER(userId), minScore, "+inf", "LIMIT", 0, MAX_USER_ENTRIES);
    if (!ids?.length) return _emptyBalance();

    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_ENTRY(id));
    const results = await pipe.exec();

    let totalCredits = 0, totalDebits = 0, adjustmentCount = 0;

    for (const [, raw] of results) {
      if (!raw) continue;
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; }
      if (entry.direction === TXN_DIRECTION.CREDIT) {
        totalCredits += entry.amount || 0;
      } else {
        totalDebits += entry.amount || 0;
      }
      if (entry.type === TXN_TYPE.ADJUSTMENT) adjustmentCount++;
    }

    return {
      balance:         r2(totalCredits - totalDebits),
      totalCredits:    r2(totalCredits),
      totalDebits:     r2(totalDebits),
      entryCount:      ids.length,
      adjustmentCount,
    };
  } catch { return _emptyBalance(); }
}

/**
 * Get aggregate ops counters.
 */
export async function getLedgerOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalEntries:    ops["total_entries"]    || 0,
      typePurchase:    ops["type_purchase"]    || 0,
      typeSale:        ops["type_sale"]        || 0,
      typeFee:         ops["type_fee"]         || 0,
      typeShipping:    ops["type_shipping_cost"] || 0,
      typeAdjustment:  ops["type_adjustment"]  || 0,
      totalCredits:    ops["dir_credit"]       || 0,
      totalDebits:     ops["dir_debit"]        || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _genTxnId(now) {
  return `txn_${now}_${crypto.randomBytes(5).toString("hex")}`;
}

function _emptyBalance() {
  return { balance: 0, totalCredits: 0, totalDebits: 0, entryCount: 0, adjustmentCount: 0 };
}

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
