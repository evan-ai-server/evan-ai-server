// src/calibrationAudit.js
// WS7 — Weekly cross-user calibration audit.
//
// Detects win-rate drift per category+signal across all users.
// Auto-suppresses failing categories by writing Redis keys checked
// at scan time via the in-memory suppression cache in index.js.
//
// Redis key schema:
//   calibration:suppress:{category}:{signal}  STRING "capped"  TTL 7 days
//   calibration:audit:last_run                STRING ISO timestamp

const KEY_SUPPRESS   = (cat, sig) => `calibration:suppress:${normalizeCat(cat)}:${sig}`;
const KEY_LAST_RUN   = () => "calibration:audit:last_run";
const SUPPRESS_TTL   = 7 * 86400;   // 7 days

// Expected win rates per signal (matches accuracyEngine SIGNAL_TARGETS)
const SIGNAL_EXPECTED = {
  "STRONG BUY": 0.80,
  "GOOD DEAL":  0.62,
};

// Status thresholds
const PASS_THRESHOLD = 0.95;  // win_rate >= expected * 0.95 → PASS
const WARN_THRESHOLD = 0.85;  // win_rate >= expected * 0.85 → WARN; else FAIL

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the weekly audit across all users.
 * Queries scan_outcomes joined with scan_sessions for last 30 days,
 * groups by category + signal_type, computes win rates, upserts audit rows,
 * and writes suppression keys for categories with >= 2 consecutive FAIL weeks.
 *
 * @param {object} redis   — Redis client
 * @param {object} pgPool  — Postgres pool (optional: skips DB writes if null)
 */
export async function runWeeklyAudit(redis, pgPool) {
  const weekStart = getWeekStart();

  // ── Pull outcomes grouped by category + signal ──────────────────────────
  let rows = [];
  if (pgPool) {
    try {
      const result = await pgPool.query(`
        SELECT
          ss.category,
          so.signal_shown                         AS signal_type,
          COUNT(*)                                AS total_outcomes,
          SUM(CASE WHEN so.is_win THEN 1 ELSE 0 END) AS win_count
        FROM scan_outcomes so
        JOIN scan_sessions ss ON ss.scan_id = so.scan_id
        WHERE so.reported_at > NOW() - INTERVAL '30 days'
          AND so.signal_shown IN ('STRONG BUY', 'GOOD DEAL')
          AND ss.category IS NOT NULL
          AND ss.category != ''
        GROUP BY ss.category, so.signal_shown
        HAVING COUNT(*) >= 5
        ORDER BY ss.category, so.signal_shown
      `);
      rows = result.rows;
    } catch (err) {
      console.error("[CalibrationAudit] DB query failed:", err?.message);
      return { ok: false, error: err?.message };
    }
  }

  const auditResults = [];

  for (const row of rows) {
    const category     = (row.category || "").toLowerCase().trim();
    const signalType   = row.signal_type;
    const totalOut     = Number(row.total_outcomes || 0);
    const winCount     = Number(row.win_count || 0);
    const winRate      = totalOut > 0 ? winCount / totalOut : 0;
    const expectedRate = SIGNAL_EXPECTED[signalType] ?? null;

    if (!expectedRate) continue;

    // Status
    const status = winRate >= expectedRate * PASS_THRESHOLD ? "PASS"
      : winRate >= expectedRate * WARN_THRESHOLD ? "WARN"
      : "FAIL";

    // Get previous weeks_failing count
    let weeksFailing = 0;
    if (pgPool && status === "FAIL") {
      try {
        const prev = await pgPool.query(`
          SELECT weeks_failing FROM calibration_audit
          WHERE category = $1 AND signal_type = $2
          ORDER BY week_start DESC LIMIT 1
        `, [category, signalType]);
        if (prev.rows.length) {
          const prevStatus = await pgPool.query(`
            SELECT status FROM calibration_audit
            WHERE category = $1 AND signal_type = $2
              AND week_start = $3::date - INTERVAL '7 days'
          `, [category, signalType, weekStart]);
          weeksFailing = prevStatus.rows[0]?.status === "FAIL"
            ? Number(prev.rows[0].weeks_failing || 0) + 1
            : 1;
        } else {
          weeksFailing = 1;
        }
      } catch { weeksFailing = 1; }
    }

    // Upsert audit row
    let actionTaken = null;
    if (pgPool) {
      try {
        await pgPool.query(`
          INSERT INTO calibration_audit (
            category, week_start, signal_type,
            total_outcomes, win_count, win_rate, expected_rate,
            status, weeks_failing, action_taken, created_at
          ) VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
          ON CONFLICT (category, week_start, signal_type) DO UPDATE SET
            total_outcomes = EXCLUDED.total_outcomes,
            win_count      = EXCLUDED.win_count,
            win_rate       = EXCLUDED.win_rate,
            status         = EXCLUDED.status,
            weeks_failing  = EXCLUDED.weeks_failing,
            action_taken   = EXCLUDED.action_taken
        `, [
          category, weekStart, signalType,
          totalOut, winCount,
          round4(winRate), round4(expectedRate),
          status, weeksFailing, actionTaken,
        ]);
      } catch (err) {
        console.error("[CalibrationAudit] upsert failed:", err?.message);
      }
    }

    // ── Auto-suppression: >= 2 consecutive FAIL weeks ──────────────────────
    if (status === "FAIL" && weeksFailing >= 2 && redis) {
      try {
        const suppressKey = KEY_SUPPRESS(category, signalType);
        await redis.set(suppressKey, "capped", "EX", SUPPRESS_TTL);
        actionTaken = `auto_suppressed:${new Date().toISOString()}`;
        // Update action_taken in DB
        if (pgPool) {
          await pgPool.query(`
            UPDATE calibration_audit
            SET action_taken = $1
            WHERE category = $2 AND week_start = $3::date AND signal_type = $4
          `, [actionTaken, category, weekStart, signalType]).catch(() => {});
        }
        console.log(`[CalibrationAudit] Suppressed ${category}:${signalType} (${weeksFailing} weeks failing, win_rate=${(winRate * 100).toFixed(1)}%)`);
      } catch (err) {
        console.error("[CalibrationAudit] suppression write failed:", err?.message);
      }
    } else if (status !== "FAIL" && redis) {
      // Clear suppression if category recovered
      try {
        const suppressKey = KEY_SUPPRESS(category, signalType);
        const existing = await redis.get(suppressKey);
        if (existing === "capped") {
          await redis.del(suppressKey);
          console.log(`[CalibrationAudit] Cleared suppression for ${category}:${signalType} (recovered, win_rate=${(winRate * 100).toFixed(1)}%)`);
        }
      } catch { /* non-fatal */ }
    }

    auditResults.push({
      category,
      signalType,
      winRate:       round4(winRate),
      expectedRate:  round4(expectedRate),
      totalOutcomes: totalOut,
      status,
      weeksFailing,
      autoSuppressed: status === "FAIL" && weeksFailing >= 2,
    });
  }

  // Mark last run
  if (redis) {
    await redis.set(KEY_LAST_RUN(), new Date().toISOString()).catch(() => {});
  }

  const alertCount = auditResults.filter(r => r.status !== "PASS").length;
  console.log(`[CalibrationAudit] Weekly audit complete: ${auditResults.length} category/signal rows, ${alertCount} alerts`);

  return {
    ok:          true,
    weekStart,
    rowsAudited: auditResults.length,
    alertCount,
    results:     auditResults,
  };
}

/**
 * Return all category/signal rows with non-PASS status from the most recent audit.
 */
export async function getCategoryAuditAlerts(pgPool) {
  if (!pgPool) return [];
  try {
    const result = await pgPool.query(`
      SELECT
        ca.category,
        ca.signal_type,
        ca.win_rate,
        ca.expected_rate,
        ca.status,
        ca.weeks_failing,
        ca.action_taken,
        ca.week_start,
        ca.total_outcomes
      FROM calibration_audit ca
      INNER JOIN (
        SELECT category, signal_type, MAX(week_start) AS latest
        FROM calibration_audit
        GROUP BY category, signal_type
      ) latest ON ca.category = latest.category
              AND ca.signal_type = latest.signal_type
              AND ca.week_start = latest.latest
      WHERE ca.status IN ('WARN', 'FAIL')
      ORDER BY ca.weeks_failing DESC, ca.win_rate ASC
    `);
    return result.rows;
  } catch {
    return [];
  }
}

/**
 * System-wide win rate across all categories and signal types (last 30 days).
 */
export async function getSystemWideWinRate(pgPool) {
  if (!pgPool) return null;
  try {
    const result = await pgPool.query(`
      SELECT
        COUNT(*)                                        AS total,
        SUM(CASE WHEN is_win THEN 1 ELSE 0 END)        AS wins,
        ROUND(AVG(CASE WHEN is_win THEN 1.0 ELSE 0 END) * 100, 2) AS win_rate_pct
      FROM scan_outcomes
      WHERE reported_at > NOW() - INTERVAL '30 days'
        AND is_win IS NOT NULL
    `);
    const row = result.rows[0];
    return {
      total:      Number(row?.total || 0),
      wins:       Number(row?.wins  || 0),
      winRatePct: Number(row?.win_rate_pct || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Check if a specific category+signal is suppressed (Redis lookup).
 */
export async function isCategorySuppressed(redis, category, signalType) {
  if (!redis || !category || !signalType) return false;
  try {
    const val = await redis.get(KEY_SUPPRESS(category, signalType));
    return val === "capped";
  } catch {
    return false;
  }
}

/**
 * Manually clear a suppression key (ops use).
 */
export async function unsuppressCategory(redis, pgPool, category, signalType) {
  if (!redis || !category || !signalType) return false;
  try {
    await redis.del(KEY_SUPPRESS(category, signalType));
    if (pgPool) {
      await pgPool.query(`
        UPDATE calibration_audit
        SET action_taken = $1
        WHERE category = $2 AND signal_type = $3
          AND week_start = (
            SELECT MAX(week_start) FROM calibration_audit
            WHERE category = $2 AND signal_type = $3
          )
      `, [`manual_unsuppressed:${new Date().toISOString()}`, normalizeCat(category), signalType]).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all current suppressed category+signal pairs from Redis.
 * Uses SCAN for safety (no KEYS *).
 */
export async function getAllSuppressions(redis) {
  if (!redis) return [];
  try {
    const results = [];
    let cursor = "0";
    do {
      const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "calibration:suppress:*", "COUNT", 100);
      cursor = nextCursor;
      for (const key of keys) {
        const val = await redis.get(key);
        if (val === "capped") {
          // key format: calibration:suppress:{category}:{signal}
          const parts = key.replace("calibration:suppress:", "").split(":");
          const signal = parts[parts.length - 1];
          const cat    = parts.slice(0, -1).join(":");
          const ttl    = await redis.ttl(key);
          results.push({ category: cat, signalType: signal, ttlSeconds: ttl });
        }
      }
    } while (cursor !== "0");
    return results;
  } catch {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(cat) {
  return String(cat || "general").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
}

function getWeekStart() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon
  const diff = (day + 6) % 7; // days since Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10); // YYYY-MM-DD
}

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}
