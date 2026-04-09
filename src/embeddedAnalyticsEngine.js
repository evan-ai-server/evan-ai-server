// src/embeddedAnalyticsEngine.js
// Phase 9 — Embedded Analytics Engine.
//
// Attribution tracking with downstream_trust_id for Phase 10 ROI proof.
//
// Tracks trust conversion events:
//   WIDGET_VIEWED        — widget was rendered/loaded in partner embed
//   BADGE_CLICKED        — user clicked the Evan badge/widget
//   VERIFY_PAGE_VIEWED   — user landed on /verify/:referenceId
//   LISTING_OPENED       — user opened a listing from a verified card
//   PURCHASE_ATTRIBUTED  — buyer completed purchase (downstream_trust_id conversion)
//   RESALE_COMPLETED     — seller completed a resale after Evan assist
//   TRUST_SHARED         — seller shared the verification link
//
// downstream_trust_id:
//   Set when a buyer completes a purchase after clicking an Evan badge.
//   This is the Phase 10 ROI anchor — proves Evan trust → sale conversion.
//   Format: "dt_{referenceId}_{timestamp}_{6-char hex}"
//
// Redis key layout:
//   p9:analytics:events:{partnerId}   ZSET  events by timestamp
//   p9:analytics:dtid:{dtid}          STRING downstream trust attribution record
//   p9:analytics:conversions          ZSET  all conversion events by value score
//   p9:analytics:ops                  HASH  aggregate counters

import crypto from "crypto";

export const ANALYTICS_VERSION = "9.0";

export const ANALYTICS_EVENT = {
  WIDGET_VIEWED:       "WIDGET_VIEWED",
  BADGE_CLICKED:       "BADGE_CLICKED",
  VERIFY_PAGE_VIEWED:  "VERIFY_PAGE_VIEWED",
  LISTING_OPENED:      "LISTING_OPENED",
  PURCHASE_ATTRIBUTED: "PURCHASE_ATTRIBUTED",
  RESALE_COMPLETED:    "RESALE_COMPLETED",
  TRUST_SHARED:        "TRUST_SHARED",
};

// Conversion events — ones that generate downstream_trust_id
const CONVERSION_EVENTS = new Set([
  ANALYTICS_EVENT.PURCHASE_ATTRIBUTED,
  ANALYTICS_EVENT.RESALE_COMPLETED,
]);

// ── Core tracking ─────────────────────────────────────────────────────────

/**
 * Track an analytics event.
 *
 * @param {object} redis
 * @param {object} opts
 *   eventType        {string}        — ANALYTICS_EVENT.*
 *   referenceId      {string}        — trust reference
 *   partnerId        {string}        — who triggered this event
 *   sessionId        {string|null}   — session correlation
 *   conversionValue  {number|null}   — USD sale value (for purchase events)
 *   itemCategory     {string|null}
 *   meta             {object}        — extra k/v for downstream analysis
 * @returns {TrackResult}
 */
export async function trackAnalyticsEvent(redis, {
  eventType,
  referenceId,
  partnerId,
  sessionId       = null,
  conversionValue = null,
  itemCategory    = null,
  meta            = {},
} = {}) {
  if (!redis || !eventType || !referenceId) {
    return { ok: false, error: "missing_params" };
  }

  const now         = Date.now();
  const attributionId = `attr_${_safe(referenceId).slice(0, 10)}_${now}`;
  const isConversion  = CONVERSION_EVENTS.has(eventType);

  // Generate downstream_trust_id for conversions
  let downstreamTrustId = null;
  if (isConversion) {
    downstreamTrustId = _generateDownstreamTrustId(referenceId, now);
  }

  const event = {
    attributionId,
    eventType,
    referenceId,
    partnerId:       partnerId || null,
    sessionId:       sessionId || null,
    conversionValue: conversionValue != null ? Number(conversionValue) : null,
    itemCategory:    itemCategory || null,
    downstream_trust_id: downstreamTrustId,
    timestamp:       now,
    meta:            meta || {},
  };

  try {
    // Store in partner event log
    if (partnerId) {
      await redis.zAdd(
        `p9:analytics:events:${_safe(partnerId)}`,
        [{ score: now, value: JSON.stringify(event) }]
      );
      await redis.zRemRangeByRank(`p9:analytics:events:${_safe(partnerId)}`, 0, -10001);
      await redis.expire(`p9:analytics:events:${_safe(partnerId)}`, 90 * 86400);
    }

    // Store downstream trust attribution record
    if (downstreamTrustId) {
      await redis.set(
        `p9:analytics:dtid:${downstreamTrustId}`,
        JSON.stringify(event),
        { EX: 365 * 86400 }  // 1-year retention for ROI proof
      );
      // Add to conversions leaderboard
      const cvScore = conversionValue ? conversionValue * 100 : now;
      await redis.zAdd("p9:analytics:conversions", [{ score: cvScore, value: downstreamTrustId }]);
    }

    // Ops counters
    await redis.hIncrBy("p9:analytics:ops", `evt_${eventType.toLowerCase()}`, 1);
    await redis.hIncrBy("p9:analytics:ops", "total_events", 1);
    if (isConversion) await redis.hIncrBy("p9:analytics:ops", "conversions", 1);
    if (conversionValue) {
      await redis.hIncrByFloat("p9:analytics:ops", "total_conversion_value", Number(conversionValue));
    }

  } catch (err) {
    return { ok: false, error: err?.message };
  }

  return {
    ok:                  true,
    attributionId,
    eventType,
    referenceId,
    downstream_trust_id: downstreamTrustId,
    isConversion,
    timestamp:           now,
    analyticsVersion:    ANALYTICS_VERSION,
  };
}

/**
 * Retrieve an attribution record by downstream_trust_id.
 * Used by Phase 10 P&L Engine to prove trust → sale conversion.
 */
export async function getDownstreamTrustRecord(redis, downstreamTrustId) {
  if (!redis || !downstreamTrustId) return null;
  try {
    const raw = await redis.get(`p9:analytics:dtid:${downstreamTrustId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * Get analytics event history for a partner.
 */
export async function getPartnerAnalyticsEvents(redis, partnerId, { limit = 50 } = {}) {
  if (!redis || !partnerId) return [];
  try {
    const raw = await redis.zRange(
      `p9:analytics:events:${_safe(partnerId)}`,
      0, limit - 1,
      { REV: true }
    );
    return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Get top conversions (sorted by conversion value).
 */
export async function getTopConversions(redis, { limit = 20 } = {}) {
  if (!redis) return [];
  try {
    const dtids = await redis.zRange("p9:analytics:conversions", 0, limit - 1, { REV: true });
    const records = await Promise.all(dtids.map(dtid => getDownstreamTrustRecord(redis, dtid)));
    return records.filter(Boolean);
  } catch { return []; }
}

/**
 * Get analytics ops summary.
 */
export async function getAnalyticsOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:analytics:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) {
      ops[k] = k === "total_conversion_value" ? parseFloat(v) || 0 : Number(v) || 0;
    }
    return {
      totalEvents:          ops["total_events"]           || 0,
      conversions:          ops["conversions"]            || 0,
      totalConversionValue: ops["total_conversion_value"] || 0,
      widgetViews:          ops["evt_widget_viewed"]      || 0,
      badgeClicks:          ops["evt_badge_clicked"]      || 0,
      purchaseAttributed:   ops["evt_purchase_attributed"] || 0,
    };
  } catch { return {}; }
}

// ── downstream_trust_id generation ────────────────────────────────────────

function _generateDownstreamTrustId(referenceId, timestamp) {
  const rand = crypto.randomBytes(3).toString("hex");
  const refPart = _safe(referenceId).slice(0, 12);
  return `dt_${refPart}_${timestamp}_${rand}`;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
