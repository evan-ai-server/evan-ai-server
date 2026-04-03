// src/watchlistEngine.js
// Phase 3 — Watchlist & Alert System.
//
// Users set price thresholds on categories/brands/models.
// When a scan matches a rule, an alert is stored.
//
// Redis key layout:
//   wl:item:{wlId}         STRING   full watchlist entry JSON (1yr TTL)
//   wl:user:{userId}       ZSET     wlIds by createdAt
//   wl:alerts:{userId}     ZSET     alert objects by ts (90d TTL, max 500)
//   wl:idx:{category}      ZSET     wlIds for scan-time lookup (1yr TTL)

import crypto from "crypto";

const WL_TTL      = 365 * 86400;
const ALERT_TTL   = 90  * 86400;
const MAX_WL_USER = 200;
const MAX_ALERTS  = 500;

const KEY_ITEM    = id       => `wl:item:${id}`;
const KEY_USER    = userId   => `wl:user:${userId}`;
const KEY_ALERTS  = userId   => `wl:alerts:${userId}`;
const KEY_IDX_CAT = category => `wl:idx:${category}`;

// ── Create ────────────────────────────────────────────────────────────────────

export async function createWatchlistEntry(redis, {
  userId,
  category       = null,
  brand          = null,
  model          = null,
  thresholdPrice = null,
  conditions     = null,   // { condition: "DS" } or similar
  label          = null,   // human-readable label
} = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };
  if (!category && !brand) return { ok: false, error: "need_category_or_brand" };

  const tp = finitePos(thresholdPrice);
  if (tp === null && thresholdPrice != null) return { ok: false, error: "invalid_threshold_price" };

  try {
    const wlId = "wl_" + crypto.randomBytes(6).toString("hex");
    const now  = Date.now();

    const entry = {
      wlId,
      userId,
      category:       ns(category),
      brand:          ns(brand),
      model:          ns(model),
      thresholdPrice: tp,
      conditions:     conditions || null,
      label:          label ? String(label).slice(0, 120) : null,
      active:         true,
      createdAt:      now,
      lastTriggeredAt: null,
      triggerCount:   0,
    };

    const multi = redis.multi();
    multi.set(KEY_ITEM(wlId), JSON.stringify(entry), { EX: WL_TTL });
    multi.zAdd(KEY_USER(userId), [{ score: now, value: wlId }]);
    if (entry.category) {
      multi.zAdd(KEY_IDX_CAT(entry.category), [{ score: now, value: wlId }]);
      multi.expire(KEY_IDX_CAT(entry.category), WL_TTL);
    }
    multi.zRemRangeByRank(KEY_USER(userId), 0, -(MAX_WL_USER + 1));
    multi.expire(KEY_USER(userId), WL_TTL);
    await multi.exec();

    return { ok: true, wlId, entry };
  } catch (err) {
    return { ok: false, error: "wl_create_failed", reason: err?.message };
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getUserWatchlist(redis, userId) {
  if (!redis || !userId) return [];
  try {
    const ids  = await redis.zRange(KEY_USER(userId), 0, -1, { REV: true });
    const raws = await Promise.all(ids.map(id => redis.get(KEY_ITEM(id)).catch(() => null)));
    return raws.map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean)
      .filter(e => e.active);
  } catch { return []; }
}

export async function deleteWatchlistEntry(redis, userId, wlId) {
  if (!redis || !userId || !wlId) return { ok: false, error: "missing_required" };
  try {
    const raw = await redis.get(KEY_ITEM(wlId));
    if (!raw) return { ok: false, error: "not_found" };
    const entry = JSON.parse(raw);
    if (entry.userId !== userId) return { ok: false, error: "unauthorized" };
    entry.active = false;
    await redis.set(KEY_ITEM(wlId), JSON.stringify(entry), { EX: WL_TTL });
    await redis.zRem(KEY_USER(userId), wlId);
    if (entry.category) await redis.zRem(KEY_IDX_CAT(entry.category), wlId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "wl_delete_failed", reason: err?.message };
  }
}

// ── Alert checking ────────────────────────────────────────────────────────────

/**
 * Check a scan result against all watchlist entries for its user.
 * Called non-blocking after scan completes.
 * Stores alerts for any matched entries.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId       {string}
 *   category     {string}
 *   brand        {string|null}
 *   model        {string|null}
 *   scannedPrice {number|null}
 *   signal       {string|null}
 *   scanId       {string}
 *   itemName     {string|null}
 */
export async function checkWatchlistForScan(redis, {
  userId, category, brand, model, scannedPrice, signal, scanId, itemName,
} = {}) {
  if (!redis || !userId) return [];
  try {
    const entries = await getUserWatchlist(redis, userId);
    const triggered = [];

    for (const entry of entries) {
      if (!isMatch(entry, { category, brand, model, scannedPrice })) continue;
      triggered.push(entry);
      await storeAlert(redis, userId, {
        wlId:       entry.wlId,
        scanId,
        itemName:   itemName || null,
        category,
        brand:      brand || null,
        model:      model || null,
        scannedPrice,
        signal,
        label:      entry.label || null,
        thresholdPrice: entry.thresholdPrice,
        matchReason: buildMatchReason(entry, scannedPrice),
      });
      // Update trigger stats on the watchlist entry
      entry.lastTriggeredAt = Date.now();
      entry.triggerCount    = (entry.triggerCount || 0) + 1;
      await redis.set(KEY_ITEM(entry.wlId), JSON.stringify(entry), { EX: WL_TTL });
    }
    return triggered;
  } catch { return []; }
}

// ── Alerts ────────────────────────────────────────────────────────────────────

async function storeAlert(redis, userId, alert) {
  const payload = JSON.stringify({ ...alert, ts: Date.now() });
  await redis.zAdd(KEY_ALERTS(userId), [{ score: Date.now(), value: payload }]);
  await redis.zRemRangeByRank(KEY_ALERTS(userId), 0, -(MAX_ALERTS + 1));
  await redis.expire(KEY_ALERTS(userId), ALERT_TTL);
}

export async function getUserAlerts(redis, userId, { limit = 20 } = {}) {
  if (!redis || !userId) return [];
  try {
    const raws = await redis.zRange(KEY_ALERTS(userId), 0, limit - 1, { REV: true });
    return raws.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export async function clearUserAlerts(redis, userId) {
  if (!redis || !userId) return;
  await redis.del(KEY_ALERTS(userId)).catch(() => {});
}

// ── Matching logic ────────────────────────────────────────────────────────────

function isMatch(entry, { category, brand, model, scannedPrice }) {
  if (entry.category && entry.category !== (category || "").toLowerCase()) return false;
  if (entry.brand) {
    const eb = entry.brand.toLowerCase();
    const sb = (brand || "").toLowerCase();
    if (!sb.includes(eb) && !eb.includes(sb)) return false;
  }
  if (entry.model) {
    const em = entry.model.toLowerCase();
    const sm = (model || "").toLowerCase();
    if (!sm.includes(em) && !em.includes(sm)) return false;
  }
  if (entry.thresholdPrice != null && scannedPrice != null) {
    if (scannedPrice > entry.thresholdPrice) return false;
  }
  return true;
}

function buildMatchReason(entry, scannedPrice) {
  const parts = [];
  if (entry.brand) parts.push(`brand matches "${entry.brand}"`);
  if (entry.model) parts.push(`model matches "${entry.model}"`);
  if (entry.thresholdPrice && scannedPrice) {
    parts.push(`price $${scannedPrice} ≤ threshold $${entry.thresholdPrice}`);
  }
  return parts.join(", ") || "category match";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function finitePos(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function ns(v) { const s = String(v || "").trim(); return s || null; }
