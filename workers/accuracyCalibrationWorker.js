// workers/accuracyCalibrationWorker.js
// Nightly background job: recompute bias-corrected accuracy for all active users,
// write snapshots to Postgres, refresh global calibration table.
//
// Designed to run as a BullMQ worker or a simple cron via node-cron.
// Queue name: "accuracy-calibration"
// Job: { userId? } — if no userId, runs global calibration sweep.

import { Worker, Queue } from "bullmq";
import { computeAccuracyProfile, getGlobalCalibration, computeAndStoreEmpiricalSilenceFactor } from "../src/accuracyEngine.js";
import { runWeeklyAudit } from "../src/calibrationAudit.js";
import { runDriftScan } from "../src/driftEngine.js";
import { runClusterScan } from "../src/badCallClusterEngine.js";
import { buildAutoTuningProposals, proposeThresholdAdjustment } from "../src/autoTuningEngine.js";

const QUEUE_NAME  = "accuracy-calibration";
const CONCURRENCY = 5;
const WINDOW_DAYS = 90;

// ── Queue singleton (used by index.js to enqueue jobs) ────────────────────────

let _queue = null;

export function getAccuracyCalibrationQueue(redisConnection) {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  }
  return _queue;
}

/**
 * Enqueue a single-user accuracy recalculation.
 */
export async function enqueueUserAccuracyRecalc(redisConnection, userId) {
  const q = getAccuracyCalibrationQueue(redisConnection);
  await q.add("recalc-user", { userId }, {
    jobId:    `accuracy-user-${userId}-${Date.now()}`,
    attempts: 3,
    backoff:  { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 20 },
  });
}

/**
 * Enqueue the global calibration sweep (runs nightly).
 */
export async function enqueueGlobalCalibrationSweep(redisConnection) {
  const q = getAccuracyCalibrationQueue(redisConnection);
  await q.add("recalc-global", {}, {
    jobId:    `accuracy-global-${new Date().toISOString().slice(0, 10)}`,
    attempts: 2,
    removeOnComplete: { count: 10 },
    removeOnFail:     { count: 5 },
  });
}

/**
 * Enqueue an outcome solicitation job (fires 30-day and 60-day reminders).
 * @param {object} redisConnection
 * @param {{ scanId, userId, category, signalType, delayMs }} params
 */
export async function enqueueOutcomeSolicitation(redisConnection, { scanId, userId, category, signalType, delayMs = 30 * 24 * 60 * 60 * 1000 }) {
  const q = getAccuracyCalibrationQueue(redisConnection);
  await q.add("solicit-outcome", { scanId, userId, category, signalType }, {
    jobId:    `solicit-${scanId}-${delayMs}`,
    delay:    delayMs,
    attempts: 2,
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 50 },
  });
}

/**
 * Enqueue the weekly cross-user calibration audit (WS7).
 * Idempotent: same jobId per week.
 */
export async function enqueueAuditSystem(redisConnection) {
  const q = getAccuracyCalibrationQueue(redisConnection);
  const weekId = getWeekStart();
  await q.add("audit-system", { weekId }, {
    jobId:    `audit-system-${weekId}`,
    attempts: 2,
    removeOnComplete: { count: 10 },
    removeOnFail:     { count: 5 },
  });
}

/**
 * Enqueue the daily drift + bad-call cluster scan (Phase 11).
 * Idempotent: same jobId per day.
 */
export async function enqueueDriftScan(redisConnection) {
  const q = getAccuracyCalibrationQueue(redisConnection);
  const dayId = new Date().toISOString().slice(0, 10);
  await q.add("drift-scan", { dayId }, {
    jobId:    `drift-scan-${dayId}`,
    attempts: 2,
    removeOnComplete: { count: 14 },
    removeOnFail:     { count: 7 },
  });
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function startAccuracyCalibrationWorker({ redisConnection, pgPool, redis }) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "recalc-user") {
        await processUserRecalc({ job, redis, pgPool });
      } else if (job.name === "recalc-global") {
        await processGlobalRecalc({ redis, pgPool });
      } else if (job.name === "solicit-outcome") {
        await processSolicitOutcome({ job, redis, pgPool });
      } else if (job.name === "audit-system") {
        await processAuditSystem({ redis, pgPool });
      } else if (job.name === "drift-scan") {
        await processDriftScan({ redis, pgPool });
      }
    },
    { connection: redisConnection, concurrency: CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[AccuracyWorker] ✓ ${job.name} (${job.id})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[AccuracyWorker] ✗ ${job?.name} (${job?.id}): ${err.message}`);
  });

  return worker;
}

// ── Job processors ────────────────────────────────────────────────────────────

async function processUserRecalc({ job, redis, pgPool }) {
  const { userId } = job.data;
  if (!userId) throw new Error("missing userId");

  const profile = await computeAccuracyProfile(redis, userId);

  // Upsert snapshot in Postgres
  if (pgPool) {
    await pgPool.query(`
      INSERT INTO accuracy_snapshots (
        user_id, computed_at,
        total_scans, total_reported, total_wins, total_losses,
        reporting_rate, reported_accuracy, corrected_accuracy, calibration_score,
        signal_breakdown, loser_silence_factor, inflation_estimate
      ) VALUES (
        $1, NOW(),
        $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10::jsonb, $11, $12
      )
      ON CONFLICT DO NOTHING
    `, [
      userId,
      profile.totalScans,
      profile.totalReported,
      profile.signalBreakdown.reduce((s, b) => s + (b.wins || 0), 0),
      profile.signalBreakdown.reduce((s, b) => s + (b.losses || 0), 0),
      profile.reportingRate,
      profile.reportedAccuracy,
      profile.overallAccuracy,
      profile.calibrationScore,
      JSON.stringify(profile.signalBreakdown),
      profile.biasCorrection.loserSilenceFactor,
      profile.biasCorrection.inflationEstimate,
    ]);
  }
}

async function processGlobalRecalc({ redis, pgPool }) {
  const calibration = await getGlobalCalibration(redis);
  if (!calibration?.length) return;

  if (!pgPool) return;

  for (const row of calibration) {
    await pgPool.query(`
      INSERT INTO signal_calibration_global (
        computed_at, window_days,
        signal, reported, wins, losses, win_rate,
        target_win_rate, calibration_gap, is_calibrated
      ) VALUES (
        NOW(), $1,
        $2, $3, $4, $5, $6,
        $7, $8, $9
      )
    `, [
      WINDOW_DAYS,
      row.signal,
      row.reported,
      row.wins,
      row.losses,
      row.winRate,
      row.targetWinRate,
      row.winRate != null && row.targetWinRate != null
        ? Math.round((row.winRate - row.targetWinRate) * 100) / 100
        : null,
      row.isCalibrated,
    ]);
  }
}

// WS1: Outcome solicitation handler
// Marks solicitation_sent_at in the DB and triggers a push notification (stub).
async function processSolicitOutcome({ job, redis, pgPool }) {
  const { scanId, userId, category, signalType } = job.data;
  if (!scanId || !userId) return;

  if (pgPool) {
    await pgPool.query(`
      UPDATE outcome_solicitations
      SET solicitation_sent_at = NOW()
      WHERE scan_id = $1 AND user_id = $2 AND solicitation_sent_at IS NULL
    `, [scanId, userId]).catch((err) =>
      console.warn("[AccuracyWorker] solicit update failed:", err?.message)
    );
  }

  // Push notification hook — extend here with FCM/APNs when available
  console.log(`[AccuracyWorker] Solicitation sent: userId=${userId} scanId=${scanId} signal=${signalType}`);

  // Compute empirical silence factor if enough data has accumulated
  if (redis && pgPool && category) {
    await computeAndStoreEmpiricalSilenceFactor(pgPool, redis, category).catch(() => {});
  }
}

// WS7: Weekly system-wide calibration audit
async function processAuditSystem({ redis, pgPool }) {
  console.log("[AccuracyWorker] Starting weekly system audit...");
  const result = await runWeeklyAudit(redis, pgPool);
  console.log("[AccuracyWorker] Audit complete:", result?.rowsAudited, "rows,", result?.alertCount, "alerts");
}

// Phase 11: Daily drift scan + cluster detection + auto-tuning proposal generation
async function processDriftScan({ redis, pgPool }) {
  console.log("[AccuracyWorker] Starting daily drift scan...");

  // 1. Run drift scan across all categories
  const driftResult = await runDriftScan(pgPool, redis).catch((err) => {
    console.error("[AccuracyWorker] Drift scan failed:", err?.message);
    return { categoryDrifts: [], signalDrifts: [], ok: false };
  });

  // 2. Load active categories for cluster scan
  let categories = [];
  if (pgPool) {
    try {
      const res = await pgPool.query(`
        SELECT DISTINCT ss.category
        FROM scan_outcomes so
        JOIN scan_sessions ss ON ss.scan_id = so.scan_id
        WHERE so.reported_at > NOW() - INTERVAL '14 days'
          AND ss.category IS NOT NULL AND ss.category != ''
      `);
      categories = res.rows.map((r) => r.category);
    } catch (err) {
      console.warn("[AccuracyWorker] Failed to load categories for cluster scan:", err?.message);
    }
  }

  // 3. Run bad-call cluster scan
  const clusterResult = await runClusterScan(redis, categories).catch((err) => {
    console.error("[AccuracyWorker] Cluster scan failed:", err?.message);
    return { clusters: [], alertClusters: 0 };
  });

  // 4. Build and store auto-tuning proposals (NEVER auto-apply)
  // Load calibration data for categories with drift
  const driftsToPropose = [
    ...(driftResult.categoryDrifts || []).filter((d) => d.severity !== "WATCH"),
    ...(driftResult.signalDrifts   || []).filter((d) => d.severity !== "WATCH"),
  ];

  if (driftsToPropose.length > 0 && pgPool) {
    const catCalibs = {};
    try {
      // Fetch calibration data for each affected category
      const { getCategoryCalibration } = await import("../src/signalCalibrator.js");
      const affectedCategories = [...new Set(driftsToPropose.map((d) => d.category).filter(Boolean))];
      for (const cat of affectedCategories) {
        catCalibs[cat] = await getCategoryCalibration(redis, null, cat).catch(() => null);
      }
    } catch (err) {
      console.warn("[AccuracyWorker] Failed to load calibrations for proposals:", err?.message);
    }

    const proposals = buildAutoTuningProposals(driftsToPropose, catCalibs);
    for (const proposal of proposals.slice(0, 5)) { // max 5 proposals per day
      await proposeThresholdAdjustment(redis, proposal).catch((err) =>
        console.warn("[AccuracyWorker] Proposal failed:", err?.message)
      );
    }
    if (proposals.length > 0) {
      console.log(`[AccuracyWorker] Generated ${proposals.length} auto-tuning proposals (pending ops review)`);
    }
  }

  console.log(
    `[AccuracyWorker] Drift scan complete: ${driftResult.totalDrifts || 0} drifts, ` +
    `${clusterResult.alertClusters || 0} cluster alerts`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getWeekStart() {
  const now  = new Date();
  const day  = now.getUTCDay();
  const diff = (day + 6) % 7;
  const mon  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return mon.toISOString().slice(0, 10);
}
