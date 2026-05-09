// shared/verdictTelemetry.js
// =====================================================================
// PHASE 6 — Verdict telemetry & disagreement detection.
//
// One purpose: detect when two verdict surfaces in the same system
// disagree, and emit a structured event a downstream sink can ship to
// analytics, Sentry, Slack, or wherever the team watches for drift.
//
// Trigger sources, per spec:
//   1. server verdict   ≠ client verdict     (network round-trip drift)
//   2. cache verdict    ≠ normalized verdict (storage drift)
//   3. AI prompt input  ≠ canonical verdict  (prompt injection drift)
//
// Plus a fourth we discovered while wiring earlier phases:
//   4. legacy namespace ≠ canonical verdict  (parallel-system drift)
//
// This module ships the event to a sink set by the host (server or
// client). The sink is intentionally injectable — the server pushes
// to its structured logger, the client pushes to RN logging /
// async analytics. Neither is hardcoded here so the module stays
// portable + testable in plain Node.
//
// Hard rules:
//   - Telemetry never throws. A broken sink must not break the user
//     request. Sink failures are swallowed; an emergency fallback
//     console.warn fires so silent telemetry-blackouts are visible.
//   - Events are normalized through the contract — both `expected` and
//     `received` are run through normalizeVerdict before comparison.
//     A "STRONG_BUY" vs "BUY" mismatch resolves to NO disagreement
//     (they're the same canonical value). True drift only fires on
//     real divergence.
// =====================================================================

import { isCanonicalVerdict, normalizeVerdict } from "./verdict.js";

/** @typedef {import("./verdictContract.js").Verdict} Verdict */

/**
 * @typedef {object} VerdictDisagreementEvent
 * @property {"verdict_disagreement"} type
 * @property {"server-vs-client" | "cache-vs-normalized" | "ai-prompt-vs-canonical" | "legacy-vs-canonical"} trigger
 * @property {string} source                      Caller path / boundary identifier.
 * @property {Verdict | null} expected            Canonical verdict considered authoritative.
 * @property {Verdict | null} received            Canonical of the divergent surface.
 * @property {unknown} expectedRaw                Raw value before normalization.
 * @property {unknown} receivedRaw                Raw value before normalization.
 * @property {number} ts                          Wall-clock millis at emission.
 * @property {Record<string, unknown>} [meta]     Additional caller-supplied context.
 */

/** @typedef {(event: VerdictDisagreementEvent) => void} TelemetrySink */

/** @type {TelemetrySink | null} */
let _sink = null;

/**
 * Register the host's telemetry sink. Idempotent. The host (server's
 * structured logger / client's analytics module) calls this once at
 * startup. Calling again replaces the sink — useful in tests.
 *
 * @param {TelemetrySink | null} sink
 */
export function setVerdictTelemetrySink(sink) {
  _sink = typeof sink === "function" ? sink : null;
}

/**
 * Emit a disagreement event. Runs both inputs through normalizeVerdict
 * first; if both resolve to the same canonical Verdict (or both to
 * null), no event fires. This makes the helper safe to call freely at
 * boundaries — only true drift is reported.
 *
 * @param {object} args
 * @param {VerdictDisagreementEvent["trigger"]} args.trigger
 * @param {string} args.source
 * @param {unknown} args.expected      Raw "authoritative" verdict.
 * @param {unknown} args.received      Raw "candidate" verdict.
 * @param {Record<string, unknown>} [args.meta]
 * @returns {boolean} true if an event was emitted.
 */
export function reportVerdictDisagreement({ trigger, source, expected, received, meta }) {
  const expCanonical = normalizeVerdict(expected);
  const recCanonical = normalizeVerdict(received);

  // No drift if both normalize to the same canonical (or both to null).
  if (expCanonical === recCanonical) return false;

  /** @type {VerdictDisagreementEvent} */
  const event = {
    type: "verdict_disagreement",
    trigger,
    source,
    expected:    expCanonical,
    received:    recCanonical,
    expectedRaw: expected,
    receivedRaw: received,
    ts:          Date.now(),
    ...(meta ? { meta } : {}),
  };

  try {
    if (_sink) _sink(event);
    else console.warn("[verdict-telemetry] sink not configured; event:", event);
  } catch (e) {
    // Sink failure must never propagate — a broken telemetry pipeline
    // cannot crash a user request. Emergency console.warn so silent
    // telemetry-blackouts are at least visible.
    // eslint-disable-next-line no-console
    console.warn("[verdict-telemetry] sink threw:", e);
  }
  return true;
}

/**
 * Convenience: cache vs normalized. Fires when a cached scan's stored
 * verdict is NOT in canonical form — regardless of whether normalization
 * eventually succeeds. The premise: storage holding "STRONG_BUY" is
 * itself drift, even though it normalizes to "BUY". We want to find
 * and fix the writer that put non-canonical data in the cache.
 *
 * Bypasses the general helper's same-canonical short-circuit because
 * "stored form" vs "normalized form" is a different question than
 * "two competing verdict surfaces".
 *
 * @param {string} source
 * @param {unknown} cachedVerdict
 * @param {Record<string, unknown>} [meta]
 * @returns {boolean} true if an event was emitted.
 */
export function reportCacheDrift(source, cachedVerdict, meta) {
  // Already canonical — no drift, no event.
  if (isCanonicalVerdict(cachedVerdict)) return false;

  /** @type {VerdictDisagreementEvent} */
  const event = {
    type:        "verdict_disagreement",
    trigger:     "cache-vs-normalized",
    source,
    expected:    normalizeVerdict(cachedVerdict),
    received:    null,
    expectedRaw: normalizeVerdict(cachedVerdict),
    receivedRaw: cachedVerdict,
    ts:          Date.now(),
    ...(meta ? { meta } : {}),
  };
  try {
    if (_sink) _sink(event);
    else console.warn("[verdict-telemetry] sink not configured; event:", event);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[verdict-telemetry] sink threw:", e);
  }
  return true;
}

/**
 * Convenience: server vs client. Used by the frontend after a scan
 * round-trips through the API.
 *
 * @param {string} source
 * @param {unknown} serverVerdict
 * @param {unknown} clientVerdict
 * @param {Record<string, unknown>} [meta]
 */
export function reportServerClientMismatch(source, serverVerdict, clientVerdict, meta) {
  return reportVerdictDisagreement({
    trigger:  "server-vs-client",
    source,
    expected: serverVerdict,
    received: clientVerdict,
    meta,
  });
}

/**
 * Convenience: AI prompt input verdict vs canonical. Used by the
 * server before injecting verdict text into an LLM prompt.
 *
 * @param {string} source
 * @param {unknown} canonicalVerdict
 * @param {unknown} promptVerdictRaw
 * @param {Record<string, unknown>} [meta]
 */
export function reportPromptDrift(source, canonicalVerdict, promptVerdictRaw, meta) {
  return reportVerdictDisagreement({
    trigger:  "ai-prompt-vs-canonical",
    source,
    expected: canonicalVerdict,
    received: promptVerdictRaw,
    meta,
  });
}

/**
 * Inspect the legacy namespace `_trace` from Phase 3 and emit a
 * disagreement event for every legacy system whose normalized form
 * does not match the authoritative canonical verdict.
 *
 * @param {string} source
 * @param {Verdict | null} canonicalVerdict     Authoritative truth.
 * @param {Array<{ system: string, raw: unknown, normalized: Verdict | null }>} legacyTrace
 * @returns {number} Count of events emitted.
 */
export function reportLegacyDrift(source, canonicalVerdict, legacyTrace = []) {
  let count = 0;
  for (const entry of legacyTrace) {
    if (entry.normalized === canonicalVerdict) continue;
    if (reportVerdictDisagreement({
      trigger:  "legacy-vs-canonical",
      source:   `${source}:${entry.system}`,
      expected: canonicalVerdict,
      received: entry.raw,
    })) count++;
  }
  return count;
}

/**
 * Build a clean analytics payload that puts the canonical verdict at
 * the top and demotes legacy values to an optional sub-field. Use at
 * any analytics emit site that previously keyed off legacy strings.
 *
 *   const payload = buildAnalyticsPayload({
 *     verdict: card.buyOrPass.verdict,
 *     legacy:  { buySignal: "STRONG_BUY" },
 *     source:  "scan_complete",
 *   });
 *
 * @param {object} args
 * @param {Verdict} args.verdict            Canonical (asserted by caller).
 * @param {string} args.source              Logical event source.
 * @param {Record<string, unknown>} [args.legacy]   Legacy values to attach (informational).
 * @param {Record<string, unknown>} [args.extra]    Additional event fields.
 * @returns {{ verdict: Verdict, source: string, ts: number, legacy?: Record<string, unknown>, [k: string]: unknown }}
 */
export function buildAnalyticsPayload({ verdict, source, legacy, extra }) {
  const payload = {
    verdict,
    source,
    ts: Date.now(),
    ...(extra ?? {}),
  };
  if (legacy && Object.keys(legacy).length > 0) {
    payload.legacy = legacy;
  }
  return payload;
}
