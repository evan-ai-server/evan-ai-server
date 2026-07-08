// src/planGateEngine.test.js
// node --test src/planGateEngine.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { PLANS, FEATURES, isPaidPlan, canAccessFeature } from "./planGateEngine.js";

test("isPaidPlan treats hunter as paid", () => {
  assert.equal(isPaidPlan(PLANS.HUNTER), true);
});

test("isPaidPlan treats pro as paid", () => {
  assert.equal(isPaidPlan(PLANS.PRO), true);
});

test("isPaidPlan treats internal as paid", () => {
  assert.equal(isPaidPlan(PLANS.INTERNAL), true);
});

test("isPaidPlan treats free as not paid", () => {
  assert.equal(isPaidPlan(PLANS.FREE), false);
});

test("hunter can access pro-gated features", () => {
  assert.equal(canAccessFeature("hunter", FEATURES.ARBITRAGE_DETECTION), true);
  assert.equal(canAccessFeature("hunter", FEATURES.FULL_COMP_LIST), true);
  assert.equal(canAccessFeature("hunter", FEATURES.FINANCIAL_IDENTITY), true);
});

test("free is still blocked from paid-gated features (regression)", () => {
  assert.equal(canAccessFeature("free", FEATURES.FULL_COMP_LIST), false);
  assert.equal(canAccessFeature("free", FEATURES.ARBITRAGE_DETECTION), false);
});

test("free retains always-on core features (regression)", () => {
  assert.equal(canAccessFeature("free", FEATURES.CORE_SIGNAL), true);
  assert.equal(canAccessFeature("free", FEATURES.BASIC_PRICE_INTEL), true);
});

test("internal/B2B-gated features remain internal-only, not opened to hunter", () => {
  assert.equal(canAccessFeature("hunter", FEATURES.BATCH_SCAN), false);
  assert.equal(canAccessFeature("hunter", FEATURES.B2B_VALUATION), false);
  assert.equal(canAccessFeature("internal", FEATURES.BATCH_SCAN), true);
});
