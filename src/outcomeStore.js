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
  return String(id || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
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
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeRealized(outcome = {}) {
  const buy = numOrNull(outcome.actualBuyPrice);
  const sell = numOrNull(outcome.actualSellPrice);
  const fees = numOrNull(outcome.actualFees) || 0;
  const shipping = numOrNull(outcome.shippingCost) || 0;
  const realizedProfit =
    buy != null && sell != null
      ? Number((sell - buy - fees - shipping).toFixed(2))
      : null;
  const realizedMarginPct =
    realizedProfit != null && sell != null && sell > 0
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

  const verdictUpper = String(prediction.verdict || "").toUpperCase();
  const predictedPositive =
    verdictUpper === "BUY" ||
    verdictUpper.includes("GOOD") ||
    verdictUpper.includes("FLIP");
  const actuallyProfitable =
    realizedProfit != null ? realizedProfit > 0 : null;
  const directionCorrect =
    actuallyProfitable == null ? null : predictedPositive === actuallyProfitable;

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
  const scanId = snapshot.scanId;
  if (!scanId) return null;

  const file = predictionPath(scanId);
  const existing = await readJson(file, null);
  if (existing) return existing; // immutable — never overwrite

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
    predictedResalePrice: numOrNull(snapshot.predictedResalePrice),
    predictedProfit: numOrNull(snapshot.predictedProfit),
    predictedMarginPct: numOrNull(snapshot.predictedMarginPct),
    suggestedOffer: numOrNull(snapshot.suggestedOffer),
    estimatedFees: numOrNull(snapshot.estimatedFees),
    listingCount: numOrNull(snapshot.listingCount),
    relevantListingCount: numOrNull(snapshot.relevantListingCount),
    sourceGroups: numOrNull(snapshot.sourceGroups),
    marketConfidence: snapshot.marketConfidence || null,
    marketEvidenceReason: snapshot.marketEvidenceReason || null,
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
    actualBuyPrice: numOrNull(
      outcome.actualBuyPrice ?? existing.actualBuyPrice
    ),
    actualSellPrice: numOrNull(
      outcome.actualSellPrice ?? existing.actualSellPrice
    ),
    actualFees: numOrNull(outcome.actualFees ?? existing.actualFees),
    shippingCost: numOrNull(outcome.shippingCost ?? existing.shippingCost),
    daysToSell: numOrNull(outcome.daysToSell ?? existing.daysToSell),
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

  for (const o of outcomes) {
    if (o.sold === true) soldCount++;
    if (Number.isFinite(Number(o.realizedProfit))) {
      const p = Number(o.realizedProfit);
      totalProfit += p;
      if (p > 0) profitableCount++;
    }
    const pe = o.predictionError || {};
    if (Number.isFinite(Number(pe.profitError))) {
      profitErrorAbsSum += Math.abs(Number(pe.profitError));
      profitErrorCount++;
    }
    if (typeof pe.directionCorrect === "boolean") {
      directionKnownCount++;
      if (pe.directionCorrect) directionCorrectCount++;
    }
  }

  return {
    userId: userId || null,
    outcomeCount: outcomes.length,
    soldCount,
    profitableCount,
    totalProfit: Number(totalProfit.toFixed(2)),
    averageProfit:
      soldCount > 0 ? Number((totalProfit / soldCount).toFixed(2)) : null,
    meanAbsoluteProfitError:
      profitErrorCount > 0
        ? Number((profitErrorAbsSum / profitErrorCount).toFixed(2))
        : null,
    directionAccuracy:
      directionKnownCount > 0
        ? Number((directionCorrectCount / directionKnownCount).toFixed(4))
        : null,
  };
}
