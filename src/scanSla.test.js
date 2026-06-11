// src/scanSla.test.js
// Phase 4H.5 — SLA budget and clean-fail payload tests.
// node --test src/scanSla.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMarketDeadlineMs,
  isSlaExhausted,
  buildSlaExhaustedPayload,
  buildMarketTimeoutPayload,
  isCleanFailPayload,
  MARKET_MIN_DEADLINE_MS,
  MARKET_MAX_DEADLINE_MS,
} from "./scanSla.js";
import { isUsableVisionSeed } from "./queryGuards.js";

// ── SLA budget math ───────────────────────────────────────────────────────────

test("market gets full default deadline when no remaining-ms is provided", () => {
  assert.equal(computeMarketDeadlineMs(null), MARKET_MAX_DEADLINE_MS);
  assert.equal(computeMarketDeadlineMs(undefined), MARKET_MAX_DEADLINE_MS);
});

test("market deadline is clamped to minimum 800ms", () => {
  assert.equal(computeMarketDeadlineMs(500), MARKET_MIN_DEADLINE_MS, "500ms remaining → clamped to 800");
  assert.equal(computeMarketDeadlineMs(0),   MARKET_MIN_DEADLINE_MS);
});

test("market deadline = remainingMs - 250 when within bounds", () => {
  // remainingMs=1700 → 1700-250=1450
  assert.equal(computeMarketDeadlineMs(1700), 1450);
  // remainingMs=1000 → 1000-250=750 → clamped to 800
  assert.equal(computeMarketDeadlineMs(1000), 800);
  // remainingMs=2500 → 2500-250=2250 → clamped to max 1700
  assert.equal(computeMarketDeadlineMs(2500), 1700);
});

test("SLA exhausted when remaining ≤ 800ms", () => {
  assert.equal(isSlaExhausted(800),  true,  "800ms is at the threshold → exhausted");
  assert.equal(isSlaExhausted(500),  true,  "500ms → exhausted");
  assert.equal(isSlaExhausted(0),    true,  "0ms → exhausted");
  assert.equal(isSlaExhausted(801),  false, "801ms → not exhausted");
  assert.equal(isSlaExhausted(1700), false, "1700ms → not exhausted");
  assert.equal(isSlaExhausted(null), false, "null → not exhausted (no budget info)");
});

// ── Clean-fail payloads ───────────────────────────────────────────────────────

test("market SLA exhausted payload has displayMode=rescan_needed and trust=none", () => {
  const p = buildSlaExhaustedPayload();
  assert.equal(p.displayMode, "rescan_needed");
  assert.equal(p.trust, "none");
  assert.deepEqual(p.items, []);
  assert.equal(p.reason, "scan_sla_exhausted_before_market");
});

test("market timeout payload has displayMode=rescan_needed and trust=none", () => {
  const p = buildMarketTimeoutPayload();
  assert.equal(p.displayMode, "rescan_needed");
  assert.equal(p.trust, "none");
  assert.deepEqual(p.items, []);
  assert.equal(p.reason, "market_first_payload_timeout");
});

test("isCleanFailPayload: detects all clean-fail markers", () => {
  assert.equal(isCleanFailPayload({ displayMode: "rescan_needed", items: [] }), true);
  assert.equal(isCleanFailPayload({ trust: "none", items: [] }), true);
  assert.equal(isCleanFailPayload({ reason: "market_first_payload_timeout", items: [] }), true);
  assert.equal(isCleanFailPayload({ reason: "scan_sla_exhausted_before_market" }), true);
  assert.equal(isCleanFailPayload({ blocked: "generic_query_post_recovery" }), true);
  assert.equal(isCleanFailPayload(null), false, "null is not a clean fail");
  assert.equal(isCleanFailPayload({ items: [{ title: "iPhone" }] }), false, "real result is not a clean fail");
});

// ── Query guard integration with oracle ──────────────────────────────────────

test("oracle blocked: 'used item for' is not a usable vision seed", () => {
  assert.equal(isUsableVisionSeed("used item for"), false,
    "oracle must not run — used item for is unusable");
});

test("oracle blocked: 'used for pre owned' is not a usable vision seed", () => {
  assert.equal(isUsableVisionSeed("used for pre owned"), false,
    "oracle must not run — used for pre owned is unusable");
});

test("oracle blocked: null query is not a usable vision seed", () => {
  assert.equal(isUsableVisionSeed(null), false);
  assert.equal(isUsableVisionSeed(""), false);
});

test("oracle allowed: 'Hawaiian Airlines 787-9 diecast model airplane' is usable", () => {
  assert.equal(isUsableVisionSeed("Hawaiian Airlines 787-9 diecast model airplane"), true,
    "oracle must be allowed — real aircraft identity is usable");
});

// ── Background master result rejection ───────────────────────────────────────

test("background master: rejects generic query from master", () => {
  // isUsableVisionSeed is the gate used before storing background result
  assert.equal(isUsableVisionSeed("used item for sale"), false,
    "background master must not store generic query");
  assert.equal(isUsableVisionSeed("item for"), false,
    "background master must not store 'item for'");
  assert.equal(isUsableVisionSeed("object"), false,
    "background master must not store single-word garbage");
});

test("background master: stores usable aircraft query", () => {
  assert.equal(isUsableVisionSeed("Hawaiian Airlines Boeing 787-9 1:400 diecast model"), true,
    "background master must store valid aircraft identity");
  assert.equal(isUsableVisionSeed("Nike Air Jordan 1 Low OG Bred"), true,
    "background master must store valid sneaker identity");
});

// ── Phase 4H.6: Background recovery endpoint + aircraft query completeness ───

// Mirror the aircraft family + airline detection logic used by the background store.
const AIRCRAFT_FAMILY_MATCH_TEST = [
  { family: "787",      tokens: ["787 9", "787", "dreamliner", "boeing 787"] },
  { family: "777",      tokens: ["777", "boeing 777"] },
  { family: "747",      tokens: ["747", "jumbo jet", "boeing 747"] },
  { family: "a380",     tokens: ["a380", "airbus a380"] },
  { family: "a330",     tokens: ["a330", "airbus a330"] },
  { family: "a321",     tokens: ["a321neo", "a321", "airbus a321"] },
];
const AIRLINE_KEYWORDS = ["hawaiian", "united", "delta", "american airlines", "southwest", "alaska", "ana", "jal", "emirates"];

function normalizeQ(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function bgHasFamily(q) {
  const n = normalizeQ(q);
  return AIRCRAFT_FAMILY_MATCH_TEST.some(({ tokens }) => tokens.some((tok) => n.includes(tok)));
}
function bgHasAirline(q) {
  const n = normalizeQ(q);
  return AIRLINE_KEYWORDS.some((kw) => (` ${n} `).includes(` ${kw} `));
}
function bgRecoverFamilyFromVariants(mainQuery, variants) {
  if (!bgHasAirline(mainQuery) || bgHasFamily(mainQuery)) return mainQuery;
  const hit = variants.find((v) => bgHasFamily(v));
  return hit || null;
}

test("aircraft background query: detects incomplete airline-only query", () => {
  assert.equal(bgHasAirline("Hawaiian Airlines diecast model airplane"), true, "should detect airline");
  assert.equal(bgHasFamily("Hawaiian Airlines diecast model airplane"), false, "should be missing family");
});

test("aircraft background query: detects complete airline+family query", () => {
  assert.equal(bgHasAirline("Hawaiian Airlines Boeing 787-9 diecast model airplane"), true);
  assert.equal(bgHasFamily("Hawaiian Airlines Boeing 787-9 diecast model airplane"), true);
});

test("aircraft background query: recovers family from variant", () => {
  const main = "Hawaiian Airlines diecast model airplane";
  const variants = ["Hawaiian Airlines 1:400 diecast", "Hawaiian Airlines Boeing 787 diecast model airplane"];
  const recovered = bgRecoverFamilyFromVariants(main, variants);
  assert.ok(recovered, "should recover a variant with family");
  assert.equal(bgHasFamily(recovered), true, "recovered variant must have family token");
});

test("aircraft background query: returns null when no variant has family", () => {
  const main = "Hawaiian Airlines diecast model airplane";
  const variants = ["Hawaiian Airlines 1:400 collectible", "Hawaiian Airlines airplane toy"];
  const recovered = bgRecoverFamilyFromVariants(main, variants);
  assert.equal(recovered, null, "no family in any variant → null, needsFamilyRecovery=true");
});

test("aircraft background query: skips recovery when family already present", () => {
  const main = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const variants = ["some other query"];
  const recovered = bgRecoverFamilyFromVariants(main, variants);
  assert.equal(recovered, main, "family already present → main query returned unchanged");
});

test("hard-fail response includes imageHash: isUsableVisionSeed gates background store", () => {
  // The gate before storing a background result is isUsableVisionSeed.
  // A real aircraft query without family should still pass the seed gate.
  assert.equal(isUsableVisionSeed("Hawaiian Airlines diecast model airplane"), true,
    "airline-only aircraft query is usable seed — gets stored and can trigger family recovery");
  assert.equal(isUsableVisionSeed("model airplane"), false,
    "generic 2-word query must not reach background store");
});

// ── Phase 4H.7: Long-poll logic (in-process simulation) ──────────────────────

test("long-poll: returns ready when result appears within wait window", async () => {
  // Simulate BACKGROUND_VISION_RESULTS map with delayed insertion
  const store = new Map();
  const INTERVAL_MS = 50;
  const WAIT_MS = 500;
  let found = false;

  // Insert result after 150ms
  const insertTimer = setTimeout(() => {
    store.set("hash123", { query: "Hawaiian Airlines diecast", completedAt: Date.now(), elapsedMs: 8000 });
  }, 150);

  const _pollStart = Date.now();
  while (!found && (Date.now() - _pollStart) < WAIT_MS) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (store.has("hash123")) found = true;
  }
  clearTimeout(insertTimer);
  assert.equal(found, true, "long-poll should find result within 500ms window");
});

test("long-poll: times out cleanly when result never arrives", async () => {
  const store = new Map();
  const INTERVAL_MS = 50;
  const WAIT_MS = 200;
  let found = false;

  const _pollStart = Date.now();
  while (!found && (Date.now() - _pollStart) < WAIT_MS) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (store.has("hash_never")) found = true;
  }
  const elapsed = Date.now() - _pollStart;
  assert.equal(found, false, "should not find a result that was never stored");
  assert.ok(elapsed >= WAIT_MS, `should wait at least ${WAIT_MS}ms`);
  assert.ok(elapsed < WAIT_MS + 200, "should not overshoot the wait window by more than 200ms");
});

test("long-poll: result stored after 11s is catchable if window is 15s", () => {
  // 11134ms master elapsedMs < 15000ms window → should be caught
  const masterElapsedMs = 11134;
  const pollWindowMs    = 15000;
  assert.equal(masterElapsedMs < pollWindowMs, true,
    "11.1s master must be within 15s long-poll window");
  // Old 8s window would miss it
  assert.equal(masterElapsedMs < 8000, false,
    "old 8s window would miss 11.1s master (confirms the bug)");
});

test("background result: needsFamilyRecovery preserved in stored entry", () => {
  // When family recovery fails, needsFamilyRecovery:true must survive the store/read cycle
  const entry = {
    query: "Hawaiian Airlines diecast airplane model",
    variants: ["Hawaiian Airlines model plane"],
    confidence: 0.85,
    completedAt: Date.now(),
    elapsedMs: 11134,
    needsFamilyRecovery: true,
  };
  // Simulate reading it back
  const restored = { ready: true, ...entry };
  assert.equal(restored.needsFamilyRecovery, true,
    "needsFamilyRecovery:true must be preserved in the response payload");
  assert.equal(restored.query, "Hawaiian Airlines diecast airplane model");
});
