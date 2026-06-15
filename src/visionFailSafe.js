// Phase V3.4 — model-circuit-open fail-safe (pure, dependency-light, unit-testable).
//
// Background: when the OpenAI model circuit breaker opens, every vision pass
// (query_fast / fast / visual_shape / master) throws `model_circuit_open:*`
// instantly. The consensus path then has no usable query, fabricates a generic
// resale fallback ("used item for sale" → stabilized to "used item for"), the
// quality gate rejects it as `generic_query`, and the endpoint returns a
// `rejected_generic` hard-fail. The client treats that as "result pending" and
// long-polls /api/vision/background-result for 12s before giving up.
//
// This module lets the consensus path detect "every attempted pass was blocked
// by the breaker AND there is no usable query" and return a typed, retryable
// `vision_unavailable` response instead — no fabricated query reaches market,
// and the client is told not to long-poll.
//
// Kept out of index.js so the detection logic can be unit-tested directly and
// can never fabricate identity.

const CIRCUIT_OPEN_CODE = "MODEL_CIRCUIT_OPEN";
const CIRCUIT_OPEN_RE = /model_circuit_open/i;

// Fabricated generic fallbacks that must NEVER count as a usable query nor flow
// into market search. Anchored, so it only matches when the WHOLE query is one
// of these generic phrases — real queries ("nike air max ... product") are safe.
const GENERIC_FALLBACK_RE =
  /^(used item(?: for(?: sale)?)?|item for(?: sale)?|consumer product|general item|unidentified item|product)$/i;

/**
 * True when an error OR a settled pass-result object indicates the model circuit
 * breaker was open. Accepts either a thrown error (.code / .message) or a result
 * object that preserved the failure (circuitOpen / errorCode / errorMessage / error).
 */
export function isModelCircuitOpenError(errorOrResult) {
  if (errorOrResult == null) return false;
  if (typeof errorOrResult !== "object") {
    return CIRCUIT_OPEN_RE.test(String(errorOrResult));
  }
  const o = errorOrResult;
  if (o.circuitOpen === true) return true;
  const code = o.code || o.errorCode;
  if (typeof code === "string" && code.toUpperCase() === CIRCUIT_OPEN_CODE) return true;
  const msg = o.message || o.errorMessage || o.error;
  return typeof msg === "string" && CIRCUIT_OPEN_RE.test(msg);
}

/**
 * True when a query is a real, searchable identity — not empty and not one of the
 * fabricated generic fallbacks. Used as a belt-and-suspenders signal alongside the
 * gate's own generic-query classification.
 */
export function isUsableQuery(query) {
  const q = String(query ?? "").trim();
  if (!q) return false;
  return !GENERIC_FALLBACK_RE.test(q);
}

// internal: did a single pass produce a usable query?
function passHasUsableQuery(result) {
  if (!result || typeof result !== "object") return false;
  const q = result.parsed?.query ?? result.query ?? null;
  return isUsableQuery(q);
}

/**
 * Summarize the four vision passes for the fail-safe decision.
 *
 * A pass is "considered" only when a result object is PRESENT (non-null). A null
 * result means the pass was never attempted / was drained, and must NOT count as
 * a circuit-open vote (otherwise an ordinary single-pass miss could look like a
 * breaker outage).
 *
 * @returns {{
 *   circuitOpen: Record<string, boolean>,
 *   consideredCount: number,
 *   circuitOpenCount: number,
 *   usableQueryCount: number,
 *   anyUsableQuery: boolean,
 *   allCircuitOpen: boolean,
 * }}
 */
export function summarizeVisionPassFailures({ queryFastResult, fastResult, visualResult, masterResult } = {}) {
  const entries = [
    ["query_fast", queryFastResult],
    ["fast", fastResult],
    ["visual_shape", visualResult],
    ["master", masterResult],
  ];

  const circuitOpen = {};
  let consideredCount = 0;
  let circuitOpenCount = 0;
  let usableQueryCount = 0;

  for (const [label, result] of entries) {
    const present = result != null;
    const isOpen = present && isModelCircuitOpenError(result);
    circuitOpen[label] = isOpen;
    if (present) consideredCount += 1;
    if (isOpen) circuitOpenCount += 1;
    if (passHasUsableQuery(result)) usableQueryCount += 1;
  }

  // Strict: every PRESENT pass must be circuit-open and none may carry a usable
  // query. A mixed failure (one circuit-open, one genuine error) falls through to
  // the existing rejected_generic / hard-fail path — we only suppress when we are
  // certain the cause is purely the breaker.
  const allCircuitOpen =
    consideredCount > 0 &&
    circuitOpenCount === consideredCount &&
    usableQueryCount === 0;

  return {
    circuitOpen,
    consideredCount,
    circuitOpenCount,
    usableQueryCount,
    anyUsableQuery: usableQueryCount > 0,
    allCircuitOpen,
  };
}

/**
 * Decide whether to return the typed vision-unavailable response.
 *
 * True only when EVERY attempted pass was circuit-open (failures.allCircuitOpen)
 * AND there is no usable query — where a fabricated generic fallback does not
 * count as usable. `qualityGateReason` is the gate's own classification
 * ("generic_query" | "null_query" | "garbage_query" | "accepted").
 */
export function shouldReturnVisionUnavailable({ query, qualityGateReason, failures } = {}) {
  if (!failures || !failures.allCircuitOpen) return false;
  const gateFailed =
    qualityGateReason === "generic_query" ||
    qualityGateReason === "null_query" ||
    qualityGateReason === "garbage_query";
  return gateFailed || !isUsableQuery(query);
}

/**
 * Build the 200-compatible, explicit vision-unavailable payload. Never invents a
 * query. `retryable` + `noBackgroundPoll` tell the client to show a retry state
 * and skip the 12s background-result long-poll. The extra `ok`/`variants`/
 * `identity`/`visionIdentity` fields mirror the existing soft-failure response so
 * the current frontend stays compatible.
 */
export function buildVisionUnavailablePayload({
  rid = null,
  imageHash = null,
  mode = null,
  reason = "model_circuit_open_all_passes",
} = {}) {
  return {
    ok: true,
    query: null,
    variants: [],
    confidence: 0,
    visionConfidence: 0,
    category: null,
    identity: null,
    visionIdentity: null,
    source: "vision_unavailable",
    visionTier: "model_circuit_open",
    selectedPass: "model_circuit_open",
    visionUnavailable: true,
    retryable: true,
    noBackgroundPoll: true,
    cached: false,
    imageHash: imageHash || null,
    mode: mode || null,
    rid: rid || null,
    reason,
    displayMode: "retry_vision",
  };
}
