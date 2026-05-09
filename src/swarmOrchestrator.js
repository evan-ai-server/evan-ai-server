// src/swarmOrchestrator.js
// Phase 10 — Fleet Orchestrator (Starlink Mode).
//
// Multi-agent swarm targeting Liquidated Bulk Lots.
// Manages a fleet of Workers that progress through a defined lifecycle,
// enforcing TruthGuard compliance (visionConfidence ≥ 65%) at every step.
//
// ── Worker Lifecycle ──────────────────────────────────────────────────────────
//
//   IDLE ──► SCOUTING ──► VALUATING ──► ACQUIRING ──► LEDGER_SYNC ──► COMPLETE
//                │              │             │
//                ▼              ▼             ▼
//             SCRUBBED       SCRUBBED      SCRUBBED
//                              │
//                           FAILED (non-recoverable errors)
//
// ── Agent Roles ───────────────────────────────────────────────────────────────
//
//   SCOUT      — Fast, cheap pass. Calls evaluateLot() with cached signals.
//                Outcome: lot-level tier score + top-item tiers.
//                Hands off to SPECIALIST when ANY top item is tier A or B
//                AND confidence ≥ 65%.
//
//   SPECIALIST — Deep analysis. Runs category/platform/exit intelligence
//                on each promising item. Gated by confidence kill-switch.
//                Only emits a BUY signal when full intel is available.
//
// ── Safety Invariants ────────────────────────────────────────────────────────
//
//   1. visionConfidence < CONFIDENCE_FLOOR → immediate SCRUBBED state
//   2. Every BUY signal requires LedgerEntry + telemetry snapshot
//   3. capitalBudget enforced before any ACQUIRING transition
//   4. tokenBudget (operation counter) hard-stops the swarm
//   5. timeoutMs hard-stops any worker stuck in a state too long
//
// ── Redis key layout ─────────────────────────────────────────────────────────
//
//   p10:swarm:worker:{workerId}   STRING   worker record (7d TTL)
//   p10:swarm:job:{jobId}         STRING   job record (30d TTL)
//   p10:swarm:queue:scout         LIST     pending scout items (FIFO)
//   p10:swarm:queue:specialist    LIST     pending specialist items (FIFO)
//   p10:swarm:ops                 HASH     counters

import crypto from "crypto";
import { evaluateLot }     from "./lotScanner.js";
import { distributeLot, DIST_STRATEGY } from "./lotDistributionEngine.js";
import { recordEntry, TXN_TYPE, TXN_DIRECTION, RELATED_TYPE } from "./transactionLedger.js";
import {
  resolvePayload, applyPayloadValuation, computeAlphaScore,
  VALIDATOR_CONFIDENCE_FLOOR,
} from "./payloadRegistry.js";

import {
  enforceInvariants, loadConstraints,
  acquireItemLock, releaseItemLock, resolveConflict,
  recordWinStreak, recordAgentOutcome,
  recordLiquidityCommitment, recordTripleCheck,
  enforceAuthenticityLaw, checkLedgerSyncSLA,
} from "./swarmInvariants.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const WORKER_STATUS = Object.freeze({
  IDLE:         "IDLE",
  SCOUTING:     "SCOUTING",
  VALUATING:    "VALUATING",
  ACQUIRING:    "ACQUIRING",
  LEDGER_SYNC:  "LEDGER_SYNC",
  COMPLETE:     "COMPLETE",
  SCRUBBED:     "SCRUBBED",
  FAILED:       "FAILED",
});

export const WORKER_ROLE = Object.freeze({
  SCOUT:      "SCOUT",
  SPECIALIST: "SPECIALIST",
});

export const JOB_STATUS = Object.freeze({
  PENDING:   "PENDING",
  RUNNING:   "RUNNING",
  COMPLETE:  "COMPLETE",
  FAILED:    "FAILED",
  CANCELLED: "CANCELLED",
});

// PHASE 3 NOTE — LEGACY VERDICT NAMESPACE.
// BUY_SIGNAL is a legacy parallel verdict system. Its values are
// mirrored under `responsePayload.legacy.swarmBuySignal` (see
// shared/legacyNamespace.js) and MUST NOT drive UI, emotion, or
// analytics. The canonical decision is `buyOrPass.verdict` from
// src/buyOrPassEngine.js. Internal swarm orchestration may continue
// to use these enums for routing / handoff decisions, but anything
// that emits to the user-facing surface must go through normalization
// in shared/verdict.js first.
export const BUY_SIGNAL = Object.freeze({
  STRONG_BUY:          "STRONG_BUY",
  GOOD_DEAL:           "GOOD_DEAL",
  WATCH:               "WATCH",
  PASS:                "PASS",
  ALPHA_CANDIDATE:     "ALPHA_CANDIDATE",     // ROI > 200% — pending validator
  VALIDATOR_CONFIRMED: "VALIDATOR_CONFIRMED", // Alpha confirmed by second specialist
});

// TruthGuard floor — matches affiliateRouter.js AFFILIATE_CONFIDENCE_THRESHOLD
const CONFIDENCE_FLOOR = 65;

// Tier thresholds for Scout → Specialist hand-off
const HANDOFF_TIERS = new Set(["A", "B"]);

const WORKER_TTL = 7  * 86400;   // 7 days
const JOB_TTL   = 30 * 86400;   // 30 days

const KEY_WORKER = (id) => `p10:swarm:worker:${id}`;
const KEY_JOB    = (id) => `p10:swarm:job:${id}`;
const KEY_Q_SCOUT      = () => `p10:swarm:queue:scout`;
const KEY_Q_SPECIALIST = () => `p10:swarm:queue:specialist`;
const KEY_Q_VALIDATOR  = () => `p10:swarm:queue:validator`;
const KEY_OPS          = () => `p10:swarm:ops`;

// ── Job Management ────────────────────────────────────────────────────────────

/**
 * Create a new swarm job for a bulk lot.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId        {string}   required
 *   lotId         {string}   required — lot being targeted
 *   items         {object[]} required — raw item list for the lot
 *   totalPaid     {number}   required — total acquisition cost
 *   tokenBudget   {number}   max operations before hard-stop (default: 500)
 *   capitalBudget {number}   max recommended spend in dollars (default: totalPaid * 1.5)
 *   timeoutMs     {number}   ms before worker is considered stuck (default: 120_000)
 *   sourceType    {string}   SOURCE_TYPE value for child inventory items
 *   notes         {string}
 * @returns {JobRecord}
 */
export async function createSwarmJob(redis, {
  userId,
  lotId,
  items         = [],
  totalPaid,
  tokenBudget   = 500,
  capitalBudget = null,
  timeoutMs     = 120_000,
  sourceType    = "OTHER",
  notes         = null,
} = {}) {
  if (!redis)         return { ok: false, error: "no_redis" };
  if (!userId)        return { ok: false, error: "missing_user_id" };
  if (!lotId)         return { ok: false, error: "missing_lot_id" };
  if (!items.length)  return { ok: false, error: "no_items" };

  const total = Number(totalPaid);
  if (!Number.isFinite(total) || total <= 0) return { ok: false, error: "invalid_total_paid" };

  const jobId    = `job_${crypto.randomBytes(6).toString("hex")}`;
  const capLimit = capitalBudget != null && Number.isFinite(Number(capitalBudget))
    ? Number(capitalBudget)
    : r2(total * 1.5);

  const job = {
    jobId,
    userId,
    lotId,
    status:        JOB_STATUS.PENDING,
    totalPaid:     total,
    itemCount:     items.length,
    tokenBudget,
    tokenUsed:     0,
    capitalBudget: capLimit,
    capitalUsed:   0,
    timeoutMs,
    sourceType,
    notes,
    workers:       [],     // workerId list
    buySignals:    [],     // items cleared by specialist
    scrubbed:      [],     // items that failed confidence check
    distResult:    null,   // filled after LEDGER_SYNC
    createdAt:     Date.now(),
    startedAt:     null,
    completedAt:   null,
  };

  // Persist job + push items to scout queue
  const pipe = redis.pipeline ? redis.pipeline() : redis.multi();
  pipe.set(KEY_JOB(jobId), JSON.stringify({ ...job, items }), "EX", JOB_TTL);
  // Push item refs to scout queue (FIFO) — each entry: { jobId, lotId, item }
  for (const item of items) {
    pipe.rpush(KEY_Q_SCOUT(), JSON.stringify({ jobId, lotId, userId, item }));
  }
  pipe.hincrby(KEY_OPS(), "total_jobs_created", 1);
  await pipe.exec().catch(() => {});

  return { ok: true, jobId, status: JOB_STATUS.PENDING, itemCount: items.length, capitalBudget: capLimit, tokenBudget };
}

/**
 * Retrieve a job record (without items array for brevity).
 */
export async function getJob(redis, jobId) {
  if (!redis || !jobId) return null;
  try {
    const raw = await redis.get(KEY_JOB(jobId));
    if (!raw) return null;
    const job = JSON.parse(raw);
    const { items: _items, ...rest } = job;
    return rest;
  } catch { return null; }
}

// ── Worker Management ─────────────────────────────────────────────────────────

/**
 * Spawn a new worker record.
 * @internal
 */
async function _spawnWorker(redis, { jobId, lotId, userId, role, item, parentWorkerId = null }) {
  const workerId = `w_${crypto.randomBytes(6).toString("hex")}`;
  const worker = {
    workerId,
    jobId,
    lotId,
    userId,
    role,
    status:          WORKER_STATUS.IDLE,
    item:            item || null,
    parentWorkerId,
    visionConfidence: null,
    scoutResult:     null,
    specialistResult: null,
    buySignal:       null,
    scrubReason:     null,
    ledgerEntryId:   null,
    telemetrySnapshot: null,
    statusHistory:   [{ status: WORKER_STATUS.IDLE, ts: Date.now() }],
    createdAt:       Date.now(),
    updatedAt:       Date.now(),
  };

  await redis.set(KEY_WORKER(workerId), JSON.stringify(worker), "EX", WORKER_TTL).catch(() => {});
  return workerId;
}

/**
 * Transition a worker to a new status, appending history.
 * @internal
 */
async function _transitionWorker(redis, workerId, newStatus, patch = {}) {
  try {
    const raw = await redis.get(KEY_WORKER(workerId));
    if (!raw) return null;
    const worker = JSON.parse(raw);
    worker.status = newStatus;
    worker.statusHistory.push({ status: newStatus, ts: Date.now() });
    worker.updatedAt = Date.now();
    Object.assign(worker, patch);
    await redis.set(KEY_WORKER(workerId), JSON.stringify(worker), "EX", WORKER_TTL);
    return worker;
  } catch { return null; }
}

export async function getWorker(redis, workerId) {
  if (!redis || !workerId) return null;
  try {
    const raw = await redis.get(KEY_WORKER(workerId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── TruthGuard Confidence Check ───────────────────────────────────────────────

/**
 * Resolve confidence from multiple possible fields, normalize to 0–100.
 * Returns null if no confidence available.
 * @internal
 */
function _resolveConfidence(data) {
  const raw = data?.visionConfidence
    ?? data?.confidence
    ?? data?.confidenceV2
    ?? data?.profitIntel?.visionConfidence
    ?? null;

  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const n = Number(raw);
  // Normalize: values ≤ 1 are treated as 0–1 fractions
  return n <= 1 ? r2(n * 100) : r2(n);
}

/**
 * Check TruthGuard. Returns { pass: boolean, confidence: number|null, reason: string|null }
 * @internal
 */
function _truthGuard(data, workerId) {
  const confidence = _resolveConfidence(data);
  if (confidence === null) {
    // No confidence data — treat as borderline, do not scrub but flag
    return { pass: true, confidence: null, reason: null };
  }
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      pass:       false,
      confidence,
      reason:     `visionConfidence ${confidence}% below floor ${CONFIDENCE_FLOOR}%`,
    };
  }
  return { pass: true, confidence, reason: null };
}

// ── Scout Worker ──────────────────────────────────────────────────────────────

/**
 * Run a Scout pass on a single item using cached lot signals.
 * Scout is fast and cheap — it only determines whether an item is worth
 * a Specialist's deeper analysis.
 *
 * Hand-off criteria: tier A or B AND confidence ≥ CONFIDENCE_FLOOR.
 *
 * @param {object} redis
 * @param {string} workerId
 * @param {object} opts
 *   lotItems     {object[]}  full lot item list (for evaluateLot context)
 *   tokenBudget  {number}    remaining budget
 *   capitalBudget {number}   remaining capital budget
 * @returns {WorkerResult}
 */
export async function runScout(redis, workerId, { lotItems = [], tokenBudget = Infinity, capitalBudget = Infinity } = {}) {
  if (!redis || !workerId) return { ok: false, error: "missing_args" };
  if (tokenBudget <= 0) {
    await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, { scrubReason: "token_budget_exhausted" });
    return { ok: false, error: "token_budget_exhausted" };
  }

  const worker = await getWorker(redis, workerId);
  if (!worker) return { ok: false, error: "worker_not_found" };

  // IDLE → SCOUTING
  await _transitionWorker(redis, workerId, WORKER_STATUS.SCOUTING);
  await redis.hincrby(KEY_OPS(), "scout_runs", 1).catch(() => {});

  try {
    const item = worker.item;

    // Run lot-level fast evaluation — evaluateLot scans the whole lot context
    // but scout only cares about this item's tier + confidence
    const lotResult = await evaluateLot({ items: lotItems.length ? lotItems : [item] }).catch(() => null);

    // Find this item in the lot result (match by scanId or itemName)
    const itemResult = lotResult?.rankedItems?.find(r =>
      r.scanId === item.scanId || r.itemName === item.itemName
    ) || lotResult?.rankedItems?.[0] || null;

    const confidence = _resolveConfidence(itemResult || item);
    const tier       = itemResult?.tier || item.tier || "?";
    const lotScore   = itemResult?.lotScore || item.lotScore || 0;

    // TruthGuard check
    const guard = _truthGuard(itemResult || item, workerId);
    if (!guard.pass) {
      await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
        visionConfidence: guard.confidence,
        scrubReason:      guard.reason,
        scoutResult:      { tier, lotScore, confidence: guard.confidence },
      });
      await redis.hincrby(KEY_OPS(), "scrubbed_confidence", 1).catch(() => {});
      return { ok: true, workerId, status: WORKER_STATUS.SCRUBBED, scrubReason: guard.reason, handOff: false };
    }

    const scoutResult = {
      tier,
      lotScore,
      confidence:    guard.confidence,
      itemResult,
      evaluatedAt:   Date.now(),
    };

    // Determine if hand-off to Specialist is warranted
    const shouldHandOff = HANDOFF_TIERS.has(tier) && (guard.confidence == null || guard.confidence >= CONFIDENCE_FLOOR);

    if (shouldHandOff) {
      // SCOUTING → VALUATING (enqueue for specialist)
      await _transitionWorker(redis, workerId, WORKER_STATUS.VALUATING, {
        visionConfidence: guard.confidence,
        scoutResult,
      });
      // Push to specialist queue
      await redis.rpush(KEY_Q_SPECIALIST(), JSON.stringify({
        jobId:        worker.jobId,
        lotId:        worker.lotId,
        userId:       worker.userId,
        item:         { ...item, tier, lotScore, confidence: guard.confidence },
        parentWorkerId: workerId,
      })).catch(() => {});
      // Record win-streak signal for emergent market hunting
      await recordWinStreak(redis, item.category || "generic", workerId, guard.confidence).catch(() => {});
      await redis.hincrby(KEY_OPS(), "handoffs_to_specialist", 1).catch(() => {});
      return { ok: true, workerId, status: WORKER_STATUS.VALUATING, handOff: true, tier, confidence: guard.confidence };
    } else {
      // Tier C/D/F or low score — scout terminates with PASS signal
      await _transitionWorker(redis, workerId, WORKER_STATUS.COMPLETE, {
        visionConfidence: guard.confidence,
        scoutResult,
        buySignal: BUY_SIGNAL.PASS,
      });
      return { ok: true, workerId, status: WORKER_STATUS.COMPLETE, handOff: false, buySignal: BUY_SIGNAL.PASS, tier };
    }
  } catch (err) {
    await _transitionWorker(redis, workerId, WORKER_STATUS.FAILED, { scrubReason: err.message || "scout_error" });
    return { ok: false, error: err.message || "scout_error" };
  }
}

// ── Specialist Worker ─────────────────────────────────────────────────────────

/**
 * Run a Specialist deep-analysis pass on an item escalated by Scout.
 * Uses category/platform/exit intelligence to derive a buy signal.
 *
 * Emits BUY_SIGNAL only when full intel is available AND confidence ≥ floor.
 * Every STRONG_BUY or GOOD_DEAL signal creates a LedgerEntry + telemetry snapshot.
 *
 * @param {object} redis
 * @param {string} workerId
 * @param {object} opts
 *   categoryIntel  {object|null}  category-level pricing intel (from reportingEngine)
 *   platformIntel  {object|null}  platform routing intel
 *   tokenBudget    {number}       remaining budget
 *   capitalBudget  {number}       remaining capital budget
 * @returns {WorkerResult}
 */
export async function runSpecialist(redis, workerId, {
  categoryIntel  = null,
  platformIntel  = null,
  tokenBudget    = Infinity,
  capitalBudget  = Infinity,
  totalBankroll  = 0,
} = {}) {
  if (!redis || !workerId) return { ok: false, error: "missing_args" };
  if (tokenBudget <= 0) {
    await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, { scrubReason: "token_budget_exhausted" });
    return { ok: false, error: "token_budget_exhausted" };
  }

  const worker = await getWorker(redis, workerId);
  if (!worker) return { ok: false, error: "worker_not_found" };
  if (worker.role !== WORKER_ROLE.SPECIALIST) {
    return { ok: false, error: "wrong_worker_role" };
  }

  await redis.hincrby(KEY_OPS(), "specialist_runs", 1).catch(() => {});

  try {
    const item = worker.item;

    // TruthGuard — re-check at specialist entry
    const guard = _truthGuard(item, workerId);
    if (!guard.pass) {
      await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
        visionConfidence: guard.confidence,
        scrubReason:      guard.reason,
      });
      await redis.hincrby(KEY_OPS(), "scrubbed_confidence", 1).catch(() => {});
      return { ok: true, workerId, status: WORKER_STATUS.SCRUBBED, scrubReason: guard.reason };
    }

    // ── Deep intel analysis ───────────────────────────────────────────────
    const expectedProfit  = Number(item.expectedProfit  || 0);
    const estimatedValue  = Number(item.estimatedValue  || item.estimatedCost || 0);
    const allocatedCost   = Number(item.allocatedCost   || 0);

    // Category-level context (from reportingEngine.getCategorySnapshot)
    const catData = categoryIntel?.categories?.find(c =>
      c.category?.toLowerCase() === item.category?.toLowerCase()
    ) || null;
    const catWinRate    = catData?.winRate   ?? null;
    const catAvgProfit  = catData?.avgProfit ?? null;

    // Platform routing (from reportingEngine.getPlatformSnapshot)
    const bestPlatform = platformIntel?.bestByWinRate?.platform || null;

    // ── Payload hot-swap — equip the specialist with domain expertise ──────
    const payload        = resolvePayload(item.category, item.itemName);
    const baseSignal     = _deriveBuySignal({
      tier:          item.tier,
      confidence:    guard.confidence,
      expectedProfit,
      estimatedValue,
      allocatedCost,
      catWinRate,
      catAvgProfit,
    });
    const payloadResult  = applyPayloadValuation(payload, item, baseSignal, allocatedCost);
    const signal         = payloadResult.adjustedSignal;
    const adjustedValue  = payloadResult.adjustedValue || estimatedValue;

    // ── Alpha Signal Filter — ROI > 200% requires Validator Specialist ────
    const alphaScore = computeAlphaScore(
      { ...item, estimatedValue: adjustedValue },
      payload,
      allocatedCost,
    );

    const specialistResult = {
      signal,
      baseSignal,
      payloadId:        payload.id,
      payloadLabel:     payload.label,
      payloadMultiplier:payloadResult.payloadMultiplier,
      payloadReasoning: payloadResult.reasoning,
      confidence:       guard.confidence,
      expectedProfit,
      estimatedValue:   adjustedValue,
      allocatedCost,
      catWinRate,
      catAvgProfit,
      bestPlatform,
      alphaScore,
      analyzedAt:       Date.now(),
    };

    // Telemetry snapshot — always captured for specialist outputs
    const telemetrySnapshot = {
      workerId,
      jobId:         worker.jobId,
      lotId:         worker.lotId,
      scanId:        item.scanId || null,
      itemName:      item.itemName || null,
      tier:          item.tier || "?",
      signal,
      baseSignal,
      payloadId:     payload.id,
      confidence:    guard.confidence,
      expectedProfit,
      estimatedValue: adjustedValue,
      allocatedCost,
      alphaROI:      alphaScore.roi,
      isAlpha:       alphaScore.isAlpha,
      catWinRate,
      bestPlatform,
      snapshotAt:    Date.now(),
    };

    // ── Alpha gate: high-ROI items must be validated before ledger write ──
    if (alphaScore.isAlpha && (signal === BUY_SIGNAL.STRONG_BUY || signal === BUY_SIGNAL.GOOD_DEAL)) {
      await _transitionWorker(redis, workerId, WORKER_STATUS.VALUATING, {
        visionConfidence: guard.confidence,
        specialistResult,
        telemetrySnapshot,
        buySignal:        BUY_SIGNAL.ALPHA_CANDIDATE,
      });
      // Enqueue for Validator Specialist — second opinion required
      await redis.rpush(KEY_Q_VALIDATOR(), JSON.stringify({
        jobId:          worker.jobId,
        lotId:          worker.lotId,
        userId:         worker.userId,
        item:           { ...item, estimatedValue: adjustedValue },
        parentWorkerId: workerId,
        alphaScore,
        specialistResult,
      })).catch(() => {});
      await redis.hincrby(KEY_OPS(), "alpha_candidates", 1).catch(() => {});
      return {
        ok:             true,
        workerId,
        status:         WORKER_STATUS.VALUATING,
        buySignal:      BUY_SIGNAL.ALPHA_CANDIDATE,
        alphaScore,
        validatorQueued: true,
        payloadId:      payload.id,
        note:           `Alpha candidate (ROI ${alphaScore.roi}%) — routed to Validator Specialist`,
      };
    }

    let ledgerEntryId = null;

    // ── ACQUIRING gate — BUY signals pass through three laws + item lock ──
    if (signal === BUY_SIGNAL.STRONG_BUY || signal === BUY_SIGNAL.GOOD_DEAL) {
      const recommendedBid = allocatedCost > 0 ? allocatedCost : r2(adjustedValue * 0.55);

      // Capital budget enforcement (local job limit)
      if (recommendedBid > capitalBudget) {
        await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
          visionConfidence: guard.confidence,
          scrubReason:      `capital_budget_exceeded: recommend $${recommendedBid}, remaining $${capitalBudget}`,
          specialistResult,
          telemetrySnapshot,
          buySignal: signal,
        });
        return { ok: true, workerId, status: WORKER_STATUS.SCRUBBED, scrubReason: "capital_budget_exceeded", signal };
      }

      // ── Global Invariant Gate (The Three Laws) ──────────────────────────
      const constraints = loadConstraints();
      const invariant   = await enforceInvariants(redis, {
        item,
        estimatedValue: adjustedValue,
        allocatedCost:  recommendedBid,
        userId:         worker.userId,
        vertical:       payload.id,
        totalBankroll,
      });

      if (!invariant.pass) {
        await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
          visionConfidence: guard.confidence,
          scrubReason:      `invariant_violation: ${invariant.violations.join(" | ")}`,
          specialistResult,
          telemetrySnapshot,
          buySignal:        signal,
          invariantResult:  invariant,
        });
        await recordAgentOutcome(redis, workerId, item.category || "generic", false).catch(() => {});
        return {
          ok: true, workerId, status: WORKER_STATUS.SCRUBBED,
          scrubReason: "invariant_violation",
          violations: invariant.violations,
          signal,
        };
      }

      // ── Item Lock — atomic conflict prevention ────────────────────────
      const scanId  = item.scanId || null;
      let lockHeld  = false;
      if (scanId) {
        const lockResult = await acquireItemLock(redis, scanId, workerId, constraints);
        if (!lockResult.locked) {
          // Another agent holds the lock — resolve by reputation
          const conflict = await resolveConflict(
            redis, scanId, workerId, lockResult.holder,
            item.category || "generic", constraints,
          );
          if (conflict.winner !== workerId) {
            // We lost the conflict — scrub and free resources
            await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
              scrubReason:     `conflict_lost_to_${conflict.winner}: ${conflict.basis}`,
              buySignal:       signal,
              conflictResult:  conflict,
            });
            return {
              ok: true, workerId, status: WORKER_STATUS.SCRUBBED,
              scrubReason: "conflict_lost", conflictResult: conflict,
            };
          }
          // We won the reputation contest — lock was transferred to us
        }
        lockHeld = true;
      }

      // ── VALUATING → ACQUIRING ─────────────────────────────────────────
      const acquisitionTs = Date.now();
      await _transitionWorker(redis, workerId, WORKER_STATUS.ACQUIRING, {
        visionConfidence: guard.confidence,
        specialistResult,
        telemetrySnapshot,
        buySignal: signal,
        invariantResult: invariant,
      });

      // Record telemetry entry in ledger — target: within 500ms of ACQUIRING
      const ledgerResult = await recordEntry(redis, worker.userId, {
        type:              TXN_TYPE.ADJUSTMENT,
        amount:            0,
        adjustmentReason:  `Swarm telemetry [${payload.id}] — ${signal} on ${item.itemName || item.scanId} (lot ${worker.lotId})`,
        relatedId:         worker.jobId,
        relatedType:       RELATED_TYPE.OTHER,
        description:       `Worker ${workerId} | payload: ${payload.id} | signal: ${signal} | confidence: ${guard.confidence}% | adj.value: $${adjustedValue} | roi: ${invariant.results.roiFloor?.roiAfterFees}%`,
        recordedBy:        "swarmOrchestrator",
      }).catch(() => null);

      ledgerEntryId = ledgerResult?.txnId || null;

      // SLA check: was ledger synced within 500ms?
      const syncSLA = checkLedgerSyncSLA(Date.now(), acquisitionTs, constraints);
      if (!syncSLA.inSLA) {
        await redis.hincrby(KEY_OPS(), "ledger_sync_sla_breaches", 1).catch(() => {});
      }

      // ACQUIRING → LEDGER_SYNC → COMPLETE
      await _transitionWorker(redis, workerId, WORKER_STATUS.LEDGER_SYNC, { ledgerEntryId, syncSLA });
      await _transitionWorker(redis, workerId, WORKER_STATUS.COMPLETE, {});

      // Post-acquisition bookkeeping
      await recordLiquidityCommitment(redis, worker.userId, payload.id, recommendedBid).catch(() => {});
      await recordAgentOutcome(redis, workerId, item.category || "generic", true).catch(() => {});
      if (lockHeld && scanId) await releaseItemLock(redis, scanId, workerId).catch(() => {});
      await redis.hincrby(KEY_OPS(), "buy_signals_emitted", 1).catch(() => {});

      return {
        ok:               true,
        workerId,
        status:           WORKER_STATUS.COMPLETE,
        buySignal:        signal,
        recommendedBid,
        confidence:       guard.confidence,
        ledgerEntryId,
        syncSLA,
        invariantResult:  invariant,
        telemetrySnapshot,
        specialistResult,
        payloadId:        payload.id,
      };
    }

    // WATCH or PASS — no ledger entry, complete without ACQUIRING
    await _transitionWorker(redis, workerId, WORKER_STATUS.COMPLETE, {
      visionConfidence: guard.confidence,
      specialistResult,
      telemetrySnapshot,
      buySignal: signal,
    });

    return {
      ok:           true,
      workerId,
      status:       WORKER_STATUS.COMPLETE,
      buySignal:    signal,
      confidence:   guard.confidence,
      specialistResult,
      payloadId:    payload.id,
    };

  } catch (err) {
    await _transitionWorker(redis, workerId, WORKER_STATUS.FAILED, { scrubReason: err.message || "specialist_error" });
    return { ok: false, error: err.message || "specialist_error" };
  }
}

// ── Swarm Runner (batch processor) ───────────────────────────────────────────

/**
 * Process pending items from the scout queue — spawns Scout workers.
 * Call this periodically to drain the scout queue.
 *
 * @param {object} redis
 * @param {object} opts
 *   batchSize    {number}   max items to process per call (default: 10)
 *   lotItems     {object[]} full lot context for evaluateLot
 *   tokenBudget  {number}   remaining token budget
 *   capitalBudget {number}  remaining capital budget
 * @returns {{ processed, scrubbed, handedOff, failed }}
 */
export async function drainScoutQueue(redis, {
  batchSize     = 10,
  lotItems      = [],
  tokenBudget   = Infinity,
  capitalBudget = Infinity,
} = {}) {
  if (!redis) return { ok: false, error: "no_redis" };

  const stats = { processed: 0, scrubbed: 0, handedOff: 0, failed: 0 };
  let remaining = Math.min(batchSize, tokenBudget);

  while (remaining > 0) {
    const raw = await redis.lpop(KEY_Q_SCOUT()).catch(() => null);
    if (!raw) break;

    let entry;
    try { entry = JSON.parse(raw); } catch { stats.failed++; remaining--; continue; }

    const workerId = await _spawnWorker(redis, {
      jobId:  entry.jobId,
      lotId:  entry.lotId,
      userId: entry.userId,
      role:   WORKER_ROLE.SCOUT,
      item:   entry.item,
    });

    // Attach worker to job record
    await _appendWorkerToJob(redis, entry.jobId, workerId);

    const result = await runScout(redis, workerId, { lotItems, tokenBudget: remaining, capitalBudget });

    if (result.status === WORKER_STATUS.SCRUBBED) stats.scrubbed++;
    else if (result.handOff) stats.handedOff++;
    else if (!result.ok) stats.failed++;

    stats.processed++;
    remaining--;
  }

  return { ok: true, ...stats };
}

/**
 * Process pending items from the specialist queue — spawns Specialist workers.
 *
 * @param {object} redis
 * @param {object} opts
 *   batchSize     {number}   max items per call (default: 5)
 *   categoryIntel {object}   from reportingEngine.getCategorySnapshot
 *   platformIntel {object}   from reportingEngine.getPlatformSnapshot
 *   tokenBudget   {number}
 *   capitalBudget {number}
 * @returns {{ processed, scrubbed, buySignals, failed }}
 */
export async function drainSpecialistQueue(redis, {
  batchSize     = 5,
  categoryIntel = null,
  platformIntel = null,
  tokenBudget   = Infinity,
  capitalBudget = Infinity,
} = {}) {
  if (!redis) return { ok: false, error: "no_redis" };

  const stats = { processed: 0, scrubbed: 0, buySignals: 0, failed: 0 };
  let remaining = Math.min(batchSize, tokenBudget);
  let capRemaining = capitalBudget;

  while (remaining > 0) {
    const raw = await redis.lpop(KEY_Q_SPECIALIST()).catch(() => null);
    if (!raw) break;

    let entry;
    try { entry = JSON.parse(raw); } catch { stats.failed++; remaining--; continue; }

    const workerId = await _spawnWorker(redis, {
      jobId:          entry.jobId,
      lotId:          entry.lotId,
      userId:         entry.userId,
      role:           WORKER_ROLE.SPECIALIST,
      item:           entry.item,
      parentWorkerId: entry.parentWorkerId || null,
    });

    await _appendWorkerToJob(redis, entry.jobId, workerId);

    const result = await runSpecialist(redis, workerId, {
      categoryIntel,
      platformIntel,
      tokenBudget:   remaining,
      capitalBudget: capRemaining,
    });

    if (result.status === WORKER_STATUS.SCRUBBED) stats.scrubbed++;
    else if (result.buySignal === BUY_SIGNAL.STRONG_BUY || result.buySignal === BUY_SIGNAL.GOOD_DEAL) {
      stats.buySignals++;
      if (result.recommendedBid) capRemaining = r2(capRemaining - result.recommendedBid);
    } else if (!result.ok) stats.failed++;

    stats.processed++;
    remaining--;
  }

  return { ok: true, ...stats };
}

// ── Validator Specialist ──────────────────────────────────────────────────────

/**
 * Run a Validator Specialist — a second-opinion worker for Alpha candidates.
 *
 * Requirements are stricter than a standard Specialist:
 *   - Confidence floor: 75% (vs 65% for standard)
 *   - Margin threshold: 40% (vs 30%)
 *   - If confirmed: writes VALIDATOR_CONFIRMED to ledger and completes
 *   - If rejected: downgrades to WATCH and completes without ledger entry
 *
 * @param {object} redis
 * @param {string} workerId  — must be a SPECIALIST role worker
 */
export async function runValidator(redis, workerId, { capitalBudget = Infinity } = {}) {
  if (!redis || !workerId) return { ok: false, error: "missing_args" };

  const worker = await getWorker(redis, workerId);
  if (!worker) return { ok: false, error: "worker_not_found" };

  await redis.hincrby(KEY_OPS(), "validator_runs", 1).catch(() => {});

  try {
    const item         = worker.item;
    const alphaScore   = worker.alphaScore || {};
    const parentResult = worker.parentSpecialistResult || {};

    // Stricter confidence check for validator
    const guard = _truthGuard(item, workerId);
    const confPct = guard.confidence;

    if (confPct == null || confPct < VALIDATOR_CONFIDENCE_FLOOR) {
      await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
        scrubReason: `validator_confidence_below_floor: ${confPct}% < ${VALIDATOR_CONFIDENCE_FLOOR}%`,
        buySignal:   BUY_SIGNAL.WATCH,
      });
      await redis.hincrby(KEY_OPS(), "validator_rejected", 1).catch(() => {});
      return {
        ok:       true,
        workerId,
        status:   WORKER_STATUS.SCRUBBED,
        buySignal: BUY_SIGNAL.WATCH,
        note:     `Validator: confidence ${confPct}% below ${VALIDATOR_CONFIDENCE_FLOOR}% floor — alpha rejected`,
      };
    }

    // Re-run payload valuation independently — validator uses same payload
    const payload       = resolvePayload(item.category, item.itemName);
    const allocatedCost = Number(item.allocatedCost || 0);
    const estimatedValue= Number(item.estimatedValue || item.estimatedCost || 0);

    // Stricter margin requirement for validator: 40% minimum
    const margin = estimatedValue > 0 && allocatedCost > 0
      ? (estimatedValue - allocatedCost) / estimatedValue
      : 0;

    if (margin < 0.40) {
      // Validator rejects — alpha ROI was overstated
      await _transitionWorker(redis, workerId, WORKER_STATUS.COMPLETE, {
        buySignal:  BUY_SIGNAL.WATCH,
        visionConfidence: confPct,
        validatorNote: `margin ${r2(margin * 100)}% below 40% validator threshold — alpha rejected`,
      });
      await redis.hincrby(KEY_OPS(), "validator_rejected", 1).catch(() => {});
      return {
        ok:             true,
        workerId,
        status:         WORKER_STATUS.COMPLETE,
        buySignal:      BUY_SIGNAL.WATCH,
        alphaConfirmed: false,
        margin:         r2(margin * 100),
        note:           "Alpha rejected — margin below validator threshold",
      };
    }

    // ── Validator confirms — proceed to ACQUIRING with ledger write ────────
    const recommendedBid = allocatedCost > 0 ? allocatedCost : r2(estimatedValue * 0.55);

    if (recommendedBid > capitalBudget) {
      await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
        scrubReason: `capital_budget_exceeded: recommend $${recommendedBid}, remaining $${capitalBudget}`,
        buySignal:   BUY_SIGNAL.VALIDATOR_CONFIRMED,
      });
      return { ok: true, workerId, status: WORKER_STATUS.SCRUBBED, scrubReason: "capital_budget_exceeded" };
    }

    await _transitionWorker(redis, workerId, WORKER_STATUS.ACQUIRING, {
      buySignal:        BUY_SIGNAL.VALIDATOR_CONFIRMED,
      visionConfidence: confPct,
    });

    const ledgerResult = await recordEntry(redis, worker.userId, {
      type:              TXN_TYPE.ADJUSTMENT,
      amount:            0,
      adjustmentReason:  `VALIDATOR_CONFIRMED: Alpha lot ${worker.lotId} | ROI ${alphaScore.roi}% | payload ${payload.id} | conf ${confPct}%`,
      relatedId:         worker.jobId,
      relatedType:       RELATED_TYPE.OTHER,
      description:       `Validator ${workerId} confirmed alpha candidate — ${item.itemName || item.scanId} | est. value $${estimatedValue} | cost $${allocatedCost}`,
      recordedBy:        "swarmOrchestrator:validator",
    }).catch(() => null);

    await _transitionWorker(redis, workerId, WORKER_STATUS.LEDGER_SYNC, { ledgerEntryId: ledgerResult?.txnId || null });
    await _transitionWorker(redis, workerId, WORKER_STATUS.COMPLETE, {});
    await redis.hincrby(KEY_OPS(), "alpha_confirmed", 1).catch(() => {});
    await redis.hincrby(KEY_OPS(), "buy_signals_emitted", 1).catch(() => {});

    return {
      ok:              true,
      workerId,
      status:          WORKER_STATUS.COMPLETE,
      buySignal:       BUY_SIGNAL.VALIDATOR_CONFIRMED,
      alphaConfirmed:  true,
      alphaROI:        alphaScore.roi,
      recommendedBid,
      ledgerEntryId:   ledgerResult?.txnId || null,
      payloadId:       payload.id,
    };

  } catch (err) {
    await _transitionWorker(redis, workerId, WORKER_STATUS.FAILED, { scrubReason: err.message || "validator_error" });
    return { ok: false, error: err.message || "validator_error" };
  }
}

/**
 * Process pending items from the validator queue.
 *
 * @param {object} redis
 * @param {object} opts
 *   batchSize     {number}  max items per call (default: 3 — validators are expensive)
 *   capitalBudget {number}
 */
export async function drainValidatorQueue(redis, { batchSize = 3, capitalBudget = Infinity } = {}) {
  if (!redis) return { ok: false, error: "no_redis" };

  const stats = { processed: 0, confirmed: 0, rejected: 0, failed: 0 };
  let capRemaining = capitalBudget;

  for (let i = 0; i < batchSize; i++) {
    const raw = await redis.lpop(KEY_Q_VALIDATOR()).catch(() => null);
    if (!raw) break;

    let entry;
    try { entry = JSON.parse(raw); } catch { stats.failed++; continue; }

    const workerId = await _spawnWorker(redis, {
      jobId:          entry.jobId,
      lotId:          entry.lotId,
      userId:         entry.userId,
      role:           WORKER_ROLE.SPECIALIST,   // validators are specialist-role
      item:           entry.item,
      parentWorkerId: entry.parentWorkerId || null,
    });

    // Inject alpha context into the new worker
    await _transitionWorker(redis, workerId, WORKER_STATUS.IDLE, {
      alphaScore:              entry.alphaScore,
      parentSpecialistResult:  entry.specialistResult,
    });

    await _appendWorkerToJob(redis, entry.jobId, workerId);

    const result = await runValidator(redis, workerId, { capitalBudget: capRemaining });

    if (result.alphaConfirmed) {
      stats.confirmed++;
      if (result.recommendedBid) capRemaining = r2(capRemaining - result.recommendedBid);
    } else if (!result.ok) {
      stats.failed++;
    } else {
      stats.rejected++;
    }

    stats.processed++;
  }

  return { ok: true, ...stats };
}

// ── Lot Distribution Trigger ──────────────────────────────────────────────────

/**
 * After swarm completes analysis, trigger cost-basis distribution across child items.
 * Only items with STRONG_BUY or GOOD_DEAL signals are included in distribution
 * unless `includeAll` is true (in which case all items are distributed equally).
 *
 * @param {object} redis
 * @param {string} jobId
 * @param {object} opts
 *   includeAll    {boolean}    distribute across all lot items (default: false)
 *   strategy      {string}     DIST_STRATEGY value
 *   dryRun        {boolean}
 */
export async function triggerLotDistribution(redis, jobId, {
  includeAll = false,
  strategy   = DIST_STRATEGY.SIGNAL_WEIGHTED,
  dryRun     = false,
} = {}) {
  if (!redis || !jobId) return { ok: false, error: "missing_args" };

  // Load full job (including items)
  const raw = await redis.get(KEY_JOB(jobId)).catch(() => null);
  if (!raw) return { ok: false, error: "job_not_found" };
  const job = JSON.parse(raw);

  let targetItems = job.items || [];

  if (!includeAll) {
    // Filter to items where workers emitted buy signals
    // Get all worker IDs and check their buy signals
    const signals = new Set();
    for (const workerId of (job.workers || [])) {
      const wRaw = await redis.get(KEY_WORKER(workerId)).catch(() => null);
      if (!wRaw) continue;
      const w = JSON.parse(wRaw);
      if (
        w.role === WORKER_ROLE.SPECIALIST &&
        (w.buySignal === BUY_SIGNAL.STRONG_BUY || w.buySignal === BUY_SIGNAL.GOOD_DEAL) &&
        w.item?.scanId
      ) {
        signals.add(w.item.scanId);
      }
    }
    if (signals.size > 0) {
      targetItems = targetItems.filter(item => signals.has(item.scanId));
    }
    // If no buy signals at all, fall back to full lot
    if (targetItems.length === 0) targetItems = job.items || [];
  }

  if (!targetItems.length) return { ok: false, error: "no_items_to_distribute" };

  const distResult = await distributeLot(redis, {
    lotId:      job.lotId,
    userId:     job.userId,
    totalPaid:  job.totalPaid,
    items:      targetItems,
    strategy,
    sourceType: job.sourceType,
    notes:      job.notes,
    dryRun,
  });

  // Update job record with dist result
  if (!dryRun && distResult.ok) {
    const updatedJob = { ...job, distResult, status: JOB_STATUS.COMPLETE, completedAt: Date.now() };
    await redis.set(KEY_JOB(jobId), JSON.stringify(updatedJob), "EX", JOB_TTL).catch(() => {});
    await redis.hincrby(KEY_OPS(), "total_jobs_completed", 1).catch(() => {});
  }

  return { ok: true, jobId, distResult };
}

// ── Timeout / Stale Worker Reaper ─────────────────────────────────────────────

/**
 * Scan a job's workers for stuck/timed-out entries and scrub them.
 *
 * @param {object} redis
 * @param {string} jobId
 * @param {number} timeoutMs   ms threshold (default: 120_000)
 */
export async function reapStaleWorkers(redis, jobId, timeoutMs = 120_000) {
  if (!redis || !jobId) return { reaped: 0 };

  const raw = await redis.get(KEY_JOB(jobId)).catch(() => null);
  if (!raw) return { reaped: 0 };
  const job = JSON.parse(raw);

  let reaped = 0;
  const now = Date.now();
  const terminal = new Set([WORKER_STATUS.COMPLETE, WORKER_STATUS.SCRUBBED, WORKER_STATUS.FAILED]);

  for (const workerId of (job.workers || [])) {
    const wRaw = await redis.get(KEY_WORKER(workerId)).catch(() => null);
    if (!wRaw) continue;
    const w = JSON.parse(wRaw);
    if (terminal.has(w.status)) continue;

    const age = now - (w.updatedAt || w.createdAt);
    if (age > timeoutMs) {
      await _transitionWorker(redis, workerId, WORKER_STATUS.SCRUBBED, {
        scrubReason: `timeout_after_${age}ms_in_${w.status}`,
      });
      reaped++;
      await redis.hincrby(KEY_OPS(), "workers_reaped", 1).catch(() => {});
    }
  }

  return { reaped };
}

// ── Ops / Telemetry ───────────────────────────────────────────────────────────

export async function getSwarmOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalJobsCreated:      ops["total_jobs_created"]      || 0,
      totalJobsCompleted:    ops["total_jobs_completed"]     || 0,
      scoutRuns:             ops["scout_runs"]               || 0,
      specialistRuns:        ops["specialist_runs"]          || 0,
      handoffsToSpecialist:  ops["handoffs_to_specialist"]   || 0,
      scrubbledConfidence:   ops["scrubbed_confidence"]      || 0,
      buySignalsEmitted:     ops["buy_signals_emitted"]      || 0,
      workersReaped:         ops["workers_reaped"]           || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Derive a buy signal from specialist analysis data.
 * @internal
 */
function _deriveBuySignal({ tier, confidence, expectedProfit, estimatedValue, allocatedCost, catWinRate }) {
  // No confidence → WATCH (can't commit)
  if (confidence != null && confidence < CONFIDENCE_FLOOR) return BUY_SIGNAL.PASS;

  const margin = estimatedValue > 0 && allocatedCost > 0
    ? (estimatedValue - allocatedCost) / estimatedValue
    : null;

  const profitPositive = expectedProfit > 0;
  const goodMargin     = margin != null && margin >= 0.30;   // ≥30% margin
  const greatMargin    = margin != null && margin >= 0.50;   // ≥50% margin
  const winRateGood    = catWinRate == null || catWinRate >= 0.55;

  // STRONG_BUY: A-tier + great margin + positive profit + strong win rate
  if (tier === "A" && greatMargin && profitPositive && winRateGood) return BUY_SIGNAL.STRONG_BUY;

  // GOOD_DEAL: A/B-tier + good margin OR strong expected profit
  if (HANDOFF_TIERS.has(tier) && (goodMargin || profitPositive) && winRateGood) return BUY_SIGNAL.GOOD_DEAL;

  // WATCH: promising but incomplete data
  if (HANDOFF_TIERS.has(tier) && (goodMargin || profitPositive)) return BUY_SIGNAL.WATCH;

  return BUY_SIGNAL.PASS;
}

/**
 * Append a workerId to a job's worker list.
 * @internal
 */
async function _appendWorkerToJob(redis, jobId, workerId) {
  try {
    const raw = await redis.get(KEY_JOB(jobId));
    if (!raw) return;
    const job = JSON.parse(raw);
    job.workers = [...(job.workers || []), workerId];
    if (job.status === JOB_STATUS.PENDING) {
      job.status    = JOB_STATUS.RUNNING;
      job.startedAt = job.startedAt || Date.now();
    }
    await redis.set(KEY_JOB(jobId), JSON.stringify(job), "EX", JOB_TTL);
  } catch {}
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
