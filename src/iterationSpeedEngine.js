// src/iterationSpeedEngine.js
// Phase 5 — Iteration speed engine.
//
// One-command rebuild + health check for Evan AI's data flywheel.
// This is a developer/product infrastructure layer only.
// It does not change scan flow, UI, ranking, verdicts, or confidence behavior.

import fs from "fs/promises";
import path from "path";

import { computeOutcomeMetrics } from "./outcomeStore.js";
import {
  buildConfidenceCalibrationReport,
  saveCalibrationReport,
} from "./confidenceCalibrationEngine.js";
import {
  buildMarketPredictionAccuracyReport,
  saveMarketPredictionAccuracyReport,
} from "./marketPredictionAccuracyEngine.js";
import {
  buildResaleIntelligenceDataset,
  saveResaleIntelligenceDataset,
} from "./resaleIntelligenceDataset.js";

const OUTCOME_ROOT = path.join(process.cwd(), "storage", "outcomes");
const ITERATION_DIR = path.join(OUTCOME_ROOT, "iteration");
const HEALTH_PATH = path.join(ITERATION_DIR, "latest-health.json");
const REGRESSION_PATH = path.join(ITERATION_DIR, "latest-regression-snapshot.json");

const ARTIFACT_PATHS = {
  calibrationPath: path.join(OUTCOME_ROOT, "calibration", "latest.json"),
  marketAccuracyPath: path.join(OUTCOME_ROOT, "market-accuracy", "latest.json"),
  datasetPath: path.join(OUTCOME_ROOT, "resale-dataset", "latest.json"),
  recordsPath: path.join(OUTCOME_ROOT, "resale-dataset", "records.json"),
  healthPath: HEALTH_PATH,
  regressionSnapshotPath: REGRESSION_PATH,
};

function nowIso() {
  return new Date().toISOString();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min = 0, max = 1) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function round4(n) {
  return Number.isFinite(Number(n)) ? Number(Number(n).toFixed(4)) : null;
}

async function ensureIterationDir() {
  await fs.mkdir(ITERATION_DIR, { recursive: true });
}

async function atomicWriteJson(file, data) {
  await ensureIterationDir();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

async function readJsonIfExists(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function artifactExists(file) {
  try {
    const stat = await fs.stat(file);
    return {
      exists: true,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: false, sizeBytes: 0, updatedAt: null };
  }
}

function scoreDataFlywheel({ metrics, calibration, marketAccuracy, dataset }) {
  const totalOutcomes = Number(metrics?.totalOutcomes ?? metrics?.outcomeCount ?? 0);
  const soldCount = Number(metrics?.soldCount ?? 0);
  const usableRecords = Number(dataset?.usableRecords ?? 0);
  const recordsWithProfit = Number(dataset?.dataQuality?.recordsWithProfit ?? 0);
  const recordsWithPriceAccuracy = Number(dataset?.dataQuality?.recordsWithPriceAccuracy ?? 0);

  // calibration report has both top-level calibrationScore and global.calibrationScore
  const calibrationScore = numOrNull(
    calibration?.calibrationScore ?? calibration?.global?.calibrationScore
  );
  const marketAccuracyScore = numOrNull(marketAccuracy?.global?.marketAccuracyScore);

  const outcomeCoverage = clamp(totalOutcomes / 50);
  const soldCoverage = clamp(soldCount / 20);
  const datasetCoverage = clamp(usableRecords / Math.max(1, totalOutcomes));
  const profitCoverage = clamp(recordsWithProfit / Math.max(1, usableRecords));
  const priceCoverage = clamp(recordsWithPriceAccuracy / Math.max(1, usableRecords));
  const calScore = calibrationScore == null ? 0.25 : clamp(calibrationScore);
  const marketScore = marketAccuracyScore == null ? 0.25 : clamp(marketAccuracyScore);

  const score =
    outcomeCoverage * 0.15 +
    soldCoverage * 0.25 +
    datasetCoverage * 0.15 +
    profitCoverage * 0.15 +
    priceCoverage * 0.10 +
    calScore * 0.10 +
    marketScore * 0.10;

  return round4(score);
}

function buildHealth({ userId, metrics, calibration, marketAccuracy, dataset, artifactStates }) {
  const warnings = [];
  const blockers = [];
  const recommendations = [];

  const totalOutcomes = Number(metrics?.totalOutcomes ?? metrics?.outcomeCount ?? 0);
  const soldCount = Number(metrics?.soldCount ?? 0);
  const usableRecords = Number(dataset?.usableRecords ?? 0);
  const recordsWithProfit = Number(dataset?.dataQuality?.recordsWithProfit ?? 0);
  const recordsWithPriceAccuracy = Number(dataset?.dataQuality?.recordsWithPriceAccuracy ?? 0);
  const calibrationScore = numOrNull(
    calibration?.calibrationScore ?? calibration?.global?.calibrationScore
  );
  const marketAccuracyScore = numOrNull(marketAccuracy?.global?.marketAccuracyScore);

  for (const [name, state] of Object.entries(artifactStates || {})) {
    if (!state.exists) {
      blockers.push(`Missing artifact: ${name}`);
    }
  }

  if (totalOutcomes === 0) {
    recommendations.push(
      "Collect real outcomes by scanning items and marking bought/listed/sold."
    );
  }

  if (soldCount < 5) {
    warnings.push("Sold outcome sample size is still low; learning metrics are preliminary.");
    recommendations.push(
      "Prioritize getting at least 5 sold outcomes to make Phase 2/3 metrics meaningful."
    );
  } else if (soldCount < 20) {
    warnings.push("Data flywheel is learning, but not statistically deep yet.");
    recommendations.push(
      "Aim for 20+ sold outcomes before making behavior-changing calibration decisions."
    );
  }

  if (usableRecords < totalOutcomes) {
    warnings.push(
      "Some outcomes are missing prediction snapshots and could not join into the dataset."
    );
  }

  if (soldCount > 0 && recordsWithProfit < soldCount) {
    warnings.push("Some sold outcomes are missing profit data.");
    recommendations.push(
      "Make sure sold outcomes capture actualSellPrice, actualFees, shippingCost, and actualBuyPrice."
    );
  }

  if (soldCount > 0 && recordsWithPriceAccuracy < soldCount) {
    warnings.push("Some sold outcomes are missing price accuracy data.");
    recommendations.push(
      "Verify prediction snapshots include predictedResalePrice and sold outcomes include actualSellPrice."
    );
  }

  if (calibrationScore != null && calibrationScore < 0.5) {
    warnings.push("Calibration score is weak; confidence may not match reality yet.");
  }

  if (marketAccuracyScore != null && marketAccuracyScore < 0.5) {
    warnings.push("Market accuracy score is weak; resale price estimates need more outcome data.");
  }

  const score = scoreDataFlywheel({ metrics, calibration, marketAccuracy, dataset });

  let status = "collecting";
  if (blockers.length > 0) {
    status = "needs_attention";
  } else if (totalOutcomes === 0) {
    status = "empty";
  } else if (soldCount < 5) {
    status = "collecting";
  } else if (
    soldCount >= 20 &&
    calibrationScore != null &&
    calibrationScore >= 0.65 &&
    marketAccuracyScore != null &&
    marketAccuracyScore >= 0.65
  ) {
    status = "healthy";
  } else if (soldCount >= 5 && usableRecords >= 5) {
    status = "learning";
  }

  return { userId: userId || null, status, score, warnings, blockers, recommendations };
}

function buildRegressionSnapshot({
  userId,
  metrics,
  calibration,
  marketAccuracy,
  dataset,
  health,
}) {
  return {
    userId: userId || null,
    generatedAt: nowIso(),
    metrics: {
      totalOutcomes: metrics?.totalOutcomes ?? metrics?.outcomeCount ?? 0,
      soldCount: metrics?.soldCount ?? 0,
      totalRealizedProfit: metrics?.totalRealizedProfit ?? metrics?.totalProfit ?? 0,
      directionAccuracy: metrics?.directionAccuracy ?? null,
      averagePredictionError:
        metrics?.averagePredictionError ?? metrics?.meanAbsoluteProfitError ?? null,
    },
    calibration: {
      usableOutcomes: calibration?.usableOutcomes ?? 0,
      calibrationScore:
        calibration?.calibrationScore ?? calibration?.global?.calibrationScore ?? null,
      overconfidentBucketCount: calibration?.overconfidentBucketCount ?? 0,
      underconfidentBucketCount: calibration?.underconfidentBucketCount ?? 0,
    },
    marketAccuracy: {
      usableOutcomes: marketAccuracy?.usableOutcomes ?? 0,
      marketAccuracyScore: marketAccuracy?.global?.marketAccuracyScore ?? null,
      pricingBias: marketAccuracy?.pricingBias ?? "unknown",
    },
    dataset: {
      usableRecords: dataset?.usableRecords ?? 0,
      totalOutcomes: dataset?.totalOutcomes ?? 0,
      soldRecordCount: dataset?.dataQuality?.soldRecordCount ?? 0,
      recordsWithProfit: dataset?.dataQuality?.recordsWithProfit ?? 0,
      recordsWithPriceAccuracy: dataset?.dataQuality?.recordsWithPriceAccuracy ?? 0,
      missingPredictionCount: dataset?.dataQuality?.missingPredictionCount ?? 0,
    },
    health,
  };
}

export async function compareAgainstLatestRegressionSnapshot(currentSnapshot) {
  const previous = await loadLatestRegressionSnapshot();
  if (!previous || !currentSnapshot) {
    return {
      compared: false,
      reason: "missing_previous_or_current_snapshot",
      regressions: [],
      improvements: [],
    };
  }

  const regressions = [];
  const improvements = [];

  function compareNumber(dotPath, label, threshold = 0.05) {
    const get = (obj) => dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
    const before = Number(get(previous));
    const after = Number(get(currentSnapshot));
    if (!Number.isFinite(before) || !Number.isFinite(after)) return;
    const delta = after - before;
    if (delta <= -threshold) regressions.push({ label, before, after, delta });
    if (delta >= threshold) improvements.push({ label, before, after, delta });
  }

  compareNumber("health.score", "Data flywheel health score", 0.05);
  compareNumber("metrics.directionAccuracy", "Direction accuracy", 0.05);
  compareNumber("calibration.calibrationScore", "Calibration score", 0.05);
  compareNumber("marketAccuracy.marketAccuracyScore", "Market accuracy score", 0.05);

  return {
    compared: true,
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: currentSnapshot.generatedAt,
    regressions,
    improvements,
  };
}

export async function loadLatestIterationHealth() {
  return readJsonIfExists(HEALTH_PATH);
}

export async function loadLatestRegressionSnapshot() {
  return readJsonIfExists(REGRESSION_PATH);
}

export async function rebuildDataFlywheel(userId = null, options = {}) {
  const t0 = Date.now();

  const metrics = await computeOutcomeMetrics(userId);

  const calibration = await buildConfidenceCalibrationReport(userId);
  await saveCalibrationReport(calibration);

  const marketAccuracy = await buildMarketPredictionAccuracyReport(userId);
  await saveMarketPredictionAccuracyReport(marketAccuracy);

  const dataset = await buildResaleIntelligenceDataset(userId);
  await saveResaleIntelligenceDataset(dataset);

  // Check artifact states (skip health/regression — they don't exist yet)
  const artifactStates = {};
  for (const [name, file] of Object.entries(ARTIFACT_PATHS)) {
    if (name === "healthPath" || name === "regressionSnapshotPath") continue;
    artifactStates[name] = await artifactExists(file);
  }

  const health = buildHealth({ userId, metrics, calibration, marketAccuracy, dataset, artifactStates });

  const regressionSnapshot = buildRegressionSnapshot({
    userId,
    metrics,
    calibration,
    marketAccuracy,
    dataset,
    health,
  });

  // Compare against previous before overwriting
  let regressionComparison = null;
  try {
    regressionComparison = await compareAgainstLatestRegressionSnapshot(regressionSnapshot);
  } catch {
    regressionComparison = {
      compared: false,
      reason: "comparison_failed",
      regressions: [],
      improvements: [],
    };
  }

  await atomicWriteJson(HEALTH_PATH, health);
  await atomicWriteJson(REGRESSION_PATH, regressionSnapshot);

  artifactStates.healthPath = await artifactExists(HEALTH_PATH);
  artifactStates.regressionSnapshotPath = await artifactExists(REGRESSION_PATH);

  return {
    ok: true,
    userId: userId || null,
    generatedAt: nowIso(),
    durationMs: Date.now() - t0,
    phases: {
      outcomes: {
        ok: true,
        totalOutcomes: metrics?.totalOutcomes ?? metrics?.outcomeCount ?? 0,
        soldCount: metrics?.soldCount ?? 0,
        totalRealizedProfit: metrics?.totalRealizedProfit ?? metrics?.totalProfit ?? 0,
        directionAccuracy: metrics?.directionAccuracy ?? null,
      },
      calibration: {
        ok: true,
        usableOutcomes: calibration?.usableOutcomes ?? 0,
        calibrationScore:
          calibration?.calibrationScore ?? calibration?.global?.calibrationScore ?? null,
        overconfidentBucketCount: calibration?.overconfidentBucketCount ?? 0,
        underconfidentBucketCount: calibration?.underconfidentBucketCount ?? 0,
      },
      marketAccuracy: {
        ok: true,
        usableOutcomes: marketAccuracy?.usableOutcomes ?? 0,
        marketAccuracyScore: marketAccuracy?.global?.marketAccuracyScore ?? null,
        pricingBias: marketAccuracy?.pricingBias ?? "unknown",
      },
      dataset: {
        ok: true,
        usableRecords: dataset?.usableRecords ?? 0,
        totalOutcomes: dataset?.totalOutcomes ?? 0,
        soldRecordCount: dataset?.dataQuality?.soldRecordCount ?? 0,
        recordsWithProfit: dataset?.dataQuality?.recordsWithProfit ?? 0,
        recordsWithPriceAccuracy: dataset?.dataQuality?.recordsWithPriceAccuracy ?? 0,
      },
    },
    health,
    artifacts: ARTIFACT_PATHS,
    artifactStates,
    regressionSnapshot,
    regressionComparison,
  };
}
