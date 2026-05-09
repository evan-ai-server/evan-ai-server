// shared/verdictContract.js
// =====================================================================
// PHASE 0 — Truth Lock Contract.
//
// Hard runtime gate for the Evan AI canonical decision verdict.
// Defines the only legal verdict values and the only way internal
// code is allowed to assert them.
//
// Boundary normalization lives in ./verdict.js. Internal code paths
// must run any verdict-shaped value through assertCanonicalVerdict().
// If the value is anything other than a canonical Verdict, this
// module throws — loud, immediate, no fallback.
//
// Hard rules (do not relax):
//   - No fallbacks. Unknown input → throw.
//   - No silent coercion. "buy", "Buy", "BUY " all throw.
//   - No legacy values pass this gate. Normalize upstream.
//   - No regex / substring interpretation. The set is closed.
// =====================================================================

/**
 * @typedef {"BUY" | "HOLD" | "PASS"} Verdict
 */

/** @type {ReadonlySet<Verdict>} */
const CANONICAL_VERDICTS = Object.freeze(new Set(["BUY", "HOLD", "PASS"]));

/** @type {readonly Verdict[]} */
export const VERDICTS = Object.freeze(["BUY", "HOLD", "PASS"]);

/**
 * Tests strict equality against the canonical set. No coercion, no
 * trimming, no case-insensitive matching — exact membership only.
 *
 * @param {unknown} value
 * @returns {value is Verdict}
 */
export function isCanonicalVerdict(value) {
  return typeof value === "string" && CANONICAL_VERDICTS.has(/** @type {Verdict} */ (value));
}

/**
 * Hard gate. Returns the value if canonical; otherwise throws
 * VerdictLeakError. Use at every internal boundary that must never
 * see legacy or unnormalized data.
 *
 * @param {unknown} value
 * @param {string} [source] Optional caller hint for the error message
 *                          (e.g. "swarmOrchestrator", "api/scan").
 * @returns {Verdict}
 * @throws {VerdictLeakError}
 */
export function assertCanonicalVerdict(value, source) {
  if (isCanonicalVerdict(value)) return value;
  throw new VerdictLeakError(value, source);
}

/**
 * Error class thrown when a non-canonical verdict reaches an internal
 * gate. Distinct class so telemetry and tests can match it without
 * false positives on generic Error.
 */
export class VerdictLeakError extends Error {
  /**
   * @param {unknown} value
   * @param {string} [source]
   */
  constructor(value, source) {
    const printed = printForError(value);
    const where = source ? ` at "${source}"` : "";
    super(`INVALID VERDICT LEAK DETECTED${where}: received ${printed}, expected one of [BUY, HOLD, PASS].`);
    this.name = "VerdictLeakError";
    /** @type {unknown} */
    this.received = value;
    /** @type {string | null} */
    this.source = source ?? null;
  }
}

const MAX_PRINT = 200;

/** @param {unknown} v */
function printForError(v) {
  let s;
  if (v === null) s = "null";
  else if (v === undefined) s = "undefined";
  else if (typeof v === "string") s = JSON.stringify(v);
  else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") s = String(v);
  else {
    try { s = JSON.stringify(v); }
    catch { s = Object.prototype.toString.call(v); }
  }
  return s.length > MAX_PRINT ? s.slice(0, MAX_PRINT) + "…[truncated]" : s;
}
