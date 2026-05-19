// src/profitLedger.js
// Realized Profit Ledger — tracks ONLY confirmed realized P&L from actual buy+sell pairs.
//
// NON-NEGOTIABLES:
//   - Do not invent fake "money protected" numbers.
//   - A realized profit entry requires BOTH buy_price AND sell_price from the user.
//   - Estimated fields (platform fees when receipt not provided) are labeled explicitly.
//   - Realized fields (fees from receipt/API) are labeled explicitly.
//   - Scan-time "savings" from market comparison are NOT recorded here.
//     (That is the gamification ledger in dealLedger.js — a separate system.)
//
// Storage:
//   Redis   : profit:totals:{userId}         HASH  — running totals (fast reads)
//   Redis   : profit:entries:{userId}        ZSET  — entry IDs scored by recorded_at
//   Redis   : profit:entry:{userId}:{eid}    STRING — full entry record
//   Postgres: realized_profit_ledger               — durable record

import { estimatePlatformFee } from "./outcomeEngine.js";

const KEY_TOTALS  = (uid) => `profit:totals:${uid}`;
const KEY_ENTRIES = (uid) => `profit:entries:${uid}`;
const KEY_ENTRY   = (uid, eid) => `profit:entry:${uid}:${eid}`;

const TOTALS_TTL  = 365 * 86400;
const ENTRIES_TTL = 365 * 86400;
const MAX_ENTRIES = 5000;

// ── Record a realized profit entry ───────────────────────────────────────────

/**
 * Record a realized profit entry.
 * Only call this when BOTH buy_price and sell_price are confirmed by the user.
 * Never call with hypothetical or estimated prices.
 *
 * @param {object} params
 *   scanId             — linked scan (optional but preferred)
 *   category           — item category
 *   brand, model       — item identity
 *   buyPriceRealized   — what the user actually paid (REQUIRED)
 *   sellPriceRealized  — what the user actually sold for (REQUIRED)
 *   platformFeeRealized— actual fee paid (from receipt/platform statement; optional)
 *   shippingRealized   — actual shipping cost paid (optional)
 *   sellPlatform       — platform sold on (optional; used for fee estimation if fee not provided)
 *   signalAtBuy        — the Evan signal when user decided to buy (optional)
 *   boughtAt           — timestamp of purchase (optional)
 *   soldAt             — timestamp of sale (optional)
 */
export async function recordRealizedProfit(redis, pgPool, userId, {
  scanId               = null,
  category             = "",
  brand                = "",
  model                = "",
  buyPriceRealized,                   // REQUIRED — actual
  sellPriceRealized,                  // REQUIRED — actual
  platformFeeRealized  = null,        // optional — actual fee paid
  shippingRealized     = null,        // optional — actual shipping
  sellPlatform         = null,
  signalAtBuy          = null,
  boughtAt             = null,
  soldAt               = null,
} = {}) {
  if (!redis || !userId) return null;

  // Both prices required — no hypothetical entries
  const buy  = Number(buyPriceRealized);
  const sell = Number(sellPriceRealized);
  if (!Number.isFinite(buy) || buy <= 0)   return { error: "buy_price_required" };
  if (!Number.isFinite(sell) || sell <= 0) return { error: "sell_price_required" };

  const now         = Date.now();
  const grossProfit = round2(sell - buy);

  const feeR   = platformFeeRealized != null && Number.isFinite(Number(platformFeeRealized))
    ? round2(Number(platformFeeRealized)) : null;
  const shipR  = shippingRealized   != null && Number.isFinite(Number(shippingRealized))
    ? round2(Number(shippingRealized))  : null;

  // Estimated fee only when actual not provided
  const feeEst = feeR == null ? estimatePlatformFee(sell, sellPlatform) : null;

  const netProfitRealized  = feeR != null
    ? round2(grossProfit - feeR  - (shipR || 0))
    : null;
  const netProfitEstimated = feeEst != null
    ? round2(grossProfit - feeEst - (shipR || 0))
    : null;

  // Best net for isWin determination (prefer realized, then estimated, then gross)
  const bestNet = netProfitRealized ?? netProfitEstimated ?? grossProfit;
  const isWin   = bestNet > 0;

  const daysToSell = boughtAt != null && soldAt != null
    ? Math.max(0, Math.round((Number(soldAt) - Number(boughtAt)) / 86400000))
    : null;

  const entryId = `pl_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const entry = {
    entryId,
    userId,
    scanId:             scanId       || null,
    category:           sanitize(category),
    brand:              sanitize(brand),
    model:              sanitize(model),
    sellPlatform:       sellPlatform ? String(sellPlatform).slice(0, 80) : null,
    signalAtBuy:        signalAtBuy  ? String(signalAtBuy).slice(0, 40)  : null,

    // Actual (REALIZED) — only fields user confirmed
    buyPriceRealized:    buy,
    sellPriceRealized:   sell,
    grossProfit,
    platformFeeRealized:  feeR,   // null if not provided
    shippingRealized:     shipR,  // null if not provided
    netProfitRealized,            // null if fee not provided

    // Estimated — labeled explicitly; null if not needed (fee was provided)
    platformFeeEstimated: feeEst, // null if feeR was provided
    netProfitEstimated,           // null if feeR was provided

    isWin,
    daysToSell,
    boughtAt:   boughtAt != null ? Number(boughtAt) : null,
    soldAt:     soldAt   != null ? Number(soldAt)   : null,
    recordedAt: now,
  };

  // Redis: store entry + update running totals
  const pipe = redis.pipeline();
  pipe.set(KEY_ENTRY(userId, entryId), JSON.stringify(entry), "EX", ENTRIES_TTL);
  pipe.zadd(KEY_ENTRIES(userId), now, entryId);
  pipe.zremrangebyrank(KEY_ENTRIES(userId), 0, -(MAX_ENTRIES + 1));
  pipe.expire(KEY_ENTRIES(userId), ENTRIES_TTL);

  // Running totals — only realized values
  pipe.hincrbyfloat(KEY_TOTALS(userId), "grossProfitTotal",      grossProfit);
  pipe.hincrby     (KEY_TOTALS(userId), "totalRealizedEntries",  1);
  if (isWin) pipe.hincrby(KEY_TOTALS(userId), "winCount", 1);
  else       pipe.hincrby(KEY_TOTALS(userId), "lossCount", 1);
  if (netProfitRealized != null)
    pipe.hincrbyfloat(KEY_TOTALS(userId), "netProfitRealizedTotal", netProfitRealized);
  if (netProfitEstimated != null)
    pipe.hincrbyfloat(KEY_TOTALS(userId), "netProfitEstimatedTotal", netProfitEstimated);
  pipe.expire(KEY_TOTALS(userId), TOTALS_TTL);

  await pipe.exec().catch(() => {});

  // Durable Postgres write
  if (pgPool) {
    await pgPool.query(
      `INSERT INTO realized_profit_ledger
         (user_id, scan_id, category, brand, model,
          buy_price_realized, sell_price_realized,
          platform_fee_realized, platform_fee_estimated,
          shipping_realized,
          gross_profit, net_profit_realized, net_profit_estimated,
          sell_platform, signal_at_buy, days_to_sell, is_verified,
          recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE,NOW())`,
      [
        userId, scanId || null,
        entry.category, entry.brand, entry.model,
        buy, sell,
        feeR  ?? null,
        feeEst ?? null,
        shipR ?? null,
        grossProfit,
        netProfitRealized  ?? null,
        netProfitEstimated ?? null,
        sellPlatform || null,
        signalAtBuy  || null,
        daysToSell   ?? null,
      ]
    ).catch(() => {});
  }

  return entry;
}

// ── Get running totals ────────────────────────────────────────────────────────

/**
 * Get a user's realized profit summary.
 * Returns totals for realized and estimated values with clear labels.
 */
export async function getRealizedProfitSummary(redis, pgPool, userId, { category = null } = {}) {
  if (!redis && !pgPool) return null;

  // Fast path: Redis totals (no category filter)
  if (!category && redis) {
    try {
      const raw = await redis.hgetall(KEY_TOTALS(userId));
      if (raw && Object.keys(raw).length > 0) {
        const totalEntries    = Number(raw.totalRealizedEntries || 0);
        const wins            = Number(raw.winCount || 0);
        const losses          = Number(raw.lossCount || 0);
        const grossTotal      = round2(Number(raw.grossProfitTotal || 0));
        const netRealized     = round2(Number(raw.netProfitRealizedTotal || 0));
        const netEstimated    = round2(Number(raw.netProfitEstimatedTotal || 0));

        return {
          userId,
          totalRealizedEntries: totalEntries,
          winCount:  wins,
          lossCount: losses,
          hitRate:   (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
          // Realized: actual confirmed P&L
          grossProfitRealized:   grossTotal,
          netProfitRealized:     netRealized    || null,
          // Estimated: includes fee estimation where actual fees not provided
          netProfitEstimated:    netEstimated   || null,
          // Note on data quality
          note: "netProfitRealized uses only entries where platform fees were confirmed. netProfitEstimated uses fee schedule estimates where actual fees were not provided.",
        };
      }
    } catch { /* fall through to Postgres */ }
  }

  // Postgres path (supports category filter, always authoritative)
  if (pgPool) {
    try {
      const params = [userId];
      let catClause = "";
      if (category) { params.push(sanitize(category)); catClause = "AND category = $2"; }

      const result = await pgPool.query(
        `SELECT
           COUNT(*)                                                    AS total_entries,
           COUNT(*) FILTER (WHERE net_profit_realized > 0 OR gross_profit > 0) AS win_count,
           COUNT(*) FILTER (WHERE net_profit_realized <= 0 OR gross_profit <= 0) AS loss_count,
           SUM(gross_profit)                                           AS gross_total,
           SUM(net_profit_realized)
             FILTER (WHERE net_profit_realized IS NOT NULL)            AS net_realized_total,
           SUM(net_profit_estimated)
             FILTER (WHERE net_profit_estimated IS NOT NULL
                       AND net_profit_realized IS NULL)                AS net_estimated_total
         FROM realized_profit_ledger
         WHERE user_id = $1 ${catClause}`,
        params
      );
      const r = result.rows[0];
      const wins   = Number(r?.win_count || 0);
      const losses = Number(r?.loss_count || 0);
      return {
        userId,
        category: category || null,
        totalRealizedEntries: Number(r?.total_entries || 0),
        winCount:  wins,
        lossCount: losses,
        hitRate:   (wins + losses) > 0 ? round2((wins / (wins + losses)) * 100) : null,
        grossProfitRealized:  r?.gross_total         != null ? round2(Number(r.gross_total))         : null,
        netProfitRealized:    r?.net_realized_total  != null ? round2(Number(r.net_realized_total))  : null,
        netProfitEstimated:   r?.net_estimated_total != null ? round2(Number(r.net_estimated_total)) : null,
        note: "netProfitRealized uses only entries where platform fees were confirmed. netProfitEstimated uses fee schedule estimates where actual fees were not provided.",
      };
    } catch { /* fall through */ }
  }

  return null;
}

// ── List recent realized entries ──────────────────────────────────────────────

export async function listRealizedProfitEntries(redis, userId, { limit = 20, since = null } = {}) {
  if (!redis || !userId) return [];
  try {
    const minScore = since ? Number(since) : 0;
    const ids = await redis.zrevrangebyscore(KEY_ENTRIES(userId), "+inf", minScore, "LIMIT", 0, limit);
    if (!ids?.length) return [];

    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_ENTRY(userId, id));
    const results = await pipe.exec();

    return results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_\- ]/g, "").trim().slice(0, 60);
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
