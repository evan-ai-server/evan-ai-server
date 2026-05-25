// src/resaleIntelligenceDataset.js
// Phase 4 — Resale intelligence dataset builder.
//
// Joins immutable prediction snapshots with mutable realized outcomes and
// produces normalized records for learning, analytics, audits, and future
// calibration. This is a data layer only — no UI, verdict, ranking, or scan
// behavior changes.

import fs from "fs/promises";
import path from "path";

import {
  listOutcomesForUser,
  getPredictionSnapshot,
} from "./outcomeStore.js";

import { loadLatestCalibrationReport } from "./confidenceCalibrationEngine.js";

import { loadLatestMarketPredictionAccuracyReport } from "./marketPredictionAccuracyEngine.js";

const OUTCOME_ROOT = path.join(process.cwd(), "storage", "outcomes");
const DATASET_DIR = path.join(OUTCOME_ROOT, "resale-dataset");
const DATASET_LATEST = path.join(DATASET_DIR, "latest.json");
const DATASET_RECORDS = path.join(DATASET_DIR, "records.json");

function nowIso() {
  return new Date().toISOString();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Number.isFinite(Number(n)) ? Number(Number(n).toFixed(2)) : null;
}

function round4(n) {
  return Number.isFinite(Number(n)) ? Number(Number(n).toFixed(4)) : null;
}

function safeString(v, fallback = "unknown") {
  const s = String(v || "").trim();
  return s || fallback;
}

function safeLower(v, fallback = "unknown") {
  return safeString(v, fallback).toLowerCase();
}

function bucketConfidence(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return "unknown";
  if (c < 20) return "0-20";
  if (c < 40) return "20-40";
  if (c < 60) return "40-60";
  if (c < 80) return "60-80";
  return "80-100";
}

function sourceDepthBucket(prediction = {}) {
  const sourceGroups = numOrNull(prediction.sourceGroups);
  const relevant = numOrNull(prediction.relevantListingCount);
  const listingCount = numOrNull(prediction.listingCount);
  const listings = relevant ?? listingCount;
  if (sourceGroups != null && sourceGroups <= 1) return "singleSource";
  if (sourceGroups != null && sourceGroups >= 2) return "multiSource";
  if (listings != null && listings < 3) return "thinListings";
  if (listings != null && listings >= 3) return "healthyListings";
  return "unknown";
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return null;
  if (bMs < aMs) return null;
  return round2((bMs - aMs) / 86_400_000);
}

function getDaysToSell(outcome = {}) {
  const explicit = numOrNull(outcome.daysToSell);
  if (explicit != null) return explicit;
  if (outcome.listedAt && outcome.soldAt) {
    return daysBetween(outcome.listedAt, outcome.soldAt);
  }
  if (outcome.createdAt && outcome.soldAt) {
    return daysBetween(outcome.createdAt, outcome.soldAt);
  }
  return null;
}

function getTopListingStats(prediction = {}) {
  const top = Array.isArray(prediction.topListings) ? prediction.topListings : [];
  const prices = top
    .map((x) => numOrNull(x?.totalPrice ?? x?.price))
    .filter((x) => x != null);
  const sources = [
    ...new Set(
      top
        .map((x) => safeString(x?.source || x?.store || "", ""))
        .filter(Boolean)
    ),
  ];
  return {
    topListingSources: sources.slice(0, 10),
    topListingPriceMin: prices.length ? round2(Math.min(...prices)) : null,
    topListingPriceMax: prices.length ? round2(Math.max(...prices)) : null,
  };
}

function getCalibrationLabel(record, calibrationReport) {
  if (
    !calibrationReport ||
    !record.confidenceBucket ||
    record.confidenceBucket === "unknown"
  ) {
    return "unknown";
  }
  const bucket = Array.isArray(calibrationReport.buckets)
    ? calibrationReport.buckets.find((b) => b.bucket === record.confidenceBucket)
    : null;
  if (!bucket || !bucket.count) return "insufficient_data";
  const gap = numOrNull(bucket.calibrationGap);
  if (gap == null) return "unknown";
  if (gap >= 15) return "overconfident";
  if (gap <= -15) return "underconfident";
  return "calibrated";
}

function getMarketAccuracyLabel(record) {
  if (!record.sold || record.percentPriceError == null) return "unknown";
  if (record.percentPriceError <= 0.1) return "accurate";
  if (record.percentPriceError <= 0.25) return "acceptable";
  return "inaccurate";
}

function buildLearningLabels(record) {
  const confidence = numOrNull(record.confidence);
  const realizedProfit = numOrNull(record.realizedProfit);
  const predictedResale = numOrNull(record.predictedResalePrice);
  const actualSell = numOrNull(record.actualSellPrice);
  const relevant = numOrNull(record.relevantListingCount);
  const sourceGroups = numOrNull(record.sourceGroups);
  const daysToSell = numOrNull(record.daysToSell);

  let overestimatedMarket = false;
  let underestimatedMarket = false;
  if (
    record.sold === true &&
    predictedResale != null &&
    actualSell != null &&
    actualSell > 0
  ) {
    const diffPct = Math.abs(actualSell - predictedResale) / actualSell;
    if (diffPct > 0.15 && predictedResale > actualSell) overestimatedMarket = true;
    if (diffPct > 0.15 && actualSell > predictedResale) underestimatedMarket = true;
  }

  const verdict = String(record.verdict || "").toUpperCase();
  const directionCorrect = record.directionCorrect;
  const highConfidenceMiss =
    confidence != null && confidence >= 70 && directionCorrect === false;
  const badCall =
    (["BUY", "HOLD"].includes(verdict) &&
      realizedProfit != null &&
      realizedProfit < 0) ||
    highConfidenceMiss;

  return {
    profitableFlip: record.sold === true && realizedProfit != null && realizedProfit > 0,
    badCall,
    overestimatedMarket,
    underestimatedMarket,
    thinMarket: relevant != null ? relevant < 3 : false,
    singleSourceMarket: sourceGroups != null ? sourceGroups <= 1 : false,
    highConfidenceMiss,
    lowConfidenceWin:
      confidence != null &&
      confidence < 50 &&
      realizedProfit != null &&
      realizedProfit > 0,
    fastSale: record.sold === true && daysToSell != null && daysToSell <= 7,
    slowSale: record.sold === true && daysToSell != null && daysToSell >= 30,
  };
}

function buildRecord({ outcome, prediction, calibrationReport }) {
  const actualSellPrice = numOrNull(outcome.actualSellPrice);
  const predictedResalePrice = numOrNull(prediction.predictedResalePrice);
  const predictedProfit = numOrNull(prediction.predictedProfit);
  const realizedProfit = numOrNull(outcome.realizedProfit);

  const priceError =
    actualSellPrice != null &&
    actualSellPrice > 0 &&
    predictedResalePrice != null &&
    predictedResalePrice > 0
      ? round2(actualSellPrice - predictedResalePrice)
      : null;
  const absolutePriceError = priceError != null ? round2(Math.abs(priceError)) : null;
  const percentPriceError =
    absolutePriceError != null && actualSellPrice > 0
      ? round4(absolutePriceError / actualSellPrice)
      : null;

  const profitError =
    realizedProfit != null && predictedProfit != null
      ? round2(realizedProfit - predictedProfit)
      : null;
  const absoluteProfitError =
    profitError != null ? round2(Math.abs(profitError)) : null;

  const daysToSell = getDaysToSell(outcome);
  const confidenceBucket = bucketConfidence(prediction.confidence);
  const topStats = getTopListingStats(prediction);

  const record = {
    scanId: outcome.scanId || prediction.scanId || null,
    userId: outcome.userId || prediction.userId || null,
    deviceId: outcome.deviceId || prediction.deviceId || null,
    guestId: outcome.guestId || prediction.guestId || null,
    createdAt: prediction.createdAt || outcome.createdAt || null,
    query: prediction.query || null,
    category: prediction.category || "unknown",
    itemName: prediction.itemName || null,
    verdict: prediction.verdict || null,
    confidence: numOrNull(prediction.confidence),
    confidenceBucket,
    reasonCode: prediction.reasonCode || null,
    scannedPrice: numOrNull(prediction.scannedPrice),
    predictedResalePrice,
    actualSellPrice,
    predictedProfit,
    realizedProfit,
    profitError,
    absoluteProfitError,
    priceError,
    absolutePriceError,
    percentPriceError,
    predictedMarginPct: numOrNull(prediction.predictedMarginPct),
    realizedMarginPct: numOrNull(outcome.realizedMarginPct),
    bought: outcome.bought === true,
    listed: outcome.listed === true,
    sold: outcome.sold === true,
    actualBuyPrice: numOrNull(outcome.actualBuyPrice),
    listingPrice: numOrNull(outcome.listingPrice),
    actualFees: numOrNull(outcome.actualFees),
    shippingCost: numOrNull(outcome.shippingCost),
    salePlatform: outcome.salePlatform || null,
    daysToSell,
    directionCorrect:
      typeof outcome?.predictionError?.directionCorrect === "boolean"
        ? outcome.predictionError.directionCorrect
        : null,
    wasProfitable: realizedProfit != null ? realizedProfit > 0 : null,
    listingCount: numOrNull(prediction.listingCount),
    relevantListingCount: numOrNull(prediction.relevantListingCount),
    sourceGroups: numOrNull(prediction.sourceGroups),
    sourceDepthBucket: sourceDepthBucket(prediction),
    marketConfidence: prediction.marketConfidence || "unknown",
    marketEvidenceReason: prediction.marketEvidenceReason || null,
    ...topStats,
    confidenceCalibrationLabel: "unknown",
    marketAccuracyLabel: "unknown",
    learningLabels: {},
  };

  record.confidenceCalibrationLabel = getCalibrationLabel(record, calibrationReport);
  record.marketAccuracyLabel = getMarketAccuracyLabel(record);
  record.learningLabels = buildLearningLabels(record);
  return record;
}

function emptyAggregate() {
  return {
    count: 0,
    soldCount: 0,
    profitableCount: 0,
    totalRealizedProfit: 0,
    averageRealizedProfit: null,
    averagePercentPriceError: null,
    averageAbsoluteProfitError: null,
    directionAccuracy: null,
    winRate: null,
  };
}

function summarizeRecords(records = []) {
  if (!records.length) return emptyAggregate();

  let soldCount = 0;
  let profitableCount = 0;
  let totalProfit = 0;
  let profitCount = 0;
  let pctErrSum = 0;
  let pctErrCount = 0;
  let absProfitErrSum = 0;
  let absProfitErrCount = 0;
  let directionKnown = 0;
  let directionCorrect = 0;

  for (const r of records) {
    if (r.sold === true) soldCount++;
    if (r.realizedProfit != null) {
      totalProfit += Number(r.realizedProfit);
      profitCount++;
      if (Number(r.realizedProfit) > 0) profitableCount++;
    }
    if (r.percentPriceError != null) {
      pctErrSum += Number(r.percentPriceError);
      pctErrCount++;
    }
    if (r.absoluteProfitError != null) {
      absProfitErrSum += Number(r.absoluteProfitError);
      absProfitErrCount++;
    }
    if (typeof r.directionCorrect === "boolean") {
      directionKnown++;
      if (r.directionCorrect) directionCorrect++;
    }
  }

  return {
    count: records.length,
    soldCount,
    profitableCount,
    totalRealizedProfit: round2(totalProfit),
    averageRealizedProfit: profitCount > 0 ? round2(totalProfit / profitCount) : null,
    averagePercentPriceError:
      pctErrCount > 0 ? round4(pctErrSum / pctErrCount) : null,
    averageAbsoluteProfitError:
      absProfitErrCount > 0 ? round2(absProfitErrSum / absProfitErrCount) : null,
    directionAccuracy:
      directionKnown > 0 ? round4(directionCorrect / directionKnown) : null,
    winRate: soldCount > 0 ? round4(profitableCount / soldCount) : null,
  };
}

function pushGroup(map, key, record) {
  const k = safeString(key, "unknown");
  if (!map[k]) map[k] = [];
  map[k].push(record);
}

function summarizeGroupMap(map) {
  const out = {};
  for (const [key, records] of Object.entries(map)) {
    out[key] = summarizeRecords(records);
  }
  return out;
}

function buildInsights(aggregates = {}) {
  const byCategory = aggregates.byCategory || {};
  const byPlatform = aggregates.byPlatform || {};
  const byVerdict = aggregates.byVerdict || {};
  const bySourceDepth = aggregates.bySourceDepth || {};

  const categoryRows = Object.entries(byCategory)
    .map(([category, stats]) => ({ category, ...stats }))
    .filter((x) => x.count > 0);

  const platformRows = Object.entries(byPlatform)
    .map(([platform, stats]) => ({ platform, ...stats }))
    .filter((x) => x.count > 0);

  const verdictRows = Object.entries(byVerdict)
    .map(([verdict, stats]) => ({ verdict, ...stats }))
    .filter((x) => x.count > 0);

  const sourceDepthRows = Object.entries(bySourceDepth)
    .map(([sourceDepth, stats]) => ({ sourceDepth, ...stats }))
    .filter((x) => x.count > 0 && x.directionAccuracy != null);

  // Only rank categories/platforms that have at least one realized-profit
  // datapoint. Otherwise nulls coerced to ±Infinity dominate the rankings
  // and a single sold record can outrank fully-unknown groups.
  const rankableCategoryRows = categoryRows.filter(
    (x) => x.averageRealizedProfit != null
  );
  const rankablePlatformRows = platformRows.filter(
    (x) => x.averageRealizedProfit != null && x.platform !== "unknown"
  );

  const bestCategories = [...rankableCategoryRows]
    .sort((a, b) => b.averageRealizedProfit - a.averageRealizedProfit)
    .slice(0, 5);

  const worstCategories = [...rankableCategoryRows]
    .sort((a, b) => a.averageRealizedProfit - b.averageRealizedProfit)
    .slice(0, 5);

  const highestErrorCategories = [...categoryRows]
    .filter((x) => x.averagePercentPriceError != null)
    .sort((a, b) => b.averagePercentPriceError - a.averagePercentPriceError)
    .slice(0, 5);

  const bestPlatforms = [...rankablePlatformRows]
    .sort((a, b) => b.averageRealizedProfit - a.averageRealizedProfit)
    .slice(0, 5);

  const mostReliableVerdicts = [...verdictRows]
    .filter((x) => x.directionAccuracy != null)
    .sort((a, b) => b.directionAccuracy - a.directionAccuracy)
    .slice(0, 5);

  const strongestSourceDepthPattern =
    [...sourceDepthRows].sort((a, b) => b.directionAccuracy - a.directionAccuracy)[0] ||
    null;

  const weakestSourceDepthPattern =
    [...sourceDepthRows].sort((a, b) => a.directionAccuracy - b.directionAccuracy)[0] ||
    null;

  return {
    bestCategories,
    worstCategories,
    bestPlatforms,
    mostReliableVerdicts,
    highestErrorCategories,
    strongestSourceDepthPattern,
    weakestSourceDepthPattern,
  };
}

function buildDataQuality({
  outcomes,
  records,
  missingPredictionCount,
  calibrationReport,
  marketAccuracyReport,
}) {
  return {
    missingPredictionCount,
    missingOutcomeCount: 0,
    soldRecordCount: records.filter((r) => r.sold === true).length,
    unsoldRecordCount: records.filter((r) => r.sold !== true).length,
    recordsWithProfit: records.filter((r) => r.realizedProfit != null).length,
    recordsWithPriceAccuracy: records.filter((r) => r.percentPriceError != null).length,
    recordsWithCalibration: calibrationReport ? records.length : 0,
    recordsWithMarketAccuracy: marketAccuracyReport ? records.length : 0,
    rawOutcomeCount: outcomes.length,
  };
}

function emptyDataset(userId = null) {
  return {
    userId: userId || null,
    generatedAt: nowIso(),
    schemaVersion: 1,
    totalOutcomes: 0,
    totalPredictionsJoined: 0,
    usableRecords: 0,
    records: [],
    aggregates: {
      byCategory: {},
      byVerdict: {},
      byPlatform: {},
      byMarketConfidence: {},
      bySourceDepth: {},
      byConfidenceBucket: {},
    },
    insights: {
      bestCategories: [],
      worstCategories: [],
      bestPlatforms: [],
      mostReliableVerdicts: [],
      highestErrorCategories: [],
      strongestSourceDepthPattern: null,
      weakestSourceDepthPattern: null,
    },
    dataQuality: {
      missingPredictionCount: 0,
      missingOutcomeCount: 0,
      soldRecordCount: 0,
      unsoldRecordCount: 0,
      recordsWithProfit: 0,
      recordsWithPriceAccuracy: 0,
      recordsWithCalibration: 0,
      recordsWithMarketAccuracy: 0,
      rawOutcomeCount: 0,
    },
  };
}

export async function buildResaleIntelligenceDataset(userId = null) {
  const outcomes = await listOutcomesForUser(userId, 10000).catch(() => []);
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    return emptyDataset(userId);
  }

  const calibrationReport = await loadLatestCalibrationReport().catch(() => null);
  const marketAccuracyReport = await loadLatestMarketPredictionAccuracyReport().catch(
    () => null
  );

  const records = [];
  let missingPredictionCount = 0;

  for (const outcome of outcomes) {
    const scanId = outcome?.scanId;
    if (!scanId) continue;
    const prediction = await getPredictionSnapshot(scanId).catch(() => null);
    if (!prediction) {
      missingPredictionCount++;
      continue;
    }
    records.push(buildRecord({ outcome, prediction, calibrationReport }));
  }

  const groups = {
    byCategory: {},
    byVerdict: {},
    byPlatform: {},
    byMarketConfidence: {},
    bySourceDepth: {},
    byConfidenceBucket: {},
  };

  for (const r of records) {
    pushGroup(groups.byCategory, safeLower(r.category), r);
    pushGroup(groups.byVerdict, String(r.verdict || "unknown").toUpperCase(), r);
    pushGroup(groups.byPlatform, safeLower(r.salePlatform || "unknown"), r);
    pushGroup(groups.byMarketConfidence, safeLower(r.marketConfidence || "unknown"), r);
    pushGroup(groups.bySourceDepth, r.sourceDepthBucket || "unknown", r);
    pushGroup(groups.byConfidenceBucket, r.confidenceBucket || "unknown", r);
  }

  const aggregates = {
    byCategory: summarizeGroupMap(groups.byCategory),
    byVerdict: summarizeGroupMap(groups.byVerdict),
    byPlatform: summarizeGroupMap(groups.byPlatform),
    byMarketConfidence: summarizeGroupMap(groups.byMarketConfidence),
    bySourceDepth: summarizeGroupMap(groups.bySourceDepth),
    byConfidenceBucket: summarizeGroupMap(groups.byConfidenceBucket),
  };

  return {
    userId: userId || null,
    generatedAt: nowIso(),
    schemaVersion: 1,
    totalOutcomes: outcomes.length,
    totalPredictionsJoined: records.length,
    usableRecords: records.length,
    records,
    aggregates,
    insights: buildInsights(aggregates),
    dataQuality: buildDataQuality({
      outcomes,
      records,
      missingPredictionCount,
      calibrationReport,
      marketAccuracyReport,
    }),
  };
}

async function ensureDatasetDir() {
  await fs.mkdir(DATASET_DIR, { recursive: true });
}

async function atomicWriteJson(file, data) {
  await ensureDatasetDir();
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function saveResaleIntelligenceDataset(dataset) {
  await atomicWriteJson(DATASET_LATEST, dataset);
  await atomicWriteJson(DATASET_RECORDS, dataset?.records || []);
  return dataset;
}

export async function loadLatestResaleIntelligenceDataset() {
  try {
    const raw = await fs.readFile(DATASET_LATEST, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
