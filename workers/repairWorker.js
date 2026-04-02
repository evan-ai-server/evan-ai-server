// workers/repairWorker.js
// Repair Worker — Phase 16: No-Decay System.
//
// Bounded, safe, logged repair jobs for stale or inconsistent system state.
// Each job is idempotent — safe to run multiple times.
//
// Jobs:
//   rebuild_anomaly_baselines   — seed anomaly baseline metrics from existing data
//   refresh_category_intel      — clear stale category intelligence snapshots
//   clear_stale_suppressions    — remove calibration suppressions older than 14d
//   rebuild_replay_index        — rebuild the wrong-call index from outcome data
//   refresh_identity_snapshots  — invalidate stale financial identity snapshots
//   repair_outcome_linkages     — check for BOUGHT outcomes with no sell record after 90d
//   audit_incident_controls     — log any controls older than 7d (non-destructive)
//
// Invoked by:
//   GET /api/ops/repair/run?job=<jobName>  (ops route)
//   Or scheduled via setInterval in index.js

import { runAnomalyDetection }          from "../src/anomalyEngine.js";
import { getActiveControls }            from "../src/incidentControls.js";
import { invalidateIdentityCache }      from "../src/financialIdentityEngine.js";
import { invalidatePerformanceCache }   from "../src/personalPerformanceEngine.js";
import { getAllSuppressions }           from "../src/calibrationAudit.js";

// ── Job registry ──────────────────────────────────────────────────────────────

const JOBS = {
  rebuild_anomaly_baselines:   jobRebuildAnomalyBaselines,
  refresh_category_intel:      jobRefreshCategoryIntel,
  clear_stale_suppressions:    jobClearStaleSuppressions,
  rebuild_replay_index:        jobRebuildReplayIndex,
  refresh_identity_snapshots:  jobRefreshIdentitySnapshots,
  repair_outcome_linkages:     jobRepairOutcomeLinkages,
  audit_incident_controls:     jobAuditIncidentControls,
};

/**
 * Run a specific repair job.
 *
 * @param {object} redis
 * @param {object|null} pgPool
 * @param {string} jobName — key from JOBS registry
 * @param {object} opts    — job-specific options
 * @returns {Promise<{ ok, jobName, repaired, errors, durationMs, log }>}
 */
export async function runRepairJob(redis, pgPool, jobName, opts = {}) {
  const fn = JOBS[jobName];
  if (!fn) {
    return { ok: false, jobName, error: `Unknown repair job: ${jobName}`, availableJobs: Object.keys(JOBS) };
  }

  const start  = Date.now();
  const logLines = [];
  const log = (msg) => { logLines.push(`[${new Date().toISOString()}] ${msg}`); };

  log(`Starting repair job: ${jobName}`);
  let repaired = 0;
  const errors = [];

  try {
    const result = await fn(redis, pgPool, opts, { log });
    repaired = result.repaired || 0;
    if (result.errors?.length) errors.push(...result.errors);
    log(`Completed: ${repaired} items repaired, ${errors.length} errors`);
  } catch (err) {
    errors.push(err?.message || String(err));
    log(`Job failed: ${err?.message}`);
  }

  return {
    ok:         errors.length === 0,
    jobName,
    repaired,
    errors,
    durationMs: Date.now() - start,
    log:        logLines,
  };
}

/**
 * List all available repair jobs.
 */
export function listRepairJobs() {
  return Object.keys(JOBS).map((name) => ({
    name,
    description: JOB_DESCRIPTIONS[name] || "No description",
  }));
}

const JOB_DESCRIPTIONS = {
  rebuild_anomaly_baselines:  "Re-run anomaly detection to refresh the active anomaly snapshot",
  refresh_category_intel:     "Invalidate stale category intelligence snapshots for high-volume categories",
  clear_stale_suppressions:   "Log calibration suppressions older than 14 days (non-destructive — ops must confirm removal)",
  rebuild_replay_index:       "Re-scan wrong-call ZSET keys to verify replay index integrity",
  refresh_identity_snapshots: "Invalidate financial identity snapshots for a user or batch of users",
  repair_outcome_linkages:    "Find BOUGHT outcomes with no corresponding sell record after 90 days",
  audit_incident_controls:    "Log all active incident controls with age; flag stale ones",
};

// ── Job implementations ───────────────────────────────────────────────────────

async function jobRebuildAnomalyBaselines(redis, _pgPool, _opts, { log }) {
  log("Running anomaly detection to refresh active snapshot...");
  const report = await runAnomalyDetection(redis);
  log(`Anomaly scan complete: ${report.total} anomalies detected (${report.criticalCount} critical)`);
  return { repaired: 1 };
}

async function jobRefreshCategoryIntel(redis, _pgPool, opts, { log }) {
  const cats = opts.categories || ["sneakers", "watches", "electronics", "handbags", "trading_cards"];
  let repaired = 0;

  for (const cat of cats) {
    // Bust the category event calendar cache
    const calKeys = await redis.keys(`cal:event:${cat}:*`).catch(() => []);
    for (const k of calKeys) {
      await redis.del(k).catch(() => {});
      repaired++;
    }
    log(`Cleared ${calKeys.length} calendar cache entries for ${cat}`);
  }

  return { repaired };
}

async function jobClearStaleSuppressions(redis, _pgPool, _opts, { log }) {
  const suppressions = await getAllSuppressions(redis).catch(() => []);
  if (!suppressions.length) {
    log("No calibration suppressions found");
    return { repaired: 0 };
  }

  const now = Date.now();
  const STALE_MS = 14 * 86400 * 1000;
  let stale = 0;
  const errors = [];

  for (const s of suppressions) {
    const age = now - new Date(s.suppressedAt || 0).getTime();
    if (age > STALE_MS) {
      stale++;
      log(`STALE suppression: ${s.category}/${s.signal} — suppressed ${Math.round(age / 86400000)}d ago. Manual review recommended.`);
      // NOTE: We log but do NOT auto-remove — ops must confirm via /api/ops/calibration/unsuppress
    }
  }

  log(`Found ${suppressions.length} suppression(s); ${stale} older than 14d — flagged for ops review`);
  return { repaired: 0, staleCount: stale, totalSuppressions: suppressions.length };
}

async function jobRebuildReplayIndex(redis, _pgPool, opts, { log }) {
  const keys = await redis.keys("wrong_call:*").catch(() => []);
  let repaired = 0;
  const errors = [];

  log(`Found ${keys.length} wrong-call ZSET keys`);

  for (const key of keys) {
    try {
      // Verify the ZSET exists and has valid entries
      const count = await redis.zcard(key).catch(() => -1);
      if (count < 0) {
        errors.push(`Key ${key} unavailable`);
        continue;
      }
      log(`${key}: ${count} entries OK`);
      repaired++;
    } catch (err) {
      errors.push(`${key}: ${err?.message}`);
    }
  }

  return { repaired, errors };
}

async function jobRefreshIdentitySnapshots(redis, _pgPool, opts, { log }) {
  const userIds = opts.userIds || [];
  if (!userIds.length) {
    // Scan for stale identity snapshots (older than 2h)
    const keys = await redis.keys("identity:snapshot:*").catch(() => []);
    log(`Found ${keys.length} identity snapshot keys — invalidating all for freshness`);
    let repaired = 0;
    for (const k of keys) {
      await redis.del(k).catch(() => {});
      repaired++;
    }
    return { repaired };
  }

  let repaired = 0;
  for (const uid of userIds) {
    await invalidateIdentityCache(redis, uid).catch(() => {});
    await invalidatePerformanceCache(redis, uid).catch(() => {});
    log(`Invalidated identity + performance cache for user ${uid}`);
    repaired++;
  }
  return { repaired };
}

async function jobRepairOutcomeLinkages(redis, pgPool, opts, { log }) {
  if (!redis) { log("Redis unavailable"); return { repaired: 0 }; }

  // Find outcome states that are stuck in BOUGHT for > 90 days
  const STALE_BOUGHT_MS = 90 * 86400 * 1000;
  const userKeys = await redis.keys("outcome:user:*").catch(() => []);
  log(`Scanning ${userKeys.length} user outcome ZSETs`);

  let staleCount = 0;
  const errors   = [];

  for (const key of userKeys.slice(0, opts.maxUsers || 50)) {
    try {
      const uid   = key.replace("outcome:user:", "");
      // Get recent outcomes (top 20 by time)
      const items = await redis.zrevrange(key, 0, 19, "WITHSCORES").catch(() => []);

      for (let i = 0; i < items.length; i += 2) {
        const scanId    = items[i];
        const timestamp = parseFloat(items[i + 1]);
        const age       = Date.now() - timestamp;

        if (age < STALE_BOUGHT_MS) continue;

        // Check the state key
        const stateKey = `outcome:state:${uid}:${scanId}`;
        const raw      = await redis.get(stateKey).catch(() => null);
        if (!raw) continue;

        let state;
        try { state = JSON.parse(raw); } catch { continue; }

        if (state.state === "BOUGHT") {
          staleCount++;
          log(`Stale BOUGHT outcome: user=${uid} scanId=${scanId} age=${Math.round(age / 86400000)}d — may need manual resolution`);
        }
      }
    } catch (err) {
      errors.push(err?.message);
    }
  }

  log(`Found ${staleCount} outcomes stuck in BOUGHT state for > 90 days`);
  return { repaired: 0, staleCount, errors };  // reporting only — no mutations without confirmation
}

async function jobAuditIncidentControls(redis, _pgPool, _opts, { log }) {
  const controls = await getActiveControls(redis).catch(() => []);
  if (!controls.length) {
    log("No active incident controls");
    return { repaired: 0 };
  }

  const now     = Date.now();
  let staleCount = 0;

  for (const ctrl of controls) {
    const age = now - new Date(ctrl.activatedAt).getTime();
    const days = Math.round(age / 86400000);
    const flag = days > 7 ? " ⚠️  STALE" : "";
    log(`Control: ${ctrl.type}:${ctrl.target} — activated ${days}d ago by ${ctrl.triggeredBy} — "${ctrl.reason}"${flag}`);
    if (days > 7) staleCount++;
  }

  log(`${controls.length} control(s) active; ${staleCount} are older than 7 days and should be reviewed`);
  return { repaired: 0, totalControls: controls.length, staleControls: staleCount };
}
