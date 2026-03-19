// src/dealLedger.js
// Deal Ledger: Redis-backed per-user P&L tracker.
// Every scan is logged. Running totals for savings, profits, scans, and
// streak. The daily habit engine — users open Evan to watch their score climb.

// ── Redis key schemas ─────────────────────────────────────────────────────────
// ledger:user:{userId}          HASH  — aggregate stats
// ledger:scans:{userId}         ZSET  — scan log (score = timestamp)
// ledger:streak:{userId}        HASH  — streak tracking { lastScanDate, currentStreak, longestStreak }
// ledger:leaderboard            ZSET  — global savings leaderboard

const KEY_LEDGER   = (userId) => `ledger:user:${userId}`;
const KEY_SCANS    = (userId) => `ledger:scans:${userId}`;
const KEY_STREAK   = (userId) => `ledger:streak:${userId}`;
const KEY_LEADERBOARD = "ledger:leaderboard";

const SCAN_LOG_TTL    = 60 * 60 * 24 * 90; // 90 days
const LEADERBOARD_TTL = 60 * 60 * 24 * 30; // 30 days

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Log a scan to the deal ledger.
 * Called every time a user completes a scan with a price result.
 */
export async function logScanToLedger(redis, userId = "", {
  itemId        = "",
  itemTitle     = "",
  category      = "",
  scannedPrice  = null,
  medianMarket  = null,
  dealVerdict   = "fair",
  netSavings    = null,   // positive = savings, negative = overpaid
  flipProfit    = null,   // if reselling, net profit
  brand         = "",
  model         = "",
} = {}) {
  if (!redis || !userId) return null;

  const now        = Date.now();
  const todayStr   = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const savings = finiteOrNull(netSavings)
    || (finiteOrNull(medianMarket) && finiteOrNull(scannedPrice)
        ? round2(finiteOrNull(medianMarket) - finiteOrNull(scannedPrice))
        : 0);

  const profit = finiteOrNull(flipProfit) || 0;

  const scanEntry = JSON.stringify({
    itemId, itemTitle, category, brand, model,
    scannedPrice: finiteOrNull(scannedPrice),
    medianMarket: finiteOrNull(medianMarket),
    dealVerdict,
    savings: round2(savings),
    flipProfit: round2(profit),
    ts: now,
    date: todayStr,
  });

  const pipeline = redis.pipeline();

  // Log to scan ZSET (score = timestamp)
  pipeline.zadd(KEY_SCANS(userId), now, scanEntry);
  pipeline.expire(KEY_SCANS(userId), SCAN_LOG_TTL);

  // Increment aggregate stats
  pipeline.hincrbyfloat(KEY_LEDGER(userId), "totalScans", 1);
  if (savings > 0) {
    pipeline.hincrbyfloat(KEY_LEDGER(userId), "totalSaved",  savings);
    pipeline.hincrbyfloat(KEY_LEDGER(userId), "dealCount",   1);
  }
  if (profit > 0) {
    pipeline.hincrbyfloat(KEY_LEDGER(userId), "totalProfit", profit);
    pipeline.hincrbyfloat(KEY_LEDGER(userId), "flipCount",   1);
  }
  if (dealVerdict === "steal" || dealVerdict === "good") {
    pipeline.hincrbyfloat(KEY_LEDGER(userId), "stealsFound", 1);
  }

  // Update leaderboard
  if (savings > 0) {
    pipeline.zincrby(KEY_LEADERBOARD, savings, userId);
    pipeline.expire(KEY_LEADERBOARD, LEADERBOARD_TTL);
  }

  await pipeline.exec();

  // Update streak separately (needs read-modify-write)
  await updateStreak(redis, userId, todayStr);

  return { logged: true, savings: round2(savings), profit: round2(profit) };
}

/**
 * Update the user's scan streak.
 */
async function updateStreak(redis, userId, todayStr) {
  const streakData = await redis.hgetall(KEY_STREAK(userId));
  const lastDate   = streakData?.lastScanDate || null;
  const current    = parseInt(streakData?.currentStreak || "0", 10);
  const longest    = parseInt(streakData?.longestStreak || "0", 10);

  let newStreak = 1;
  if (lastDate) {
    const last     = new Date(lastDate);
    const today    = new Date(todayStr);
    const diffDays = Math.round((today - last) / (1000 * 60 * 60 * 24));
    newStreak = diffDays === 1 ? current + 1 : diffDays === 0 ? current : 1;
  }

  const newLongest = Math.max(longest, newStreak);
  await redis.hmset(KEY_STREAK(userId), {
    lastScanDate:   todayStr,
    currentStreak:  newStreak,
    longestStreak:  newLongest,
  });

  return { currentStreak: newStreak, longestStreak: newLongest };
}

/**
 * Fetch a user's full ledger summary.
 */
export async function getLedgerSummary(redis, userId = "") {
  if (!redis || !userId) return null;

  const [stats, streak] = await Promise.all([
    redis.hgetall(KEY_LEDGER(userId)),
    redis.hgetall(KEY_STREAK(userId)),
  ]);

  const totalScans   = parseFloat(stats?.totalScans  || 0);
  const totalSaved   = parseFloat(stats?.totalSaved  || 0);
  const totalProfit  = parseFloat(stats?.totalProfit || 0);
  const dealCount    = parseFloat(stats?.dealCount   || 0);
  const flipCount    = parseFloat(stats?.flipCount   || 0);
  const stealsFound  = parseFloat(stats?.stealsFound || 0);

  const avgSavingsPct = totalScans > 0 && totalSaved > 0
    ? round2((totalSaved / totalScans / 50) * 100) // rough: $50 median scan value
    : 0;

  const currentStreak = parseInt(streak?.currentStreak || 0, 10);
  const longestStreak = parseInt(streak?.longestStreak || 0, 10);

  return {
    totalScans:    Math.round(totalScans),
    totalSaved:    round2(totalSaved),
    totalProfit:   round2(totalProfit),
    totalValue:    round2(totalSaved + totalProfit),
    dealCount:     Math.round(dealCount),
    flipCount:     Math.round(flipCount),
    stealsFound:   Math.round(stealsFound),
    avgSavingsPct,
    streak: {
      current:  currentStreak,
      longest:  longestStreak,
      isActive: currentStreak > 0,
    },
    topSignal: totalValue(totalSaved, totalProfit) > 0
      ? `$${round2(totalSaved + totalProfit).toFixed(2)} total value found across ${Math.round(totalScans)} scans — ${currentStreak} day streak`
      : `${Math.round(totalScans)} scans logged — start finding deals to build your ledger`,
  };
}

function totalValue(saved, profit) { return saved + profit; }

/**
 * Fetch a user's recent scan history.
 */
export async function getRecentScans(redis, userId = "", limit = 20) {
  if (!redis || !userId) return [];
  const raw = await redis.zrevrange(KEY_SCANS(userId), 0, limit - 1);
  return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

/**
 * Fetch global leaderboard (top N savers).
 */
export async function getLeaderboard(redis, limit = 10) {
  if (!redis) return [];
  const raw = await redis.zrevrange(KEY_LEADERBOARD, 0, limit - 1, "WITHSCORES");
  const result = [];
  for (let i = 0; i < raw.length; i += 2) {
    result.push({ userId: raw[i], totalSaved: round2(parseFloat(raw[i + 1])) });
  }
  return result;
}

/**
 * Master deal ledger payload (for a scan response — auto-log + return summary).
 */
export async function buildDealLedgerPayload(redis, userId = "", scanData = {}) {
  if (!redis || !userId) return null;

  await logScanToLedger(redis, userId, scanData);
  const summary = await getLedgerSummary(redis, userId);

  return {
    summary,
    justLogged: true,
    topSignal:  summary?.topSignal || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
