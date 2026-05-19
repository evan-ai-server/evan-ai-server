// src/outcomeTimeline.js
// Outcome Timeline — per-item ordered event log.
//
// Records every state transition, financial event, and user annotation
// on a scanned item as a time-ordered list.
//
// Queryable by:
//   - scanId  (single-item full timeline)
//   - userId  (all items, filterable)
//   - category, signal, state, time window
//
// Storage:
//   Redis   : outcome:tl:{userId}:{scanId}  LIST — JSON event entries (push/trim)
//   Postgres: outcome_events                      — durable indexed event log
//
// Event types:
//   state_transition   — lifecycle state change
//   financial_note     — user manually noted a price/fee
//   annotation         — free-text note
//   rescan             — market signal refreshed on same item

const KEY_TL  = (uid, sid) => `outcome:tl:${uid}:${sid}`;
const TL_TTL  = 365 * 86400;
const MAX_TL  = 500;  // events per scan item

// ── Append an event ───────────────────────────────────────────────────────────

/**
 * Append an event to a scan item's timeline.
 * Called by outcomeEngine.transitionOutcome automatically for state transitions.
 * Can also be called independently for financial notes or annotations.
 *
 * @param {string} eventType — "state_transition" | "financial_note" | "annotation" | "rescan"
 * @param {object} data
 *   fromState      — prior state (state_transition only)
 *   toState        — new state
 *   priceActual    — dollar amount if relevant
 *   priceLabel     — "buy_price" | "sell_price" | "list_price" | "return_credit"
 *   platform       — platform name if relevant
 *   notes          — free text
 *   meta           — arbitrary extra context
 */
export async function appendTimelineEvent(redis, userId, scanId, eventType, data = {}) {
  if (!redis || !userId || !scanId || !eventType) return null;

  const now   = Date.now();
  const event = {
    at:         now,
    eventType:  String(eventType).slice(0, 40),
    fromState:  data.fromState  || null,
    toState:    data.toState    || null,
    priceActual:data.priceActual != null ? Number(data.priceActual) : null,
    priceLabel: data.priceLabel || null,
    platform:   data.platform   ? String(data.platform).slice(0, 80) : null,
    notes:      data.notes      ? String(data.notes).slice(0, 500) : null,
    meta:       data.meta       || null,
  };

  try {
    const serialized = JSON.stringify(event);
    const key = KEY_TL(userId, scanId);
    await redis.pipeline()
      .rpush(key, serialized)
      .ltrim(key, -MAX_TL, -1)   // keep only last MAX_TL events
      .expire(key, TL_TTL)
      .exec();
  } catch { /* non-fatal */ }

  return event;
}

// ── Get timeline for a single scan item ──────────────────────────────────────

/**
 * Retrieve the complete timeline for a scan item.
 * Returns events in chronological order (oldest first).
 *
 * @returns Event[] sorted by at ASC
 */
export async function getItemTimeline(redis, pgPool, userId, scanId) {
  if (!userId || !scanId) return [];

  // Prefer Postgres when available (indexed, persistent)
  if (pgPool) {
    try {
      const result = await pgPool.query(
        `SELECT
           id,
           event_type  AS "eventType",
           from_state  AS "fromState",
           to_state    AS "toState",
           price_actual AS "priceActual",
           price_label  AS "priceLabel",
           platform,
           notes,
           meta,
           created_at  AS "at"
         FROM outcome_events
         WHERE scan_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [scanId, userId]
      );
      if (result.rows.length > 0) return result.rows;
    } catch { /* fall through */ }
  }

  // Redis fallback
  if (!redis) return [];
  try {
    const raw = await redis.lrange(KEY_TL(userId, scanId), 0, -1);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Query timelines across multiple items ─────────────────────────────────────

/**
 * Query outcome events from Postgres for aggregate or filtered reporting.
 * Useful for: "show me all SOLD transitions in the last 30 days for footwear".
 *
 * Falls back to a per-item Redis approach if Postgres unavailable (slow — limit low).
 *
 * @param {object} opts
 *   eventType  — filter by event type (e.g. "state_transition")
 *   toState    — filter by destination state (e.g. "SOLD")
 *   category   — filter by category (uses scan_sessions join)
 *   signal     — filter by buy signal
 *   since      — start timestamp (ms or ISO)
 *   until      — end timestamp (ms or ISO)
 *   limit      — max results
 */
export async function queryTimelineEvents(pgPool, userId, {
  eventType = null,
  toState   = null,
  category  = null,
  signal    = null,
  since     = null,
  until     = null,
  limit     = 100,
} = {}) {
  if (!pgPool) return [];

  try {
    const conds  = ["e.user_id = $1"];
    const params = [userId];
    let p = 2;

    if (eventType) { conds.push(`e.event_type = $${p++}`);       params.push(eventType); }
    if (toState)   { conds.push(`e.to_state = $${p++}`);         params.push(toState); }
    if (category) {
      conds.push(`s.category = $${p++}`);
      params.push(String(category).toLowerCase().trim().slice(0, 60));
    }
    if (signal) {
      conds.push(`o.signal_shown = $${p++}`);
      params.push(String(signal).slice(0, 40));
    }
    if (since) {
      const ts = Number(since) > 1e12 ? new Date(Number(since)).toISOString() : since;
      conds.push(`e.created_at >= $${p++}`); params.push(ts);
    }
    if (until) {
      const ts = Number(until) > 1e12 ? new Date(Number(until)).toISOString() : until;
      conds.push(`e.created_at <= $${p++}`); params.push(ts);
    }
    params.push(Math.min(limit, 1000));

    const result = await pgPool.query(
      `SELECT
         e.id,
         e.scan_id       AS "scanId",
         e.event_type    AS "eventType",
         e.from_state    AS "fromState",
         e.to_state      AS "toState",
         e.price_actual  AS "priceActual",
         e.price_label   AS "priceLabel",
         e.platform,
         e.notes,
         e.meta,
         e.created_at    AS "at",
         s.category,
         s.brand,
         s.model,
         o.signal_shown  AS "signalShown"
       FROM outcome_events e
       LEFT JOIN scan_sessions s ON s.scan_id = e.scan_id
       LEFT JOIN scan_outcomes o ON o.scan_id = e.scan_id AND o.user_id = e.user_id
       WHERE ${conds.join(" AND ")}
       ORDER BY e.created_at DESC
       LIMIT $${p}`,
      params
    );
    return result.rows;
  } catch { return []; }
}
