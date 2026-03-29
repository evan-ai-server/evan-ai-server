// src/calibrationReport.js
// Monthly Calibration Report — per-user accuracy accountability.
//
// Builds a structured monthly report covering:
//   - Scan volume and signal breakdown for the month
//   - Per-category win rates vs expected targets
//   - Top underperforming category/signal combos
//   - Wrong-call log (STRONG BUY → loss)
//   - Overall accuracy profile reference
//
// Redis keys:
//   calibration:report:{userId}:{month}    STRING  — cached report
//   wrong_call:{userId}                    ZSET    — wrong calls, score=ts
//
// This is accountability infrastructure, not a UI branding layer.

const CURRENT_REPORT_TTL  = 3 * 3600;        // 3h for current month (data changes)
const PAST_REPORT_TTL     = 7 * 24 * 3600;   // 7d for past months (stable)
const KEY_REPORT          = (uid, mo) => `calibration:report:${uid}:${mo}`;
const KEY_WRONG_CALLS     = (uid)     => `wrong_call:${uid}`;
const WRONG_CALL_MAX      = 50;
const WRONG_CALL_TTL      = 90 * 24 * 3600;  // 90d

// Expected win-rate targets per signal (used to identify under-performing combos)
const SIGNAL_TARGETS = { "STRONG BUY": 85, "GOOD DEAL": 70, "FAIR": 50 };

// ── Wrong-call admission ───────────────────────────────────────────────────────

/**
 * Record a confirmed wrong call (e.g., STRONG BUY → buyer lost money).
 * Called by POST /api/accuracy/wrong-call after a user reports a loss.
 *
 * gateSuspected: the likely gate that failed (e.g. "thin_market", "replica_risk",
 *                "low_identity", "price_volatility") — nullable
 */
export async function recordWrongCall(redis, userId, {
  scanId,
  signal       = "STRONG BUY",
  category     = null,
  gateSuspected = null,
  scannedAt    = null,
}) {
  if (!redis || !userId || !scanId) return false;

  const entry = JSON.stringify({
    scanId,
    signal,
    category,
    gateSuspected,
    scannedAt:  scannedAt || Date.now(),
    recordedAt: Date.now(),
  });

  const key = KEY_WRONG_CALLS(userId);
  await redis.zadd(key, Date.now(), entry);
  await redis.zremrangebyrank(key, 0, -(WRONG_CALL_MAX + 1)); // keep newest
  await redis.expire(key, WRONG_CALL_TTL);
  return true;
}

/**
 * Retrieve recent wrong calls for a user, newest first.
 */
export async function listWrongCalls(redis, userId, limit = 10) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.zrevrange(KEY_WRONG_CALLS(userId), 0, limit - 1);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Monthly report ─────────────────────────────────────────────────────────────

/**
 * Build a monthly calibration report for a user.
 *
 * @param {object}      redis
 * @param {object|null} pgPool
 * @param {string}      userId
 * @param {{ month?: string }} opts  — "YYYY-MM"; defaults to current month
 * @returns {object} report payload
 */
export async function buildMonthlyCalibrationReport(redis, pgPool, userId, { month } = {}) {
  const reportMonth = month || currentMonth();

  // ── Accuracy profile (all-time, per user) ────────────────────────────────
  let accuracyProfile = null;
  try {
    const { computeAccuracyProfile } = await import("./accuracyEngine.js");
    accuracyProfile = await computeAccuracyProfile(redis, userId);
  } catch { /* non-fatal */ }

  // ── Wrong calls this month ────────────────────────────────────────────────
  let wrongCalls = [];
  try {
    const all = await listWrongCalls(redis, userId, 50);
    wrongCalls = all.filter((wc) => {
      const ts = wc.recordedAt || wc.scannedAt || 0;
      return toMonthStr(new Date(ts)) === reportMonth;
    });
  } catch { /* non-fatal */ }

  // ── Scan volume + category breakdown (needs pgPool) ───────────────────────
  let scanVolume        = null;
  let signalBreakdown   = {};
  let categoryBreakdown = [];

  if (pgPool) {
    try {
      const [monthStart, monthEnd] = monthBounds(reportMonth);

      // Signal-level volume for the month
      const volRes = await pgPool.query(`
        SELECT signal_type, COUNT(*) AS cnt
        FROM outcome_solicitations
        WHERE user_id = $1
          AND solicitation_sent_at >= $2
          AND solicitation_sent_at <  $3
        GROUP BY signal_type
        ORDER BY cnt DESC
      `, [userId, monthStart, monthEnd]).catch(() => ({ rows: [] }));

      scanVolume = 0;
      for (const row of volRes.rows) {
        const n = Number(row.cnt);
        signalBreakdown[row.signal_type] = n;
        scanVolume += n;
      }

      // Per-category outcome breakdown (min 3 outcomes to appear)
      const catRes = await pgPool.query(`
        SELECT
          category,
          signal_type,
          COUNT(*)                                           AS total,
          SUM(CASE WHEN response = 'WIN'  THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN response = 'LOSS' THEN 1 ELSE 0 END) AS losses
        FROM outcome_solicitations
        WHERE user_id = $1
          AND category IS NOT NULL
          AND solicitation_sent_at >= $2
          AND solicitation_sent_at <  $3
        GROUP BY category, signal_type
        HAVING COUNT(*) >= 3
        ORDER BY total DESC
        LIMIT 20
      `, [userId, monthStart, monthEnd]).catch(() => ({ rows: [] }));

      categoryBreakdown = catRes.rows.map((row) => ({
        category:   row.category,
        signalType: row.signal_type,
        total:      Number(row.total),
        wins:       Number(row.wins),
        losses:     Number(row.losses),
        winRate:    Number(row.total) > 0
          ? Math.round((Number(row.wins) / Number(row.total)) * 100)
          : null,
      }));
    } catch { /* non-fatal */ }
  }

  // ── Top missed signals: categories where observed << expected ─────────────
  const topMissedSignals = categoryBreakdown
    .filter((c) => {
      const target = SIGNAL_TARGETS[c.signalType];
      return target && c.winRate !== null && c.winRate < target - 10 && c.total >= 5;
    })
    .sort((a, b) => {
      const aGap = (SIGNAL_TARGETS[a.signalType] || 70) - (a.winRate || 0);
      const bGap = (SIGNAL_TARGETS[b.signalType] || 70) - (b.winRate || 0);
      return bGap - aGap;
    })
    .slice(0, 3);

  return {
    ok:                   true,
    month:                reportMonth,
    userId,
    scanVolume,
    signalBreakdown,
    categoryBreakdown,
    topMissedSignals,
    wrongCallCount:       wrongCalls.length,
    wrongCalls:           wrongCalls.slice(0, 5),
    overallAccuracy:      accuracyProfile?.overallAccuracy      ?? null,
    calibrationConfidence: accuracyProfile?.calibrationConfidence ?? "ESTIMATED",
    reportingRate:        accuracyProfile?.reportingRate         ?? null,
    signalBreakdownLifetime: accuracyProfile?.signalBreakdown    ?? null,
    generatedAt:          Date.now(),
  };
}

// ── Cache helpers ──────────────────────────────────────────────────────────────

export async function getCachedCalibrationReport(redis, userId, month) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(KEY_REPORT(userId, month));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function cacheCalibrationReport(redis, userId, month, report) {
  if (!redis || !userId || !month) return;
  const ttl = month === currentMonth() ? CURRENT_REPORT_TTL : PAST_REPORT_TTL;
  await redis.set(KEY_REPORT(userId, month), JSON.stringify(report), "EX", ttl).catch(() => {});
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function currentMonth() {
  return toMonthStr(new Date());
}

function toMonthStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthBounds(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}
