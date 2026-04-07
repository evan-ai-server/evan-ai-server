// src/trustTimelineEngine.js
// Phase 7 — Trust History & Timeline Engine.
//
// Every trust state change leaves a timestamped, auditable event on a timeline.
// This creates the historical backbone of external trust — trust is not just
// a current state, it's a provable track record.
//
// Trust timeline becomes:
//   - The historical record for reseller credibility
//   - The audit trail for dispute defense
//   - The substrate for trust trend analysis
//   - The source for partner-visible trust history
//
// Event types (what creates a timeline event):
//   VERIFIED_ISSUED        — new Evan-Verified credential issued
//   VERIFIED_RENEWED       — re-scanned; verification renewed
//   VERIFIED_EXPIRED       — verification passed expiry, not renewed
//   VERIFIED_REVOKED       — verification revoked (new evidence)
//   CERTIFIED_GRANTED      — Evan-Certified status granted
//   CERTIFIED_RENEWED      — certification renewed
//   CERTIFIED_PROBATION    — certification put on probation
//   CERTIFIED_REVOKED      — certification revoked
//   GUARANTEE_ATTACHED     — guarantee policy issued for item
//   GUARANTEE_EXPIRED      — guarantee policy expired
//   GUARANTEE_CLAIMED      — claim approved against guarantee
//   GUARANTEE_REVOKED      — guarantee revoked (counterfeit confirmed)
//   TRUSTMARK_ISSUED       — trustmark issued
//   TRUSTMARK_REVOKED      — trustmark revoked
//   TRUSTMARK_EXPIRED      — trustmark expired
//   TRUST_DOWNGRADED       — trust state downgraded (new evidence)
//   TRUST_RESTORED         — trust state restored (dispute resolved)
//   DISPUTE_OPENED         — claim/dispute opened
//   DISPUTE_RESOLVED       — claim/dispute resolved (approved/denied)
//   REFERENCE_CREATED      — external reference created
//   REFERENCE_REVOKED      — external reference revoked
//
// Redis key layout:
//   tl:event:{eventId}                 STRING  event record (2yr TTL)
//   tl:entity:{entityType}:{entityId}  ZSET    eventIds scored by timestamp (2yr TTL)
//   tl:ops                             HASH    ops counters
//
// Visibility levels:
//   PUBLIC    — shown on public verification pages
//   PARTNER   — shown in partner API responses
//   INTERNAL  — internal ops only

import crypto from "crypto";

export const TIMELINE_VERSION = "7.0";

export const TIMELINE_EVENT_TYPE = {
  VERIFIED_ISSUED:      "VERIFIED_ISSUED",
  VERIFIED_RENEWED:     "VERIFIED_RENEWED",
  VERIFIED_EXPIRED:     "VERIFIED_EXPIRED",
  VERIFIED_REVOKED:     "VERIFIED_REVOKED",
  CERTIFIED_GRANTED:    "CERTIFIED_GRANTED",
  CERTIFIED_RENEWED:    "CERTIFIED_RENEWED",
  CERTIFIED_PROBATION:  "CERTIFIED_PROBATION",
  CERTIFIED_REVOKED:    "CERTIFIED_REVOKED",
  GUARANTEE_ATTACHED:   "GUARANTEE_ATTACHED",
  GUARANTEE_EXPIRED:    "GUARANTEE_EXPIRED",
  GUARANTEE_CLAIMED:    "GUARANTEE_CLAIMED",
  GUARANTEE_REVOKED:    "GUARANTEE_REVOKED",
  TRUSTMARK_ISSUED:     "TRUSTMARK_ISSUED",
  TRUSTMARK_REVOKED:    "TRUSTMARK_REVOKED",
  TRUSTMARK_EXPIRED:    "TRUSTMARK_EXPIRED",
  TRUST_DOWNGRADED:     "TRUST_DOWNGRADED",
  TRUST_RESTORED:       "TRUST_RESTORED",
  DISPUTE_OPENED:       "DISPUTE_OPENED",
  DISPUTE_RESOLVED:     "DISPUTE_RESOLVED",
  REFERENCE_CREATED:    "REFERENCE_CREATED",
  REFERENCE_REVOKED:    "REFERENCE_REVOKED",
};

export const TIMELINE_ENTITY_TYPE = {
  ITEM:     "ITEM",
  RESELLER: "RESELLER",
  SCAN:     "SCAN",
};

export const TIMELINE_VISIBILITY = {
  PUBLIC:   "PUBLIC",
  PARTNER:  "PARTNER",
  INTERNAL: "INTERNAL",
};

// Default visibility per event type
const DEFAULT_VISIBILITY = {
  VERIFIED_ISSUED:      TIMELINE_VISIBILITY.PUBLIC,
  VERIFIED_RENEWED:     TIMELINE_VISIBILITY.PUBLIC,
  VERIFIED_EXPIRED:     TIMELINE_VISIBILITY.PARTNER,
  VERIFIED_REVOKED:     TIMELINE_VISIBILITY.PUBLIC,
  CERTIFIED_GRANTED:    TIMELINE_VISIBILITY.PUBLIC,
  CERTIFIED_RENEWED:    TIMELINE_VISIBILITY.PUBLIC,
  CERTIFIED_PROBATION:  TIMELINE_VISIBILITY.PARTNER,
  CERTIFIED_REVOKED:    TIMELINE_VISIBILITY.PUBLIC,
  GUARANTEE_ATTACHED:   TIMELINE_VISIBILITY.PARTNER,
  GUARANTEE_EXPIRED:    TIMELINE_VISIBILITY.PARTNER,
  GUARANTEE_CLAIMED:    TIMELINE_VISIBILITY.PARTNER,
  GUARANTEE_REVOKED:    TIMELINE_VISIBILITY.PARTNER,
  TRUSTMARK_ISSUED:     TIMELINE_VISIBILITY.PUBLIC,
  TRUSTMARK_REVOKED:    TIMELINE_VISIBILITY.PUBLIC,
  TRUSTMARK_EXPIRED:    TIMELINE_VISIBILITY.PARTNER,
  TRUST_DOWNGRADED:     TIMELINE_VISIBILITY.PARTNER,
  TRUST_RESTORED:       TIMELINE_VISIBILITY.PARTNER,
  DISPUTE_OPENED:       TIMELINE_VISIBILITY.INTERNAL,
  DISPUTE_RESOLVED:     TIMELINE_VISIBILITY.PARTNER,
  REFERENCE_CREATED:    TIMELINE_VISIBILITY.PARTNER,
  REFERENCE_REVOKED:    TIMELINE_VISIBILITY.PARTNER,
};

const EVENT_TTL  = 2 * 365 * 86400;  // 2 years
const ENTITY_TTL = 2 * 365 * 86400;  // 2 years
const MAX_EVENTS_PER_ENTITY = 500;

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_EVENT  = id               => `tl:event:${id}`;
const KEY_ENTITY = (type, entityId) => `tl:entity:${type}:${_safeKey(entityId)}`;
const KEY_OPS    = ()               => `tl:ops`;

// ── Record timeline event ─────────────────────────────────────────────────────

/**
 * Record a trust event on the timeline for an entity.
 *
 * @param {object} redis
 * @param {object} opts
 *   entityType    {string}    — TIMELINE_ENTITY_TYPE.*
 *   entityId      {string}    — userId for resellers, scanId for items
 *   eventType     {string}    — TIMELINE_EVENT_TYPE.*
 *   eventSummary  {string}    — human-readable summary (public-safe)
 *   changedBy     {string}    — "user"|"system"|"ops"|"expert"
 *   metadata      {object}    — event-specific extra data (internal)
 *   overrideVisibility {string|null} — override default visibility
 * @returns {Promise<{ ok, eventId?, event? }>}
 */
export async function recordTimelineEvent(redis, {
  entityType,
  entityId,
  eventType,
  eventSummary    = "",
  changedBy       = "system",
  metadata        = {},
  overrideVisibility = null,
} = {}) {
  if (!redis || !entityType || !entityId || !eventType) {
    return { ok: false, error: "missing_required" };
  }
  if (!TIMELINE_EVENT_TYPE[eventType]) {
    return { ok: false, error: "invalid_event_type" };
  }

  try {
    const now     = Date.now();
    const eventId = `tle_${crypto.randomBytes(8).toString("hex")}`;
    const visibility = overrideVisibility || DEFAULT_VISIBILITY[eventType] || TIMELINE_VISIBILITY.INTERNAL;

    const event = {
      eventId,
      entityType,
      entityId,
      eventType,
      eventSummary,
      changedBy,
      changedAt:   now,
      visibility,
      metadata,    // internal context only — never sent externally as-is
      timelineVersion: TIMELINE_VERSION,
    };

    const entityKey = KEY_ENTITY(entityType, entityId);

    // Store event record
    await redis.set(KEY_EVENT(eventId), JSON.stringify(event), { EX: EVENT_TTL });

    // Add to entity timeline sorted by timestamp
    await redis.zAdd(entityKey, [{ score: now, value: eventId }]);
    await redis.expire(entityKey, ENTITY_TTL);

    // Trim to max per entity (remove oldest)
    const count = await redis.zCard(entityKey);
    if (count > MAX_EVENTS_PER_ENTITY) {
      await redis.zRemRangeByRank(entityKey, 0, count - MAX_EVENTS_PER_ENTITY - 1);
    }

    await redis.hIncrBy(KEY_OPS(), "total_events", 1);
    await redis.hIncrBy(KEY_OPS(), `type.${eventType}`, 1);

    return { ok: true, eventId, event };
  } catch (err) {
    return { ok: false, error: "record_failed", reason: err?.message };
  }
}

// ── Read timeline ─────────────────────────────────────────────────────────────

/**
 * Get the timeline for an entity, filtered by visibility level.
 * Most recent events first.
 *
 * @param {object} redis
 * @param {string} entityType
 * @param {string} entityId
 * @param {object} opts
 *   minVisibility  {string}  — minimum visibility to include (PUBLIC < PARTNER < INTERNAL)
 *   limit          {number}
 * @returns {Promise<Array>}
 */
export async function getEntityTimeline(redis, entityType, entityId, {
  minVisibility = TIMELINE_VISIBILITY.PUBLIC,
  limit         = 50,
} = {}) {
  if (!redis || !entityType || !entityId) return [];
  try {
    const entityKey = KEY_ENTITY(entityType, entityId);
    // Get most recent N events (highest scores = most recent)
    const eventIds = await redis.zRange(entityKey, 0, limit - 1, { REV: true });
    if (!eventIds || eventIds.length === 0) return [];

    const raws = await Promise.all(eventIds.map(id => redis.get(KEY_EVENT(id)).catch(() => null)));
    const events = raws
      .filter(r => r)
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean)
      .filter(ev => _visibilityLevel(ev.visibility) >= _visibilityLevel(minVisibility));

    return events;
  } catch { return []; }
}

/**
 * Get a public-safe version of the timeline (strips internal metadata).
 * Suitable for /verify/reseller/:referenceId response.
 */
export async function getPublicTimeline(redis, entityType, entityId, limit = 20) {
  const events = await getEntityTimeline(redis, entityType, entityId, {
    minVisibility: TIMELINE_VISIBILITY.PUBLIC,
    limit,
  });
  return events.map(ev => ({
    eventType:    ev.eventType,
    eventSummary: ev.eventSummary,
    changedAt:    ev.changedAt,
    visibility:   ev.visibility,
  }));
}

/**
 * Get a partner-safe version of the timeline.
 */
export async function getPartnerTimeline(redis, entityType, entityId, limit = 50) {
  const events = await getEntityTimeline(redis, entityType, entityId, {
    minVisibility: TIMELINE_VISIBILITY.PARTNER,
    limit,
  });
  return events.map(ev => ({
    eventId:      ev.eventId,
    eventType:    ev.eventType,
    eventSummary: ev.eventSummary,
    changedBy:    ev.changedBy,
    changedAt:    ev.changedAt,
    visibility:   ev.visibility,
    // Never include metadata (may contain internal reasoning)
  }));
}

// ── Ops ───────────────────────────────────────────────────────────────────────

export async function getTimelineOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalEvents: ops["total_events"] || 0,
      byType: Object.fromEntries(
        Object.entries(ops)
          .filter(([k]) => k.startsWith("type."))
          .map(([k, v]) => [k.replace("type.", ""), v])
      ),
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _visibilityLevel(visibility) {
  const levels = {
    [TIMELINE_VISIBILITY.PUBLIC]:   1,
    [TIMELINE_VISIBILITY.PARTNER]:  2,
    [TIMELINE_VISIBILITY.INTERNAL]: 3,
  };
  return levels[visibility] || 1;
}

function _safeKey(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
