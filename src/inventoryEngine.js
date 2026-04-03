// src/inventoryEngine.js
// Phase 3 — Inventory Engine (Power User Lock-In Core).
//
// Converts every BUY decision into a persistent inventory position.
// Inventory items are the connective tissue between:
//   scan → decision → source → INVENTORY ITEM → outcome → metrics
//
// Design invariants:
//   - Inventory is created when source is recorded (BUY + purchasePrice required)
//   - Items persist independently of scan TTL (2-year TTL vs 90-day signal TTL)
//   - Idempotent creation: one inventory item per scanId
//   - Status transitions are validated and logged
//   - All financial mutations go through explicit functions — no freeform patches
//
// Redis key layout:
//   inv:item:{invId}               STRING  full inventory item JSON (2yr TTL)
//   inv:scan:{scanId}              STRING  invId for this scan (2yr TTL, for dedup)
//   inv:user:{userId}              ZSET    invIds scored by acquiredAt (2yr TTL)
//   inv:user:{userId}:status:ACTIVE ZSET   invIds for status filter (2yr TTL)
//   inv:user:{userId}:status:SOLD   ZSET   same for SOLD
//   inv:user:{userId}:status:DEAD   ZSET
//   inv:user:{userId}:status:RETURNED ZSET
//   inv:user:{userId}:cat:{category} ZSET  invIds for category filter
//
// Status lifecycle:
//   ACTIVE → SOLD / DEAD / RETURNED
//   (SOLD / DEAD / RETURNED are terminal — no further transitions)

import crypto from "crypto";

const INV_TTL      = 2 * 365 * 86400;  // 2 years
const MAX_INV_USER = 10_000;            // max items tracked per user
const VALID_STATUSES = new Set(["ACTIVE", "SOLD", "DEAD", "RETURNED"]);
const TERMINAL_STATUSES = new Set(["SOLD", "DEAD", "RETURNED"]);

// ── Redis key helpers ─────────────────────────────────────────────────────────

const KEY_ITEM    = (id)           => `inv:item:${id}`;
const KEY_SCAN    = (scanId)       => `inv:scan:${scanId}`;
const KEY_USER    = (userId)       => `inv:user:${userId}`;
const KEY_STATUS  = (userId, st)   => `inv:user:${userId}:status:${st}`;
const KEY_CAT     = (userId, cat)  => `inv:user:${userId}:cat:${cat}`;

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create an inventory item from a BUY + source record.
 * Called automatically from POST /scan/source after source is stored.
 * Idempotent: calling twice with the same scanId returns the existing item.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId          {string}
 *   scanId          {string}
 *   category        {string|null}        from signal snapshot
 *   itemName        {string|null}        from signal snapshot
 *   itemSnapshot    {object|null}        structured attributes from Phase 2 categoryDomination
 *   purchasePrice   {number}             required
 *   askPrice        {number|null}
 *   sourceType      {string}
 *   city            {string|null}
 *   signal          {string|null}        Evan's original buy signal
 *   trustScore      {number|null}
 * @returns {Promise<{ ok, invId, item, created }>}
 */
export async function createInventoryItem(redis, {
  userId,
  scanId,
  category      = null,
  itemName      = null,
  itemSnapshot  = null,
  purchasePrice,
  askPrice      = null,
  sourceType    = "OTHER",
  city          = null,
  signal        = null,
  trustScore    = null,
} = {}) {
  if (!redis)  return { ok: false, error: "no_redis" };
  if (!userId) return { ok: false, error: "missing_user_id" };
  if (!scanId) return { ok: false, error: "missing_scan_id" };

  const pp = finitePositive(purchasePrice);
  if (pp === null) return { ok: false, error: "invalid_purchase_price" };

  try {
    // Idempotency: return existing if already created for this scan
    const existingInvId = await redis.get(KEY_SCAN(scanId)).catch(() => null);
    if (existingInvId) {
      const existingRaw = await redis.get(KEY_ITEM(existingInvId)).catch(() => null);
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          return { ok: true, invId: existingInvId, item: existing, created: false };
        } catch { /* fall through to recreate */ }
      }
    }

    const invId     = generateInvId();
    const now       = Date.now();
    const catNorm   = normStr(category) || "generic";

    const item = {
      invId,
      userId,
      scanId,
      category:     catNorm,
      itemName:     normStr(itemName) || null,
      itemSnapshot: itemSnapshot || null,  // frozen Phase 2 structured attributes
      purchasePrice: pp,
      askPrice:      finitePositive(askPrice),
      sourceType:    normStr(sourceType) || "OTHER",
      city:          normStr(city),
      signal:        normStr(signal),
      trustScore:    finitePositive(trustScore) || null,
      status:        "ACTIVE",
      acquiredAt:    now,
      linkedOutcomeId: null,
      soldPrice:     null,
      soldAt:        null,
      platform:      null,
      fees:          null,
      shippingCost:  null,
      netProfit:     null,
      notes:         null,
      editHistory:   [],
      updatedAt:     now,
    };

    const multi = redis.multi();
    multi.set(KEY_ITEM(invId), JSON.stringify(item), { EX: INV_TTL });
    multi.set(KEY_SCAN(scanId), invId, { EX: INV_TTL });
    multi.zAdd(KEY_USER(userId), [{ score: now, value: invId }]);
    multi.zAdd(KEY_STATUS(userId, "ACTIVE"), [{ score: now, value: invId }]);
    multi.zAdd(KEY_CAT(userId, catNorm), [{ score: now, value: invId }]);
    multi.zRemRangeByRank(KEY_USER(userId), 0, -(MAX_INV_USER + 1));
    multi.expire(KEY_USER(userId), INV_TTL);
    multi.expire(KEY_STATUS(userId, "ACTIVE"), INV_TTL);
    multi.expire(KEY_CAT(userId, catNorm), INV_TTL);
    await multi.exec();

    return { ok: true, invId, item, created: true };
  } catch (err) {
    return { ok: false, error: "inv_create_failed", reason: err?.message };
  }
}

/**
 * Get the invId for a given scanId (if an inventory item was created from it).
 */
export async function getInvIdForScan(redis, scanId) {
  if (!redis || !scanId) return null;
  try { return await redis.get(KEY_SCAN(scanId)); } catch { return null; }
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Get a single inventory item by invId.
 */
export async function getInventoryItem(redis, invId) {
  if (!redis || !invId) return null;
  try {
    const raw = await redis.get(KEY_ITEM(invId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Get inventory items for a user with optional filtering.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts
 *   status    {string|null}   filter by status (ACTIVE | SOLD | DEAD | RETURNED)
 *   category  {string|null}   filter by category
 *   limit     {number}        default 50
 *   offset    {number}        default 0
 *   since     {number|null}   acquiredAt lower bound (ms)
 *   until     {number|null}   acquiredAt upper bound (ms)
 * @returns {Promise<{ items, total }>}
 */
export async function getUserInventory(redis, userId, {
  status   = null,
  category = null,
  limit    = 50,
  offset   = 0,
  since    = null,
  until    = null,
} = {}) {
  if (!redis || !userId) return { items: [], total: 0 };
  try {
    const key  = category ? KEY_CAT(userId, category)
               : status   ? KEY_STATUS(userId, status)
               : KEY_USER(userId);
    const lo = since != null ? Number(since) : "-inf";
    const hi = until != null ? Number(until) : "+inf";
    const maxLimit = Math.min(limit, 200);

    const [invIds, total] = await Promise.all([
      redis.zRangeByScore(key, lo, hi, { REV: true, LIMIT: { offset, count: maxLimit } }).catch(() => []),
      redis.zCard(key).catch(() => 0),
    ]);

    if (!invIds || invIds.length === 0) return { items: [], total };

    const raws = await Promise.all(invIds.map(id => redis.get(KEY_ITEM(id)).catch(() => null)));
    const items = raws
      .map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);

    // Apply status filter if category key was used (category key doesn't filter by status)
    const filtered = status && category ? items.filter(i => i.status === status) : items;

    return { items: filtered, total };
  } catch { return { items: [], total: 0 }; }
}

/**
 * Get inventory summary counts for a user (fast — uses ZSET cardinalities).
 */
export async function getInventoryCounts(redis, userId) {
  if (!redis || !userId) return { active: 0, sold: 0, dead: 0, returned: 0, total: 0 };
  try {
    const [active, sold, dead, returned, total] = await Promise.all([
      redis.zCard(KEY_STATUS(userId, "ACTIVE")).catch(() => 0),
      redis.zCard(KEY_STATUS(userId, "SOLD")).catch(() => 0),
      redis.zCard(KEY_STATUS(userId, "DEAD")).catch(() => 0),
      redis.zCard(KEY_STATUS(userId, "RETURNED")).catch(() => 0),
      redis.zCard(KEY_USER(userId)).catch(() => 0),
    ]);
    return { active, sold, dead, returned, total };
  } catch { return { active: 0, sold: 0, dead: 0, returned: 0, total: 0 }; }
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Update mutable fields on an inventory item.
 * Only non-financial fields may be freely patched (notes).
 * Financial corrections (purchasePrice) require audit logging.
 *
 * @param {object} redis
 * @param {string} invId
 * @param {object} patches — { notes?, purchasePrice?, itemName? }
 * @param {string} [editedBy] — userId or "user" for audit log
 * @returns {Promise<{ ok, item }>}
 */
export async function updateInventoryItem(redis, invId, patches = {}, editedBy = "user") {
  if (!redis || !invId) return { ok: false, error: "missing_inv_id" };
  try {
    const item = await getInventoryItem(redis, invId);
    if (!item) return { ok: false, error: "item_not_found" };

    const auditEntry = { at: Date.now(), by: editedBy, changes: {} };
    const allowed    = ["notes", "purchasePrice", "askPrice", "itemName"];

    for (const field of allowed) {
      if (patches[field] === undefined) continue;

      // Financial correction: purchasePrice requires positive number
      if (field === "purchasePrice") {
        const pp = finitePositive(patches.purchasePrice);
        if (pp === null) continue;
        auditEntry.changes.purchasePrice = { from: item.purchasePrice, to: pp };
        item.purchasePrice = pp;
      } else if (field === "askPrice") {
        const ap = finitePositive(patches.askPrice);
        if (ap === null) continue;
        auditEntry.changes.askPrice = { from: item.askPrice, to: ap };
        item.askPrice = ap;
      } else if (field === "notes") {
        const note = patches.notes ? String(patches.notes).slice(0, 1000) : null;
        auditEntry.changes.notes = { from: item.notes, to: note };
        item.notes = note;
      } else if (field === "itemName") {
        const name = patches.itemName ? String(patches.itemName).slice(0, 200) : item.itemName;
        auditEntry.changes.itemName = { from: item.itemName, to: name };
        item.itemName = name;
      }
    }

    if (Object.keys(auditEntry.changes).length > 0) {
      item.editHistory = [...(item.editHistory || []).slice(-19), auditEntry];
    }
    item.updatedAt = Date.now();

    await redis.set(KEY_ITEM(invId), JSON.stringify(item), { EX: INV_TTL });
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: "inv_update_failed", reason: err?.message };
  }
}

// ── Status Transitions ────────────────────────────────────────────────────────

/**
 * Mark an inventory item as SOLD.
 * Updates status, records sale data, computes netProfit.
 *
 * @param {object} redis
 * @param {string} invId
 * @param {object} opts
 *   soldPrice    {number}  required
 *   platform     {string|null}
 *   fees         {number|null}  total platform fees
 *   shippingCost {number|null}
 *   soldAt       {number|null}  ms timestamp
 *   linkedOutcomeId {string|null} scanId of the outcome record (for linking)
 */
export async function markInventorySold(redis, invId, {
  soldPrice,
  platform      = null,
  fees          = null,
  shippingCost  = null,
  soldAt        = null,
  linkedOutcomeId = null,
} = {}) {
  if (!redis || !invId) return { ok: false, error: "missing_inv_id" };
  const sp = finitePositive(soldPrice);
  if (sp === null) return { ok: false, error: "invalid_sold_price" };

  try {
    const item = await getInventoryItem(redis, invId);
    if (!item) return { ok: false, error: "item_not_found" };
    if (TERMINAL_STATUSES.has(item.status)) {
      return { ok: false, error: "invalid_transition", current: item.status };
    }

    const feesVal    = finiteNonNeg(fees)        ?? 0;
    const shipVal    = finiteNonNeg(shippingCost) ?? 0;
    const netProfit  = r2(sp - item.purchasePrice - feesVal - shipVal);
    const now        = soldAt ?? Date.now();

    Object.assign(item, {
      status:   "SOLD",
      soldPrice: sp,
      soldAt:   now,
      platform: platform ? String(platform).slice(0, 80) : null,
      fees:     feesVal,
      shippingCost: shipVal,
      netProfit,
      linkedOutcomeId: linkedOutcomeId || null,
      updatedAt: Date.now(),
    });
    item.editHistory = [...(item.editHistory || []).slice(-19), {
      at: Date.now(), by: "system", changes: { status: { from: "ACTIVE", to: "SOLD" } }
    }];

    await _transitionStatus(redis, item, "ACTIVE", "SOLD");
    return { ok: true, item, netProfit };
  } catch (err) {
    return { ok: false, error: "inv_sold_failed", reason: err?.message };
  }
}

/**
 * Mark an inventory item as DEAD (unsellable, full loss).
 */
export async function markInventoryDead(redis, invId, { notes = null, deadAt = null } = {}) {
  return _markTerminal(redis, invId, "DEAD", { notes, ts: deadAt, reason: "unsellable" });
}

/**
 * Mark an inventory item as RETURNED.
 */
export async function markInventoryReturned(redis, invId, {
  refundAmount = null,
  notes        = null,
  returnedAt   = null,
} = {}) {
  return _markTerminal(redis, invId, "RETURNED", {
    notes, ts: returnedAt,
    netProfit: finiteNonNeg(refundAmount) != null
      ? r2((finiteNonNeg(refundAmount) || 0) - (await _getPP(redis, invId)))
      : null,
  });
}

// ── Inventory-based P&L summaries ─────────────────────────────────────────────

/**
 * Compute P&L metrics from inventory data.
 * Provides sourceType breakdown and time-period breakdowns.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts — { since, until } for time filtering
 */
export async function getInventoryMetrics(redis, userId, { since = null, until = null } = {}) {
  if (!redis || !userId) return _emptyInvMetrics();
  try {
    const { items } = await getUserInventory(redis, userId, {
      limit: MAX_INV_USER, since, until,
    });

    let totalSpent    = 0, totalRevenue = 0, totalProfit = 0;
    let totalActive   = 0, totalSold    = 0, totalDead = 0, totalReturned = 0;
    let totalWins     = 0;
    const timesToSale = [];
    const sourceMap   = {};
    const catMap      = {};
    const platMap     = {};

    for (const item of items) {
      const pp  = item.purchasePrice || 0;
      totalSpent += pp;

      switch (item.status) {
        case "ACTIVE":   totalActive++;   break;
        case "DEAD":     totalDead++;     totalProfit -= pp; break;
        case "RETURNED": totalReturned++; break;
        case "SOLD":
          totalSold++;
          const sp = item.soldPrice || 0;
          const np = item.netProfit ?? 0;
          totalRevenue += sp;
          totalProfit  += np;
          if (np > 0) totalWins++;
          if (item.soldAt && item.acquiredAt) {
            timesToSale.push(item.soldAt - item.acquiredAt);
          }
          // Platform breakdown
          const plat = item.platform || "unknown";
          if (!platMap[plat]) platMap[plat] = { sold: 0, revenue: 0, profit: 0 };
          platMap[plat].sold++;
          platMap[plat].revenue += sp;
          platMap[plat].profit  += np;
          break;
      }

      // Source type breakdown
      const src = item.sourceType || "OTHER";
      if (!sourceMap[src]) sourceMap[src] = { count: 0, spent: 0, revenue: 0, profit: 0, sold: 0 };
      sourceMap[src].count++;
      sourceMap[src].spent += pp;
      if (item.status === "SOLD") {
        sourceMap[src].sold++;
        sourceMap[src].revenue += item.soldPrice || 0;
        sourceMap[src].profit  += item.netProfit ?? 0;
      }

      // Category breakdown
      const cat = item.category || "unknown";
      if (!catMap[cat]) catMap[cat] = { count: 0, spent: 0, revenue: 0, profit: 0, active: 0, sold: 0 };
      catMap[cat].count++;
      catMap[cat].spent += pp;
      if (item.status === "ACTIVE") catMap[cat].active++;
      if (item.status === "SOLD") {
        catMap[cat].sold++;
        catMap[cat].revenue += item.soldPrice || 0;
        catMap[cat].profit  += item.netProfit ?? 0;
      }
    }

    const avgTimeToSaleDays = timesToSale.length > 0
      ? r2(timesToSale.reduce((a, b) => a + b, 0) / timesToSale.length / 86400000)
      : null;

    const roi = totalSpent > 0 && totalSold > 0
      ? r2(((totalRevenue - totalSpent) / totalSpent) * 100)
      : null;

    const capitalDeployed = items
      .filter(i => i.status === "ACTIVE")
      .reduce((s, i) => s + (i.purchasePrice || 0), 0);

    return {
      totalItems:       items.length,
      totalActive,
      totalSold,
      totalDead,
      totalReturned,
      totalSpent:       r2(totalSpent),
      totalRevenue:     r2(totalRevenue),
      totalProfit:      r2(totalProfit),
      capitalDeployed:  r2(capitalDeployed),
      winRate:          totalSold > 0 ? r2((totalWins / totalSold) * 100) : null,
      roi,
      avgTimeToSaleDays,
      sourceBreakdown:  Object.entries(sourceMap).map(([src, s]) => ({
        sourceType: src,
        count:    s.count,
        spent:    r2(s.spent),
        sold:     s.sold,
        revenue:  r2(s.revenue),
        profit:   r2(s.profit),
        roi:      s.spent > 0 ? r2(((s.revenue - s.spent) / s.spent) * 100) : null,
      })).sort((a, b) => b.profit - a.profit),
      categoryBreakdown: Object.entries(catMap).map(([cat, s]) => ({
        category: cat,
        count:    s.count,
        active:   s.active,
        sold:     s.sold,
        spent:    r2(s.spent),
        revenue:  r2(s.revenue),
        profit:   r2(s.profit),
      })).sort((a, b) => b.profit - a.profit),
      platformBreakdown: Object.entries(platMap).map(([plat, s]) => ({
        platform: plat,
        sold:     s.sold,
        revenue:  r2(s.revenue),
        profit:   r2(s.profit),
      })).sort((a, b) => b.profit - a.profit),
    };
  } catch { return _emptyInvMetrics(); }
}

/**
 * Get time-period P&L breakdown: last7d, last30d, last90d, allTime.
 */
export async function getTimePeriodMetrics(redis, userId) {
  if (!redis || !userId) return {};
  const now = Date.now();
  const [last7d, last30d, last90d, allTime] = await Promise.all([
    getInventoryMetrics(redis, userId, { since: now - 7  * 86400000 }),
    getInventoryMetrics(redis, userId, { since: now - 30 * 86400000 }),
    getInventoryMetrics(redis, userId, { since: now - 90 * 86400000 }),
    getInventoryMetrics(redis, userId),
  ]);
  return { last7d, last30d, last90d, allTime };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _transitionStatus(redis, item, fromStatus, toStatus) {
  const multi = redis.multi();
  multi.set(KEY_ITEM(item.invId), JSON.stringify(item), { EX: INV_TTL });
  multi.zRem(KEY_STATUS(item.userId, fromStatus), item.invId);
  multi.zAdd(KEY_STATUS(item.userId, toStatus), [{ score: item.acquiredAt, value: item.invId }]);
  multi.expire(KEY_STATUS(item.userId, toStatus), INV_TTL);
  await multi.exec();
}

async function _markTerminal(redis, invId, toStatus, { notes, ts, netProfit } = {}) {
  if (!redis || !invId) return { ok: false, error: "missing_inv_id" };
  try {
    const item = await getInventoryItem(redis, invId);
    if (!item) return { ok: false, error: "item_not_found" };
    if (TERMINAL_STATUSES.has(item.status)) {
      return { ok: false, error: "invalid_transition", current: item.status };
    }
    const prev = item.status;
    item.status    = toStatus;
    item.notes     = notes ? String(notes).slice(0, 1000) : item.notes;
    item.updatedAt = Date.now();
    if (netProfit != null) item.netProfit = netProfit;
    item.editHistory = [...(item.editHistory || []).slice(-19), {
      at: Date.now(), by: "user", changes: { status: { from: prev, to: toStatus } }
    }];
    await _transitionStatus(redis, item, prev, toStatus);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: "inv_transition_failed", reason: err?.message };
  }
}

async function _getPP(redis, invId) {
  const item = await getInventoryItem(redis, invId);
  return item?.purchasePrice || 0;
}

function _emptyInvMetrics() {
  return {
    totalItems: 0, totalActive: 0, totalSold: 0, totalDead: 0, totalReturned: 0,
    totalSpent: 0, totalRevenue: 0, totalProfit: 0, capitalDeployed: 0,
    winRate: null, roi: null, avgTimeToSaleDays: null,
    sourceBreakdown: [], categoryBreakdown: [], platformBreakdown: [],
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function generateInvId() {
  return "inv_" + crypto.randomBytes(8).toString("hex");
}

function normStr(v) {
  if (!v) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}

export { MAX_INV_USER };
