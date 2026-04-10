// src/selfHealingLedger.js
// Phase 10 — Self-Healing Ledger & Truth Reconciler.
//
// Three-layer defense against agent math errors in a 100+ worker swarm:
//
//   Layer 1 — Drift Detection:
//     Compares agent-claimed totals against the immutable ledger.
//     Rounding drift (<0.01%) → SYSTEM_AUTO_HEAL correction entry.
//     Larger discrepancy → Logic_Exception (flagged, capital blocked).
//
//   Layer 2 — State-Rewind / Price-Spike Guard:
//     Freezes any item where specialist valuation diverges from a
//     subsequent market scan by >40%. No capital can be committed to a
//     frozen item. Enqueues frozen items for an Audit Agent.
//
//   Layer 3 — Synthetic Audit Trail:
//     Every heal event writes a timestamped snapshot capturing agent
//     reasoning, ledger state before/after, and corrective action.
//     Retrieved as structured log entries usable as orchestrator training data.
//
// Redis key layout:
//   p10:heal:audit:{healId}     STRING   audit snapshot (90d TTL)
//   p10:heal:index              ZSET     healId → timestamp (score) for log retrieval
//   p10:heal:frozen:{scanId}    STRING   frozen item record (7d TTL)
//   p10:heal:queue:audit        LIST     scanIds pending Audit Agent (FIFO)
//   p10:heal:ops                HASH     counters

import crypto from "crypto";
import {
  recordAdjustment,
  getEntriesForRelated,
  TXN_DIRECTION,
} from "./transactionLedger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const HEAL_TYPE = Object.freeze({
  AUTO_HEAL:       "AUTO_HEAL",        // rounding correction applied automatically
  LOGIC_EXCEPTION: "LOGIC_EXCEPTION",  // drift too large — capital blocked, flagged
  PRICE_FREEZE:    "PRICE_FREEZE",     // market scan diverged >40% from specialist
  AUDIT_RESOLVED:  "AUDIT_RESOLVED",   // audit agent cleared a frozen item
  AUDIT_REJECTED:  "AUDIT_REJECTED",   // audit agent confirmed error, item scrubbed
});

export const FREEZE_STATUS = Object.freeze({
  FROZEN:   "FROZEN",
  RESOLVED: "RESOLVED",
  REJECTED: "REJECTED",
});

// Auto-heal threshold: drift < 0.01% of total is considered a rounding artifact
const AUTO_HEAL_THRESHOLD_PCT = 0.0001;

// Price-spike guard: specialist vs market delta > 40% triggers freeze
const PRICE_DELTA_FREEZE_PCT = 0.40;

// Confidence floor — mirrors affiliateRouter + swarmOrchestrator
const CONFIDENCE_FLOOR = 65;

const AUDIT_TTL   = 90 * 86400;  // 90 days — audit trail persistence
const FREEZE_TTL  = 7  * 86400;  // 7 days — frozen items auto-expire if never resolved

const KEY_AUDIT  = (id)     => `p10:heal:audit:${id}`;
const KEY_INDEX  = ()       => `p10:heal:index`;
const KEY_FROZEN = (scanId) => `p10:heal:frozen:${scanId}`;
const KEY_QUEUE  = ()       => `p10:heal:queue:audit`;
const KEY_OPS    = ()       => `p10:heal:ops`;

// ── Layer 1: Drift Detection ──────────────────────────────────────────────────

/**
 * Detect and optionally auto-heal drift between what an agent claims was paid
 * and what the immutable ledger records for that lot.
 *
 * Drift < 0.01% of total  → SYSTEM_AUTO_HEAL correction entry + audit record.
 * Drift ≥ 0.01%            → Logic_Exception, no money moved, audit record.
 *
 * @param {object} redis
 * @param {object} opts
 *   lotId          {string}   lot being reconciled
 *   userId         {string}   lot owner
 *   agentClaimedTotal {number} what the agent believes was spent (total_paid)
 *   lotDistBasis   {number}   reference basis from lot distribution record
 *   agentId        {string}   workerId / jobId for attribution
 *   agentReasoning {string}   free-text rationale from the agent (for audit trail)
 * @returns {DriftResult}
 */
export async function detectLedgerDrift(redis, {
  lotId,
  userId,
  agentClaimedTotal,
  lotDistBasis,
  agentId        = "unknown",
  agentReasoning = "",
} = {}) {
  if (!redis)             return { ok: false, error: "no_redis" };
  if (!lotId || !userId)  return { ok: false, error: "missing_lot_or_user" };

  const claimed = Number(agentClaimedTotal);
  const basis   = Number(lotDistBasis);
  if (!Number.isFinite(claimed) || !Number.isFinite(basis) || basis <= 0) {
    return { ok: false, error: "invalid_amounts" };
  }

  // Pull all ledger DEBIT entries linked to this lot (PURCHASE + SHIPPING_COST + FEE)
  const entries      = await getEntriesForRelated(redis, lotId, { limit: 500 }).catch(() => []);
  const ledgerDebits = entries
    .filter(e => e.direction === TXN_DIRECTION.DEBIT && e.type !== "ADJUSTMENT")
    .reduce((s, e) => s + (e.amount || 0), 0);

  // Primary drift: agent vs ledger debits
  const ledgerDrift   = Math.abs(claimed - ledgerDebits);
  const ledgerDriftPct = ledgerDebits > 0 ? ledgerDrift / ledgerDebits : ledgerDrift / claimed;

  // Secondary drift: agent vs lot distribution basis
  const basisDrift    = Math.abs(claimed - basis);
  const basisDriftPct = basisDrift / basis;

  // Use the larger of the two drifts as the operative figure
  const drift    = Math.max(ledgerDrift, basisDrift);
  const driftPct = Math.max(ledgerDriftPct, basisDriftPct);

  const ledgerStateBefore = {
    ledgerDebits:    r2(ledgerDebits),
    agentClaimedTotal: r2(claimed),
    lotDistBasis:    r2(basis),
    basisDrift:      r2(basisDrift),
    ledgerDrift:     r2(ledgerDrift),
    driftPct:        r4(driftPct * 100),  // as percent for readability
    entryCount:      entries.length,
  };

  // ── AUTO-HEAL branch ───────────────────────────────────────────────────────
  if (driftPct < AUTO_HEAL_THRESHOLD_PCT) {
    const correctionAmount = r2(basis - claimed);
    const healDescription  = `SYSTEM_AUTO_HEAL: lot ${lotId} drift ${r4(driftPct * 100)}% (${r2(drift)}) — rounding correction applied by selfHealingLedger`;

    const ledgerEntry = await recordAdjustment(redis, userId, {
      amount:           Math.abs(correctionAmount),
      invId:            lotId,
      adjustmentReason: healDescription,
      description:      healDescription,
      recordedBy:       "selfHealingLedger:AUTO_HEAL",
    }).catch(() => null);

    const audit = await _writeAuditRecord(redis, {
      healType:          HEAL_TYPE.AUTO_HEAL,
      lotId,
      userId,
      agentId,
      agentReasoning,
      ledgerStateBefore,
      correctiveAction:  { type: "CORRECTION_ENTRY", amount: correctionAmount, txnId: ledgerEntry?.txnId || null },
      ledgerStateAfter:  { ...ledgerStateBefore, drift: 0, correctionApplied: true },
      resolved:          true,
      note:              healDescription,
    });

    await redis.hincrby(KEY_OPS(), "auto_heals", 1).catch(() => {});
    return {
      ok:              true,
      healType:        HEAL_TYPE.AUTO_HEAL,
      drift:           r2(drift),
      driftPct:        r4(driftPct * 100),
      correctionAmount,
      txnId:           ledgerEntry?.txnId || null,
      healId:          audit.healId,
      capitalBlocked:  false,
    };
  }

  // ── LOGIC_EXCEPTION branch ────────────────────────────────────────────────
  const note = `Logic_Exception: lot ${lotId} drift ${r4(driftPct * 100)}% exceeds auto-heal threshold. Capital commitment blocked. Agent: ${agentId}`;

  const audit = await _writeAuditRecord(redis, {
    healType:         HEAL_TYPE.LOGIC_EXCEPTION,
    lotId,
    userId,
    agentId,
    agentReasoning,
    ledgerStateBefore,
    correctiveAction: { type: "CAPITAL_BLOCKED", reason: "drift_exceeds_threshold" },
    ledgerStateAfter: ledgerStateBefore,   // no change — block only
    resolved:         false,
    note,
  });

  await redis.hincrby(KEY_OPS(), "logic_exceptions", 1).catch(() => {});
  return {
    ok:             true,
    healType:       HEAL_TYPE.LOGIC_EXCEPTION,
    drift:          r2(drift),
    driftPct:       r4(driftPct * 100),
    capitalBlocked: true,
    healId:         audit.healId,
    note,
  };
}

// ── Layer 2: State-Rewind / Price-Spike Guard ─────────────────────────────────

/**
 * Compare a specialist's valuation against a subsequent market scan.
 * If confidence was above the floor but prices diverge >40%,
 * freeze the item and enqueue for an Audit Agent.
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId           {string}   item identifier
 *   userId           {string}
 *   workerId         {string}   specialist workerId that issued the valuation
 *   specialistValue  {number}   specialist's estimated value
 *   marketScanValue  {number}   subsequent market scan price
 *   confidence       {number}   visionConfidence (0–100 or 0–1, auto-normalized)
 *   agentReasoning   {string}
 *   lotId            {string}   parent lot (for ledger correlation)
 * @returns {RewindResult}
 */
export async function rollbackToLastKnownTruth(redis, {
  scanId,
  userId,
  workerId        = "unknown",
  specialistValue,
  marketScanValue,
  confidence,
  agentReasoning  = "",
  lotId           = null,
} = {}) {
  if (!redis)              return { ok: false, error: "no_redis" };
  if (!scanId || !userId)  return { ok: false, error: "missing_scan_or_user" };

  const specVal  = Number(specialistValue);
  const mktVal   = Number(marketScanValue);
  if (!Number.isFinite(specVal) || specVal <= 0) return { ok: false, error: "invalid_specialist_value" };
  if (!Number.isFinite(mktVal)  || mktVal  <= 0) return { ok: false, error: "invalid_market_value" };

  // Normalize confidence
  const confRaw = Number(confidence);
  const confPct = Number.isFinite(confRaw) ? (confRaw <= 1 ? r2(confRaw * 100) : r2(confRaw)) : null;

  // Price delta — relative to the higher of the two (conservative)
  const higher   = Math.max(specVal, mktVal);
  const delta    = Math.abs(specVal - mktVal);
  const deltaPct = delta / higher;

  const shouldFreeze = deltaPct > PRICE_DELTA_FREEZE_PCT && (confPct == null || confPct >= CONFIDENCE_FLOOR);

  const ledgerStateBefore = {
    scanId,
    specialistValue: r2(specVal),
    marketScanValue: r2(mktVal),
    delta:           r2(delta),
    deltaPct:        r4(deltaPct * 100),
    confidence:      confPct,
    workerId,
    lotId,
  };

  if (!shouldFreeze) {
    // Delta within acceptable range — no action needed
    return {
      ok:      true,
      frozen:  false,
      deltaPct: r4(deltaPct * 100),
      note:    "delta_within_threshold",
    };
  }

  // ── Freeze the item ───────────────────────────────────────────────────────
  const existingFreeze = await redis.get(KEY_FROZEN(scanId)).catch(() => null);
  if (existingFreeze) {
    // Already frozen — don't double-queue, just return current state
    const freeze = JSON.parse(existingFreeze);
    return { ok: true, frozen: true, alreadyFrozen: true, freezeId: freeze.freezeId };
  }

  const freezeId = `frz_${crypto.randomBytes(6).toString("hex")}`;
  const freezeRecord = {
    freezeId,
    scanId,
    userId,
    workerId,
    lotId,
    status:          FREEZE_STATUS.FROZEN,
    specialistValue: r2(specVal),
    marketScanValue: r2(mktVal),
    deltaPct:        r4(deltaPct * 100),
    confidence:      confPct,
    frozenAt:        Date.now(),
    resolution:      null,
    resolvedAt:      null,
    resolvedBy:      null,
  };

  await redis.set(KEY_FROZEN(scanId), JSON.stringify(freezeRecord), "EX", FREEZE_TTL).catch(() => {});

  // Enqueue for Audit Agent
  await redis.rpush(KEY_QUEUE(), JSON.stringify({
    freezeId, scanId, userId, workerId, lotId,
    deltaPct: r4(deltaPct * 100), confidence: confPct, queuedAt: Date.now(),
  })).catch(() => {});

  const note = `PRICE_FREEZE: item ${scanId} frozen. Specialist $${r2(specVal)} vs market $${r2(mktVal)} = ${r4(deltaPct * 100)}% delta exceeds 40% threshold. Capital blocked pending Audit Agent.`;

  const audit = await _writeAuditRecord(redis, {
    healType:         HEAL_TYPE.PRICE_FREEZE,
    lotId,
    userId,
    agentId:          workerId,
    agentReasoning,
    ledgerStateBefore,
    correctiveAction: { type: "ITEM_FROZEN", freezeId, auditQueued: true },
    ledgerStateAfter: { ...ledgerStateBefore, frozen: true, freezeId },
    resolved:         false,
    note,
  });

  await redis.hincrby(KEY_OPS(), "price_freezes", 1).catch(() => {});
  return {
    ok:           true,
    frozen:       true,
    freezeId,
    deltaPct:     r4(deltaPct * 100),
    healId:       audit.healId,
    auditQueued:  true,
    capitalBlocked: true,
    note,
  };
}

/**
 * Check if an item is currently frozen (blocks ACQUIRING in swarm).
 *
 * @returns {{ frozen: boolean, freezeId?: string, deltaPct?: number }}
 */
export async function isItemFrozen(redis, scanId) {
  if (!redis || !scanId) return { frozen: false };
  try {
    const raw = await redis.get(KEY_FROZEN(scanId));
    if (!raw) return { frozen: false };
    const rec = JSON.parse(raw);
    return {
      frozen:    rec.status === FREEZE_STATUS.FROZEN,
      freezeId:  rec.freezeId,
      deltaPct:  rec.deltaPct,
      frozenAt:  rec.frozenAt,
    };
  } catch { return { frozen: false }; }
}

/**
 * Audit Agent resolution — unfreeze and commit or reject.
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId        {string}
 *   auditAgentId  {string}   ID of the Audit Agent resolving
 *   resolution    {string}   "RESOLVED" | "REJECTED"
 *   correctedValue {number}  Audit Agent's corrected value (required for RESOLVED)
 *   note          {string}
 */
export async function resolveAuditItem(redis, {
  scanId,
  auditAgentId   = "audit_agent",
  resolution,
  correctedValue = null,
  note           = "",
} = {}) {
  if (!redis || !scanId)  return { ok: false, error: "missing_args" };
  if (resolution !== FREEZE_STATUS.RESOLVED && resolution !== FREEZE_STATUS.REJECTED) {
    return { ok: false, error: "invalid_resolution" };
  }

  const raw = await redis.get(KEY_FROZEN(scanId)).catch(() => null);
  if (!raw) return { ok: false, error: "freeze_not_found" };

  const freeze = JSON.parse(raw);
  if (freeze.status !== FREEZE_STATUS.FROZEN) {
    return { ok: false, error: "item_not_frozen" };
  }

  freeze.status      = resolution;
  freeze.resolvedAt  = Date.now();
  freeze.resolvedBy  = auditAgentId;
  freeze.resolution  = { correctedValue, note };

  await redis.set(KEY_FROZEN(scanId), JSON.stringify(freeze), "EX", FREEZE_TTL).catch(() => {});

  const healType = resolution === FREEZE_STATUS.RESOLVED
    ? HEAL_TYPE.AUDIT_RESOLVED
    : HEAL_TYPE.AUDIT_REJECTED;

  const audit = await _writeAuditRecord(redis, {
    healType,
    lotId:   freeze.lotId,
    userId:  freeze.userId,
    agentId: auditAgentId,
    agentReasoning: note,
    ledgerStateBefore: { freezeId: freeze.freezeId, status: FREEZE_STATUS.FROZEN },
    correctiveAction:  { type: resolution, correctedValue, resolvedBy: auditAgentId },
    ledgerStateAfter:  { freezeId: freeze.freezeId, status: resolution, correctedValue },
    resolved: true,
    note,
  });

  const opKey = resolution === FREEZE_STATUS.RESOLVED ? "audit_resolutions" : "audit_rejections";
  await redis.hincrby(KEY_OPS(), opKey, 1).catch(() => {});

  return { ok: true, healType, freezeId: freeze.freezeId, healId: audit.healId };
}

// ── Layer 3: Synthetic Audit Trail ───────────────────────────────────────────

/**
 * Retrieve audit log entries, newest first.
 *
 * @param {object} redis
 * @param {object} opts
 *   limit   {number}   max entries (default: 50)
 *   offset  {number}   skip N newest entries (default: 0)
 *   type    {string}   filter by HEAL_TYPE (optional)
 * @returns {{ entries: AuditRecord[], total: number }}
 */
export async function getSelfHealingAuditLog(redis, { limit = 50, offset = 0, type = null } = {}) {
  if (!redis) return { entries: [], total: 0 };
  try {
    // ZSET sorted by timestamp — retrieve newest first
    const total = await redis.zcard(KEY_INDEX()).catch(() => 0);
    const ids   = await redis.zrevrange(KEY_INDEX(), offset, offset + limit - 1).catch(() => []);

    if (!ids.length) return { entries: [], total };

    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_AUDIT(id));
    const results = await pipe.exec();

    const entries = [];
    for (const [, raw] of results) {
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw);
        if (!type || entry.healType === type) entries.push(entry);
      } catch {}
    }

    return { entries, total };
  } catch { return { entries: [], total: 0 }; }
}

/**
 * Drain the audit queue — returns items pending Audit Agent review.
 *
 * @param {object} redis
 * @param {number} limit   max items to dequeue (default: 10)
 * @returns {{ items: object[] }}
 */
export async function drainAuditQueue(redis, limit = 10) {
  if (!redis) return { items: [] };
  const items = [];
  for (let i = 0; i < limit; i++) {
    const raw = await redis.lpop(KEY_QUEUE()).catch(() => null);
    if (!raw) break;
    try { items.push(JSON.parse(raw)); } catch {}
  }
  return { items };
}

/**
 * Aggregate ops counters for the self-healing system.
 */
export async function getSelfHealingOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      autoHeals:        ops["auto_heals"]        || 0,
      logicExceptions:  ops["logic_exceptions"]  || 0,
      priceFreezes:     ops["price_freezes"]     || 0,
      auditResolutions: ops["audit_resolutions"] || 0,
      auditRejections:  ops["audit_rejections"]  || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Write a heal audit record and index it.
 * @internal
 * @returns {{ healId: string }}
 */
async function _writeAuditRecord(redis, {
  healType,
  lotId,
  userId,
  agentId,
  agentReasoning,
  ledgerStateBefore,
  correctiveAction,
  ledgerStateAfter,
  resolved,
  note,
}) {
  const healId  = `heal_${crypto.randomBytes(8).toString("hex")}`;
  const ts      = Date.now();

  const record = {
    healId,
    healType,
    lotId:            lotId  || null,
    userId:           userId || null,
    agentId:          agentId || null,
    agentReasoning:   agentReasoning || null,
    ledgerStateBefore,
    correctiveAction,
    ledgerStateAfter,
    resolved:         !!resolved,
    note:             note || null,
    recordedAt:       ts,
  };

  const pipe = redis.pipeline ? redis.pipeline() : redis.multi();
  pipe.set(KEY_AUDIT(healId), JSON.stringify(record), "EX", AUDIT_TTL);
  pipe.zadd(KEY_INDEX(), ts, healId);
  pipe.hincrby(KEY_OPS(), "total_heal_events", 1);
  await pipe.exec().catch(() => {});

  return { healId };
}

function r2(n) { return Math.round(n * 100) / 100; }
function r4(n) { return Math.round(n * 10000) / 10000; }
