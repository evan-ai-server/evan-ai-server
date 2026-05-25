// src/confidenceCalibrationEngine.js
// Phase 2 — Confidence calibration engine.
//
// Reads historical prediction snapshots + realized outcomes from outcomeStore
// and produces a calibration report that buckets predicted confidence against
// real directional outcomes and prediction error. This is a measurement layer:
// it does not mutate verdicts, rankings, or scan behavior. The
// `adjustConfidenceWithCalibration` helper is a pure function that callers may
// invoke to obtain a calibrated confidence value alongside the raw one.
//
// Storage:
//   storage/outcomes/calibration/latest.json — most recent rebuilt report

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

import {
  listOutcomesForUser,
  getPredictionSnapshot,
} from "./outcomeStore.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const CALIBRATION_DIR = path.join(_dir, "..", "storage", "outcomes", "calibration");
const LATEST_FILE = path.join(CALIBRATION_DIR, "latest.json");

const BUCKETS = ["0-20", "20-40", "40-60", "60-80", "80-100"];
const VERDICT_KEYS = ["BUY", "HOLD", "PASS"];
const MIN_COUNT_FOR_ADJUSTMENT = 10;

// ── helpers ──────────────────────────────────────────────────────────────────

function bucketConfidence(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return "unknown";
  if (c < 20) return "0-20";
  if (c < 40) return "20-40";
  if (c < 60) return "40-60";
  if (c < 80) return "60-80";
  return "80-100";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nowIso() {
  return new Date().toISOString();
}

function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round(n, digits = 4) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// Normalize a verdict string to one of BUY / HOLD / PASS for grouping.
// Anything BUY-leaning ("BUY", "GOOD FLIP", "GOOD_BUY") rolls into BUY;
// PASS-leaning ("PASS", "AVOID", "BAD") into PASS; everything else HOLD.
function normalizeVerdict(verdict) {
  const v = String(verdict || "").toUpperCase();
  if (!v) return "HOLD";
  if (v.includes("BUY") || v.includes("GOOD") || v.includes("FLIP")) return "BUY";
  if (v.includes("PASS") || v.includes("AVOID") || v.includes("BAD")) return "PASS";
  return "HOLD";
}

function normalizeCategory(category) {
  const c = String(category || "").trim().toLowerCase();
  return c || "unknown";
}

// Bucket midpoints used as the expected direction-accuracy a perfectly
// calibrated model with that confidence band would deliver.
function bucketMidpointPct(bucket) {
  switch (bucket) {
    case "0-20":   return 10;
    case "20-40":  return 30;
    case "40-60":  return 50;
    case "60-80":  return 70;
    case "80-100": return 90;
    default:       return 50;
  }
}

// ── storage ──────────────────────────────────────────────────────────────────

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function saveCalibrationReport(report) {
  if (!report || typeof report !== "object") return false;
  await writeJsonAtomic(LATEST_FILE, report);
  return true;
}

export async function loadLatestCalibrationReport() {
  return readJson(LATEST_FILE, null);
}

// ── core aggregation ─────────────────────────────────────────────────────────

// Pull together prediction + outcome rows that have enough signal to score.
// A row is "usable" when a prediction snapshot exists AND we have either a
// computed predictionError or a numeric realizedProfit on the outcome.
async function collectUsableRows(userId) {
  const outcomes = await listOutcomesForUser(userId, 5000);
  const rows = [];
  for (const o of outcomes) {
    if (!o?.scanId) continue;
    const prediction = await getPredictionSnapshot(o.scanId);
    if (!prediction) continue;

    const hasPredictionError =
      o.predictionError &&
      (Number.isFinite(Number(o.predictionError.profitError)) ||
        typeof o.predictionError.directionCorrect === "boolean");
    const hasRealizedProfit = Number.isFinite(Number(o.realizedProfit));
    if (!hasPredictionError && !hasRealizedProfit) continue;

    rows.push({ prediction, outcome: o });
  }
  return { totalOutcomes: outcomes.length, rows };
}

// Build a calibration sub-report (buckets + rolled stats) from a set of rows.
// Used for the top-level report and for each verdict/category slice.
function buildBucketStats(rows) {
  const byBucket = new Map(BUCKETS.map((b) => [b, []]));

  for (const { prediction, outcome } of rows) {
    const conf = numOrNull(prediction.confidence);
    const bucket = bucketConfidence(conf);
    if (!byBucket.has(bucket)) continue; // skip "unknown"
    byBucket.get(bucket).push({ prediction, outcome });
  }

  const buckets = [];
  let directionCorrectAll = 0;
  let directionKnownAll = 0;
  let confidenceSumAll = 0;
  let confidenceCountAll = 0;
  let gapAbsSum = 0;
  let gapCount = 0;
  let overconfidentBuckets = 0;
  let underconfidentBuckets = 0;
  let bestBucket = null;
  let worstBucket = null;

  for (const bucket of BUCKETS) {
    const items = byBucket.get(bucket) || [];
    const count = items.length;

    const confidences = items
      .map((r) => numOrNull(r.prediction.confidence))
      .filter((v) => v != null);
    const predictedProfits = items
      .map((r) => numOrNull(r.prediction.predictedProfit))
      .filter((v) => v != null);
    const realizedProfits = items
      .map((r) => numOrNull(r.outcome.realizedProfit))
      .filter((v) => v != null);
    const profitErrorsAbs = items
      .map((r) => {
        const pe = r.outcome.predictionError || {};
        const v = numOrNull(pe.profitError);
        return v == null ? null : Math.abs(v);
      })
      .filter((v) => v != null);

    let directionCorrect = 0;
    let directionKnown = 0;
    for (const r of items) {
      const dc = r.outcome?.predictionError?.directionCorrect;
      if (typeof dc === "boolean") {
        directionKnown++;
        if (dc) directionCorrect++;
      }
    }

    const directionAccuracy =
      directionKnown > 0 ? directionCorrect / directionKnown : null;
    const averageConfidence = mean(confidences);
    const averagePredictionError = mean(profitErrorsAbs);
    const averageRealizedProfit = mean(realizedProfits);
    const averagePredictedProfit = mean(predictedProfits);

    // calibrationGap: how many confidence points the model claims vs what it
    // actually delivers as directional accuracy. Positive = overconfident.
    const calibrationGap =
      averageConfidence != null && directionAccuracy != null
        ? averageConfidence - directionAccuracy * 100
        : null;

    // expected accuracy a perfectly calibrated model in this band would hit
    const expectedAccuracy = bucketMidpointPct(bucket) / 100;
    const suggestedConfidenceMultiplier =
      directionAccuracy != null && expectedAccuracy > 0
        ? clamp(directionAccuracy / expectedAccuracy, 0.6, 1.15)
        : null;

    if (calibrationGap != null) {
      gapAbsSum += Math.abs(calibrationGap);
      gapCount++;
      if (calibrationGap > 15) overconfidentBuckets++;
      else if (calibrationGap < -15) underconfidentBuckets++;
      if (count >= MIN_COUNT_FOR_ADJUSTMENT) {
        if (
          bestBucket == null ||
          Math.abs(calibrationGap) < Math.abs(bestBucket.gap)
        ) {
          bestBucket = { bucket, gap: calibrationGap };
        }
        if (
          worstBucket == null ||
          Math.abs(calibrationGap) > Math.abs(worstBucket.gap)
        ) {
          worstBucket = { bucket, gap: calibrationGap };
        }
      }
    }

    directionCorrectAll += directionCorrect;
    directionKnownAll += directionKnown;
    if (averageConfidence != null) {
      confidenceSumAll += averageConfidence * confidences.length;
      confidenceCountAll += confidences.length;
    }

    buckets.push({
      bucket,
      count,
      directionAccuracy: round(directionAccuracy, 4),
      averagePredictionError: round(averagePredictionError, 2),
      averageRealizedProfit: round(averageRealizedProfit, 2),
      averagePredictedProfit: round(averagePredictedProfit, 2),
      averageConfidence: round(averageConfidence, 2),
      calibrationGap: round(calibrationGap, 2),
      suggestedConfidenceMultiplier: round(suggestedConfidenceMultiplier, 4),
    });
  }

  const overallDirectionAccuracy =
    directionKnownAll > 0 ? directionCorrectAll / directionKnownAll : null;
  const averageConfidence =
    confidenceCountAll > 0 ? confidenceSumAll / confidenceCountAll : null;
  // calibrationScore: 1 - normalized mean absolute gap. Gap is in confidence
  // points (0–100); divide by 100 to land in [0,1].
  const calibrationScore =
    gapCount > 0 ? clamp(1 - gapAbsSum / gapCount / 100, 0, 1) : null;

  // Mean absolute profit error across all rows in this slice.
  const allProfitErrors = rows
    .map((r) => {
      const pe = r.outcome?.predictionError || {};
      const v = numOrNull(pe.profitError);
      return v == null ? null : Math.abs(v);
    })
    .filter((v) => v != null);
  const averagePredictionError = mean(allProfitErrors);

  return {
    buckets,
    overallDirectionAccuracy: round(overallDirectionAccuracy, 4),
    averagePredictionError: round(averagePredictionError, 2),
    averageConfidence: round(averageConfidence, 2),
    calibrationScore: round(calibrationScore, 4),
    overconfidentBucketCount: overconfidentBuckets,
    underconfidentBucketCount: underconfidentBuckets,
    bestCalibratedBucket: bestBucket ? bestBucket.bucket : null,
    worstCalibratedBucket: worstBucket ? worstBucket.bucket : null,
  };
}

function emptyReport(userId) {
  return {
    userId: userId || null,
    generatedAt: nowIso(),
    totalOutcomes: 0,
    usableOutcomes: 0,
    buckets: BUCKETS.map((b) => ({
      bucket: b,
      count: 0,
      directionAccuracy: null,
      averagePredictionError: null,
      averageRealizedProfit: null,
      averagePredictedProfit: null,
      averageConfidence: null,
      calibrationGap: null,
      suggestedConfidenceMultiplier: null,
    })),
    byVerdict: Object.fromEntries(VERDICT_KEYS.map((k) => [k, null])),
    byCategory: {},
    global: {
      directionAccuracy: null,
      averagePredictionError: null,
      averageConfidence: null,
      calibrationScore: null,
    },
    overallDirectionAccuracy: null,
    averagePredictionError: null,
    overconfidentBucketCount: 0,
    underconfidentBucketCount: 0,
    bestCalibratedBucket: null,
    worstCalibratedBucket: null,
    calibrationScore: null,
  };
}

export async function buildConfidenceCalibrationReport(userId = null) {
  const { totalOutcomes, rows } = await collectUsableRows(userId);
  if (rows.length === 0) {
    const empty = emptyReport(userId);
    empty.totalOutcomes = totalOutcomes;
    return empty;
  }

  const overall = buildBucketStats(rows);

  // Verdict slices — keyed BUY/HOLD/PASS, null when slice has no rows.
  const verdictGroups = new Map(VERDICT_KEYS.map((k) => [k, []]));
  for (const r of rows) {
    const k = normalizeVerdict(r.prediction.verdict);
    if (verdictGroups.has(k)) verdictGroups.get(k).push(r);
  }
  const byVerdict = {};
  for (const k of VERDICT_KEYS) {
    const slice = verdictGroups.get(k) || [];
    byVerdict[k] = slice.length > 0
      ? { count: slice.length, ...buildBucketStats(slice) }
      : null;
  }

  // Category slices — keyed by normalized category, only emitted when present.
  const categoryGroups = new Map();
  for (const r of rows) {
    const k = normalizeCategory(r.prediction.category);
    if (!categoryGroups.has(k)) categoryGroups.set(k, []);
    categoryGroups.get(k).push(r);
  }
  const byCategory = {};
  for (const [k, slice] of categoryGroups.entries()) {
    byCategory[k] = { count: slice.length, ...buildBucketStats(slice) };
  }

  return {
    userId: userId || null,
    generatedAt: nowIso(),
    totalOutcomes,
    usableOutcomes: rows.length,
    buckets: overall.buckets,
    byVerdict,
    byCategory,
    global: {
      directionAccuracy: overall.overallDirectionAccuracy,
      averagePredictionError: overall.averagePredictionError,
      averageConfidence: overall.averageConfidence,
      calibrationScore: overall.calibrationScore,
    },
    overallDirectionAccuracy: overall.overallDirectionAccuracy,
    averagePredictionError: overall.averagePredictionError,
    overconfidentBucketCount: overall.overconfidentBucketCount,
    underconfidentBucketCount: overall.underconfidentBucketCount,
    bestCalibratedBucket: overall.bestCalibratedBucket,
    worstCalibratedBucket: overall.worstCalibratedBucket,
    calibrationScore: overall.calibrationScore,
  };
}

// ── adjusted confidence (pure function) ──────────────────────────────────────

function pickBucketEntry(slice, bucket) {
  if (!slice || !Array.isArray(slice.buckets)) return null;
  return slice.buckets.find((b) => b.bucket === bucket) || null;
}

function reasonForMultiplier(multiplier) {
  if (multiplier == null || !Number.isFinite(multiplier)) return "calibrated";
  if (multiplier < 0.95) return "historical_overconfidence";
  if (multiplier > 1.05) return "historical_underconfidence";
  return "calibrated";
}

export function adjustConfidenceWithCalibration(
  rawConfidence,
  calibrationReport,
  context = {}
) {
  const raw = numOrNull(rawConfidence);
  const result = {
    rawConfidence: raw,
    adjustedConfidence: raw,
    multiplier: 1,
    source: "none",
    reason: "no_calibration_data",
  };
  if (raw == null || !calibrationReport) return result;

  const bucket = bucketConfidence(raw);
  if (bucket === "unknown") return result;

  const verdict = normalizeVerdict(context.verdict);
  const category = normalizeCategory(context.category);

  // Priority: category → verdict → global. Each must have count >= 10 in the
  // matching bucket before we trust it.
  const candidates = [
    {
      source: `category:${category}:${bucket}`,
      entry: pickBucketEntry(calibrationReport.byCategory?.[category], bucket),
    },
    {
      source: `verdict:${verdict}:${bucket}`,
      entry: pickBucketEntry(calibrationReport.byVerdict?.[verdict], bucket),
    },
    {
      source: `bucket:${bucket}`,
      entry: pickBucketEntry(calibrationReport, bucket),
    },
  ];

  for (const c of candidates) {
    const entry = c.entry;
    if (!entry) continue;
    if (!Number.isFinite(Number(entry.count)) || entry.count < MIN_COUNT_FOR_ADJUSTMENT) continue;
    const m = numOrNull(entry.suggestedConfidenceMultiplier);
    if (m == null) continue;
    const adjusted = clamp(Math.round(raw * m), 0, 100);
    return {
      rawConfidence: raw,
      adjustedConfidence: adjusted,
      multiplier: round(m, 4),
      source: c.source,
      reason: reasonForMultiplier(m),
    };
  }

  return result;
}

// Exported for tests / future callers that want the raw helpers.
export { bucketConfidence, clamp, normalizeVerdict, normalizeCategory };
