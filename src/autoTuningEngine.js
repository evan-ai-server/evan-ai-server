// src/autoTuningEngine.js
// Phase 11 — Self-Improving System: Auto-Tuning Proposals and Adjustment History.
//
// CRITICAL RULES (NON-NEGOTIABLE):
//   1. No silent production threshold mutation. EVER.
//   2. Every proposal is logged with: who proposed it, why, what, when.
//   3. Application requires explicit ops confirmation.
//   4. Every applied adjustment has a rollback point stored before it's applied.
//   5. Canary mode: apply to N% of traffic first; ops promote or roll back.
//   6. Low-sample categories (< MIN_CANARY_SAMPLES) cannot self-tune at all.
//   7. GLOBAL_FLOORS from categoryThresholdEngine are absolute hard limits.
//
// Adjustment lifecycle:
//   PROPOSED → (confirm) → APPLIED (full) or CANARY (partial traffic)
//   CANARY   → (promote) → APPLIED
//   CANARY   → (rollback) → ROLLED_BACK
//   APPLIED  → (rollback) → ROLLED_BACK
//
// Redis key schema:
//   tune:history                    ZSET   (score=ts, member=JSON record)
//   tune:pending                    HASH   (field=id, value=JSON proposal)
//   tune:active:{category}          HASH   (field=thresholdKey, value=JSON override)
//   tune:canary:{id}                HASH   { status, trafficPct, appliedAt, promotedAt, rolledBackAt }
//   tune:rollback:{id}              STRING  JSON previous state before adjustment
//
// Applied overrides are loaded by loadExplicitThresholdOverrides() and
// passed to buildEffectiveThresholds() in the scan hot path.

import { GLOBAL_FLOORS } from "./categoryThresholdEngine.js";

const KEY_HISTORY     = ()           => "tune:history";
const KEY_PENDING     = ()           => "tune:pending";
const KEY_ACTIVE      = (cat)        => `tune:active:${normalizeCat(cat)}`;
const KEY_CANARY      = (id)         => `tune:canary:${id}`;
const KEY_ROLLBACK    = (id)         => `tune:rollback:${id}`;

const HISTORY_TTL         = 365 * 86400;  // 1 year
const HISTORY_MAX         = 500;          // max entries in history ZSET
const CANARY_TTL          = 14 * 86400;   // canary state survives 14d max
const ROLLBACK_TTL        = 30 * 86400;   // rollback backup survives 30d
const MIN_CANARY_SAMPLES  = 30;           // category needs ≥30 outcomes before any tuning
const DEFAULT_CANARY_PCT  = 10;           // default canary traffic %

// ── Proposal builder ──────────────────────────────────────────────────────────

/**
 * Generate auto-tuning proposals from drift data + calibration data.
 *
 * Rules:
 *   - Only propose TIGHTENING (raising floors), never loosening via auto-tune
 *   - Only propose when: severity >= WARN AND sampleSize >= MIN_CANARY_SAMPLES
 *   - Cap tighten at 15% above current value (no large jumps)
 *   - Never propose a value below GLOBAL_FLOORS[key]
 *   - One proposal per category+threshold per scan cycle
 *
 * @param {object[]} driftResults     — from runDriftScan()
 * @param {object}   categoryCalibrations — map of category → calibration data
 * @returns {object[]} proposals (NOT yet stored — caller calls proposeThresholdAdjustment)
 */
export function buildAutoTuningProposals(driftResults, categoryCalibrations) {
  const proposals = [];
  const seen      = new Set(); // dedup category+threshold

  for (const drift of driftResults) {
    if (!drift || drift.type !== "CATEGORY_WIN_RATE") continue;
    if (drift.severity === "OK" || drift.severity === "WATCH") continue; // only WARN and ALERT

    const { category, signal, gap, severity, recentTotal } = drift;
    if (!category || !signal) continue;
    if ((recentTotal || 0) < MIN_CANARY_SAMPLES) continue; // low-sample guard

    const cal = categoryCalibrations?.[category];
    if (!cal) continue;

    if (signal === "STRONG BUY") {
      // Propose tightening STRONG_BUY_DEAL_STRENGTH
      const key        = "STRONG_BUY_DEAL_STRENGTH";
      const floor      = GLOBAL_FLOORS[key];
      const current    = cal.dealStrengthOverride ?? floor;
      const dedupeKey  = `${category}:${key}`;
      if (!seen.has(dedupeKey) && current < floor + 0.15) {
        // Tighten proportionally to gap: WARN = small nudge, ALERT = larger
        const delta    = severity === "ALERT" ? 0.03 : 0.015;
        const proposed = round4(Math.min(floor + 0.15, current + delta));
        if (proposed > current) {
          proposals.push({
            category, signal, thresholdKey: key,
            currentValue:   current,
            suggestedValue: proposed,
            reason:         `${signal} win-rate drift: ${(drift.recent * 100).toFixed(1)}% vs ${(drift.baseline * 100).toFixed(1)}% baseline (${(gap * 100).toFixed(1)}% gap, ${severity})`,
            severity,
            driftGap:       drift.gap,
            sampleSize:     recentTotal,
          });
          seen.add(dedupeKey);
        }
      }

      // Also propose confidence tighten on ALERT
      if (severity === "ALERT" && cal.confidenceOverride != null) {
        const cKey       = "STRONG_BUY_CONFIDENCE";
        const cFloor     = GLOBAL_FLOORS[cKey];
        const cCurrent   = cal.confidenceOverride ?? cFloor;
        const cDedupeKey = `${category}:${cKey}`;
        if (!seen.has(cDedupeKey) && cCurrent < cFloor + 0.10) {
          const proposed = round4(Math.min(cFloor + 0.10, cCurrent + 0.02));
          if (proposed > cCurrent) {
            proposals.push({
              category, signal, thresholdKey: cKey,
              currentValue:   cCurrent,
              suggestedValue: proposed,
              reason:         `STRONG BUY ALERT drift — confidence threshold tighten to reduce false positives`,
              severity,
              driftGap:       drift.gap,
              sampleSize:     recentTotal,
            });
            seen.add(cDedupeKey);
          }
        }
      }
    }

    if (signal === "GOOD DEAL") {
      const key        = "GOOD_DEAL_DEAL_STRENGTH";
      const floor      = GLOBAL_FLOORS[key];
      const current    = cal.dealStrengthOverride ?? floor;
      const dedupeKey  = `${category}:${key}`;
      if (!seen.has(dedupeKey) && current < floor + 0.08) {
        const delta    = severity === "ALERT" ? 0.025 : 0.01;
        const proposed = round4(Math.min(floor + 0.08, current + delta));
        if (proposed > current) {
          proposals.push({
            category, signal, thresholdKey: key,
            currentValue:   current,
            suggestedValue: proposed,
            reason:         `${signal} win-rate drift: ${(drift.recent * 100).toFixed(1)}% vs ${(drift.baseline * 100).toFixed(1)}% baseline (${(gap * 100).toFixed(1)}% gap, ${severity})`,
            severity,
            driftGap:       drift.gap,
            sampleSize:     recentTotal,
          });
          seen.add(dedupeKey);
        }
      }
    }
  }

  return proposals;
}

// ── Proposal storage ──────────────────────────────────────────────────────────

/**
 * Store a tuning proposal, logging it to history and pending queue.
 * Returns the new adjustmentId.
 *
 * @param {object} redis
 * @param {object} proposal — from buildAutoTuningProposals() or manual ops
 * @returns {string} adjustmentId
 */
export async function proposeThresholdAdjustment(redis, {
  category, signal, thresholdKey, currentValue, suggestedValue, reason, severity, sampleSize, driftGap,
}) {
  if (!redis || !category || !thresholdKey) throw new Error("redis, category, thresholdKey required");

  // Hard safety: never propose below global floor
  const floor = GLOBAL_FLOORS[thresholdKey];
  if (floor !== undefined && suggestedValue < floor) {
    throw new Error(`Proposed value ${suggestedValue} is below global floor ${floor} for ${thresholdKey}`);
  }
  // Hard safety: never auto-loosen (only tighten through auto-tuning)
  if (suggestedValue <= currentValue) {
    throw new Error(`Auto-tuning can only tighten thresholds. ${suggestedValue} <= ${currentValue}`);
  }

  const id = `adj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    status:         "PROPOSED",
    category,
    signal:         signal || null,
    thresholdKey,
    currentValue,
    suggestedValue,
    reason,
    severity:       severity || null,
    sampleSize:     sampleSize || null,
    driftGap:       driftGap  || null,
    proposedAt:     Date.now(),
    proposedBy:     "auto_drift_scan",
    appliedAt:      null,
    rolledBackAt:   null,
  };

  // Store in pending hash
  await redis.hset(KEY_PENDING(), id, JSON.stringify(record));

  // Log to history ZSET
  await logAdjustmentEvent(redis, record);

  console.log(`[AutoTuning] Proposed: ${id} — ${thresholdKey} ${currentValue}→${suggestedValue} (${category}, ${reason.slice(0, 60)})`);

  return id;
}

// ── Applying adjustments ──────────────────────────────────────────────────────

/**
 * Apply a pending adjustment to production (full or canary).
 * Records rollback state before mutating anything.
 *
 * @param {object} redis
 * @param {string} adjustmentId
 * @param {{ mode: 'full'|'canary', trafficPct?: number, confirmedBy?: string }} opts
 */
export async function applyAdjustment(redis, adjustmentId, {
  mode        = "canary",
  trafficPct  = DEFAULT_CANARY_PCT,
  confirmedBy = "ops",
} = {}) {
  if (!redis || !adjustmentId) throw new Error("redis and adjustmentId required");

  const raw = await redis.hget(KEY_PENDING(), adjustmentId);
  if (!raw) throw new Error(`No pending adjustment with id=${adjustmentId}`);

  const proposal = JSON.parse(raw);
  if (proposal.status !== "PROPOSED") {
    throw new Error(`Adjustment ${adjustmentId} is already in status=${proposal.status}`);
  }

  // Save rollback state BEFORE applying
  const currentActive = await loadExplicitThresholdOverrides(redis, proposal.category);
  await redis.set(
    KEY_ROLLBACK(adjustmentId),
    JSON.stringify({ previousOverrides: currentActive, category: proposal.category, savedAt: Date.now() }),
    "EX", ROLLBACK_TTL,
  );

  const appliedAt = Date.now();
  const actualTrafficPct = mode === "full" ? 100 : Math.max(1, Math.min(100, trafficPct));

  // Write explicit override for this category
  const override = {
    value:         proposal.suggestedValue,
    adjustmentId,
    mode,
    trafficPct:    actualTrafficPct,
    appliedAt,
    confirmedBy,
    reason:        proposal.reason,
  };

  await redis.hset(KEY_ACTIVE(proposal.category), proposal.thresholdKey, JSON.stringify(override));
  await redis.expire(KEY_ACTIVE(proposal.category), HISTORY_TTL);

  // Update proposal status
  const updated = {
    ...proposal,
    status:        mode === "full" ? "APPLIED" : "CANARY",
    appliedAt,
    confirmedBy,
    mode,
    trafficPct:    actualTrafficPct,
  };
  await redis.hset(KEY_PENDING(), adjustmentId, JSON.stringify(updated));

  // Canary state tracking
  if (mode === "canary") {
    await redis.hmset(KEY_CANARY(adjustmentId), {
      status:     "CANARY",
      trafficPct: String(actualTrafficPct),
      appliedAt:  String(appliedAt),
    });
    await redis.expire(KEY_CANARY(adjustmentId), CANARY_TTL);
  }

  await logAdjustmentEvent(redis, { ...updated, event: "APPLIED" });

  console.log(`[AutoTuning] Applied: ${adjustmentId} — ${proposal.thresholdKey} = ${proposal.suggestedValue} (${mode}, ${actualTrafficPct}% traffic, by=${confirmedBy})`);
}

/**
 * Promote a canary to full traffic.
 */
export async function promoteCanary(redis, adjustmentId, { confirmedBy = "ops" } = {}) {
  if (!redis || !adjustmentId) throw new Error("redis and adjustmentId required");

  const raw = await redis.hget(KEY_PENDING(), adjustmentId);
  if (!raw) throw new Error(`No adjustment with id=${adjustmentId}`);

  const proposal = JSON.parse(raw);
  if (proposal.status !== "CANARY") throw new Error(`Cannot promote — status is ${proposal.status}`);

  // Update override to full traffic
  const existing = await redis.hget(KEY_ACTIVE(proposal.category), proposal.thresholdKey);
  if (existing) {
    const override = JSON.parse(existing);
    override.mode       = "full";
    override.trafficPct = 100;
    override.promotedAt = Date.now();
    override.confirmedBy = confirmedBy;
    await redis.hset(KEY_ACTIVE(proposal.category), proposal.thresholdKey, JSON.stringify(override));
  }

  // Update proposal
  const updated = { ...proposal, status: "APPLIED", trafficPct: 100, promotedAt: Date.now(), confirmedBy };
  await redis.hset(KEY_PENDING(), adjustmentId, JSON.stringify(updated));

  await redis.hset(KEY_CANARY(adjustmentId), "status", "PROMOTED", "promotedAt", String(Date.now()));
  await logAdjustmentEvent(redis, { ...updated, event: "PROMOTED" });

  console.log(`[AutoTuning] Promoted canary: ${adjustmentId} to full traffic`);
}

/**
 * Roll back an applied or canary adjustment to the previous state.
 * Uses the pre-stored rollback snapshot.
 */
export async function rollbackAdjustment(redis, adjustmentId, { confirmedBy = "ops" } = {}) {
  if (!redis || !adjustmentId) throw new Error("redis and adjustmentId required");

  const raw = await redis.hget(KEY_PENDING(), adjustmentId);
  if (!raw) throw new Error(`No adjustment with id=${adjustmentId}`);

  const proposal = JSON.parse(raw);
  if (!["APPLIED", "CANARY"].includes(proposal.status)) {
    throw new Error(`Cannot roll back — status is ${proposal.status}`);
  }

  // Restore previous state from rollback snapshot
  const rollbackRaw = await redis.get(KEY_ROLLBACK(adjustmentId));
  if (rollbackRaw) {
    const rollback = JSON.parse(rollbackRaw);
    // Restore the key to its prior value (or delete if it didn't exist)
    const prev = rollback.previousOverrides?.[proposal.thresholdKey];
    if (prev) {
      await redis.hset(KEY_ACTIVE(proposal.category), proposal.thresholdKey, JSON.stringify(prev));
    } else {
      await redis.hdel(KEY_ACTIVE(proposal.category), proposal.thresholdKey);
    }
  } else {
    // No snapshot found — just delete the override
    await redis.hdel(KEY_ACTIVE(proposal.category), proposal.thresholdKey);
  }

  const rolledBackAt = Date.now();
  const updated = { ...proposal, status: "ROLLED_BACK", rolledBackAt, confirmedBy };
  await redis.hset(KEY_PENDING(), adjustmentId, JSON.stringify(updated));

  await logAdjustmentEvent(redis, { ...updated, event: "ROLLED_BACK" });

  console.log(`[AutoTuning] Rolled back: ${adjustmentId} (by=${confirmedBy})`);
}

// ── Override loading (used by scan hot path) ──────────────────────────────────

/**
 * Load active explicit threshold overrides for a category.
 * Returns a plain object map of thresholdKey → value (considering canary traffic pct).
 *
 * @param {string|null} canaryRoll — deterministic 0–1 float for this scan (from hash(userId+category))
 *                                   Pass null to always apply full overrides (e.g., ops preview)
 * @returns {{ [thresholdKey]: number }}
 */
export async function loadExplicitThresholdOverrides(redis, category, canaryRoll = null) {
  if (!redis || !category) return {};
  try {
    const raw = await redis.hgetall(KEY_ACTIVE(normalizeCat(category)));
    if (!raw || !Object.keys(raw).length) return {};

    const result = {};
    for (const [key, val] of Object.entries(raw)) {
      try {
        const override = JSON.parse(val);
        if (!override?.value) continue;

        // Canary traffic check
        if (override.mode === "canary" && canaryRoll !== null) {
          const pct = (override.trafficPct || DEFAULT_CANARY_PCT) / 100;
          if (canaryRoll > pct) continue; // this scan is outside the canary cohort
        }

        result[key] = override.value;
      } catch { /* skip malformed */ }
    }
    return result;
  } catch { return {}; }
}

// ── List / query ──────────────────────────────────────────────────────────────

export async function listPendingAdjustments(redis) {
  if (!redis) return [];
  try {
    const all = await redis.hgetall(KEY_PENDING());
    if (!all) return [];
    return Object.values(all)
      .map((v) => { try { return JSON.parse(v); } catch { return null; } })
      .filter((r) => r && ["PROPOSED", "CANARY"].includes(r.status))
      .sort((a, b) => (b.proposedAt || 0) - (a.proposedAt || 0));
  } catch { return []; }
}

export async function listAllAdjustments(redis) {
  if (!redis) return [];
  try {
    const all = await redis.hgetall(KEY_PENDING());
    if (!all) return [];
    return Object.values(all)
      .map((v) => { try { return JSON.parse(v); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => (b.proposedAt || 0) - (a.proposedAt || 0));
  } catch { return []; }
}

/**
 * Get adjustment history log (most recent events first).
 */
export async function listAdjustmentHistory(redis, limit = 50) {
  if (!redis) return [];
  try {
    const raw = await redis.zrevrange(KEY_HISTORY(), 0, limit - 1);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Adjustment event log ──────────────────────────────────────────────────────

async function logAdjustmentEvent(redis, record) {
  if (!redis) return;
  const entry = JSON.stringify({ ...record, _loggedAt: Date.now() });
  await redis.zadd(KEY_HISTORY(), Date.now(), entry);
  await redis.zremrangebyrank(KEY_HISTORY(), 0, -(HISTORY_MAX + 1));
  await redis.expire(KEY_HISTORY(), HISTORY_TTL);
}

// ── Per-user calibration reinforcement ───────────────────────────────────────

/**
 * Generate per-user calibration reinforcement hints.
 * When a user has enough outcomes in a category, this surfaces personalized
 * guidance ("your STRONG BUY calls in electronics are 91% accurate — stay the course").
 *
 * This does NOT adjust any thresholds — purely informational for the user.
 *
 * @returns {{ hints: object[], userId }} or null
 */
export function buildUserCalibrationReinforcement(accuracyProfile, categoryCalibrations) {
  if (!accuracyProfile) return null;

  const hints = [];

  for (const breakdown of (accuracyProfile.signalBreakdown || [])) {
    const { signal, calibratedWinRate, sampleSize, target } = breakdown;
    if (!sampleSize || sampleSize < 10) continue;

    const pct = Math.round((calibratedWinRate || 0) * 100);
    const targetPct = Math.round((target?.expectedWinRate || 0.7) * 100);

    if (pct >= targetPct + 10) {
      hints.push({
        signal,
        type:    "STRONG_PERFORMER",
        message: `Your ${signal} calls are at ${pct}% accuracy (target: ${targetPct}%). Keep using Evan for these.`,
        sampleSize,
      });
    } else if (pct < targetPct - 20 && sampleSize >= 20) {
      hints.push({
        signal,
        type:    "UNDERPERFORMING",
        message: `Your ${signal} calls are at ${pct}% accuracy vs ${targetPct}% target. Be more selective.`,
        sampleSize,
      });
    }
  }

  return hints.length ? { hints } : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}
function round4(v) { return Math.round(Number(v) * 10000) / 10000; }

export { MIN_CANARY_SAMPLES, DEFAULT_CANARY_PCT };
