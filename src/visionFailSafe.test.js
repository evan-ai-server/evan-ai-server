import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isModelCircuitOpenError,
  isUsableQuery,
  summarizeVisionPassFailures,
  shouldReturnVisionUnavailable,
  buildVisionUnavailablePayload,
} from "./visionFailSafe.js";

// A pass result as runVisionPass returns it when the breaker is open (Phase V3.4
// preserves errorCode/errorMessage/circuitOpen on the failure object).
const circuitOpenPass = (label) => ({
  rawText: "",
  parsed: {},
  error: "vision_pass_failed",
  errorCode: "MODEL_CIRCUIT_OPEN",
  errorMessage: `model_circuit_open:vision_pass:${label}`,
  circuitOpen: true,
  source: "openai",
});

// A pass that timed out / was aborted — NOT a breaker outage.
const timedOutPass = () => ({
  rawText: "",
  parsed: { query: null, confidence: 0 },
  source: "openai",
  cancelled: true,
});

const usablePass = (query) => ({
  rawText: "{}",
  parsed: { query, confidence: 0.9 },
  source: "openai",
});

// ── isModelCircuitOpenError ────────────────────────────────────────────────
test("isModelCircuitOpenError detects thrown errors by code and message", () => {
  assert.equal(isModelCircuitOpenError({ code: "MODEL_CIRCUIT_OPEN" }), true);
  assert.equal(isModelCircuitOpenError({ message: "model_circuit_open:vision_pass:fast" }), true);
  assert.equal(isModelCircuitOpenError("model_circuit_open:vision_pass:master"), true);
  assert.equal(isModelCircuitOpenError({ circuitOpen: true }), true);
});

test("isModelCircuitOpenError detects preserved pass-result markers", () => {
  assert.equal(isModelCircuitOpenError(circuitOpenPass("fast")), true);
  assert.equal(isModelCircuitOpenError({ errorCode: "model_circuit_open" }), true);
});

test("isModelCircuitOpenError is false for non-circuit failures / nullish", () => {
  assert.equal(isModelCircuitOpenError(null), false);
  assert.equal(isModelCircuitOpenError(undefined), false);
  assert.equal(isModelCircuitOpenError(timedOutPass()), false);
  assert.equal(isModelCircuitOpenError({ error: "vision_pass_failed" }), false);
  assert.equal(isModelCircuitOpenError({ code: "ETIMEDOUT" }), false);
  assert.equal(isModelCircuitOpenError("Request was aborted."), false);
});

// ── isUsableQuery ──────────────────────────────────────────────────────────
test("isUsableQuery rejects empty + fabricated generic fallbacks", () => {
  assert.equal(isUsableQuery(null), false);
  assert.equal(isUsableQuery(""), false);
  assert.equal(isUsableQuery("   "), false);
  assert.equal(isUsableQuery("used item for"), false);
  assert.equal(isUsableQuery("used item for sale"), false);
  assert.equal(isUsableQuery("used item"), false);
  assert.equal(isUsableQuery("item for"), false);
  assert.equal(isUsableQuery("consumer product"), false);
  assert.equal(isUsableQuery("Product"), false);
});

test("isUsableQuery accepts a real identity (even containing the word product)", () => {
  assert.equal(isUsableQuery("Hawaiian Airlines Boeing 787 diecast model airplane"), true);
  assert.equal(isUsableQuery("nike air max product line shoes"), true);
});

// ── summarizeVisionPassFailures ────────────────────────────────────────────
test("all four passes circuit-open → allCircuitOpen true, no usable query", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: circuitOpenPass("query_fast"),
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  assert.equal(failures.allCircuitOpen, true);
  assert.equal(failures.consideredCount, 4);
  assert.equal(failures.circuitOpenCount, 4);
  assert.equal(failures.anyUsableQuery, false);
  assert.deepEqual(failures.circuitOpen, {
    query_fast: true, fast: true, visual_shape: true, master: true,
  });
});

test("the live scenario: query_fast not captured (null), fast/master/visual circuit-open", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: null, // not in `passes` in the consensus path
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  // null query_fast is "not considered" — does not block detection
  assert.equal(failures.consideredCount, 3);
  assert.equal(failures.circuitOpenCount, 3);
  assert.equal(failures.allCircuitOpen, true);
});

test("one usable query present → allCircuitOpen false", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: usablePass("Hawaiian Airlines Boeing 787 diecast model airplane"),
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  assert.equal(failures.anyUsableQuery, true);
  assert.equal(failures.allCircuitOpen, false);
});

test("timeout / no-result but NOT circuit-open → not classified as circuit-open", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: timedOutPass(),
    fastResult: timedOutPass(),
    visualResult: timedOutPass(),
    masterResult: timedOutPass(),
  });
  assert.equal(failures.circuitOpenCount, 0);
  assert.equal(failures.allCircuitOpen, false);
  assert.deepEqual(failures.circuitOpen, {
    query_fast: false, fast: false, visual_shape: false, master: false,
  });
});

test("mixed: one circuit-open + one genuine failure → not all circuit-open (conservative)", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: null,
    fastResult: circuitOpenPass("fast"),
    visualResult: { error: "vision_pass_failed", errorCode: "ETIMEDOUT" },
    masterResult: circuitOpenPass("master"),
  });
  assert.equal(failures.consideredCount, 3);
  assert.equal(failures.circuitOpenCount, 2);
  assert.equal(failures.allCircuitOpen, false);
});

test("no passes considered (all null) → allCircuitOpen false", () => {
  const failures = summarizeVisionPassFailures({});
  assert.equal(failures.consideredCount, 0);
  assert.equal(failures.allCircuitOpen, false);
});

// ── shouldReturnVisionUnavailable ──────────────────────────────────────────
test("generic query with all passes circuit-open → suppressed (return unavailable)", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: null,
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  assert.equal(
    shouldReturnVisionUnavailable({ query: "used item for", qualityGateReason: "generic_query", failures }),
    true
  );
});

test("null query with all passes circuit-open → unavailable", () => {
  const failures = summarizeVisionPassFailures({
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  assert.equal(
    shouldReturnVisionUnavailable({ query: null, qualityGateReason: "null_query", failures }),
    true
  );
});

test("usable query present → never unavailable even if gate says accepted", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: usablePass("real query"),
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  assert.equal(
    shouldReturnVisionUnavailable({ query: "real query", qualityGateReason: "accepted", failures }),
    false
  );
});

test("generic query but NOT circuit-open (ordinary miss) → do not classify as unavailable", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: timedOutPass(),
    fastResult: timedOutPass(),
    visualResult: timedOutPass(),
    masterResult: timedOutPass(),
  });
  assert.equal(
    shouldReturnVisionUnavailable({ query: "used item for", qualityGateReason: "generic_query", failures }),
    false
  );
});

// ── buildVisionUnavailablePayload ──────────────────────────────────────────
test("payload is explicit, retryable, no-poll, carries imageHash, invents no query", () => {
  const p = buildVisionUnavailablePayload({
    rid: "rid123",
    imageHash: "abc123hash",
    mode: "item",
    reason: "model_circuit_open_all_passes",
  });
  assert.equal(p.visionUnavailable, true);
  assert.equal(p.retryable, true);
  assert.equal(p.noBackgroundPoll, true);
  assert.equal(p.imageHash, "abc123hash");
  assert.equal(p.query, null);
  assert.equal(p.confidence, 0);
  assert.equal(p.visionConfidence, 0);
  assert.equal(p.category, null);
  assert.equal(p.source, "vision_unavailable");
  assert.equal(p.visionTier, "model_circuit_open");
  assert.equal(p.selectedPass, "model_circuit_open");
  assert.equal(p.displayMode, "retry_vision");
  assert.equal(p.cached, false);
  assert.equal(p.reason, "model_circuit_open_all_passes");
});

test("payload defaults are safe when fields are omitted", () => {
  const p = buildVisionUnavailablePayload({});
  assert.equal(p.imageHash, null);
  assert.equal(p.query, null);
  assert.equal(p.visionUnavailable, true);
  assert.equal(p.reason, "model_circuit_open_all_passes");
});

// ── end-to-end: helper composition matches the live bug ────────────────────
test("end-to-end — live circuit-open scan resolves to the unavailable payload", () => {
  const failures = summarizeVisionPassFailures({
    queryFastResult: null,
    fastResult: circuitOpenPass("fast"),
    visualResult: circuitOpenPass("visual_shape"),
    masterResult: circuitOpenPass("master"),
  });
  const unavailable = shouldReturnVisionUnavailable({
    query: "used item for",
    qualityGateReason: "generic_query",
    failures,
  });
  assert.equal(unavailable, true);
  const payload = buildVisionUnavailablePayload({
    rid: "rid",
    imageHash: "e416271db4af",
    mode: "item",
    reason: "model_circuit_open_all_passes",
  });
  assert.equal(payload.query, null, "no fabricated query reaches market");
  assert.equal(payload.noBackgroundPoll, true, "client must not long-poll");
});
