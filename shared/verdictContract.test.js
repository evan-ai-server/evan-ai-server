// shared/verdictContract.test.js
// Phase 0 contract tests — these enforce the hard gate behaviour.
// Run with: node --test shared/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERDICTS,
  isCanonicalVerdict,
  assertCanonicalVerdict,
  VerdictLeakError,
} from "./verdictContract.js";

test("VERDICTS exposes exactly BUY, HOLD, PASS", () => {
  assert.deepEqual(VERDICTS, ["BUY", "HOLD", "PASS"]);
});

test("VERDICTS array is frozen — cannot be mutated at runtime", () => {
  assert.equal(Object.isFrozen(VERDICTS), true);
  assert.throws(() => {
    // @ts-expect-error: deliberately attempting illegal mutation
    VERDICTS.push("MAYBE");
  });
});

test("isCanonicalVerdict accepts each canonical value", () => {
  for (const v of ["BUY", "HOLD", "PASS"]) {
    assert.equal(isCanonicalVerdict(v), true, `${v} should be canonical`);
  }
});

test("isCanonicalVerdict rejects legacy verdict tokens", () => {
  const legacyTokens = [
    // Legacy from swarmOrchestrator / accuracyEngine / discoveryEngine
    "STRONG_BUY",
    "GOOD_DEAL",
    "STRONG BUY",
    "GOOD DEAL",
    "OVERPRICED",
    "RISKY",
    "INSUFFICIENT DATA",
    "WATCH",
    // Legacy from dealComparator
    "steal",
    "good_deal",
    "fair",
    "high",
    "price_trap",
    // Legacy from dealEngine
    "CHECK",
    // Cached legacy strings spotted in the prompt
    "GREAT_FLIP",
    "BUY_WITH_CAUTION",
    "AUTHENTICATE_FIRST",
    "STEAL_DEAL",
  ];
  for (const v of legacyTokens) {
    assert.equal(isCanonicalVerdict(v), false, `${v} must not pass the gate`);
  }
});

test("isCanonicalVerdict rejects case- and whitespace-variant inputs", () => {
  const variants = ["buy", "Buy", "bUy", " BUY", "BUY ", "  HOLD", "PASS\n", "pass"];
  for (const v of variants) {
    assert.equal(isCanonicalVerdict(v), false, `${JSON.stringify(v)} must not pass the gate`);
  }
});

test("isCanonicalVerdict rejects non-string and structural inputs", () => {
  const nonStrings = [null, undefined, 0, 1, NaN, true, false, {}, [], { verdict: "BUY" }, ["BUY"]];
  for (const v of nonStrings) {
    assert.equal(isCanonicalVerdict(v), false, `${JSON.stringify(v) ?? String(v)} must not pass the gate`);
  }
});

test("assertCanonicalVerdict returns the input unchanged for canonical values", () => {
  assert.equal(assertCanonicalVerdict("BUY"), "BUY");
  assert.equal(assertCanonicalVerdict("HOLD"), "HOLD");
  assert.equal(assertCanonicalVerdict("PASS"), "PASS");
});

test("assertCanonicalVerdict throws VerdictLeakError on legacy tokens", () => {
  for (const legacy of ["STRONG_BUY", "GOOD_DEAL", "OVERPRICED", "buy", "BUY ", null, undefined, 0]) {
    assert.throws(() => assertCanonicalVerdict(legacy), VerdictLeakError);
  }
});

test("VerdictLeakError preserves the rejected value and source on the instance", () => {
  try {
    assertCanonicalVerdict("STRONG_BUY", "swarmOrchestrator");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof VerdictLeakError, "expected VerdictLeakError");
    assert.equal(e.name, "VerdictLeakError");
    assert.equal(e.received, "STRONG_BUY");
    assert.equal(e.source, "swarmOrchestrator");
    assert.match(e.message, /INVALID VERDICT LEAK DETECTED/);
    assert.match(e.message, /swarmOrchestrator/);
    assert.match(e.message, /STRONG_BUY/);
    assert.match(e.message, /\[BUY, HOLD, PASS\]/);
  }
});

test("VerdictLeakError without source still produces a clear message", () => {
  try {
    assertCanonicalVerdict("buy");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof VerdictLeakError);
    assert.equal(e.source, null);
    assert.match(e.message, /INVALID VERDICT LEAK DETECTED/);
    assert.match(e.message, /\[BUY, HOLD, PASS\]/);
  }
});

test("VerdictLeakError formats null and undefined readably", () => {
  try { assertCanonicalVerdict(null); } catch (e) {
    assert.ok(e instanceof VerdictLeakError);
    assert.match(e.message, /received null/);
  }
  try { assertCanonicalVerdict(undefined); } catch (e) {
    assert.ok(e instanceof VerdictLeakError);
    assert.match(e.message, /received undefined/);
  }
});

test("VerdictLeakError handles structural values without crashing the formatter", () => {
  const circular = {};
  circular.self = circular;
  try {
    assertCanonicalVerdict(circular, "test/circular");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof VerdictLeakError);
    assert.match(e.message, /INVALID VERDICT LEAK DETECTED/);
  }
});

test("VerdictLeakError truncates oversized values so it never balloons logs", () => {
  const huge = "x".repeat(50_000);
  try {
    assertCanonicalVerdict(huge);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof VerdictLeakError);
    assert.ok(e.message.length < 500, `message length ${e.message.length} must stay bounded`);
    assert.match(e.message, /\[truncated\]/);
  }
});
