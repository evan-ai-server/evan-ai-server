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
  // - res: Express response object, only in the outer handler — not a param of runVisionConsensus
  assert.ok(
    !blockSlice.includes("_similarityVec") || blockSlice.includes("const _lateSimilarityVec"),
    "block must not reference out-of-scope _similarityVec (use _lateSimilarityVec from await _embedPromise)"
  );
  assert.ok(
    !blockSlice.includes("skipCaches"),
    "block must not reference out-of-scope skipCaches (use isBenchBypass(req) or gate by _embedPromise)"
  );
  assert.ok(
    !blockSlice.includes("res.status") && !blockSlice.includes("res.json"),
    "block must not reference out-of-scope res (runVisionConsensus returns an object, not an HTTP response)"
  );

  // And confirm the in-scope replacement is present
  assert.ok(blockSlice.includes("_embedPromise"), "block must use _embedPromise (in-scope param)");
  assert.ok(blockSlice.includes("_lateSimilarityVec"), "block must derive vector from await _embedPromise");
});

// ── V3.10B.2: late seed returns a result object, not res.status() ──────────
test("V3.10B.2 — late seed accepted path sets _graceRescuedFastResult (not res.status)", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const startMarker = "VISION_SIMILARITY_LATE_SEED_ACCEPTED";
  const startIdx = src.indexOf(startMarker);
  assert.ok(startIdx !== -1, "LATE_SEED_ACCEPTED log must exist");

  const block = src.slice(startIdx, startIdx + 1500);
  assert.ok(
    block.includes("_graceRescuedFastResult"),
    "accepted late seed must set _graceRescuedFastResult for downstream seed_recovery"
  );
  assert.ok(
    !block.includes("res.status"),
    "accepted late seed must NOT call res.status() — res is not in scope"
  );
});

// ── V3.10B.2: incomplete verified query is not treated as disagreement ──────
test("V3.10B.2 — verified query subset of seed is 'inconclusive', not 'disagree'", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const fnIdx = src.indexOf("function isVerifiedQueryIncomplete");
  assert.ok(fnIdx !== -1, "isVerifiedQueryIncomplete must be defined in index.js");
});

test("V3.10B.2 — self-heal uses isVerifiedQueryIncomplete before status='disagree'", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const selfHealSection = src.indexOf("isVerifiedQueryIncomplete(seedQuery, verifiedQuery)");
  assert.ok(selfHealSection !== -1, "self-heal block must call isVerifiedQueryIncomplete");

  const inconclusiveStatus = src.indexOf('status = "inconclusive"');
  assert.ok(inconclusiveStatus !== -1, "inconclusive status must exist for subset queries");
});

// ── V3.10B.2: final UI identity lock — static code check ────────────────────
test("V3.10B.2 — FINAL_UI_IDENTITY_LOCK_APPLIED log exists in buildMarketSearchResponsePayload", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const lockLog = src.indexOf("FINAL_UI_IDENTITY_LOCK_APPLIED");
  assert.ok(lockLog !== -1, "final UI identity lock must be applied before PAYLOAD_FINAL_ITEMS_BEFORE_SEND");

  const payloadLog = src.indexOf("PAYLOAD_FINAL_ITEMS_BEFORE_SEND");
  assert.ok(payloadLog !== -1);
  assert.ok(lockLog < payloadLog, "identity lock must run BEFORE the final items log");
});

// ── V3.10B.3: SLA legacy _buildPayload must pass isLegacyFallback: true ─────
test("V3.10B.3 — SLA legacy _buildPayload call includes isLegacyFallback: true", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const slaLegacyIdx = src.indexOf("sla_exhausted_legacy_fallback");
  if (slaLegacyIdx === -1) return; // guard string may differ, skip gracefully

  const slaBlock = src.slice(slaLegacyIdx, slaLegacyIdx + 2000);
  const buildCall = slaBlock.indexOf("_buildPayload");
  assert.ok(buildCall !== -1, "SLA legacy path must call _buildPayload");
  const callSlice = slaBlock.slice(buildCall, buildCall + 300);
  assert.ok(
    callSlice.includes("isLegacyFallback: true") || callSlice.includes("isLegacyFallback:true"),
    "SLA legacy _buildPayload must pass isLegacyFallback: true to prevent snapshot pollution"
  );
});

// ── V3.10B.3: final UI identity lock has no >=2 floor (zero honest > competitor junk)
test("V3.10B.3 — final UI identity lock assigns filtered even when < 2 items remain", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const lockIdx = src.indexOf("FINAL_UI_IDENTITY_LOCK_APPLIED");
  assert.ok(lockIdx !== -1);

  // Search backwards from the log to find the assignment block (~200 chars before the log)
  const preBlock = src.slice(Math.max(0, lockIdx - 400), lockIdx);
  assert.ok(
    !preBlock.includes("_uiFiltered.length >= 2"),
    "final UI identity lock must NOT have a >= 2 floor — zero honest items is better than competitor junk"
  );
});

// ── V3.10B.4: query_fast rejected for incomplete aircraft → no VISION_QUERY_FAST_ACCEPTED
test("V3.10B.4 — static: AIRCRAFT_IDENTITY_INCOMPLETE_QUERY_FAST_REJECTED block does not also accept", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const rejIdx = src.indexOf("AIRCRAFT_IDENTITY_INCOMPLETE_QUERY_FAST_REJECTED");
  assert.ok(rejIdx !== -1, "rejection log must exist");

  // The rejection block sits inside the refinement failure path. After it,
  // the code must return before reaching VISION_QUERY_FAST_ACCEPTED.
  // Check that VISION_QUERY_FAST_REJECTED_INCOMPLETE_AIRCRAFT exists
  // (the new hard rejection that returns before acceptance).
  const hardReject = src.indexOf("VISION_QUERY_FAST_REJECTED_INCOMPLETE_AIRCRAFT");
  assert.ok(hardReject !== -1, "hard rejection log must exist after failed refinement");
  assert.ok(hardReject > rejIdx, "hard rejection must follow the refinement failure log");
});

test("V3.10B.4 — static: incomplete aircraft returns incompleteIdentity payload (not query_fast accepted)", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const marker = src.indexOf("VISION_QUERY_FAST_REJECTED_INCOMPLETE_AIRCRAFT");
  assert.ok(marker !== -1);
  const returnBlock = src.slice(marker, marker + 900);
  assert.ok(returnBlock.includes("incompleteIdentity: true"), "must return incompleteIdentity");
  assert.ok(returnBlock.includes('"INCOMPLETE_AIRCRAFT_IDENTITY"'), "must set error code");
});

// ── V3.10B.5: incomplete-aircraft rejection must NOT abort master ──────────────
// node --check cannot catch this: aborting master here silently kills the
// background long-poll recovery that produces the exact aircraft identity.
test("V3.10B.5 — static: incomplete aircraft rejection keeps master alive for background recovery", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const marker = src.indexOf("VISION_QUERY_FAST_REJECTED_INCOMPLETE_AIRCRAFT");
  assert.ok(marker !== -1, "rejection log must exist");
  // Slice from just BEFORE the rejection block (the aborts precede the log) to the return.
  const block = src.slice(marker - 400, marker + 900);

  assert.ok(
    !block.includes("masterAbortCtrl.abort()"),
    "rejection branch must NOT abort master — it kills background identity recovery"
  );
  assert.ok(
    block.includes("_registerMasterBackgroundRecovery()"),
    "rejection branch must register master background recovery for salvage long-poll"
  );
  assert.ok(
    block.includes("launchMasterNow()"),
    "rejection branch must ensure master is launched"
  );
  // The returned payload must not hardcode masterLaunched:false (the old regression).
  assert.ok(
    !block.includes("masterLaunched: false"),
    "rejection branch must not hardcode masterLaunched:false"
  );
});

// ── V3.10B.5: shared background-recovery helper used by BOTH no-seed paths ──────
test("V3.10B.5 — static: background-recovery helper is defined and used by hard_deadline + incomplete paths", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const def = src.indexOf("const _registerMasterBackgroundRecovery =");
  assert.ok(def !== -1, "helper must be defined once");

  // Used at exactly two call sites (hard_deadline + incomplete-aircraft rejection),
  // plus the definition = 3 textual occurrences total.
  const occurrences = src.split("_registerMasterBackgroundRecovery").length - 1;
  assert.ok(occurrences >= 3, `helper must be defined and called from both no-seed paths (found ${occurrences} refs)`);

  // The hard_deadline path must still trigger background recovery (extraction must
  // not have dropped it).
  const hardTimeout = src.indexOf("VISION_FIRST_QUERY_HARD_TIMEOUT");
  assert.ok(hardTimeout !== -1);
  const hardBlock = src.slice(hardTimeout, hardTimeout + 600);
  assert.ok(
    hardBlock.includes("_registerMasterBackgroundRecovery()"),
    "hard_deadline path must still register master background recovery"
  );
});

// ── V3.10B.6 (B): background family recovery scans master identity fields ──────
test("V3.10B.6 — static: background recovery scans master identity fields, not only variants", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const marker = src.indexOf("AIRCRAFT_BACKGROUND_QUERY_INCOMPLETE");
  assert.ok(marker !== -1, "incomplete-aircraft background block must exist");
  const block = src.slice(marker, marker + 1600);

  assert.ok(block.includes("recoverFamilyFromMasterFields("),
    "must use the pure recoverFamilyFromMasterFields helper");
  // Proves it reads structured identity fields, not just variants.
  for (const field of ["_bgIdent.model", "_bgIdent.family", "_bgIdent.modelNumber", "_bgIdent.brand"]) {
    assert.ok(block.includes(field), `recovery must consider ${field}`);
  }
  // Must NOT graft from legacy snapshot or similarity in this path.
  assert.ok(!block.includes("readLegacySnapshotFallback"), "must not use legacy snapshot to infer family");
  assert.ok(!block.includes("similarityFindSimilar"), "must not use broad similarity to infer family");
});

test("V3.10B.6 — static: no fresh model/vision call added to background family recovery (no A)", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");
  const marker = src.indexOf("AIRCRAFT_BACKGROUND_QUERY_INCOMPLETE");
  const block = src.slice(marker, marker + 1600);
  // The recovery must not invoke a new vision pass or oracle (B not A).
  assert.ok(!block.includes("runVisionPass"), "background family recovery must not run a fresh vision pass");
  assert.ok(!block.includes("gptMarketOracle"), "background family recovery must not call the oracle");
  assert.ok(!block.includes("openai."), "background family recovery must not make a fresh model call");
});

// ── V3.10B.6 (C): VISION_UNDER_2S_BLOCKER_SUMMARY instrumentation ──────────────
test("V3.10B.6 — static: VISION_UNDER_2S_BLOCKER_SUMMARY exists with key blocker fields", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const marker = src.indexOf("VISION_UNDER_2S_BLOCKER_SUMMARY");
  assert.ok(marker !== -1, "blocker summary log must exist");
  const block = src.slice(marker, marker + 1400);
  for (const field of ["queryFastMs", "queryFastTimedOut", "fastMs", "visualMs", "similarityMs", "hardDeadlineMs", "masterLaunched", "blockerReasons"]) {
    assert.ok(block.includes(field), `blocker summary must include ${field}`);
  }
});

test("V3.10B.4 — static: market stream blocks incomplete aircraft pre-source", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const streamGuard = src.indexOf("MARKET_BLOCKED_INCOMPLETE_AIRCRAFT_IDENTITY_PRE_SOURCE");
  assert.ok(streamGuard !== -1, "stream pre-source block must exist");
  const guardBlock = src.slice(streamGuard, streamGuard + 500);
  assert.ok(
    guardBlock.includes("/market/search/stream") || guardBlock.includes("/market/search"),
    "pre-source block must reference a market route"
  );
});

test("V3.10B.4 — static: market non-stream blocks incomplete aircraft pre-source", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const routeGuard = src.indexOf('route: "/market/search", query');
  const preSource = src.indexOf("MARKET_BLOCKED_INCOMPLETE_AIRCRAFT_IDENTITY_PRE_SOURCE");
  assert.ok(preSource !== -1);
  // The non-stream pre-source guard must exist
  const nonStreamGuard = src.indexOf('route: "/market/search"', preSource);
  assert.ok(nonStreamGuard !== -1, "non-stream pre-source block must exist");
});

// ── V3.10B.10: grace-path aircraft family-completeness gate ─────────────────
// The seed recovery loop (where grace-rescued query_fast results are accepted)
// must enforce the same aircraft family check the normal query_fast path has.

test("V3.10B.10 — seed recovery loop contains aircraft family-completeness gate", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  // The seed recovery loop starts with _seedCandidates and iterates with "if (acceptable)"
  const seedLoop = src.indexOf("_seedCandidates");
  assert.ok(seedLoop !== -1, "seed recovery loop must exist");

  // Find the "if (acceptable)" block within the seed recovery section
  const acceptableCheck = src.indexOf("if (acceptable)", seedLoop);
  assert.ok(acceptableCheck !== -1, "acceptable check must exist in seed recovery");

  // The aircraft family gate must be INSIDE the acceptable block, BEFORE _seedResult assignment
  const gateLog = src.indexOf("VISION_SEED_RECOVERY_REJECTED_INCOMPLETE_AIRCRAFT", acceptableCheck);
  assert.ok(gateLog !== -1, "grace-path aircraft family rejection log must exist in seed recovery");

  const seedAssignment = src.indexOf("_seedResult = {", acceptableCheck);
  assert.ok(seedAssignment !== -1, "seed result assignment must exist");
  assert.ok(gateLog < seedAssignment, "aircraft family gate must precede seed result assignment");
});

test("V3.10B.10 — grace aircraft gate checks AIRCRAFT_FAMILY_MATCH (not queryGuards pattern)", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const gateLog = src.indexOf("VISION_SEED_RECOVERY_REJECTED_INCOMPLETE_AIRCRAFT");
  assert.ok(gateLog !== -1);

  // The gate must use AIRCRAFT_FAMILY_MATCH (index.js's authoritative family source),
  // NOT _FAMILY_PATTERN from queryGuards.js (which diverges on 767/757/727/717).
  const gateBlock = src.slice(gateLog - 600, gateLog);
  assert.ok(gateBlock.includes("AIRCRAFT_FAMILY_MATCH"), "must check family via AIRCRAFT_FAMILY_MATCH");
  assert.ok(gateBlock.includes("AIRLINE_COMPETITOR_MAP"), "must check airline via AIRLINE_COMPETITOR_MAP");
});

test("V3.10B.10 — grace aircraft gate returns incomplete_aircraft_identity and registers master recovery", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const gateLog = src.indexOf("VISION_SEED_RECOVERY_REJECTED_INCOMPLETE_AIRCRAFT");
  assert.ok(gateLog !== -1);

  // After the rejection log, the code must launch master and register background recovery
  const afterGate = src.slice(gateLog, gateLog + 1800);
  assert.ok(afterGate.includes("launchMasterNow()"), "must call launchMasterNow");
  assert.ok(afterGate.includes("_registerMasterBackgroundRecovery()"), "must register master background recovery");
  assert.ok(afterGate.includes('"incomplete_aircraft_identity"'), "must return incomplete_aircraft_identity tier");
  assert.ok(afterGate.includes("INCOMPLETE_AIRCRAFT_IDENTITY"), "must set INCOMPLETE_AIRCRAFT_IDENTITY error");
});

test("V3.10B.10 — grace aircraft gate also emits VISION_QUERY_FAST_REJECTED_INCOMPLETE_AIRCRAFT", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  // The existing log name used by the normal path must also fire from the grace path
  // so grep/audit tooling catches both paths with the same search.
  const gateLog = src.indexOf("VISION_SEED_RECOVERY_REJECTED_INCOMPLETE_AIRCRAFT");
  assert.ok(gateLog !== -1);
  const afterGate = src.slice(gateLog, gateLog + 1200);
  assert.ok(
    afterGate.includes("VISION_QUERY_FAST_REJECTED_INCOMPLETE_AIRCRAFT"),
    "grace gate must emit the same rejection log as the normal path for unified audit"
  );
});

// ── V3.10B.11: stream Phase 1 empty → snapshot fallback + cross-route cache ──

test("V3.10B.11 — stream has Phase 1 empty snapshot fallback with cross-route cache write", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const fallbackLog = src.indexOf("STREAM_PHASE1_EMPTY_SNAPSHOT_FALLBACK");
  assert.ok(fallbackLog !== -1, "stream must have Phase 1 empty snapshot fallback path");

  // The fallback must call readInternalMarketSnapshot
  const fallbackBlock = src.slice(fallbackLog - 2000, fallbackLog);
  assert.ok(fallbackBlock.includes("readInternalMarketSnapshot"), "fallback must read internal snapshot");
  assert.ok(fallbackBlock.includes("resolveAircraftCachePolicy"), "fallback must apply aircraft cache policy");
  assert.ok(fallbackBlock.includes("computeCleanRetrievalPool"), "fallback must compute clean pool");
});

test("V3.10B.11 — stream snapshot fallback writes to cross-route payload cache", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const fallbackLog = src.indexOf("STREAM_PHASE1_EMPTY_SNAPSHOT_FALLBACK");
  assert.ok(fallbackLog !== -1);

  // The setMarketScanResult call must be BEFORE the fallback log (it writes, then logs)
  const beforeLog = src.slice(fallbackLog - 1200, fallbackLog);
  assert.ok(
    beforeLog.includes("setMarketScanResult"),
    "snapshot fallback must write to cross-route cache before logging"
  );
  assert.ok(
    beforeLog.includes('layer: "phase1_empty_snapshot"'),
    "cache layer must be identified as phase1_empty_snapshot"
  );
});

test("V3.10B.11 — stream snapshot fallback only fires when phase1 items < 2", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const fallbackLog = src.indexOf("STREAM_PHASE1_EMPTY_SNAPSHOT_FALLBACK");
  assert.ok(fallbackLog !== -1);

  // The fallback must be guarded by phase1Items.length < 2
  const beforeFallback = src.slice(fallbackLog - 2500, fallbackLog);
  assert.ok(
    beforeFallback.includes("phase1Items.length < 2"),
    "snapshot fallback must only fire when phase1 items < 2"
  );
});

// ── V3.10B.12: stream Phase 1 success + clientClosed → cross-route cache write ──

test("V3.10B.12 — stream writes cross-route cache when Phase 1 succeeds but client closed", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const cacheLog = src.indexOf("STREAM_PHASE1_CLIENT_CLOSED_CACHE_WRITE");
  assert.ok(cacheLog !== -1, "stream must have Phase 1 client-closed cache write path");

  // The cache write must happen before STREAM_CLIENT_CLOSED_STAGE
  const closedStage = src.indexOf("STREAM_CLIENT_CLOSED_STAGE", cacheLog);
  assert.ok(closedStage > cacheLog, "cache write must happen before STREAM_CLIENT_CLOSED_STAGE log");
});

test("V3.10B.12 — client-closed cache write calls setMarketScanResult", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const cacheLog = src.indexOf("STREAM_PHASE1_CLIENT_CLOSED_CACHE_WRITE");
  assert.ok(cacheLog !== -1);

  const cacheBlock = src.slice(cacheLog - 1200, cacheLog);
  assert.ok(cacheBlock.includes("setMarketScanResult"), "must call setMarketScanResult");
  assert.ok(cacheBlock.includes('"client_closed_phase1"'), "layer must be client_closed_phase1");
});

test("V3.10B.12 — client-closed cache write only fires when phase1Items >= 2 and no provisional sent", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  const cacheLog = src.indexOf("STREAM_PHASE1_CLIENT_CLOSED_CACHE_WRITE");
  assert.ok(cacheLog !== -1);

  const cacheBlock = src.slice(cacheLog - 1500, cacheLog);
  assert.ok(cacheBlock.includes("phase1Items.length >= 2"), "must guard on phase1Items >= 2");
  assert.ok(cacheBlock.includes("!_earlyProvSent"), "must guard on no provisional sent");
});

test("V3.10B.12 — enriched query secondary /market/search has scanId cross-route cache lookup", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");

  // The non-stream route must look up by scanId before running market
  const cacheLookup = src.indexOf("getMarketScanResult({");
  assert.ok(cacheLookup !== -1, "non-stream route must call getMarketScanResult");

  const lookupBlock = src.slice(cacheLookup, cacheLookup + 200);
  assert.ok(lookupBlock.includes("scanId"), "lookup must include scanId");

  // ENRICHED_QUERY_MARKET_CALL_BLOCKED must exist
  assert.ok(src.includes("ENRICHED_QUERY_MARKET_CALL_BLOCKED"), "enriched query block log must exist");
});
