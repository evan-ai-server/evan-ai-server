// src/outcomeStore.js
// Lightweight JSON file store for scan prediction snapshots and realized outcomes.
// Prediction snapshots are immutable once written (same scanId returns existing).
// Outcome records are mutable and can be updated incrementally over time.
//
// Storage layout:
//   storage/outcomes/predictions/<scanId>.json  — immutable scan snapshot
//   storage/outcomes/realized/<scanId>.json     — mutable outcome record

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(_dir, "..", "storage", "outcomes");
const PREDICTIONS_DIR = path.join(ROOT, "predictions");
const OUTCOMES_DIR = path.join(ROOT, "realized");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function safeId(id = "") {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  // Backward-compatible: any id that already fits returns unchanged so
  // existing files on disk keep resolving to the same path.
  if (cleaned.length <= 120) return cleaned;
  // For long ids, keep a recognizable prefix + short hash of the full
  // cleaned id so two long ids sharing the first 120 chars don't collide
  // and silently overwrite each other's snapshot or outcome file.
  const hash = crypto.createHash("sha1").update(cleaned).digest("hex").slice(0, 12);
  return `${cleaned.slice(0, 100)}.${hash}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

function predictionPath(scanId) {
  return path.join(PREDICTIONS_DIR, `${safeId(scanId)}.json`);
}

function outcomePath(scanId) {
  return path.join(OUTCOMES_DIR, `${safeId(scanId)}.json`);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Merge numeric field while treating "" / undefined as "no change."
// Plain null in the new payload still preserves existing — only an
// explicit finite number overwrites. This stops form-field clears
// (which submit empty strings) from erasing previously captured prices.
function pickNumeric(newVal, oldVal) {
  if (newVal === undefined || newVal === null || newVal === "") {
    return numOrNull(oldVal);
  }
  return numOrNull(newVal);
}

function computeRealized(outcome = {}) {
  // Only compute after a confirmed sale with a positive sell price.
  // Bought-only records must stay null — sell=0 or missing sold flag
  // would otherwise produce a misleadingly negative "realized" value.
  if (outcome.sold !== true) return { realizedProfit: null, realizedMarginPct: null };
  const buy = numOrNull(outcome.actualBuyPrice);
  const sell = numOrNull(outcome.actualSellPrice);
  if (sell == null || sell <= 0) return { realizedProfit: null, realizedMarginPct: null };
  const fees = numOrNull(outcome.actualFees) || 0;
  const shipping = numOrNull(outcome.shippingCost) || 0;
  const realizedProfit =
    buy != null
      ? Number((sell - buy - fees - shipping).toFixed(2))
      : null;
  const realizedMarginPct =
    realizedProfit != null
      ? Number((realizedProfit / sell).toFixed(4))
      : null;
  return { realizedProfit, realizedMarginPct };
}

function computePredictionError(prediction = {}, outcome = {}) {
  const predictedResale = numOrNull(prediction.predictedResalePrice);
  const predictedProfit = numOrNull(prediction.predictedProfit);
  const actualSell = numOrNull(outcome.actualSellPrice);
  const realizedProfit = numOrNull(outcome.realizedProfit);

  const resalePriceError =
    predictedResale != null && actualSell != null
      ? Number((predictedResale - actualSell).toFixed(2))
      : null;
  const profitError =
    predictedProfit != null && realizedProfit != null
      ? Number((predictedProfit - realizedProfit).toFixed(2))
      : null;
  const profitErrorPct =
    profitError != null &&
    realizedProfit != null &&
    Math.abs(realizedProfit) > 0.01
      ? Number((profitError / realizedProfit).toFixed(4))
      : null;

  // Direction correctness only applies when the verdict made an explicit
  // directional bet. BUY-leaning predicts profitable; PASS-leaning predicts
  // not profitable. HOLD (and any unknown verdict) is an explicit
  // "uncertain / no call" — counting it as either direction would inflate
  // or deflate accuracy depending on how the item happened to play out.
  const verdictUpper = String(prediction.verdict || "").toUpperCase();
  const isPositive =
    verdictUpper === "BUY" ||
    verdictUpper.includes("GOOD") ||
    verdictUpper.includes("FLIP");
  const isNegative =
    verdictUpper === "PASS" ||
    verdictUpper.includes("AVOID") ||
    verdictUpper.includes("BAD");
  const actuallyProfitable =
    realizedProfit != null ? realizedProfit > 0 : null;
  let directionCorrect = null;
  if (actuallyProfitable != null) {
    if (isPositive) directionCorrect = actuallyProfitable === true;
    else if (isNegative) directionCorrect = actuallyProfitable === false;
  }

  return {
    resalePriceError,
    profitError,
    profitErrorPct,
    directionCorrect,
    verdictCorrect: directionCorrect,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function recordPredictionSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const scanId = snapshot.scanId;
  if (!scanId) return null;

  const file = predictionPath(scanId);
  const existing = await readJson(file, null);
  if (existing) return existing; // immutable — never overwrite

  // Phase 4D: sanitize trust block — only known scalar fields survive
  const _rawTrust = snapshot.trust && typeof snapshot.trust === "object" ? snapshot.trust : null;
  const trust = _rawTrust ? {
    canonicalVerdict:             typeof _rawTrust.canonicalVerdict === "string"     ? _rawTrust.canonicalVerdict.slice(0, 40) : null,
    evidenceTier:                 typeof _rawTrust.evidenceTier     === "string"     ? _rawTrust.evidenceTier.slice(0, 60)     : null,
    verdictStrengthCap:           typeof _rawTrust.verdictStrengthCap === "string"   ? _rawTrust.verdictStrengthCap.slice(0, 60) : null,
    calibratedConfidence:         numOrNull(_rawTrust.calibratedConfidence),
    marketConfidence:             numOrNull(_rawTrust.marketConfidence) ?? (typeof _rawTrust.marketConfidence === "string" ? _rawTrust.marketConfidence.slice(0, 20) : null),
    evidenceConfidence:           numOrNull(_rawTrust.evidenceConfidence),
    verifiedListingCount:         Number.isFinite(Number(_rawTrust.verifiedListingCount)) ? Number(_rawTrust.verifiedListingCount) : 0,
    pricingSignalCount:           Number.isFinite(Number(_rawTrust.pricingSignalCount))   ? Number(_rawTrust.pricingSignalCount)   : 0,
    cleanCompCount:               numOrNull(_rawTrust.cleanCompCount),
    consensusMedian:              numOrNull(_rawTrust.consensusMedian),
    canShowStrongLanguage:        _rawTrust.canShowStrongLanguage        ?? null,
    canShowVerifiedLanguage:      _rawTrust.canShowVerifiedLanguage      ?? null,
    canShowMedianAsAuthoritative: _rawTrust.canShowMedianAsAuthoritative ?? null,
  } : null;

  const clean = {
    scanId,
    userId: snapshot.userId || null,
    deviceId: snapshot.deviceId || null,
    guestId: snapshot.guestId || null,
    createdAt: snapshot.createdAt || nowIso(),
    query: snapshot.query || null,
    category: snapshot.category || null,
    itemName: snapshot.itemName || null,
    scannedPrice: numOrNull(snapshot.scannedPrice),
    verdict: snapshot.verdict || null,
    confidence: numOrNull(snapshot.confidence),
    reasonCode: snapshot.reasonCode || null,
    predictedBrand: typeof snapshot.predictedBrand === "string" ? snapshot.predictedBrand.slice(0, 120) : null,
    predictedModel: typeof snapshot.predictedModel === "string" ? snapshot.predictedModel.slice(0, 120) : null,
    predictedResalePrice: numOrNull(snapshot.predictedResalePrice),
    predictedProfit: numOrNull(snapshot.predictedProfit),
    predictedMarginPct: numOrNull(snapshot.predictedMarginPct),
    predictedRoiPct: numOrNull(snapshot.predictedRoiPct),
    suggestedOffer: numOrNull(snapshot.suggestedOffer),
    estimatedFees: numOrNull(snapshot.estimatedFees),
    listingCount: numOrNull(snapshot.listingCount),
    relevantListingCount: numOrNull(snapshot.relevantListingCount),
    sourceGroups: numOrNull(snapshot.sourceGroups),
    marketConfidence: snapshot.marketConfidence || null,
    marketEvidenceReason: snapshot.marketEvidenceReason || null,
    trust,
    topListings: Array.isArray(snapshot.topListings)
      ? snapshot.topListings.slice(0, 8).map((x) => ({
          title: x?.title || x?.itemName || null,
          source: x?.source || x?.store || null,
          price: numOrNull(x?.price),
          totalPrice: numOrNull(x?.totalPrice),
          directUrl: x?.directUrl || x?.link || x?.url || null,
        }))
      : [],
    rawLiteMeta: snapshot.rawLiteMeta || {},
  };

  await writeJsonAtomic(file, clean);
  return clean;
}

export async function getPredictionSnapshot(scanId) {
  if (!scanId) return null;
  return readJson(predictionPath(scanId), null);
}

export async function recordOutcome(scanId, outcome = {}) {
  if (!scanId) return null;

  const prediction = await getPredictionSnapshot(scanId);
  const existing = await readJson(outcomePath(scanId), { scanId });

  const merged = {
    ...existing,
    ...outcome,
    scanId,
    userId:
      outcome.userId || existing.userId || prediction?.userId || null,
    deviceId:
      outcome.deviceId || existing.deviceId || prediction?.deviceId || null,
    guestId:
      outcome.guestId || existing.guestId || prediction?.guestId || null,
    updatedAt: nowIso(),
    bought:
      typeof outcome.bought === "boolean"
        ? outcome.bought
        : existing.bought ?? null,
    listed:
      typeof outcome.listed === "boolean"
        ? outcome.listed
        : existing.listed ?? null,
    sold:
      typeof outcome.sold === "boolean"
        ? outcome.sold
        : existing.sold ?? null,
    actualBuyPrice: pickNumeric(outcome.actualBuyPrice, existing.actualBuyPrice),
    actualSellPrice: pickNumeric(outcome.actualSellPrice, existing.actualSellPrice),
    actualFees: pickNumeric(outcome.actualFees, existing.actualFees),
    shippingCost: pickNumeric(outcome.shippingCost, existing.shippingCost),
    daysToSell: pickNumeric(outcome.daysToSell, existing.daysToSell),
    listingPrice: pickNumeric(outcome.listingPrice, existing.listingPrice),
    listedAt: outcome.listedAt || existing.listedAt || null,
    soldAt: outcome.soldAt || existing.soldAt || null,
    salePlatform: outcome.salePlatform || existing.salePlatform || null,
    userNotes: outcome.userNotes || existing.userNotes || null,
  };

  const realized = computeRealized(merged);
  merged.realizedProfit = realized.realizedProfit;
  merged.realizedMarginPct = realized.realizedMarginPct;
  merged.predictionError = computePredictionError(prediction || {}, merged);

  await writeJsonAtomic(outcomePath(scanId), merged);
  return merged;
}

export async function getOutcome(scanId) {
  if (!scanId) return null;
  return readJson(outcomePath(scanId), null);
}

export async function getOutcomeWithPrediction(scanId) {
  const [prediction, outcome] = await Promise.all([
    getPredictionSnapshot(scanId),
    getOutcome(scanId),
  ]);
  return { scanId, prediction, outcome };
}

export async function listOutcomesForUser(userId, limit = 100) {
  await ensureDir(OUTCOMES_DIR);
  const files = await fs.readdir(OUTCOMES_DIR).catch(() => []);
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const row = await readJson(path.join(OUTCOMES_DIR, f), null);
    if (!row) continue;
    if (userId && row.userId !== userId) continue;
    out.push(row);
  }
  out.sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  );
  return out.slice(0, limit);
}

export async function computeOutcomeMetrics(userId) {
  const outcomes = await listOutcomesForUser(userId, 1000);
  let soldCount = 0;
  let profitableCount = 0;
  let totalProfit = 0;
  let profitErrorAbsSum = 0;
  let profitErrorCount = 0;
  let directionCorrectCount = 0;
  let directionKnownCount = 0;
  let daysToSellSum = 0;
  let daysToSellCount = 0;

  for (const o of outcomes) {
    // Use numOrNull, not Number.isFinite(Number(v)), because Number(null) === 0
    // is finite — that would inflate counts and treat null profit as zero.
    const realized = numOrNull(o.realizedProfit);
    if (o.sold === true) {
      soldCount++;
      if (realized != null && realized > 0) profitableCount++;
      const explicit = numOrNull(o.daysToSell);
      if (explicit != null) {
        daysToSellSum += explicit;
        daysToSellCount++;
      } else if (o.listedAt && o.soldAt) {
        const listedMs = new Date(o.listedAt).getTime();
        const soldMs   = new Date(o.soldAt).getTime();
        if (Number.isFinite(listedMs) && Number.isFinite(soldMs) && soldMs >= listedMs) {
          daysToSellSum += (soldMs - listedMs) / 86_400_000;
          daysToSellCount++;
        }
      }
    }
    if (realized != null) {
      totalProfit += realized;
    }
    const pe = o.predictionError || {};
    const profitErr = numOrNull(pe.profitError);
    if (profitErr != null) {
      profitErrorAbsSum += Math.abs(profitErr);
      profitErrorCount++;
    }
    if (typeof pe.directionCorrect === "boolean") {
      directionKnownCount++;
      if (pe.directionCorrect) directionCorrectCount++;
    }
  }

  return {
    userId: userId || null,
    totalOutcomes: outcomes.length,
    outcomeCount:  outcomes.length,
    soldCount,
    profitableCount,
    totalProfit: Number(totalProfit.toFixed(2)),
    totalRealizedProfit: Number(totalProfit.toFixed(2)),
    averageProfit:
      soldCount > 0 ? Number((totalProfit / soldCount).toFixed(2)) : null,
    averageRealizedProfit:
      soldCount > 0 ? Number((totalProfit / soldCount).toFixed(2)) : null,
    winRate:
      soldCount > 0 ? Number((profitableCount / soldCount).toFixed(4)) : null,
    meanAbsoluteProfitError:
      profitErrorCount > 0
        ? Number((profitErrorAbsSum / profitErrorCount).toFixed(2))
        : null,
    averagePredictionError:
      profitErrorCount > 0
        ? Number((profitErrorAbsSum / profitErrorCount).toFixed(2))
        : null,
    directionAccuracy:
      directionKnownCount > 0
        ? Number((directionCorrectCount / directionKnownCount).toFixed(4))
        : null,
    averageDaysToSell:
      daysToSellCount > 0
        ? Number((daysToSellSum / daysToSellCount).toFixed(1))
        : null,
  };
}

// Phase 4D: aggregate breakdowns by category, evidenceTier, and verdict.
// Joins realized outcomes with their prediction snapshots so trust-tier
// accuracy can be computed. Never throws.
export async function computeOutcomeStatsBreakdown(userId = null) {
  const outcomes = await listOutcomesForUser(userId, 1000).catch(() => []);

  // bucket shape: { count, soldCount, profitSum, profitErrAbsSum, profitErrCount, dirCorrect, dirKnown }
  function emptyBucket() {
    return { count: 0, soldCount: 0, profitSum: 0, profitErrAbsSum: 0, profitErrCount: 0, dirCorrect: 0, dirKnown: 0 };
  }
  function addToBucket(b, outcome) {
    b.count++;
    const realized = numOrNull(outcome.realizedProfit);
    if (outcome.sold === true) {
      b.soldCount++;
      if (realized != null) b.profitSum += realized;
    }
    const pe = outcome.predictionError || {};
    const profitErr = numOrNull(pe.profitError);
    if (profitErr != null) { b.profitErrAbsSum += Math.abs(profitErr); b.profitErrCount++; }
    if (typeof pe.directionCorrect === "boolean") { b.dirKnown++; if (pe.directionCorrect) b.dirCorrect++; }
  }
  function serializeBucket(b) {
    return {
      count: b.count,
      soldCount: b.soldCount,
      avgRealizedProfit: b.soldCount > 0 ? Number((b.profitSum / b.soldCount).toFixed(2)) : null,
      avgProfitError: b.profitErrCount > 0 ? Number((b.profitErrAbsSum / b.profitErrCount).toFixed(2)) : null,
      directionCorrectCount: b.dirCorrect,
      directionKnownCount: b.dirKnown,
      directionAccuracy: b.dirKnown > 0 ? Number((b.dirCorrect / b.dirKnown).toFixed(4)) : null,
    };
  }

  const byCategory    = {};
  const byEvidenceTier = {};
  const byVerdict     = {};

  for (const o of outcomes) {
    // Resolved prediction for trust-tier lookup — join from prediction snapshot
    const prediction = await getPredictionSnapshot(o.scanId).catch(() => null);

    const cat  = prediction?.category || o.category || "unknown";
    const tier = prediction?.trust?.evidenceTier || "unknown";
    const verd = prediction?.verdict || o.predictionError?.verdict || "unknown";

    for (const [map, key] of [[byCategory, cat], [byEvidenceTier, tier], [byVerdict, verd]]) {
      if (!map[key]) map[key] = emptyBucket();
      addToBucket(map[key], o);
    }
  }

  return {
    total: outcomes.length,
    soldCount: outcomes.filter(o => o.sold === true).length,
    byCategory:     Object.fromEntries(Object.entries(byCategory).map(([k, v])    => [k, serializeBucket(v)])),
    byEvidenceTier: Object.fromEntries(Object.entries(byEvidenceTier).map(([k, v]) => [k, serializeBucket(v)])),
    byVerdict:      Object.fromEntries(Object.entries(byVerdict).map(([k, v])      => [k, serializeBucket(v)])),
  };
}
