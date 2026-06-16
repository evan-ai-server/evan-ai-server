import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approximateMarketDecision,
  rescueOracleDecision,
} from "./incompleteAircraftMarketPolicy.js";

// ── approximateMarketDecision ──────────────────────────────────────────────
test("approx: market-ready never needs approximate", () => {
  const r = approximateMarketDecision({ marketReady: true, incompleteAircraft: false, baseApproxAllowed: true });
  assert.deepEqual(r, { allowed: false, blocked: false, reason: "already_market_ready" });
});

test("approx: the live Hawaiian airline-only case is BLOCKED (the V3.7 fix)", () => {
  // "Hawaiian Airlines diecast airplane model" — airline present, no 787.
  // Pre-V3.7 this returned approximateAllowed:true and greenlit the wasteful scan.
  const r = approximateMarketDecision({
    marketReady: false,
    incompleteAircraft: true,
    baseApproxAllowed: true, // isApproximateMarketAllowedQuery said "safe collectible"
  });
  assert.deepEqual(r, { allowed: false, blocked: true, reason: "incomplete_aircraft_identity" });
});

test("approx: non-aircraft safe collectible still gets approximate market", () => {
  // e.g. a vintage collectible with no aircraft identity — incompleteAircraft is
  // always false for non-aircraft, so V3.7 must not regress it.
  const r = approximateMarketDecision({
    marketReady: false,
    incompleteAircraft: false,
    baseApproxAllowed: true,
  });
  assert.deepEqual(r, { allowed: true, blocked: false, reason: "safe_collectible_family_unconfirmed" });
});

test("approx: not-ready + not-incomplete + not-approx-eligible → not allowed (not blocked)", () => {
  const r = approximateMarketDecision({ marketReady: false, incompleteAircraft: false, baseApproxAllowed: false });
  assert.deepEqual(r, { allowed: false, blocked: false, reason: "not_approx_eligible" });
});

test("approx: defaults are safe (no approximate market, nothing blocked)", () => {
  const r = approximateMarketDecision();
  assert.equal(r.allowed, false);
  assert.equal(r.blocked, false);
});

// ── rescueOracleDecision ───────────────────────────────────────────────────
test("rescue: thin pool + incomplete aircraft → BLOCKED (the V3.7 fix)", () => {
  const r = rescueOracleDecision({ itemCount: 0, skipOracle: false, incompleteAircraft: true });
  assert.deepEqual(r, { run: false, blocked: true, reason: "incomplete_aircraft_identity" });
});

test("rescue: thin pool + complete identity → oracle runs", () => {
  const r = rescueOracleDecision({ itemCount: 0, skipOracle: false, incompleteAircraft: false });
  assert.deepEqual(r, { run: true, blocked: false, reason: "ok" });
});

test("rescue: thin pool below 4 still runs for complete identity", () => {
  assert.equal(rescueOracleDecision({ itemCount: 3, incompleteAircraft: false }).run, true);
  assert.equal(rescueOracleDecision({ itemCount: 1, incompleteAircraft: false }).run, true);
});

test("rescue: skipOracle (stream path) never runs and never 'blocks'", () => {
  // The stream passes skipOracle:true to get Phase 1 results without GPT — this is
  // why the stream's in-merge oracle was already safe.
  const r = rescueOracleDecision({ itemCount: 0, skipOracle: true, incompleteAircraft: true });
  assert.deepEqual(r, { run: false, blocked: false, reason: "skip_oracle" });
});

test("rescue: sufficient pool (>= minItems) does not run", () => {
  const r = rescueOracleDecision({ itemCount: 4, skipOracle: false, incompleteAircraft: false });
  assert.deepEqual(r, { run: false, blocked: false, reason: "pool_sufficient" });
  assert.equal(rescueOracleDecision({ itemCount: 9, incompleteAircraft: true }).run, false);
  // sufficient pool wins even for incomplete aircraft — nothing to fabricate
  assert.equal(rescueOracleDecision({ itemCount: 9, incompleteAircraft: true }).blocked, false);
});

test("rescue: custom minItems respected", () => {
  assert.equal(rescueOracleDecision({ itemCount: 5, minItems: 8, incompleteAircraft: false }).run, true);
  assert.equal(rescueOracleDecision({ itemCount: 8, minItems: 8, incompleteAircraft: false }).run, false);
});

// ── end-to-end: the live failure resolves to both gates blocked ────────────
test("end-to-end — live airline-only Hawaiian scan blocks approx market AND rescue oracle", () => {
  const incompleteAircraft = true; // detectIncompleteAircraftIdentityQuery(...).incomplete
  assert.equal(
    approximateMarketDecision({ marketReady: false, incompleteAircraft, baseApproxAllowed: true }).allowed,
    false
  );
  assert.equal(
    rescueOracleDecision({ itemCount: 0, skipOracle: false, incompleteAircraft }).run,
    false
  );
});
