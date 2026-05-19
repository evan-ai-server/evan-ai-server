// src/portfolioTracker.js
// Portfolio Tracker: Redis-backed registry of items a user owns.
import {
  computeOptimalListPrice,
  selectExitPlatform,
  computeHoldOrFold,
  computeDaysHeld,
} from "./exitIntelligence.js";
// Tracks purchase price, current market value, unrealized P&L, and
// surfaces "sell now" signals when the market moves in their favor.
// "Portfolio: 8 items, $1,240 value, +$340 unrealized gain. 2 should sell now."

// ── Redis key schemas ─────────────────────────────────────────────────────────
// portfolio:user:{userId}           ZSET  — item IDs (score = addedAt timestamp)
// portfolio:item:{userId}:{itemId}  HASH  — item record
// portfolio:prices:{userId}         HASH  — latest market prices per itemId

const KEY_PORTFOLIO  = (userId)         => `portfolio:user:${userId}`;
const KEY_ITEM       = (userId, itemId) => `portfolio:item:${userId}:${itemId}`;
const KEY_PRICES     = (userId)         => `portfolio:prices:${userId}`;

const PORTFOLIO_TTL  = 60 * 60 * 24 * 365; // 1 year

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Add an item to the portfolio.
 */
export async function addPortfolioItem(redis, userId = "", item = {}) {
  if (!redis || !userId) return null;

  const itemId = item?.itemId || item?.id || `item_${Date.now()}`;
  const now    = Date.now();

  const record = {
    itemId,
    title:          String(item?.title        || item?.model || "Unknown"),
    brand:          String(item?.brand        || ""),
    model:          String(item?.model        || ""),
    category:       String(item?.category     || ""),
    purchasePrice:  String(finiteOrNull(item?.purchasePrice ?? item?.scannedPrice) ?? 0),
    condition:      String(item?.condition    || "good"),
    size:           String(item?.size         || ""),
    platform:       String(item?.platform     || ""),
    addedAt:        String(now),
    notes:          String(item?.notes        || ""),
  };

  const pipeline = redis.pipeline();
  pipeline.zadd(KEY_PORTFOLIO(userId), now, itemId);
  pipeline.hmset(KEY_ITEM(userId, itemId), record);
  pipeline.expire(KEY_ITEM(userId, itemId), PORTFOLIO_TTL);
  pipeline.expire(KEY_PORTFOLIO(userId), PORTFOLIO_TTL);
  await pipeline.exec();

  return { added: true, itemId, record };
}

/**
 * Remove an item from the portfolio (sold / no longer owned).
 */
export async function removePortfolioItem(redis, userId = "", itemId = "") {
  if (!redis || !userId || !itemId) return false;
  const pipeline = redis.pipeline();
  pipeline.zrem(KEY_PORTFOLIO(userId), itemId);
  pipeline.del(KEY_ITEM(userId, itemId));
  await pipeline.exec();
  return true;
}

/**
 * Update the current market price for a portfolio item.
 */
export async function updatePortfolioItemPrice(redis, userId = "", itemId = "", currentMarketPrice = null) {
  if (!redis || !userId || !itemId) return null;
  const price = finiteOrNull(currentMarketPrice);
  if (!price) return null;
  await redis.hset(KEY_PRICES(userId), itemId, String(price));
  return { updated: true, itemId, currentMarketPrice: price };
}

/**
 * Compute P&L for a single portfolio item.
 */
function computeItemPnL(record = {}, currentPrice = null) {
  const purchase = finiteOrNull(record?.purchasePrice);
  const current  = finiteOrNull(currentPrice);

  if (!purchase) return { purchase: null, current: null, gain: null, gainPct: null, shouldSell: false };

  const gain    = current !== null ? round2(current - purchase) : null;
  const gainPct = (gain !== null && purchase) ? round2((gain / purchase) * 100) : null;

  // Sell signal: up 20%+ or showing demand/momentum signals
  const shouldSell = gainPct !== null && gainPct >= 20;

  return { purchase, current, gain, gainPct, shouldSell };
}

/**
 * Fetch full portfolio with P&L for all items.
 */
export async function getPortfolio(redis, userId = "") {
  if (!redis || !userId) return null;

  const itemIds = await redis.zrevrange(KEY_PORTFOLIO(userId), 0, -1);
  if (!itemIds.length) {
    return { items: [], totalItems: 0, totalCost: 0, totalValue: 0, unrealizedGain: 0, sellNow: [] };
  }

  const prices = await redis.hgetall(KEY_PRICES(userId)) || {};

  const items = await Promise.all(
    itemIds.map(async (itemId) => {
      const record = await redis.hgetall(KEY_ITEM(userId, itemId));
      if (!record) return null;
      const currentPrice = finiteOrNull(prices[itemId]) || null;
      const pnl      = computeItemPnL(record, currentPrice);
      const daysHeld = computeDaysHeld(record);

      // Exit intelligence: sell-side guidance attached per item
      const listPriceResult = computeOptimalListPrice(
        record.category || "",
        currentPrice ? [{ price: currentPrice }] : [],
        record.condition || "",
        daysHeld,
      );
      const exitPlatform = selectExitPlatform(
        record.category || "",
        currentPrice ?? finiteOrNull(record.purchasePrice) ?? 0,
        record.condition || "",
        "NATIONAL",
      );
      const holdOrFold = computeHoldOrFold(record, currentPrice, daysHeld);
      const exitIntel = {
        recommendedListPrice: listPriceResult.price ?? currentPrice ?? finiteOrNull(record.purchasePrice),
        preferredPlatform:    exitPlatform.primary,
        secondaryPlatform:    exitPlatform.secondary,
        estimatedFee:         exitPlatform.fee,
        holdOrFold,
        daysHeld,
      };

      return { ...record, ...pnl, currentPrice, exitIntel };
    })
  );

  const valid = items.filter(Boolean);

  const totalCost      = round2(valid.reduce((s, i) => s + (finiteOrNull(i.purchase) || 0), 0));
  const totalValue     = round2(valid.reduce((s, i) => s + (finiteOrNull(i.currentPrice || i.purchase) || 0), 0));
  const unrealizedGain = round2(totalValue - totalCost);
  const gainPct        = totalCost > 0 ? round2((unrealizedGain / totalCost) * 100) : 0;
  const sellNow        = valid.filter(i => i.shouldSell);

  return {
    items: valid,
    totalItems:     valid.length,
    totalCost,
    totalValue,
    unrealizedGain,
    gainPct,
    sellNow,
    topSignal: valid.length
      ? `Portfolio: ${valid.length} items, $${totalValue.toFixed(2)} value, ${unrealizedGain >= 0 ? "+" : ""}$${unrealizedGain.toFixed(2)} unrealized${sellNow.length ? ` — ${sellNow.length} item${sellNow.length !== 1 ? "s" : ""} should sell now` : ""}`
      : "Portfolio is empty — scan items and mark as owned to track them",
  };
}

/**
 * Master portfolio tracker payload — fetches and returns full portfolio.
 */
export async function buildPortfolioPayload(redis, userId = "") {
  const portfolio = await getPortfolio(redis, userId);
  return {
    portfolio: portfolio || null,
    topSignal: portfolio?.topSignal || null,
  };
}
