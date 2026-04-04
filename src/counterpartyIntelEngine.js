// src/counterpartyIntelEngine.js
// Phase 6 — Counterparty Intelligence Engine.
//
// Redis-backed reputation memory for sellers and buyers on secondary marketplaces.
// Tracks behavioral signals that indicate trustworthiness or risk:
//   - Dispute history (buyer-opened or seller-attributed)
//   - Authentication mismatch rate (sold item failed auth verification)
//   - Condition mismatch rate (condition worse than described)
//   - Scam flags (confirmed platform enforcement actions)
//   - Return rate
//   - Positive signal velocity (clean transactions)
//
// Design principles:
//   1. Memory is probabilistic, not punitive — a dispute is a signal, not a verdict.
//   2. Decay over time — old signals matter less than recent behavior.
//   3. All scores are [0, 1] — 0 is lowest risk, 1 is highest risk.
//   4. counterpartyRisk is a single output float consumed by sellRoutingEngine.
//   5. No PII stored — only platform username/sellerId, not real name or contact.
//   6. Data is contributor-sourced — Evan stores what users report + platform signals.
//
// Redis key layout:
//   cp:record:{platformId}:{sellerId}    STRING  counterparty record (1yr TTL, refreshed on update)
//   cp:scam:{platformId}:{sellerId}      STRING  scam flag record (permanent — never decays)
//   cp:ops                               HASH    ops counters

import crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CP_VERSION    = "6.0";
const CP_TTL               = 365 * 86400;       // 1 year
const CP_SCAM_TTL          = 5 * 365 * 86400;   // scam flags last 5 years

// Signal weight in overall counterpartyRisk score
const SIGNAL_WEIGHTS = {
  disputeRate:        0.30,
  authMismatchRate:   0.30,
  conditionMismatch:  0.15,
  scamFlags:          0.20,   // presence of any scam flag is heavily weighted
  returnRate:         0.05,
};

// Decay half-life: signals from >6 months ago contribute 50% less
const DECAY_HALF_LIFE_MS = 180 * 86400000;

// Thresholds for risk classification
const RISK_THRESHOLDS = {
  LOW:      0.15,
  MODERATE: 0.35,
  HIGH:     0.60,
};

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_RECORD = (platformId, sellerId) =>
  `cp:record:${platformId}:${_sanitizeId(sellerId)}`;
const KEY_SCAM   = (platformId, sellerId) =>
  `cp:scam:${platformId}:${_sanitizeId(sellerId)}`;
const KEY_OPS    = () => `cp:ops`;

// ── Core: get counterparty risk ────────────────────────────────────────────────

/**
 * Get the risk score for a counterparty (seller or buyer on a given platform).
 * Returns a single counterpartyRisk float (0-1) for use in sellRoutingEngine.
 *
 * @param {object} redis
 * @param {string} platformId
 * @param {string} sellerId     — platform username or seller ID
 * @returns {Promise<CounterpartyRiskResult>}
 */
export async function getCounterpartyRisk(redis, platformId, sellerId) {
  if (!redis || !platformId || !sellerId) {
    return _nullResult(platformId, sellerId);
  }

  try {
    const [recordRaw, scamRaw] = await Promise.all([
      redis.get(KEY_RECORD(platformId, sellerId)).catch(() => null),
      redis.get(KEY_SCAM(platformId, sellerId)).catch(() => null),
    ]);

    // Scam flag is an absolute override — always high risk
    if (scamRaw) {
      let scamData = {};
      try { scamData = JSON.parse(scamRaw); } catch {}
      return {
        platformId,
        sellerId,
        counterpartyRisk: 0.95,
        riskLevel: "HIGH",
        scamFlagged: true,
        scamReason: scamData.reason || "platform_enforcement",
        scamFlaggedAt: scamData.flaggedAt || null,
        record: null,
        dataQuality: "SCAM_FLAG",
        cp_version: CP_VERSION,
      };
    }

    // No record — return null risk (unknown, not assumed risky)
    if (!recordRaw) {
      return _nullResult(platformId, sellerId);
    }

    const record = JSON.parse(recordRaw);
    const riskScore = _computeRiskScore(record);

    return {
      platformId,
      sellerId,
      counterpartyRisk: riskScore,
      riskLevel: _riskLevel(riskScore),
      scamFlagged: false,
      record,
      dataQuality: _dataQuality(record),
      cp_version: CP_VERSION,
    };
  } catch (err) {
    return _nullResult(platformId, sellerId);
  }
}

// ── Record: record a transaction event ────────────────────────────────────────

/**
 * Record a new transaction event for a counterparty.
 * Call this whenever:
 *   - A user reports buying from a seller and encountering a problem
 *   - An Evan scan reveals auth mismatch after purchase
 *   - A platform signals a dispute/enforcement action
 *
 * @param {object} redis
 * @param {string} platformId
 * @param {string} sellerId
 * @param {object} event
 *   type            {string}  — "dispute"|"auth_mismatch"|"condition_mismatch"|"return"|"clean"
 *   reportedBy      {string}  — "user"|"platform"|"evan_scan"
 *   scanId          {string|null}  — evan scan that revealed the mismatch
 *   value           {number|null}  — transaction value
 *   notes           {string|null}
 * @returns {Promise<{ ok, record? }>}
 */
export async function recordCounterpartyEvent(redis, platformId, sellerId, event = {}) {
  if (!redis || !platformId || !sellerId) {
    return { ok: false, error: "missing_required" };
  }

  const { type = "clean", reportedBy = "user", scanId = null, value = null, notes = null } = event;

  const validTypes = ["dispute", "auth_mismatch", "condition_mismatch", "return", "clean", "scam_flag"];
  if (!validTypes.includes(type)) {
    return { ok: false, error: "invalid_event_type" };
  }

  try {
    // Handle scam_flag separately — permanent key
    if (type === "scam_flag") {
      const scamRecord = {
        platformId,
        sellerId: _sanitizeId(sellerId),
        reason: notes || "platform_enforcement",
        flaggedAt: Date.now(),
        flaggedBy: reportedBy,
        scanId,
      };
      await redis.set(KEY_SCAM(platformId, sellerId), JSON.stringify(scamRecord), { EX: CP_SCAM_TTL });
      await redis.hIncrBy(KEY_OPS(), "scam_flags", 1);
      return { ok: true, type: "scam_flag", record: scamRecord };
    }

    // Get or create record
    const existingRaw = await redis.get(KEY_RECORD(platformId, sellerId)).catch(() => null);
    let record;
    if (existingRaw) {
      try { record = JSON.parse(existingRaw); }
      catch { record = _newRecord(platformId, sellerId); }
    } else {
      record = _newRecord(platformId, sellerId);
    }

    // Append event to history (keep last 50)
    const now = Date.now();
    const newEvent = {
      type,
      reportedBy,
      scanId,
      value,
      notes,
      recordedAt: now,
    };
    record.events = [...(record.events || []).slice(-49), newEvent];

    // Recompute aggregate stats from full event history
    _recomputeStats(record);
    record.updatedAt = now;
    record.totalEvents = record.events.length;

    await redis.set(KEY_RECORD(platformId, sellerId), JSON.stringify(record), { EX: CP_TTL });
    await redis.hIncrBy(KEY_OPS(), `event.${type}`, 1);

    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: "record_failed", reason: err?.message };
  }
}

// ── Read ops ──────────────────────────────────────────────────────────────────

export async function getCounterpartyRecord(redis, platformId, sellerId) {
  if (!redis || !platformId || !sellerId) return null;
  try {
    const raw = await redis.get(KEY_RECORD(platformId, sellerId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function getCounterpartyOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      scamFlags:         ops["scam_flags"]           || 0,
      disputeEvents:     ops["event.dispute"]        || 0,
      authMismatchEvents:ops["event.auth_mismatch"]  || 0,
      conditionMismatch: ops["event.condition_mismatch"] || 0,
      cleanEvents:       ops["event.clean"]          || 0,
      returnEvents:      ops["event.return"]         || 0,
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _newRecord(platformId, sellerId) {
  return {
    platformId,
    sellerId: _sanitizeId(sellerId),
    events: [],
    totalEvents: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stats: {
      disputeCount:      0,
      authMismatchCount: 0,
      conditionMismatch: 0,
      returnCount:       0,
      cleanCount:        0,
      disputeRate:       0,
      authMismatchRate:  0,
      conditionMismatchRate: 0,
      returnRate:        0,
    },
    cp_version: CP_VERSION,
  };
}

function _recomputeStats(record) {
  const events = record.events || [];
  const total  = events.length || 1;

  let disputes      = 0;
  let authMismatch  = 0;
  let condMismatch  = 0;
  let returns       = 0;
  let clean         = 0;

  for (const ev of events) {
    if (ev.type === "dispute")          disputes++;
    if (ev.type === "auth_mismatch")    authMismatch++;
    if (ev.type === "condition_mismatch") condMismatch++;
    if (ev.type === "return")           returns++;
    if (ev.type === "clean")            clean++;
  }

  record.stats = {
    disputeCount:         disputes,
    authMismatchCount:    authMismatch,
    conditionMismatch:    condMismatch,
    returnCount:          returns,
    cleanCount:           clean,
    disputeRate:          Math.round(disputes / total * 100) / 100,
    authMismatchRate:     Math.round(authMismatch / total * 100) / 100,
    conditionMismatchRate:Math.round(condMismatch / total * 100) / 100,
    returnRate:           Math.round(returns / total * 100) / 100,
  };
}

function _computeRiskScore(record) {
  const stats = record.stats || {};
  const events = record.events || [];

  // Apply time decay: compute a recency-weighted version of each rate
  const now      = Date.now();
  let wDispute   = 0, wAuth = 0, wCond = 0, wReturn = 0;
  let wTotal     = 0;

  for (const ev of events) {
    const age     = now - (ev.recordedAt || now);
    const decay   = Math.pow(0.5, age / DECAY_HALF_LIFE_MS);
    const weight  = decay;
    wTotal       += weight;

    if (ev.type === "dispute")           wDispute += weight;
    if (ev.type === "auth_mismatch")     wAuth    += weight;
    if (ev.type === "condition_mismatch") wCond   += weight;
    if (ev.type === "return")            wReturn  += weight;
  }

  if (wTotal === 0) return 0;

  const decayedDisputeRate  = wDispute / wTotal;
  const decayedAuthRate     = wAuth    / wTotal;
  const decayedCondRate     = wCond    / wTotal;
  const decayedReturnRate   = wReturn  / wTotal;

  // Scam flags checked separately (always override) — but check scamFlags field too
  const scamBoost = (record.stats?.scamFlags || 0) > 0 ? 0.50 : 0;

  const rawScore =
    decayedDisputeRate  * SIGNAL_WEIGHTS.disputeRate     +
    decayedAuthRate     * SIGNAL_WEIGHTS.authMismatchRate +
    decayedCondRate     * SIGNAL_WEIGHTS.conditionMismatch +
    decayedReturnRate   * SIGNAL_WEIGHTS.returnRate       +
    scamBoost           * SIGNAL_WEIGHTS.scamFlags;

  return Math.min(1, Math.max(0, Math.round(rawScore * 1000) / 1000));
}

function _riskLevel(score) {
  if (score >= RISK_THRESHOLDS.HIGH)     return "HIGH";
  if (score >= RISK_THRESHOLDS.MODERATE) return "MODERATE";
  if (score >= RISK_THRESHOLDS.LOW)      return "LOW";
  return "MINIMAL";
}

function _dataQuality(record) {
  const n = record.totalEvents || 0;
  if (n >= 20) return "RICH";
  if (n >= 8)  return "MODERATE";
  if (n >= 3)  return "SPARSE";
  return "INSUFFICIENT";
}

function _nullResult(platformId, sellerId) {
  return {
    platformId,
    sellerId,
    counterpartyRisk: 0,
    riskLevel: "UNKNOWN",
    scamFlagged: false,
    record: null,
    dataQuality: "NO_DATA",
    cp_version: CP_VERSION,
  };
}

function _sanitizeId(id) {
  // Prevent key injection — allow alphanumeric, dash, underscore, dot only
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}
