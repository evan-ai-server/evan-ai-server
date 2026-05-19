// src/scanHarness.js
// Scan harness — append-only JSONL ledger of real-world scans + ground-truth outcomes.
// Used to evaluate whether Evan's verdicts hold up against reality before building
// further trust/calibration phases. Writes are async and never throw.

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const HARNESS_DIR    = path.resolve("storage/scan-harness");
const SCANS_FILE     = path.join(HARNESS_DIR, "scans.jsonl");
const OUTCOMES_FILE  = path.join(HARNESS_DIR, "outcomes.jsonl");

let dirReady = null;
async function ensureDir() {
  if (!dirReady) dirReady = fs.mkdir(HARNESS_DIR, { recursive: true }).catch(() => {});
  return dirReady;
}

function pickRequestSnapshot(req) {
  const b = req?.body || {};
  return {
    imageKey:        b.imageKey || b.objectKey || b.scanAsset?.processedKey || b.scanAsset?.originalKey || null,
    scanPriceInput:  b.scanPriceInput ?? b.askingPrice ?? null,
    cheapestAltInput: b.cheapestAltInput ?? null,
    note:            typeof b.note === "string" ? b.note.slice(0, 500) : null,
    userAgent:       req?.headers?.["user-agent"] || null,
    ip:              req?.ip || null,
  };
}

function summarizeShaped(shaped) {
  if (!shaped || typeof shaped !== "object") return {};
  const id = shaped.identity || shaped.visionIdentity || {};
  const bop = shaped.buyOrPass || {};
  const legacy = shaped.legacy || {};
  return {
    scanId:        shaped.scanId || null,
    verdict:       bop.verdict || shaped.verdict || shaped.recommendation || shaped.decision || null,
    confidence:    typeof bop.confidence === "number" ? bop.confidence
                  : typeof shaped.confidence === "number" ? shaped.confidence
                  : (shaped.confidence?.overall ?? null),
    reasonCode:    bop.reasonCode || null,
    title:         shaped.itemName || id.title || id.name || id.brand || null,
    category:      shaped.category || id.category || null,
    askingPrice:   shaped.originalPrice ?? shaped.askingPrice ?? shaped.scannedPrice ?? null,
    estResale:     shaped.profitIntel?.marketPriceMedian ?? shaped.estimatedResale ?? shaped.predictedResale ?? null,
    itemCount:     Array.isArray(shaped.items) ? shaped.items.length : null,
    legacy: {
      profitIntelBuySignal: legacy.profitIntelBuySignal ?? null,
      dealQualityVerdict:   legacy.dealQualityVerdict   ?? null,
      dealEngineVerdict:    legacy.dealEngineVerdict    ?? null,
      swarmBuySignal:       legacy.swarmBuySignal       ?? null,
      smartAlertType:       legacy.smartAlertType       ?? null,
    },
    summary:       typeof shaped.summary === "string" ? shaped.summary.slice(0, 400) : null,
  };
}

export async function recordScan(req, shaped) {
  try {
    await ensureDir();
    const scanId = shaped?.scanId || crypto.randomUUID();
    const entry = {
      scanId,
      ts:       new Date().toISOString(),
      route:    req?.originalUrl || null,
      request:  pickRequestSnapshot(req),
      summary:  summarizeShaped(shaped),
      shaped,
    };
    await fs.appendFile(SCANS_FILE, JSON.stringify(entry) + "\n", "utf8");
    return scanId;
  } catch {
    return null;
  }
}

// Record a verdict-bearing payload directly from the build function, when the
// route-level hook would miss it (e.g. final stream payload threw and was
// replaced by an empty catch-fallback). Source labels which call site fired.
export async function recordVerdictPayload(source, payload) {
  try {
    await ensureDir();
    const scanId = payload?.scanId || crypto.randomUUID();
    const entry = {
      scanId,
      ts:       new Date().toISOString(),
      route:    `fn:${source}`,
      request:  null,
      summary:  summarizeShaped(payload),
      shaped:   payload,
    };
    await fs.appendFile(SCANS_FILE, JSON.stringify(entry) + "\n", "utf8");
    return scanId;
  } catch {
    return null;
  }
}

export async function recordOutcome(outcome) {
  try {
    await ensureDir();
    const entry = { ts: new Date().toISOString(), ...outcome };
    await fs.appendFile(OUTCOMES_FILE, JSON.stringify(entry) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export async function readScans()    { return readJsonl(SCANS_FILE); }
export async function readOutcomes() { return readJsonl(OUTCOMES_FILE); }

export const HARNESS_PATHS = { HARNESS_DIR, SCANS_FILE, OUTCOMES_FILE };
