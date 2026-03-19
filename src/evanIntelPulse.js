// src/evanIntelPulse.js
// Evan Intel Pulse: the daily habit engine. Generates a personalized daily
// digest per user: watchlist moves, hot deals in their categories, market
// momentum updates, and actionable flip opportunities.
// "Today: 2 watchlist hits, $340 in deals found, sneakers surging."

// ── Redis key schemas ─────────────────────────────────────────────────────────
// pulse:user:{userId}            HASH  — pulse config { categories, minDealPct }
// pulse:digest:{userId}:{date}   STRING (JSON) — cached daily digest
// pulse:feed:{userId}            ZSET  — ordered feed events (score = timestamp)

const KEY_CONFIG  = (userId) => `pulse:user:${userId}`;
const KEY_DIGEST  = (userId, date) => `pulse:digest:${userId}:${date}`;
const KEY_FEED    = (userId) => `pulse:feed:${userId}`;

const FEED_TTL    = 60 * 60 * 24 * 7;  // 7 days
const DIGEST_TTL  = 60 * 60 * 20;      // 20 hours (refreshes daily)

// ── Pulse event types ─────────────────────────────────────────────────────────
const PULSE_EVENT_TYPES = {
  WATCHLIST_HIT:      { priority: 1, icon: "🎯", label: "Watchlist Hit" },
  DEAL_FOUND:         { priority: 2, icon: "💰", label: "Deal Found" },
  MARKET_SURGE:       { priority: 3, icon: "🔥", label: "Market Surge" },
  PRICE_DROP:         { priority: 4, icon: "📉", label: "Price Drop" },
  FLIP_OPPORTUNITY:   { priority: 5, icon: "⚡", label: "Flip Opportunity" },
  MARKET_WARNING:     { priority: 6, icon: "⚠️", label: "Market Warning" },
  RESTOCK_ALERT:      { priority: 7, icon: "🛒", label: "Restock Alert" },
  STREAK_MILESTONE:   { priority: 8, icon: "🔥", label: "Streak Milestone" },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Set a user's pulse configuration (categories of interest, deal threshold).
 */
export async function setPulseConfig(redis, userId = "", config = {}) {
  if (!redis || !userId) return null;
  const { categories = [], minDealPct = 10 } = config;
  await redis.hset(KEY_CONFIG(userId), {
    categories:  JSON.stringify(categories),
    minDealPct:  String(minDealPct),
  });
  return { configured: true };
}

/**
 * Get a user's pulse configuration.
 */
export async function getPulseConfig(redis, userId = "") {
  if (!redis || !userId) return { categories: [], minDealPct: 10 };
  const raw = await redis.hgetall(KEY_CONFIG(userId));
  return {
    categories: raw?.categories ? JSON.parse(raw.categories) : [],
    minDealPct: parseFloat(raw?.minDealPct || 10),
  };
}

/**
 * Push an event into the user's pulse feed.
 */
export async function pushPulseEvent(redis, userId = "", event = {}) {
  if (!redis || !userId) return null;
  const ts   = Date.now();
  const entry = JSON.stringify({ ...event, ts });
  await redis.zadd(KEY_FEED(userId), ts, entry);
  await redis.expire(KEY_FEED(userId), FEED_TTL);
  // Keep feed trimmed to 200 events
  await redis.zremrangebyrank(KEY_FEED(userId), 0, -201);
  return { pushed: true };
}

/**
 * Evaluate a completed scan for pulse-worthy events and push them.
 */
export async function evaluateScanForPulse(redis, userId = "", scanResult = {}) {
  if (!redis || !userId) return [];

  const events = [];
  const config = await getPulseConfig(redis, userId);

  const verdict  = scanResult?.dealComparator?.verdict || null;
  const category = scanResult?.category || "";
  const brand    = scanResult?.visionIdentity?.brand || "";
  const model    = scanResult?.visionIdentity?.model || "";
  const itemName = [brand, model].filter(Boolean).join(" ") || "Unknown item";

  // ── Deal found ──────────────────────────────────────────────────────────
  if (verdict === "steal" || verdict === "good") {
    const savings = scanResult?.priceTargets?.targets?.netProfit
      || scanResult?.dealComparator?.savingsAmount
      || null;
    events.push({
      type:    "DEAL_FOUND",
      label:   PULSE_EVENT_TYPES.DEAL_FOUND.label,
      icon:    PULSE_EVENT_TYPES.DEAL_FOUND.icon,
      title:   `${verdict === "steal" ? "🔥 Steal Alert" : "💰 Good Deal"}: ${itemName}`,
      body:    savings ? `~$${savings.toFixed(2)} below market value` : `Priced below market`,
      category,
      itemName,
    });
  }

  // ── Market surge in user's categories ──────────────────────────────────
  const momentumTier = scanResult?.marketMomentum?.overallTier || null;
  if (momentumTier === "surging" && (config.categories.includes(category) || !config.categories.length)) {
    events.push({
      type:    "MARKET_SURGE",
      label:   PULSE_EVENT_TYPES.MARKET_SURGE.label,
      icon:    PULSE_EVENT_TYPES.MARKET_SURGE.icon,
      title:   `${category} prices surging`,
      body:    scanResult?.marketMomentum?.topSignal || "Strong upward momentum detected",
      category,
    });
  }

  // ── Flip opportunity ────────────────────────────────────────────────────
  const flipScore = scanResult?.flipScore?.flipScore?.score ?? null;
  if (flipScore && flipScore >= 72) {
    events.push({
      type:    "FLIP_OPPORTUNITY",
      label:   PULSE_EVENT_TYPES.FLIP_OPPORTUNITY.label,
      icon:    PULSE_EVENT_TYPES.FLIP_OPPORTUNITY.icon,
      title:   `Flip opportunity: ${itemName}`,
      body:    scanResult?.flipScore?.flipScore?.topSignal || `Flip Score ${flipScore}/100`,
      category,
      itemName,
      flipScore,
    });
  }

  // ── Restock alert ───────────────────────────────────────────────────────
  const restock = scanResult?.releaseCalendar?.restockIntel;
  if (restock?.restockLikely && restock?.msrp?.worthBuyingAtRetail) {
    events.push({
      type:    "RESTOCK_ALERT",
      label:   PULSE_EVENT_TYPES.RESTOCK_ALERT.label,
      icon:    PULSE_EVENT_TYPES.RESTOCK_ALERT.icon,
      title:   `Restock likely: ${itemName}`,
      body:    restock?.recommendation || scanResult?.releaseCalendar?.topSignal || "",
      category,
      itemName,
    });
  }

  // Push all events
  for (const event of events) {
    await pushPulseEvent(redis, userId, event);
  }

  return events;
}

/**
 * Build the daily pulse digest for a user.
 */
export async function buildDailyPulse(redis, userId = "") {
  if (!redis || !userId) return null;

  const today  = new Date().toISOString().split("T")[0];
  const cached = await redis.get(KEY_DIGEST(userId, today));
  if (cached) {
    try { return JSON.parse(cached); } catch { /* fall through */ }
  }

  // Fetch last 24 hours of feed events
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const raw   = await redis.zrangebyscore(KEY_FEED(userId), since, "+inf");
  const events = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

  // Group by type
  const byType = {};
  for (const e of events) {
    if (!byType[e.type]) byType[e.type] = [];
    byType[e.type].push(e);
  }

  const dealCount     = (byType.DEAL_FOUND || []).length;
  const flipCount     = (byType.FLIP_OPPORTUNITY || []).length;
  const surgeCount    = (byType.MARKET_SURGE || []).length;
  const watchlistHits = (byType.WATCHLIST_HIT || []).length;

  // Top events (priority ordered)
  const topEvents = events
    .sort((a, b) => (PULSE_EVENT_TYPES[a.type]?.priority || 99) - (PULSE_EVENT_TYPES[b.type]?.priority || 99))
    .slice(0, 5);

  const headline = [
    watchlistHits ? `${watchlistHits} watchlist hit${watchlistHits !== 1 ? "s" : ""}` : null,
    dealCount     ? `${dealCount} deal${dealCount !== 1 ? "s" : ""} found`             : null,
    flipCount     ? `${flipCount} flip opportunit${flipCount !== 1 ? "ies" : "y"}`     : null,
    surgeCount    ? `${surgeCount} market surge${surgeCount !== 1 ? "s" : ""}`         : null,
  ].filter(Boolean).join(", ");

  const digest = {
    date:          today,
    userId,
    headline:      headline || "No major events today — keep scanning",
    eventCount:    events.length,
    topEvents,
    summary: {
      dealCount,
      flipCount,
      watchlistHits,
      surgeCount,
    },
    topSignal: headline
      ? `Today's Evan Pulse: ${headline}`
      : "Quiet market — good time to watch for price drops",
  };

  // Cache the digest
  await redis.set(KEY_DIGEST(userId, today), JSON.stringify(digest), "EX", DIGEST_TTL);
  return digest;
}

/**
 * Master Evan Intel Pulse payload (returns current pulse + recent feed).
 */
export async function buildEvanIntelPulsePayload(redis, userId = "") {
  if (!redis || !userId) return null;

  const [digest, config] = await Promise.all([
    buildDailyPulse(redis, userId),
    getPulseConfig(redis, userId),
  ]);

  // Recent feed (last 10 events across all time)
  const rawFeed = await redis.zrevrange(KEY_FEED(userId), 0, 9);
  const recentFeed = rawFeed.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

  return {
    digest,
    config,
    recentFeed,
    topSignal: digest?.topSignal || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
