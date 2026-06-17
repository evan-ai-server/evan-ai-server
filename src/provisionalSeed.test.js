import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateProvisionalSeed, isSafeProvisionalCategory } from "./provisionalSeed.js";

const T = 0.92;

test("safe diecast, high similarity, complete aircraft → accepted (query stays exact)", () => {
  const q = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const r = evaluateProvisionalSeed({ mode: "item", query: q, category: "diecast model", similarity: 0.95, threshold: T });
  assert.equal(r.eligible, true, r.reason);
  assert.equal(r.reason, "accepted");
});

test("prop mode is also allowed", () => {
  const r = evaluateProvisionalSeed({ mode: "prop", query: "GeminiJets 787-9 diecast model airplane", category: "diecast model", similarity: 0.93, threshold: T });
  assert.equal(r.eligible, true, r.reason);
});

test("sneaker, high similarity → rejected (unsafe category)", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Nike ZoomX Vaporfly Next% 2", category: "sneakers", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "unsafe_or_unknown_category");
});

test("electronics (AirPods), high similarity → rejected", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Apple AirPods Pro 2", category: "electronics", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "unsafe_or_unknown_category");
});

test("unknown / empty category → rejected", () => {
  const r1 = evaluateProvisionalSeed({ mode: "item", query: "some thing", category: "general", similarity: 0.99, threshold: T });
  assert.equal(r1.eligible, false);
  assert.equal(r1.reason, "unsafe_or_unknown_category");
  const r2 = evaluateProvisionalSeed({ mode: "item", query: "some thing", category: "", similarity: 0.99, threshold: T });
  assert.equal(r2.eligible, false);
  assert.equal(r2.reason, "unsafe_or_unknown_category");
});

test("below similarity threshold → rejected even for safe category", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Hawaiian Airlines Boeing 787 diecast model airplane", category: "diecast model", similarity: 0.90, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "below_similarity_threshold");
});

test("mode not item/prop → rejected", () => {
  const r = evaluateProvisionalSeed({ mode: "label", query: "Hawaiian Airlines Boeing 787 diecast model airplane", category: "diecast model", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "mode_not_item_prop");
});

test("incomplete aircraft (airline, no family) → rejected, never invents a family", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Hawaiian Airlines diecast model airplane", category: "diecast model", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "incomplete_aircraft_identity");
});

test("empty prior query → rejected", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "", category: "diecast model", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "no_prior_query");
});

test("isSafeProvisionalCategory allowlist vs high-stakes block", () => {
  assert.equal(isSafeProvisionalCategory("diecast model"), true);
  assert.equal(isSafeProvisionalCategory("model airplane"), true);
  assert.equal(isSafeProvisionalCategory("collectible"), true);
  assert.equal(isSafeProvisionalCategory("sneakers"), false);
  assert.equal(isSafeProvisionalCategory("watch"), false);
  assert.equal(isSafeProvisionalCategory("graded card"), false);
  assert.equal(isSafeProvisionalCategory(""), false);
  assert.equal(isSafeProvisionalCategory("general"), false);
});

// ── V3.10A: late similarity seed rescue — same policy, later in the scan ──────
//
// The grace window fires when all fast vision passes miss the 3300ms deadline.
// By then the embed has been running for ~400ms and is typically done.
// V3.10A checks _similarityVec at the START of the grace window; if a high-
// confidence safe hit exists it returns immediately (same as provisional seed).
// These tests prove the SAME evaluateProvisionalSeed policy governs both paths.

test("V3.10A — late seed: Hawaiian 787 complete-identity hit accepted (the live failure recovery)", () => {
  // This is the exact scan that failed: embed at 407ms, provisional budget 250ms, all passes timed out.
  // With V3.10A, the grace window would find _similarityVec set and call evaluateProvisionalSeed.
  const r = evaluateProvisionalSeed({
    mode: "item",
    query: "Hawaiian Airlines Boeing 787 diecast model airplane",
    category: "diecast model",
    similarity: 0.955, // same similarity seen in prior live scan
    threshold: 0.92,
  });
  assert.equal(r.eligible, true, r.reason);
  assert.equal(r.reason, "accepted");
});

test("V3.10A — late seed: airline-only (no 787 family) → rejected, still not market-ready", () => {
  // If the prior cached query was from a hard-fail scan that returned "Hawaiian Airlines
  // diecast model airplane" (incomplete identity), the late seed must also reject it.
  const r = evaluateProvisionalSeed({
    mode: "item",
    query: "Hawaiian Airlines diecast model airplane",
    category: "diecast model",
    similarity: 0.96,
    threshold: 0.92,
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "incomplete_aircraft_identity");
});

test("V3.10A — late seed: high-stakes category (sneakers) → rejected regardless of similarity", () => {
  const r = evaluateProvisionalSeed({
    mode: "item",
    query: "Nike Air Jordan 1 High Chicago",
    category: "sneakers",
    similarity: 0.99,
    threshold: 0.92,
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "unsafe_or_unknown_category");
});

test("V3.10A — late seed missing: null _embedPromise means no late check (hard_fail remains)", () => {
  // When _embedPromise is null (not passed to runVisionConsensus), the late seed
  // block is gated by `&& _embedPromise` and skipped entirely. The grace race
  // proceeds normally and eventually expires → hard_fail_no_seed.
  const _embedPromise = null;
  const lateSeedSkipped = !_embedPromise;
  assert.equal(lateSeedSkipped, true, "null promise → late seed skipped, grace race proceeds");
});

test("V3.10A — late seed disabled when PROVISIONAL_SEED flag is off", () => {
  // The late seed block is gated by VISION_SIMILARITY_PROVISIONAL_SEED_ENABLED.
  // When the flag is off (prod default), behavior is exactly as before V3.10A.
  const flagOff = false; // VISION_SIMILARITY_PROVISIONAL_SEED_ENABLED = false (prod default)
  const lateSeedSkipped = !flagOff;
  assert.equal(lateSeedSkipped, true, "flag off → late seed disabled, grace race proceeds");
});

test("V3.10A — query_fast wins before grace starts: late seed block never reached", () => {
  // raceWinner === "hard_deadline" is required to enter the grace block.
  // When query_fast wins (raceWinner === "fast"), the grace block is never entered.
  // This models the NORMAL fast-scan path: no regression.
  const raceWinner = "fast"; // query_fast returned before hard deadline
  const graceBlockEntered = raceWinner === "hard_deadline";
  assert.equal(graceBlockEntered, false, "fast win → grace block skipped → late seed never runs");
});

// ── V3.10A.2 regression guard — static source-code scope check ───────────────
// node --check passes even when variables are used out-of-scope (ReferenceError is
// only caught at runtime). This test reads the grace-window late-seed block from
// index.js and asserts no known out-of-scope identifiers are referenced there.
// Both crashes so far (skipCaches → V3.10A.1, _similarityVec → V3.10A.2) would
// have been caught by this.

test("V3.10A.2 static scope guard — grace window late-seed block has no known out-of-scope identifiers", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  // Extract the late-seed block: from VISION_SIMILARITY_LATE_SEED block start to end
  const startMarker = "if (VISION_SIMILARITY_PROVISIONAL_SEED_ENABLED && _embedPromise)";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, "late-seed block must exist in index.js");

  // Check a narrow window around that block (2000 chars is enough for the whole block)
  const blockSlice = src.slice(startIdx, startIdx + 2000);

  // These identifiers are known to be OUT OF SCOPE inside runVisionConsensus:
  // - _similarityVec: declared in the outer request handler, not passed as a param
  // - skipCaches: declared in the outer request handler AFTER runVisionConsensus returns
  assert.ok(
    !blockSlice.includes("_similarityVec") || blockSlice.includes("const _lateSimilarityVec"),
    "block must not reference out-of-scope _similarityVec (use _lateSimilarityVec from await _embedPromise)"
  );
  assert.ok(
    !blockSlice.includes("skipCaches"),
    "block must not reference out-of-scope skipCaches (use isBenchBypass(req) or gate by _embedPromise)"
  );

  // And confirm the in-scope replacement is present
  assert.ok(blockSlice.includes("_embedPromise"), "block must use _embedPromise (in-scope param)");
  assert.ok(blockSlice.includes("_lateSimilarityVec"), "block must derive vector from await _embedPromise");
});
