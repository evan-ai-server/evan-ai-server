// src/externalUsageTracker.js
// Phase 8 — External Usage Tracker + Network Effect Signals.
//
// Tracks every moment Evan appears in the real world:
//   - Verification links shared and clicked
//   - Listing exports generated and copies
//   - Trustmark snippets copied
//   - Profile views and QR scans
//   - Partner API calls
//   - Verification lookups from external sources
//
// Network effect signals derived from this data:
//   - Most shared items (by referenceId)
//   - Most verified categories
//   - Most trusted sellers (by profile view count)
//   - Highest trustmark engagement (link → click conversion)
//   - Category-level adoption trends
//
// These signals will later:
//   - Influence certification scoring
//   - Surface to ops as platform health metrics
//   - Drive ranking in future search/discover features
//
// Redis key layout:
//   ext:event:{eventId}                STRING  individual event record (90d TTL)
//   ext:ref:{referenceId}:clicks       STRING  click counter
//   ext:ref:{referenceId}:shares       STRING  share counter
//   ext:ref:{referenceId}:conversions  STRING  verification page views
//   ext:user:{userId}:events           ZSET    eventIds by timestamp (90d)
//   ext:category:{category}:score      STRING  adoption score
//   ext:top:items                      ZSET    most engaged referenceIds by score
//   ext:top:users                      ZSET    most active reseller userIds by score
//   ext:top:categories                 ZSET    most adopted categories by score
//   ext:ops                            HASH    aggregate ops counters

import crypto from "crypto";

export const TRACKER_VERSION = "8.0";

export const USAGE_EVENT_TYPE = {
  LINK_CREATED:         "LINK_CREATED",
  LINK_SHARED:          "LINK_SHARED",
  LINK_CLICKED:         "LINK_CLICKED",
  VERIFICATION_VIEWED:  "VERIFICATION_VIEWED",
  LISTING_EXPORTED:     "LISTING_EXPORTED",
  LISTING_COPIED:       "LISTING_COPIED",
  TRUSTMARK_COPIED:     "TRUSTMARK_COPIED",
  PROFILE_VIEWED:       "PROFILE_VIEWED",
  QR_SCANNED:           "QR_SCANNED",
  PARTNER_API_CALLED:   "PARTNER_API_CALLED",
  FEEDBACK_SUBMITTED:   "FEEDBACK_SUBMITTED",
};

const EVENT_TTL  = 90 * 86400;
const TOP_WINDOW = 30 * 86400;    // 30-day rolling window for top-N lists

const KEY_EVENT     = id          => `ext:event:${id}`;
const KEY_REF       = (id, m)     => `ext:ref:${id}:${m}`;
const KEY_USER      = userId      => `ext:user:${_safe(userId)}:events`;
const KEY_CAT       = cat         => `ext:category:${_safe(cat)}:score`;
const KEY_TOP_ITEMS = ()          => `ext:top:items`;
const KEY_TOP_USERS = ()          => `ext:top:users`;
const KEY_TOP_CATS  = ()          => `ext:top:categories`;
const KEY_OPS       = ()          => `ext:ops`;

// ── Record usage event ────────────────────────────────────────────────────────

/**
 * Record an external usage event.
 * This is the primary ingest point for all external usage tracking.
 *
 * @param {object} redis
 * @param {object} opts
 *   eventType     {string}    — USAGE_EVENT_TYPE.*
 *   referenceId   {string|null}
 *   userId        {string|null}
 *   category      {string|null}
 *   platform      {string|null}  — where the event originated
 *   metadata      {object}
 * @returns {Promise<{ ok, eventId? }>}
 */
export async function recordUsageEvent(redis, {
  eventType,
  referenceId = null,
  userId      = null,
  category    = null,
  platform    = null,
  metadata    = {},
} = {}) {
  if (!redis || !eventType) return { ok: false, error: "missing_required" };
  try {
    const now     = Date.now();
    const eventId = `uev_${crypto.randomBytes(6).toString("hex")}`;

    const event = {
      eventId, eventType, referenceId, userId, category,
      platform, metadata: _safeMetadata(metadata),
      recordedAt: now, trackerVersion: TRACKER_VERSION,
    };

    // Store event record
    await redis.set(KEY_EVENT(eventId), JSON.stringify(event), { EX: EVENT_TTL });

    // Per-reference counters
    if (referenceId) {
      const metricKey = _eventToRefMetric(eventType);
      if (metricKey) await redis.incrBy(KEY_REF(referenceId, metricKey), 1);
      // Update top items leaderboard (incremental score)
      const score = _eventToScore(eventType);
      if (score > 0) await redis.zIncrBy(KEY_TOP_ITEMS(), score, referenceId);
    }

    // Per-user timeline
    if (userId) {
      await redis.zAdd(KEY_USER(userId), [{ score: now, value: eventId }]);
      await redis.expire(KEY_USER(userId), EVENT_TTL);
      // Update top users leaderboard
      const score = _eventToScore(eventType);
      if (score > 0) await redis.zIncrBy(KEY_TOP_USERS(), score, _safe(userId));
    }

    // Per-category adoption score
    if (category) {
      await redis.incrByFloat(KEY_CAT(category), _eventToScore(eventType));
      await redis.zIncrBy(KEY_TOP_CATS(), _eventToScore(eventType), _safe(category));
    }

    // Global ops
    await redis.hIncrBy(KEY_OPS(), "total_events", 1);
    await redis.hIncrBy(KEY_OPS(), `type.${eventType}`, 1);
    if (platform) await redis.hIncrBy(KEY_OPS(), `platform.${platform}`, 1);

    return { ok: true, eventId };
  } catch (err) {
    return { ok: false, error: "record_failed", reason: err?.message };
  }
}

// ── Convenience recorders ─────────────────────────────────────────────────────

export async function trackVerificationViewed(redis, referenceId, { category, platform } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.VERIFICATION_VIEWED, referenceId, category, platform });
}
export async function trackLinkShared(redis, referenceId, { userId, platform } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.LINK_SHARED, referenceId, userId, platform });
}
export async function trackLinkClicked(redis, referenceId, { platform } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.LINK_CLICKED, referenceId, platform });
}
export async function trackListingExported(redis, { userId, category, platform } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.LISTING_EXPORTED, userId, category, platform });
}
export async function trackTrustmarkCopied(redis, referenceId, { userId } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.TRUSTMARK_COPIED, referenceId, userId });
}
export async function trackProfileViewed(redis, profileUserId, { platform } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.PROFILE_VIEWED, userId: profileUserId, platform });
}
export async function trackQRScanned(redis, profileUserId) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.QR_SCANNED, userId: profileUserId });
}
export async function trackPartnerApiCalled(redis, { partnerType, endpoint } = {}) {
  return recordUsageEvent(redis, { eventType: USAGE_EVENT_TYPE.PARTNER_API_CALLED, platform: partnerType, metadata: { endpoint } });
}

// ── Network effect signals ────────────────────────────────────────────────────

/**
 * Get the top-N most engaged items by external interaction score.
 * Score = weighted sum of: verification views, link clicks, trustmark copies, shares.
 */
export async function getTopEngagedItems(redis, limit = 10) {
  if (!redis) return [];
  try {
    const items = await redis.zRange(KEY_TOP_ITEMS(), 0, limit - 1, { REV: true, WITHSCORES: true });
    const out   = [];
    for (let i = 0; i < items.length; i += 2) {
      out.push({ referenceId: items[i], engagementScore: parseFloat(items[i + 1]) || 0 });
    }
    return out;
  } catch { return []; }
}

/**
 * Get the top-N most active resellers by external engagement.
 */
export async function getTopActiveResellers(redis, limit = 10) {
  if (!redis) return [];
  try {
    const items = await redis.zRange(KEY_TOP_USERS(), 0, limit - 1, { REV: true, WITHSCORES: true });
    const out   = [];
    for (let i = 0; i < items.length; i += 2) {
      out.push({ userId: items[i], engagementScore: parseFloat(items[i + 1]) || 0 });
    }
    return out;
  } catch { return []; }
}

/**
 * Get category-level adoption scores (which categories are getting the most external trust usage).
 */
export async function getCategoryAdoptionScores(redis, limit = 15) {
  if (!redis) return [];
  try {
    const items = await redis.zRange(KEY_TOP_CATS(), 0, limit - 1, { REV: true, WITHSCORES: true });
    const out   = [];
    for (let i = 0; i < items.length; i += 2) {
      out.push({ category: items[i], adoptionScore: parseFloat(items[i + 1]) || 0 });
    }
    return out;
  } catch { return []; }
}

/**
 * Get per-reference engagement stats.
 */
export async function getReferenceEngagement(redis, referenceId) {
  if (!redis || !referenceId) return null;
  try {
    const [clicks, shares, conversions] = await Promise.all([
      redis.get(KEY_REF(referenceId, "clicks")).then(v => Number(v) || 0),
      redis.get(KEY_REF(referenceId, "shares")).then(v => Number(v) || 0),
      redis.get(KEY_REF(referenceId, "conversions")).then(v => Number(v) || 0),
    ]);
    const convRate = clicks > 0 ? Math.round(conversions / clicks * 100) / 100 : 0;
    return { referenceId, clicks, shares, conversions, conversionRate: convRate };
  } catch { return null; }
}

/**
 * Get full external usage ops summary.
 */
export async function getUsageOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalEvents:          ops["total_events"]                    || 0,
      verificationViews:    ops[`type.${USAGE_EVENT_TYPE.VERIFICATION_VIEWED}`] || 0,
      linksShared:          ops[`type.${USAGE_EVENT_TYPE.LINK_SHARED}`]         || 0,
      linksClicked:         ops[`type.${USAGE_EVENT_TYPE.LINK_CLICKED}`]        || 0,
      listingsExported:     ops[`type.${USAGE_EVENT_TYPE.LISTING_EXPORTED}`]    || 0,
      trustmarksCopied:     ops[`type.${USAGE_EVENT_TYPE.TRUSTMARK_COPIED}`]    || 0,
      profilesViewed:       ops[`type.${USAGE_EVENT_TYPE.PROFILE_VIEWED}`]      || 0,
      qrScans:              ops[`type.${USAGE_EVENT_TYPE.QR_SCANNED}`]          || 0,
      partnerApiCalls:      ops[`type.${USAGE_EVENT_TYPE.PARTNER_API_CALLED}`]  || 0,
      byPlatform: Object.fromEntries(
        Object.entries(ops).filter(([k]) => k.startsWith("platform.")).map(([k,v]) => [k.replace("platform.",""),v])
      ),
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _eventToRefMetric(eventType) {
  const map = {
    [USAGE_EVENT_TYPE.LINK_CLICKED]:       "clicks",
    [USAGE_EVENT_TYPE.LINK_SHARED]:        "shares",
    [USAGE_EVENT_TYPE.VERIFICATION_VIEWED]:"conversions",
  };
  return map[eventType] || null;
}

function _eventToScore(eventType) {
  // Engagement score weights
  const weights = {
    [USAGE_EVENT_TYPE.LINK_CREATED]:        0,
    [USAGE_EVENT_TYPE.LINK_SHARED]:         3,
    [USAGE_EVENT_TYPE.LINK_CLICKED]:        2,
    [USAGE_EVENT_TYPE.VERIFICATION_VIEWED]: 5,    // highest value — actually opened proof
    [USAGE_EVENT_TYPE.LISTING_EXPORTED]:    4,
    [USAGE_EVENT_TYPE.LISTING_COPIED]:      4,
    [USAGE_EVENT_TYPE.TRUSTMARK_COPIED]:    3,
    [USAGE_EVENT_TYPE.PROFILE_VIEWED]:      2,
    [USAGE_EVENT_TYPE.QR_SCANNED]:          5,    // physical scan = high intent
    [USAGE_EVENT_TYPE.PARTNER_API_CALLED]:  1,
    [USAGE_EVENT_TYPE.FEEDBACK_SUBMITTED]:  0,
  };
  return weights[eventType] || 0;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function _safeMetadata(meta) {
  if (!meta || typeof meta !== "object") return {};
  // Strip any potentially sensitive fields
  const unsafe = ["password", "token", "secret", "key", "auth"];
  const clean  = { ...meta };
  for (const f of unsafe) delete clean[f];
  return clean;
}
