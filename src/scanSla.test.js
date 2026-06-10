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
