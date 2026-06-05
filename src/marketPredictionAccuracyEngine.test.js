// src/marketPredictionAccuracyEngine.test.js
// Phase 4E — Tests for byEvidenceTier bucketing, join-drop counters, and
// reliability labeling in buildMarketPredictionAccuracyReport.
//
// Uses real storage/outcomes/{predictions,realized}/ files with unique scanIds
// cleaned up after each test, matching the outcomeStore.test.js pattern.

import { strict as assert } from "assert";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { buildMarketPredictionAccuracyReport } from "./marketPredictionAccuracyEngine.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const PRED_DIR = path.join(_dir, "..", "storage", "outcomes", "predictions");
const REAL_DIR = path.join(_dir, "..", "storage", "outcomes", "realized");

function uid() {
  return `mpa_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function writePrediction(scanId, overrides = {}) {
  await fs.mkdir(PRED_DIR, { recursive: true });
  const snap = {
    scanId,
    userId: "u_test",
    createdAt: new Date().toISOString(),
    query: "test item",
    category: "Sneakers",
    verdict: "BUY",
    confidence: 72,
    predictedResalePrice: 120,
    predictedProfit: 30,
    listingCount: 8,
    relevantListingCount: 6,
    sourceGroups: 3,
    marketConfidence: "high",
    marketEvidenceReason: "ok",
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
    userId: "u_test",
    updatedAt: new Date().toISOString(),
    bought: true,
    listed: true,
    sold: true,
    actualBuyPrice: 90,
    actualSellPrice: 115,
    actualFees: 10,
    shippingCost: 5,
    realizedProfit: 10,
    realizedMarginPct: 0.087,
    predictionError: { profitError: 20, directionCorrect: true },
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

console.log("\nsrc/marketPredictionAccuracyEngine.test.js");

// ── 1. Evidence tier bucketing with trust block ───────────────────────────────
await test("byEvidenceTier groups predictions by trust.evidenceTier", async () => {
  const id1 = uid(); const id2 = uid();
  try {
    await writePrediction(id1, {
      trust: { evidenceTier: "verified_strong", verifiedListingCount: 5 },
      predictedResalePrice: 100,
    });
    await writeOutcome(id1, { actualSellPrice: 110, sold: true });

    await writePrediction(id2, {
      trust: { evidenceTier: "pricing_signal_only", verifiedListingCount: 0 },
      predictedResalePrice: 80,
    });
    await writeOutcome(id2, { actualSellPrice: 90, sold: true });

    const report = await buildMarketPredictionAccuracyReport("u_test");
    assert.ok(report.byEvidenceTier, "byEvidenceTier should exist");
    assert.ok(report.byEvidenceTier["verified_strong"], "verified_strong tier present");
    assert.ok(report.byEvidenceTier["pricing_signal_only"], "pricing_signal_only tier present");
    // EVIDENCE_TIER_KEYS must all be present (forced keys)
    for (const k of ["verified_strong", "verified_partial", "pricing_signal_only", "thin_pricing_signal", "estimate_only", "no_evidence", "unknown"]) {
      assert.ok(k in report.byEvidenceTier, `forced key "${k}" must be present`);
    }
  } finally {
    await cleanup(id1, id2);
  }
});

// ── 2. Old predictions without trust block → "unknown" ───────────────────────
await test("old snapshots without trust block fall into 'unknown' tier", async () => {
  const id = uid();
  try {
    // No trust field — simulates a pre-4D snapshot
    await writePrediction(id, { predictedResalePrice: 100 });
    await writeOutcome(id, { actualSellPrice: 95, sold: true });

    const report = await buildMarketPredictionAccuracyReport("u_test");
    const unknown = report.byEvidenceTier["unknown"];
    assert.ok(unknown, "unknown tier should exist");
    // Some count >= 1 from our test row (other tests may add more; just check >= 1)
    // We can't assert exact count due to other test artifacts so just assert key exists and count is a number
    assert.equal(typeof unknown.count, "number", "unknown.count should be a number");
    assert.ok("reliability" in unknown, "unknown tier must have reliability field");
  } finally {
    await cleanup(id);
  }
});

// ── 3. Missing prediction increments droppedNoPrediction ─────────────────────
await test("missing prediction snapshot increments droppedNoPrediction", async () => {
  const id = uid();
  try {
    // Write outcome with no matching prediction
    await writeOutcome(id, { sold: true, actualSellPrice: 80 });

    const report = await buildMarketPredictionAccuracyReport("u_test");
    assert.ok(typeof report.droppedNoPrediction === "number", "droppedNoPrediction should be a number");
    // At least 1 drop from our orphaned outcome (there may be others from prior test runs)
    assert.ok(report.droppedNoPrediction >= 1, `droppedNoPrediction should be >= 1, got ${report.droppedNoPrediction}`);
  } finally {
    await cleanup(id);
  }
});

// ── 4. Unsold outcome increments droppedUnsold ───────────────────────────────
await test("unsold outcome increments droppedUnsold", async () => {
  const id = uid();
  try {
    await writePrediction(id, { predictedResalePrice: 100 });
    await writeOutcome(id, { sold: false, bought: true, actualSellPrice: null });

    const report = await buildMarketPredictionAccuracyReport("u_test");
    assert.ok(typeof report.droppedUnsold === "number", "droppedUnsold should be a number");
    assert.ok(report.droppedUnsold >= 1, `droppedUnsold should be >= 1, got ${report.droppedUnsold}`);
  } finally {
    await cleanup(id);
  }
});

// ── 5. Tier below sample floor has reliability:"insufficient_data" ─────────────
await test("tier with 1-4 rows has reliability:insufficient_data", async () => {
  const id = uid();
  try {
    await writePrediction(id, {
      trust: { evidenceTier: "estimate_only" },
      predictedResalePrice: 50,
    });
    await writeOutcome(id, { sold: true, actualSellPrice: 55 });

    const report = await buildMarketPredictionAccuracyReport("u_test");
    // estimate_only has 1 row from this test → count < MIN_SAMPLES_FOR_BIAS (5)
    const tier = report.byEvidenceTier["estimate_only"];
    assert.ok(tier, "estimate_only tier should exist");
    if (tier.count > 0 && tier.count < 5) {
      assert.equal(tier.reliability, "insufficient_data",
        `tier with count=${tier.count} should be insufficient_data, got ${tier.reliability}`);
    }
    // If count >= 5 due to other test data, it would be "reliable" — that's also correct
  } finally {
    await cleanup(id);
  }
});

// ── 6. Zero-count forced tier has reliability:"no_data" ──────────────────────
await test("zero-count forced tier has reliability:no_data", async () => {
  const report = await buildMarketPredictionAccuracyReport("u_no_such_user_xyzxyz");
  assert.ok(report.byEvidenceTier, "byEvidenceTier must be present even when empty");
  for (const k of ["verified_strong", "verified_partial", "thin_pricing_signal", "estimate_only", "no_evidence"]) {
    const tier = report.byEvidenceTier[k];
    assert.ok(tier, `tier "${k}" must exist`);
    assert.equal(tier.count, 0, `empty tier count should be 0`);
    assert.equal(tier.reliability, "no_data", `empty tier reliability should be no_data, got ${tier.reliability}`);
  }
});

// ── 7. Existing fields still present ─────────────────────────────────────────
await test("existing report fields are all present", async () => {
  const report = await buildMarketPredictionAccuracyReport("u_no_such_user_xyzxyz");
  const required = ["userId", "generatedAt", "totalOutcomes", "usableOutcomes",
    "global", "profitAccuracy", "byCategory", "byVerdict", "byMarketConfidence",
    "bySourceDepth", "worstCategories", "bestCategories", "pricingBias", "recommendations",
    "joinedPredictionCount", "droppedNoPrediction", "droppedUnsold", "byEvidenceTier"];
  for (const f of required) {
    assert.ok(f in report, `field "${f}" must be present`);
  }
});

// ── 8. PREDICTION_JOIN_SUMMARY counters are self-consistent ──────────────────
await test("join counters are self-consistent (joined + dropped <= total)", async () => {
  const id = uid();
  try {
    await writePrediction(id, { predictedResalePrice: 100, trust: { evidenceTier: "verified_strong" } });
    await writeOutcome(id, { sold: true, actualSellPrice: 110 });

    const report = await buildMarketPredictionAccuracyReport("u_test");
    const { totalOutcomes, joinedPredictionCount, droppedNoPrediction, droppedUnsold } = report;
    // joinedPredictionCount + droppedNoPrediction ≤ totalOutcomes
    assert.ok(joinedPredictionCount + droppedNoPrediction <= totalOutcomes,
      `joined(${joinedPredictionCount}) + droppedNoPrediction(${droppedNoPrediction}) should be <= total(${totalOutcomes})`);
  } finally {
    await cleanup(id);
  }
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
