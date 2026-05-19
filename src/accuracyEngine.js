// src/accuracyEngine.js
// Bias-Corrected Signal Accuracy Engine.
//
// Problem: outcome reporting has systematic positive bias.
//   Winners (bought + profited) report outcomes eagerly.
//   Losers (bought + lost) often stay silent.
//   This inflates "apparent accuracy" by 15–30 percentage points.
//
// Solution:
//   1. Track outcomes at signal-tier granularity (STRONG BUY, GOOD DEAL, FAIR)
//   2. Estimate non-reporting rate from scan→outcome conversion rate
//   3. Apply a pessimistic-weighted correction to reported win rates
//   4. Compute calibration score: do signal tiers actually rank accuracy correctly?
//
// Redis key schema:
//   accuracy:outcomes:{userId}   HASH  — per signal outcome tally
//     fields: {signal}:scans, {signal}:reported, {signal}:wins, {signal}:losses
//   accuracy:calibration:{userId} HASH — computed calibration metrics
//     fields: {signal}:calibratedWinRate, {signal}:reportingRate, updatedAt
//   accuracy:global              HASH  — aggregate cross-user signal calibration
//     fields: {signal}:wins, {signal}:losses, {signal}:reported

const KEY_OUTCOMES     = (uid) => `accuracy:outcomes:${uid}`;
const KEY_CALIBRATION  = (uid) => `accuracy:calibration:${uid}`;
const KEY_GLOBAL       = () => `accuracy:global`;
const KEY_SILENCE      = (cat) => `accuracy:silence:${normalizeCatKey(cat)}`;

const TTL_OUTCOMES    = 365 * 86400;  // 1 year
const TTL_CALIBRATION = 30  * 86400;  // refresh monthly
const TTL_SILENCE     = 90  * 86400;  // 90 days

// Minimum solicitation responses before empirical factor qualifies
const MIN_EMPIRICAL_SAMPLES = 30;

// ── Signal tier target accuracy rates (empirical targets) ────────────────────
// These are the accuracy rates a well-calibrated system SHOULD hit.
// Used to generate a calibration score: how close is observed to target?
const SIGNAL_TARGETS = {
  "STRONG BUY": { minWinRate: 0.80, expectedWinRate: 0.85 },
  "GOOD DEAL":  { minWinRate: 0.62, expectedWinRate: 0.70 },
  "FAIR":       { minWinRate: 0.40, expectedWinRate: 0.50 }, // benchmark: ~coin flip
  "RISKY":      { minWinRate: 0.00, expectedWinRate: 0.25 }, // expect low
};

// ── Empirical silence factor (per-category) ───────────────────────────────────

/**
 * Get stored empirical silence factor for a category.
 * Returns null if not set or sample threshold not met.
 */
export async function getEmpiricalSilenceFactor(redis, category) {
  if (!redis || !category) return null;
  try {
    const raw = await redis.hgetall(KEY_SILENCE(category));
    if (!raw?.factor) return null;
    const sampleSize = Number(raw.sampleSize || 0);
    if (sampleSize < MIN_EMPIRICAL_SAMPLES) return null;
    return {
      factor:     round2(Number(raw.factor)),
      sampleSize,
      updatedAt:  Number(raw.updatedAt || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Store computed empirical silence factor for a category.
 * Called by accuracyCalibrationWorker after computing from solicitation data.
 */
export async function setEmpiricalSilenceFactor(redis, category, factor, sampleSize) {
  if (!redis || !category) return;
  const clamped = Math.max(0, Math.min(1, Number(factor) || LOSER_SILENCE_FACTOR));
  try {
    await redis.hmset(KEY_SILENCE(category), {
      factor:     String(round2(clamped)),
      sampleSize: String(Number(sampleSize) || 0),
      updatedAt:  String(Date.now()),
    });
    await redis.expire(KEY_SILENCE(category), TTL_SILENCE);
  } catch { /* non-fatal */ }
}

/**
 * Compute empirical silence factor from outcome_solicitations table.
 * Formula: proportion of non-responding solicitations that are losses,
 * estimated from (responses received: WIN vs LOSS ratio) vs overall scan→outcome rate.
 * Stores result in Redis when sample threshold is met.
 *
 * @param {object} pgPool  — Postgres pool
 * @param {object} redis   — Redis client
 * @param {string} category
 */
export async function computeAndStoreEmpiricalSilenceFactor(pgPool, redis, category) {
  if (!pgPool || !redis || !category) return null;
  try {
    const cat = normalizeCatKey(category);
    const result = await pgPool.query(`
      SELECT
        COUNT(*)                                      AS total_solicited,
        COUNT(response)                               AS responded,
        SUM(CASE WHEN response = 'WIN'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN response = 'LOSS' THEN 1 ELSE 0 END) AS losses
      FROM outcome_solicitations
      WHERE category = $1
        AND solicitation_sent_at IS NOT NULL
        AND solicitation_sent_at > NOW() - INTERVAL '180 days'
    `, [cat]);

    const row        = result.rows[0];
    const total      = Number(row?.total_solicited || 0);
    const responded  = Number(row?.responded || 0);
    const wins       = Number(row?.wins || 0);
    const losses     = Number(row?.losses || 0);

    if (responded < MIN_EMPIRICAL_SAMPLES) return null;

    // Empirical: of silent non-responders, what fraction are losses?
    // Observed response rate = responded / total
    // Observed win rate among responders = wins / responded
    // Assume winners and losers respond at different rates:
    //   silenceFactor = 1 - (winRate_responders / overall_winRate_estimate)
    // Simplified: losses_silent / (total - responded)
    // We estimate losses_silent via: total_losses_est = total * (1 - observed_winRate)
    // Then: losses_silent = total_losses_est - losses_reported
    const observedWinRate = responded > 0 ? wins / responded : 0.5;
    const estTotalLosses  = total * (1 - observedWinRate);
    const silentLosses    = Math.max(0, estTotalLosses - losses);
    const silentTotal     = total - responded;
    const silenceFactor   = silentTotal > 10
      ? round2(Math.max(0.3, Math.min(0.9, silentLosses / silentTotal)))
      : LOSER_SILENCE_FACTOR;

    await setEmpiricalSilenceFactor(redis, cat, silenceFactor, responded);
    return { silenceFactor, sampleSize: responded };
  } catch {
    return null;
  }
}

// ── Non-reporting bias correction ────────────────────────────────────────────
// Estimate: losers under-report by this factor relative to winners.
// If reportingRate (outcomes reported / scans) is X%, and winners report at
// 2× the rate of losers, then actual win rate is lower than observed.
// Formula: trueWinRate = reportedWins / (reportedWins + reportedLosses + estimatedHiddenLosses)
// estimatedHiddenLosses ≈ (1 - reportingRate) * scans * LOSER_SILENCE_FACTOR
const LOSER_SILENCE_FACTOR = 0.65; // 65% of silent outcomes are estimated losses

// ── Record outcome for a signal ───────────────────────────────────────────────

/**
 * Record a scan event (before outcome is known).
 * Called whenever a buy signal is surfaced to the user.
 */
export async function recordSignalScan(redis, userId, signal) {
  if (!redis || !userId || !signal) return;
  const sig = normalizeSignal(signal);
  if (!sig) return;

  const pipe = redis.pipeline();
  pipe.hincrby(KEY_OUTCOMES(userId), `${sig}:scans`, 1);
  pipe.expire(KEY_OUTCOMES(userId), TTL_OUTCOMES);
  await pipe.exec().catch(() => {});
}

/**
 * Record a reported outcome (user told us what happened).
 * @param {object} params
 *   signal      — original buy signal shown to user
 *   didBuy      — boolean
 *   isWin       — boolean (null if unknown, counts as unreported)
 *   profitCents — signed profit in cents (null if not sold yet)
 */
export async function recordSignalOutcome(redis, userId, {
  signal     = null,
  didBuy     = false,
  isWin      = null,
  profitCents = null,
}) {
  if (!redis || !userId) return;
  const sig = normalizeSignal(signal);
  if (!sig) return;

  const pipe = redis.pipeline();
  pipe.hincrby(KEY_OUTCOMES(userId), `${sig}:reported`, 1);

  if (isWin === true || (profitCents != null && Number(profitCents) > 0)) {
    pipe.hincrby(KEY_OUTCOMES(userId), `${sig}:wins`, 1);
  } else if (isWin === false || (profitCents != null && Number(profitCents) <= 0)) {
    pipe.hincrby(KEY_OUTCOMES(userId), `${sig}:losses`, 1);
  }

  // Also record in global calibration hash
  if (isWin === true || (profitCents != null && Number(profitCents) > 0)) {
    pipe.hincrby(KEY_GLOBAL(), `${sig}:wins`, 1);
  } else if (isWin === false || (profitCents != null && Number(profitCents) <= 0)) {
    pipe.hincrby(KEY_GLOBAL(), `${sig}:losses`, 1);
  }
  pipe.hincrby(KEY_GLOBAL(), `${sig}:reported`, 1);

  pipe.expire(KEY_OUTCOMES(userId), TTL_OUTCOMES);
  await pipe.exec().catch(() => {});
}

// ── Compute accuracy profile for a user ──────────────────────────────────────

/**
 * Build a full accuracy profile for a user, bias-corrected.
 *
 * @returns {{
 *   overallAccuracy: number,        // 0–100, bias-corrected
 *   reportedAccuracy: number,       // 0–100, raw (inflated)
 *   reportingRate: number,          // % of scans with reported outcomes
 *   calibrationScore: number,       // 0–100, how well signal tiers rank
 *   signalBreakdown: object[],      // per-signal stats
 *   biasCorrection: object,         // correction metadata
 *   totalScans: number,
 *   totalReported: number,
 * }}
 */
export async function computeAccuracyProfile(redis, userId, { category = null } = {}) {
  if (!redis || !userId) return defaultProfile();

  try {
    const raw = await redis.hgetall(KEY_OUTCOMES(userId));
    if (!raw) return defaultProfile();

    // WS1: use empirical silence factor per category if available
    let empiricalSilenceData = null;
    if (category) {
      empiricalSilenceData = await getEmpiricalSilenceFactor(redis, category);
    }
    const activeSilenceFactor  = empiricalSilenceData?.factor ?? LOSER_SILENCE_FACTOR;
    const silenceFactorSource  = empiricalSilenceData ? "empirical" : "default";
    const empiricalSampleSize  = empiricalSilenceData?.sampleSize ?? null;
    const calibrationConfidence = empiricalSilenceData
      ? (empiricalSilenceData.sampleSize >= 50 ? "HIGH" : "MEDIUM")
      : "ESTIMATED";

    const signals = ["STRONG BUY", "GOOD DEAL", "FAIR", "RISKY"];
    const breakdown = [];
    let totalScans    = 0;
    let totalReported = 0;
    let totalWins     = 0;
    let totalBiasedWins = 0;

    for (const signal of signals) {
      const sig     = normalizeSignal(signal);
      const scans   = Number(raw[`${sig}:scans`]   || 0);
      const reported = Number(raw[`${sig}:reported`] || 0);
      const wins    = Number(raw[`${sig}:wins`]    || 0);
      const losses  = Number(raw[`${sig}:losses`]  || 0);

      totalScans    += scans;
      totalReported += reported;

      if (reported < 3) {
        breakdown.push({ signal, scans, reported, wins, losses,
          reportingRate: null, reportedWinRate: null, biasedWinRate: null, sampleSize: "insufficient" });
        continue;
      }

      const reportingRate  = scans > 0 ? round2((reported / scans) * 100) : null;
      const reportedWinRate = reported > 0 ? round2((wins / reported) * 100) : null;

      // Bias correction: estimate hidden losses (WS1: use empirical factor if available)
      const silentScans      = Math.max(0, scans - reported);
      const estimatedHiddenLosses = Math.round(silentScans * activeSilenceFactor);
      const biasedDenominator = wins + losses + estimatedHiddenLosses;
      const biasedWinRate    = biasedDenominator > 0
        ? round2((wins / biasedDenominator) * 100)
        : reportedWinRate;

      totalWins      += wins;
      totalBiasedWins += (biasedWinRate ?? 0) * reported;

      const target = SIGNAL_TARGETS[signal];
      const targetWinRate = target ? round2(target.expectedWinRate * 100) : null;
      const gapFromTarget = targetWinRate != null && biasedWinRate != null
        ? round2(biasedWinRate - targetWinRate)
        : null;

      breakdown.push({
        signal,
        scans,
        reported,
        wins,
        losses,
        reportingRate:   reportingRate ?? null,
        reportedWinRate: reportedWinRate ?? null,
        biasedWinRate:   biasedWinRate ?? null,
        hiddenLossEstimate: estimatedHiddenLosses,
        targetWinRate,
        gapFromTarget,
        sampleSize: reported >= 20 ? "robust" : reported >= 8 ? "moderate" : "small",
      });
    }

    // Overall accuracy: weighted by reported outcomes, bias-corrected
    const overallReported  = breakdown.reduce((s, b) => s + (b.reported || 0), 0);
    const overallWins      = breakdown.reduce((s, b) => s + (b.wins || 0), 0);
    const overallLosses    = breakdown.reduce((s, b) => s + (b.losses || 0), 0);
    const silentTotal      = Math.max(0, totalScans - totalReported);
    const hiddenLossTotal  = Math.round(silentTotal * activeSilenceFactor);
    const biasedDenom      = overallWins + overallLosses + hiddenLossTotal;

    const reportedAccuracy  = overallReported > 0
      ? round2((overallWins / overallReported) * 100)
      : null;
    const overallAccuracy   = biasedDenom > 0
      ? round2((overallWins / biasedDenom) * 100)
      : null;
    const reportingRate     = totalScans > 0
      ? round2((totalReported / totalScans) * 100)
      : null;

    // Calibration score: do tiers rank in correct order?
    const calibrationScore = computeCalibrationScore(breakdown);

    return {
      overallAccuracy,
      reportedAccuracy,
      reportingRate,
      calibrationScore,
      silenceFactor:          round2(activeSilenceFactor),
      silenceFactorSource,
      empiricalSampleSize,
      calibrationConfidence,
      signalBreakdown: breakdown,
      biasCorrection: {
        loserSilenceFactor:  activeSilenceFactor,
        totalHiddenLossEst:  hiddenLossTotal,
        inflationEstimate:   reportedAccuracy != null && overallAccuracy != null
          ? round2(reportedAccuracy - overallAccuracy)
          : null,
      },
      totalScans,
      totalReported,
    };
  } catch {
    return defaultProfile();
  }
}

/**
 * Get global signal calibration (cross-user, anonymized aggregate).
 */
export async function getGlobalCalibration(redis) {
  if (!redis) return null;
  try {
    const raw = await redis.hgetall(KEY_GLOBAL());
    if (!raw) return null;

    const signals = ["STRONG BUY", "GOOD DEAL", "FAIR", "RISKY"];
    return signals.map((signal) => {
      const sig     = normalizeSignal(signal);
      const reported = Number(raw[`${sig}:reported`] || 0);
      const wins    = Number(raw[`${sig}:wins`]     || 0);
      const losses  = Number(raw[`${sig}:losses`]   || 0);
      const winRate = reported > 0 ? round2((wins / reported) * 100) : null;
      const target  = SIGNAL_TARGETS[signal];
      return {
        signal,
        reported,
        wins,
        losses,
        winRate,
        targetWinRate:   target ? round2(target.expectedWinRate * 100) : null,
        isCalibrated:    winRate != null && target
          ? winRate >= target.minWinRate * 100
          : null,
      };
    });
  } catch {
    return null;
  }
}

// ── Calibration score ─────────────────────────────────────────────────────────

/**
 * Calibration score 0–100:
 * A well-calibrated system has STRONG BUY > GOOD DEAL > FAIR in win rate.
 * Each correct ordering adds points. Bonus for hitting target rates.
 */
function computeCalibrationScore(breakdown) {
  const bySignal = {};
  for (const b of breakdown) {
    if (b.biasedWinRate != null) bySignal[b.signal] = b.biasedWinRate;
  }

  let score = 50; // baseline

  // Ordering checks (each worth 15 points)
  if ((bySignal["STRONG BUY"] ?? 0) > (bySignal["GOOD DEAL"] ?? 0))  score += 15;
  if ((bySignal["GOOD DEAL"]  ?? 0) > (bySignal["FAIR"]      ?? 0))  score += 15;
  if ((bySignal["FAIR"]       ?? 0) > (bySignal["RISKY"]     ?? 0))  score += 10;

  // Absolute threshold bonuses (each worth 5 points)
  for (const [signal, target] of Object.entries(SIGNAL_TARGETS)) {
    const observed = bySignal[signal];
    if (observed != null && observed >= target.minWinRate * 100) score += 5;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ── Accuracy-aware buy signal adjuster ───────────────────────────────────────

/**
 * Adjust a buy signal based on a user's per-tier accuracy track record.
 * If the user consistently loses on GOOD DEAL → downgrade to FAIR.
 * If the user has excellent STRONG BUY track record → add confidence note.
 *
 * @returns {{ adjustedSignal, accuracyNote, originalSignal }}
 */
export function applyAccuracyAdjustment(buySignal, breakdown = []) {
  if (!buySignal || !breakdown.length) {
    return { adjustedSignal: buySignal, accuracyNote: null, originalSignal: buySignal };
  }

  const signalData = breakdown.find(b => b.signal === buySignal);
  if (!signalData || signalData.sampleSize === "insufficient") {
    return { adjustedSignal: buySignal, accuracyNote: null, originalSignal: buySignal };
  }

  const rate   = signalData.biasedWinRate;
  const target = SIGNAL_TARGETS[buySignal];

  if (!target || rate == null) {
    return { adjustedSignal: buySignal, accuracyNote: null, originalSignal: buySignal };
  }

  // Significant under-performance → downgrade
  if (buySignal === "GOOD DEAL" && rate < 40) {
    return {
      adjustedSignal: "FAIR",
      accuracyNote:   `Your track record on GOOD DEAL signals is ${rate.toFixed(0)}% — Evan is being cautious`,
      originalSignal: buySignal,
    };
  }
  if (buySignal === "STRONG BUY" && rate < 60) {
    return {
      adjustedSignal: "GOOD DEAL",
      accuracyNote:   `Your STRONG BUY win rate (${rate.toFixed(0)}%) is below target — Evan downgraded`,
      originalSignal: buySignal,
    };
  }

  // Strong performance → confidence note (no upgrade, just note)
  if (rate >= target.expectedWinRate * 100 && signalData.sampleSize !== "small") {
    return {
      adjustedSignal: buySignal,
      accuracyNote:   `Your ${buySignal} win rate is ${rate.toFixed(0)}% — above target`,
      originalSignal: buySignal,
    };
  }

  return { adjustedSignal: buySignal, accuracyNote: null, originalSignal: buySignal };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCatKey(cat) {
  return String(cat || "general").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
}

function normalizeSignal(signal) {
  if (!signal) return null;
  const s = String(signal).toUpperCase().trim();
  const MAP = {
    "STRONG BUY": "sb",
    "GOOD DEAL":  "gd",
    "FAIR":       "fair",
    "RISKY":      "risky",
    "OVERPRICED": "over",
    "INSUFFICIENT DATA": "insuf",
  };
  return MAP[s] ?? s.toLowerCase().replace(/\s+/g, "_").slice(0, 20);
}

function defaultProfile() {
  return {
    overallAccuracy:       null,
    reportedAccuracy:      null,
    reportingRate:         null,
    calibrationScore:      null,
    silenceFactor:         round2(LOSER_SILENCE_FACTOR),
    silenceFactorSource:   "default",
    empiricalSampleSize:   null,
    calibrationConfidence: "ESTIMATED",
    signalBreakdown:       [],
    biasCorrection:    { loserSilenceFactor: LOSER_SILENCE_FACTOR, totalHiddenLossEst: 0, inflationEstimate: null },
    totalScans:        0,
    totalReported:     0,
  };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
