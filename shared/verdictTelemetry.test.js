// shared/verdictTelemetry.test.js
// Phase 6 telemetry tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportVerdictDisagreement,
  reportCacheDrift,
  reportServerClientMismatch,
  reportPromptDrift,
  reportLegacyDrift,
  buildAnalyticsPayload,
  setVerdictTelemetrySink,
} from "./verdictTelemetry.js";

function captureSink() {
  /** @type {Array<any>} */
  const events = [];
  setVerdictTelemetrySink(e => events.push(e));
  return {
    events,
    reset() { events.length = 0; },
    teardown() { setVerdictTelemetrySink(null); },
  };
}

// ── reportVerdictDisagreement — core path ──────────────────────────

test("reportVerdictDisagreement emits when canonical forms differ", () => {
  const cap = captureSink();
  try {
    const fired = reportVerdictDisagreement({
      trigger:  "server-vs-client",
      source:   "test/round-trip",
      expected: "BUY",
      received: "PASS",
    });
    assert.equal(fired, true);
    assert.equal(cap.events.length, 1);
    const e = cap.events[0];
    assert.equal(e.type, "verdict_disagreement");
    assert.equal(e.trigger, "server-vs-client");
    assert.equal(e.expected, "BUY");
    assert.equal(e.received, "PASS");
    assert.equal(e.expectedRaw, "BUY");
    assert.equal(e.receivedRaw, "PASS");
    assert.ok(typeof e.ts === "number");
  } finally { cap.teardown(); }
});

test("reportVerdictDisagreement does NOT emit when both normalize to same canonical", () => {
  const cap = captureSink();
  try {
    const fired = reportVerdictDisagreement({
      trigger:  "cache-vs-normalized",
      source:   "test",
      expected: "BUY",
      received: "STRONG_BUY",   // normalizes to BUY
    });
    assert.equal(fired, false);
    assert.equal(cap.events.length, 0);
  } finally { cap.teardown(); }
});

test("reportVerdictDisagreement does NOT emit when both normalize to null", () => {
  const cap = captureSink();
  try {
    const fired = reportVerdictDisagreement({
      trigger:  "cache-vs-normalized",
      source:   "test",
      expected: undefined,
      received: "ZOMBIE_VAR_FROM_2024",
    });
    assert.equal(fired, false, "both null → no drift");
    assert.equal(cap.events.length, 0);
  } finally { cap.teardown(); }
});

test("reportVerdictDisagreement attaches optional meta", () => {
  const cap = captureSink();
  try {
    reportVerdictDisagreement({
      trigger:  "server-vs-client",
      source:   "test",
      expected: "BUY",
      received: "PASS",
      meta:     { userId: "u_42", scanId: "s_xyz" },
    });
    assert.deepEqual(cap.events[0].meta, { userId: "u_42", scanId: "s_xyz" });
  } finally { cap.teardown(); }
});

test("reportVerdictDisagreement falls back to console.warn if no sink set", () => {
  setVerdictTelemetrySink(null);
  let warned = false;
  const origWarn = console.warn;
  console.warn = () => { warned = true; };
  try {
    const fired = reportVerdictDisagreement({
      trigger:  "server-vs-client",
      source:   "test",
      expected: "BUY",
      received: "PASS",
    });
    assert.equal(fired, true);
    assert.equal(warned, true, "console.warn should fire as last resort");
  } finally { console.warn = origWarn; }
});

test("reportVerdictDisagreement never throws — sink errors are swallowed", () => {
  const origWarn = console.warn;
  console.warn = () => {};
  setVerdictTelemetrySink(() => { throw new Error("simulated sink failure"); });
  try {
    assert.doesNotThrow(() => reportVerdictDisagreement({
      trigger:  "server-vs-client",
      source:   "test",
      expected: "BUY",
      received: "PASS",
    }));
  } finally {
    setVerdictTelemetrySink(null);
    console.warn = origWarn;
  }
});

// ── reportCacheDrift ────────────────────────────────────────────────

test("reportCacheDrift emits when cached value is not canonical and was normalized", () => {
  const cap = captureSink();
  try {
    const fired = reportCacheDrift("EVAN_LAST_RESULT_V1", "STRONG_BUY");
    assert.equal(fired, true);
    assert.equal(cap.events[0].trigger,    "cache-vs-normalized");
    assert.equal(cap.events[0].expected,   "BUY");
    assert.equal(cap.events[0].receivedRaw, "STRONG_BUY");
  } finally { cap.teardown(); }
});

test("reportCacheDrift is silent when cached value is already canonical", () => {
  const cap = captureSink();
  try {
    const fired = reportCacheDrift("EVAN_LAST_RESULT_V1", "BUY");
    assert.equal(fired, false);
    assert.equal(cap.events.length, 0);
  } finally { cap.teardown(); }
});

// ── reportServerClientMismatch ──────────────────────────────────────

test("reportServerClientMismatch emits with correct trigger label", () => {
  const cap = captureSink();
  try {
    reportServerClientMismatch("scan/round-trip", "PASS", "BUY");
    assert.equal(cap.events[0].trigger, "server-vs-client");
    assert.equal(cap.events[0].expected, "PASS");
    assert.equal(cap.events[0].received, "BUY");
  } finally { cap.teardown(); }
});

// ── reportPromptDrift ───────────────────────────────────────────────

test("reportPromptDrift emits with correct trigger label", () => {
  const cap = captureSink();
  try {
    reportPromptDrift("api/listing/generate", "BUY", "GREAT_FLIP");
    // GREAT_FLIP normalizes to BUY → no drift, should NOT fire.
    assert.equal(cap.events.length, 0);
    // Now a real disagreement:
    reportPromptDrift("api/listing/generate", "BUY", "OVERPRICED");
    assert.equal(cap.events.length, 1);
    assert.equal(cap.events[0].trigger,  "ai-prompt-vs-canonical");
    assert.equal(cap.events[0].expected, "BUY");
    assert.equal(cap.events[0].received, "PASS");
  } finally { cap.teardown(); }
});

// ── reportLegacyDrift ───────────────────────────────────────────────

test("reportLegacyDrift fires once per disagreeing legacy system", () => {
  const cap = captureSink();
  try {
    const trace = [
      { system: "profitIntel.buySignal",          raw: "STRONG BUY", normalized: "BUY" },
      { system: "swarmOrchestrator.buySignal",    raw: "OVERPRICED", normalized: "PASS" },
      { system: "dealComparator.verdict.verdict", raw: "fair",       normalized: "HOLD" },
    ];
    const count = reportLegacyDrift("scan/main-response", "BUY", trace);
    assert.equal(count, 2, "two disagreements");
    assert.equal(cap.events.length, 2);
    assert.deepEqual(cap.events.map(e => e.received), ["PASS", "HOLD"]);
    for (const e of cap.events) {
      assert.equal(e.trigger, "legacy-vs-canonical");
      assert.equal(e.expected, "BUY");
      assert.match(e.source, /^scan\/main-response:/);
    }
  } finally { cap.teardown(); }
});

test("reportLegacyDrift returns 0 when all legacy entries agree with canonical", () => {
  const cap = captureSink();
  try {
    const trace = [
      { system: "profitIntel.buySignal", raw: "STRONG BUY", normalized: "BUY" },
      { system: "swarmOrchestrator",     raw: "GOOD_DEAL",  normalized: "BUY" },
    ];
    const count = reportLegacyDrift("scan/main-response", "BUY", trace);
    assert.equal(count, 0);
    assert.equal(cap.events.length, 0);
  } finally { cap.teardown(); }
});

// ── buildAnalyticsPayload ───────────────────────────────────────────

test("buildAnalyticsPayload puts canonical verdict at the top", () => {
  const p = buildAnalyticsPayload({ verdict: "BUY", source: "scan_complete" });
  assert.equal(p.verdict, "BUY");
  assert.equal(p.source,  "scan_complete");
  assert.ok(typeof p.ts === "number");
  assert.equal("legacy" in p, false, "legacy omitted when not provided");
});

test("buildAnalyticsPayload nests legacy values under .legacy", () => {
  const p = buildAnalyticsPayload({
    verdict: "BUY",
    source:  "scan_complete",
    legacy:  { buySignal: "STRONG_BUY", dealEngineVerdict: "BUY" },
    extra:   { userId: "u_42" },
  });
  assert.equal(p.verdict, "BUY");
  assert.deepEqual(p.legacy, { buySignal: "STRONG_BUY", dealEngineVerdict: "BUY" });
  assert.equal(p.userId, "u_42");
});

test("buildAnalyticsPayload omits empty legacy", () => {
  const p = buildAnalyticsPayload({ verdict: "BUY", source: "x", legacy: {} });
  assert.equal("legacy" in p, false);
});
