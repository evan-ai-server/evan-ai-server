// src/confidenceCalibrationEngine.test.js
// Phase 4E — Tests for byEvidenceTier bucketing, join-drop counters, and
// reliability labeling in buildConfidenceCalibrationReport.

import { strict as assert } from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { buildConfidenceCalibrationReport } from "./confidenceCalibrationEngine.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const PRED_DIR = path.join(_dir, "..", "storage", "outcomes", "predictions");
const REAL_DIR = path.join(_dir, "..", "storage", "outcomes", "realized");

function uid() {
  return `cal_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function writePrediction(scanId, overrides = {}) {
  await fs.mkdir(PRED_DIR, { recursive: true });
  const snap = {
    scanId,
    userId: "u_caltest",
    createdAt: new Date().toISOString(),
    query: "test calibration item",
    category: "Sneakers",
    verdict: "BUY",
    confidence: 65,
    predictedResalePrice: 120,
    predictedProfit: 25,
    listingCount: 6,
    relevantListingCount: 4,
    sourceGroups: 2,
    marketConfidence: "medium",
    rawLiteMeta: {},
    topListings: [],
    ...overrides,
  };
  await fs.writeFile(path.join(PRED_DIR, `${scanId}.json`), JSON.stringify(snap, null, 2));
  return snap;
}

async function writeOutcome(scanId, overrides = {}) {
  await fs.mkdir(REAL_DIR, { recursive: true });
  const o = {
    scanId,
    userId: "u_caltest",
    updatedAt: new Date().toISOString(),
    bought: true,
    listed: true,
    sold: true,
    actualBuyPrice: 85,
    actualSellPrice: 110,
    actualFees: 8,
    shippingCost: 5,
    realizedProfit: 12,
    predictionError: { profitError: 13, directionCorrect: true },
    ...overrides,
  };
  await fs.writeFile(path.join(REAL_DIR, `${scanId}.json`), JSON.stringify(o, null, 2));
  return o;
}

async function cleanup(...scanIds) {
  for (const id of scanIds) {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    await fs.unlink(path.join(PRED_DIR, `${safe}.json`)).catch(() => {});
    await fs.unlink(path.join(REAL_DIR, `${safe}.json`)).catch(() => {});
  }
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

console.log("\nsrc/confidenceCalibrationEngine.test.js");

// ── 1. byEvidenceTier exists with forced keys ─────────────────────────────────
await test("byEvidenceTier is present with all forced tier keys", async () => {
  const report = await buildConfidenceCalibrationReport("u_no_such_user_calxyz");
  assert.ok(report.byEvidenceTier, "byEvidenceTier must be present");
  for (const k of ["verified_strong", "verified_partial", "pricing_signal_only",
    "thin_pricing_signal", "estimate_only", "no_evidence", "unknown"]) {
    assert.ok(k in report.byEvidenceTier, `forced key "${k}" must be in byEvidenceTier`);
  }
});

// ── 2. Old snapshot without trust → "unknown" tier ───────────────────────────
await test("old prediction without trust block buckets into 'unknown'", async () => {
  const id = uid();
  try {
    // No trust field
    await writePrediction(id);
    await writeOutcome(id, { realizedProfit: 15, predictionError: { profitError: 10, directionCorrect: true } });

    const report = await buildConfidenceCalibrationReport("u_caltest");
    const unknown = report.byEvidenceTier["unknown"];
    assert.ok(unknown, "unknown tier should exist");
    assert.equal(typeof unknown.count, "number", "unknown.count should be a number");
    assert.ok("reliability" in unknown, "unknown tier must have reliability");
    // count >= 1 from our test row
    assert.ok(unknown.count >= 1, `unknown.count should be >= 1, got ${unknown.count}`);
  } finally {
    await cleanup(id);
  }
});

// ── 3. Prediction with trust block goes into correct tier ─────────────────────
await test("prediction with trust.evidenceTier goes into correct bucket", async () => {
  const id = uid();
  try {
    await writePrediction(id, {
      trust: { evidenceTier: "verified_strong", verifiedListingCount: 5 },
    });
    await writeOutcome(id, {
      realizedProfit: 20,
      predictionError: { profitError: 5, directionCorrect: true },
    });

    const report = await buildConfidenceCalibrationReport("u_caltest");
    const tier = report.byEvidenceTier["verified_strong"];
    assert.ok(tier, "verified_strong tier should exist");
    assert.ok(tier.count >= 1, `verified_strong count should be >= 1, got ${tier.count}`);
    assert.ok("reliability" in tier, "verified_strong must have reliability field");
  } finally {
    await cleanup(id);
  }
});

// ── 4. Missing prediction increments droppedNoPrediction ─────────────────────
await test("outcome without prediction increments droppedNoPrediction", async () => {
  const id = uid();
  try {
    await writeOutcome(id, { realizedProfit: 10, predictionError: { profitError: 5, directionCorrect: true } });

    const report = await buildConfidenceCalibrationReport("u_caltest");
    assert.ok(typeof report.droppedNoPrediction === "number", "droppedNoPrediction should be a number");
    assert.ok(report.droppedNoPrediction >= 1, `droppedNoPrediction should be >= 1, got ${report.droppedNoPrediction}`);
  } finally {
    await cleanup(id);
  }
});

// ── 5. Outcome with neither realizedProfit nor predictionError is droppedInsufficient ─
await test("outcome with no signal increments droppedInsufficient", async () => {
  const id = uid();
  try {
    await writePrediction(id);
    // outcome with no realizedProfit and no predictionError
    await writeOutcome(id, {
      bought: true, sold: false,
      realizedProfit: null,
      predictionError: null,
    });

    const report = await buildConfidenceCalibrationReport("u_caltest");
    assert.ok(typeof report.droppedInsufficient === "number", "droppedInsufficient should be a number");
    assert.ok(report.droppedInsufficient >= 1, `droppedInsufficient should be >= 1, got ${report.droppedInsufficient}`);
  } finally {
    await cleanup(id);
  }
});

// ── 6. Tier with < MIN_COUNT_FOR_ADJUSTMENT rows → reliability:insufficient_data
await test("tier with count < 10 has reliability:insufficient_data", async () => {
  const id = uid();
  try {
    // Use a rare tier that's unlikely to have 10 rows
    await writePrediction(id, {
      trust: { evidenceTier: "thin_pricing_signal" },
    });
    await writeOutcome(id, {
      realizedProfit: 8,
      predictionError: { profitError: 4, directionCorrect: true },
    });

    const report = await buildConfidenceCalibrationReport("u_caltest");
    const tier = report.byEvidenceTier["thin_pricing_signal"];
    assert.ok(tier, "thin_pricing_signal tier should exist");
    if (tier.count > 0 && tier.count < 10) {
      assert.equal(tier.reliability, "insufficient_data",
        `tier with ${tier.count} rows should be insufficient_data, got ${tier.reliability}`);
    }
  } finally {
    await cleanup(id);
  }
});

// ── 7. Empty tier has count:0 and reliability:no_data ────────────────────────
await test("zero-count forced tier has count:0 and reliability:no_data", async () => {
  const report = await buildConfidenceCalibrationReport("u_no_such_user_calxyz");
  // For a user with no data, all forced tiers should be no_data
  for (const k of ["verified_strong", "verified_partial", "estimate_only", "no_evidence"]) {
    const tier = report.byEvidenceTier[k];
    assert.ok(tier, `tier "${k}" must exist`);
    assert.equal(tier.count, 0, `empty tier count should be 0, got ${tier.count}`);
    assert.equal(tier.reliability, "no_data", `empty tier should have no_data reliability`);
  }
});

// ── 8. All existing report fields are still present ──────────────────────────
await test("all existing calibration report fields are preserved", async () => {
  const report = await buildConfidenceCalibrationReport("u_no_such_user_calxyz");
  const required = ["userId", "generatedAt", "totalOutcomes", "usableOutcomes",
    "buckets", "byVerdict", "byCategory", "global",
    "overallDirectionAccuracy", "averagePredictionError",
    "overconfidentBucketCount", "underconfidentBucketCount",
    "bestCalibratedBucket", "worstCalibratedBucket", "calibrationScore",
    "joinedPredictionCount", "droppedNoPrediction", "droppedInsufficient", "byEvidenceTier"];
  for (const f of required) {
    assert.ok(f in report, `field "${f}" must be present`);
  }
});

// ── 9. Join counters self-consistent ─────────────────────────────────────────
await test("join counters: joinedPredictionCount + droppedNoPrediction <= totalOutcomes", async () => {
  const id = uid();
  try {
    await writePrediction(id, { trust: { evidenceTier: "verified_partial" } });
    await writeOutcome(id, { realizedProfit: 12, predictionError: { directionCorrect: true } });

    const report = await buildConfidenceCalibrationReport("u_caltest");
    const { totalOutcomes, joinedPredictionCount, droppedNoPrediction } = report;
    assert.ok(joinedPredictionCount + droppedNoPrediction <= totalOutcomes,
      `joined(${joinedPredictionCount}) + dropped(${droppedNoPrediction}) should be <= total(${totalOutcomes})`);
  } finally {
    await cleanup(id);
  }
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
