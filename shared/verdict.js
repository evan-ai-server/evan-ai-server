// shared/verdict.js
// =====================================================================
// PHASE 1 — Normalization + presentation.
//
// This is the boundary layer. External / legacy / cached / user-input
// data lands here and either becomes a canonical Verdict or null.
// Internal code paths must NEVER reach into this file's lookup map
// directly — they go through the contract (./verdictContract.js).
//
// Pattern at every boundary:
//
//   const v = normalizeVerdict(incoming) ?? assertVerdict(incoming, "src/x");
//   //          ^ best-effort recovery     ^ failure-fast if no mapping
//
// Tolerance rules (only here, never in the contract):
//   - Trim whitespace.
//   - Uppercase.
//   - Replace underscores with spaces.
//   - Collapse multi-space.
//   - Match against LEGACY_VERDICT_MAP. Miss → null.
//
// Hard rules (carried over from contract):
//   - The output of normalizeVerdict is always either a canonical
//     Verdict or null. No partial / mixed / annotated forms.
//   - No regex / substring interpretation outside this file.
//   - Adding a new alias means adding a row to LEGACY_VERDICT_MAP
//     AND a row to the test fixture in verdict.test.js.
// =====================================================================

import {
  assertCanonicalVerdict,
  isCanonicalVerdict,
  VerdictLeakError,
  VERDICTS,
} from "./verdictContract.js";

/** @typedef {import("./verdictContract.js").Verdict} Verdict */

// Re-export the contract surface so callers only need to import this
// file. Internal asserts still use the contract directly.
export { assertCanonicalVerdict, isCanonicalVerdict, VerdictLeakError, VERDICTS };

/**
 * Canonical-form alias. Most callers should use this name; it reads
 * cleaner at boundaries ("assertVerdict") than the contract export.
 *
 * @param {unknown} value
 * @param {string} [source]
 * @returns {Verdict}
 */
export const assertVerdict = assertCanonicalVerdict;

/**
 * Legacy alias → canonical Verdict mapping.
 *
 * Keys are stored in their *normalized lookup form* — uppercase with
 * spaces (no underscores). Inputs are normalized the same way before
 * lookup, so "STRONG_BUY", "strong_buy", "Strong Buy", and " STRONG BUY "
 * all resolve to the same row.
 *
 * Exposed as a frozen plain object (not a Map) because Object.freeze
 * on a Map doesn't actually block .set()/.delete()/.clear() — Maps
 * store data in internal slots, not own properties. ESM strict mode
 * makes property writes on a frozen object throw, so this surface is
 * genuinely immutable at runtime.
 *
 * Coverage by source (greppable):
 *   swarmOrchestrator.js    — STRONG_BUY, GOOD_DEAL
 *   accuracyEngine.js       — STRONG_BUY targets
 *   payloadRegistry.js      — STRONG_BUY, GOOD_DEAL, WATCH, PASS
 *   truthGuard.js           — STRONG BUY, GOOD DEAL, FAIR, OVERPRICED,
 *                             RISKY, INSUFFICIENT DATA
 *   badCallReplay.js        — same as truthGuard
 *   discoveryEngine.js      — OVERPRICED, INSUFFICIENT DATA, RISKY
 *   marketDepthGate.js      — OVERPRICED
 *   personalAgent.js        — RISKY, OVERPRICED
 *   personalDecisionEngine  — OVERPRICED
 *   dealComparator.js       — steal, good, good_deal, fair, high, price_trap
 *   dealEngineVerdict       — CHECK
 *   notification legacy     — STEAL_DEAL, GREAT_FLIP, BUY_WITH_CAUTION,
 *                             AUTHENTICATE_FIRST
 */
const LEGACY_PAIRS = /** @type {ReadonlyArray<readonly [string, Verdict]>} */ ([
  // ── Canonical (idempotent under normalization) ─────────────────────
  ["BUY",  "BUY"],
  ["HOLD", "HOLD"],
  ["PASS", "PASS"],

  // ── Legacy → BUY ───────────────────────────────────────────────────
  ["STRONG BUY",  "BUY"],   // covers STRONG_BUY
  ["GOOD DEAL",   "BUY"],   // covers GOOD_DEAL
  ["STEAL",       "BUY"],   // dealComparator
  ["GOOD",        "BUY"],   // dealComparator (some paths emit bare "good")
  ["STEAL DEAL",  "BUY"],   // notification alert legacy (covers STEAL_DEAL)
  ["GREAT FLIP",  "BUY"],   // notification alert legacy (covers GREAT_FLIP)

  // ── Legacy → HOLD ──────────────────────────────────────────────────
  ["FAIR",              "HOLD"],
  ["WATCH",             "HOLD"],
  ["CHECK",             "HOLD"],   // dealEngineVerdict
  ["BUY WITH CAUTION",  "HOLD"],   // notification alert legacy
  ["AUTHENTICATE FIRST","HOLD"],   // notification alert legacy

  // ── Legacy → PASS ──────────────────────────────────────────────────
  ["OVERPRICED",        "PASS"],
  ["RISKY",             "PASS"],
  ["INSUFFICIENT DATA", "PASS"],
  ["HIGH",              "PASS"],   // dealComparator
  ["PRICE TRAP",        "PASS"],   // covers price_trap
]);

/**
 * Public read-only mapping. Keys are normalized lookup form.
 * @type {Readonly<Record<string, Verdict>>}
 */
export const LEGACY_VERDICT_MAP = Object.freeze(Object.fromEntries(LEGACY_PAIRS));

// Internal lookup table — a Map for O(1) `.get()` semantics. Not
// exported. Created from the same source-of-truth pairs as the public
// frozen object so the two can never drift.
const _legacyLookup = new Map(LEGACY_PAIRS);

/**
 * Normalize messy / legacy / cached input into either a canonical
 * Verdict or null. Never throws. Never returns a non-canonical string.
 *
 *   normalizeVerdict("STRONG_BUY")      // "BUY"
 *   normalizeVerdict("Insufficient Data") // "PASS"
 *   normalizeVerdict("xyz")              // null
 *   normalizeVerdict(undefined)          // null
 *   normalizeVerdict(null)               // null
 *   normalizeVerdict(42)                 // null
 *
 * @param {unknown} value
 * @returns {Verdict | null}
 */
export function normalizeVerdict(value) {
  const key = lookupKey(value);
  if (key === null) return null;
  return _legacyLookup.get(key) ?? null;
}

/**
 * Convenience composition: normalize, and if no mapping exists, throw
 * a VerdictLeakError. Use at boundaries that must produce a Verdict.
 *
 *   const v = requireVerdict(scan.verdict, "scan/api");
 *
 * @param {unknown} value
 * @param {string} [source]
 * @returns {Verdict}
 * @throws {VerdictLeakError}
 */
export function requireVerdict(value, source) {
  const v = normalizeVerdict(value);
  if (v !== null) return v;
  // Re-route through the contract so the caller sees the same
  // "INVALID VERDICT LEAK DETECTED" surface the rest of the system uses.
  return assertCanonicalVerdict(value, source);
}

// ── Presentation helpers ─────────────────────────────────────────────
// These accept ONLY canonical input. They route through the hard gate
// before returning, so a programming error (passing legacy) surfaces
// immediately at the call site rather than producing a wrong colour.

const PRESENTATION = Object.freeze({
  BUY:  Object.freeze({ label: "BUY",  color: "green"   }),
  HOLD: Object.freeze({ label: "HOLD", color: "neutral" }),
  PASS: Object.freeze({ label: "PASS", color: "red"     }),
});

/**
 * @param {Verdict} verdict
 * @returns {string}
 */
export function verdictLabel(verdict) {
  return PRESENTATION[assertCanonicalVerdict(verdict, "verdictLabel")].label;
}

/**
 * Server-side colour token. The frontend mirror in Phase 4 will own
 * the actual hex / RN palette mapping; this is the abstract token
 * the server emits in API responses, prompts, and analytics.
 *
 * @param {Verdict} verdict
 * @returns {"green" | "neutral" | "red"}
 */
export function verdictColor(verdict) {
  return PRESENTATION[assertCanonicalVerdict(verdict, "verdictColor")].color;
}

// ── Boundary helpers ─────────────────────────────────────────────────
// These are designed for the four outbound paths defined by Phase 2:
// API responses, AI prompts, notifications, ML calibration. They each
// have slightly different failure-mode requirements — read the JSDoc.

/**
 * Outbound API / response payload helper.
 *
 * Takes any object that may carry a `.verdict` field and ensures the
 * field is canonical before the payload escapes the server. Behaviour:
 *
 *   - payload null/undefined           → returns null
 *   - payload.verdict canonical        → returns payload unchanged
 *   - payload.verdict legacy alias     → returns NEW payload with
 *                                         verdict normalized to canonical
 *   - payload.verdict unparseable      → throws VerdictLeakError
 *   - payload has no `verdict` field   → throws VerdictLeakError
 *
 * The throw is the spec — at every outbound API boundary, drift must
 * become loud, not silently emit a contradictory state to the client.
 * The Express layer wraps this in try/catch + telemetry (Phase 6).
 *
 * @template {Record<string, unknown>} T
 * @param {T | null | undefined} payload
 * @param {string} source
 * @returns {(T & { verdict: Verdict }) | null}
 * @throws {VerdictLeakError}
 */
export function enforceVerdictOnPayload(payload, source) {
  if (payload == null) return null;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new VerdictLeakError(payload, `${source} (payload not an object)`);
  }
  if (!("verdict" in payload)) {
    throw new VerdictLeakError(undefined, `${source} (no verdict field)`);
  }
  const raw = /** @type {{ verdict: unknown }} */ (payload).verdict;
  const canonical = normalizeVerdict(raw);
  if (canonical === null) {
    throw new VerdictLeakError(raw, source);
  }
  // Identity preservation when the field was already canonical — avoids
  // unnecessary allocation in the hot path.
  if (raw === canonical) {
    return /** @type {T & { verdict: Verdict }} */ (payload);
  }
  return /** @type {T & { verdict: Verdict }} */ ({ ...payload, verdict: canonical });
}

/**
 * Outbound LLM-prompt helper.
 *
 * Used immediately before injecting a verdict string into an LLM
 * prompt. Returns the canonical Verdict if the input parses, or null.
 * Never throws — the caller's expected pattern is:
 *
 *   const v = verdictForPrompt(ctx.buyVerdict, "api/ask");
 *   if (v) lines.push(`AI deal verdict: ${v}`);
 *
 * Rationale: if a cached scan has a malformed verdict, we'd rather
 * omit the line entirely than feed the model a contradictory string
 * like "STRONG_BUY" while the rest of the system says PASS. Telemetry
 * (Phase 6) records the omission so we can hunt down the source.
 *
 * @param {unknown} value
 * @param {string} _source Reserved for Phase 6 telemetry hook.
 * @returns {Verdict | null}
 */
export function verdictForPrompt(value, _source) {
  return normalizeVerdict(value);
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * Convert raw input into the lookup key for LEGACY_VERDICT_MAP.
 * Returns null for non-strings or empty strings — those can never
 * resolve to a verdict.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function lookupKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ");
}
