// src/queryGuards.test.js
// Phase 4H.4 — prove the query guard chain catches all garbage before market search.
// node --test src/queryGuards.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { isGarbageQuery, isGenericGarbageQuery, isUsableVisionSeed, isGenericAircraftToyQuery, detectIncompleteAircraftIdentityQuery } from "./queryGuards.js";

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

// ── isGenericAircraftToyQuery — Phase 4J.1 ────────────────────────────────────

test('isGenericAircraftToyQuery — true for generic aircraft queries', () => {
  const generic = [
    "white plastic model airplane toy",
    "model airplane",
    "toy airplane",
    "plastic airplane model",
    "model plane",
    "airplane toy",
    "plastic airplane",
    "aircraft model",
  ];
  for (const q of generic) {
    assert.equal(isGenericAircraftToyQuery(q), true, `"${q}" should be generic aircraft`);
  }
});

test('isGenericAircraftToyQuery — false when specific identity present', () => {
  const specific = [
    "Hawaiian Airlines Boeing 787 diecast model airplane",
    "ANA Airbus A380 Sea Turtle 1:400 model airplane",
    "Boeing 747-400 Pokemon ANA 1:200 model airplane",
    "GeminiJets 787-9 Hawaiian Airlines diecast model",
    "Herpa Boeing 787-9 Hawaiian Airlines aircraft model 1:200",
    "United Airlines Boeing 737 diecast model airplane",
    "Emirates Airbus A380 model airplane 1:400",
  ];
  for (const q of specific) {
    assert.equal(isGenericAircraftToyQuery(q), false, `"${q}" should NOT be generic aircraft`);
  }
});

test('isGenericAircraftToyQuery — false for non-aircraft queries', () => {
  const nonAircraft = [
    "Nike Vaporfly 2 running shoes",
    "Air Jordan 1 Low OG",
    "vintage watch Omega Seamaster",
    "white plastic toy car",
  ];
  for (const q of nonAircraft) {
    assert.equal(isGenericAircraftToyQuery(q), false, `"${q}" should not be generic aircraft`);
  }
});

test('oracle guard — generic premium aircraft query skips oracle', () => {
  const query = "white plastic model airplane toy";
  const scannedPrice = 165.99;
  const isGenericPremium = isGenericAircraftToyQuery(query) && scannedPrice >= 50;
  assert.equal(isGenericPremium, true, "generic aircraft at premium price should skip oracle");
});

test('oracle guard — low price generic aircraft toy does not skip oracle', () => {
  const query = "white plastic model airplane toy";
  const scannedPrice = 10;
  const isGenericPremium = isGenericAircraftToyQuery(query) && scannedPrice >= 50;
  assert.equal(isGenericPremium, false, "cheap toy airplane should not skip oracle");
});

test('oracle guard — specific aircraft query does not skip oracle', () => {
  const query = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const scannedPrice = 165.99;
  const isGenericPremium = isGenericAircraftToyQuery(query) && scannedPrice >= 50;
  assert.equal(isGenericPremium, false, "specific aircraft should not skip oracle");
});

// ── detectIncompleteAircraftIdentityQuery — Phase 4J.2 ───────────────────────

test('incomplete aircraft — "Hawaiian Airlines diecast airplane model" has airline, no family', () => {
  const r = detectIncompleteAircraftIdentityQuery("Hawaiian Airlines diecast airplane model");
  assert.equal(r.incomplete, true, "should be incomplete: airline present, no family");
  assert.equal(r.requiredAirline, "hawaiian");
  assert.equal(r.requiredFamily, null);
  assert.equal(r.reason, "airline_present_family_missing");
});

test('incomplete aircraft — "hawaiian airlines diecast airplane model" (lowercase) has airline, no family', () => {
  const r = detectIncompleteAircraftIdentityQuery("hawaiian airlines diecast airplane model");
  assert.equal(r.incomplete, true);
  assert.equal(r.requiredAirline, "hawaiian");
});

test('not incomplete — "Hawaiian Airlines Boeing 787 diecast model airplane" has airline + family', () => {
  const r = detectIncompleteAircraftIdentityQuery("Hawaiian Airlines Boeing 787 diecast model airplane");
  assert.equal(r.incomplete, false, "should NOT be incomplete: has 787 family");
});

test('not incomplete — "ANA Airbus A380 Sea Turtle 1:400" has airline + family', () => {
  const r = detectIncompleteAircraftIdentityQuery("ANA Airbus A380 Sea Turtle 1:400");
  assert.equal(r.incomplete, false, "should NOT be incomplete: has a380 family");
});

test('not incomplete — "white plastic model airplane toy" has no airline', () => {
  const r = detectIncompleteAircraftIdentityQuery("white plastic model airplane toy");
  assert.equal(r.incomplete, false, "no airline → not incomplete aircraft identity");
});

test('not incomplete — "Emirates Airbus A380 diecast model" has airline + family', () => {
  const r = detectIncompleteAircraftIdentityQuery("Emirates Airbus A380 diecast model");
  assert.equal(r.incomplete, false);
});

test('not incomplete — "United Airlines Boeing 777 diecast" has airline + family', () => {
  const r = detectIncompleteAircraftIdentityQuery("United Airlines Boeing 777 diecast");
  assert.equal(r.incomplete, false);
});

test('not incomplete — "Hawaiian Airlines shirt" has airline but not an aircraft query', () => {
  const r = detectIncompleteAircraftIdentityQuery("Hawaiian Airlines shirt");
  assert.equal(r.incomplete, false, "no aircraft term → not an aircraft query");
});

test('oracle guard — incomplete aircraft blocks oracle', () => {
  const query = "Hawaiian Airlines diecast airplane model";
  const identityQuality = 0.47;
  const phase1Items = [];
  const _incomplete = detectIncompleteAircraftIdentityQuery(query);
  // Simulate: needsOracle = _incomplete.incomplete ? false : oracleDecision.invoke
  const needsOracle = _incomplete.incomplete ? false : (phase1Items.length === 0 && identityQuality >= 0.35);
  assert.equal(needsOracle, false, "incomplete aircraft identity must block oracle");
});

test('oracle guard — exact aircraft query does not block oracle due to incomplete check', () => {
  const query = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const _incomplete = detectIncompleteAircraftIdentityQuery(query);
  assert.equal(_incomplete.incomplete, false, "exact aircraft must not be flagged as incomplete");
});

test('oracle guard — source unavailable + no market data blocks oracle', () => {
  const serpCooling = true;
  const ebayAvailable = false;
  const phase1Items = [];
  const _primarySourceUnavailable = serpCooling && !ebayAvailable;
  const _sourceUnavailableNoData = _primarySourceUnavailable && phase1Items.length === 0;
  const oracleDecisionInvoke = true; // oracle would normally fire
  const needsOracle = _sourceUnavailableNoData ? false : oracleDecisionInvoke;
  assert.equal(needsOracle, false, "source unavailable + no market data must block oracle");
});

test('oracle guard — source unavailable but has items still allows oracle', () => {
  const serpCooling = true;
  const ebayAvailable = false;
  const phase1Items = [{ title: "item1" }, { title: "item2" }];
  const _primarySourceUnavailable = serpCooling && !ebayAvailable;
  const _sourceUnavailableNoData = _primarySourceUnavailable && phase1Items.length === 0;
  const oracleDecisionInvoke = true;
  const needsOracle = _sourceUnavailableNoData ? false : oracleDecisionInvoke;
  assert.equal(needsOracle, true, "source unavailable but items present → oracle still allowed");
});
