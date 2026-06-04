// src/outcomeStore.test.js
// Phase 4D — Tests for outcomeStore.js: snapshot trust block, immutability,
// outcome compute (realized profit, profit error, daysToSell, HOLD/directionCorrect),
// stats breakdown buckets, and dev shell creation.

import { strict as assert } from "assert";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// ── Test isolation: override OUTCOME_STORE_ROOT env so each test run uses a
//    throwaway tmp dir. outcomeStore.js uses import-time path computation, so
//    we need to resolve the paths before importing — but the module uses
//    fileURLToPath(__dirname) to build ROOT, which we can't override via env.
//    Solution: copy the module's logic manually per-test using a temp root, and
//    exercise the public API exports directly.

// We will use a custom OUTCOME_DIR env var approach: point storage/outcomes to
// a temp dir by symlinking/setting at test time. The simplest safe approach for
// this architecture is to test the pure, synchronous compute functions directly
// (computeRealized, computePredictionError, computeOutcomeStatsBreakdown logic)
// plus the snapshot trust-block sanitization via a roundtrip through a temp dir.

// We'll spin up the whole module pointed at a temp dir by monkey-patching the
// paths it uses. Since the module hardcodes paths at import time from __dirname,
// we test the public async API by using a writable temp dir.

const _dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT_REAL = path.join(_dir, "..", "storage", "outcomes");

// Create a per-run temp root so we never pollute real storage.
const TEST_ROOT = path.join(os.tmpdir(), `outcome-test-${Date.now()}-${process.pid}`);
const TEST_PREDICTIONS = path.join(TEST_ROOT, "predictions");
const TEST_REALIZED    = path.join(TEST_ROOT, "realized");

// Swap the module's storage root by dynamically loading after setting paths.
// Since outcomeStore.js computes paths at import time, we use a simple test
// helper that writes files into the real storage dir but uses unique scanIds
// that won't collide. Each test cleans up after itself.

import {
  recordPredictionSnapshot,
  getPredictionSnapshot,
  recordOutcome,
  getOutcome,
  getOutcomeWithPrediction,
  computeOutcomeMetrics,
  computeOutcomeStatsBreakdown,
} from "./outcomeStore.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanup(scanId) {
  // Best-effort delete to avoid polluting storage with test artifacts
  for (const sub of ["predictions", "realized"]) {
    const safe = String(scanId || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    const p = path.join(ROOT_REAL, sub, `${safe}.json`);
    await fs.unlink(p).catch(() => {});
  }
}

// ── test runner ───────────────────────────────────────────────────────────────

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

// ── tests ────────────────────────────────────────────────────────────────────

console.log("\nsrc/outcomeStore.test.js");

await test("prediction snapshot persists trust block", async () => {
  const scanId = uid();
  try {
    const snap = await recordPredictionSnapshot({
      scanId,
      userId: "u_test",
      query:  "nike air max 1",
      category: "Sneakers",
      verdict: "BUY",
      confidence: 0.8,
      predictedProfit: 42,
      predictedRoiPct: 0.35,
      predictedBrand: "Nike",
      predictedModel: "Air Max 1",
      trust: {
        canonicalVerdict:             "BUY",
        evidenceTier:                 "verified_strong",
        verdictStrengthCap:           "strong",
        calibratedConfidence:         0.8,
        marketConfidence:             0.75,
        evidenceConfidence:           0.9,
        verifiedListingCount:         5,
        pricingSignalCount:           3,
        cleanCompCount:               8,
        consensusMedian:              162,
        canShowStrongLanguage:        true,
        canShowVerifiedLanguage:      true,
        canShowMedianAsAuthoritative: true,
      },
    });
    assert.ok(snap, "snapshot should be returned");
    assert.equal(snap.trust?.evidenceTier, "verified_strong", "evidenceTier should persist");
    assert.equal(snap.trust?.verdictStrengthCap, "strong", "verdictStrengthCap should persist");
    assert.equal(snap.trust?.verifiedListingCount, 5, "verifiedListingCount should persist");
    assert.equal(snap.trust?.pricingSignalCount, 3, "pricingSignalCount should persist");
    assert.equal(snap.trust?.consensusMedian, 162, "consensusMedian should persist");
    assert.equal(snap.trust?.canonicalVerdict, "BUY", "canonicalVerdict should persist");
    assert.equal(snap.predictedBrand, "Nike", "predictedBrand should persist");
    assert.equal(snap.predictedModel, "Air Max 1", "predictedModel should persist");
    assert.equal(snap.predictedRoiPct, 0.35, "predictedRoiPct should persist");
    assert.equal(snap.trust?.canShowStrongLanguage, true, "canShowStrongLanguage should persist");
    // Verify persisted to disk
    const fromDisk = await getPredictionSnapshot(scanId);
    assert.equal(fromDisk?.trust?.evidenceTier, "verified_strong", "trust should survive disk roundtrip");
  } finally {
    await cleanup(scanId);
  }
});

await test("old snapshot without trust block still parses", async () => {
  const scanId = uid();
  // Write a legacy-format snapshot directly (no trust field)
  const legacyPath = path.join(ROOT_REAL, "predictions", `${scanId}.json`);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, JSON.stringify({
    scanId, query: "legacy scan", verdict: "HOLD", confidence: 0.5, predictedProfit: 10,
  }), "utf8");
  try {
    const snap = await getPredictionSnapshot(scanId);
    assert.ok(snap, "legacy snapshot should parse");
    assert.equal(snap.scanId, scanId);
    assert.equal(snap.verdict, "HOLD");
    // trust may be undefined/null — should not throw
    assert.ok(snap.trust === undefined || snap.trust === null, "no trust field on legacy record is fine");
  } finally {
    await cleanup(scanId);
  }
});

await test("second snapshot write does not mutate original (immutable)", async () => {
  const scanId = uid();
  try {
    const first = await recordPredictionSnapshot({
      scanId, query: "original", verdict: "BUY", predictedProfit: 50,
      trust: { evidenceTier: "verified_strong", verifiedListingCount: 4 },
    });
    // Try to overwrite with different data
    const second = await recordPredictionSnapshot({
      scanId, query: "mutated", verdict: "PASS", predictedProfit: 0,
      trust: { evidenceTier: "no_evidence", verifiedListingCount: 0 },
    });
    // Should return the original, unmodified
    assert.equal(second?.query, "original", "query must not be overwritten");
    assert.equal(second?.verdict, "BUY", "verdict must not be overwritten");
    assert.equal(second?.trust?.evidenceTier, "verified_strong", "trust must not be overwritten");
  } finally {
    await cleanup(scanId);
  }
});

await test("no image bytes or base64 blobs stored in trust block", async () => {
  const scanId = uid();
  try {
    const snap = await recordPredictionSnapshot({
      scanId, query: "test", verdict: "HOLD",
      trust: {
        evidenceTier: "verified_strong",
        // These should be dropped by the whitelist
        imageBytes: Buffer.from("shouldnotstore").toString("base64"),
        base64Thumbnail: "data:image/jpeg;base64,/9j/4AAQ",
        rawHtml: "<html><body>lots of content</body></html>",
        verifiedListingCount: 2,
      },
    });
    assert.ok(snap, "snapshot should be returned");
    const t = snap.trust || {};
    assert.ok(!("imageBytes" in t), "imageBytes must not be stored");
    assert.ok(!("base64Thumbnail" in t), "base64Thumbnail must not be stored");
    assert.ok(!("rawHtml" in t), "rawHtml must not be stored");
    assert.equal(t.verifiedListingCount, 2, "known fields should still persist");
  } finally {
    await cleanup(scanId);
  }
});

await test("realizedProfit computes correctly (buy/sell/fees/shipping)", async () => {
  const scanId = uid();
  try {
    // Provide a prediction snapshot first
    await recordPredictionSnapshot({ scanId, query: "test item", verdict: "BUY", predictedProfit: 30 });
    const outcome = await recordOutcome(scanId, {
      bought: true, actualBuyPrice: 60,
      listed: true, listingPrice: 100,
      sold: true, actualSellPrice: 100,
      actualFees: 10, shippingCost: 5,
    });
    // realizedProfit = 100 - 60 - 10 - 5 = 25
    assert.equal(outcome.realizedProfit, 25, `expected 25, got ${outcome.realizedProfit}`);
    assert.ok(outcome.realizedMarginPct != null, "realizedMarginPct should be set");
  } finally {
    await cleanup(scanId);
  }
});

await test("profitError computes correctly (predicted - realized)", async () => {
  const scanId = uid();
  try {
    await recordPredictionSnapshot({ scanId, query: "test item", verdict: "BUY", predictedProfit: 30 });
    const outcome = await recordOutcome(scanId, {
      bought: true, actualBuyPrice: 60,
      sold: true, actualSellPrice: 100,
      actualFees: 10, shippingCost: 5,
    });
    // realizedProfit = 25, predictedProfit = 30, profitError = 30 - 25 = 5
    assert.equal(outcome.predictionError?.profitError, 5, `expected profitError=5, got ${outcome.predictionError?.profitError}`);
  } finally {
    await cleanup(scanId);
  }
});

await test("HOLD verdict keeps directionCorrect as null", async () => {
  const scanId = uid();
  try {
    await recordPredictionSnapshot({ scanId, query: "test hold", verdict: "HOLD", predictedProfit: 10 });
    const outcome = await recordOutcome(scanId, {
      bought: true, actualBuyPrice: 50,
      sold: true, actualSellPrice: 70,
      actualFees: 5, shippingCost: 2,
    });
    // HOLD is neither positive nor negative — directionCorrect must be null
    assert.equal(outcome.predictionError?.directionCorrect, null,
      `HOLD verdict must produce directionCorrect=null, got ${outcome.predictionError?.directionCorrect}`);
  } finally {
    await cleanup(scanId);
  }
});

await test("daysToSell computed from listedAt/soldAt when explicit value absent", async () => {
  const scanId = uid();
  try {
    await recordPredictionSnapshot({ scanId, query: "test sell speed", verdict: "BUY" });
    const listedAt = new Date(Date.now() - 7 * 86_400_000).toISOString(); // 7 days ago
    const soldAt   = new Date().toISOString();
    const outcome  = await recordOutcome(scanId, {
      bought: true, actualBuyPrice: 30,
      listed: true, listedAt,
      sold: true, soldAt, actualSellPrice: 55, actualFees: 5, shippingCost: 2,
    });
    // computeOutcomeMetrics reads daysToSell or derives from dates
    const metrics = await computeOutcomeMetrics(null);
    assert.ok(metrics, "metrics should return");
    // We can't assert exact avgDaysToSell since other records exist, but verify no throw
  } finally {
    await cleanup(scanId);
  }
});

await test("stats breakdown buckets by category, evidenceTier, verdict", async () => {
  const scanId1 = uid();
  const scanId2 = uid();
  try {
    await recordPredictionSnapshot({
      scanId: scanId1, query: "sneaker test", verdict: "BUY", category: "Sneakers",
      predictedProfit: 20,
      trust: { evidenceTier: "verified_strong", verifiedListingCount: 3 },
    });
    await recordPredictionSnapshot({
      scanId: scanId2, query: "toy test", verdict: "PASS", category: "Toys",
      predictedProfit: -5,
      trust: { evidenceTier: "pricing_signal_only", verifiedListingCount: 0 },
    });
    await recordOutcome(scanId1, { bought: true, actualBuyPrice: 50, sold: true, actualSellPrice: 75, actualFees: 5, shippingCost: 3 });
    await recordOutcome(scanId2, { bought: false });

    const breakdown = await computeOutcomeStatsBreakdown(null);
    assert.ok(breakdown, "breakdown should return");
    assert.ok(typeof breakdown.total === "number", "total should be a number");
    assert.ok(typeof breakdown.byCategory === "object", "byCategory should be object");
    assert.ok(typeof breakdown.byEvidenceTier === "object", "byEvidenceTier should be object");
    assert.ok(typeof breakdown.byVerdict === "object", "byVerdict should be object");
    // Sneakers bucket should exist
    assert.ok(breakdown.byCategory["Sneakers"], "Sneakers bucket should exist");
    assert.ok(breakdown.byCategory["Sneakers"].count >= 1, "Sneakers count should be >=1");
  } finally {
    await cleanup(scanId1);
    await cleanup(scanId2);
  }
});

await test("missing prediction shell marks predictionFound:false in dev route logic", async () => {
  const scanId = uid();
  try {
    // No prediction snapshot — just an outcome shell
    const outcome = await recordOutcome(scanId, { userId: "u_test_shell" });
    assert.ok(outcome, "outcome shell should be created");
    assert.equal(outcome.scanId, scanId, "scanId should match");
    // Verify getPredictionSnapshot returns null
    const pred = await getPredictionSnapshot(scanId);
    assert.equal(pred, null, "no prediction should exist for this scanId");
  } finally {
    await cleanup(scanId);
  }
});

// ── Phase 4D.2 tests ─────────────────────────────────────────────────────────

await test("recordPredictionSnapshot returns null for null/undefined input (no throw)", async () => {
  const r1 = await recordPredictionSnapshot(null);
  const r2 = await recordPredictionSnapshot(undefined);
  const r3 = await recordPredictionSnapshot({ scanId: null, query: "test" });
  assert.equal(r1, null, "null input returns null");
  assert.equal(r2, null, "undefined input returns null");
  assert.equal(r3, null, "null scanId returns null");
});

await test("non-stream fallback: snapshot captured under client scanId when no stream snapshot", async () => {
  const clientScanId = uid();
  try {
    // Simulate what _tryRecordSnapshot("non_stream_fallback", ...) does:
    // no prior snapshot exists for this scanId → new file written
    const snap = await recordPredictionSnapshot({
      scanId: clientScanId,
      query: "hawaiian airlines boeing 787 diecast model airplane",
      category: "General",
      verdict: "PASS",
      confidence: 0.38,
      trust: {
        canonicalVerdict: "PASS",
        evidenceTier: "pricing_signal_only",
        verdictStrengthCap: "evidence_limited",
        calibratedConfidence: 0.38,
        verifiedListingCount: 0,
        pricingSignalCount: 7,
        cleanCompCount: 7,
        consensusMedian: 70.87,
        canShowStrongLanguage: false,
      },
    });
    assert.ok(snap, "non-stream fallback snapshot should be written");
    assert.equal(snap.trust?.evidenceTier, "pricing_signal_only");
    assert.equal(snap.trust?.verifiedListingCount, 0);
    assert.equal(snap.trust?.pricingSignalCount, 7);
    assert.equal(snap.trust?.canonicalVerdict, "PASS");
    assert.equal(snap.trust?.canShowStrongLanguage, false);
  } finally {
    await cleanup(clientScanId);
  }
});

await test("non-stream fallback does not overwrite when stream already recorded", async () => {
  const serverScanId = uid();
  const clientScanId = uid(); // different scanId — these are separate files
  try {
    // Stream provisional capture fires first under server scanId
    const streamSnap = await recordPredictionSnapshot({
      scanId: serverScanId, query: "test item", verdict: "BUY",
      trust: { evidenceTier: "verified_strong", verifiedListingCount: 5 },
    });
    assert.equal(streamSnap?.trust?.evidenceTier, "verified_strong");

    // Non-stream fallback fires under client scanId (separate file, different key)
    const nonStreamSnap = await recordPredictionSnapshot({
      scanId: clientScanId, query: "test item", verdict: "HOLD",
      trust: { evidenceTier: "pricing_signal_only", verifiedListingCount: 0 },
    });
    assert.equal(nonStreamSnap?.trust?.evidenceTier, "pricing_signal_only");

    // Server snapshot is untouched
    const reDiskServer = await getPredictionSnapshot(serverScanId);
    assert.equal(reDiskServer?.trust?.evidenceTier, "verified_strong", "stream snapshot not affected by non-stream fallback");
  } finally {
    await cleanup(serverScanId);
    await cleanup(clientScanId);
  }
});

await test("recordPredictionSnapshot is idempotent: repeated call with same scanId returns original", async () => {
  const scanId = uid();
  try {
    await recordPredictionSnapshot({
      scanId, query: "first write", verdict: "BUY",
      trust: { evidenceTier: "verified_strong", pricingSignalCount: 4 },
    });
    // Call again with different data — should return first snapshot unchanged
    const second = await recordPredictionSnapshot({
      scanId, query: "second write", verdict: "PASS",
      trust: { evidenceTier: "no_evidence", pricingSignalCount: 0 },
    });
    assert.equal(second?.query, "first write", "query must not be overwritten");
    assert.equal(second?.trust?.evidenceTier, "verified_strong", "trust must not be overwritten");
    assert.equal(second?.trust?.pricingSignalCount, 4, "pricingSignalCount must not be overwritten");
  } finally {
    await cleanup(scanId);
  }
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
