// src/priceAlertWebhooks.js
// Feature 74 — Real-Time Price Alert Webhooks
// When a watchlist item's current price drops to or below the target price,
// fire an instant webhook POST to a registered URL.
// Redis-backed alert registry with dedup (don't fire same alert twice in 24h).
// "Not a daily digest — instant."

import https from "https";
import http from "http";

const ALERT_KEY_PREFIX     = "palert:";
const DEDUP_KEY_PREFIX     = "palert_dedup:";
const ALERT_REGISTRY_KEY   = "palert_registry";
const DEDUP_TTL_SEC        = 24 * 60 * 60;   // 24h dedup window
const WEBHOOK_TIMEOUT_MS   = 8000;
const MAX_RETRY_ATTEMPTS   = 2;

// ── Webhook registry (per user) ───────────────────────────────────────────────

/**
 * Register a webhook URL for a user.
 * Events: "price_alert" | "floor_breach" | "all"
 */
export async function registerWebhook(userId, webhookUrl, { events = ["price_alert"], redis } = {}) {
  if (!redis || !userId || !webhookUrl) return { ok: false, reason: "missing_params" };
  if (!isValidUrl(webhookUrl)) return { ok: false, reason: "invalid_url" };

  const key = `${ALERT_KEY_PREFIX}${userId}`;
  const entry = JSON.stringify({ url: webhookUrl, events, registeredAt: Date.now() });
  await redis.hset(ALERT_REGISTRY_KEY, key, entry).catch(() => null);

  return { ok: true, userId, webhookUrl, events };
}

/**
 * Remove a webhook for a user.
 */
export async function unregisterWebhook(userId, redis) {
  if (!redis || !userId) return;
  const key = `${ALERT_KEY_PREFIX}${userId}`;
  await redis.hdel(ALERT_REGISTRY_KEY, key).catch(() => null);
}

/**
 * Get webhook config for a user.
 */
export async function getWebhookConfig(userId, redis) {
  if (!redis || !userId) return null;
  const key = `${ALERT_KEY_PREFIX}${userId}`;
  const raw = await redis.hget(ALERT_REGISTRY_KEY, key).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Alert firing ──────────────────────────────────────────────────────────────

/**
 * Check if an alert should fire for a watchlist item vs current price.
 * Returns { shouldFire, reason }
 */
export function shouldFireAlert(watchlistItem, currentPrice) {
  const target = Number(watchlistItem?.targetPrice);
  const current = Number(currentPrice);
  if (!Number.isFinite(target) || !Number.isFinite(current) || target <= 0) {
    return { shouldFire: false, reason: "no_target_price" };
  }
  if (current <= target) {
    return {
      shouldFire: true,
      reason: "price_at_or_below_target",
      targetPrice: target,
      currentPrice: current,
      savingPct: round2(((target - current) / target) * 100),
    };
  }
  return { shouldFire: false, reason: "price_above_target" };
}

/**
 * Fire a price alert webhook for a user when their watchlist item hits target.
 */
export async function firePriceAlert({ userId, watchlistItem, currentPrice, marketData = null, redis } = {}) {
  if (!redis || !userId || !watchlistItem) return { fired: false, reason: "missing_params" };

  const alertCheck = shouldFireAlert(watchlistItem, currentPrice);
  if (!alertCheck.shouldFire) return { fired: false, reason: alertCheck.reason };

  // Dedup: don't fire same item alert twice in 24h
  const dedupKey = `${DEDUP_KEY_PREFIX}${userId}:${watchlistItem.id || watchlistItem.query}`;
  const alreadyFired = await redis.get(dedupKey).catch(() => null);
  if (alreadyFired) return { fired: false, reason: "dedup_24h" };

  // Get webhook config
  const config = await getWebhookConfig(userId, redis);
  if (!config?.url) return { fired: false, reason: "no_webhook_registered" };

  const payload = buildAlertPayload(watchlistItem, currentPrice, alertCheck, marketData);

  const result = await sendWebhook(config.url, payload);

  if (result.ok) {
    // Set dedup key
    await redis.setex(dedupKey, DEDUP_TTL_SEC, "1").catch(() => null);
  }

  return { fired: result.ok, webhookUrl: config.url, payload, httpStatus: result.status, error: result.error || null };
}

/**
 * Batch check all watchlist items for a user and fire alerts as needed.
 */
export async function checkAndFireWatchlistAlerts({ userId, watchlistItems, priceMap, redis } = {}) {
  if (!Array.isArray(watchlistItems) || !watchlistItems.length) return [];

  const results = [];
  for (const item of watchlistItems) {
    const currentPrice = priceMap?.[item.id] ?? priceMap?.[item.query];
    if (!currentPrice) continue;
    const result = await firePriceAlert({ userId, watchlistItem: item, currentPrice, redis });
    results.push({ itemId: item.id, query: item.query, ...result });
  }
  return results;
}

// ── Webhook HTTP dispatch ─────────────────────────────────────────────────────

async function sendWebhook(url, payload, attempt = 1) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const lib = isHttps ? https : http;
      const options = {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent":     "EvanAI-PriceAlert/1.0",
          "X-Alert-Source": "evan-ai-price-monitor",
        },
      };

      const timer = setTimeout(() => {
        req.destroy();
        if (attempt < MAX_RETRY_ATTEMPTS) {
          sendWebhook(url, payload, attempt + 1).then(resolve);
        } else {
          resolve({ ok: false, status: null, error: "timeout" });
        }
      }, WEBHOOK_TIMEOUT_MS);

      const req = lib.request(options, (res) => {
        clearTimeout(timer);
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ ok, status: res.statusCode, body: data.slice(0, 200) });
        });
      });

      req.on("error", (err) => {
        clearTimeout(timer);
        if (attempt < MAX_RETRY_ATTEMPTS) {
          sendWebhook(url, payload, attempt + 1).then(resolve);
        } else {
          resolve({ ok: false, status: null, error: err.message });
        }
      });

      req.write(body);
      req.end();
    } catch (err) {
      resolve({ ok: false, status: null, error: err.message });
    }
  });
}

// ── Payload builder ───────────────────────────────────────────────────────────

function buildAlertPayload(watchlistItem, currentPrice, alertCheck, marketData) {
  return {
    event:       "price_alert",
    timestamp:   new Date().toISOString(),
    item: {
      id:          watchlistItem.id,
      query:       watchlistItem.query,
      title:       watchlistItem.title,
      targetPrice: alertCheck.targetPrice,
      currentPrice: alertCheck.currentPrice,
      savingPct:   alertCheck.savingPct,
    },
    market: marketData ? {
      median:     marketData.median ?? null,
      typicalLow: marketData.typicalLow ?? null,
      listingCount: marketData.listingCount ?? null,
    } : null,
    message: `Price alert: "${watchlistItem.title || watchlistItem.query}" is now $${alertCheck.currentPrice} — at or below your target of $${alertCheck.targetPrice} (${alertCheck.savingPct}% savings).`,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// ── Master payload builder ─────────────────────────────────────────────────────

export async function buildPriceAlertPayload({ userId, watchlistItem, currentPrice, marketData = null, redis } = {}) {
  if (!userId || !watchlistItem || !currentPrice) {
    return { alertFired: false, alertResult: null, topSignal: null };
  }
  const result = await firePriceAlert({ userId, watchlistItem, currentPrice, marketData, redis });
  const topSignal = result.fired
    ? `Price alert fired: $${currentPrice} ≤ target $${watchlistItem.targetPrice}`
    : null;
  return { alertFired: result.fired, alertResult: result, topSignal };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
