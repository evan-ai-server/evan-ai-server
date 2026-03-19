// src/watchlistIntelligence.js
// Smart watchlist: add items with target prices, track price movement across scans,
// generate "price hit target" alerts, cross-user demand signals, Redis-backed.

// ── Redis key schema ──────────────────────────────────────────────────────────
// watchlist:user:{userId}             ZSET  — itemId scored by addedAt timestamp
// watchlist:item:{userId}:{itemId}    HASH  — item data + target price
// watchlist:price:{itemFingerprint}   ZSET  — observed prices scored by timestamp
// watchlist:watchers:{itemFp}         SET   — set of userIds watching this item

const KEY_USER_LIST     = (userId)           => `watchlist:user:${userId}`;
const KEY_ITEM          = (userId, itemId)   => `watchlist:item:${userId}:${itemId}`;
const KEY_PRICE_HISTORY = (fp)               => `watchlist:price:${fp}`;
const KEY_WATCHERS      = (fp)               => `watchlist:watchers:${fp}`;

const ITEM_TTL_DAYS     = 180; // 6 months
const PRICE_HISTORY_TTL = 90 * 86400; // 90 days

// ── Fingerprint ───────────────────────────────────────────────────────────────
function itemFingerprint(identity = {}) {
  const parts = [
    String(identity?.brand || "").toLowerCase().trim(),
    String(identity?.model || "").toLowerCase().trim(),
    String(identity?.category || "").toLowerCase().trim(),
  ].filter(Boolean);
  return parts.join(":").replace(/\s+/g, "_") || "unknown";
}

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Add an item to a user's watchlist.
 */
export async function addToWatchlist(redis, userId, item = {}) {
  if (!redis || !userId) return null;

  const {
    identity     = {},
    targetPrice  = null,
    marketPrice  = null,
    category     = "",
    notes        = "",
    imageHash    = null,
  } = item;

  const itemId = `${itemFingerprint({ ...identity, category })}_${Date.now()}`;
  const fp     = itemFingerprint({ ...identity, category });
  const now    = Date.now();

  const data = {
    itemId,
    fingerprint:  fp,
    brand:        identity?.brand    || "",
    model:        identity?.model    || "",
    category:     category           || identity?.category || "",
    targetPrice:  targetPrice        != null ? String(targetPrice) : "",
    marketPriceAtAdd: marketPrice    != null ? String(marketPrice) : "",
    imageHash:    imageHash          || "",
    notes,
    addedAt:      String(now),
    status:       "watching",
    lastCheckedAt:"",
    lastSeenPrice:"",
    alertFired:   "false",
  };

  const p = redis.pipeline();
  p.hset(KEY_ITEM(userId, itemId), data);
  p.expire(KEY_ITEM(userId, itemId), ITEM_TTL_DAYS * 86400);
  p.zadd(KEY_USER_LIST(userId), now, itemId);
  p.expire(KEY_USER_LIST(userId), ITEM_TTL_DAYS * 86400);
  p.sadd(KEY_WATCHERS(fp), userId);
  p.expire(KEY_WATCHERS(fp), ITEM_TTL_DAYS * 86400);
  await p.exec();

  return { itemId, fingerprint: fp, ...data };
}

/**
 * Remove an item from a user's watchlist.
 */
export async function removeFromWatchlist(redis, userId, itemId) {
  if (!redis || !userId || !itemId) return false;
  // Need fingerprint to remove from watchers set
  const raw = await redis.hgetall(KEY_ITEM(userId, itemId));
  const p   = redis.pipeline();
  p.del(KEY_ITEM(userId, itemId));
  p.zrem(KEY_USER_LIST(userId), itemId);
  if (raw?.fingerprint) p.srem(KEY_WATCHERS(raw.fingerprint), userId);
  await p.exec();
  return true;
}

/**
 * List all watchlist items for a user.
 */
export async function listWatchlistItems(redis, userId, limit = 50) {
  if (!redis || !userId) return [];
  const ids = await redis.zrevrange(KEY_USER_LIST(userId), 0, limit - 1);
  if (!ids.length) return [];

  const p = redis.pipeline();
  for (const id of ids) p.hgetall(KEY_ITEM(userId, id));
  const results = await p.exec();

  return results
    .map(([, data]) => data)
    .filter(Boolean)
    .map(deserializeWatchlistItem);
}

/**
 * Record a new price observation for a fingerprinted item.
 */
export async function recordWatchlistPriceObservation(redis, fingerprint, price, source = "") {
  if (!redis || !fingerprint || !finiteOrNull(price)) return;
  const now    = Date.now();
  const member = `${round2(price)}|${source}|${now}`;
  await redis.zadd(KEY_PRICE_HISTORY(fingerprint), now, member);
  await redis.expire(KEY_PRICE_HISTORY(fingerprint), PRICE_HISTORY_TTL);
  // Keep only last 100 observations
  await redis.zremrangebyrank(KEY_PRICE_HISTORY(fingerprint), 0, -101);
}

/**
 * Get price history for a fingerprinted item.
 */
export async function getWatchlistPriceHistory(redis, fingerprint, limit = 30) {
  if (!redis || !fingerprint) return [];
  const raw = await redis.zrevrange(KEY_PRICE_HISTORY(fingerprint), 0, limit - 1, "WITHSCORES");

  const entries = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [price, source] = String(raw[i]).split("|");
    const ts = Number(raw[i + 1]);
    entries.push({ price: round2(Number(price)), source: source || "unknown", timestamp: ts });
  }
  return entries;
}

/**
 * Check if any watched item's price has hit the user's target.
 * Returns items where currentPrice <= targetPrice.
 */
export async function checkWatchlistAlerts(redis, userId, currentPriceMap = {}) {
  if (!redis || !userId) return [];
  const items   = await listWatchlistItems(redis, userId, 100);
  const alerts  = [];

  for (const item of items) {
    if (!item.targetPrice || item.alertFired === true) continue;

    const fp           = item.fingerprint;
    const currentPrice = finiteOrNull(currentPriceMap[fp]) || null;
    if (!currentPrice) continue;

    if (currentPrice <= item.targetPrice) {
      alerts.push({
        itemId:       item.itemId,
        brand:        item.brand,
        model:        item.model,
        targetPrice:  item.targetPrice,
        currentPrice,
        savings:      round2(item.targetPrice - currentPrice),
        savingsPct:   round2(((item.targetPrice - currentPrice) / item.targetPrice) * 100),
        signal:       `${item.brand} ${item.model} hit your target price of $${item.targetPrice.toFixed(2)} — now $${currentPrice.toFixed(2)}`,
      });
      // Mark alert fired
      await redis.hset(KEY_ITEM(userId, item.itemId), "alertFired", "true", "lastSeenPrice", String(currentPrice));
    }
  }

  return alerts;
}

/**
 * Get the watcher count for an item fingerprint (cross-user demand signal).
 */
export async function getWatcherCount(redis, fingerprint) {
  if (!redis || !fingerprint) return 0;
  return await redis.scard(KEY_WATCHERS(fingerprint)) || 0;
}

/**
 * Build a watchlist demand signal for display.
 * "47 users are watching this item" type intelligence.
 */
export async function buildWatchlistDemandSignal(redis, identity = {}, category = "") {
  const fp      = itemFingerprint({ ...identity, category });
  const count   = await getWatcherCount(redis, fp);

  if (count === 0) return null;

  const signal = count >= 50  ? `${count}+ users watching — extremely high demand signal`
               : count >= 20  ? `${count} users watching — strong demand, move quickly`
               : count >= 5   ? `${count} users watching — notable interest in this item`
               : `${count} user${count !== 1 ? "s" : ""} watching this item`;

  return {
    watcherCount: count,
    tier:         count >= 50 ? "extreme" : count >= 20 ? "high" : count >= 5 ? "notable" : "low",
    signal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function deserializeWatchlistItem(raw) {
  if (!raw) return null;
  return {
    ...raw,
    targetPrice:      finiteOrNull(raw.targetPrice),
    marketPriceAtAdd: finiteOrNull(raw.marketPriceAtAdd),
    lastSeenPrice:    finiteOrNull(raw.lastSeenPrice),
    addedAt:          raw.addedAt    ? Number(raw.addedAt)    : null,
    alertFired:       raw.alertFired === "true",
  };
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
