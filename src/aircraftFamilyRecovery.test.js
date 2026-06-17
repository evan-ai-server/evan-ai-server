import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateFamilyRecoveryHint,
  FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
} from "./aircraftFamilyRecovery.js";

// ── evaluateFamilyRecoveryHint ──────────────────────────────────────────────

test("family recovery: complete aircraft diecast candidate with matching airline → accepted", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Hawaiian Airlines Boeing 787 diecast model airplane",
    candidateCategory: "diecast model",
    candidateConfidence: 0.85,
    similarity: 0.95,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.recoveredQuery, "Hawaiian Airlines Boeing 787 diecast model airplane");
  assert.equal(r.reason, "similarity_family_hint_accepted");
});

test("family recovery: airline mismatch → rejected", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Delta Airlines Boeing 787 diecast model airplane",
    candidateCategory: "diecast model",
    candidateConfidence: 0.85,
    similarity: 0.95,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "airline_mismatch");
});

test("family recovery: candidate also missing family → rejected", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Hawaiian Airlines diecast airplane collectible",
    candidateCategory: "diecast model",
    candidateConfidence: 0.85,
    similarity: 0.95,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "candidate_missing_family");
});

test("family recovery: below similarity threshold → rejected", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Hawaiian Airlines Boeing 787 diecast model airplane",
    candidateCategory: "diecast model",
    candidateConfidence: 0.85,
    similarity: 0.80,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "below_similarity_threshold");
});

test("family recovery: non-aircraft category → rejected", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Hawaiian Airlines Boeing 787 vintage poster",
    candidateCategory: "poster",
    candidateConfidence: 0.85,
    similarity: 0.95,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "not_aircraft_collectible_context");
});

test("family recovery: low candidate confidence → rejected", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Hawaiian Airlines Boeing 787 diecast model airplane",
    candidateCategory: "diecast model",
    candidateConfidence: 0.4,
    similarity: 0.95,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "candidate_low_confidence");
});

test("family recovery: missing inputs → rejected", () => {
  const r = evaluateFamilyRecoveryHint({});
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "missing_inputs");
});

test("family recovery: Airbus A380 candidate with correct airline → accepted", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "ANA diecast model airplane",
    requiredAirline: "ana",
    candidateQuery: "ANA Airbus A380 1:400 diecast model airplane",
    candidateCategory: "diecast model",
    candidateConfidence: 0.80,
    similarity: 0.92,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, true);
  assert.equal(r.recoveredQuery, "ANA Airbus A380 1:400 diecast model airplane");
});

test("family recovery: conflicting manufacturer/family ignored (model present) → accepted", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Emirates diecast airplane model",
    requiredAirline: "emirates",
    candidateQuery: "Emirates Airbus A380 1:200 diecast model",
    candidateCategory: "diecast model",
    candidateConfidence: 0.85,
    similarity: 0.93,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, true);
});

test("FAMILY_RECOVERY_SIMILARITY_THRESHOLD is 0.88", () => {
  assert.equal(FAMILY_RECOVERY_SIMILARITY_THRESHOLD, 0.88);
});

// ── Oracle remains blocked during source unavailable ────────────────────────
// (This is covered by existing marketOracleGuard tests; this test confirms
// the family recovery helper itself does not create oracle bypass paths.)

test("family recovery: accepted result has no oracle/market fields", () => {
  const r = evaluateFamilyRecoveryHint({
    incompleteQuery: "Hawaiian Airlines diecast airplane model",
    requiredAirline: "hawaiian",
    candidateQuery: "Hawaiian Airlines Boeing 787 diecast model airplane",
    candidateCategory: "diecast model",
    candidateConfidence: 0.85,
    similarity: 0.95,
    threshold: FAMILY_RECOVERY_SIMILARITY_THRESHOLD,
  });
  assert.equal(r.accepted, true);
  assert.ok(!("items" in r), "recovery hint must not contain market items");
  assert.ok(!("verified" in r), "recovery hint must not contain verification status");
  assert.ok(!("directUrl" in r), "recovery hint must not contain URLs");
});

// ── V3.10B.1 static regression guard — no fake similarity in family recovery ──
// The V3.10B family recovery block must NOT pass hardcoded similarity values
// (like 0.90 or 0.95) to evaluateFamilyRecoveryHint without real same-image
// linkage. Only similarity: 1.0 (same-image proven) is acceptable.

test("V3.10B.1 static guard — family recovery block has no fake similarity values", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const startMarker = "AIRCRAFT_FAMILY_BACKGROUND_RECOVERY_STARTED";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, "family recovery block must exist in index.js");

  const endMarker = "AIRCRAFT_FAMILY_BACKGROUND_RECOVERY_ERROR";
  const endIdx = src.indexOf(endMarker, startIdx);
  assert.ok(endIdx !== -1, "family recovery error handler must exist");

  const block = src.slice(startIdx, endIdx);

  // Must NOT contain hardcoded fake similarity like 0.90 or 0.95
  assert.ok(
    !block.includes("similarity: 0.90"),
    "family recovery must not pass fake similarity: 0.90 (no real vector proof)"
  );
  assert.ok(
    !block.includes("similarity: 0.95"),
    "family recovery must not pass fake similarity: 0.95 (no real vector proof)"
  );

  // Must NOT iterate similarityEntries() — broad cross-image search is unsafe
  assert.ok(
    !block.includes("similarityEntries()"),
    "family recovery must not use broad similarityEntries() — only same-image linkage"
  );

  // Must use same-image linkage (1.0 = proven same image)
  assert.ok(
    block.includes("similarity: 1.0"),
    "family recovery must use similarity: 1.0 for same-image proven linkage"
  );
});

// ── V3.10B.1 static guard — legacy fallback does not write to SERP_CACHE ──

test("V3.10B.1 static guard — SERP_CACHE writes are gated on legacy fallback flag", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  // Find the non-stream legacy fallback section
  const legacyMarker = "LEGACY_SNAPSHOT_SOURCE_UNAVAILABLE_USED";
  const legacyIdx = src.indexOf(legacyMarker);
  assert.ok(legacyIdx !== -1, "legacy fallback block must exist");

  // Find the first SERP_CACHE.set after the legacy fallback in the non-stream path
  const afterLegacy = src.slice(legacyIdx, legacyIdx + 3000);
  const serpCacheSetIdx = afterLegacy.indexOf("SERP_CACHE.set");
  assert.ok(serpCacheSetIdx !== -1, "SERP_CACHE.set must exist after legacy block");

  // The SERP_CACHE.set line must include a legacy guard
  const serpLine = afterLegacy.slice(Math.max(0, serpCacheSetIdx - 200), serpCacheSetIdx + 100);
  assert.ok(
    serpLine.includes("_legacyFallbackUsed") || serpLine.includes("_streamLegacyFallbackUsed"),
    "SERP_CACHE.set after legacy fallback must be gated by legacy flag"
  );
});
