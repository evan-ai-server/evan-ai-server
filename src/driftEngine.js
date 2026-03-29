// src/driftEngine.js
// Phase 11 — Self-Improving System: Drift Detection.
//
// Compares recent win-rate / time-to-sell windows against established baselines
// to detect systematic performance decay before it silently accumulates.
//
// Drift types:
//   CATEGORY_WIN_RATE — win rate falling in a specific category+signal
//   SIGNAL_WIN_RATE   — global signal win rate falling (cross-category)
//   TIME_TO_SELL      — items taking materially longer to sell than baseline
//   FALSE_POSITIVE_SPIKE — bad-call rate spiking in a specific bin
//
// Severity levels (based on % drop from baseline):
//   WATCH  — 10–20% below baseline (monitor)
//   WARN   — 20–30% below baseline (investigate, may suggest threshold tighten)
//   ALERT  — 30%+  below baseline  (auto-suppression candidate or proposal trigger)
//
// Redis key schema:
//   drift:baseline:{category}:{signal}   HASH   { winRate, sampleSize, windowDays, establishedAt }
//   drift:tts_baseline:{category}        HASH   { medianDays, sampleSize, establishedAt }
//   drift:snapshot                       STRING  JSON of last full drift scan result
//   drift:last_scan                      STRING  ISO timestamp
//
// Baselines are re-established when: sampleSize grows 2× or baseline is >90d old.

const KEY_BASELINE     = (cat, sig)  => `drift:baseline:${normalizeCat(cat)}:${sig.replace(/\s+/g, "_")}`;
const KEY_TTS_BASELINE = (cat)       => `drift:tts_baseline:${normalizeCat(cat)}`;
const KEY_SNAPSHOT     = ()          => "drift:snapshot";
const KEY_LAST_SCAN    = ()          => "drift:last_scan";

const BASELINE_REESTABLISH_DAYS   = 90;   // re-baseline after 90 days
const BASELINE_GROWTH_FACTOR      = 2.0;  // re-baseline if sample grows 2×
const BASELINE_MIN_SAMPLES        = 10;   // minimum outcomes to establish a baseline
const DRIFT_WINDOW_DAYS           = 14;   // recent window for comparison
const DRIFT_WATCH_THRESHOLD       = 0.10; // 10% below baseline
const DRIFT_WARN_THRESHOLD        = 0.20; // 20% below baseline
const DRIFT_ALERT_THRESHOLD       = 0.30; // 30% below baseline
const TTS_DRIFT_WATCH_THRESHOLD   = 0.20; // 20% longer than baseline
const TTS_DRIFT_WARN_THRESHOLD    = 0.40; // 40% longer
const TTS_DRIFT_ALERT_THRESHOLD   = 0.65; // 65% longer
const SNAPSHOT_TTL                = 25 * 3600; // 25h (daily scan)

// ── Baseline management ───────────────────────────────────────────────────────

/**
 * Load the established win-rate baseline for a category+signal pair.
 */
export async function loadCategoryBaseline(redis, category, signal) {
  if (!redis || !category || !signal) return null;
  try {
    const data = await redis.hgetall(KEY_BASELINE(category, signal));
    if (!data?.winRate) return null;
    return {
      winRate:       Number(data.winRate),
      sampleSize:    Number(data.sampleSize || 0),
      windowDays:    Number(data.windowDays || 60),
      establishedAt: Number(data.establishedAt || 0),
    };
  } catch { return null; }
}

/**
 * Store a new baseline for a category+signal pair.
 * Called when baseline doesn't exist or needs re-establishment.
 */
export async function storeCategoryBaseline(redis, category, signal, { winRate, sampleSize, windowDays = 60 }) {
  if (!redis || !category || !signal) return;
  const data = {
    winRate:       String(round4(winRate)),
    sampleSize:    String(sampleSize),
    windowDays:    String(windowDays),
    establishedAt: String(Date.now()),
  };
  await redis.hmset(KEY_BASELINE(category, signal), data);
  await redis.expire(KEY_BASELINE(category, signal), 180 * 86400); // 180d max
}

/**
 * Load the TTS (time-to-sell) baseline for a category.
 */
export async function loadTTSBaseline(redis, category) {
  if (!redis || !category) return null;
  try {
    const data = await redis.hgetall(KEY_TTS_BASELINE(category));
    if (!data?.medianDays) return null;
    return {
      medianDays:    Number(data.medianDays),
      sampleSize:    Number(data.sampleSize || 0),
      establishedAt: Number(data.establishedAt || 0),
    };
  } catch { return null; }
}

export async function storeTTSBaseline(redis, category, { medianDays, sampleSize }) {
  if (!redis || !category) return;
  await redis.hmset(KEY_TTS_BASELINE(category), {
    medianDays:    String(round2(medianDays)),
    sampleSize:    String(sampleSize),
    establishedAt: String(Date.now()),
  });
  await redis.expire(KEY_TTS_BASELINE(category), 180 * 86400);
}

// ── Drift computation ─────────────────────────────────────────────────────────

/**
 * Classify a drift gap into a severity level.
 * gap = (baseline - current) / baseline (positive = current is worse)
 */
export function classifyDriftSeverity(gap) {
  if (gap >= DRIFT_ALERT_THRESHOLD)  return "ALERT";
  if (gap >= DRIFT_WARN_THRESHOLD)   return "WARN";
  if (gap >= DRIFT_WATCH_THRESHOLD)  return "WATCH";
  return "OK";
}

export function classifyTTSSeverity(gap) {
  if (gap >= TTS_DRIFT_ALERT_THRESHOLD)  return "ALERT";
  if (gap >= TTS_DRIFT_WARN_THRESHOLD)   return "WARN";
  if (gap >= TTS_DRIFT_WATCH_THRESHOLD)  return "WATCH";
  return "OK";
}

/**
 * Compute drift for a specific category+signal pair.
 * Queries the last DRIFT_WINDOW_DAYS of outcomes and compares to baseline.
 *
 * @returns {DriftResult|null}
 * DriftResult = { category, signal, baseline, recent, gap, severity, type, detectedAt }
 */
export async function computeCategoryDrift(pgPool, redis, category, signal) {
  if (!pgPool || !category || !signal) return null;

  const cutoff = new Date(Date.now() - DRIFT_WINDOW_DAYS * 86400 * 1000);

  try {
    const result = await pgPool.query(`
      SELECT
        COUNT(*)                                           AS total,
        SUM(CASE WHEN so.is_win THEN 1 ELSE 0 END)        AS wins
      FROM scan_outcomes so
      JOIN scan_sessions ss ON ss.scan_id = so.scan_id
      WHERE so.signal_shown = $1
        AND ss.category     = $2
        AND so.reported_at  > $3
        AND so.is_win IS NOT NULL
    `, [signal, normalizeCat(category), cutoff]);

    const row    = result.rows[0];
    const total  = Number(row?.total || 0);
    const wins   = Number(row?.wins  || 0);

    if (total < 4) return null; // not enough recent data to detect drift

    const recentRate = wins / total;

    // Load or establish baseline
    let baseline = await loadCategoryBaseline(redis, category, signal);

    if (!baseline) {
      // No baseline yet — try to establish from longer window
      const baseResult = await pgPool.query(`
        SELECT
          COUNT(*)                                       AS total,
          SUM(CASE WHEN so.is_win THEN 1 ELSE 0 END)    AS wins
        FROM scan_outcomes so
        JOIN scan_sessions ss ON ss.scan_id = so.scan_id
        WHERE so.signal_shown = $1
          AND ss.category     = $2
          AND so.reported_at  > NOW() - INTERVAL '60 days'
          AND so.is_win IS NOT NULL
      `, [signal, normalizeCat(category)]);

      const br = baseResult.rows[0];
      const bt = Number(br?.total || 0);
      const bw = Number(br?.wins  || 0);

      if (bt >= BASELINE_MIN_SAMPLES) {
        await storeCategoryBaseline(redis, category, signal, {
          winRate: bw / bt, sampleSize: bt, windowDays: 60,
        });
        baseline = { winRate: bw / bt, sampleSize: bt };
      } else {
        return null; // can't compute drift without a baseline
      }
    }

    // Re-establish baseline if stale or sample has grown significantly
    const ageMs = Date.now() - (baseline.establishedAt || 0);
    const ageDays = ageMs / (86400 * 1000);
    if (ageDays > BASELINE_REESTABLISH_DAYS || total > baseline.sampleSize * BASELINE_GROWTH_FACTOR) {
      await storeCategoryBaseline(redis, category, signal, {
        winRate: recentRate, sampleSize: total, windowDays: DRIFT_WINDOW_DAYS,
      });
      return null; // re-baselined, no drift to report
    }

    const gap      = (baseline.winRate - recentRate) / Math.max(baseline.winRate, 0.01);
    const severity = classifyDriftSeverity(gap);

    if (severity === "OK") return null;

    return {
      type:        "CATEGORY_WIN_RATE",
      category,
      signal,
      baseline:    round4(baseline.winRate),
      recent:      round4(recentRate),
      recentTotal: total,
      gap:         round4(gap),
      severity,
      detectedAt:  Date.now(),
      windowDays:  DRIFT_WINDOW_DAYS,
    };
  } catch (err) {
    console.warn(`[DriftEngine] computeCategoryDrift failed (${category}/${signal}):`, err?.message);
    return null;
  }
}

/**
 * Compute global signal-level drift (cross-category, last 14 days vs 60-day baseline).
 * Detects if a signal (STRONG BUY / GOOD DEAL) is globally underperforming.
 */
export async function computeSignalDrift(pgPool, redis, signal) {
  if (!pgPool || !signal) return null;

  try {
    const recentResult = await pgPool.query(`
      SELECT
        COUNT(*)                                       AS total,
        SUM(CASE WHEN is_win THEN 1 ELSE 0 END)        AS wins
      FROM scan_outcomes
      WHERE signal_shown  = $1
        AND reported_at   > NOW() - INTERVAL '14 days'
        AND is_win IS NOT NULL
    `, [signal]);

    const rr = recentResult.rows[0];
    const rt = Number(rr?.total || 0);
    const rw = Number(rr?.wins  || 0);
    if (rt < 8) return null;

    const recentRate = rw / rt;

    const baseResult = await pgPool.query(`
      SELECT
        COUNT(*)                                       AS total,
        SUM(CASE WHEN is_win THEN 1 ELSE 0 END)        AS wins
      FROM scan_outcomes
      WHERE signal_shown  = $1
        AND reported_at   BETWEEN NOW() - INTERVAL '60 days' AND NOW() - INTERVAL '14 days'
        AND is_win IS NOT NULL
    `, [signal]);

    const br = baseResult.rows[0];
    const bt = Number(br?.total || 0);
    const bw = Number(br?.wins  || 0);
    if (bt < BASELINE_MIN_SAMPLES) return null;

    const baselineRate = bw / bt;
    const gap      = (baselineRate - recentRate) / Math.max(baselineRate, 0.01);
    const severity = classifyDriftSeverity(gap);

    if (severity === "OK") return null;

    return {
      type:         "SIGNAL_WIN_RATE",
      signal,
      baseline:     round4(baselineRate),
      recent:       round4(recentRate),
      recentTotal:  rt,
      baselineTotal: bt,
      gap:          round4(gap),
      severity,
      detectedAt:   Date.now(),
      windowDays:   DRIFT_WINDOW_DAYS,
    };
  } catch (err) {
    console.warn(`[DriftEngine] computeSignalDrift failed (${signal}):`, err?.message);
    return null;
  }
}

/**
 * Compute time-to-sell drift for a category.
 * Uses avgDaysToSale from signalCalibrator vs CATEGORY_DAYS_TO_SALE baseline.
 *
 * @param {number}      currentAvgDays  — from getCategoryCalibration().avgDaysToSale
 * @param {number|null} staticBaseline  — from CATEGORY_DAYS_TO_SALE map (null if unknown)
 */
export async function computeTTSDrift(redis, category, currentAvgDays, staticBaseline) {
  if (!category || currentAvgDays == null) return null;

  let baseline = await loadTTSBaseline(redis, category);

  if (!baseline && staticBaseline != null) {
    // Use static table as first baseline
    await storeTTSBaseline(redis, category, { medianDays: staticBaseline, sampleSize: 0 });
    baseline = { medianDays: staticBaseline, sampleSize: 0 };
  }

  if (!baseline) return null;

  const gap      = (currentAvgDays - baseline.medianDays) / Math.max(baseline.medianDays, 1);
  const severity = classifyTTSSeverity(gap);

  if (severity === "OK") return null;

  return {
    type:        "TIME_TO_SELL",
    category,
    baseline:    round2(baseline.medianDays),
    current:     round2(currentAvgDays),
    gap:         round4(gap),
    severity,
    detectedAt:  Date.now(),
  };
}

// ── Full drift scan ───────────────────────────────────────────────────────────

/**
 * Run a full drift scan across all active categories and signals.
 * Called by the accuracy calibration worker on its daily/weekly cycle.
 *
 * @returns {{ categoryDrifts, signalDrifts, totalDrifts, alertCount, warnCount, generatedAt }}
 */
export async function runDriftScan(pgPool, redis) {
  if (!pgPool) return { ok: false, error: "pgPool required", categoryDrifts: [], signalDrifts: [] };

  const categoryDrifts = [];
  const signalDrifts   = [];

  // Fetch all active categories from recent outcomes
  let categories = [];
  try {
    const catResult = await pgPool.query(`
      SELECT DISTINCT ss.category
      FROM scan_outcomes so
      JOIN scan_sessions ss ON ss.scan_id = so.scan_id
      WHERE so.reported_at > NOW() - INTERVAL '30 days'
        AND ss.category IS NOT NULL AND ss.category != ''
      ORDER BY ss.category
    `);
    categories = catResult.rows.map((r) => r.category);
  } catch (err) {
    console.warn("[DriftEngine] Failed to load categories:", err?.message);
  }

  // Per-category drift for each tracked signal
  for (const cat of categories) {
    for (const sig of ["STRONG BUY", "GOOD DEAL"]) {
      const drift = await computeCategoryDrift(pgPool, redis, cat, sig).catch(() => null);
      if (drift) categoryDrifts.push(drift);
    }
  }

  // Global signal drift
  for (const sig of ["STRONG BUY", "GOOD DEAL"]) {
    const drift = await computeSignalDrift(pgPool, redis, sig).catch(() => null);
    if (drift) signalDrifts.push(drift);
  }

  const allDrifts   = [...categoryDrifts, ...signalDrifts];
  const alertCount  = allDrifts.filter((d) => d.severity === "ALERT").length;
  const warnCount   = allDrifts.filter((d) => d.severity === "WARN").length;
  const watchCount  = allDrifts.filter((d) => d.severity === "WATCH").length;

  const snapshot = {
    ok:             true,
    categoryDrifts,
    signalDrifts,
    totalDrifts:    allDrifts.length,
    alertCount,
    warnCount,
    watchCount,
    generatedAt:    Date.now(),
  };

  // Persist snapshot
  await storeDriftSnapshot(redis, snapshot);

  console.log(`[DriftEngine] Scan complete: ${allDrifts.length} drifts (${alertCount} ALERT, ${warnCount} WARN, ${watchCount} WATCH)`);

  return snapshot;
}

// ── Snapshot helpers ──────────────────────────────────────────────────────────

export async function storeDriftSnapshot(redis, snapshot) {
  if (!redis) return;
  await redis.set(KEY_SNAPSHOT(), JSON.stringify(snapshot), "EX", SNAPSHOT_TTL).catch(() => {});
  await redis.set(KEY_LAST_SCAN(), new Date().toISOString(), "EX", SNAPSHOT_TTL).catch(() => {});
}

export async function loadDriftSnapshot(redis) {
  if (!redis) return null;
  try {
    const raw = await redis.get(KEY_SNAPSHOT());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function getLastDriftScanTime(redis) {
  if (!redis) return null;
  try { return await redis.get(KEY_LAST_SCAN()); } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}
function round2(v) { return Math.round(Number(v) * 100) / 100; }
function round4(v) { return Math.round(Number(v) * 10000) / 10000; }

export { DRIFT_WATCH_THRESHOLD, DRIFT_WARN_THRESHOLD, DRIFT_ALERT_THRESHOLD };
