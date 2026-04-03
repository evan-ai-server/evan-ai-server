// src/closedLoopEngine.js
// Closed-Loop Intelligence Engine — Phase 1: Core Data Foundation.
//
// Transforms Evan from:
//   stateless scan → output
// Into:
//   scan → decision → source → outcome → learning → improved future signals
//
// Redis key layout:
//   loop:signal:{scanId}    STRING  signal snapshot at scan time (90d TTL)
//   loop:decision:{scanId}  STRING  buy/pass/undecided + override detection (365d TTL)
//   loop:source:{scanId}    STRING  purchase price, ask price, source context (365d TTL)
//   loop:outcome:{scanId}   STRING  sold price, fees, computed net profit (365d TTL)
//   loop:user:{userId}      ZSET    scanIds scored by timestamp (365d TTL, max 5000)
//
// Design invariants:
//   - null means unknown — never fabricate a value
//   - askPrice is always stored independently from purchasePrice
//   - source record is only valid for BUY decisions
//   - outcome record requires a source record (source proves a real purchase happened)
//   - all writes are non-blocking and non-fatal
//   - override detection uses the server-stored signal snapshot, not client-provided values

// ── Constants ─────────────────────────────────────────────────────────────────

const SIGNAL_TTL   = 90  * 86400;  // 90 days — matches learn:scan_history TTL
const LOOP_TTL     = 365 * 86400;  // 1 year
const MAX_USER_IDX = 5_000;        // max scanIds tracked per user

// Signals that constitute a positive recommendation (Evan says "buy this")
const POSITIVE_SIGNALS = new Set(["STRONG BUY", "GOOD DEAL"]);
// Signals that constitute a negative recommendation (Evan says "avoid this")
const NEGATIVE_SIGNALS = new Set(["RISKY", "INSUFFICIENT DATA", "OVERPRICED"]);

// Valid decision values
const VALID_DECISIONS = new Set(["BUY", "PASS", "UNDECIDED"]);

// Valid source types for where the item was physically found
const VALID_SOURCE_TYPES = new Set([
  "THRIFT",       // thrift store (Goodwill, Savers, etc.)
  "ESTATE",       // estate sale or auction
  "GARAGE",       // garage sale or yard sale
  "MARKETPLACE",  // eBay, Poshmark, Mercari, Facebook (already-listed items)
  "CONSIGNMENT",  // consignment shop
  "AUCTION",      // formal auction house
  "ONLINE_LOCAL", // Craigslist, Facebook Marketplace (local pickup)
  "OTHER",        // anything else
]);

// Real-world physical sources — askPrice validation is stricter for these
const PHYSICAL_SOURCE_TYPES = new Set(["THRIFT", "ESTATE", "GARAGE", "CONSIGNMENT", "AUCTION"]);

// Valid outcome statuses
const VALID_OUTCOME_STATUSES = new Set(["SOLD", "UNSOLD", "RETURNED"]);

// ── Redis Key Helpers ─────────────────────────────────────────────────────────

const KEY_SIGNAL   = (scanId) => `loop:signal:${scanId}`;
const KEY_DECISION = (scanId) => `loop:decision:${scanId}`;
const KEY_SOURCE   = (scanId) => `loop:source:${scanId}`;
const KEY_OUTCOME  = (scanId) => `loop:outcome:${scanId}`;
const KEY_USER_IDX = (userId) => `loop:user:${userId}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function safePositiveNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeNonNegativeNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseStored(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── Signal Snapshot ───────────────────────────────────────────────────────────

/**
 * Store a signal snapshot immediately after a scan completes.
 * Called from the scan pipeline (all 4 routes: A, B, C, D) right before response.
 * This is the authoritative record of what Evan told the user — used for override detection.
 *
 * Fire-and-forget — never throws, never blocks the scan response.
 *
 * @param {object} redis
 * @param {string} scanId
 * @param {{ userId, signal, trustScore, category }} opts
 */
export function storeSignalSnapshot(redis, scanId, {
  userId = null,
  signal = null,
  trustScore = null,
  category = null,
  itemName = null,
} = {}) {
  if (!redis || !scanId || !signal) return;
  try {
    const snapshot = JSON.stringify({
      scanId,
      userId:     userId     || null,
      signal:     signal     || null,
      trustScore: Number.isFinite(trustScore) ? trustScore : null,
      category:   category   || null,
      itemName:   itemName   || null,
      ts:         Date.now(),
    });
    redis.set(KEY_SIGNAL(scanId), snapshot, "EX", SIGNAL_TTL).catch(() => {});
  } catch { /* non-fatal */ }
}

/**
 * Retrieve the signal snapshot for a scan.
 * Returns null if expired or not found.
 *
 * @param {object} redis
 * @param {string} scanId
 * @returns {Promise<object|null>}
 */
export async function getSignalSnapshot(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    return parseStored(await redis.get(KEY_SIGNAL(scanId)));
  } catch { return null; }
}

// ── Override Detection ────────────────────────────────────────────────────────

/**
 * Detect whether the user's decision overrides Evan's recommendation.
 *
 * Override cases:
 *   - Evan said STRONG BUY or GOOD DEAL  → user chose PASS     (ignoring positive signal)
 *   - Evan said RISKY or INSUFFICIENT DATA → user chose BUY   (ignoring negative signal)
 *
 * Non-override cases:
 *   - Evan said STRONG BUY → user chose BUY   (agreed with signal)
 *   - Evan said RISKY → user chose PASS        (agreed with signal)
 *   - Signal is FAIR or UNDECIDED             (neutral — no override)
 *   - User chose UNDECIDED                    (deferred, not an override)
 *
 * @param {string} signal  — Evan's signal at scan time
 * @param {string} decision — user's decision (BUY | PASS | UNDECIDED)
 * @returns {boolean}
 */
export function detectOverride(signal, decision) {
  if (!signal || !decision || decision === "UNDECIDED") return false;
  const isPositive = POSITIVE_SIGNALS.has(signal);
  const isNegative = NEGATIVE_SIGNALS.has(signal);
  if (isPositive && decision === "PASS") return true;
  if (isNegative && decision === "BUY")  return true;
  return false;
}

// ── Decision Recording ────────────────────────────────────────────────────────

/**
 * Record a user's buy/pass/undecided decision on a scan.
 * Performs server-side override detection using the stored signal snapshot.
 *
 * @param {object} redis
 * @param {string} scanId
 * @param {{ userId, decision, decidedAt }} opts
 * @returns {Promise<{ ok, record, error? }>}
 */
export async function storeDecision(redis, scanId, {
  userId   = null,
  decision = null,
  decidedAt = null,
} = {}) {
  if (!redis)  return { ok: false, error: "no_redis" };
  if (!scanId) return { ok: false, error: "missing_scan_id" };
  if (!userId) return { ok: false, error: "missing_user_id" };

  const dec = String(decision || "").toUpperCase().trim();
  if (!VALID_DECISIONS.has(dec)) {
    return { ok: false, error: "invalid_decision", valid: [...VALID_DECISIONS] };
  }

  try {
    // Load stored signal snapshot for server-side override detection
    const snapshot = await getSignalSnapshot(redis, scanId);
    const originalSignal = snapshot?.signal || null;
    const wasOverride    = originalSignal ? detectOverride(originalSignal, dec) : false;

    const record = {
      scanId,
      userId,
      decision:        dec,
      wasOverride,
      originalSignal,
      trustScore:      snapshot?.trustScore ?? null,
      category:        snapshot?.category   ?? null,
      decidedAt:       decidedAt != null ? Number(decidedAt) : Date.now(),
    };

    const pipeline = redis.pipeline();
    pipeline.set(KEY_DECISION(scanId), JSON.stringify(record), "EX", LOOP_TTL);
    // Index by user (ZSET score = decidedAt for range queries)
    pipeline.zadd(KEY_USER_IDX(userId), record.decidedAt, scanId);
    pipeline.zremrangebyrank(KEY_USER_IDX(userId), 0, -(MAX_USER_IDX + 1));
    pipeline.expire(KEY_USER_IDX(userId), LOOP_TTL);
    await pipeline.exec();

    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: "decision_store_failed", reason: err?.message };
  }
}

/**
 * Retrieve a decision record for a scan.
 *
 * @param {object} redis
 * @param {string} scanId
 * @returns {Promise<object|null>}
 */
export async function getDecision(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    return parseStored(await redis.get(KEY_DECISION(scanId)));
  } catch { return null; }
}

// ── Source Recording ──────────────────────────────────────────────────────────

/**
 * Record the real-world source of a purchased item.
 * ONLY valid if the scan has a BUY decision.
 *
 * askPrice is the price the seller was asking (tag price, listing price).
 * purchasePrice is what the user actually paid (after negotiation, discount, etc.).
 * These are ALWAYS stored separately — askPrice is NEVER defaulted to purchasePrice.
 *
 * @param {object} redis
 * @param {string} scanId
 * @param {{ userId, purchasePrice, askPrice, sourceType, city, zip, metadata, capturedAt }} opts
 * @returns {Promise<{ ok, record, error? }>}
 */
export async function storeSource(redis, scanId, {
  userId        = null,
  purchasePrice = null,
  askPrice      = null,
  sourceType    = null,
  city          = null,
  zip           = null,
  metadata      = null,
  capturedAt    = null,
} = {}) {
  if (!redis)  return { ok: false, error: "no_redis" };
  if (!scanId) return { ok: false, error: "missing_scan_id" };
  if (!userId) return { ok: false, error: "missing_user_id" };

  // Enforce: source only valid for BUY decisions
  const decision = await getDecision(redis, scanId);
  if (!decision) {
    return { ok: false, error: "no_decision_found", detail: "Submit POST /scan/decision first" };
  }
  if (decision.decision !== "BUY") {
    return { ok: false, error: "source_requires_buy_decision", decisionFound: decision.decision };
  }

  // Validate purchasePrice
  const pp = safePositiveNumber(purchasePrice);
  if (pp === null) return { ok: false, error: "invalid_purchase_price", detail: "Must be a positive number" };

  // Validate askPrice — required for physical sources, optional for online/marketplace
  const ap = safePositiveNumber(askPrice);
  const srcType = String(sourceType || "OTHER").toUpperCase().trim();
  if (!VALID_SOURCE_TYPES.has(srcType)) {
    return {
      ok: false, error: "invalid_source_type",
      valid: [...VALID_SOURCE_TYPES],
    };
  }
  if (PHYSICAL_SOURCE_TYPES.has(srcType) && ap === null) {
    return {
      ok: false,
      error: "ask_price_required_for_physical_source",
      detail: `sourceType ${srcType} requires askPrice — this is the real-world price floor capture`,
    };
  }

  // Validate city
  const cityStr = city ? String(city).trim().slice(0, 100) : null;
  if (!cityStr) return { ok: false, error: "city_required" };

  const zipStr  = zip ? String(zip).trim().slice(0, 20) : null;
  const metaStr = metadata ? (typeof metadata === "object"
    ? JSON.stringify(metadata).slice(0, 500)
    : String(metadata).slice(0, 500))
    : null;

  try {
    const record = {
      scanId,
      userId,
      purchasePrice: pp,
      askPrice:      ap,          // null is valid for non-physical sources
      sourceType:    srcType,
      city:          cityStr,
      zip:           zipStr,
      metadata:      metaStr,
      capturedAt:    capturedAt != null ? Number(capturedAt) : Date.now(),
    };

    await redis.set(KEY_SOURCE(scanId), JSON.stringify(record), "EX", LOOP_TTL);
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: "source_store_failed", reason: err?.message };
  }
}

/**
 * Retrieve the source record for a scan.
 *
 * @param {object} redis
 * @param {string} scanId
 * @returns {Promise<object|null>}
 */
export async function getSource(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    return parseStored(await redis.get(KEY_SOURCE(scanId)));
  } catch { return null; }
}

// ── Profit Computation ────────────────────────────────────────────────────────

/**
 * Compute net profit from a sale.
 * netProfit = soldPrice - purchasePrice - fees - shippingCost
 * All deductions default to 0 if not provided (null → 0).
 * Returns null if soldPrice or purchasePrice is missing.
 *
 * @param {{ soldPrice, purchasePrice, fees, shippingCost }} params
 * @returns {number|null}
 */
export function computeNetProfit({ soldPrice, purchasePrice, fees, shippingCost } = {}) {
  const sp = safePositiveNumber(soldPrice);
  const pp = safePositiveNumber(purchasePrice);
  if (sp === null || pp === null) return null;
  const f  = safeNonNegativeNumber(fees)         ?? 0;
  const sc = safeNonNegativeNumber(shippingCost) ?? 0;
  return Math.round((sp - pp - f - sc) * 100) / 100;
}

/**
 * Compute time to sale in milliseconds.
 * timeToSale = outcomeUpdatedAt - sourceCapturedAt
 * Returns null if either timestamp is missing or result is negative.
 *
 * @param {number} sourceCapturedAt  — when the item was purchased (ms)
 * @param {number} outcomeUpdatedAt  — when the sale was recorded (ms)
 * @returns {number|null}  milliseconds
 */
export function computeTimeToSale(sourceCapturedAt, outcomeUpdatedAt) {
  if (!sourceCapturedAt || !outcomeUpdatedAt) return null;
  const diff = outcomeUpdatedAt - sourceCapturedAt;
  return diff >= 0 ? diff : null;
}

// ── Outcome Recording ─────────────────────────────────────────────────────────

/**
 * Record the outcome of a scan (sold / unsold / returned).
 * Requires a source record to exist (source proves the purchase happened).
 * Computes netProfit and timeToSale automatically.
 * Idempotent: updating an existing outcome record is allowed.
 *
 * @param {object} redis
 * @param {string} scanId
 * @param {{ userId, soldPrice, platform, fees, shippingCost, outcomeStatus, updatedAt }} opts
 * @returns {Promise<{ ok, record, error? }>}
 */
export async function storeOutcome(redis, scanId, {
  userId        = null,
  soldPrice     = null,
  platform      = null,
  fees          = null,
  shippingCost  = null,
  outcomeStatus = "SOLD",
  updatedAt     = null,
} = {}) {
  if (!redis)  return { ok: false, error: "no_redis" };
  if (!scanId) return { ok: false, error: "missing_scan_id" };
  if (!userId) return { ok: false, error: "missing_user_id" };

  // Require source record — outcome without source means no real purchase
  const source = await getSource(redis, scanId);
  if (!source) {
    return {
      ok: false,
      error: "no_source_record",
      detail: "Submit POST /scan/source before recording an outcome",
    };
  }

  const status = String(outcomeStatus || "SOLD").toUpperCase().trim();
  if (!VALID_OUTCOME_STATUSES.has(status)) {
    return { ok: false, error: "invalid_outcome_status", valid: [...VALID_OUTCOME_STATUSES] };
  }

  // For SOLD outcomes, soldPrice is required
  if (status === "SOLD") {
    const sp = safePositiveNumber(soldPrice);
    if (sp === null) return { ok: false, error: "sold_price_required_for_sold_outcome" };
  }

  const sp         = safePositiveNumber(soldPrice);
  const feesVal    = safeNonNegativeNumber(fees);
  const shippingVal = safeNonNegativeNumber(shippingCost);
  const now        = updatedAt != null ? Number(updatedAt) : Date.now();

  const netProfit   = status === "SOLD"
    ? computeNetProfit({ soldPrice: sp, purchasePrice: source.purchasePrice, fees: feesVal, shippingCost: shippingVal })
    : null;
  const timeToSale  = status === "SOLD"
    ? computeTimeToSale(source.capturedAt, now)
    : null;

  try {
    const record = {
      scanId,
      userId,
      soldPrice:    sp,
      platform:     platform ? String(platform).trim().slice(0, 80) : null,
      fees:         feesVal,
      shippingCost: shippingVal,
      netProfit,
      timeToSale,                  // milliseconds; null if unknown
      outcomeStatus:  status,
      updatedAt:      now,
    };

    await redis.set(KEY_OUTCOME(scanId), JSON.stringify(record), "EX", LOOP_TTL);
    return { ok: true, record };
  } catch (err) {
    return { ok: false, error: "outcome_store_failed", reason: err?.message };
  }
}

/**
 * Retrieve the outcome record for a scan.
 *
 * @param {object} redis
 * @param {string} scanId
 * @returns {Promise<object|null>}
 */
export async function getOutcome(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    return parseStored(await redis.get(KEY_OUTCOME(scanId)));
  } catch { return null; }
}

// ── Unified History ───────────────────────────────────────────────────────────

/**
 * Get the unified closed-loop history for a user.
 * For each scan in the user's index, loads: signal snapshot, decision, source, outcome.
 * Uses pipelining to minimize round-trips.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {{ limit, offset, since, until }} opts
 * @returns {Promise<{ scans: object[], profitSummary: object }>}
 */
export async function getUserLoop(redis, userId, {
  limit  = 50,
  offset = 0,
  since  = null,    // ms timestamp lower bound
  until  = null,    // ms timestamp upper bound
} = {}) {
  if (!redis || !userId) return { scans: [], profitSummary: null };

  try {
    const maxLimit = Math.min(limit, 200);
    const lo = since != null ? Number(since) : "-inf";
    const hi = until != null ? Number(until) : "+inf";

    // Fetch scanIds in reverse-chronological order (newest first)
    const scanIds = await redis.zrevrangebyscore(
      KEY_USER_IDX(userId),
      hi, lo,
      "LIMIT", offset, maxLimit
    ).catch(() => []);

    if (!scanIds || scanIds.length === 0) {
      return { scans: [], profitSummary: _emptySummary() };
    }

    // Pipeline all 4 record types for all scanIds in one round-trip
    const pipeline = redis.pipeline();
    for (const sid of scanIds) {
      pipeline.get(KEY_SIGNAL(sid));
      pipeline.get(KEY_DECISION(sid));
      pipeline.get(KEY_SOURCE(sid));
      pipeline.get(KEY_OUTCOME(sid));
    }
    const results = await pipeline.exec();

    const scans = [];
    for (let i = 0; i < scanIds.length; i++) {
      const base    = i * 4;
      const signal  = parseStored(results[base]?.[1]);
      const dec     = parseStored(results[base + 1]?.[1]);
      const source  = parseStored(results[base + 2]?.[1]);
      const outcome = parseStored(results[base + 3]?.[1]);

      scans.push({
        scanId:    scanIds[i],
        itemName:  signal?.itemName  ?? null,
        category:  signal?.category  ?? dec?.category ?? null,
        signal:    signal?.signal    ?? null,
        trustScore: signal?.trustScore ?? null,
        ts:        signal?.ts ?? dec?.decidedAt ?? null,

        decision: dec ? {
          decision:       dec.decision,
          wasOverride:    dec.wasOverride,
          originalSignal: dec.originalSignal,
          decidedAt:      dec.decidedAt,
        } : null,

        source: source ? {
          purchasePrice: source.purchasePrice,
          askPrice:      source.askPrice,
          sourceType:    source.sourceType,
          city:          source.city,
          zip:           source.zip,
          capturedAt:    source.capturedAt,
        } : null,

        outcome: outcome ? {
          soldPrice:     outcome.soldPrice,
          platform:      outcome.platform,
          fees:          outcome.fees,
          shippingCost:  outcome.shippingCost,
          netProfit:     outcome.netProfit,
          timeToSale:    outcome.timeToSale,
          outcomeStatus: outcome.outcomeStatus,
          updatedAt:     outcome.updatedAt,
        } : null,
      });
    }

    return {
      scans,
      profitSummary: _computeSummary(scans),
    };
  } catch { return { scans: [], profitSummary: _emptySummary() }; }
}

// ── User Metrics ──────────────────────────────────────────────────────────────

/**
 * Compute full profit and behavioral metrics for a user.
 * Reads the full user history (up to 5000 records) and aggregates.
 *
 * Returns:
 *   totalSpent       — sum of purchasePrice across all BUY decisions with source
 *   totalRevenue     — sum of soldPrice across SOLD outcomes
 *   totalProfit      — sum of netProfit across SOLD outcomes
 *   winRate          — % of SOLD outcomes with netProfit > 0
 *   avgROI           — (totalRevenue - totalSpent) / totalSpent * 100
 *   avgTimeToSale    — mean timeToSale in days across SOLD outcomes
 *   overrideRate     — % of decisions that were overrides
 *   categoryBreakdown — per-category stats
 *   platformBreakdown — per-platform stats
 *
 * @param {object} redis
 * @param {string} userId
 * @returns {Promise<object>}
 */
export async function getUserMetrics(redis, userId) {
  if (!redis || !userId) return _emptyMetrics();

  try {
    // Load full history (no pagination — metrics need complete dataset)
    const { scans } = await getUserLoop(redis, userId, { limit: MAX_USER_IDX });

    if (!scans || scans.length === 0) return _emptyMetrics();

    let totalSpent     = 0;
    let totalRevenue   = 0;
    let totalProfit    = 0;
    let totalSold      = 0;
    let totalWins      = 0;
    let totalOverrides = 0;
    let totalDecisions = 0;
    let timesToSale    = [];
    const catMap       = {};
    const platMap      = {};

    for (const scan of scans) {
      const { decision, source, outcome, category } = scan;

      if (decision) {
        totalDecisions++;
        if (decision.wasOverride) totalOverrides++;
      }

      if (source?.purchasePrice) {
        totalSpent += source.purchasePrice;
      }

      if (outcome?.outcomeStatus === "SOLD") {
        totalSold++;
        if (outcome.soldPrice)  totalRevenue += outcome.soldPrice;
        if (outcome.netProfit != null) {
          totalProfit += outcome.netProfit;
          if (outcome.netProfit > 0) totalWins++;
        }
        if (outcome.timeToSale != null) {
          timesToSale.push(outcome.timeToSale);
        }

        // Platform breakdown
        const plat = outcome.platform || "unknown";
        if (!platMap[plat]) platMap[plat] = { sold: 0, revenue: 0, profit: 0 };
        platMap[plat].sold++;
        if (outcome.soldPrice)  platMap[plat].revenue += outcome.soldPrice;
        if (outcome.netProfit != null) platMap[plat].profit += outcome.netProfit;
      }

      // Category breakdown
      const cat = category || "unknown";
      if (!catMap[cat]) catMap[cat] = { scans: 0, buys: 0, sold: 0, profit: 0, spent: 0, revenue: 0 };
      catMap[cat].scans++;
      if (decision?.decision === "BUY") catMap[cat].buys++;
      if (source?.purchasePrice)        catMap[cat].spent   += source.purchasePrice;
      if (outcome?.outcomeStatus === "SOLD") {
        catMap[cat].sold++;
        if (outcome.soldPrice)            catMap[cat].revenue += outcome.soldPrice;
        if (outcome.netProfit != null)    catMap[cat].profit  += outcome.netProfit;
      }
    }

    const avgTimeToSaleDays = timesToSale.length > 0
      ? Math.round(timesToSale.reduce((a, b) => a + b, 0) / timesToSale.length / 86400000 * 10) / 10
      : null;

    const avgROI = totalSpent > 0 && totalSold > 0
      ? Math.round(((totalRevenue - totalSpent) / totalSpent) * 1000) / 10  // one decimal %
      : null;

    // Round monetary values to 2 decimal places
    const round2 = (n) => Math.round(n * 100) / 100;

    return {
      totalScans:       scans.length,
      totalDecisions,
      totalBuys:        scans.filter(s => s.decision?.decision === "BUY").length,
      totalPasses:      scans.filter(s => s.decision?.decision === "PASS").length,
      totalSold,
      totalSpent:       round2(totalSpent),
      totalRevenue:     round2(totalRevenue),
      totalProfit:      round2(totalProfit),
      winRate:          totalSold > 0 ? Math.round((totalWins / totalSold) * 1000) / 10 : null,  // %
      avgROI,           // % return on cost
      avgTimeToSaleDays,
      overrideRate:     totalDecisions > 0 ? Math.round((totalOverrides / totalDecisions) * 1000) / 10 : null,  // %
      categoryBreakdown: Object.entries(catMap).map(([cat, s]) => ({
        category: cat,
        scans:    s.scans,
        buys:     s.buys,
        sold:     s.sold,
        profit:   round2(s.profit),
        spent:    round2(s.spent),
        revenue:  round2(s.revenue),
      })).sort((a, b) => b.profit - a.profit),
      platformBreakdown: Object.entries(platMap).map(([plat, s]) => ({
        platform: plat,
        sold:     s.sold,
        revenue:  round2(s.revenue),
        profit:   round2(s.profit),
      })).sort((a, b) => b.profit - a.profit),
    };
  } catch { return _emptyMetrics(); }
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

function _emptySummary() {
  return {
    totalScans: 0, totalBuys: 0, totalSold: 0,
    totalSpent: 0, totalRevenue: 0, totalProfit: 0,
    winRate: null, overrideCount: 0,
  };
}

function _computeSummary(scans) {
  if (!scans || scans.length === 0) return _emptySummary();
  let totalBuys = 0, totalSold = 0, totalSpent = 0, totalRevenue = 0, totalProfit = 0, totalWins = 0, overrideCount = 0;
  for (const scan of scans) {
    if (scan.decision?.decision === "BUY") totalBuys++;
    if (scan.decision?.wasOverride)        overrideCount++;
    if (scan.source?.purchasePrice)        totalSpent += scan.source.purchasePrice;
    if (scan.outcome?.outcomeStatus === "SOLD") {
      totalSold++;
      if (scan.outcome.soldPrice)               totalRevenue += scan.outcome.soldPrice;
      if (scan.outcome.netProfit != null) {
        totalProfit += scan.outcome.netProfit;
        if (scan.outcome.netProfit > 0) totalWins++;
      }
    }
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    totalScans:   scans.length,
    totalBuys,
    totalSold,
    totalSpent:   round2(totalSpent),
    totalRevenue: round2(totalRevenue),
    totalProfit:  round2(totalProfit),
    winRate:      totalSold > 0 ? Math.round((totalWins / totalSold) * 1000) / 10 : null,
    overrideCount,
  };
}

function _emptyMetrics() {
  return {
    totalScans: 0, totalDecisions: 0, totalBuys: 0, totalPasses: 0, totalSold: 0,
    totalSpent: 0, totalRevenue: 0, totalProfit: 0,
    winRate: null, avgROI: null, avgTimeToSaleDays: null, overrideRate: null,
    categoryBreakdown: [], platformBreakdown: [],
  };
}

// ── Exports (constants for route-layer validation) ────────────────────────────

export { VALID_DECISIONS, VALID_SOURCE_TYPES, PHYSICAL_SOURCE_TYPES, VALID_OUTCOME_STATUSES };
