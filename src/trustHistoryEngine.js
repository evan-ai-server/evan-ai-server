// src/trustHistoryEngine.js
// Phase 4 — Trust History & Expert Review Pipeline.
//
// Persists the trust/auth outcome for every scan — creating an auditable trail
// that can later feed:
//   - Expert review queue
//   - Model improvement data
//   - Phase 5 "Evan Authenticated" guarantee system
//   - Trust auditability for high-stakes claims
//
// Redis key layout:
//   trust:scan:{scanId}         STRING  full trust record (2yr TTL)
//   trust:user:{userId}         ZSET    scanIds scored by ts (max 200, 1yr TTL)
//   trust:cat:{category}        ZSET    scanIds scored by ts (max 1000, 90d TTL)
//   trust:review:queue          ZSET    scanIds scored by review priority (no TTL)
//   trust:review:{reviewId}     STRING  expert review record (2yr TTL)
//   trust:stats                 HASH    global trust distribution stats
//
// Trust record shape:
//   {
//     scanId, userId, category, brand,
//     trustScore, authVerdict, authEvidenceStrength,
//     authScore, counterfeitFlags[], reviewRecommended,
//     trustState, highStakeRulesTriggered[], warningCodes[],
//     finalBuySignal, scannedPrice,
//     expertVerdict: null,   → filled when reviewed
//     createdAt, updatedAt,
//   }
//
// Expert review record shape:
//   {
//     reviewId, scanId, userId, category,
//     verdict: AUTHENTIC | COUNTERFEIT | UNRESOLVED,
//     notes, reviewer, reviewedAt,
//     evidenceSnapshot,   → frozen at review creation time
//     patternFed: boolean → whether this was fed into counterfeit memory
//   }

import crypto from "crypto";

const SCAN_TTL    = 2 * 365 * 86400;   // 2 years
const USER_TTL    = 1 * 365 * 86400;   // 1 year
const CAT_TTL     = 90 * 86400;        // 90 days
const REVIEW_TTL  = 2 * 365 * 86400;   // 2 years
const MAX_PER_USER = 200;
const MAX_PER_CAT  = 1000;

// Review verdict constants
export const REVIEW_VERDICT = {
  AUTHENTIC:   "AUTHENTIC",
  COUNTERFEIT: "COUNTERFEIT",
  UNRESOLVED:  "UNRESOLVED",
};

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_SCAN    = id       => `trust:scan:${id}`;
const KEY_USER    = userId   => `trust:user:${userId}`;
const KEY_CAT     = category => `trust:cat:${category}`;
const KEY_QUEUE   = ()       => `trust:review:queue`;
const KEY_REVIEW  = id       => `trust:review:${id}`;
const KEY_STATS   = ()       => `trust:stats`;

// ── Store trust record ────────────────────────────────────────────────────────

/**
 * Persist the trust/auth outcome for a completed scan.
 * Called non-blocking after scan response is built.
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId                  {string}
 *   userId                  {string|null}
 *   category                {string}
 *   brand                   {string|null}
 *   trustScore              {number}
 *   authEvidence            {object}   — from authEvidenceModel
 *   trustState              {string}   — from trustStateEngine
 *   highStakesRulesTriggered{string[]} — from highStakesDowngradeRules
 *   finalBuySignal          {string|null}
 *   scannedPrice            {number|null}
 */
export async function storeTrustRecord(redis, {
  scanId,
  userId          = null,
  category        = "",
  brand           = null,
  trustScore      = 0.5,
  authEvidence    = {},
  trustState      = "INSUFFICIENT_EVIDENCE",
  highStakesRulesTriggered = [],
  finalBuySignal  = null,
  scannedPrice    = null,
} = {}) {
  if (!redis || !scanId) return;

  try {
    const now = Date.now();
    const record = {
      scanId,
      userId,
      category,
      brand,
      trustScore:             Math.round(trustScore * 1000) / 1000,
      authVerdict:            authEvidence.verdict || "UNCERTAIN",
      authEvidenceStrength:   authEvidence.evidenceStrength || "NONE",
      authScore:              authEvidence.authScore ?? null,
      counterfeitFlags:       (authEvidence.negativeSignals || [])
                                .filter(s => s.code === "COUNTERFEIT_PATTERN_MATCH")
                                .map(s => ({ code: s.code, detail: s.detail })),
      reviewRecommended:      authEvidence.reviewRecommended ?? false,
      reviewUrgency:          authEvidence.reviewUrgency ?? null,
      trustState,
      warningCodes:           authEvidence.warningCodes || [],
      highStakeRulesTriggered: highStakesRulesTriggered,
      finalBuySignal,
      scannedPrice,
      expertVerdict:          null,
      createdAt:              now,
      updatedAt:              now,
    };

    const pipeline = redis.multi();

    // Main record
    pipeline.set(KEY_SCAN(scanId), JSON.stringify(record), { EX: SCAN_TTL });

    // User index
    if (userId) {
      pipeline.zAdd(KEY_USER(userId), [{ score: now, value: scanId }]);
      pipeline.zRemRangeByRank(KEY_USER(userId), 0, -(MAX_PER_USER + 1));
      pipeline.expire(KEY_USER(userId), USER_TTL);
    }

    // Category index
    if (category) {
      pipeline.zAdd(KEY_CAT(category), [{ score: now, value: scanId }]);
      pipeline.zRemRangeByRank(KEY_CAT(category), 0, -(MAX_PER_CAT + 1));
      pipeline.expire(KEY_CAT(category), CAT_TTL);
    }

    // Expert review queue — add if review recommended
    if (record.reviewRecommended) {
      const queueScore = now + (record.reviewUrgency === "HIGH" ? 1e12 : 0);
      pipeline.zAdd(KEY_QUEUE(), [{ score: queueScore, value: scanId }]);
    }

    // Update distribution stats
    pipeline.hIncrBy(KEY_STATS(), `verdict.${record.authVerdict}`, 1);
    pipeline.hIncrBy(KEY_STATS(), `state.${trustState}`, 1);
    if (record.counterfeitFlags.length > 0) {
      pipeline.hIncrBy(KEY_STATS(), "counterfeitFlagged", 1);
    }
    if (highStakesRulesTriggered.length > 0) {
      pipeline.hIncrBy(KEY_STATS(), "highStakesTriggered", 1);
    }

    await pipeline.exec();
  } catch (err) {
    console.error("[trustHistory] storeTrustRecord error:", err?.message);
  }
}

// ── Get trust record ──────────────────────────────────────────────────────────

export async function getTrustRecord(redis, scanId) {
  if (!redis || !scanId) return null;
  try {
    const raw = await redis.get(KEY_SCAN(scanId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Get user trust history ────────────────────────────────────────────────────

export async function getUserTrustHistory(redis, userId, { limit = 20, offset = 0 } = {}) {
  if (!redis || !userId) return { scanIds: [], records: [], total: 0 };
  try {
    const total  = await redis.zCard(KEY_USER(userId));
    const scanIds = await redis.zRange(KEY_USER(userId), offset, offset + limit - 1, { REV: true });
    const raws   = await Promise.all(scanIds.map(id => redis.get(KEY_SCAN(id)).catch(() => null)));
    const records = raws.map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
    return { scanIds, records, total };
  } catch { return { scanIds: [], records: [], total: 0 }; }
}

// ── Get review queue ──────────────────────────────────────────────────────────

/**
 * Get the expert review queue — items flagged for review, highest priority first.
 */
export async function getReviewQueue(redis, { limit = 20 } = {}) {
  if (!redis) return [];
  try {
    const scanIds = await redis.zRange(KEY_QUEUE(), 0, limit - 1, { REV: true });
    const raws    = await Promise.all(scanIds.map(id => redis.get(KEY_SCAN(id)).catch(() => null)));
    return raws.map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Flag scan for expert review ───────────────────────────────────────────────

/**
 * Manually add a scan to the expert review queue.
 * Used when user or ops flags an item for manual authentication review.
 */
export async function flagForReview(redis, scanId, { urgency = "MEDIUM", reason = null } = {}) {
  if (!redis || !scanId) return { ok: false, error: "missing_scan_id" };
  try {
    const now = Date.now();
    const queueScore = urgency === "HIGH" ? now + 1e12 : now;
    await redis.zAdd(KEY_QUEUE(), [{ score: queueScore, value: scanId }]);

    // Update the trust record with review flag
    const raw = await redis.get(KEY_SCAN(scanId));
    if (raw) {
      const record = JSON.parse(raw);
      record.reviewRecommended = true;
      record.reviewUrgency     = urgency;
      record.manualReviewReason = reason;
      record.updatedAt         = now;
      await redis.set(KEY_SCAN(scanId), JSON.stringify(record), { EX: SCAN_TTL });
    }

    return { ok: true, scanId, urgency };
  } catch (err) {
    return { ok: false, error: "flag_failed", reason: err?.message };
  }
}

// ── Attach expert verdict ─────────────────────────────────────────────────────

/**
 * Record an expert's authentication verdict on a reviewed scan.
 * Connects to counterfeit memory if verdict is COUNTERFEIT.
 *
 * @param {object} redis
 * @param {object} opts
 *   scanId      {string}
 *   verdict     {string}  AUTHENTIC | COUNTERFEIT | UNRESOLVED
 *   reviewer    {string}
 *   notes       {string|null}
 *   isFake      {boolean}
 *   fakeSignals {string[]}  — if counterfeit: list of detected tells
 * @returns {ExpertReviewResult}
 */
export async function attachExpertVerdict(redis, {
  scanId,
  verdict,
  reviewer,
  notes       = null,
  isFake      = false,
  fakeSignals = [],
} = {}) {
  if (!redis || !scanId || !verdict) {
    return { ok: false, error: "missing_required" };
  }
  if (!Object.values(REVIEW_VERDICT).includes(verdict)) {
    return { ok: false, error: "invalid_verdict", valid: Object.values(REVIEW_VERDICT) };
  }

  try {
    const now      = Date.now();
    const reviewId = "rev_" + crypto.randomBytes(6).toString("hex");

    // Get the original trust record for evidence snapshot
    const raw = await redis.get(KEY_SCAN(scanId));
    const trustRecord = raw ? JSON.parse(raw) : null;

    const review = {
      reviewId,
      scanId,
      category:  trustRecord?.category || null,
      brand:     trustRecord?.brand    || null,
      verdict,
      notes,
      reviewer,
      reviewedAt: now,
      evidenceSnapshot: trustRecord ? {
        trustScore:          trustRecord.trustScore,
        authVerdict:         trustRecord.authVerdict,
        authEvidenceStrength:trustRecord.authEvidenceStrength,
        warningCodes:        trustRecord.warningCodes,
        finalBuySignal:      trustRecord.finalBuySignal,
        scannedPrice:        trustRecord.scannedPrice,
      } : null,
      patternFed: false,
    };

    // Store review record
    await redis.set(KEY_REVIEW(reviewId), JSON.stringify(review), { EX: REVIEW_TTL });

    // Update trust record with expert verdict
    if (trustRecord) {
      trustRecord.expertVerdict = { verdict, reviewer, reviewedAt: now, reviewId };
      trustRecord.updatedAt     = now;
      await redis.set(KEY_SCAN(scanId), JSON.stringify(trustRecord), { EX: SCAN_TTL });
    }

    // Remove from review queue (reviewed)
    await redis.zRem(KEY_QUEUE(), scanId).catch(() => {});

    // Update stats
    await redis.hIncrBy(KEY_STATS(), `expertVerdict.${verdict}`, 1).catch(() => {});

    // Feed into counterfeit memory if confirmed fake
    let counterfeitPatternId = null;
    if (isFake && verdict === REVIEW_VERDICT.COUNTERFEIT && trustRecord?.category && trustRecord?.brand) {
      try {
        const { addCounterfeitPattern } = await import("./counterfeitMemory.js");
        counterfeitPatternId = await addCounterfeitPattern(redis, {
          category:    trustRecord.category,
          brand:       trustRecord.brand,
          model:       null,
          patternType: "expert_confirmed",
          attributes:  { brand: trustRecord.brand },
          fakeSignals: fakeSignals.length > 0 ? fakeSignals : ["expert_verified_counterfeit"],
          confidence:  0.95,
          source:      "expert_review",
          addedBy:     reviewer,
        });
        review.patternFed = true;
        await redis.set(KEY_REVIEW(reviewId), JSON.stringify(review), { EX: REVIEW_TTL });
        await redis.hIncrBy(KEY_STATS(), "patternsFed", 1).catch(() => {});
      } catch (err) {
        console.error("[trustHistory] counterfeit feed error:", err?.message);
      }
    }

    return {
      ok: true,
      reviewId,
      scanId,
      verdict,
      reviewer,
      counterfeitPatternId,
      reviewedAt: now,
    };
  } catch (err) {
    return { ok: false, error: "verdict_attach_failed", reason: err?.message };
  }
}

// ── Get review record ─────────────────────────────────────────────────────────

export async function getReviewRecord(redis, reviewId) {
  if (!redis || !reviewId) return null;
  try {
    const raw = await redis.get(KEY_REVIEW(reviewId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Trust ops summary ─────────────────────────────────────────────────────────

/**
 * Get trust system ops summary.
 * Returns verdict distribution, state distribution, recent flags, queue depth.
 */
export async function getTrustOps(redis) {
  if (!redis) return {};
  try {
    const [statsRaw, queueDepth] = await Promise.all([
      redis.hGetAll(KEY_STATS()).catch(() => ({})),
      redis.zCard(KEY_QUEUE()).catch(() => 0),
    ]);

    // Parse stats hash
    const stats = {};
    for (const [k, v] of Object.entries(statsRaw || {})) {
      stats[k] = Number(v) || 0;
    }

    // Build structured summary
    const verdictDist = {
      LIKELY_AUTHENTIC:      stats["verdict.LIKELY_AUTHENTIC"]      || 0,
      LIKELY_COUNTERFEIT:    stats["verdict.LIKELY_COUNTERFEIT"]    || 0,
      UNCERTAIN:             stats["verdict.UNCERTAIN"]             || 0,
      INSUFFICIENT_EVIDENCE: stats["verdict.INSUFFICIENT_EVIDENCE"] || 0,
    };
    const stateDist = {
      VERIFIED_CONFIDENT:             stats["state.VERIFIED_CONFIDENT"]             || 0,
      PROBABLE_BUT_VERIFY:            stats["state.PROBABLE_BUT_VERIFY"]            || 0,
      HIGH_RISK_AUTH:                 stats["state.HIGH_RISK_AUTH"]                 || 0,
      MARKET_GOOD_BUT_AUTH_UNCERTAIN: stats["state.MARKET_GOOD_BUT_AUTH_UNCERTAIN"] || 0,
      INSUFFICIENT_EVIDENCE:          stats["state.INSUFFICIENT_EVIDENCE"]          || 0,
    };

    return {
      verdictDistribution: verdictDist,
      stateDistribution:   stateDist,
      reviewQueueDepth:    queueDepth,
      totalCounterfeitFlagged: stats["counterfeitFlagged"] || 0,
      totalHighStakesTriggered: stats["highStakesTriggered"] || 0,
      expertVerdicts: {
        AUTHENTIC:   stats["expertVerdict.AUTHENTIC"]   || 0,
        COUNTERFEIT: stats["expertVerdict.COUNTERFEIT"] || 0,
        UNRESOLVED:  stats["expertVerdict.UNRESOLVED"]  || 0,
      },
      patternsFedFromReviews: stats["patternsFed"] || 0,
    };
  } catch (err) {
    console.error("[trustHistory] getTrustOps error:", err?.message);
    return {};
  }
}

// ── Category trust pressure ───────────────────────────────────────────────────

/**
 * Get recent counterfeit flagging pressure for a category.
 * Returns count of recent scans flagged in the last N days.
 */
export async function getCategoryTrustPressure(redis, category, { days = 30 } = {}) {
  if (!redis || !category) return { category, flagCount: 0, totalScans: 0 };
  try {
    const since = Date.now() - (days * 86400000);
    const scanIds = await redis.zRangeByScore(KEY_CAT(category), since, "+inf");
    if (scanIds.length === 0) return { category, flagCount: 0, totalScans: 0 };

    const raws = await Promise.all(scanIds.slice(0, 200).map(id =>
      redis.get(KEY_SCAN(id)).catch(() => null)
    ));
    const records = raws.map(r => { try { return r ? JSON.parse(r) : null; } catch { return null; } })
      .filter(Boolean);

    const flagCount = records.filter(r => r.counterfeitFlags?.length > 0 || r.authVerdict === "LIKELY_COUNTERFEIT").length;

    return {
      category,
      flagCount,
      totalScans: records.length,
      flagRate:   records.length > 0 ? Math.round((flagCount / records.length) * 100) / 100 : 0,
      periodDays: days,
    };
  } catch { return { category, flagCount: 0, totalScans: 0 }; }
}
