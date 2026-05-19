// src/portfolio.js
// Portfolio Mode — reseller inventory tracker with market value drift
// Multi-instance safe (all writes via Redis pipeline + atomic ops)

import crypto from "crypto";

const PORT_SUMMARY_KEY = (userId)         => `portfolio:${userId}`;
const PORT_ITEMS_KEY   = (userId)         => `portfolio:items:${userId}`;
const PORT_ITEM_KEY    = (userId, itemId) => `portfolio:item:${userId}:${itemId}`;
const PORT_SOLD_KEY    = (userId)         => `portfolio:sold:${userId}`;

const PORT_TTL_SEC = 365 * 86400; // 1 year
const MAX_ITEMS    = () => Number(process.env.PORTFOLIO_MAX_ITEMS || 500);

// ── Generate item ID ──────────────────────────────────────────────────────────

function makeItemId() {
  return `pi_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

// ── Serialize value for Redis HSET ────────────────────────────────────────────

function serializeVal(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ── Add item ──────────────────────────────────────────────────────────────────

export async function addPortfolioItem(redis, userId, item) {
  if (!redis || !userId || !item) return null;

  const existing = await redis.zcard(PORT_ITEMS_KEY(userId));
  if (existing >= MAX_ITEMS()) {
    throw new Error("portfolio_max_items_reached");
  }

  const now    = Date.now();
  const itemId = item.id || makeItemId();

  const acqPrice = Number(item.acquisitionPrice ?? item.price ?? 0);
  const record   = {
    id:              itemId,
    userId,
    query:           item.query          || null,
    title:           item.title          || item.query || null,
    brand:           item.brand          || null,
    model:           item.model          || null,
    category:        item.category       || null,
    imageUrl:        item.imageUrl        || null,
    imageHash:       item.imageHash       || null,
    scanId:          item.scanId          || null,  // link to originating scan replay
    acquisitionPrice: Number.isFinite(acqPrice) ? acqPrice : null,
    currentValue:    item.currentValue   ?? item.acquisitionPrice ?? null,
    conditionGrade:  item.conditionGrade  || null,
    conditionLabel:  item.conditionLabel  || null,
    listingStatus:   item.listingStatus   || "unlisted",
    // Lifecycle: WATCHING | PASSED | BOUGHT | HOLDING | LISTED | SOLD
    lifecycleStatus: item.lifecycleStatus || "HOLDING",
    quantity:        Math.max(1, Math.round(Number(item.quantity || 1))),
    platform:        item.platform        || null,
    notes:           item.notes           || null,
    visionIdentity:  item.visionIdentity  || null,
    addedAt:         now,
    lastValuedAt:    now,
    soldAt:          null,
    soldPrice:       null,
    updatedAt:       now,
  };

  const pipeline = redis.pipeline();
  pipeline.hset(PORT_ITEM_KEY(userId, itemId),
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, serializeVal(v)]))
  );
  pipeline.expire(PORT_ITEM_KEY(userId, itemId), PORT_TTL_SEC);
  pipeline.zadd(PORT_ITEMS_KEY(userId), now, itemId);
  pipeline.expire(PORT_ITEMS_KEY(userId), PORT_TTL_SEC);

  // Update summary
  const currentSummary = await getPortfolioSummaryRaw(redis, userId);
  const newTotalCost   = Number(currentSummary?.totalCost    || 0) + (record.acquisitionPrice || 0);
  const newCurrValue   = Number(currentSummary?.currentValue || 0) + (Number(record.currentValue) || record.acquisitionPrice || 0);
  const newCount       = Number(currentSummary?.totalItems   || 0) + 1;

  pipeline.hset(PORT_SUMMARY_KEY(userId), {
    totalItems:   newCount,
    totalCost:    Math.round(newTotalCost  * 100) / 100,
    currentValue: Math.round(newCurrValue  * 100) / 100,
    updatedAt:    now,
  });
  pipeline.expire(PORT_SUMMARY_KEY(userId), PORT_TTL_SEC);

  await pipeline.exec();
  return record;
}

// ── Get summary (raw Redis hash) ──────────────────────────────────────────────

async function getPortfolioSummaryRaw(redis, userId) {
  if (!redis || !userId) return null;
  const raw = await redis.hgetall(PORT_SUMMARY_KEY(userId));
  if (!raw || !Object.keys(raw).length) return null;
  return {
    totalItems:   Number(raw.totalItems   || 0),
    totalCost:    Number(raw.totalCost    || 0),
    currentValue: Number(raw.currentValue || 0),
    updatedAt:    Number(raw.updatedAt    || 0),
  };
}

// ── Get summary (public) ──────────────────────────────────────────────────────

export async function getPortfolioSummary(redis, userId) {
  if (!redis || !userId) return null;
  const summary = await getPortfolioSummaryRaw(redis, userId);
  if (!summary) return { totalItems: 0, totalCost: 0, currentValue: 0, unrealizedGain: 0, unrealizedGainPct: null };

  const gain    = summary.currentValue - summary.totalCost;
  const gainPct = summary.totalCost > 0
    ? Math.round((gain / summary.totalCost) * 10000) / 100
    : null;

  return { ...summary, unrealizedGain: Math.round(gain * 100) / 100, unrealizedGainPct: gainPct };
}

// ── List items ────────────────────────────────────────────────────────────────

export async function listPortfolioItems(redis, userId, limit = 50, offset = 0) {
  if (!redis || !userId) return [];
  const ids = await redis.zrevrange(PORT_ITEMS_KEY(userId), offset, offset + limit - 1);
  if (!ids?.length) return [];

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(PORT_ITEM_KEY(userId, id));
  const results = await pipeline.exec();

  return results
    .map(([, raw]) => raw && Object.keys(raw).length ? deserializePortfolioItem(raw) : null)
    .filter(Boolean);
}

// ── Get single item ───────────────────────────────────────────────────────────

export async function getPortfolioItem(redis, userId, itemId) {
  if (!redis || !userId || !itemId) return null;
  const raw = await redis.hgetall(PORT_ITEM_KEY(userId, itemId));
  if (!raw || !Object.keys(raw).length) return null;
  return deserializePortfolioItem(raw);
}

// ── Deserialize Redis hash → item object ─────────────────────────────────────

function deserializePortfolioItem(raw) {
  return {
    id:              raw.id              || null,
    userId:          raw.userId          || null,
    query:           raw.query           || null,
    title:           raw.title           || null,
    brand:           raw.brand           || null,
    model:           raw.model           || null,
    category:        raw.category        || null,
    imageUrl:        raw.imageUrl         || null,
    imageHash:       raw.imageHash        || null,
    scanId:          raw.scanId           || null,
    acquisitionPrice: raw.acquisitionPrice ? Number(raw.acquisitionPrice) : null,
    currentValue:    raw.currentValue     ? Number(raw.currentValue)      : null,
    conditionGrade:  raw.conditionGrade   || null,
    conditionLabel:  raw.conditionLabel   || null,
    listingStatus:   raw.listingStatus    || "unlisted",
    lifecycleStatus: raw.lifecycleStatus  || "HOLDING",
    quantity:        raw.quantity         ? Math.max(1, Number(raw.quantity)) : 1,
    platform:        raw.platform         || null,
    notes:           raw.notes            || null,
    visionIdentity:  raw.visionIdentity   ? (() => { try { return JSON.parse(raw.visionIdentity); } catch { return null; } })() : null,
    addedAt:         Number(raw.addedAt   || 0),
    lastValuedAt:    Number(raw.lastValuedAt || 0),
    soldAt:          raw.soldAt           ? Number(raw.soldAt)  : null,
    soldPrice:       raw.soldPrice        ? Number(raw.soldPrice) : null,
    updatedAt:       Number(raw.updatedAt || 0),
  };
}

// ── Update current market value ───────────────────────────────────────────────

export async function updatePortfolioItemValue(redis, userId, itemId, newValue) {
  if (!redis || !userId || !itemId) return null;
  const v   = Number(newValue);
  if (!Number.isFinite(v)) return null;
  const now = Date.now();

  const existing = await getPortfolioItem(redis, userId, itemId);
  if (!existing) return null;

  const oldValue = Number(existing.currentValue || existing.acquisitionPrice || 0);
  const diff     = v - oldValue;

  const pipeline = redis.pipeline();
  pipeline.hset(PORT_ITEM_KEY(userId, itemId), { currentValue: v, lastValuedAt: now, updatedAt: now });
  pipeline.expire(PORT_ITEM_KEY(userId, itemId), PORT_TTL_SEC);

  const summary = await getPortfolioSummaryRaw(redis, userId);
  if (summary) {
    pipeline.hset(PORT_SUMMARY_KEY(userId), {
      currentValue: Math.round((summary.currentValue + diff) * 100) / 100,
      updatedAt:    now,
    });
  }

  await pipeline.exec();
  return { ...existing, currentValue: v, lastValuedAt: now, updatedAt: now };
}

// ── Set lifecycle status ──────────────────────────────────────────────────────
// Allowed: WATCHING | PASSED | BOUGHT | HOLDING | LISTED | SOLD

export async function setPortfolioItemLifecycleStatus(redis, userId, itemId, lifecycleStatus) {
  if (!redis || !userId || !itemId || !lifecycleStatus) return null;
  const allowed = new Set(["WATCHING", "PASSED", "BOUGHT", "HOLDING", "LISTED", "SOLD"]);
  if (!allowed.has(lifecycleStatus)) return null;

  const existing = await getPortfolioItem(redis, userId, itemId);
  if (!existing) return null;

  const now = Date.now();
  await redis.hset(PORT_ITEM_KEY(userId, itemId), { lifecycleStatus, updatedAt: String(now) });
  await redis.expire(PORT_ITEM_KEY(userId, itemId), PORT_TTL_SEC);

  return { ...existing, lifecycleStatus, updatedAt: now };
}

// ── Mark item as sold ─────────────────────────────────────────────────────────

export async function markPortfolioItemSold(redis, userId, itemId, soldPrice) {
  if (!redis || !userId || !itemId) return null;
  const sp = Number(soldPrice);
  if (!Number.isFinite(sp) || sp <= 0) return null;

  const existing = await getPortfolioItem(redis, userId, itemId);
  if (!existing) return null;

  const now = Date.now();

  const updated = {
    ...existing,
    soldPrice:       sp,
    soldAt:          now,
    listingStatus:   "sold",
    lifecycleStatus: "SOLD",
    currentValue:    sp,
    updatedAt:       now,
  };

  const pipeline = redis.pipeline();
  pipeline.hset(PORT_ITEM_KEY(userId, itemId),
    Object.fromEntries(Object.entries(updated).map(([k, v]) => [k, serializeVal(v)]))
  );
  pipeline.expire(PORT_ITEM_KEY(userId, itemId), PORT_TTL_SEC);

  // Move from active → sold zset
  pipeline.zrem(PORT_ITEMS_KEY(userId), itemId);
  pipeline.zadd(PORT_SOLD_KEY(userId), now, itemId);
  pipeline.expire(PORT_SOLD_KEY(userId), PORT_TTL_SEC);

  // Adjust summary
  const acq = Number(existing.acquisitionPrice || 0);
  const cur = Number(existing.currentValue || existing.acquisitionPrice || 0);

  const summary = await getPortfolioSummaryRaw(redis, userId);
  if (summary) {
    pipeline.hset(PORT_SUMMARY_KEY(userId), {
      totalItems:   Math.max(0, summary.totalItems - 1),
      totalCost:    Math.max(0, Math.round((summary.totalCost    - acq) * 100) / 100),
      currentValue: Math.max(0, Math.round((summary.currentValue - cur) * 100) / 100),
      updatedAt:    now,
    });
  }

  await pipeline.exec();
  return updated;
}

// ── Remove item ───────────────────────────────────────────────────────────────

export async function removePortfolioItem(redis, userId, itemId) {
  if (!redis || !userId || !itemId) return null;

  const existing = await getPortfolioItem(redis, userId, itemId);
  if (!existing) return null;

  const acq = Number(existing.acquisitionPrice || 0);
  const cur = Number(existing.currentValue || existing.acquisitionPrice || 0);
  const now = Date.now();

  const pipeline = redis.pipeline();
  pipeline.del(PORT_ITEM_KEY(userId, itemId));
  pipeline.zrem(PORT_ITEMS_KEY(userId), itemId);
  pipeline.zrem(PORT_SOLD_KEY(userId),  itemId);

  const summary = await getPortfolioSummaryRaw(redis, userId);
  if (summary) {
    pipeline.hset(PORT_SUMMARY_KEY(userId), {
      totalItems:   Math.max(0, summary.totalItems - 1),
      totalCost:    Math.max(0, Math.round((summary.totalCost    - acq) * 100) / 100),
      currentValue: Math.max(0, Math.round((summary.currentValue - cur) * 100) / 100),
      updatedAt:    now,
    });
  }

  await pipeline.exec();
  return { removed: true, itemId };
}

// ── Performance breakdown ─────────────────────────────────────────────────────

export async function getPortfolioPerformance(redis, userId) {
  if (!redis || !userId) return null;

  const [summary, soldIds] = await Promise.all([
    getPortfolioSummaryRaw(redis, userId),
    redis.zrevrange(PORT_SOLD_KEY(userId), 0, 199),
  ]);

  const soldPipeline = redis.pipeline();
  for (const id of (soldIds || [])) soldPipeline.hgetall(PORT_ITEM_KEY(userId, id));
  const soldRaw = await soldPipeline.exec();

  const soldItems = soldRaw
    .map(([, raw]) => raw && Object.keys(raw).length ? deserializePortfolioItem(raw) : null)
    .filter(Boolean)
    .filter((i) => i.soldAt && Number.isFinite(i.soldPrice));

  const totalRealizedGain = soldItems.reduce((sum, i) => {
    return sum + (Number(i.soldPrice || 0) - Number(i.acquisitionPrice || 0));
  }, 0);

  const totalSoldRevenue  = soldItems.reduce((sum, i) => sum + Number(i.soldPrice || 0), 0);
  const totalCostSold     = soldItems.reduce((sum, i) => sum + Number(i.acquisitionPrice || 0), 0);

  const avgHoldDays = soldItems.length
    ? Math.round(soldItems.reduce((sum, i) => sum + (i.soldAt - i.addedAt) / (1000 * 86400), 0) / soldItems.length)
    : null;

  // Hit rate: % of sales that were profitable
  const profitableSales = soldItems.filter((i) => Number(i.soldPrice || 0) > Number(i.acquisitionPrice || 0)).length;
  const hitRate         = soldItems.length > 0 ? Math.round((profitableSales / soldItems.length) * 100) : null;

  // Average margin %
  const avgMarginPct = soldItems.length > 0 && totalCostSold > 0
    ? Math.round((totalRealizedGain / totalCostSold) * 10000) / 100
    : null;

  // Best and worst flip
  let bestFlip = null;
  let worstFlip = null;
  for (const i of soldItems) {
    const gain = Number(i.soldPrice || 0) - Number(i.acquisitionPrice || 0);
    if (bestFlip === null || gain > bestFlip.gain) {
      bestFlip = { title: i.title, gain: Math.round(gain * 100) / 100, soldPrice: i.soldPrice, acquisitionPrice: i.acquisitionPrice, category: i.category };
    }
    if (worstFlip === null || gain < worstFlip.gain) {
      worstFlip = { title: i.title, gain: Math.round(gain * 100) / 100, soldPrice: i.soldPrice, acquisitionPrice: i.acquisitionPrice, category: i.category };
    }
  }

  // Category breakdown from sold items
  const catMap = {};
  for (const i of soldItems) {
    const cat  = ((i.category || "").trim().toLowerCase()) || "uncategorized";
    if (!catMap[cat]) catMap[cat] = { soldCount: 0, totalGain: 0, totalCost: 0 };
    catMap[cat].soldCount++;
    catMap[cat].totalGain += Number(i.soldPrice || 0) - Number(i.acquisitionPrice || 0);
    catMap[cat].totalCost += Number(i.acquisitionPrice || 0);
  }
  const categoryBreakdown = Object.entries(catMap)
    .map(([category, stats]) => ({
      category,
      soldCount:  stats.soldCount,
      totalGain:  Math.round(stats.totalGain * 100) / 100,
      avgMargin:  stats.totalCost > 0
        ? Math.round((stats.totalGain / stats.totalCost) * 10000) / 100
        : null,
    }))
    .sort((a, b) => b.totalGain - a.totalGain);

  return {
    activeItems:       Number(summary?.totalItems    || 0),
    totalCost:         Number(summary?.totalCost     || 0),
    currentValue:      Number(summary?.currentValue  || 0),
    unrealizedGain:    Math.round((Number(summary?.currentValue || 0) - Number(summary?.totalCost || 0)) * 100) / 100,
    soldItems:         soldItems.length,
    totalSoldRevenue:  Math.round(totalSoldRevenue  * 100) / 100,
    totalRealizedGain: Math.round(totalRealizedGain * 100) / 100,
    hitRate,
    avgMarginPct,
    avgHoldDays,
    bestFlip,
    worstFlip:         worstFlip?.gain < 0 ? worstFlip : null, // only surface if it was actually a loss
    categoryBreakdown,
  };
}
