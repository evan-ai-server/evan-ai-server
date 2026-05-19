// src/partnerWebhookEngine.js
// Phase 9 — Partner Webhook Engine.
//
// Webhook registry, signing, delivery, retry, and replay protection.
//
// Webhook events:
//   trust.verified          — new trust reference created
//   trust.revoked           — reference revoked
//   trust.expired           — reference expired
//   cert.issued             — partner certification issued
//   cert.updated            — certification tier changed
//   feedback.flagged        — critical feedback on a reference
//   conversion.attributed   — downstream_trust_id conversion recorded
//   monitor.alert           — trustmark safety monitor alert
//
// Delivery:
//   - HTTP POST to partner's registered endpoint
//   - Signed: X-Evan-Signature: sha256={HMAC-SHA256(secret, payload)}
//   - Replay protection: X-Evan-Delivery-Id header (unique per event)
//   - Retry: up to MAX_RETRIES with exponential backoff delays
//   - Timeouts: 10s per attempt
//
// Redis key layout:
//   p9:wh:endpoints:{partnerId}    ZSET  registered webhook endpoints
//   p9:wh:delivery:{deliveryId}    HASH  delivery state + retries
//   p9:wh:replay:{deliveryId}      STRING replay guard (24h TTL)
//   p9:wh:queue                    LIST  pending deliveries
//   p9:wh:ops                      HASH  counters

import crypto from "crypto";

export const WEBHOOK_VERSION = "9.0";

export const WEBHOOK_EVENT = {
  TRUST_VERIFIED:       "trust.verified",
  TRUST_REVOKED:        "trust.revoked",
  TRUST_EXPIRED:        "trust.expired",
  CERT_ISSUED:          "cert.issued",
  CERT_UPDATED:         "cert.updated",
  FEEDBACK_FLAGGED:     "feedback.flagged",
  CONVERSION_ATTRIBUTED:"conversion.attributed",
  MONITOR_ALERT:        "monitor.alert",
};

const MAX_RETRIES     = 4;
const RETRY_DELAYS_MS = [0, 30_000, 300_000, 1_800_000]; // 0, 30s, 5m, 30m
const DELIVERY_TTL    = 7 * 86400;   // 7 days
const REPLAY_TTL      = 86400;       // 24 hours

// ── Endpoint registry ─────────────────────────────────────────────────────

/**
 * Register a webhook endpoint for a partner.
 */
export async function registerWebhook(redis, {
  partnerId,
  url,
  secret,
  events      = ["*"],
  description = "",
} = {}) {
  if (!redis || !partnerId || !url || !secret) {
    return { ok: false, error: "missing_params" };
  }
  if (!_isValidUrl(url)) return { ok: false, error: "invalid_url" };

  const webhookId  = `wh_${_safe(partnerId)}_${crypto.randomBytes(6).toString("hex")}`;
  const endpoint   = {
    webhookId,
    partnerId,
    url,
    secret:      _hashSecret(secret),   // store hashed — never store raw secrets
    events:      Array.isArray(events) ? events : ["*"],
    description: String(description || "").slice(0, 200),
    active:      true,
    createdAt:   Date.now(),
  };

  try {
    await redis.zAdd(
      `p9:wh:endpoints:${_safe(partnerId)}`,
      [{ score: Date.now(), value: JSON.stringify(endpoint) }]
    );
    await redis.expire(`p9:wh:endpoints:${_safe(partnerId)}`, 365 * 86400);
    await redis.hIncrBy("p9:wh:ops", "endpoints_registered", 1);
    return { ok: true, webhookId, partnerId, url, events };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

/**
 * Get all webhooks for a partner.
 */
export async function getPartnerWebhooks(redis, partnerId) {
  if (!redis || !partnerId) return [];
  try {
    const raw = await redis.zRange(`p9:wh:endpoints:${_safe(partnerId)}`, 0, -1);
    return raw
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(e => e && e.active);
  } catch { return []; }
}

/**
 * Deactivate a webhook.
 */
export async function deactivateWebhook(redis, partnerId, webhookId) {
  if (!redis || !partnerId || !webhookId) return { ok: false };
  try {
    const raw      = await redis.zRange(`p9:wh:endpoints:${_safe(partnerId)}`, 0, -1);
    const entries  = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    const target   = entries.find(e => e.webhookId === webhookId);
    if (!target) return { ok: false, error: "webhook_not_found" };

    // Remove old and re-add with active: false
    await redis.zRem(`p9:wh:endpoints:${_safe(partnerId)}`, JSON.stringify(target));
    const updated = { ...target, active: false, deactivatedAt: Date.now() };
    await redis.zAdd(`p9:wh:endpoints:${_safe(partnerId)}`, [{ score: target.createdAt, value: JSON.stringify(updated) }]);
    return { ok: true, webhookId };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────────

/**
 * Dispatch a webhook event to all matching partner endpoints.
 * Queues deliveries into Redis for background delivery.
 *
 * @param {object} redis
 * @param {object} opts
 *   partnerId  {string}    — target partner
 *   eventType  {string}    — WEBHOOK_EVENT.*
 *   payload    {object}    — event data
 * @returns {DispatchResult}
 */
export async function dispatchWebhookEvent(redis, { partnerId, eventType, payload = {} } = {}) {
  if (!redis || !partnerId || !eventType) return { ok: false, error: "missing_params" };

  const endpoints = await getPartnerWebhooks(redis, partnerId);
  const matched   = endpoints.filter(ep =>
    ep.active && (ep.events.includes("*") || ep.events.includes(eventType))
  );

  if (!matched.length) return { ok: true, dispatched: 0, noEndpoints: true };

  const deliveries = [];
  for (const ep of matched) {
    const deliveryId = `dlv_${ep.webhookId}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const delivery   = {
      deliveryId,
      webhookId:   ep.webhookId,
      partnerId,
      url:         ep.url,
      eventType,
      payload,
      secretHash:  ep.secret,
      attempt:     0,
      status:      "QUEUED",
      queuedAt:    Date.now(),
      nextRetryAt: Date.now(),
    };

    await redis.hSet(`p9:wh:delivery:${deliveryId}`, _flattenForHash(delivery));
    await redis.expire(`p9:wh:delivery:${deliveryId}`, DELIVERY_TTL);
    await redis.lPush("p9:wh:queue", deliveryId);
    deliveries.push(deliveryId);
  }

  await redis.hIncrBy("p9:wh:ops", "events_dispatched", deliveries.length);
  return { ok: true, dispatched: deliveries.length, deliveryIds: deliveries };
}

// ── Delivery ──────────────────────────────────────────────────────────────

/**
 * Deliver a queued webhook (call from background job / cron).
 */
export async function deliverWebhook(redis, deliveryId) {
  if (!redis || !deliveryId) return { ok: false };

  // Load delivery state
  const raw = await redis.hGetAll(`p9:wh:delivery:${deliveryId}`);
  if (!raw || !raw.url) return { ok: false, error: "delivery_not_found" };

  const attempt     = Number(raw.attempt) || 0;
  const url         = raw.url;
  const eventType   = raw.eventType;
  const secretHash  = raw.secretHash;
  let   payload;
  try { payload = JSON.parse(raw.payload || "{}"); } catch { payload = {}; }

  if (attempt >= MAX_RETRIES) {
    await redis.hSet(`p9:wh:delivery:${deliveryId}`, "status", "EXHAUSTED");
    await redis.hIncrBy("p9:wh:ops", "deliveries_exhausted", 1);
    return { ok: false, error: "max_retries_exhausted", deliveryId };
  }

  // Replay guard
  const replayKey = `p9:wh:replay:${deliveryId}:${attempt}`;
  const alreadySent = await redis.get(replayKey);
  if (alreadySent) {
    return { ok: false, error: "replay_blocked", deliveryId };
  }

  // Build signed body
  const deliveryBody = JSON.stringify({
    webhookId:   raw.webhookId,
    deliveryId,
    eventType,
    payload,
    deliveredAt: Date.now(),
  });
  const signature = _signPayload(deliveryBody, secretHash);

  try {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":         "application/json",
        "X-Evan-Signature":     `sha256=${signature}`,
        "X-Evan-Delivery-Id":   deliveryId,
        "X-Evan-Event":         eventType,
        "User-Agent":           "Evan-Webhooks/9.0",
      },
      body:   deliveryBody,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const success = response.status >= 200 && response.status < 300;

    // Set replay guard
    await redis.set(replayKey, "1", "EX", REPLAY_TTL);

    await redis.hSet(`p9:wh:delivery:${deliveryId}`, {
      status:     success ? "DELIVERED" : "FAILED",
      attempt:    attempt + 1,
      lastStatus: response.status,
      lastAt:     Date.now(),
      ...(success ? {} : {
        nextRetryAt: Date.now() + (RETRY_DELAYS_MS[attempt + 1] || RETRY_DELAYS_MS.at(-1)),
      }),
    });

    await redis.hIncrBy("p9:wh:ops", success ? "deliveries_ok" : "deliveries_failed", 1);

    return { ok: success, deliveryId, statusCode: response.status, attempt: attempt + 1 };

  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    await redis.hSet(`p9:wh:delivery:${deliveryId}`, {
      status:     "FAILED",
      attempt:    attempt + 1,
      lastError:  isTimeout ? "timeout" : (err?.message || "error"),
      nextRetryAt: Date.now() + (RETRY_DELAYS_MS[attempt + 1] || RETRY_DELAYS_MS.at(-1)),
    });
    await redis.hIncrBy("p9:wh:ops", "deliveries_failed", 1);
    return { ok: false, error: isTimeout ? "timeout" : err?.message, deliveryId };
  }
}

/**
 * Process the delivery queue (pop and deliver up to N items).
 * Call from a cron job or background worker.
 */
export async function processDeliveryQueue(redis, { maxItems = 20 } = {}) {
  if (!redis) return { processed: 0 };
  const results = [];
  for (let i = 0; i < maxItems; i++) {
    const deliveryId = await redis.rPop("p9:wh:queue").catch(() => null);
    if (!deliveryId) break;

    // Check nextRetryAt
    const nextRetry = await redis.hGet(`p9:wh:delivery:${deliveryId}`, "nextRetryAt").catch(() => null);
    if (nextRetry && Number(nextRetry) > Date.now()) {
      // Not yet ready — re-queue at front
      await redis.lPush("p9:wh:queue", deliveryId).catch(() => {});
      continue;
    }

    const result = await deliverWebhook(redis, deliveryId);
    results.push(result);

    // Re-queue for retry if failed and not exhausted
    if (!result.ok && result.error !== "max_retries_exhausted") {
      const status = await redis.hGet(`p9:wh:delivery:${deliveryId}`, "status").catch(() => null);
      if (status === "FAILED") {
        await redis.lPush("p9:wh:queue", deliveryId).catch(() => {});
      }
    }
  }
  return { processed: results.length, results };
}

/**
 * Get webhook ops summary.
 */
export async function getWebhookOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:wh:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      endpointsRegistered: ops["endpoints_registered"] || 0,
      eventsDispatched:    ops["events_dispatched"]    || 0,
      deliveriesOk:        ops["deliveries_ok"]        || 0,
      deliveriesFailed:    ops["deliveries_failed"]    || 0,
      deliveriesExhausted: ops["deliveries_exhausted"] || 0,
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _signPayload(body, secretHash) {
  // secretHash is a sha256 hex of the raw secret stored at registration
  // Re-derive signing key from hash for determinism
  return crypto.createHmac("sha256", secretHash).update(body).digest("hex");
}

function _hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function _isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch { return false; }
}

function _flattenForHash(obj) {
  const flat = {};
  for (const [k, v] of Object.entries(obj)) {
    flat[k] = typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
  }
  return flat;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
