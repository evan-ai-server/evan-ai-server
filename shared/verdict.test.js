// shared/verdict.test.js
// Phase 1 normalization-layer tests.
// Run with: node --test shared/

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVerdict,
  requireVerdict,
  assertVerdict,
  verdictLabel,
  verdictColor,
  enforceVerdictOnPayload,
  verdictForPrompt,
  sanitizePromptContext,
  LEGACY_VERDICT_MAP,
  VERDICTS,
  VerdictLeakError,
} from "./verdict.js";

// ── normalizeVerdict — canonical idempotency ────────────────────────

test("normalizeVerdict is idempotent on canonical values", () => {
  assert.equal(normalizeVerdict("BUY"),  "BUY");
  assert.equal(normalizeVerdict("HOLD"), "HOLD");
  assert.equal(normalizeVerdict("PASS"), "PASS");
});

// ── normalizeVerdict — full legacy fixture ──────────────────────────
// Source-coded: every entry corresponds to a real grep hit.

const LEGACY_FIXTURE = /** @type {const} */ ([
  // swarmOrchestrator / accuracyEngine / payloadRegistry
  ["STRONG_BUY",        "BUY"],
  ["STRONG BUY",        "BUY"],
  ["strong_buy",        "BUY"],
  ["Strong Buy",        "BUY"],
  ["GOOD_DEAL",         "BUY"],
  ["GOOD DEAL",         "BUY"],
  ["good_deal",         "BUY"],
  ["Good Deal",         "BUY"],

  // dealComparator (lowercase emit)
  ["steal",             "BUY"],
  ["STEAL",             "BUY"],
  ["good",              "BUY"],
  ["GOOD",              "BUY"],
  ["fair",              "HOLD"],
  ["FAIR",              "HOLD"],
  ["high",              "PASS"],
  ["HIGH",              "PASS"],
  ["price_trap",        "PASS"],
  ["PRICE TRAP",        "PASS"],

  // truthGuard / discoveryEngine / marketDepthGate / personalAgent
  ["OVERPRICED",        "PASS"],
  ["overpriced",        "PASS"],
  ["RISKY",             "PASS"],
  ["risky",             "PASS"],
  ["INSUFFICIENT DATA", "PASS"],
  ["insufficient_data", "PASS"],

  // dealEngineVerdict
  ["CHECK",             "HOLD"],
  ["check",             "HOLD"],

  // payloadRegistry
  ["WATCH",             "HOLD"],
  ["watch",             "HOLD"],

  // notification alert legacy (cached scans, deep-link payloads)
  ["STEAL_DEAL",         "BUY"],
  ["GREAT_FLIP",         "BUY"],
  ["BUY_WITH_CAUTION",   "HOLD"],
  ["AUTHENTICATE_FIRST", "HOLD"],
  ["great flip",         "BUY"],
  ["buy with caution",   "HOLD"],
]);

test("normalizeVerdict handles every known legacy token", () => {
  for (const [input, expected] of LEGACY_FIXTURE) {
    assert.equal(
      normalizeVerdict(input),
      expected,
      `normalizeVerdict(${JSON.stringify(input)}) → expected ${expected}`
    );
  }
});

test("normalizeVerdict tolerates whitespace and surrounding noise", () => {
  assert.equal(normalizeVerdict("  BUY  "),       "BUY");
  assert.equal(normalizeVerdict("\tHOLD\n"),      "HOLD");
  assert.equal(normalizeVerdict("STRONG   BUY"),  "BUY");
  assert.equal(normalizeVerdict("  strong_buy "), "BUY");
});

test("normalizeVerdict returns null for unknown tokens", () => {
  for (const v of ["xyz", "MAYBE", "DEFER", "????", "BUYISH", "halfpass", "none"]) {
    assert.equal(normalizeVerdict(v), null, `${v} should not resolve`);
  }
});

test("normalizeVerdict returns null for non-string and empty inputs", () => {
  for (const v of [null, undefined, 0, 1, NaN, true, false, {}, [], "", "   ", "\n"]) {
    assert.equal(normalizeVerdict(v), null);
  }
});

test("normalizeVerdict never throws — even on circular structures", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(normalizeVerdict(circular), null);
});

test("normalizeVerdict is idempotent under double application", () => {
  for (const [input] of LEGACY_FIXTURE) {
    const once = normalizeVerdict(input);
    if (once === null) continue;
    assert.equal(normalizeVerdict(once), once, `double-normalize drift on ${input}`);
  }
});

// ── requireVerdict — strict variant ──────────────────────────────────

test("requireVerdict returns canonical for known input", () => {
  assert.equal(requireVerdict("STRONG_BUY"), "BUY");
  assert.equal(requireVerdict("OVERPRICED"), "PASS");
  assert.equal(requireVerdict("BUY"),        "BUY");
});

test("requireVerdict throws VerdictLeakError on unknown tokens", () => {
  assert.throws(() => requireVerdict("xyz"),     VerdictLeakError);
  assert.throws(() => requireVerdict(undefined), VerdictLeakError);
  assert.throws(() => requireVerdict(null),      VerdictLeakError);
});

test("requireVerdict carries source through to the error message", () => {
  try {
    requireVerdict("ZOMBIE", "test/source");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof VerdictLeakError);
    assert.equal(e.source, "test/source");
    assert.match(e.message, /test\/source/);
  }
});

// ── assertVerdict — re-export of contract ───────────────────────────

test("assertVerdict is the same callable as the contract assertCanonicalVerdict", () => {
  assert.equal(assertVerdict("BUY"), "BUY");
  assert.throws(() => assertVerdict("STRONG_BUY"), VerdictLeakError);
});

// ── Presentation helpers ────────────────────────────────────────────

test("verdictLabel returns the canonical label for canonical input", () => {
  assert.equal(verdictLabel("BUY"),  "BUY");
  assert.equal(verdictLabel("HOLD"), "HOLD");
  assert.equal(verdictLabel("PASS"), "PASS");
});

test("verdictColor returns the abstract colour token", () => {
  assert.equal(verdictColor("BUY"),  "green");
  assert.equal(verdictColor("HOLD"), "neutral");
  assert.equal(verdictColor("PASS"), "red");
});

test("verdictLabel and verdictColor refuse legacy strings", () => {
  assert.throws(() => verdictLabel("STRONG_BUY"),  VerdictLeakError);
  assert.throws(() => verdictColor("OVERPRICED"),  VerdictLeakError);
  assert.throws(() => verdictLabel("buy"),         VerdictLeakError);
  assert.throws(() => verdictColor(undefined),     VerdictLeakError);
});

// ── LEGACY_VERDICT_MAP shape ────────────────────────────────────────

test("LEGACY_VERDICT_MAP is frozen and exposes only canonical values", () => {
  assert.equal(Object.isFrozen(LEGACY_VERDICT_MAP), true);
  for (const v of Object.values(LEGACY_VERDICT_MAP)) {
    assert.ok(VERDICTS.includes(v), `map value ${v} is not canonical`);
  }
});

test("LEGACY_VERDICT_MAP covers all three canonical verdicts as targets", () => {
  const targets = new Set(Object.values(LEGACY_VERDICT_MAP));
  for (const v of VERDICTS) {
    assert.ok(targets.has(v), `no legacy alias maps to ${v}`);
  }
});

test("LEGACY_VERDICT_MAP cannot be mutated at runtime (frozen object semantics)", () => {
  // ESM modules run in strict mode — assignment to a frozen property throws.
  assert.throws(() => { LEGACY_VERDICT_MAP["ZOMBIE"] = "BUY"; }, TypeError);
  assert.throws(() => { delete LEGACY_VERDICT_MAP["BUY"]; }, TypeError);
  assert.throws(() => { LEGACY_VERDICT_MAP["BUY"] = "PASS"; }, TypeError);
});

// ── enforceVerdictOnPayload — outbound API boundary ─────────────────

test("enforceVerdictOnPayload returns null for null/undefined input", () => {
  assert.equal(enforceVerdictOnPayload(null,      "test"), null);
  assert.equal(enforceVerdictOnPayload(undefined, "test"), null);
});

test("enforceVerdictOnPayload preserves identity when verdict is already canonical", () => {
  const payload = { verdict: "BUY", confidence: 80 };
  const out = enforceVerdictOnPayload(payload, "test");
  assert.equal(out, payload, "should be the same object reference");
});

test("enforceVerdictOnPayload normalizes legacy verdict in a fresh object", () => {
  const payload = { verdict: "STRONG_BUY", confidence: 80 };
  const out = enforceVerdictOnPayload(payload, "test");
  assert.notEqual(out, payload, "should not mutate the caller's object");
  assert.equal(out.verdict, "BUY");
  assert.equal(out.confidence, 80);
  assert.equal(payload.verdict, "STRONG_BUY", "original payload untouched");
});

test("enforceVerdictOnPayload throws VerdictLeakError on unparseable verdict", () => {
  assert.throws(() => enforceVerdictOnPayload({ verdict: "ZOMBIE" }, "test"), VerdictLeakError);
  assert.throws(() => enforceVerdictOnPayload({ verdict: 42 },       "test"), VerdictLeakError);
});

test("enforceVerdictOnPayload throws when payload has no verdict field", () => {
  assert.throws(() => enforceVerdictOnPayload({ score: 80 }, "test"), VerdictLeakError);
});

test("enforceVerdictOnPayload throws when payload is not an object", () => {
  assert.throws(() => enforceVerdictOnPayload("BUY",  "test"), VerdictLeakError);
  assert.throws(() => enforceVerdictOnPayload(["BUY"], "test"), VerdictLeakError);
});

test("enforceVerdictOnPayload preserves non-verdict fields untouched on normalization", () => {
  const payload = {
    verdict: "good_deal",
    confidence: 75,
    nested: { a: 1 },
    arr: [1, 2, 3],
  };
  const out = enforceVerdictOnPayload(payload, "test");
  assert.equal(out.verdict, "BUY");
  assert.equal(out.nested, payload.nested, "nested object identity preserved");
  assert.equal(out.arr, payload.arr,       "array identity preserved");
});

// ── verdictForPrompt — outbound LLM boundary ────────────────────────

test("verdictForPrompt returns canonical for known input", () => {
  assert.equal(verdictForPrompt("BUY",        "ai/test"), "BUY");
  assert.equal(verdictForPrompt("STRONG_BUY", "ai/test"), "BUY");
  assert.equal(verdictForPrompt("OVERPRICED", "ai/test"), "PASS");
});

test("verdictForPrompt returns null on unparseable input — never throws", () => {
  assert.equal(verdictForPrompt("ZOMBIE",    "ai/test"), null);
  assert.equal(verdictForPrompt(undefined,   "ai/test"), null);
  assert.equal(verdictForPrompt(null,        "ai/test"), null);
  assert.equal(verdictForPrompt({},          "ai/test"), null);
  assert.equal(verdictForPrompt(0,           "ai/test"), null);
});

// ── sanitizePromptContext — Phase 9 prompt-input gate ───────────────

test("sanitizePromptContext: returns empty object for non-objects", () => {
  assert.deepEqual(sanitizePromptContext(null),     { ctx: {}, drifted: [] });
  assert.deepEqual(sanitizePromptContext(undefined), { ctx: {}, drifted: [] });
  assert.deepEqual(sanitizePromptContext("BUY"),     { ctx: {}, drifted: [] });
  assert.deepEqual(sanitizePromptContext([1, 2]),    { ctx: {}, drifted: [] });
});

test("sanitizePromptContext: canonicalizes recoverable legacy verdicts", () => {
  const { ctx, drifted } = sanitizePromptContext({
    itemName: "Supreme box logo",
    verdict:    "STRONG_BUY",
    buyVerdict: "GREAT_FLIP",
    buySignal:  "BUY_WITH_CAUTION",
  });
  assert.equal(ctx.verdict, "BUY");
  assert.equal(ctx.buyVerdict, "BUY");
  assert.equal(ctx.buySignal, "HOLD");
  assert.equal(ctx.itemName, "Supreme box logo");
  assert.equal(drifted.length, 3);
});

test("sanitizePromptContext: nulls out unparseable verdict strings", () => {
  const { ctx, drifted } = sanitizePromptContext({
    verdict:    "ZOMBIE_VERDICT",
    buyVerdict: "??",
  });
  assert.equal(ctx.verdict, null);
  assert.equal(ctx.buyVerdict, null);
  assert.equal(drifted.length, 2);
  assert.equal(drifted[0].canonical, null);
});

test("sanitizePromptContext: leaves canonical fields untouched", () => {
  const before = { verdict: "BUY", buyVerdict: "PASS" };
  const { ctx, drifted } = sanitizePromptContext(before);
  assert.equal(ctx.verdict, "BUY");
  assert.equal(ctx.buyVerdict, "PASS");
  assert.equal(drifted.length, 0);
});

test("sanitizePromptContext: ignores fields that aren't verdict-bearing", () => {
  const { ctx } = sanitizePromptContext({
    verdict: "STRONG_BUY",
    note: "OVERPRICED",          // non-verdict field — must NOT be touched
    label: "GREAT_FLIP",
  });
  assert.equal(ctx.verdict, "BUY");
  assert.equal(ctx.note, "OVERPRICED");
  assert.equal(ctx.label, "GREAT_FLIP");
});

test("sanitizePromptContext: never mutates the input object", () => {
  const input = { verdict: "STRONG_BUY", x: 1 };
  const { ctx } = sanitizePromptContext(input);
  assert.equal(input.verdict, "STRONG_BUY");  // unchanged
  assert.notEqual(ctx, input);
});
