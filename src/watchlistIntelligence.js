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

// Alert cooldown: prevents firing the same alert type for the same item within 12h
const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const KEY_ALERT_COOLDOWN    = (userId, fp, type) => `watchlist:alert_cd:${userId}:${fp}:${type}`;
const KEY_SIMILAR_SEEN      = (userId, fp)        => `watchlist:sim_seen:${userId}:${fp}`;
const KEY_ESCALATION_ANCHOR = (userId, fp)        => `watchlist:esc_anchor:${userId}:${fp}`;
const SIMILAR_SEEN_TTL      = 24 * 3600; // 24h dedup for similar items
const ESCALATION_ANCHOR_TTL = 48 * 3600; // 48h between escalation alerts

async function isAlertOnCooldown(redis, userId, fp, type) {
  if (!redis) return false;
  const raw = await redis.get(KEY_ALERT_COOLDOWN(userId, fp, type));
  return !!raw;
}

async function setAlertCooldown(redis, userId, fp, type) {
  if (!redis) return;
  await redis.set(KEY_ALERT_COOLDOWN(userId, fp, type), "1", "PX", ALERT_COOLDOWN_MS);
}

/**
 * Build the next recommended action for a watched item.
 * BUY_NOW | KEEP_WATCHING | REMOVE_OR_PASS | MONITOR
 */
export function buildWatchNextAction(item, currentPrice, priceHistory = []) {
  const target = finiteOrNull(item?.targetPrice);

  // Target hit → BUY_NOW
  if (target && currentPrice && currentPrice <= target) {
    return { action: "BUY_NOW", reason: `Price hit your target of $${target.toFixed(2)}` };
  }

  // New historical low → BUY_NOW if it's also reasonable vs target
  if (priceHistory.length >= 3 && currentPrice) {
    const prices  = priceHistory.map((h) => h.price).filter(Number.isFinite);
    const prevMin = prices.length > 1 ? Math.min(...prices.slice(1)) : null;
    if (prevMin && currentPrice < prevMin) {
      return { action: "BUY_NOW", reason: `New historical low at $${currentPrice.toFixed(2)}` };
    }
  }

  // Price improved significantly (10%+ drop from first seen)
  const firstPrice = finiteOrNull(item?.marketPriceAtAdd);
  if (firstPrice && currentPrice && (firstPrice - currentPrice) / firstPrice >= 0.10) {
    return { action: "BUY_NOW", reason: `Price dropped ${Math.round(((firstPrice - currentPrice) / firstPrice) * 100)}% since you started watching` };
  }

  // Price trending up or no movement
  if (firstPrice && currentPrice && currentPrice > firstPrice * 1.05) {
    return { action: "REMOVE_OR_PASS", reason: "Price is rising — consider removing or acting now" };
  }

  // No target, no significant movement
  if (!target) {
    return { action: "MONITOR", reason: "No target price set — update your target to get alerts" };
  }

  return { action: "KEEP_WATCHING", reason: "Price not yet at target — keep watching" };
}

/**
 * Check watched items for alert conditions.
 * Fires on: target hit, new historical low, significant drop, meaningful upgrade.
 * Each alert has: alertType, priority (HIGH|MEDIUM|LOW), reason, action, nextAction.
 */
export async function checkWatchlistAlerts(redis, userId, currentPriceMap = {}) {
  if (!redis || !userId) return [];
  const items  = await listWatchlistItems(redis, userId, 100);
  const alerts = [];

  for (const item of items) {
    const fp           = item.fingerprint;
    const currentPrice = finiteOrNull(currentPriceMap[fp]) ?? null;
    if (!currentPrice) continue;

    const lastSeen   = finiteOrNull(item.lastSeenPrice) ?? null;
    const target     = finiteOrNull(item.targetPrice)   ?? null;
    const addedPrice = finiteOrNull(item.marketPriceAtAdd) ?? null;

    // Update lastSeenPrice always
    await redis.hset(KEY_ITEM(userId, item.itemId), "lastSeenPrice", String(currentPrice));

    // ── Alert 1: TARGET HIT (HIGH) ────────────────────────────────────────────
    if (target && currentPrice <= target && item.alertFired !== true) {
      const onCd = await isAlertOnCooldown(redis, userId, fp, "target_hit");
      if (!onCd) {
        alerts.push({
          itemId:       item.itemId,
          brand:        item.brand,
          model:        item.model,
          alertType:    "target_hit",
          priority:     "HIGH",
          currentPrice,
          targetPrice:  target,
          savings:      round2(target - currentPrice),
          savingsPct:   round2(((target - currentPrice) / target) * 100),
          reason:       `Hit your target of $${target.toFixed(2)} — now $${currentPrice.toFixed(2)}`,
          nextAction:   { action: "BUY_NOW", reason: `Price hit your target of $${target.toFixed(2)}` },
        });
        await redis.hset(KEY_ITEM(userId, item.itemId), "alertFired", "true");
        await setAlertCooldown(redis, userId, fp, "target_hit");
      }
      continue; // target hit is the highest priority — skip lower ones
    }

    // ── Alert 2: NEW HISTORICAL LOW (HIGH) ────────────────────────────────────
    if (lastSeen && currentPrice < lastSeen) {
      const drop    = round2(lastSeen - currentPrice);
      const dropPct = round2((drop / lastSeen) * 100);
      if (dropPct >= 10) {
        const onCd = await isAlertOnCooldown(redis, userId, fp, "new_low");
        if (!onCd) {
          alerts.push({
            itemId:     item.itemId,
            brand:      item.brand,
            model:      item.model,
            alertType:  "new_low",
            priority:   dropPct >= 20 ? "HIGH" : "MEDIUM",
            currentPrice,
            previousPrice: lastSeen,
            dropAmount: drop,
            dropPct,
            reason:     `New low: dropped ${dropPct}% to $${currentPrice.toFixed(2)}`,
            nextAction: { action: "BUY_NOW", reason: `New low at $${currentPrice.toFixed(2)} — ${dropPct}% below last seen` },
          });
          await setAlertCooldown(redis, userId, fp, "new_low");
        }
      }
    }

    // ── Alert 3: SIGNIFICANT DROP FROM INITIAL PRICE (MEDIUM) ────────────────
    if (addedPrice && currentPrice < addedPrice) {
      const drop    = round2(addedPrice - currentPrice);
      const dropPct = round2((drop / addedPrice) * 100);
      if (dropPct >= 15) {
        const onCd = await isAlertOnCooldown(redis, userId, fp, "sig_drop");
        if (!onCd) {
          alerts.push({
            itemId:     item.itemId,
            brand:      item.brand,
            model:      item.model,
            alertType:  "significant_drop",
            priority:   "MEDIUM",
            currentPrice,
            addedPrice,
            dropAmount: drop,
            dropPct,
            reason:     `Down ${dropPct}% from $${addedPrice.toFixed(2)} when you added it`,
            nextAction: { action: "BUY_NOW", reason: `Price dropped ${dropPct}% since you started watching` },
          });
          await setAlertCooldown(redis, userId, fp, "sig_drop");
        }
      }
    }
  }

  return alerts;
}

// ── New alert types (Phase 8) ─────────────────────────────────────────────────

/**
 * Alert type: RELIST_OPPORTUNITY
 * Fires when a previously-watched item that disappeared (went out of stock / sold)
 * comes back on the market at equal or better price.
 *
 * Trigger: lastSeenPrice was set, no new price observed for > 5 days,
 *          now a new listing at same or lower price appears.
 *
 * @param {object} item         — watchlist item
 * @param {number} currentPrice — new observation price
 * @param {Array}  priceHistory — from getWatchlistPriceHistory
 * @returns {object|null} alert or null
 */
export async function checkRelistAlert(redis, userId, item, currentPrice, priceHistory = []) {
  if (!redis || !item?.fingerprint || !currentPrice) return null;
  const fp = item.fingerprint;

  // Check cooldown
  const onCd = await isAlertOnCooldown(redis, userId, fp, "relist");
  if (onCd) return null;

  const lastSeen = finiteOrNull(item.lastSeenPrice);
  if (!lastSeen) return null; // never seen before — not a relist

  const lastSeenAt = Number(item.lastCheckedAt) || 0;
  if (!lastSeenAt) return null;

  // Must have had a gap of at least 5 days without price observation
  const gapDays = (Date.now() - lastSeenAt) / 86400000;
  if (gapDays < 5) return null;

  // New price must be at or below the last seen price
  if (currentPrice > lastSeen * 1.02) return null;

  const savings = round2(lastSeen - currentPrice);
  await setAlertCooldown(redis, userId, fp, "relist");

  return {
    itemId:       item.itemId,
    brand:        item.brand,
    model:        item.model,
    fingerprint:  fp,
    alertType:    "relist_opportunity",
    priority:     "MEDIUM",
    currentPrice,
    lastSeenPrice: lastSeen,
    gapDays:      Math.round(gapDays),
    savings:      savings > 0 ? savings : 0,
    reason:       `Back on market after ${Math.round(gapDays)} days${savings > 0 ? ` — $${savings.toFixed(2)} cheaper` : " — same price as before"}`,
    nextAction:   { action: "BUY_NOW", reason: `Relisted at $${currentPrice.toFixed(2)} — was $${lastSeen.toFixed(2)}` },
  };
}

/**
 * Alert type: SIMILAR_ITEM_SURFACED
 * Fires when a different listing for the same item fingerprint appears
 * at a meaningfully better price than the item currently on the watchlist.
 *
 * Requirements:
 *   - Different listing (different source or URL)
 *   - At least 8% cheaper than current watchlist marketPrice
 *   - Alert not in seen set
 *
 * @param {object} item         — watchlist item
 * @param {Array}  liveListings — fresh market listings for the same fingerprint
 * @returns {object|null} alert or null
 */
export async function checkSimilarItemAlert(redis, userId, item, liveListings = []) {
  if (!redis || !item?.fingerprint || !liveListings.length) return null;
  const fp = item.fingerprint;

  const onCd = await isAlertOnCooldown(redis, userId, fp, "similar");
  if (onCd) return null;

  const basePrice = finiteOrNull(item.lastSeenPrice) || finiteOrNull(item.marketPriceAtAdd);
  if (!basePrice) return null;

  // Find listings meaningfully cheaper than the watched price
  const better = liveListings
    .map(l => ({
      ...l,
      _p: Number(l?.price ?? l?.totalPrice ?? l?.currentPrice),
      _src: String(l?.source || l?.marketplace || "").toLowerCase(),
    }))
    .filter(l => Number.isFinite(l._p) && l._p > 0 && (basePrice - l._p) / basePrice >= 0.08)
    .sort((a, b) => a._p - b._p);

  if (!better.length) return null;

  const best = better[0];
  const saving = round2(basePrice - best._p);
  const savingPct = round2((saving / basePrice) * 100);

  // Check dedup
  const seenKey = `${best._src}|${round2(best._p)}`;
  const alreadySeen = await redis.sismember(KEY_SIMILAR_SEEN(userId, fp), seenKey).catch(() => 0);
  if (alreadySeen) return null;

  await redis.sadd(KEY_SIMILAR_SEEN(userId, fp), seenKey).catch(() => {});
  await redis.expire(KEY_SIMILAR_SEEN(userId, fp), SIMILAR_SEEN_TTL).catch(() => {});
  await setAlertCooldown(redis, userId, fp, "similar");

  return {
    itemId:       item.itemId,
    brand:        item.brand,
    model:        item.model,
    fingerprint:  fp,
    alertType:    "similar_item_surfaced",
    priority:     savingPct >= 20 ? "HIGH" : "MEDIUM",
    currentPrice:    best._p,
    watchlistPrice:  basePrice,
    savingAmount:    saving,
    savingPct,
    source:          best._src,
    listingUrl:      best.url || best.link || null,
    listingTitle:    String(best.title || "").slice(0, 100),
    reason:          `Better listing found: $${best._p.toFixed(2)} on ${best._src} — ${savingPct}% below your watched price`,
    nextAction:      { action: "BUY_NOW", reason: `$${saving.toFixed(2)} savings vs. your watched price` },
  };
}

/**
 * Alert type: OPPORTUNITY_ESCALATION
 * Fires when an item's opportunity signal has meaningfully improved since
 * the last escalation anchor (bigger spread, improved urgency, better signal).
 *
 * Trigger: current spread vs market has grown by >= 10% since last check.
 *
 * @param {object} item          — watchlist item
 * @param {number} currentPrice
 * @param {number} marketMedian
 * @param {string} currentSignal — current buy signal
 * @returns {object|null} alert or null
 */
export async function checkEscalationAlert(redis, userId, item, currentPrice, marketMedian, currentSignal) {
  if (!redis || !item?.fingerprint || !currentPrice || !marketMedian) return null;
  if (!["STRONG BUY", "GOOD DEAL"].includes(currentSignal)) return null;

  const fp = item.fingerprint;

  // Load anchor: { price, spread, signal, setAt }
  const anchorRaw = await redis.get(KEY_ESCALATION_ANCHOR(userId, fp)).catch(() => null);
  const anchor    = anchorRaw ? (() => { try { return JSON.parse(anchorRaw); } catch { return null; } })() : null;

  const currentSpread = marketMedian > 0 ? round2((marketMedian - currentPrice) / marketMedian) : 0;

  if (!anchor) {
    // First time — just store anchor, no alert
    await redis.set(KEY_ESCALATION_ANCHOR(userId, fp), JSON.stringify({ price: currentPrice, spread: currentSpread, signal: currentSignal, setAt: Date.now() }), "EX", ESCALATION_ANCHOR_TTL).catch(() => {});
    return null;
  }

  // Check if opportunity materially improved
  const spreadImprovement = currentSpread - (anchor.spread || 0);
  const signalUpgrade = anchor.signal !== "STRONG BUY" && currentSignal === "STRONG BUY";

  const escalated = spreadImprovement >= 0.10 || signalUpgrade;
  if (!escalated) return null;

  // Update anchor
  await redis.set(KEY_ESCALATION_ANCHOR(userId, fp), JSON.stringify({ price: currentPrice, spread: currentSpread, signal: currentSignal, setAt: Date.now() }), "EX", ESCALATION_ANCHOR_TTL).catch(() => {});

  const reason = signalUpgrade
    ? `Signal upgraded to STRONG BUY — better deal than when you added it`
    : `Spread improved ${Math.round(spreadImprovement * 100)}% — now ${Math.round(currentSpread * 100)}% below market`;

  return {
    itemId:       item.itemId,
    brand:        item.brand,
    model:        item.model,
    fingerprint:  fp,
    alertType:    "opportunity_escalation",
    priority:     signalUpgrade ? "HIGH" : "MEDIUM",
    currentPrice,
    marketMedian,
    currentSpread:   round2(currentSpread * 100),
    spreadImprovement: round2(spreadImprovement * 100),
    previousSignal:  anchor.signal,
    currentSignal,
    reason,
    nextAction:   { action: "BUY_NOW", reason: reason },
  };
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
