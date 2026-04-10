// src/swarmInvariants.js
// Phase 10 — Swarm Control & Emergent Intelligence.
//
// "The Laws of Evan AI" — Global Invariants enforced across every agent
// in a 100+ worker swarm. This is the transition from managed tool to
// autonomous market force.
//
// ── The Three Laws ───────────────────────────────────────────────────────────
//
//   Law 1 — ROI Floor:
//     Never commit capital unless projected ROI > 30% after all platform,
//     shipping, and payment fees are deducted.
//
//   Law 2 — Liquidity Rule:
//     Never tie up more than maxPctPerVertical% of the total bankroll in a
//     single payload vertical (VINTAGE_ELECTRONICS, DESIGNER_APPAREL, etc.).
//
//   Law 3 — Authenticity Law:
//     Any item flagged HIGH_RISK for counterfeits must pass 3 independent
//     Specialist checks before capital can be committed. Failure → SCRUBBED.
//
// ── Emergent Market Hunting ───────────────────────────────────────────────────
//
//   When 3+ Scout agents report high-margin findings in the same niche within
//   a 10-minute window, the Orchestrator auto-reallocates 20% of idle workers
//   to corner that category — detected purely from real-time telemetry.
//
// ── Decentralized Ledger Sync + Conflict Resolution ──────────────────────────
//
//   Every acquisition decision is locked via SET NX before the ledger write.
//   If two agents compete for the same item, the higher-reputation agent
//   (measured by historical accuracy per category) wins the lock.
//   The loser is scrubbed and freed for reallocation.
//
// ── Redis key layout ─────────────────────────────────────────────────────────
//
//   p10:inv:liquidity:{userId}:{vertical}  HASH   committed amount per vertical
//   p10:inv:reputation:{workerId}          HASH   wins/total per category key
//   p10:inv:streak:{category}             ZSET   high-margin signals (score=ts)
//   p10:inv:hot                            HASH   hot category counts
//   p10:inv:lock:{scanId}                 STRING  workerId holding the item lock
//   p10:inv:triplecheck:{scanId}          HASH   check count + checkers list
//   p10:inv:ops                            HASH   counters

import { readFileSync }    from "fs";
import { fileURLToPath }   from "url";
import { join, dirname }   from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constraint loader ─────────────────────────────────────────────────────────

let _cachedConstraints = null;
let _cacheLoadedAt     = 0;
const CACHE_TTL_MS     = 30_000;  // re-read file at most every 30s

export function loadConstraints(forceReload = false) {
  const now = Date.now();
  if (!forceReload && _cachedConstraints && (now - _cacheLoadedAt) < CACHE_TTL_MS) {
    return _cachedConstraints;
  }
  try {
    const raw = readFileSync(join(__dirname, "..", "global_constraints.json"), "utf8");
    _cachedConstraints = JSON.parse(raw);
    _cacheLoadedAt     = now;
    return _cachedConstraints;
  } catch {
    // Fallback defaults if file missing
    return {
      roiFloor:          { minROIPct: 30, platformFeePct: 13, shippingFeePct: 5, paymentFeePct: 3 },
      liquidityRule:     { maxPctPerVertical: 25, cooldownMs: 300_000 },
      authenticityLaw:   { highRiskFlags: ["HIGH_RISK","COUNTERFEIT_RISK","AUTH_REQUIRED","UNVERIFIED_AUTH"], tripleCheckMinPasses: 3 },
      winningStreak:     { triggerCount: 3, windowMs: 600_000, reallocationPct: 20, hotCategoryTtlMs: 1_800_000 },
      ledgerSync:        { maxMs: 500 },
      conflictResolution:{ strategy: "REPUTATION", lockTtlMs: 30_000, minOutcomesForReputation: 3 },
    };
  }
}

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_LIQ       = (userId, v) => `p10:inv:liquidity:${userId}:${v}`;
const KEY_REP       = (workerId)  => `p10:inv:reputation:${workerId}`;
const KEY_STREAK    = (cat)       => `p10:inv:streak:${encodeURIComponent(cat)}`;
const KEY_HOT       = ()          => `p10:inv:hot`;
const KEY_LOCK      = (scanId)    => `p10:inv:lock:${scanId}`;
const KEY_3CHECK    = (scanId)    => `p10:inv:triplecheck:${scanId}`;
const KEY_OPS       = ()          => `p10:inv:ops`;

const LIQ_TTL    = 86_400;    // 24h — daily capital tracking
const REP_TTL    = 90 * 86_400; // 90d — long-term reputation
const STREAK_TTL = 3_600;     // 1h — winning streak window
const HOT_TTL    = 3_600;     // 1h — hot category cache
const CHECK_TTL  = 3_600;     // 1h — triple-check state

// ── Law 1: ROI Floor ──────────────────────────────────────────────────────────

/**
 * Verify a potential acquisition clears the ROI floor after all fees.
 *
 * @param {number} estimatedValue   — what the item sells for
 * @param {number} allocatedCost    — what we're paying
 * @param {object} constraints      — loaded from global_constraints.json
 * @returns {{ pass: boolean, roi: number, roiAfterFees: number, required: number }}
 */
export function enforceROIFloor(estimatedValue, allocatedCost, constraints) {
  const c = constraints?.roiFloor || {};
  const required     = Number(c.minROIPct     ?? 30);
  const platformFee  = Number(c.platformFeePct ?? 13) / 100;
  const shippingFee  = Number(c.shippingFeePct ?? 5)  / 100;
  const paymentFee   = Number(c.paymentFeePct  ?? 3)  / 100;

  const val  = Number(estimatedValue || 0);
  const cost = Number(allocatedCost  || 0);

  if (val <= 0 || cost <= 0) {
    return { pass: false, roi: 0, roiAfterFees: 0, required, reason: "invalid_values" };
  }

  const totalFeePct  = platformFee + shippingFee + paymentFee;
  const netProceeds  = r2(val * (1 - totalFeePct));
  const grossROI     = r2(((val - cost) / cost) * 100);
  const roiAfterFees = r2(((netProceeds - cost) / cost) * 100);
  const pass         = roiAfterFees >= required;

  return {
    pass,
    roi:          grossROI,
    roiAfterFees,
    required,
    netProceeds,
    totalFeePct:  r2(totalFeePct * 100),
    reason:       pass ? null : `roi_${roiAfterFees}%_below_floor_${required}%`,
  };
}

// ── Law 2: Liquidity Rule ─────────────────────────────────────────────────────

/**
 * Gate capital commitment: vertical exposure must stay ≤ maxPctPerVertical% of bankroll.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string} vertical       — payload ID (VINTAGE_ELECTRONICS, etc.)
 * @param {number} bidAmount      — proposed spend
 * @param {number} totalBankroll  — total capital pool
 * @param {object} constraints
 * @returns {{ pass: boolean, currentExposure: number, maxAllowed: number, exposurePct: number }}
 */
export async function enforceLiquidityRule(redis, userId, vertical, bidAmount, totalBankroll, constraints) {
  const c           = constraints?.liquidityRule || {};
  const maxPct      = Number(c.maxPctPerVertical ?? 25) / 100;
  const bankroll    = Number(totalBankroll || 0);
  const bid         = Number(bidAmount     || 0);

  if (bankroll <= 0) return { pass: true, note: "no_bankroll_provided" };

  const maxAllowed  = r2(bankroll * maxPct);

  let currentCommitted = 0;
  try {
    const raw = await redis.hget(KEY_LIQ(userId, vertical || "GENERIC"), "committed");
    currentCommitted = Number(raw || 0);
  } catch {}

  const projectedExposure = r2(currentCommitted + bid);
  const exposurePct       = r2((projectedExposure / bankroll) * 100);
  const pass              = projectedExposure <= maxAllowed;

  return {
    pass,
    vertical:          vertical || "GENERIC",
    currentCommitted:  r2(currentCommitted),
    projectedExposure,
    maxAllowed,
    exposurePct,
    maxPct:            r2(maxPct * 100),
    reason:            pass ? null : `liquidity_${exposurePct}%_exceeds_max_${r2(maxPct * 100)}%`,
  };
}

/**
 * Record a capital commitment to a vertical after successful acquisition.
 * Call this after LEDGER_SYNC to track exposure.
 */
export async function recordLiquidityCommitment(redis, userId, vertical, amount) {
  if (!redis || !userId || !vertical || !amount) return;
  try {
    await redis.hincrbyfloat(KEY_LIQ(userId, vertical || "GENERIC"), "committed", amount);
    await redis.expire(KEY_LIQ(userId, vertical || "GENERIC"), LIQ_TTL);
  } catch {}
}

/**
 * Release committed capital when an item is sold or scrubbed.
 */
export async function releaseLiquidityCommitment(redis, userId, vertical, amount) {
  if (!redis || !userId || !vertical || !amount) return;
  try {
    const current = Number(await redis.hget(KEY_LIQ(userId, vertical || "GENERIC"), "committed") || 0);
    const updated = Math.max(0, r2(current - amount));
    await redis.hset(KEY_LIQ(userId, vertical || "GENERIC"), "committed", updated);
  } catch {}
}

// ── Law 3: Authenticity Law ───────────────────────────────────────────────────

/**
 * Check if an item requires the triple-check protocol.
 * Returns { requiresTripleCheck, checkCount, pass } where pass = true only
 * when check count has reached the required minimum.
 *
 * @param {object} redis
 * @param {object} item
 * @param {object} constraints
 */
export async function enforceAuthenticityLaw(redis, item, constraints) {
  const c         = constraints?.authenticityLaw || {};
  const riskFlags = c.highRiskFlags || ["HIGH_RISK", "COUNTERFEIT_RISK", "AUTH_REQUIRED", "UNVERIFIED_AUTH"];
  const minPasses = Number(c.tripleCheckMinPasses ?? 3);

  const itemFlags = [
    ...(item.flags    || []),
    item.riskLevel    || "",
    item.authStatus   || "",
    item.conditionNotes || "",
  ].join(" ").toUpperCase();

  const isHighRisk = riskFlags.some(f => itemFlags.includes(f));

  if (!isHighRisk) return { requiresTripleCheck: false, pass: true, checkCount: 0 };

  // Check current triple-check progress
  let checkCount = 0;
  try {
    const raw = await redis.hget(KEY_3CHECK(item.scanId || "no_scan"), "count");
    checkCount = Number(raw || 0);
  } catch {}

  const pass = checkCount >= minPasses;

  return {
    requiresTripleCheck: true,
    checkCount,
    minPasses,
    pass,
    reason: pass ? null : `authenticity_triple_check_required: ${checkCount}/${minPasses} passes`,
  };
}

/**
 * Record one passed Specialist check for a high-risk item.
 * Returns the new check count.
 */
export async function recordTripleCheck(redis, scanId, workerId, constraints) {
  if (!redis || !scanId || !workerId) return { checkCount: 0 };
  const ttl = Number(constraints?.authenticityLaw?.tripleCheckTtlMs ?? 3_600_000) / 1000;
  try {
    const pipe = redis.pipeline ? redis.pipeline() : redis.multi();
    pipe.hincrby(KEY_3CHECK(scanId), "count", 1);
    pipe.expire(KEY_3CHECK(scanId), Math.ceil(ttl));
    const results = await pipe.exec();
    const checkCount = Number(results?.[0]?.[1] || results?.[0] || 0);
    await redis.hincrby(KEY_OPS(), "triple_checks_recorded", 1).catch(() => {});
    return { checkCount };
  } catch { return { checkCount: 0 }; }
}

// ── Composite Invariant Gate ──────────────────────────────────────────────────

/**
 * Single entry point — run all three laws against a proposed acquisition.
 * Returns { pass: boolean, violations: string[] } with full detail for each law.
 *
 * @param {object} redis
 * @param {object} opts
 *   item           {object}  item being acquired
 *   estimatedValue {number}
 *   allocatedCost  {number}
 *   userId         {string}
 *   vertical       {string}  payload ID (for liquidity tracking)
 *   totalBankroll  {number}  total capital pool (optional — skips liquidity if absent)
 * @returns {InvariantResult}
 */
export async function enforceInvariants(redis, {
  item           = {},
  estimatedValue = 0,
  allocatedCost  = 0,
  userId         = null,
  vertical       = "GENERIC",
  totalBankroll  = 0,
} = {}) {
  const constraints = loadConstraints();
  const violations  = [];
  const results     = {};

  // Law 1 — ROI Floor
  const roi = enforceROIFloor(estimatedValue, allocatedCost, constraints);
  results.roiFloor = roi;
  if (!roi.pass) violations.push(`ROI_FLOOR: ${roi.reason}`);

  // Law 2 — Liquidity Rule
  if (userId && totalBankroll > 0) {
    const liq = await enforceLiquidityRule(redis, userId, vertical, allocatedCost, totalBankroll, constraints);
    results.liquidityRule = liq;
    if (!liq.pass) violations.push(`LIQUIDITY_RULE: ${liq.reason}`);
  }

  // Law 3 — Authenticity Law
  const auth = await enforceAuthenticityLaw(redis, item, constraints);
  results.authenticityLaw = auth;
  if (!auth.pass) violations.push(`AUTHENTICITY_LAW: ${auth.reason}`);

  const pass = violations.length === 0;
  if (!pass) await redis.hincrby(KEY_OPS(), "invariant_violations", 1).catch(() => {});

  return { pass, violations, results, constraints: { version: constraints.version } };
}

// ── Emergent Market Hunting — Winning Streak Detection ────────────────────────

/**
 * Record a high-margin Scout sighting for a category.
 * Called when a Scout hands off a tier-A or tier-B item to a Specialist.
 *
 * @param {object} redis
 * @param {string} category   e.g. "vintage electronics", "sneakers"
 * @param {string} workerId
 * @param {number} confidence
 */
export async function recordWinStreak(redis, category, workerId, confidence = 0) {
  if (!redis || !category) return;
  const ts  = Date.now();
  const key = KEY_STREAK(category);
  try {
    const pipe = redis.pipeline ? redis.pipeline() : redis.multi();
    // Score = timestamp; member = workerId:ts for uniqueness
    pipe.zadd(key, ts, `${workerId}:${ts}`);
    pipe.expire(key, STREAK_TTL);
    await pipe.exec();
    await redis.hincrby(KEY_OPS(), "streak_signals_recorded", 1).catch(() => {});
  } catch {}
}

/**
 * Scan all tracked categories for winning streaks.
 * Returns categories where ≥ triggerCount scouts fired within windowMs.
 *
 * @param {object} redis
 * @returns {{ hotCategories: Array<{ category, signalCount, windowMs }> }}
 */
export async function detectHotCategories(redis) {
  if (!redis) return { hotCategories: [] };

  const constraints  = loadConstraints();
  const triggerCount = Number(constraints?.winningStreak?.triggerCount ?? 3);
  const windowMs     = Number(constraints?.winningStreak?.windowMs     ?? 600_000);
  const since        = Date.now() - windowMs;
  const hotTtl       = Number(constraints?.winningStreak?.hotCategoryTtlMs ?? 1_800_000) / 1000;

  // Get all known streak keys
  let streakKeys = [];
  try {
    streakKeys = await redis.keys("p10:inv:streak:*");
  } catch { return { hotCategories: [] }; }

  const hotCategories = [];
  const pipe          = redis.pipeline ? redis.pipeline() : redis.multi();
  for (const key of streakKeys) {
    // Count signals within the window
    pipe.zcount(key, since, "+inf");
  }
  const counts = await pipe.exec().catch(() => []);

  const hotPipe = redis.pipeline ? redis.pipeline() : redis.multi();
  for (let i = 0; i < streakKeys.length; i++) {
    const count    = Number(counts[i]?.[1] ?? counts[i] ?? 0);
    const rawKey   = streakKeys[i];
    const category = decodeURIComponent(rawKey.replace("p10:inv:streak:", ""));
    if (count >= triggerCount) {
      hotCategories.push({ category, signalCount: count, windowMs, triggerCount });
      // Cache in hot index
      hotPipe.hset(KEY_HOT(), category, count);
    }
  }
  if (hotCategories.length > 0) {
    hotPipe.expire(KEY_HOT(), Math.ceil(hotTtl));
    await hotPipe.exec().catch(() => {});
    await redis.hincrby(KEY_OPS(), "hot_categories_detected", hotCategories.length).catch(() => {});
  }

  return { hotCategories };
}

/**
 * Get current hot categories from cache (fast path).
 * @returns {Array<{ category, count }>}
 */
export async function getHotCategories(redis) {
  if (!redis) return [];
  try {
    const raw = await redis.hgetall(KEY_HOT());
    return Object.entries(raw || {}).map(([category, count]) => ({
      category,
      count: Number(count),
    })).sort((a, b) => b.count - a.count);
  } catch { return []; }
}

// ── Conflict Resolution — Item Lock + Agent Reputation ────────────────────────

/**
 * Attempt to claim exclusive lock on an item (scanId).
 * Uses Redis SET NX (atomic — only one agent wins).
 *
 * @returns {{ locked: boolean, holder: string|null }}
 */
export async function acquireItemLock(redis, scanId, workerId, constraints) {
  if (!redis || !scanId || !workerId) return { locked: false, holder: null };
  const ttlMs = Number(constraints?.conflictResolution?.lockTtlMs ?? 30_000);
  const ttlS  = Math.ceil(ttlMs / 1000);
  try {
    // ioredis: set(key, value, "NX", "EX", seconds) → "OK" | null
    const result = await redis.set(KEY_LOCK(scanId), workerId, "NX", "EX", ttlS);
    if (result === "OK") {
      await redis.hincrby(KEY_OPS(), "locks_acquired", 1).catch(() => {});
      return { locked: true, holder: workerId };
    }
    // Lock held by someone else — find out who
    const holder = await redis.get(KEY_LOCK(scanId)).catch(() => null);
    return { locked: false, holder };
  } catch { return { locked: false, holder: null }; }
}

/**
 * Release an item lock. Only the holder can release it.
 */
export async function releaseItemLock(redis, scanId, workerId) {
  if (!redis || !scanId || !workerId) return;
  try {
    const holder = await redis.get(KEY_LOCK(scanId));
    if (holder === workerId) {
      await redis.del(KEY_LOCK(scanId));
      await redis.hincrby(KEY_OPS(), "locks_released", 1).catch(() => {});
    }
  } catch {}
}

/**
 * Resolve a lock conflict between two agents competing for the same item.
 * The agent with the higher reputation in the item's category wins.
 *
 * @param {object} redis
 * @param {string} scanId
 * @param {string} challengerWorkerId  — the agent that lost the SET NX race
 * @param {string} holderWorkerId      — the agent currently holding the lock
 * @param {string} category
 * @param {object} constraints
 * @returns {{ winner: string, loser: string, basis: string }}
 */
export async function resolveConflict(redis, scanId, challengerWorkerId, holderWorkerId, category, constraints) {
  const minOutcomes = Number(constraints?.conflictResolution?.minOutcomesForReputation ?? 3);

  const [challengerRep, holderRep] = await Promise.all([
    getAgentReputation(redis, challengerWorkerId, category),
    getAgentReputation(redis, holderWorkerId, category),
  ]);

  // Only switch if challenger has enough history and clearly higher win rate
  const challengerQualified = challengerRep.total >= minOutcomes;
  const holderQualified     = holderRep.total     >= minOutcomes;

  let winner, loser, basis;

  if (challengerQualified && holderQualified && challengerRep.winRate > holderRep.winRate) {
    // Challenger has superior reputation — transfer lock
    const ttlMs = Number(constraints?.conflictResolution?.lockTtlMs ?? 30_000);
    await redis.set(KEY_LOCK(scanId), challengerWorkerId, "EX", Math.ceil(ttlMs / 1000)).catch(() => {});
    winner = challengerWorkerId;
    loser  = holderWorkerId;
    basis  = `reputation: challenger ${r2(challengerRep.winRate * 100)}% > holder ${r2(holderRep.winRate * 100)}% in ${category}`;
  } else {
    // Holder keeps the lock (default — first-come-first-served if reputation is equal/unknown)
    winner = holderWorkerId;
    loser  = challengerWorkerId;
    basis  = challengerQualified && holderQualified
      ? `reputation: holder ${r2(holderRep.winRate * 100)}% >= challenger ${r2(challengerRep.winRate * 100)}%`
      : "insufficient_history: first-come-first-served";
  }

  await redis.hincrby(KEY_OPS(), "conflicts_resolved", 1).catch(() => {});
  return { winner, loser, basis, challengerRep, holderRep };
}

// ── Agent Reputation ──────────────────────────────────────────────────────────

/**
 * Record the outcome of an agent's decision in a category.
 * Call this after an item is sold (won=true) or scrubbed/lost (won=false).
 *
 * @param {object} redis
 * @param {string} workerId
 * @param {string} category
 * @param {boolean} won
 */
export async function recordAgentOutcome(redis, workerId, category, won) {
  if (!redis || !workerId || !category) return;
  const cat  = String(category).toLowerCase().replace(/\s+/g, "_");
  const key  = KEY_REP(workerId);
  try {
    const pipe = redis.pipeline ? redis.pipeline() : redis.multi();
    pipe.hincrby(key, `total:${cat}`, 1);
    if (won) pipe.hincrby(key, `wins:${cat}`, 1);
    pipe.hset(key, "updatedAt", Date.now());
    pipe.expire(key, REP_TTL);
    await pipe.exec();
    await redis.hincrby(KEY_OPS(), "reputation_updates", 1).catch(() => {});
  } catch {}
}

/**
 * Get an agent's reputation in a specific category.
 *
 * @returns {{ winRate: number, wins: number, total: number, category: string }}
 */
export async function getAgentReputation(redis, workerId, category) {
  const empty = { winRate: 0, wins: 0, total: 0, category };
  if (!redis || !workerId) return empty;
  const cat = String(category || "generic").toLowerCase().replace(/\s+/g, "_");
  try {
    const raw  = await redis.hgetall(KEY_REP(workerId));
    if (!raw) return empty;
    const wins  = Number(raw[`wins:${cat}`]  || 0);
    const total = Number(raw[`total:${cat}`] || 0);
    return {
      winRate:  total > 0 ? r2(wins / total) : 0,
      wins,
      total,
      category,
      workerId,
    };
  } catch { return empty; }
}

/**
 * Get full reputation profile for a worker across all categories.
 */
export async function getAgentReputationProfile(redis, workerId) {
  if (!redis || !workerId) return { workerId, categories: [] };
  try {
    const raw = await redis.hgetall(KEY_REP(workerId));
    if (!raw) return { workerId, categories: [] };

    // Extract all category names from total:* fields
    const categories = Object.keys(raw)
      .filter(k => k.startsWith("total:"))
      .map(k => {
        const cat   = k.replace("total:", "");
        const wins  = Number(raw[`wins:${cat}`]  || 0);
        const total = Number(raw[`total:${cat}`] || 0);
        return { category: cat, winRate: total > 0 ? r2(wins / total) : 0, wins, total };
      })
      .sort((a, b) => b.total - a.total);

    return { workerId, categories, updatedAt: Number(raw.updatedAt || 0) };
  } catch { return { workerId, categories: [] }; }
}

// ── Ledger Sync SLA Monitor ───────────────────────────────────────────────────

/**
 * Verify that a ledger entry was written within the SLA window.
 * Returns { inSLA: boolean, elapsedMs: number, maxMs: number }.
 */
export function checkLedgerSyncSLA(entryTimestamp, acquisitionTimestamp, constraints) {
  const maxMs    = Number(constraints?.ledgerSync?.maxMs ?? 500);
  const elapsed  = entryTimestamp - acquisitionTimestamp;
  const inSLA    = elapsed >= 0 && elapsed <= maxMs;
  return { inSLA, elapsedMs: elapsed, maxMs };
}

// ── Ops ───────────────────────────────────────────────────────────────────────

export async function getInvariantOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      invariantViolations:    ops["invariant_violations"]     || 0,
      tripleChecksRecorded:   ops["triple_checks_recorded"]   || 0,
      locksAcquired:          ops["locks_acquired"]           || 0,
      locksReleased:          ops["locks_released"]           || 0,
      conflictsResolved:      ops["conflicts_resolved"]       || 0,
      hotCategoriesDetected:  ops["hot_categories_detected"]  || 0,
      streakSignalsRecorded:  ops["streak_signals_recorded"]  || 0,
      reputationUpdates:      ops["reputation_updates"]       || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function r2(n) { return Math.round(n * 100) / 100; }
