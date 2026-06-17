import { test } from "node:test";
import assert from "node:assert/strict";
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
