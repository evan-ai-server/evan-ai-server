import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeAircraftVariants, isAircraftQueryContext } from "./aircraftCacheSafeGuard.js";

// ── isAircraftQueryContext ────────────────────────────────────────────────────

test("isAircraftQueryContext: hawaiian airlines boeing 787 diecast → true", () => {
  assert.equal(isAircraftQueryContext("hawaiian airlines boeing 787 diecast model airplane"), true);
});

test("isAircraftQueryContext: nike air jordan 1 → false", () => {
  assert.equal(isAircraftQueryContext("nike air jordan 1 low og"), false);
});

test("isAircraftQueryContext: null/empty → false", () => {
  assert.equal(isAircraftQueryContext(null), false);
  assert.equal(isAircraftQueryContext(""), false);
});

// ── sanitizeAircraftVariants ──────────────────────────────────────────────────

test("aircraft query with glasses variant → glasses removed", () => {
  const r = sanitizeAircraftVariants("hawaiian airlines boeing 787 diecast model airplane", ["glasses"]);
  assert.deepEqual(r.removed, ["glasses"]);
  assert.deepEqual(r.variants, []);
});

test("aircraft query with mixed variants → only non-aircraft removed", () => {
  const r = sanitizeAircraftVariants("hawaiian airlines boeing 787 diecast model airplane", [
    "hawaiian airlines 787 model airplane",
    "glasses",
    "boeing 787 diecast",
    "shoes size 10",
  ]);
  assert.deepEqual(r.removed, ["glasses", "shoes size 10"]);
  assert.deepEqual(r.variants, ["hawaiian airlines 787 model airplane", "boeing 787 diecast"]);
});

test("aircraft query with all clean variants → none removed", () => {
  const variants = [
    "hawaiian airlines 787 model airplane",
    "boeing 787 diecast model airplane",
    "hawaiian airlines model airplane",
  ];
  const r = sanitizeAircraftVariants("hawaiian airlines boeing 787 diecast model airplane", variants);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.variants, variants);
});

test("non-aircraft query → no sanitization", () => {
  const variants = ["glasses", "sunglasses", "eyewear"];
  const r = sanitizeAircraftVariants("nike air jordan 1 low og", variants);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.variants, variants);
});

test("empty/null variants → passthrough", () => {
  const r1 = sanitizeAircraftVariants("boeing 787 diecast", []);
  assert.deepEqual(r1.variants, []);
  assert.deepEqual(r1.removed, []);

  const r2 = sanitizeAircraftVariants("boeing 787 diecast", null);
  assert.deepEqual(r2.variants, []);
  assert.deepEqual(r2.removed, []);
});

test("aircraft variant with maker terms preserved", () => {
  const r = sanitizeAircraftVariants("hawaiian airlines boeing 787 diecast model airplane", [
    "geminijets hawaiian airlines 787 dreamliner",
    "herpa boeing 787 hawaiian airlines",
    "ng models 787 hawaiian",
  ]);
  assert.deepEqual(r.removed, []);
  assert.equal(r.variants.length, 3);
});

// ── Static guards: index.js exact-aircraft cache acceptance ──────────────────

const INDEX_SRC = readFileSync(resolve(import.meta.dirname, "../index.js"), "utf8");

test("EXACT_AIRCRAFT_SAFE_CACHE_ACCEPTED_BELOW_MIN_TARGET log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("EXACT_AIRCRAFT_SAFE_CACHE_ACCEPTED_BELOW_MIN_TARGET"), "log missing");
});

test("exact aircraft cache exception uses _isExactAircraftIdentity at all 3 cache layers", () => {
  const enriched = INDEX_SRC.includes("_exactAircraftOkEnriched = _isExactAircraftIdentity && _notHighStakesForCache");
  const internal = INDEX_SRC.includes("_exactAircraftOkInternal = _isExactAircraftIdentity && _notHighStakesForCache");
  const serp = INDEX_SRC.includes("_exactAircraftOkSerp = _isExactAircraftIdentity && _notHighStakesForCache");
  assert.ok(enriched, "enriched cache layer missing aircraft exception");
  assert.ok(internal, "internal cache layer missing aircraft exception");
  assert.ok(serp, "serp cache layer missing aircraft exception");
});

test("exact aircraft cache requires cleanCount >= 4", () => {
  const matches = INDEX_SRC.match(/_exactAircraftOk\w+ = _isExactAircraftIdentity && _notHighStakesForCache && \w+\.cleanCount >= 4/g);
  assert.ok(matches && matches.length >= 3, `expected >= 3 cleanCount >= 4 guards, found ${matches?.length || 0}`);
});

test("aircraft cache exception does NOT lower global minTarget", () => {
  assert.ok(INDEX_SRC.includes("const MIN_CLEAN_RESULTS_TARGET  = Number(process.env.MIN_CLEAN_RESULTS_TARGET  || 8)"), "original MIN_CLEAN_RESULTS_TARGET declaration must be unchanged");
});

test("CACHE_MIN_CLEAN_POOL_POLICY reason includes exact_aircraft_safe_cache", () => {
  assert.ok(INDEX_SRC.includes('"exact_aircraft_safe_cache"'), "reason string missing from cache policy log");
});

test("_notHighStakesForCache uses isTrueHighStakesVisionCategory", () => {
  assert.ok(INDEX_SRC.includes("_notHighStakesForCache = !isTrueHighStakesVisionCategory("), "high-stakes guard missing");
});

// ── Static guards: variant sanitizer ─────────────────────────────────────────

test("MARKET_VARIANTS_SANITIZED_BY_CATEGORY log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("MARKET_VARIANTS_SANITIZED_BY_CATEGORY"), "sanitizer log missing");
});

test("sanitizeAircraftVariants is called in mergeCheapestSources", () => {
  assert.ok(INDEX_SRC.includes("sanitizeAircraftVariants(normalizedQuery, incomingVariants)"), "sanitizer call missing");
});

test("sanitizeAircraftVariants is imported from aircraftCacheSafeGuard", () => {
  assert.ok(INDEX_SRC.includes('import { sanitizeAircraftVariants } from "./src/aircraftCacheSafeGuard.js"'), "import missing");
});
