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

// Minimum sold-outcome counts before we treat statistical claims as load-
// bearing. Below MIN_SAMPLES_FOR_BIAS we don't claim a directional bias from
// the over/under rates; below MIN_SAMPLES_FOR_BUCKET we don't issue
// source-depth recommendations sourced from one or two rows.
const MIN_SAMPLES_FOR_BIAS = 5;
const MIN_SAMPLES_FOR_BUCKET = 5;

// Phase 4E: evidence tier keys from confidenceCalibration.js — the full
// vocabulary of tiers produced by calibrateEvidenceConfidence(). "unknown"
// catches old predictions that predate the trust block.
const EVIDENCE_TIER_KEYS = [
  "verified_strong",
  "verified_partial",
  "pricing_signal_only",
  "thin_pricing_signal",
  "estimate_only",
  "no_evidence",
  "unknown",
];

function computePricingBias(globalStats) {
  if (!globalStats || !globalStats.count) return "unknown";
  if (globalStats.count < MIN_SAMPLES_FOR_BIAS) return "insufficient_data";
  const over = globalStats.overestimateRate ?? 0;
  const under = globalStats.underestimateRate ?? 0;
  if (over - under >= 0.15) return "overestimating";
  if (under - over >= 0.15) return "underestimating";
  return "balanced";
}

function recommendationFromReport(report) {
  const recs = [];
  const usable = Number(report.usableOutcomes) || 0;
  if (!usable) {
    recs.push(
      "Collect more sold outcomes before changing market prediction behavior."
    );
    return recs;
  }
  if (usable < MIN_SAMPLES_FOR_BIAS) {
    recs.push(
      `Only ${usable} sold outcome${usable === 1 ? "" : "s"} on file — treat market accuracy metrics as preliminary until at least ${MIN_SAMPLES_FOR_BIAS} are collected.`
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
  const singleSource = report.bySourceDepth?.singleSource;
  if (
    singleSource?.marketAccuracyScore != null &&
    singleSource.marketAccuracyScore < 0.75 &&
    (singleSource.count ?? 0) >= MIN_SAMPLES_FOR_BUCKET
  ) {
    recs.push(
      "Single-source market evidence has weak pricing accuracy; continue capping confidence when source diversity is low."
    );
  }
  const thinListings = report.bySourceDepth?.thinListings;
  if (
    thinListings?.marketAccuracyScore != null &&
    thinListings.marketAccuracyScore < 0.75 &&
    (thinListings.count ?? 0) >= MIN_SAMPLES_FOR_BUCKET
  ) {
    recs.push(
      "Thin listing sets produce weaker pricing accuracy; keep retrieval expansion and minimum listing depth gates active."
    );
  }
  return recs;
}

// Phase 4E: wrap price-accuracy stats with a reliability assessment so callers
// know which tier buckets have enough data to trust vs. which are exploratory.
function withReliability(stats, minSamples = MIN_SAMPLES_FOR_BIAS) {
  const count = stats?.count ?? 0;
  const reliability = count === 0 ? "no_data"
    : count < minSamples ? "insufficient_data"
    : "reliable";
  return { ...stats, reliability };
}

function emptyReport(userId = null) {
  const emptyTierEntry = { ...emptyStats(), reliability: "no_data" };
  return {
    userId: userId || null,
    generatedAt: nowIso(),
    totalOutcomes: 0,
    usableOutcomes: 0,
    joinedPredictionCount: 0,
    droppedNoPrediction: 0,
    droppedUnsold: 0,
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
    byEvidenceTier: Object.fromEntries(EVIDENCE_TIER_KEYS.map((k) => [k, emptyTierEntry])),
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

  // Phase 4E: join-drop counters so silent subset exclusion is visible.
  let joinedPredictionCount = 0;
  let droppedNoPrediction   = 0;
  let droppedUnsold         = 0;

  const rows = [];
  for (const outcome of outcomes) {
    const scanId = outcome?.scanId;
    if (!scanId) { droppedNoPrediction++; continue; }

    const prediction = await getPredictionSnapshot(scanId).catch(() => null);
    if (!prediction) { droppedNoPrediction++; continue; }
    joinedPredictionCount++;

    if (outcome.sold !== true) { droppedUnsold++; continue; }

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
      // Phase 4E: read trust block — old predictions without it map to "unknown"
      evidenceTier: prediction.trust?.evidenceTier ?? "unknown",
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

  console.log("PREDICTION_JOIN_SUMMARY", {
    engine: "marketPredictionAccuracy",
    totalOutcomes: outcomes.length,
    joinedPredictionCount,
    droppedNoPrediction,
    droppedUnsold,
  });

  if (!rows.length) {
    const r = emptyReport(userId);
    r.totalOutcomes = outcomes.length;
    r.joinedPredictionCount = joinedPredictionCount;
    r.droppedNoPrediction   = droppedNoPrediction;
    r.droppedUnsold         = droppedUnsold;
    return r;
  }

  const byCategoryRows        = {};
  const byVerdictRows         = {};
  const byMarketConfidenceRows = {};
  const bySourceDepthRows     = {};
  const byEvidenceTierRows    = {};

  for (const row of rows) {
    pushGroup(byCategoryRows,         row.category,        row);
    pushGroup(byVerdictRows,          row.verdict,         row);
    pushGroup(byMarketConfidenceRows, row.marketConfidence, row);
    pushGroup(bySourceDepthRows,      row.sourceDepth,     row);
    pushGroup(byEvidenceTierRows,     row.evidenceTier,    row);
  }

  const global = summarizePriceRows(rows);
  const profitAccuracy = summarizeProfitRows(rows);
  const byCategory = summarizeGroupMap(byCategoryRows);
  const byVerdict = summarizeGroupMap(byVerdictRows, ["BUY", "HOLD", "PASS"]);
  const byMarketConfidence = summarizeGroupMap(byMarketConfidenceRows, [
    "high", "medium", "low", "unknown",
  ]);
  const bySourceDepth = summarizeGroupMap(bySourceDepthRows, [
    "singleSource", "multiSource", "thinListings", "healthyListings", "unknown",
  ]);

  // Phase 4E: build evidence-tier accuracy breakdown, each bucket labelled with
  // reliability so callers never silently act on thin data.
  const byEvidenceTier = {};
  for (const key of EVIDENCE_TIER_KEYS) {
    const tierRows = byEvidenceTierRows[key] || [];
    byEvidenceTier[key] = withReliability(summarizePriceRows(tierRows));
  }
  // Also include any unexpected tier values not in the forced list
  for (const [key, tierRows] of Object.entries(byEvidenceTierRows)) {
    if (!byEvidenceTier[key]) {
      byEvidenceTier[key] = withReliability(summarizePriceRows(tierRows));
    }
  }

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
    joinedPredictionCount,
    droppedNoPrediction,
    droppedUnsold,
    global,
    profitAccuracy,
    byCategory,
    byVerdict,
    byMarketConfidence,
    bySourceDepth,
    byEvidenceTier,
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
