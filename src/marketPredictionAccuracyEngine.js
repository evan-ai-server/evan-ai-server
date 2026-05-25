// src/marketPredictionAccuracyEngine.js
// Phase 3 — Market prediction accuracy engine.
//
// Measures whether Evan AI's predicted resale price and predicted profit
// matched real-world sale outcomes. This is a measurement/data layer only.
// It does not mutate verdicts, ranking, scan behavior, or UI.

import fs from "fs/promises";
import path from "path";

import {
  listOutcomesForUser,
  getPredictionSnapshot,
} from "./outcomeStore.js";

const OUTCOME_ROOT = path.join(process.cwd(), "storage", "outcomes");
const MARKET_ACCURACY_DIR = path.join(OUTCOME_ROOT, "market-accuracy");
const MARKET_ACCURACY_LATEST = path.join(MARKET_ACCURACY_DIR, "latest.json");

function nowIso() {
  return new Date().toISOString();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function round2(n) {
  return Number.isFinite(Number(n)) ? Number(Number(n).toFixed(2)) : null;
}

function round4(n) {
  return Number.isFinite(Number(n)) ? Number(Number(n).toFixed(4)) : null;
}

function safeLower(v, fallback = "unknown") {
  const s = String(v || "").trim().toLowerCase();
  return s || fallback;
}

function median(nums = []) {
  const arr = nums
    .filter((n) => Number.isFinite(Number(n)))
    .map(Number)
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function emptyStats() {
  return {
    count: 0,
    averagePredictedResalePrice: null,
    averageActualSellPrice: null,
    averageAbsolutePriceError: null,
    averagePercentPriceError: null,
    medianAbsolutePriceError: null,
    overestimatedCount: 0,
    underestimatedCount: 0,
    exactishCount: 0,
    overestimateRate: null,
    underestimateRate: null,
    exactishRate: null,
    marketAccuracyScore: null,
  };
}

function summarizePriceRows(rows = []) {
  if (!rows.length) return emptyStats();

  let predictedSum = 0;
  let actualSum = 0;
  let absErrSum = 0;
  let pctErrSum = 0;
  let overestimatedCount = 0;
  let underestimatedCount = 0;
  let exactishCount = 0;
  const absErrors = [];

  for (const r of rows) {
    predictedSum += r.predictedResalePrice;
    actualSum += r.actualSellPrice;
    absErrSum += r.absolutePriceError;
    pctErrSum += r.percentPriceError;
    absErrors.push(r.absolutePriceError);

    if (r.percentPriceError <= 0.10) exactishCount++;
    // priceError = actual - predicted. Negative => Evan predicted too high.
    if (r.priceError < 0) overestimatedCount++;
    if (r.priceError > 0) underestimatedCount++;
  }

  const count = rows.length;
  const avgPct = pctErrSum / count;

  return {
    count,
    averagePredictedResalePrice: round2(predictedSum / count),
    averageActualSellPrice: round2(actualSum / count),
    averageAbsolutePriceError: round2(absErrSum / count),
    averagePercentPriceError: round4(avgPct),
    medianAbsolutePriceError: round2(median(absErrors)),
    overestimatedCount,
    underestimatedCount,
    exactishCount,
    overestimateRate: round4(overestimatedCount / count),
    underestimateRate: round4(underestimatedCount / count),
    exactishRate: round4(exactishCount / count),
    marketAccuracyScore: round4(clamp(1 - avgPct, 0, 1)),
  };
}

function summarizeProfitRows(rows = []) {
  // Drop the inner Number(): Number(null) === 0 is finite, which would
  // otherwise let rows with null predicted/realized profit pass and contribute
  // synthetic zero errors to the profit accuracy averages.
  const usable = rows.filter(
    (r) =>
      Number.isFinite(r.predictedProfit) &&
      Number.isFinite(r.realizedProfit)
  );

  if (!usable.length) {
    return {
      count: 0,
      averagePredictedProfit: null,
      averageRealizedProfit: null,
      averageAbsoluteProfitError: null,
      averageProfitError: null,
      overestimatedProfitCount: 0,
      underestimatedProfitCount: 0,
      profitAccuracyScore: null,
    };
  }

  let predictedSum = 0;
  let realizedSum = 0;
  let absErrSum = 0;
  let errSum = 0;
  let overestimatedProfitCount = 0;
  let underestimatedProfitCount = 0;

  for (const r of usable) {
    const err = r.realizedProfit - r.predictedProfit;
    predictedSum += r.predictedProfit;
    realizedSum += r.realizedProfit;
    absErrSum += Math.abs(err);
    errSum += err;
    if (err < 0) overestimatedProfitCount++;
    if (err > 0) underestimatedProfitCount++;
  }

  const count = usable.length;
  const avgAbsErr = absErrSum / count;
  const avgRealizedAbs = Math.max(1, Math.abs(realizedSum / count));

  return {
    count,
    averagePredictedProfit: round2(predictedSum / count),
    averageRealizedProfit: round2(realizedSum / count),
    averageAbsoluteProfitError: round2(avgAbsErr),
    averageProfitError: round2(errSum / count),
    overestimatedProfitCount,
    underestimatedProfitCount,
    profitAccuracyScore: round4(clamp(1 - avgAbsErr / avgRealizedAbs, 0, 1)),
  };
}

function sourceDepthKey(prediction = {}) {
  const groups = numOrNull(prediction.sourceGroups);
  const listings = numOrNull(
    prediction.relevantListingCount ?? prediction.listingCount
  );
  if (groups != null && groups <= 1) return "singleSource";
  if (groups != null && groups >= 2) return "multiSource";
  if (listings != null && listings < 3) return "thinListings";
  if (listings != null && listings >= 3) return "healthyListings";
  return "unknown";
}

function computePricingBias(globalStats) {
  if (!globalStats || !globalStats.count) return "unknown";
  const over = globalStats.overestimateRate ?? 0;
  const under = globalStats.underestimateRate ?? 0;
  if (over - under >= 0.15) return "overestimating";
  if (under - over >= 0.15) return "underestimating";
  return "balanced";
}

function recommendationFromReport(report) {
  const recs = [];
  if (!report.usableOutcomes) {
    recs.push(
      "Collect more sold outcomes before changing market prediction behavior."
    );
    return recs;
  }
  if (
    report.global.averagePercentPriceError != null &&
    report.global.averagePercentPriceError > 0.25
  ) {
    recs.push(
      "Market resale estimates are off by more than 25% on average; keep confidence conservative until more category-level calibration is available."
    );
  }
  if (report.pricingBias === "overestimating") {
    recs.push(
      "Evan is overestimating resale prices more often than underestimating; consider future downward adjustment in risky categories."
    );
  }
  if (report.pricingBias === "underestimating") {
    recs.push(
      "Evan is underestimating resale prices more often than overestimating; investigate missed upside in strong categories."
    );
  }
  if (
    report.bySourceDepth?.singleSource?.marketAccuracyScore != null &&
    report.bySourceDepth.singleSource.marketAccuracyScore < 0.75
  ) {
    recs.push(
      "Single-source market evidence has weak pricing accuracy; continue capping confidence when source diversity is low."
    );
  }
  if (
    report.bySourceDepth?.thinListings?.marketAccuracyScore != null &&
    report.bySourceDepth.thinListings.marketAccuracyScore < 0.75
  ) {
    recs.push(
      "Thin listing sets produce weaker pricing accuracy; keep retrieval expansion and minimum listing depth gates active."
    );
  }
  return recs;
}

function emptyReport(userId = null) {
  return {
    userId: userId || null,
    generatedAt: nowIso(),
    totalOutcomes: 0,
    usableOutcomes: 0,
    global: emptyStats(),
    profitAccuracy: summarizeProfitRows([]),
    byCategory: {},
    byVerdict: {
      BUY: emptyStats(),
      HOLD: emptyStats(),
      PASS: emptyStats(),
    },
    byMarketConfidence: {
      high: emptyStats(),
      medium: emptyStats(),
      low: emptyStats(),
      unknown: emptyStats(),
    },
    bySourceDepth: {
      singleSource: emptyStats(),
      multiSource: emptyStats(),
      thinListings: emptyStats(),
      healthyListings: emptyStats(),
      unknown: emptyStats(),
    },
    worstCategories: [],
    bestCategories: [],
    pricingBias: "unknown",
    recommendations: [
      "Collect more sold outcomes before changing market prediction behavior.",
    ],
  };
}

function pushGroup(map, key, row) {
  const k = key || "unknown";
  if (!map[k]) map[k] = [];
  map[k].push(row);
}

function summarizeGroupMap(map, forcedKeys = []) {
  const out = {};
  for (const key of forcedKeys) {
    out[key] = summarizePriceRows(map[key] || []);
  }
  for (const [key, rows] of Object.entries(map)) {
    if (!out[key]) out[key] = summarizePriceRows(rows);
  }
  return out;
}

export async function buildMarketPredictionAccuracyReport(userId = null) {
  const outcomes = await listOutcomesForUser(userId, 10000).catch(() => []);
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return emptyReport(userId);
  }

  const rows = [];
  for (const outcome of outcomes) {
    const scanId = outcome?.scanId;
    if (!scanId) continue;

    const prediction = await getPredictionSnapshot(scanId).catch(() => null);
    if (!prediction) continue;

    if (outcome.sold !== true) continue;

    const actualSellPrice = numOrNull(outcome.actualSellPrice);
    const predictedResalePrice = numOrNull(prediction.predictedResalePrice);
    if (actualSellPrice == null || actualSellPrice <= 0) continue;
    if (predictedResalePrice == null || predictedResalePrice <= 0) continue;

    const priceError = actualSellPrice - predictedResalePrice;
    const absolutePriceError = Math.abs(priceError);
    const percentPriceError = absolutePriceError / actualSellPrice;

    rows.push({
      scanId,
      userId: outcome.userId || prediction.userId || null,
      category: safeLower(prediction.category || "unknown"),
      verdict: String(prediction.verdict || "unknown").toUpperCase(),
      marketConfidence: safeLower(prediction.marketConfidence || "unknown"),
      sourceDepth: sourceDepthKey(prediction),
      predictedResalePrice,
      actualSellPrice,
      priceError,
      absolutePriceError,
      percentPriceError,
      predictedProfit: numOrNull(prediction.predictedProfit),
      realizedProfit: numOrNull(outcome.realizedProfit),
      listingCount: numOrNull(prediction.listingCount),
      relevantListingCount: numOrNull(prediction.relevantListingCount),
      sourceGroups: numOrNull(prediction.sourceGroups),
    });
  }

  if (!rows.length) {
    const r = emptyReport(userId);
    r.totalOutcomes = outcomes.length;
    return r;
  }

  const byCategoryRows = {};
  const byVerdictRows = {};
  const byMarketConfidenceRows = {};
  const bySourceDepthRows = {};

  for (const row of rows) {
    pushGroup(byCategoryRows, row.category, row);
    pushGroup(byVerdictRows, row.verdict, row);
    pushGroup(byMarketConfidenceRows, row.marketConfidence, row);
    pushGroup(bySourceDepthRows, row.sourceDepth, row);
  }

  const global = summarizePriceRows(rows);
  const profitAccuracy = summarizeProfitRows(rows);
  const byCategory = summarizeGroupMap(byCategoryRows);
  const byVerdict = summarizeGroupMap(byVerdictRows, ["BUY", "HOLD", "PASS"]);
  const byMarketConfidence = summarizeGroupMap(byMarketConfidenceRows, [
    "high",
    "medium",
    "low",
    "unknown",
  ]);
  const bySourceDepth = summarizeGroupMap(bySourceDepthRows, [
    "singleSource",
    "multiSource",
    "thinListings",
    "healthyListings",
    "unknown",
  ]);

  const categoryStats = Object.entries(byCategory)
    .map(([category, stats]) => ({ category, ...stats }))
    .filter((x) => x.count > 0 && x.marketAccuracyScore != null);

  const bestCategories = [...categoryStats]
    .sort((a, b) => b.marketAccuracyScore - a.marketAccuracyScore)
    .slice(0, 5);
  const worstCategories = [...categoryStats]
    .sort((a, b) => a.marketAccuracyScore - b.marketAccuracyScore)
    .slice(0, 5);

  const report = {
    userId: userId || null,
    generatedAt: nowIso(),
    totalOutcomes: outcomes.length,
    usableOutcomes: rows.length,
    global,
    profitAccuracy,
    byCategory,
    byVerdict,
    byMarketConfidence,
    bySourceDepth,
    worstCategories,
    bestCategories,
    pricingBias: computePricingBias(global),
    recommendations: [],
  };
  report.recommendations = recommendationFromReport(report);
  return report;
}

async function ensureDir() {
  await fs.mkdir(MARKET_ACCURACY_DIR, { recursive: true });
}

export async function saveMarketPredictionAccuracyReport(report) {
  await ensureDir();
  const tmp = `${MARKET_ACCURACY_LATEST}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(report, null, 2));
  await fs.rename(tmp, MARKET_ACCURACY_LATEST);
  return report;
}

export async function loadLatestMarketPredictionAccuracyReport() {
  try {
    const raw = await fs.readFile(MARKET_ACCURACY_LATEST, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
