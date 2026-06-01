// src/identityRejectionSummary.test.js
// node --test src/identityRejectionSummary.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmptyIdentitySummary,
  mergeIdentitySummaries,
  normalizeIdentitySummary,
} from "./identityRejectionSummary.js";

// ── createEmptyIdentitySummary ────────────────────────────────────────────────

test("createEmptyIdentitySummary: all fields present and zeroed", () => {
  const s = createEmptyIdentitySummary();
  assert.equal(s.rawCount, 0);
  assert.equal(s.keptCount, 0);
  assert.equal(s.rejectedCompetitorCount, 0);
  assert.equal(s.rejectedFamilyCount, 0);
  assert.equal(s.rejectedManufacturerCount, 0);
  assert.equal(s.rejectedModelMismatchCount, 0);
  assert.equal(s.rejectedMissingAirlineCount, 0);
  assert.equal(s.rejectedWeakAirlineGenericCount, 0);
  assert.equal(s.rejectedGenericToyCount, 0);
  assert.equal(s.rejectedMerchCount, 0);
  assert.equal(s.rejectedSneakerWrongLineCount, 0);
  assert.equal(s.rejectedSneakerWrongGenerationCount, 0);
  assert.equal(s.rejectedSneakerVariantCount, 0);
  assert.equal(s.rejectedJordanWrongModelCount, 0);
  assert.equal(s.rejectedJordanWrongCutCount, 0);
  assert.equal(s.rejectedJordanWrongSublineCount, 0);
  assert.equal(s.rejectedJordanWrongThemeCount, 0);
  assert.equal(s.rejectedJordanNonJordanCount, 0);
  assert.equal(s.rejectedOtherIdentityCount, 0);
  assert.equal(s.totalRejectedCount, 0);
  assert.equal(s.rejectionRatio, 0);
  assert.deepEqual(s.appliedLocks, []);
  assert.equal(s.relaxed, false);
});

// ── mergeIdentitySummaries ────────────────────────────────────────────────────

test("mergeIdentitySummaries: additively sums numeric fields", () => {
  const a = { ...createEmptyIdentitySummary(), rejectedCompetitorCount: 2, keptCount: 10, appliedLocks: ["airline"] };
  const b = { ...createEmptyIdentitySummary(), rejectedGenericToyCount: 3, keptCount: 5, appliedLocks: ["aircraft_model_tier"] };
  const m = mergeIdentitySummaries(a, b);
  assert.equal(m.rejectedCompetitorCount, 2);
  assert.equal(m.rejectedGenericToyCount, 3);
  assert.equal(m.keptCount, 15);
  assert.deepEqual(m.appliedLocks.sort(), ["airline", "aircraft_model_tier"].sort());
});

test("mergeIdentitySummaries: dedupes appliedLocks", () => {
  const a = { ...createEmptyIdentitySummary(), appliedLocks: ["airline", "aircraft_family"] };
  const b = { ...createEmptyIdentitySummary(), appliedLocks: ["airline"] };
  const m = mergeIdentitySummaries(a, b);
  assert.equal(m.appliedLocks.filter(l => l === "airline").length, 1, "airline should appear only once");
});

test("mergeIdentitySummaries: propagates relaxed=true", () => {
  const a = { ...createEmptyIdentitySummary(), relaxed: false };
  const b = { ...createEmptyIdentitySummary(), relaxed: true };
  assert.equal(mergeIdentitySummaries(a, b).relaxed, true);
  assert.equal(mergeIdentitySummaries(a).relaxed, false);
});

test("mergeIdentitySummaries: ignores null/undefined entries", () => {
  const a = { ...createEmptyIdentitySummary(), rejectedCompetitorCount: 5 };
  const m = mergeIdentitySummaries(a, null, undefined);
  assert.equal(m.rejectedCompetitorCount, 5);
});

test("mergeIdentitySummaries: empty call returns zeroed summary", () => {
  const m = mergeIdentitySummaries();
  assert.equal(m.totalRejectedCount, 0);
  assert.equal(m.rejectionRatio, 0);
});

// ── normalizeIdentitySummary ──────────────────────────────────────────────────

test("normalizeIdentitySummary: sums buckets into totalRejectedCount", () => {
  const s = {
    ...createEmptyIdentitySummary(),
    rejectedCompetitorCount:     2,
    rejectedModelMismatchCount:  1,
    rejectedMissingAirlineCount: 8,
    rejectedGenericToyCount:     3,
    keptCount:                   11,
  };
  const n = normalizeIdentitySummary(s);
  assert.equal(n.totalRejectedCount, 14, "2+1+8+3=14");
});

test("normalizeIdentitySummary: rejectionRatio uses totalRejectedCount + keptCount", () => {
  const s = {
    ...createEmptyIdentitySummary(),
    rejectedCompetitorCount: 14,
    keptCount:               11,
  };
  const n = normalizeIdentitySummary(s);
  assert.equal(n.totalRejectedCount, 14);
  const expected = Math.round((14 / 25) * 1000) / 1000;
  assert.equal(n.rejectionRatio, expected);
});

test("normalizeIdentitySummary: zero denominator → rejectionRatio=0", () => {
  const n = normalizeIdentitySummary(createEmptyIdentitySummary());
  assert.equal(n.rejectionRatio, 0);
  assert.equal(n.totalRejectedCount, 0);
});

test("normalizeIdentitySummary: clamps negative counts to 0", () => {
  const s = { ...createEmptyIdentitySummary(), rejectedCompetitorCount: -5, keptCount: -3 };
  const n = normalizeIdentitySummary(s);
  assert.equal(n.rejectedCompetitorCount, 0);
  assert.equal(n.keptCount, 0);
  assert.equal(n.totalRejectedCount, 0);
});

test("normalizeIdentitySummary: missing fields default to 0 (partial object input)", () => {
  const n = normalizeIdentitySummary({ keptCount: 5, rejectedGenericToyCount: 2 });
  assert.equal(n.keptCount, 5);
  assert.equal(n.rejectedGenericToyCount, 2);
  assert.equal(n.rejectedCompetitorCount, 0);
  assert.equal(n.totalRejectedCount, 2);
});

test("normalizeIdentitySummary: null input returns empty summary", () => {
  const n = normalizeIdentitySummary(null);
  assert.equal(n.totalRejectedCount, 0);
  assert.deepEqual(n.appliedLocks, []);
});

test("normalizeIdentitySummary: unknown/extra field is not exploded into standard buckets", () => {
  const s = { ...createEmptyIdentitySummary(), rejectedOtherIdentityCount: 7, keptCount: 3 };
  const n = normalizeIdentitySummary(s);
  assert.equal(n.rejectedOtherIdentityCount, 7);
  assert.equal(n.totalRejectedCount, 7);
});

test("normalizeIdentitySummary: sneaker counts don't get mislabeled as aircraft reasons", () => {
  const s = {
    ...createEmptyIdentitySummary(),
    rejectedSneakerWrongGenerationCount: 4,
    keptCount: 6,
  };
  const n = normalizeIdentitySummary(s);
  assert.equal(n.rejectedSneakerWrongGenerationCount, 4);
  assert.equal(n.rejectedFamilyCount, 0, "sneaker gen rejection must not pollute aircraft family count");
  assert.equal(n.totalRejectedCount, 4);
});

test("normalizeIdentitySummary: Jordan counts don't create fake aircraft reasons", () => {
  const s = {
    ...createEmptyIdentitySummary(),
    rejectedJordanWrongThemeCount: 3,
    keptCount: 7,
  };
  const n = normalizeIdentitySummary(s);
  assert.equal(n.rejectedJordanWrongThemeCount, 3);
  assert.equal(n.rejectedCompetitorCount, 0);
  assert.equal(n.rejectedFamilyCount, 0);
  assert.equal(n.totalRejectedCount, 3);
});

// ── Integration: mergeIdentitySummaries + normalizeIdentitySummary ────────────

test("merge then normalize: Hawaiian 787 scenario", () => {
  const aircraftLockSummary = {
    ...createEmptyIdentitySummary(),
    rejectedCompetitorCount:     2,
    rejectedModelMismatchCount:  1,
    rejectedMissingAirlineCount: 8,
    rejectedGenericToyCount:     3,
    appliedLocks: ["airline", "aircraft_family", "aircraft_model_tier"],
  };
  const merged = mergeIdentitySummaries(aircraftLockSummary);
  merged.keptCount = 11;
  const n = normalizeIdentitySummary(merged);

  assert.equal(n.totalRejectedCount, 14);
  assert.equal(n.keptCount, 11);
  const expectedRatio = Math.round((14 / 25) * 1000) / 1000;
  assert.equal(n.rejectionRatio, expectedRatio);
  assert.ok(n.appliedLocks.includes("airline"));
  assert.ok(n.appliedLocks.includes("aircraft_model_tier"));
});

test("totalRejectedCount=0 with cleanCompCount>0: no identity_lock_high_rejection_ratio should fire", () => {
  const s = normalizeIdentitySummary({ ...createEmptyIdentitySummary(), keptCount: 11 });
  assert.equal(s.totalRejectedCount, 0);
  assert.equal(s.rejectionRatio, 0);
  // rejectionRatio=0 < 0.25 threshold → no identity_lock_high_rejection_ratio in calibration
});
