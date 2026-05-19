// src/dealVelocityEngine.js
// Deal velocity detection — identifies rapid price drops and seller urgency signals.
//
// ACTIONABILITY GATES (all must pass to fire an alert):
//   1. Price still below market median — not just a correction to fair value
//   2. Drop rate qualifies as RAPID (not gradual drift)
//   3. Alert not on cooldown for this user+item
//   4. Signal must be STRONG BUY or GOOD DEAL at current price
//
// Redis keys:
//   velocity:cooldown:{userId}:{fp}   STRING  — per-user per-item cooldown (6h TTL)
//   velocity:drops:{fp}               ZSET    — price drop events for an item (scored by ts)

const KEY_COOLDOWN  = (uid, fp) => `velocity:cooldown:${uid}:${fp}`;
const KEY_DROPS     = (fp)      => `velocity:drops:${fp}`;

const COOLDOWN_MS   = 6 * 3600 * 1000;   // 6h per user per item
const DROPS_TTL     = 7 * 86400;         // 7-day window for drop history
const MAX_DROPS     = 50;

// Velocity thresholds
const RAPID_DROP_PCT_24H  = 0.10;  // 10%+ drop in < 24h = RAPID
const RAPID_DROP_PCT_72H  = 0.20;  // 20%+ drop in < 72h = RAPID
const GRADUAL_DROP_PCT    = 0.07;  // 7–10% in 24h = GRADUAL

// Urgency signals in listing titles / descriptions
const URGENCY_PATTERNS = [
  /\b(need[s]?\s+(it\s+)?gone|must\s+sell|have\s+to\s+sell)\b/i,
  /\b(moving|relocating|downsizing|clearing\s+out)\b/i,
  /\b(quick\s+sale|fast\s+sale|quick\s+flip|asap)\b/i,
  /\b(price\s+(drop|reduced|lowered|cut)|just\s+reduced)\b/i,
  /\b(obo|offers?\s+welcome|make\s+(an\s+)?offer)\b/i,
  /\b(last\s+chance|final\s+price|won['']?t\s+last)\b/i,
];

// ── Drop event recording ──────────────────────────────────────────────────────

/**
 * Record a price drop event for an item fingerprint.
 * Call whenever a lower price is observed vs. the previous known price.
 *
 * @param {string} fingerprint
 * @param {number} prevPrice
 * @param {number} newPrice
 * @param {string} source — platform source
 */
export async function recordPriceDropEvent(redis, fingerprint, prevPrice, newPrice, source = "") {
  if (!redis || !fingerprint || !prevPrice || !newPrice) return;
  if (newPrice >= prevPrice) return; // not a drop

  const dropPct = round2((prevPrice - newPrice) / prevPrice);
  const event = JSON.stringify({
    prevPrice: round2(prevPrice),
    newPrice:  round2(newPrice),
    dropPct,
    source,
    ts: Date.now(),
  });

  await redis.zadd(KEY_DROPS(fingerprint), Date.now(), event);
  await redis.zremrangebyrank(KEY_DROPS(fingerprint), 0, -(MAX_DROPS + 1));
  await redis.expire(KEY_DROPS(fingerprint), DROPS_TTL);
}

/**
 * Load recent price drop events for an item fingerprint.
 * @returns {Array<{prevPrice, newPrice, dropPct, source, ts}>}
 */
export async function loadDropEvents(redis, fingerprint, maxAgeMs = 7 * 86400 * 1000) {
  if (!redis || !fingerprint) return [];
  try {
    const cutoff = Date.now() - maxAgeMs;
    const raw = await redis.zrangebyscore(KEY_DROPS(fingerprint), cutoff, "+inf");
    return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── Velocity classification ───────────────────────────────────────────────────

/**
 * Classify drop events into a velocity tier.
 *
 * @param {Array} drops — from loadDropEvents
 * @param {number} currentPrice
 * @param {number} priceAtBaselineTs — the oldest reference price in the window
 * @returns {{ tier: "RAPID"|"GRADUAL"|"NONE", totalDropPct, dropsIn24h, dropsIn72h, windowMs }}
 */
export function classifyDropVelocity(drops, currentPrice, baselinePrice) {
  if (!drops.length || !currentPrice || !baselinePrice || currentPrice >= baselinePrice) {
    return { tier: "NONE", totalDropPct: 0, dropsIn24h: 0, dropsIn72h: 0 };
  }

  const now    = Date.now();
  const ms24h  = 24 * 3600 * 1000;
  const ms72h  = 72 * 3600 * 1000;

  const totalDropPct   = round2((baselinePrice - currentPrice) / baselinePrice);
  const dropsIn24h     = drops.filter(d => (now - d.ts) <= ms24h);
  const dropsIn72h     = drops.filter(d => (now - d.ts) <= ms72h);

  const dropPct24h = dropsIn24h.reduce((sum, d) => sum + (d.dropPct || 0), 0);
  const dropPct72h = dropsIn72h.reduce((sum, d) => sum + (d.dropPct || 0), 0);

  if (dropPct24h >= RAPID_DROP_PCT_24H || dropPct72h >= RAPID_DROP_PCT_72H) {
    return { tier: "RAPID", totalDropPct, dropsIn24h: dropsIn24h.length, dropsIn72h: dropsIn72h.length, dropPct24h: round2(dropPct24h) };
  }
  if (totalDropPct >= GRADUAL_DROP_PCT) {
    return { tier: "GRADUAL", totalDropPct, dropsIn24h: dropsIn24h.length, dropsIn72h: dropsIn72h.length, dropPct24h: round2(dropPct24h) };
  }
  return { tier: "NONE", totalDropPct, dropsIn24h: 0, dropsIn72h: 0 };
}

// ── Seller urgency inference ──────────────────────────────────────────────────

/**
 * Infer seller urgency from listing signals.
 *
 * @param {object} item — market listing with title, description, listedAt
 * @param {Array}  drops — recent drop events for this item
 * @returns {{ urgent: boolean, signals: string[], confidenceBoost: number }}
 */
export function inferSellerUrgency(item, drops = []) {
  const signals = [];
  const text = `${item?.title || ""} ${item?.description || ""}`.toLowerCase();

  // Title/description urgency patterns
  let patternMatches = 0;
  for (const pat of URGENCY_PATTERNS) {
    if (pat.test(text)) {
      patternMatches++;
      signals.push(`Listing contains urgency language`);
      break; // count once
    }
  }

  // Multiple rapid price cuts
  if (drops.length >= 3) {
    signals.push(`${drops.length} price cuts recorded`);
  } else if (drops.length >= 2) {
    signals.push("Multiple price reductions");
  }

  // Large single price cut
  const bigDrop = drops.find(d => (d.dropPct || 0) >= 0.15);
  if (bigDrop) {
    signals.push(`Single cut of ${Math.round(bigDrop.dropPct * 100)}% — motivated seller`);
  }

  // Item has been listed a while with recent cut
  const listedAt = Number(item?.listedAt || item?.listingDate);
  if (listedAt && drops.length >= 1) {
    const daysListed = (Date.now() - listedAt) / 86400000;
    if (daysListed > 14 && drops.length >= 1) {
      signals.push(`Listed ${Math.round(daysListed)} days with recent price cut — seller motivated`);
    }
  }

  const urgent = signals.length >= 1;
  const confidenceBoost = Math.min(0.15, signals.length * 0.05);

  return { urgent, signals: signals.slice(0, 3), confidenceBoost };
}

// ── Cooldown management ───────────────────────────────────────────────────────

async function isOnCooldown(redis, userId, fingerprint) {
  if (!redis || !userId) return false;
  const raw = await redis.get(KEY_COOLDOWN(userId, fingerprint)).catch(() => null);
  return !!raw;
}

async function setCooldown(redis, userId, fingerprint) {
  if (!redis || !userId) return;
  await redis.set(KEY_COOLDOWN(userId, fingerprint), "1", "PX", COOLDOWN_MS).catch(() => {});
}

// ── Actionability gate ────────────────────────────────────────────────────────

/**
 * Check whether a velocity event meets the actionability bar:
 *   - Current price must be below market median (still a real deal)
 *   - Velocity tier must be RAPID (GRADUAL doesn't warrant an alert)
 *   - Buy signal must be STRONG BUY or GOOD DEAL
 */
export function isVelocityActionable(velocityData, currentPrice, marketMedian, buySignal) {
  if (!velocityData || velocityData.tier !== "RAPID") return false;
  if (!["STRONG BUY", "GOOD DEAL"].includes(buySignal)) return false;
  if (currentPrice == null || marketMedian == null) return false;
  if (Number(currentPrice) >= Number(marketMedian) * 0.98) return false; // not below market
  return true;
}

// ── Alert builder ─────────────────────────────────────────────────────────────

/**
 * Build a velocity alert object for use in feeds and watchlist alerts.
 *
 * @param {object} item         — market listing
 * @param {object} velocityData — from classifyDropVelocity
 * @param {object} urgencyData  — from inferSellerUrgency
 * @param {number} currentPrice
 * @param {number} marketMedian
 * @param {string} buySignal
 * @returns {object} velocity alert
 */
export function buildVelocityAlert(item, velocityData, urgencyData, currentPrice, marketMedian, buySignal) {
  const dropPctStr  = velocityData.dropPct24h != null
    ? `${Math.round(velocityData.dropPct24h * 100)}% in 24h`
    : `${Math.round(velocityData.totalDropPct * 100)}% total`;
  const savingsVsMedian = marketMedian && currentPrice
    ? round2(marketMedian - currentPrice)
    : null;

  const urgencyStr = urgencyData.urgent
    ? urgencyData.signals[0] || "Seller urgency detected"
    : null;

  const parts = [`Rapid drop: ${dropPctStr}`];
  if (urgencyStr) parts.push(urgencyStr);
  if (savingsVsMedian) parts.push(`$${savingsVsMedian.toFixed(0)} below market`);

  return {
    alertType:           "velocity_drop",
    priority:            buySignal === "STRONG BUY" ? "HIGH" : "MEDIUM",
    title:               String(item?.title || "").slice(0, 80) || "Rapid price drop detected",
    currentPrice,
    marketMedian,
    savingsVsMedian,
    velocityTier:        velocityData.tier,
    totalDropPct:        round2(velocityData.totalDropPct * 100),
    dropPct24h:          velocityData.dropPct24h != null ? round2(velocityData.dropPct24h * 100) : null,
    dropsIn24h:          velocityData.dropsIn24h,
    sellerUrgent:        urgencyData.urgent,
    urgencySignals:      urgencyData.signals,
    confidenceBoost:     urgencyData.confidenceBoost,
    buySignal,
    reason:              parts.join(" · "),
    url:                 item?.url || item?.link || null,
    source:              String(item?.source || item?.marketplace || "").toLowerCase(),
    detectedAt:          Date.now(),
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Analyze a set of market items for velocity signals.
 * Rate-limited per user per fingerprint.
 *
 * @param {object} params
 *   redis, userId, fingerprint, items, priceHistory, buySignal, marketMedian
 * @returns {object|null} velocity alert or null
 */
export async function analyzeVelocityForItem(redis, userId, {
  fingerprint   = null,
  items         = [],
  priceHistory  = [],   // from watchlistIntelligence.getWatchlistPriceHistory
  buySignal     = null,
  marketMedian  = null,
}) {
  if (!redis || !fingerprint || !buySignal) return null;

  try {
    // Find the cheapest current listing
    const prices = items
      .map(it => Number(it?.price ?? it?.totalPrice ?? it?.currentPrice) || 0)
      .filter(p => p > 0)
      .sort((a, b) => a - b);
    const currentPrice = prices[0] ?? null;
    if (!currentPrice) return null;

    // Load drop events
    const drops = await loadDropEvents(redis, fingerprint);

    // Derive baseline price (oldest in price history or drops)
    const historyPrices = priceHistory.map(h => h.price).filter(p => p > 0);
    const baselinePrice = historyPrices.length > 0
      ? Math.max(...historyPrices)  // highest historical = baseline
      : (drops.length > 0 ? drops.reduce((max, d) => Math.max(max, d.prevPrice || 0), 0) : null);

    if (!baselinePrice) return null;

    const velocityData = classifyDropVelocity(drops, currentPrice, baselinePrice);

    // Check actionability before calling inferSellerUrgency (avoid unnecessary work)
    if (!isVelocityActionable(velocityData, currentPrice, marketMedian, buySignal)) return null;

    // Check cooldown
    const onCooldown = await isOnCooldown(redis, userId, fingerprint);
    if (onCooldown) return null;

    // Find the cheapest listing item for urgency analysis
    const cheapestItem = items.reduce((best, it) => {
      const p = Number(it?.price ?? it?.totalPrice ?? 0);
      const bp = Number(best?.price ?? best?.totalPrice ?? Infinity);
      return p > 0 && p < bp ? it : best;
    }, {});

    const urgencyData = inferSellerUrgency(cheapestItem, drops);
    const alert = buildVelocityAlert(cheapestItem, velocityData, urgencyData, currentPrice, marketMedian, buySignal);

    // Set cooldown
    await setCooldown(redis, userId, fingerprint);

    return alert;
  } catch { return null; }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(Number(v) * 100) / 100; }
