// src/tacticWinRateEngine.js
// Tactic Win-Rate Engine — Phase 13: Behavioral Lock-In.
//
// Tracks how specific buying/selling behaviors correlate with outcomes.
// Every metric traces to a real outcome event — no synthetic scores.
//
// Tactic types:
//   STRONG_BUY_ONLY      — user bought on STRONG BUY signal (not lower)
//   GOOD_DEAL_ACTIVE     — user bought on GOOD DEAL signal
//   WARNING_IGNORED      — user bought despite active scan warnings
//   NEGOTIATED_BUY       — personal action was NEGOTIATE and user bought
//   SELL_FIRST_COMPLIED  — personal action was SELL_FIRST and user did NOT buy
//   SELL_FIRST_IGNORED   — personal action was SELL_FIRST and user bought anyway
//   HOLD_LONG            — sold item after ≥ HOLD_LONG_DAYS (60d) held
//
// Recording:
//   recordTacticEvent()     — called at buy-outcome time (index.js)
//   inferTacticsFromBuy()   — pure function; infer applicable tactics from context
//
// Redis keys:
//   tactic:stat:{userId}:{tacticType}    HASH  wins, total, winProfitSum, lossProfitSum, updatedAt
//   tactic:recent:{userId}               ZSET  score=ts, member=JSON event (90d, max 100)

const KEY_STAT   = (uid, t) => `tactic:stat:${uid}:${t}`;
const KEY_RECENT = (uid)    => `tactic:recent:${uid}`;

const STAT_TTL   = 180 * 86400;   // 6 months — tactics are long-term behavioral signals
const RECENT_TTL = 90  * 86400;   // 90 days
const MAX_RECENT = 100;

export const HOLD_LONG_DAYS = 60;  // held this many days = HOLD_LONG

export const TACTIC_TYPES = {
  STRONG_BUY_ONLY:     "STRONG_BUY_ONLY",
  GOOD_DEAL_ACTIVE:    "GOOD_DEAL_ACTIVE",
  WARNING_IGNORED:     "WARNING_IGNORED",
  NEGOTIATED_BUY:      "NEGOTIATED_BUY",
  SELL_FIRST_COMPLIED: "SELL_FIRST_COMPLIED",
  SELL_FIRST_IGNORED:  "SELL_FIRST_IGNORED",
  HOLD_LONG:           "HOLD_LONG",
};

// ── Inference ─────────────────────────────────────────────────────────────────

/**
 * Infer which tactics apply to a completed outcome event.
 * Pure function — no Redis access. Returns array of tactic type strings.
 *
 * @param {object} ctx
 *   didBuy        {boolean}        — user actually bought
 *   buySignal     {string|null}    — signal shown at scan time
 *   personalAction{string|null}    — Evan's recommendation (BUY, NEGOTIATE, SELL_FIRST, …)
 *   warnings      {string[]|null}  — active warnings at scan time
 *   isWin         {boolean|null}   — outcome (null if not yet sold)
 *   daysToSell    {number|null}    — days between buy and sell
 * @returns {string[]}
 */
export function inferTacticsFromBuy(ctx) {
  const { didBuy, buySignal, personalAction, warnings, daysToSell } = ctx;
  const tactics = [];

  if (didBuy) {
    if (buySignal === "STRONG BUY") tactics.push(TACTIC_TYPES.STRONG_BUY_ONLY);
    if (buySignal === "GOOD DEAL")  tactics.push(TACTIC_TYPES.GOOD_DEAL_ACTIVE);
    if (Array.isArray(warnings) && warnings.length >= 1) tactics.push(TACTIC_TYPES.WARNING_IGNORED);
    if (personalAction === "NEGOTIATE")   tactics.push(TACTIC_TYPES.NEGOTIATED_BUY);
    if (personalAction === "SELL_FIRST")  tactics.push(TACTIC_TYPES.SELL_FIRST_IGNORED);
    if (daysToSell != null && daysToSell >= HOLD_LONG_DAYS) tactics.push(TACTIC_TYPES.HOLD_LONG);
  } else {
    // Not a buy — only SELL_FIRST_COMPLIED applies (user heeded the recommendation)
    if (personalAction === "SELL_FIRST") tactics.push(TACTIC_TYPES.SELL_FIRST_COMPLIED);
  }

  return tactics;
}

// ── Recording ─────────────────────────────────────────────────────────────────

/**
 * Record a tactic outcome event.
 * Increments win/loss counters for the tactic and logs the event.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string} tacticType    — one of TACTIC_TYPES
 * @param {object} opts
 *   isWin         {boolean|null}  — outcome (null if compliance tactic, no outcome yet)
 *   netProfit     {number|null}   — realized net profit (null if not yet sold)
 *   signal        {string|null}
 *   category      {string|null}
 */
export async function recordTacticEvent(redis, userId, tacticType, {
  isWin      = null,
  netProfit  = null,
  signal     = null,
  category   = null,
} = {}) {
  if (!redis || !userId || !tacticType) return;
  if (!Object.values(TACTIC_TYPES).includes(tacticType)) return;

  const now     = Date.now();
  const statKey = KEY_STAT(userId, tacticType);

  try {
    const pipe = redis.pipeline();

    // Update stat counters
    pipe.hincrby(statKey, "total", 1);
    if (isWin === true) {
      pipe.hincrby(statKey, "wins", 1);
      if (netProfit != null) pipe.hincrbyfloat(statKey, "winProfitSum", Number(netProfit));
    } else if (isWin === false) {
      pipe.hincrby(statKey, "losses", 1);
      if (netProfit != null) pipe.hincrbyfloat(statKey, "lossProfitSum", Number(netProfit));
    }
    pipe.hset(statKey, "updatedAt", String(now));
    pipe.expire(statKey, STAT_TTL);

    // Log recent event
    const event = JSON.stringify({
      tactic: tacticType,
      isWin,
      netProfit: netProfit ?? null,
      signal:   signal   ?? null,
      category: category ?? null,
      at: now,
    });
    const recentKey = KEY_RECENT(userId);
    pipe.zadd(recentKey, now, event);
    pipe.expire(recentKey, RECENT_TTL);
    pipe.zremrangebyrank(recentKey, 0, -(MAX_RECENT + 1));

    await pipe.exec();
  } catch { /* non-fatal */ }
}

/**
 * Record multiple tactics from a single buy event.
 * Convenience wrapper for index.js — infers and records in one call.
 */
export async function recordTacticsFromBuyContext(redis, userId, ctx) {
  const tactics = inferTacticsFromBuy(ctx);
  if (!tactics.length) return;
  await Promise.all(
    tactics.map((t) =>
      recordTacticEvent(redis, userId, t, {
        isWin:     ctx.isWin     ?? null,
        netProfit: ctx.netProfit ?? null,
        signal:    ctx.buySignal ?? null,
        category:  ctx.category  ?? null,
      })
    )
  );
}

// ── Reading ───────────────────────────────────────────────────────────────────

/**
 * Get win-rate stats for a single tactic type.
 * Returns null if no data.
 */
export async function getTacticStats(redis, userId, tacticType) {
  if (!redis || !userId || !tacticType) return null;
  try {
    const raw = await redis.hgetall(KEY_STAT(userId, tacticType));
    if (!raw || !raw.total) return null;

    const total      = Number(raw.total)      || 0;
    const wins       = Number(raw.wins)       || 0;
    const losses     = Number(raw.losses)     || 0;
    const winProfit  = Number(raw.winProfitSum)  || 0;
    const lossProfit = Number(raw.lossProfitSum) || 0;

    return {
      tacticType,
      total,
      wins,
      losses,
      winRate:      total > 0 ? round2((wins / total) * 100) : null,
      netProfitSum: round2(winProfit + lossProfit),
      avgProfit:    (wins + losses) > 0 ? round2((winProfit + lossProfit) / (wins + losses)) : null,
      updatedAt:    raw.updatedAt ? Number(raw.updatedAt) : null,
    };
  } catch { return null; }
}

/**
 * Get tactic stats for all tracked tactic types.
 * Returns an object keyed by tacticType, only including tactics with data.
 */
export async function getTacticSummary(redis, userId) {
  if (!redis || !userId) return {};
  const results = await Promise.all(
    Object.values(TACTIC_TYPES).map((t) => getTacticStats(redis, userId, t))
  );
  const out = {};
  for (const stat of results) {
    if (stat && stat.total > 0) out[stat.tacticType] = stat;
  }
  return out;
}

/**
 * Identify the user's "signature tactics" — tactics with real data that show
 * consistent patterns. Returns top tactics sorted by trade count (min 3 events).
 *
 * Only returns tactics with enough data to be meaningful.
 * Never fabricates a "signature" from thin air.
 */
export async function getSignatureTactics(redis, userId, { minEvents = 3, topN = 3 } = {}) {
  const summary = await getTacticSummary(redis, userId);
  return Object.values(summary)
    .filter((s) => s.total >= minEvents)
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);
}

/**
 * Load recent tactic events (last N).
 */
export async function getRecentTacticEvents(redis, userId, { limit = 20 } = {}) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.zrevrange(KEY_RECENT(userId), 0, limit - 1);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(v) {
  return v != null ? Math.round(Number(v) * 100) / 100 : null;
}
