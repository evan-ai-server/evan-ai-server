// src/outcomeEngine.js
// Outcome Engine — durable scan outcome lifecycle and state machine.
//
// Manages the full lifecycle of a scanned item from first scan through
// eventual sale or explicit terminal state. Every transition is recorded
// with timestamp and optional financial data.
//
// State machine:
//   SCANNED  → WATCHED | BOUGHT | SKIPPED
//   WATCHED  → BOUGHT  | SKIPPED
//   BOUGHT   → LISTED  | RETURNED
//   LISTED   → SOLD    | FAILED_EXIT
//   SOLD     → RETURNED  (buyer return after sale)
//
//   Terminal: SKIPPED, RETURNED, FAILED_EXIT
//
// Storage:
//   Redis   : outcome:state:{userId}:{scanId}  HASH — current state + financials
//   Redis   : outcome:user:{userId}            ZSET — scanIds scored by last transition time
//   Postgres: scan_outcomes.lifecycle_state         — durable lifecycle state
//   Postgres: outcome_events                        — per-transition event log

// ── State definitions ─────────────────────────────────────────────────────────

export const OUTCOME_STATES = Object.freeze({
  SCANNED:     "SCANNED",
  WATCHED:     "WATCHED",
  BOUGHT:      "BOUGHT",
  SKIPPED:     "SKIPPED",
  LISTED:      "LISTED",
  SOLD:        "SOLD",
  RETURNED:    "RETURNED",
  FAILED_EXIT: "FAILED_EXIT",
});

// Valid transitions map: fromState → allowed toState[]
const VALID_TRANSITIONS = {
  SCANNED:     ["WATCHED", "BOUGHT", "SKIPPED"],
  WATCHED:     ["BOUGHT",  "SKIPPED"],
  BOUGHT:      ["LISTED",  "RETURNED"],
  LISTED:      ["SOLD",    "FAILED_EXIT"],
  SOLD:        ["RETURNED"],
  SKIPPED:     [],
  RETURNED:    [],
  FAILED_EXIT: [],
};

const TERMINAL_STATES = new Set(["SKIPPED", "RETURNED", "FAILED_EXIT"]);

const KEY_STATE = (uid, sid) => `outcome:state:${uid}:${sid}`;
const KEY_USER  = (uid)      => `outcome:user:${uid}`;
const STATE_TTL = 365 * 86400;   // 1 year
const USER_TTL  = 365 * 86400;
const USER_MAX  = 2000;          // cap per-user ZSET

// ── Initialize outcome record ─────────────────────────────────────────────────
// Call immediately after a scan produces a signal. Sets state = SCANNED.

/**
 * @param {object} redis
 * @param {object|null} pgPool    — Postgres pool; if null, Redis-only
 * @param {string} userId
 * @param {string} scanId
 * @param {object} meta           — scan metadata
 *   category, brand, model, query, buySignal, dealStrength, scannedPrice, confidenceV2
 */
export async function initOutcome(redis, pgPool, userId, scanId, {
  category     = "",
  brand        = "",
  model        = "",
  query        = null,
  buySignal    = null,
  dealStrength = null,
  scannedPrice = null,
  confidenceV2 = null,
} = {}) {
  if (!redis || !userId || !scanId) return null;

  const now = Date.now();
  const record = {
    scanId,
    userId,
    state:        OUTCOME_STATES.SCANNED,
    category:     sanitize(category),
    brand:        sanitize(brand),
    model:        sanitize(model),
    query:        query ? String(query).slice(0, 200) : null,
    buySignal:    buySignal    ? String(buySignal).slice(0, 40)    : null,
    dealStrength: dealStrength  != null ? round2(Number(dealStrength))  : null,
    scannedPrice: scannedPrice  != null ? round2(Number(scannedPrice))  : null,
    confidenceV2: confidenceV2  != null ? round2(Number(confidenceV2))  : null,
    // Financials populated by later transitions
    buyPrice:                  null,
    listPrice:                 null,
    sellPrice:                 null,
    grossProfit:               null,
    netProfitRealized:         null,   // using actual fees paid
    netProfitEstimated:        null,   // using estimated platform fee schedule
    platformFeeRealized:       null,   // actual fee — labeled REALIZED
    platformFeeEstimated:      null,   // schedule-based estimate — labeled ESTIMATED
    shippingRealized:          null,
    refundAmount:              null,   // Phase 10: refund amount (RETURNED state)
    sellPlatform:              null,
    isWin:                     null,
    // Phase 10: outcome flags (orthogonal to state)
    disputeFlag:       false,   // buyer opened a dispute
    counterfeiteFlag:  false,   // item flagged as counterfeit
    cancellationFlag:  false,   // transaction was cancelled
    // Phase 10: financial correction audit trail
    correctionHistory: [],      // [{ at, by, field, from, to, reason }]
    stateHistory: [{ state: OUTCOME_STATES.SCANNED, at: now }],
    createdAt:    now,
    updatedAt:    now,
  };

  const pipe = redis.pipeline();
  pipe.set(KEY_STATE(userId, scanId), JSON.stringify(record), "EX", STATE_TTL);
  pipe.zadd(KEY_USER(userId), now, scanId);
  pipe.zremrangebyrank(KEY_USER(userId), 0, -(USER_MAX + 1));
  pipe.expire(KEY_USER(userId), USER_TTL);
  await pipe.exec().catch(() => {});

  // Durable write — only writes lifecycle_state; financial columns updated at transitions
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO scan_outcomes
         (scan_id, user_id, lifecycle_state, signal_shown, did_buy, reported_at)
       VALUES ($1, $2, $3, $4, FALSE, NOW())
       ON CONFLICT (scan_id, user_id) DO UPDATE
         SET lifecycle_state = EXCLUDED.lifecycle_state`,
      [scanId, userId, OUTCOME_STATES.SCANNED, buySignal || null]
    ).catch(() => {});
  }

  return record;
}

// ── Transition state ──────────────────────────────────────────────────────────

/**
 * Transition an outcome to a new state.
 * Returns the updated record, or an error object if transition is invalid.
 *
 * @param {string} toState         — from OUTCOME_STATES
 * @param {object} financials      — optional; apply financial data at this transition
 *   buyPrice:            number|null   — actual buy price (at BOUGHT)
 *   sellPrice:           number|null   — actual sell price (at SOLD)
 *   listPrice:           number|null   — listed price (at LISTED)
 *   platformFeeRealized: number|null   — actual fee paid (if available — REALIZED)
 *   shipping:            number|null   — actual shipping (if available — REALIZED)
 *   sellPlatform:        string|null
 *   notes:               string|null
 */
export async function transitionOutcome(redis, pgPool, userId, scanId, toState, financials = {}) {
  if (!redis || !userId || !scanId || !toState) return null;
  if (!OUTCOME_STATES[toState]) return { error: `invalid_state: ${toState}` };

  const raw = await redis.get(KEY_STATE(userId, scanId)).catch(() => null);
  if (!raw) return { error: "outcome_not_found", scanId };

  let record;
  try { record = JSON.parse(raw); } catch { return { error: "parse_error" }; }

  const fromState = record.state;
  const allowed   = VALID_TRANSITIONS[fromState] || [];
  if (!allowed.includes(toState)) {
    return { error: "invalid_transition", fromState, toState, allowed };
  }

  const now = Date.now();
  record.state     = toState;
  record.updatedAt = now;

  const {
    buyPrice            = null,
    sellPrice           = null,
    listPrice           = null,
    platformFeeRealized = null,
    shipping            = null,
    sellPlatform        = null,
    notes               = null,
  } = financials;

  // Apply financials at each relevant transition
  if (toState === "BOUGHT"  && buyPrice   != null) record.buyPrice   = round2(Number(buyPrice));
  if (toState === "LISTED"  && listPrice  != null) record.listPrice  = round2(Number(listPrice));
  if (toState === "SOLD"    && sellPrice  != null) record.sellPrice  = round2(Number(sellPrice));
  if (platformFeeRealized   != null)               record.platformFeeRealized  = round2(Number(platformFeeRealized));
  if (shipping              != null)               record.shippingRealized     = round2(Number(shipping));
  if (sellPlatform)                                record.sellPlatform         = String(sellPlatform).slice(0, 80);

  // Compute P&L only when we have both buy + sell (REALIZED)
  // Never compute hypothetical or scan-time "savings"
  if (record.buyPrice != null && record.sellPrice != null) {
    record.grossProfit = round2(record.sellPrice - record.buyPrice);

    const feeR = record.platformFeeRealized;
    const ship = record.shippingRealized || 0;

    if (feeR != null) {
      // Fee was provided by user — use it directly (REALIZED)
      record.netProfitRealized = round2(record.grossProfit - feeR - ship);
    }

    // Also compute estimated net using platform fee schedule (clearly labeled ESTIMATED)
    const feeEst = feeR == null
      ? estimatePlatformFee(record.sellPrice, record.sellPlatform)
      : null;
    if (feeEst != null) {
      record.platformFeeEstimated = feeEst;
      record.netProfitEstimated   = round2(record.grossProfit - feeEst - ship);
    }

    // isWin: prefer realized, fall back to estimated, then gross
    const netForWin = record.netProfitRealized ?? record.netProfitEstimated ?? record.grossProfit;
    record.isWin = netForWin > 0;
  }

  // Append to state history
  if (!Array.isArray(record.stateHistory)) record.stateHistory = [];
  const histEntry = { state: toState, at: now };
  if (notes) histEntry.notes = String(notes).slice(0, 300);
  record.stateHistory.push(histEntry);

  // Persist to Redis
  const pipe = redis.pipeline();
  pipe.set(KEY_STATE(userId, scanId), JSON.stringify(record), "EX", STATE_TTL);
  pipe.zadd(KEY_USER(userId), now, scanId);
  pipe.expire(KEY_USER(userId), USER_TTL);
  await pipe.exec().catch(() => {});

  // Durable Postgres update
  if (pgPool) {
    await pgPool.query(
      `UPDATE scan_outcomes SET
         lifecycle_state       = $1,
         state_updated_at      = to_timestamp($2::bigint / 1000.0),
         did_buy               = CASE WHEN $3 THEN TRUE  ELSE did_buy    END,
         buy_price             = COALESCE($4,  buy_price),
         did_sell              = CASE WHEN $5 THEN TRUE  ELSE did_sell   END,
         sell_price            = COALESCE($6,  sell_price),
         gross_profit          = COALESCE($7,  gross_profit),
         net_profit            = COALESCE($8,  net_profit),
         platform_fees         = COALESCE($9,  platform_fees),
         shipping_cost         = COALESCE($10, shipping_cost),
         sell_platform         = COALESCE($11, sell_platform),
         is_win                = COALESCE($12, is_win)
       WHERE scan_id = $13 AND user_id = $14`,
      [
        toState,
        now,
        toState === "BOUGHT",
        record.buyPrice  ?? null,
        toState === "SOLD",
        record.sellPrice ?? null,
        record.grossProfit          ?? null,
        record.netProfitRealized    ?? null,
        record.platformFeeRealized  ?? null,
        record.shippingRealized     ?? null,
        record.sellPlatform         ?? null,
        record.isWin                ?? null,
        scanId,
        userId,
      ]
    ).catch(() => {});

    // Append event to outcome_events
    await pgPool.query(
      `INSERT INTO outcome_events
         (scan_id, user_id, event_type, from_state, to_state,
          price_actual, price_label, platform, notes, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        scanId,
        userId,
        "state_transition",
        fromState,
        toState,
        toState === "BOUGHT"  ? (record.buyPrice   ?? null) :
        toState === "SOLD"    ? (record.sellPrice   ?? null) :
        toState === "LISTED"  ? (record.listPrice   ?? null) : null,
        toState === "BOUGHT"  ? "buy_price"  :
        toState === "SOLD"    ? "sell_price" :
        toState === "LISTED"  ? "list_price" : null,
        record.sellPlatform ?? null,
        notes ? String(notes).slice(0, 500) : null,
        JSON.stringify({
          fromState,
          toState,
          grossProfit:         record.grossProfit        ?? null,
          netProfitRealized:   record.netProfitRealized  ?? null,
          netProfitEstimated:  record.netProfitEstimated ?? null,
        }),
      ]
    ).catch(() => {});
  }

  return record;
}

// ── Read current state ────────────────────────────────────────────────────────

export async function getOutcomeState(redis, userId, scanId) {
  if (!redis || !userId || !scanId) return null;
  try {
    const raw = await redis.get(KEY_STATE(userId, scanId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── List outcomes for a user (Redis) ─────────────────────────────────────────

/**
 * List outcome records for a user from Redis.
 * @param {object} opts
 *   limit    — max results (default 50)
 *   state    — filter by lifecycle state
 *   category — filter by category
 *   signal   — filter by buySignal
 *   since    — min timestamp (ms)
 *   until    — max timestamp (ms)
 */
export async function listUserOutcomes(redis, userId, {
  limit    = 50,
  state    = null,
  category = null,
  signal   = null,
  since    = null,
  until    = null,
} = {}) {
  if (!redis || !userId) return [];
  try {
    const minScore = since  ? Number(since) : 0;
    const maxScore = until  ? Number(until) : "+inf";
    // Fetch extra to account for filter drop-off
    const ids = await redis.zrevrangebyscore(KEY_USER(userId), maxScore, minScore, "LIMIT", 0, limit * 4);
    if (!ids?.length) return [];

    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_STATE(userId, id));
    const results = await pipe.exec();

    return results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean)
      .filter((r) => {
        if (state    && r.state    !== state)              return false;
        if (category && r.category !== sanitize(category)) return false;
        if (signal   && r.buySignal !== signal)            return false;
        return true;
      })
      .slice(0, limit);
  } catch { return []; }
}

// ── Durable query via Postgres ────────────────────────────────────────────────

/**
 * Query outcomes from Postgres for aggregate-level reporting.
 * Falls back to Redis if pgPool unavailable.
 */
export async function queryOutcomes(pgPool, redis, userId, {
  category = null,
  signal   = null,
  state    = null,
  since    = null,
  until    = null,
  limit    = 100,
} = {}) {
  if (pgPool) {
    try {
      const conds  = ["o.user_id = $1"];
      const params = [userId];
      let p = 2;

      if (category) { conds.push(`o.category = $${p++}`);        params.push(sanitize(category)); }
      if (signal)   { conds.push(`o.signal_shown = $${p++}`);    params.push(String(signal).slice(0, 40)); }
      if (state)    { conds.push(`o.lifecycle_state = $${p++}`); params.push(state); }
      if (since) {
        const ts = Number(since) > 1e12 ? new Date(Number(since)).toISOString() : since;
        conds.push(`o.reported_at >= $${p++}`); params.push(ts);
      }
      if (until) {
        const ts = Number(until) > 1e12 ? new Date(Number(until)).toISOString() : until;
        conds.push(`o.reported_at <= $${p++}`); params.push(ts);
      }
      params.push(Math.min(limit, 500));

      const result = await pgPool.query(
        `SELECT
           o.scan_id,
           o.user_id,
           o.lifecycle_state,
           o.signal_shown,
           o.did_buy,
           o.buy_price,
           o.did_sell,
           o.sell_price,
           o.gross_profit,
           o.net_profit,
           o.platform_fees,
           o.shipping_cost,
           o.is_win,
           o.sell_platform,
           o.reported_at,
           o.state_updated_at,
           s.category,
           s.brand,
           s.model,
           s.deal_strength,
           s.confidence_v2
         FROM scan_outcomes o
         LEFT JOIN scan_sessions s ON s.scan_id = o.scan_id
         WHERE ${conds.join(" AND ")}
         ORDER BY o.reported_at DESC
         LIMIT $${p}`,
        params
      );
      return result.rows;
    } catch { /* fall through */ }
  }

  // Redis fallback
  return listUserOutcomes(redis, userId, { limit, state, category, signal, since, until });
}

// ── Per-category and per-signal aggregation ───────────────────────────────────

/**
 * Aggregate realized outcomes per category for a user.
 * Returns only entries where both buy_price AND sell_price are present
 * (genuine realized outcomes — not scan-time estimates).
 */
export async function getOutcomeAggregates(pgPool, redis, userId, { since = null } = {}) {
  if (pgPool) {
    try {
      const params = [userId];
      let sinceClause = "";
      if (since) {
        const ts = Number(since) > 1e12 ? new Date(Number(since)).toISOString() : since;
        params.push(ts);
        sinceClause = `AND o.reported_at >= $2`;
      }
      const result = await pgPool.query(
        `SELECT
           s.category,
           o.signal_shown                              AS signal,
           COUNT(*)                                    AS total_outcomes,
           COUNT(*) FILTER (WHERE o.did_buy = TRUE)   AS bought_count,
           COUNT(*) FILTER (WHERE o.did_sell = TRUE)  AS sold_count,
           COUNT(*) FILTER (WHERE o.is_win = TRUE)    AS win_count,
           COUNT(*) FILTER (WHERE o.is_win = FALSE)   AS loss_count,
           SUM(o.net_profit) FILTER (WHERE o.net_profit IS NOT NULL)   AS net_profit_sum,
           SUM(o.gross_profit) FILTER (WHERE o.gross_profit IS NOT NULL) AS gross_profit_sum,
           AVG(o.net_profit) FILTER (WHERE o.net_profit IS NOT NULL)   AS avg_net_profit
         FROM scan_outcomes o
         LEFT JOIN scan_sessions s ON s.scan_id = o.scan_id
         WHERE o.user_id = $1
           AND o.buy_price IS NOT NULL
           AND o.sell_price IS NOT NULL
           ${sinceClause}
         GROUP BY s.category, o.signal_shown
         ORDER BY net_profit_sum DESC NULLS LAST`,
        params
      );
      return result.rows.map((r) => ({
        category:     r.category   || "unknown",
        signal:       r.signal     || null,
        totalOutcomes: Number(r.total_outcomes),
        boughtCount:  Number(r.bought_count),
        soldCount:    Number(r.sold_count),
        winCount:     Number(r.win_count),
        lossCount:    Number(r.loss_count),
        hitRate:      Number(r.sold_count) > 0
          ? round2((Number(r.win_count) / Number(r.sold_count)) * 100)
          : null,
        // Realized values: only when user provided sell price
        netProfitSum:  r.net_profit_sum   != null ? round2(Number(r.net_profit_sum))   : null,
        grossProfitSum:r.gross_profit_sum != null ? round2(Number(r.gross_profit_sum)) : null,
        avgNetProfit:  r.avg_net_profit   != null ? round2(Number(r.avg_net_profit))   : null,
      }));
    } catch { /* fall through */ }
  }

  // Redis fallback: list outcomes and aggregate in-process
  const outcomes = await listUserOutcomes(redis, userId, { limit: 500 });
  const catMap = new Map();
  for (const r of outcomes) {
    if (r.buyPrice == null || r.sellPrice == null) continue;
    const key = `${r.category || "unknown"}:${r.buySignal || ""}`;
    if (!catMap.has(key)) catMap.set(key, { category: r.category, signal: r.buySignal, wins: 0, losses: 0, netSum: 0, count: 0 });
    const e = catMap.get(key);
    e.count++;
    if (r.isWin === true)  e.wins++;
    if (r.isWin === false) e.losses++;
    if (r.netProfitRealized != null) e.netSum += r.netProfitRealized;
    else if (r.netProfitEstimated != null) e.netSum += r.netProfitEstimated;
  }
  return [...catMap.values()].map((e) => ({
    category:      e.category || "unknown",
    signal:        e.signal || null,
    soldCount:     e.count,
    winCount:      e.wins,
    lossCount:     e.losses,
    hitRate:       e.count > 0 ? round2((e.wins / e.count) * 100) : null,
    netProfitSum:  round2(e.netSum),
  }));
}

// ── Phase 10: Outcome flags ────────────────────────────────────────────────────

/**
 * Set outcome flags: dispute, counterfeit, or cancellation.
 * Flags are orthogonal to lifecycle state — they can be set in any non-terminal state.
 *
 * @param {object} flags
 *   disputeFlag      {boolean|null}
 *   counterfeiteFlag {boolean|null}
 *   cancellationFlag {boolean|null}
 *   notes            {string|null}
 */
export async function setOutcomeFlags(redis, pgPool, userId, scanId, {
  disputeFlag      = null,
  counterfeiteFlag = null,
  cancellationFlag = null,
  notes            = null,
} = {}) {
  if (!redis || !userId || !scanId) return { error: "missing_required" };

  const raw = await redis.get(KEY_STATE(userId, scanId)).catch(() => null);
  if (!raw) return { error: "outcome_not_found" };

  let record;
  try { record = JSON.parse(raw); } catch { return { error: "parse_error" }; }

  const now     = Date.now();
  const changed = {};

  if (disputeFlag      != null && typeof disputeFlag      === "boolean") {
    changed.disputeFlag      = { from: record.disputeFlag,      to: disputeFlag };
    record.disputeFlag      = disputeFlag;
  }
  if (counterfeiteFlag != null && typeof counterfeiteFlag === "boolean") {
    changed.counterfeiteFlag = { from: record.counterfeiteFlag, to: counterfeiteFlag };
    record.counterfeiteFlag = counterfeiteFlag;
  }
  if (cancellationFlag != null && typeof cancellationFlag === "boolean") {
    changed.cancellationFlag = { from: record.cancellationFlag, to: cancellationFlag };
    record.cancellationFlag = cancellationFlag;
  }

  if (Object.keys(changed).length === 0) return { ok: true, record };

  if (!Array.isArray(record.correctionHistory)) record.correctionHistory = [];
  record.correctionHistory.push({
    at: now, by: "user", type: "flag_change",
    changes: changed,
    notes: notes ? String(notes).slice(0, 300) : null,
  });
  record.updatedAt = now;

  const pipe = redis.pipeline();
  pipe.set(KEY_STATE(userId, scanId), JSON.stringify(record), "EX", STATE_TTL);
  pipe.zadd(KEY_USER(userId), now, scanId);
  pipe.expire(KEY_USER(userId), USER_TTL);
  await pipe.exec().catch(() => {});

  if (pgPool && (disputeFlag != null || counterfeiteFlag != null || cancellationFlag != null)) {
    await pgPool.query(
      `INSERT INTO outcome_events
         (scan_id, user_id, event_type, from_state, to_state, notes, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        scanId, userId, "flag_change",
        record.state, record.state,
        notes || null,
        JSON.stringify({ changed }),
      ]
    ).catch(() => {});
  }

  return { ok: true, record };
}

// ── Phase 10: Financial corrections ───────────────────────────────────────────

/**
 * Correct a financial field on an outcome record.
 * Creates an immutable entry in correctionHistory — never silently overwrites.
 *
 * Correctable fields: buyPrice, sellPrice, listPrice, platformFeeRealized, shippingRealized, refundAmount
 *
 * @param {object} corrections  — { field: newValue, ... } (only correctable fields accepted)
 * @param {object} opts
 *   reason       {string}  REQUIRED — why the correction is being made
 *   correctedBy  {string}  who is making the correction ("user" | route | userId)
 */
export async function correctOutcomeFinancials(redis, pgPool, userId, scanId, corrections = {}, {
  reason,
  correctedBy = "user",
} = {}) {
  if (!redis || !userId || !scanId) return { error: "missing_required" };
  if (!reason || !String(reason).trim()) return { error: "correction_requires_reason" };

  const CORRECTABLE_FIELDS = new Set([
    "buyPrice", "sellPrice", "listPrice",
    "platformFeeRealized", "shippingRealized", "refundAmount",
  ]);

  const raw = await redis.get(KEY_STATE(userId, scanId)).catch(() => null);
  if (!raw) return { error: "outcome_not_found" };

  let record;
  try { record = JSON.parse(raw); } catch { return { error: "parse_error" }; }

  const now     = Date.now();
  const applied = {};

  for (const [field, newVal] of Object.entries(corrections)) {
    if (!CORRECTABLE_FIELDS.has(field)) continue;

    const numeric = Number(newVal);
    if (!Number.isFinite(numeric) || numeric < 0) continue;

    applied[field] = { from: record[field], to: round2(numeric) };
    record[field]  = round2(numeric);
  }

  if (Object.keys(applied).length === 0) {
    return { error: "no_correctable_fields_provided", allowedFields: [...CORRECTABLE_FIELDS] };
  }

  // Recompute derived P&L after corrections
  if (record.buyPrice != null && record.sellPrice != null) {
    record.grossProfit = round2(record.sellPrice - record.buyPrice);
    const feeR = record.platformFeeRealized;
    const ship = record.shippingRealized || 0;
    if (feeR != null) {
      record.netProfitRealized = round2(record.grossProfit - feeR - ship);
    }
    const feeEst = feeR == null ? estimatePlatformFee(record.sellPrice, record.sellPlatform) : null;
    if (feeEst != null) {
      record.platformFeeEstimated = feeEst;
      record.netProfitEstimated   = round2(record.grossProfit - feeEst - ship);
    }
    const netForWin = record.netProfitRealized ?? record.netProfitEstimated ?? record.grossProfit;
    record.isWin = netForWin > 0;
  }

  // Append to correction history (immutable audit trail)
  if (!Array.isArray(record.correctionHistory)) record.correctionHistory = [];
  record.correctionHistory.push({
    at:          now,
    by:          String(correctedBy).slice(0, 100),
    type:        "financial_correction",
    reason:      String(reason).slice(0, 500),
    changes:     applied,
  });
  record.updatedAt = now;

  const pipe = redis.pipeline();
  pipe.set(KEY_STATE(userId, scanId), JSON.stringify(record), "EX", STATE_TTL);
  pipe.zadd(KEY_USER(userId), now, scanId);
  pipe.expire(KEY_USER(userId), USER_TTL);
  await pipe.exec().catch(() => {});

  if (pgPool) {
    await pgPool.query(
      `INSERT INTO outcome_events
         (scan_id, user_id, event_type, from_state, to_state, notes, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        scanId, userId, "financial_correction",
        record.state, record.state,
        reason,
        JSON.stringify({ applied, correctedBy }),
      ]
    ).catch(() => {});
  }

  return { ok: true, record, applied };
}

// ── Platform fee schedule (for estimated labels) ──────────────────────────────
// Rates are approximate per publicly available schedules.
// Results are ALWAYS labeled as estimated when using this function.

const PLATFORM_FEE_RATES = {
  ebay:                   (p) => p >= 7500 ? 0.0225 : 0.1325,
  poshmark:               (p) => p < 15   ? 2.95 / Math.max(p, 0.01) : 0.20,
  mercari:                ()  => 0.10,
  depop:                  ()  => 0.10,
  stockx:                 ()  => 0.095,
  vinted:                 ()  => 0,          // buyer-funded
  "facebook marketplace": ()  => 0.05,
  amazon:                 ()  => 0.15,
  etsy:                   ()  => 0.065 + 0.03,
};

export function estimatePlatformFee(sellPrice, platform) {
  if (!platform || sellPrice == null || !Number.isFinite(Number(sellPrice))) return null;
  const price = Number(sellPrice);
  if (price <= 0) return null;
  const key    = String(platform).toLowerCase().trim();
  const rateFn = PLATFORM_FEE_RATES[key]
    || Object.entries(PLATFORM_FEE_RATES).find(([k]) => key.includes(k))?.[1];
  if (!rateFn) return null;
  const rate = rateFn(price);
  return round2(typeof rate === "number" ? price * rate : rate);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_\- ]/g, "").trim().slice(0, 60);
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
