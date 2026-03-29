// src/calibrationCurveEngine.js
// Calibration Curve Engine — Phase 10 Accuracy Dominance.
//
// GOAL: Track predicted vs observed win rates in deal-strength bins per category.
//
// A well-calibrated Evan means: when the system calls STRONG BUY in the HIGH
// deal-strength bin for "shoes", ~85% of those deals are actually wins.
// When observed rate drifts significantly, that's a signal to tighten.
//
// DEAL STRENGTH BINS:
//   LOW:    [0.10, 0.18)  — marginal
//   MEDIUM: [0.18, 0.26)  — standard
//   HIGH:   [0.26, 0.35)  — strong
//   ELITE:  [0.35, 1.0]   — exceptional
//
// Redis keys:
//   cal_curve:{category}:{signal}:{bin}  HASH  { wins, total, sum_ds, sum_cv }
//
// Probability expression (UI-surfaced only when qualified):
//   "83% observed win rate in this category (47 comparable deals)"
//   Returns null when sampleSize < MIN_BIN_SAMPLES — never fabricate confidence.

const MIN_BIN_SAMPLES = 8;     // minimum outcomes per bin for probability expression
const BIN_TTL         = 180 * 24 * 3600;  // 6 months

export const DS_BINS = [
  { name: "LOW",    min: 0.10, max: 0.18 },
  { name: "MEDIUM", min: 0.18, max: 0.26 },
  { name: "HIGH",   min: 0.26, max: 0.35 },
  { name: "ELITE",  min: 0.35, max: 1.0  },
];

// Expected win-rate reference per signal (for calibration gap measurement)
export const EXPECTED_WIN_RATES = {
  "STRONG BUY": 85,
  "GOOD DEAL":  70,
  "FAIR":       50,
};

const KEY_BIN = (cat, signal, bin) =>
  `cal_curve:${normalizeCat(cat)}:${signal.replace(/\s+/g, "_")}:${bin}`;

// ── Outcome recording ──────────────────────────────────────────────────────────

/**
 * Record an outcome into the calibration curve for a category+signal+bin.
 * Called after a user reports a win or loss for a scan.
 *
 * @param {object} redis
 * @param {{ category, signal, dealStrength, confidence, isWin }} params
 */
export async function recordCurveOutcome(redis, { category, signal, dealStrength, confidence, isWin }) {
  if (!redis || !category || !signal || dealStrength == null) return;

  const bin = classifyDealStrengthBin(dealStrength);
  if (!bin) return;

  const key     = KEY_BIN(category, signal, bin);
  const winVal  = isWin ? 1 : 0;

  // Pipeline for atomicity
  const pipeline = redis.pipeline ? redis.pipeline() : null;
  const r = pipeline || redis;

  r.hincrby(key, "total",   1);
  r.hincrby(key, "wins",    winVal);
  r.hincrbyfloat(key, "sum_ds", dealStrength);
  if (confidence != null) r.hincrbyfloat(key, "sum_cv", confidence);
  r.expire(key, BIN_TTL);

  if (pipeline) await pipeline.exec().catch(() => {});
}

// ── Curve reading ──────────────────────────────────────────────────────────────

/**
 * Get the observed win rate for a specific (category, signal, dealStrength) combo.
 * Returns null when there are not enough samples — never surface unqualified data.
 *
 * @returns {{ observedWinRate, sampleSize, bin, avgDealStrength } | null}
 */
export async function getObservedWinRate(redis, category, signal, dealStrength) {
  if (!redis || !category || !signal || dealStrength == null) return null;

  const bin = classifyDealStrengthBin(dealStrength);
  if (!bin) return null;

  try {
    const data = await redis.hgetall(KEY_BIN(category, signal, bin));
    if (!data?.total) return null;

    const total = Number(data.total || 0);
    const wins  = Number(data.wins  || 0);
    if (total < MIN_BIN_SAMPLES) return null;

    return {
      observedWinRate:  Math.round((wins / total) * 100),
      sampleSize:       total,
      bin,
      avgDealStrength:  data.sum_ds ? round2(Number(data.sum_ds) / total) : null,
    };
  } catch { return null; }
}

/**
 * Get the full calibration curve for a (category, signal) pair.
 * Returns null if no qualified bins exist.
 */
export async function getCalibrationCurve(redis, category, signal) {
  if (!redis || !category || !signal) return null;

  const binData = await Promise.all(
    DS_BINS.map(async (b) => {
      try {
        const data  = await redis.hgetall(KEY_BIN(category, signal, b.name));
        const total = Number(data?.total || 0);
        const wins  = Number(data?.wins  || 0);
        return {
          bin:            b.name,
          min:            b.min,
          max:            b.max,
          total,
          wins,
          winRate:        total >= MIN_BIN_SAMPLES ? Math.round((wins / total) * 100) : null,
          avgDealStrength: data?.sum_ds && total > 0 ? round2(Number(data.sum_ds) / total) : null,
          qualified:      total >= MIN_BIN_SAMPLES,
        };
      } catch {
        return { bin: b.name, min: b.min, max: b.max, total: 0, wins: 0, winRate: null, qualified: false };
      }
    })
  );

  const qualified = binData.filter((b) => b.qualified);
  if (!qualified.length) return null;

  return {
    category,
    signal,
    expectedWinRate: EXPECTED_WIN_RATES[signal] ?? null,
    bins:            binData,
    qualifiedBins:   qualified.length,
    totalOutcomes:   binData.reduce((s, b) => s + b.total, 0),
  };
}

/**
 * Get all calibration curves for a category (all signals).
 */
export async function getAllCurvesForCategory(redis, category) {
  if (!redis || !category) return [];
  const signals = ["STRONG BUY", "GOOD DEAL", "FAIR"];
  const curves  = await Promise.all(signals.map((s) => getCalibrationCurve(redis, category, s)));
  return curves.filter(Boolean);
}

// ── Probability expression (UI-safe) ──────────────────────────────────────────

/**
 * Build a user-facing probability expression string.
 * Returns null if data is insufficient — NEVER fabricate.
 *
 * @param {object|null} observedResult — from getObservedWinRate
 * @param {string}      signal
 * @returns {{ statement, observedRate, sampleSize, bin } | null}
 */
export function buildProbabilityExpression(observedResult, signal) {
  if (!observedResult || observedResult.sampleSize < MIN_BIN_SAMPLES) return null;

  const { observedWinRate, sampleSize, bin } = observedResult;
  const signalLabel = {
    "STRONG BUY": "strong buys",
    "GOOD DEAL":  "good deals",
    "FAIR":       "fair deals",
  }[signal] || "deals";

  return {
    statement:    `${observedWinRate}% observed win rate for ${signalLabel} in this category`,
    observedRate: observedWinRate,
    sampleSize,
    bin,
  };
}

// ── Calibration health assessment ─────────────────────────────────────────────

/**
 * Assess how well-calibrated a category is across all signals.
 * Computes a calibration health score 0–100 and a status label.
 *
 * A healthy category means observed win rates are close to expected rates.
 * Each percentage-point gap incurs a 2pt penalty.
 *
 * @returns {{ category, calibrationScore, status, assessments } | null}
 */
export async function assessCalibrationHealth(redis, category) {
  if (!redis || !category) return null;

  const assessments = [];

  for (const [signal, expected] of Object.entries(EXPECTED_WIN_RATES)) {
    const curve = await getCalibrationCurve(redis, category, signal).catch(() => null);
    if (!curve || !curve.qualifiedBins) continue;

    // Use the most representative qualified bin (MEDIUM or HIGH preferred)
    const repBin = curve.bins.find((b) => b.qualified && (b.bin === "MEDIUM" || b.bin === "HIGH"))
      || curve.bins.find((b) => b.qualified);

    if (!repBin) continue;

    const gap   = Math.abs((repBin.winRate || 0) - expected);
    const score = Math.max(0, 100 - gap * 2);

    assessments.push({
      signal,
      observed:   repBin.winRate,
      expected,
      gap,
      score,
      bin:        repBin.bin,
      sampleSize: curve.totalOutcomes,
    });
  }

  if (!assessments.length) return null;

  const avgScore = Math.round(assessments.reduce((s, a) => s + a.score, 0) / assessments.length);

  return {
    category,
    calibrationScore: avgScore,
    status:           avgScore >= 85 ? "WELL_CALIBRATED" : avgScore >= 65 ? "ACCEPTABLE" : "NEEDS_ATTENTION",
    assessments,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Classify a dealStrength value into a named bin.
 * Returns null if out of range.
 */
export function classifyDealStrengthBin(ds) {
  const n = Number(ds);
  if (!Number.isFinite(n) || n < 0.10) return null;
  for (const b of DS_BINS) {
    if (n >= b.min && n < b.max) return b.name;
  }
  return n >= 0.35 ? "ELITE" : null;
}

function normalizeCat(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }

export { MIN_BIN_SAMPLES };
