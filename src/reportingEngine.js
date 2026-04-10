// src/reportingEngine.js
// Phase 10 — P&L Reporting Engine.
//
// ── MISSION CONTROL: Transaction Ledger Aggregation ─────────────────────────
//
// This engine treats the Transaction Ledger (transactionLedger.js) as the
// authoritative source of truth for all financial reporting. It aggregates
// immutable LedgerEntry records into structured snapshots suitable for:
//   - User-facing P&L dashboards
//   - Category-level performance attribution
//   - Platform routing intelligence
//   - Automated pricing model telemetry
//   - Time-series financial history (daily / monthly)
//
// Design principles:
//   - All aggregates are derived from ledger entries — never from mutable fields
//   - Sparse data is acknowledged, not fabricated
//   - Snapshots are cached with short TTLs; the ledger is always authoritative
//   - Every snapshot includes `dataQuality` metadata so consumers know confidence
//   - Reports are "reusable" — structured for downstream pricing model ingestion
//
// Redis key layout:
//   p10:rpt:daily:{userId}:{YYYY-MM-DD}    STRING  daily snapshot (24h TTL)
//   p10:rpt:monthly:{userId}:{YYYY-MM}     STRING  monthly snapshot (7d TTL)
//   p10:rpt:category:{userId}              STRING  category summary (1h TTL)
//   p10:rpt:platform:{userId}              STRING  platform routing summary (1h TTL)
//   p10:rpt:telemetry:{userId}             STRING  pricing model telemetry export (6h TTL)
//   p10:rpt:ops                            HASH    aggregate counters

import { getUserLedger, getLedgerBalance, TXN_TYPE, TXN_DIRECTION } from "./transactionLedger.js";
import { getInventoryMetrics, getTimePeriodMetrics }                  from "./inventoryEngine.js";
import { getRealizedProfitSummary, listRealizedProfitEntries }        from "./profitLedger.js";
import { getListingMetrics }                                           from "./listingRecordModel.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const TTL_DAILY     = 24 * 3600;
const TTL_MONTHLY   = 7  * 86400;
const TTL_CATEGORY  = 3600;
const TTL_PLATFORM  = 3600;
const TTL_TELEMETRY = 6  * 3600;

const KEY_DAILY     = (uid, d)  => `p10:rpt:daily:${uid}:${d}`;
const KEY_MONTHLY   = (uid, m)  => `p10:rpt:monthly:${uid}:${m}`;
const KEY_CATEGORY  = (uid)     => `p10:rpt:category:${uid}`;
const KEY_PLATFORM  = (uid)     => `p10:rpt:platform:${uid}`;
const KEY_TELEMETRY = (uid)     => `p10:rpt:telemetry:${uid}`;
const KEY_OPS       = ()        => `p10:rpt:ops`;

export const REPORT_VERSION = "10.0";

// ── Daily Snapshot ─────────────────────────────────────────────────────────────

/**
 * Build or retrieve a daily P&L snapshot for a user.
 * Aggregates all ledger entries for the given calendar day (UTC).
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string} [dateStr]  — "YYYY-MM-DD" UTC; defaults to today
 * @param {boolean} [forceRefresh]
 * @returns {DailySnapshot}
 */
export async function getDailySnapshot(redis, userId, { dateStr = null, forceRefresh = false } = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };

  const day = dateStr || _todayStr();

  if (!forceRefresh) {
    try {
      const cached = await redis.get(KEY_DAILY(userId, day));
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip */ }
  }

  // Window: midnight-to-midnight UTC for the given day
  const dayStart = new Date(`${day}T00:00:00Z`).getTime();
  const dayEnd   = new Date(`${day}T23:59:59.999Z`).getTime();

  const entries = await getUserLedger(redis, userId, {
    limit: 10_000,
    since: dayStart,
  });

  // Filter to this exact day
  const dayEntries = entries.filter(e => e.recordedAt >= dayStart && e.recordedAt <= dayEnd);

  const agg = _aggregateEntries(dayEntries);

  const snapshot = {
    ok:            true,
    reportVersion: REPORT_VERSION,
    userId,
    date:          day,
    period:        "daily",
    ...agg,
    dataQuality:   _dataQuality(dayEntries.length),
    generatedAt:   Date.now(),
  };

  try {
    await redis.set(KEY_DAILY(userId, day), JSON.stringify(snapshot), "EX", TTL_DAILY);
    await redis.hincrby(KEY_OPS(), "daily_built", 1);
  } catch { /* non-critical */ }

  return snapshot;
}

// ── Monthly Snapshot ──────────────────────────────────────────────────────────

/**
 * Build or retrieve a monthly P&L snapshot.
 *
 * @param {string} [monthStr]  — "YYYY-MM"; defaults to current month
 */
export async function getMonthlySnapshot(redis, userId, { monthStr = null, forceRefresh = false } = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };

  const month = monthStr || _thisMonthStr();

  if (!forceRefresh) {
    try {
      const cached = await redis.get(KEY_MONTHLY(userId, month));
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip */ }
  }

  const [year, mo] = month.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, mo - 1, 1)).getTime();
  const monthEnd   = new Date(Date.UTC(year, mo, 0, 23, 59, 59, 999)).getTime();

  const entries = await getUserLedger(redis, userId, { limit: 50_000, since: monthStart });
  const monthEntries = entries.filter(e => e.recordedAt >= monthStart && e.recordedAt <= monthEnd);

  // Build daily breakdown within the month
  const dailyMap = new Map();
  for (const e of monthEntries) {
    const d = _dateStr(e.recordedAt);
    if (!dailyMap.has(d)) dailyMap.set(d, []);
    dailyMap.get(d).push(e);
  }
  const dailyBreakdown = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, es]) => ({
      date,
      ..._aggregateEntries(es),
    }));

  const agg = _aggregateEntries(monthEntries);

  const snapshot = {
    ok:            true,
    reportVersion: REPORT_VERSION,
    userId,
    month,
    period:        "monthly",
    ...agg,
    dailyBreakdown,
    dataQuality:   _dataQuality(monthEntries.length),
    generatedAt:   Date.now(),
  };

  try {
    await redis.set(KEY_MONTHLY(userId, month), JSON.stringify(snapshot), "EX", TTL_MONTHLY);
    await redis.hincrby(KEY_OPS(), "monthly_built", 1);
  } catch { /* non-critical */ }

  return snapshot;
}

// ── Category Performance Snapshot ────────────────────────────────────────────

/**
 * Build a category-level performance summary.
 * Combines ledger entries + inventory metrics for holistic attribution.
 *
 * The category breakdown is critical for pricing model telemetry — it shows
 * which categories are producing the best ROI so the scan signal can be
 * calibrated against realized outcomes.
 */
export async function getCategorySnapshot(redis, pgPool, userId, { forceRefresh = false } = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };

  if (!forceRefresh) {
    try {
      const cached = await redis.get(KEY_CATEGORY(userId));
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip */ }
  }

  const [invMetrics, profitSummary, entries] = await Promise.all([
    getInventoryMetrics(redis, userId),
    getRealizedProfitSummary(redis, pgPool, userId),
    getUserLedger(redis, userId, { limit: 50_000 }),
  ]);

  // Build per-category aggregates from inventory (authoritative for category data)
  const catData = {};
  for (const c of (invMetrics.categoryBreakdown || [])) {
    catData[c.category] = {
      category:         c.category,
      itemsAcquired:    c.count,
      activeItems:      c.active,
      soldItems:        c.sold,
      totalSpent:       c.spent,
      totalRevenue:     c.revenue,
      grossProfit:      c.profit,
      roi:              c.spent > 0 ? r2(((c.revenue - c.spent) / c.spent) * 100) : null,
      winRate:          c.sold > 0 ? null : null,  // enriched below from profitLedger
      // Pricing telemetry fields (reusable by pricing models)
      avgAcquisitionCost: c.count > 0 ? r2(c.spent / c.count) : null,
      avgSalePrice:       c.sold  > 0 ? r2(c.revenue / c.sold) : null,
      avgGrossMargin:     c.revenue > 0 ? r2(((c.revenue - c.spent) / c.revenue) * 100) : null,
      dataPoints:       c.count,
    };
  }

  // Enrich with realized profit data from profitLedger where available
  const ledgerEntries = await listRealizedProfitEntries(redis, userId, { limit: 5000 });
  const catProfit = {};
  for (const e of ledgerEntries) {
    const cat = e.category || "unknown";
    if (!catProfit[cat]) catProfit[cat] = { wins: 0, losses: 0, netSum: 0, count: 0, daysSum: 0, daysCount: 0 };
    const p = catProfit[cat];
    p.count++;
    if (e.isWin === true)  p.wins++;
    if (e.isWin === false) p.losses++;
    const net = e.netProfitRealized ?? e.netProfitEstimated ?? e.grossProfit ?? 0;
    p.netSum += net;
    if (e.daysToSell != null) { p.daysSum += e.daysToSell; p.daysCount++; }
  }

  for (const [cat, p] of Object.entries(catProfit)) {
    if (!catData[cat]) catData[cat] = { category: cat, itemsAcquired: 0, soldItems: 0, dataPoints: 0 };
    catData[cat].winRate         = p.count > 0 ? r2((p.wins / p.count) * 100) : null;
    catData[cat].avgNetProfit    = p.count > 0 ? r2(p.netSum / p.count) : null;
    catData[cat].avgDaysToSell   = p.daysCount > 0 ? r2(p.daysSum / p.daysCount) : null;
    catData[cat].realizedEntries = p.count;
  }

  const categories = Object.values(catData)
    .sort((a, b) => (b.grossProfit || 0) - (a.grossProfit || 0));

  const snapshot = {
    ok:            true,
    reportVersion: REPORT_VERSION,
    userId,
    period:        "all_time",
    categories,
    summary: {
      totalCategories: categories.length,
      topCategory:     categories[0]?.category || null,
      worstCategory:   categories.slice(-1)[0]?.category || null,
      overallWinRate:  profitSummary?.hitRate || null,
    },
    dataQuality:  _dataQuality(categories.reduce((s, c) => s + (c.dataPoints || 0), 0)),
    generatedAt:  Date.now(),
  };

  try {
    await redis.set(KEY_CATEGORY(userId), JSON.stringify(snapshot), "EX", TTL_CATEGORY);
    await redis.hincrby(KEY_OPS(), "category_built", 1);
  } catch { /* non-critical */ }

  return snapshot;
}

// ── Platform Routing Intelligence ─────────────────────────────────────────────

/**
 * Build a platform-level routing intelligence report.
 * Answers: "Where should I sell this item?"
 *
 * Aggregates realized outcomes per marketplace to produce:
 *   - Average realized margin per platform
 *   - Average sell-through time
 *   - Average effective fee rate
 *   - Refund / dispute rates
 */
export async function getPlatformSnapshot(redis, userId, { forceRefresh = false } = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };

  if (!forceRefresh) {
    try {
      const cached = await redis.get(KEY_PLATFORM(userId));
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip */ }
  }

  const [invMetrics, listingMetrics, ledgerEntries] = await Promise.all([
    getInventoryMetrics(redis, userId),
    getListingMetrics(redis, userId),
    listRealizedProfitEntries(redis, userId, { limit: 5000 }),
  ]);

  // Platform data from inventory (sold platform field)
  const platData = {};
  for (const p of (invMetrics.platformBreakdown || [])) {
    platData[p.platform] = {
      platform:       p.platform,
      soldItems:      p.sold,
      totalRevenue:   p.revenue,
      totalProfit:    p.profit,
      // Enriched from ledger entries below
      avgDaysToSell:  null,
      avgFeeRate:     null,
      wins:           0,
      losses:         0,
      winRate:        null,
      dataPoints:     p.sold,
    };
  }

  // Enrich from realized profit ledger
  const platProfit = {};
  for (const e of ledgerEntries) {
    const plat = e.sellPlatform || "unknown";
    if (!platProfit[plat]) platProfit[plat] = {
      wins: 0, losses: 0, daysSum: 0, daysCount: 0,
      feeSum: 0, feeCount: 0, revenueSum: 0,
    };
    const p = platProfit[plat];
    if (e.isWin === true)  p.wins++;
    if (e.isWin === false) p.losses++;
    if (e.daysToSell != null) { p.daysSum += e.daysToSell; p.daysCount++; }
    if (e.platformFeeRealized != null && e.sellPriceRealized > 0) {
      p.feeSum     += (e.platformFeeRealized / e.sellPriceRealized) * 100;
      p.feeCount++;
    }
    p.revenueSum += e.sellPriceRealized || 0;
  }

  for (const [plat, p] of Object.entries(platProfit)) {
    if (!platData[plat]) platData[plat] = { platform: plat, soldItems: 0, totalRevenue: 0, totalProfit: 0, dataPoints: 0 };
    platData[plat].wins         = p.wins;
    platData[plat].losses       = p.losses;
    platData[plat].winRate      = (p.wins + p.losses) > 0
      ? r2((p.wins / (p.wins + p.losses)) * 100) : null;
    platData[plat].avgDaysToSell = p.daysCount > 0 ? r2(p.daysSum / p.daysCount) : null;
    platData[plat].avgFeeRate    = p.feeCount  > 0 ? r2(p.feeSum  / p.feeCount)  : null;
  }

  // Add listing metrics (sell-through per marketplace)
  for (const m of (listingMetrics.marketplaceBreakdown || [])) {
    const plat = m.marketplace;
    if (!platData[plat]) platData[plat] = {
      platform: plat, soldItems: 0, totalRevenue: 0, totalProfit: 0, dataPoints: 0,
      wins: 0, losses: 0, winRate: null, avgDaysToSell: null,
    };
    platData[plat].avgFeeRate    = platData[plat].avgFeeRate ?? m.avgFeeRate;
    platData[plat].listingsSold  = m.sold;
    platData[plat].netProceeds   = m.netProceeds;
  }

  const platforms = Object.values(platData)
    .sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

  const snapshot = {
    ok:            true,
    reportVersion: REPORT_VERSION,
    userId,
    platforms,
    routing: {
      bestByWinRate:    platforms.find(p => p.winRate != null)?.platform || null,
      fastestSell:      [...platforms].sort((a, b) =>
        (a.avgDaysToSell ?? 999) - (b.avgDaysToSell ?? 999))[0]?.platform || null,
      lowestFees:       [...platforms].sort((a, b) =>
        (a.avgFeeRate ?? 999) - (b.avgFeeRate ?? 999))[0]?.platform || null,
    },
    dataQuality:  _dataQuality(platforms.reduce((s, p) => s + (p.dataPoints || 0), 0)),
    generatedAt:  Date.now(),
  };

  try {
    await redis.set(KEY_PLATFORM(userId), JSON.stringify(snapshot), "EX", TTL_PLATFORM);
    await redis.hincrby(KEY_OPS(), "platform_built", 1);
  } catch { /* non-critical */ }

  return snapshot;
}

// ── Telemetry Export ──────────────────────────────────────────────────────────

/**
 * Build a structured telemetry export for pricing model ingestion.
 *
 * This is the "reusable data" layer. The output is:
 *   - Machine-readable, schema-versioned
 *   - Sanitized (no raw personal identifiers beyond userId)
 *   - Structured for direct ingestion into pricing feedback loops
 *   - Includes signal accuracy metadata (expected vs realized)
 *
 * The telemetry export is what makes the ledger "compound value over time":
 * each sale outcome feeds back into the system's pricing intelligence.
 */
export async function getTelemetryExport(redis, pgPool, userId, { forceRefresh = false } = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };

  if (!forceRefresh) {
    try {
      const cached = await redis.get(KEY_TELEMETRY(userId));
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip */ }
  }

  const [
    balance,
    timePeriod,
    ledgerEntries,
    profitSummary,
  ] = await Promise.all([
    getLedgerBalance(redis, userId),
    getTimePeriodMetrics(redis, userId),
    listRealizedProfitEntries(redis, userId, { limit: 5000 }),
    getRealizedProfitSummary(redis, pgPool, userId),
  ]);

  // Signal accuracy: compare Evan's signal at buy time vs actual outcome
  const signalPerf = {};
  for (const e of ledgerEntries) {
    const sig = e.signalAtBuy || "UNKNOWN";
    if (!signalPerf[sig]) signalPerf[sig] = { wins: 0, losses: 0, profitSum: 0, count: 0 };
    const p = signalPerf[sig];
    p.count++;
    if (e.isWin === true)  p.wins++;
    if (e.isWin === false) p.losses++;
    p.profitSum += (e.netProfitRealized ?? e.netProfitEstimated ?? e.grossProfit ?? 0);
  }

  const signalAccuracy = Object.entries(signalPerf).map(([signal, p]) => ({
    signal,
    outcomes:      p.count,
    wins:          p.wins,
    losses:        p.losses,
    winRate:       p.count > 0 ? r2((p.wins / p.count) * 100) : null,
    avgNetProfit:  p.count > 0 ? r2(p.profitSum / p.count)  : null,
    // Calibration flag: if Evan said STRONG BUY and win rate < 50%, signal needs re-calibration
    needsCalibration: (signal === "STRONG BUY" || signal === "GOOD DEAL") &&
                      p.count >= 5 && (p.wins / p.count) < 0.5,
  })).sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

  const telemetry = {
    ok:            true,
    reportVersion: REPORT_VERSION,
    schemaVersion: "10.0",
    userId,
    exportedAt:    Date.now(),

    // Ledger health
    ledger: {
      balance:         balance.balance,
      totalCredits:    balance.totalCredits,
      totalDebits:     balance.totalDebits,
      entryCount:      balance.entryCount,
      adjustmentCount: balance.adjustmentCount,
    },

    // Realized outcomes summary
    realizedOutcomes: {
      totalEntries:        profitSummary?.totalRealizedEntries  || 0,
      winCount:            profitSummary?.winCount              || 0,
      lossCount:           profitSummary?.lossCount             || 0,
      hitRate:             profitSummary?.hitRate               || null,
      grossProfitRealized: profitSummary?.grossProfitRealized   || 0,
      netProfitRealized:   profitSummary?.netProfitRealized     || null,
    },

    // Time-period P&L for trend analysis
    timePeriodPnL: {
      last7d:  _timePeriodSummary(timePeriod.last7d),
      last30d: _timePeriodSummary(timePeriod.last30d),
      last90d: _timePeriodSummary(timePeriod.last90d),
      allTime: _timePeriodSummary(timePeriod.allTime),
    },

    // Signal accuracy (pricing model feedback)
    signalAccuracy,
    signalCalibrationNeeded: signalAccuracy.filter(s => s.needsCalibration).map(s => s.signal),

    dataQuality:  _dataQuality(ledgerEntries.length),
  };

  try {
    await redis.set(KEY_TELEMETRY(userId), JSON.stringify(telemetry), "EX", TTL_TELEMETRY);
    await redis.hincrby(KEY_OPS(), "telemetry_built", 1);
  } catch { /* non-critical */ }

  return telemetry;
}

// ── Full Report (all sections combined) ───────────────────────────────────────

/**
 * Build the complete Phase 10 financial report for a user.
 * Combines all snapshot types into one payload for dashboard rendering.
 */
export async function buildFullReport(redis, pgPool, userId, { forceRefresh = false } = {}) {
  if (!redis || !userId) return { ok: false, error: "missing_required" };

  const [daily, monthly, category, platform, telemetry] = await Promise.all([
    getDailySnapshot(redis, userId, { forceRefresh }),
    getMonthlySnapshot(redis, userId, { forceRefresh }),
    getCategorySnapshot(redis, pgPool, userId, { forceRefresh }),
    getPlatformSnapshot(redis, userId, { forceRefresh }),
    getTelemetryExport(redis, pgPool, userId, { forceRefresh }),
  ]);

  return {
    ok:            true,
    reportVersion: REPORT_VERSION,
    userId,
    generatedAt:   Date.now(),
    daily,
    monthly,
    category,
    platform,
    telemetry,
  };
}

// ── Ops ───────────────────────────────────────────────────────────────────────

export async function getReportingOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      dailyBuilt:     ops["daily_built"]     || 0,
      monthlyBuilt:   ops["monthly_built"]   || 0,
      categoryBuilt:  ops["category_built"]  || 0,
      platformBuilt:  ops["platform_built"]  || 0,
      telemetryBuilt: ops["telemetry_built"] || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Aggregate an array of LedgerEntry records into a structured summary.
 */
function _aggregateEntries(entries) {
  let totalCredits = 0, totalDebits = 0;
  let purchases = 0, sales = 0, fees = 0, shipping = 0, refundsOut = 0, refundsIn = 0, adjustments = 0;
  const typeAmounts = {};

  for (const e of entries) {
    const amt = e.amount || 0;
    if (e.direction === TXN_DIRECTION.CREDIT) totalCredits += amt;
    else                                      totalDebits  += amt;

    switch (e.type) {
      case TXN_TYPE.PURCHASE:           purchases   += amt; break;
      case TXN_TYPE.SALE:               sales       += amt; break;
      case TXN_TYPE.FEE:                fees        += amt; break;
      case TXN_TYPE.SHIPPING_COST:      shipping    += amt; break;
      case TXN_TYPE.REFUND_OUT:         refundsOut  += amt; break;
      case TXN_TYPE.REFUND_IN:          refundsIn   += amt; break;
      case TXN_TYPE.ADJUSTMENT:         adjustments += amt; break;
    }
  }

  const netCash    = r2(totalCredits - totalDebits);
  const grossProfit = r2(sales - purchases);

  return {
    entryCount:    entries.length,
    netCash,
    totalCredits:  r2(totalCredits),
    totalDebits:   r2(totalDebits),
    grossProfit,
    breakdown: {
      purchases:   r2(purchases),
      sales:       r2(sales),
      fees:        r2(fees),
      shipping:    r2(shipping),
      refundsOut:  r2(refundsOut),
      refundsIn:   r2(refundsIn),
      adjustments: r2(adjustments),
    },
  };
}

function _timePeriodSummary(m) {
  if (!m) return null;
  return {
    totalItems:    m.totalItems,
    sold:          m.totalSold,
    totalSpent:    m.totalSpent,
    totalRevenue:  m.totalRevenue,
    totalProfit:   m.totalProfit,
    winRate:       m.winRate,
    roi:           m.roi,
  };
}

function _dataQuality(entryCount) {
  if (entryCount === 0) return { level: "EMPTY",    confidence: 0,  note: "No data recorded yet" };
  if (entryCount < 5)  return { level: "SPARSE",   confidence: 0.3, note: "Very few data points — results directional only" };
  if (entryCount < 20) return { level: "LIMITED",  confidence: 0.6, note: "Limited data — growing" };
  if (entryCount < 50) return { level: "MODERATE", confidence: 0.8, note: "Moderate data quality" };
  return                      { level: "GOOD",     confidence: 1.0, note: "Sufficient data for confident reporting" };
}

function _todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function _thisMonthStr() {
  return new Date().toISOString().slice(0, 7);
}

function _dateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
