// src/scanReviewStore.test.js
// node --test src/scanReviewStore.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect all store writes to an isolated tmp dir. storePaths() reads this
// env var at call time, so setting it here (before any store function runs)
// is sufficient.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "scan-review-test-"));
process.env.SCAN_REVIEW_DIR = TMP_DIR;

import {
  createScanReviewRecord,
  appendScanReviewRecord,
  readRecentScanReviews,
  findScanReviewByScanId,
  updateScanReview,
  SCAN_REVIEW_SCHEMA_VERSION,
} from "./scanReviewStore.js";

const JSONL = path.join(TMP_DIR, "scan-review.jsonl");
function resetStore() { try { fs.rmSync(JSONL, { force: true }); } catch {} }

// A realistic full capture input (Hawaiian 787 shaped).
function fullInput(overrides = {}) {
  return {
    scanId:   "scan-abc-123",
    traceId:  "trace-xyz",
    rid:      "rid-9",
    route:    "/market/search",
    userId:   "user-1",
    deviceId: "device-1",
    imageHash: "a".repeat(64),
    predicted: {
      query: "hawaiian airlines boeing 787 diecast model",
      finalQuery: "hawaiian airlines boeing 787-9 diecast 1:400",
      category: "model airplane",
      brand: "Phoenix",
      model: "787-9",
      identity: { title: "Hawaiian 787-9", brand: "Phoenix", scale: "1:400" },
      variants: ["hawaiian 787", "hawaiian 787-9 diecast"],
      visionConfidence: 0.85,
      visualConfidence: 0.72,
      brandCertainty: 0.6,
    },
    market: {
      finalVerdict: "PASS",
      canonicalVerdict: "PASS",
      calibratedConfidence: 0.4,
      marketConfidence: 0.0,
      evidenceConfidence: 0.16,
      evidenceTier: "pricing_signal_only",
      verdictStrengthCap: "evidence_limited",
      canShowVerifiedLanguage: false,
      canShowStrongLanguage: false,
      canShowMedianAsAuthoritative: false,
      verifiedListingCount: 0,
      pricingSignalCount: 6,
      cleanCompCount: 6,
      consensusMedian: 70,
      consensusListingCount: 6,
      consensusSpread: 20,
      marketEvidenceConfidence: "low",
      marketEvidenceReason: "pricing only",
      urlVerificationEnabled: false,
    },
    identityRejections: {
      totalRejectedCount: 12,
      rejectionRatio: 0.522,
      appliedLocks: ["aircraft_model_tier"],
      rejectedCompetitorCount: 1,
      rejectedMissingAirlineCount: 7,
      rejectedGenericToyCount: 3,
      rejectedModelMismatchCount: 1,
    },
    topListings: [
      { title: "Hawaiian 787", price: 70, totalPrice: 75, source: "ebay", clickable: false, isVerifiedListing: false, evidenceQuality: "pricing_signal", urlQuality: "google_unresolved", host: "ebay.com" },
    ],
    ...overrides,
  };
}

// 1 — required top-level shape
test("createScanReviewRecord returns the required top-level shape", () => {
  const rec = createScanReviewRecord(fullInput());
  assert.equal(rec.schemaVersion, SCAN_REVIEW_SCHEMA_VERSION);
  assert.equal(typeof rec.createdAt, "string");
  assert.equal(rec.updatedAt, null);
  for (const k of ["scanId", "traceId", "rid", "route", "userId", "deviceId", "imageHash", "imageHashPrefix", "predicted", "market", "identityRejections", "topListings", "review"]) {
    assert.ok(k in rec, `record has ${k}`);
  }
  assert.equal(rec.imageHashPrefix, "a".repeat(12));
  assert.equal(rec.predicted.query, "hawaiian airlines boeing 787 diecast model");
  assert.equal(rec.market.finalVerdict, "PASS");
  assert.equal(rec.market.evidenceTier, "pricing_signal_only");
  assert.equal(rec.identityRejections.totalRejectedCount, 12);
  assert.equal(rec.review.status, "unreviewed");
  assert.equal(rec.review.identityCorrect, null);
});

// 2 — topListings sanitized + capped to 12, only safe fields
test("topListings are sanitized and capped at 12 with only safe fields", () => {
  const raw = Array.from({ length: 20 }, (_, n) => ({
    title: `Listing ${n}`,
    price: 10 + n,
    totalPrice: 12 + n,
    source: "ebay",
    seller: "seller",
    clickable: false,
    isVerifiedListing: false,
    evidenceQuality: "pricing_signal",
    urlQuality: "google_unresolved",
    host: "ebay.com",
    // junk that must be dropped:
    imageBytes: "x".repeat(5000),
    thumbnailUrl: "https://img/whatever.jpg",
    rawHtml: "<html>...</html>",
    description: "y".repeat(9000),
  }));
  const rec = createScanReviewRecord(fullInput({ topListings: raw }));
  assert.equal(rec.topListings.length, 12);
  assert.equal(rec.topListings[0].rank, 1);
  assert.equal(rec.topListings[11].rank, 12);
  const allowed = new Set(["rank", "title", "price", "totalPrice", "source", "seller", "clickable", "isVerifiedListing", "evidenceQuality", "urlQuality", "host"]);
  for (const li of rec.topListings) {
    for (const k of Object.keys(li)) assert.ok(allowed.has(k), `unexpected listing field ${k}`);
  }
});

// 3 — raw image / image bytes never stored
test("raw image bytes are not stored anywhere in the record", () => {
  const rec = createScanReviewRecord(fullInput({
    imageHash: "b".repeat(64),
    predicted: { ...fullInput().predicted, identity: { brand: "Phoenix", imageBytes: "SECRET_BYTES", thumbnail: "data:image/png;base64,AAAA" } },
    topListings: [{ title: "x", price: 1, imageBytes: "SECRET_BYTES", imageBase64: "AAAA", image: "https://img/x.jpg" }],
  }));
  const json = JSON.stringify(rec);
  assert.ok(!json.includes("SECRET_BYTES"), "no raw image bytes");
  assert.ok(!json.includes("base64"), "no base64 image data");
  assert.ok(!/"image"\s*:/.test(json), "no image url field");
  // imageHash (already-computed digest) is allowed and prefixed
  assert.equal(rec.imageHashPrefix, "b".repeat(12));
});

// 4 — appendScanReviewRecord writes valid JSONL
test("appendScanReviewRecord writes valid JSONL", async () => {
  resetStore();
  const rec = createScanReviewRecord(fullInput({ scanId: "jsonl-1" }));
  const ok = await appendScanReviewRecord(rec);
  assert.equal(ok, true);
  const raw = fs.readFileSync(JSONL, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.scanId, "jsonl-1");
  assert.equal(parsed.schemaVersion, SCAN_REVIEW_SCHEMA_VERSION);
});

// 5 — readRecentScanReviews newest-first
test("readRecentScanReviews returns newest first", async () => {
  resetStore();
  await appendScanReviewRecord(createScanReviewRecord(fullInput({ scanId: "A" })));
  await appendScanReviewRecord(createScanReviewRecord(fullInput({ scanId: "B" })));
  await appendScanReviewRecord(createScanReviewRecord(fullInput({ scanId: "C" })));
  const recent = await readRecentScanReviews({ limit: 10 });
  assert.equal(recent.length, 3);
  assert.deepEqual(recent.map((r) => r.scanId), ["C", "B", "A"]);
  const one = await readRecentScanReviews({ limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].scanId, "C");
});

// findScanReviewByScanId
test("findScanReviewByScanId returns the record or null", async () => {
  resetStore();
  await appendScanReviewRecord(createScanReviewRecord(fullInput({ scanId: "find-1" })));
  const found = await findScanReviewByScanId("find-1");
  assert.ok(found);
  assert.equal(found.scanId, "find-1");
  assert.equal(await findScanReviewByScanId("missing"), null);
});

// 6 — updateScanReview patches review without destroying predicted/market
test("updateScanReview updates review fields without destroying predicted/market", async () => {
  resetStore();
  await appendScanReviewRecord(createScanReviewRecord(fullInput({ scanId: "upd-1" })));
  const updated = await updateScanReview("upd-1", {
    identityCorrect: true,
    queryCorrect: false,
    verdictFair: true,
    correctedSearchQuery: "hawaiian airlines 787-9 phoenix 1:400",
    notes: "model tier confirmed",
    reviewedBy: "andrew",
  });
  assert.ok(updated);
  assert.equal(updated.review.identityCorrect, true);
  assert.equal(updated.review.queryCorrect, false);
  assert.equal(updated.review.verdictFair, true);
  assert.equal(updated.review.status, "reviewed");
  assert.equal(updated.review.reviewedBy, "andrew");
  assert.equal(typeof updated.review.reviewedAt, "string");
  assert.equal(typeof updated.updatedAt, "string");
  // original predicted/market preserved
  assert.equal(updated.predicted.query, "hawaiian airlines boeing 787 diecast model");
  assert.equal(updated.market.finalVerdict, "PASS");
  assert.equal(updated.market.evidenceTier, "pricing_signal_only");
  assert.equal(updated.identityRejections.totalRejectedCount, 12);
  // persisted
  const reread = await findScanReviewByScanId("upd-1");
  assert.equal(reread.review.identityCorrect, true);
  assert.equal(reread.predicted.brand, "Phoenix");
});

// 7 — invalid booleans + huge notes sanitized
test("invalid booleans and huge notes are sanitized on update", async () => {
  resetStore();
  await appendScanReviewRecord(createScanReviewRecord(fullInput({ scanId: "san-1" })));
  const updated = await updateScanReview("san-1", {
    identityCorrect: "yes",            // not a boolean -> null
    queryCorrect: 1,                   // not a boolean -> null
    notes: "z".repeat(10000),          // huge -> capped
    badListingNotes: ["ok note", "x".repeat(5000), 123],
  });
  assert.ok(updated);
  assert.equal(updated.review.identityCorrect, null);
  assert.equal(updated.review.queryCorrect, null);
  assert.ok(updated.review.notes.length <= 4000, "notes capped to <= 4000");
  assert.ok(updated.review.badListingNotes.every((n) => typeof n === "string"), "badListingNotes are strings");
  assert.ok(updated.review.badListingNotes[1].length <= 500, "long badListingNote item capped");
});

// 8 — missing optional fields don't crash
test("missing optional fields do not crash", async () => {
  resetStore();
  const rec = createScanReviewRecord({});
  assert.equal(rec.schemaVersion, SCAN_REVIEW_SCHEMA_VERSION);
  assert.equal(rec.scanId, null);
  assert.equal(rec.predicted.query, null);
  assert.equal(rec.predicted.visionConfidence, 0);
  assert.equal(rec.market.finalVerdict, null);
  assert.equal(rec.market.verifiedListingCount, 0);
  assert.equal(rec.market.urlVerificationEnabled, false);
  assert.deepEqual(rec.topListings, []);
  assert.equal(rec.identityRejections.totalRejectedCount, 0);
  // bad inputs to all entry points
  assert.doesNotThrow(() => createScanReviewRecord(null));
  assert.doesNotThrow(() => createScanReviewRecord(42));
  const ok = await appendScanReviewRecord(createScanReviewRecord({ scanId: "empty-ok" }));
  assert.equal(ok, true);
  assert.equal(await updateScanReview("does-not-exist", { identityCorrect: true }), null);
  assert.equal(await updateScanReview(null, {}), null);
});
