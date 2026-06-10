// src/queryGuards.test.js
// Phase 4H.4 — prove the query guard chain catches all garbage before market search.
// node --test src/queryGuards.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { isGarbageQuery, isGenericGarbageQuery, isUsableVisionSeed } from "./queryGuards.js";

// ── isGenericGarbageQuery ─────────────────────────────────────────────────────

test('"used item for" is unusable — caught by /^used item/ pattern', () => {
  assert.equal(isGenericGarbageQuery("used item for"), true,
    '"used item for" must be rejected as generic garbage');
});

test('"used for pre owned" is unusable — caught by /^used for/ pattern', () => {
  assert.equal(isGenericGarbageQuery("used for pre owned"), true,
    '"used for pre owned" must be rejected as generic garbage');
});

test('"item for sale" is unusable — caught by /^item for/ pattern', () => {
  assert.equal(isGenericGarbageQuery("item for sale"), true);
});

test('"object for sale used" is unusable', () => {
  assert.equal(isGenericGarbageQuery("object for sale used"), true);
});

test('"used for marketplace" is unusable', () => {
  assert.equal(isGenericGarbageQuery("used for marketplace"), true);
});

test('"iPhone 13 Pro Max" passes — real product query', () => {
  assert.equal(isGenericGarbageQuery("iPhone 13 Pro Max"), false,
    '"iPhone 13 Pro Max" must NOT be rejected');
});

test('"Hawaiian Airlines Boeing 787-9 diecast model airplane" passes', () => {
  assert.equal(isGenericGarbageQuery("Hawaiian Airlines Boeing 787-9 diecast model airplane"), false);
});

test('"Nike Air Jordan 1 Low OG" passes', () => {
  assert.equal(isGenericGarbageQuery("Nike Air Jordan 1 Low OG"), false);
});

// ── isGarbageQuery ────────────────────────────────────────────────────────────

test('"item" is garbage', () => {
  assert.equal(isGarbageQuery("item"), true);
});

test('"product" is garbage', () => {
  assert.equal(isGarbageQuery("product"), true);
});

test('"Nike Air Jordan 1" is not single-word garbage', () => {
  assert.equal(isGarbageQuery("Nike Air Jordan 1"), false);
});

// ── isUsableVisionSeed ────────────────────────────────────────────────────────
// Proves: hard_deadline_fail with generic seed does NOT produce a usable search

test('hard_deadline_fail — "used item for" seed is NOT usable', () => {
  assert.equal(isUsableVisionSeed("used item for"), false,
    '"used item for" must not be a usable vision seed');
});

test('hard_deadline_fail — "used for pre owned" seed is NOT usable', () => {
  assert.equal(isUsableVisionSeed("used for pre owned"), false,
    '"used for pre owned" must not be a usable vision seed');
});

test('hard_deadline_fail — null seed is NOT usable', () => {
  assert.equal(isUsableVisionSeed(null), false);
  assert.equal(isUsableVisionSeed(""), false);
  assert.equal(isUsableVisionSeed(undefined), false);
});

test('hard_deadline_fail — "Hawaiian Airlines 787-9 diecast" IS a usable seed', () => {
  assert.equal(isUsableVisionSeed("Hawaiian Airlines 787-9 diecast"), true,
    'Real aircraft query must be a usable seed');
});

// ── oracle skip on generic query ──────────────────────────────────────────────
// Proves: oracle must never run on a query that isGenericGarbageQuery rejects

test('oracle guard — all oracle-triggering garbage queries are caught', () => {
  const garbageOracleQueries = [
    "used item for",
    "used for pre owned",
    "item for sale",
    "used for marketplace",
    "object for sale",
    "product available",
    "thing for sale today",
  ];
  for (const q of garbageOracleQueries) {
    assert.equal(
      isGenericGarbageQuery(q), true,
      `Oracle guard: "${q}" must be blocked by isGenericGarbageQuery`
    );
  }
});
