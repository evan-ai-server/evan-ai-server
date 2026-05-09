// shared/notification.js
// =====================================================================
// PHASE 8 — Notification authority.
//
// Notifications are GENERATED, not assembled. The only inputs that
// shape user-visible copy are:
//
//   - canonical Verdict          ("BUY" | "HOLD" | "PASS")
//   - canonical reason code      (one of REASON_CODES)
//
// Forbidden inputs (rule, not heuristic):
//
//   - dealComparator.verdict.verdict    ("steal", "good_deal", …)
//   - profitIntel.buySignal             ("STRONG BUY", "GREAT_FLIP", …)
//   - smartAlertEngine alertType strings
//   - any raw cached scan string
//
// The contract: every notification this module emits carries
// { verdict, reasonCode, title, body } where verdict drives the
// emotional layer (color, haptics, sound) on the device. Title/body
// strings are derived from a frozen lookup keyed by (verdict, reason)
// — there is NO string interpolation of legacy enums anywhere.
//
// Hard rules:
//   - Title/body NEVER contain "STRONG BUY", "GREAT_FLIP",
//     "BUY_WITH_CAUTION", "AUTHENTICATE_FIRST", or "STEAL_DEAL".
//     (The test suite asserts this with a regex over every output.)
//   - assertNotificationClean() is the gate; downstream callers may
//     run it on any notification before queueing.
//   - Adding a new reasonCode means adding a row in REASON_TEXT and
//     a fixture in notification.test.js. Do not silently extend.
// =====================================================================

import { assertVerdict, isCanonicalVerdict, normalizeVerdict } from "./verdict.js";

/** @typedef {import("./verdictContract.js").Verdict} Verdict */

/**
 * Canonical reason codes. These are the only legal values for
 * `reasonCode` in any notification this system emits. They are
 * intentionally short and abstract — the user-facing text comes from
 * REASON_TEXT below, never from the code itself.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REASON_CODES = Object.freeze({
  // BUY rationales
  PRICE_BELOW_MARKET:        "PRICE_BELOW_MARKET",
  STRONG_RESALE_DEMAND:      "STRONG_RESALE_DEMAND",
  ARBITRAGE_OPPORTUNITY:     "ARBITRAGE_OPPORTUNITY",
  PRICE_DROP_ALERT:          "PRICE_DROP_ALERT",
  BUY_WINDOW_OPEN:           "BUY_WINDOW_OPEN",

  // HOLD rationales
  AUTH_VERIFICATION_NEEDED:  "AUTH_VERIFICATION_NEEDED",
  WAIT_FOR_BETTER_PRICE:     "WAIT_FOR_BETTER_PRICE",
  INSUFFICIENT_CONFIDENCE:   "INSUFFICIENT_CONFIDENCE",
  CONDITION_AMBIGUOUS:       "CONDITION_AMBIGUOUS",
  CHEAPER_ALTERNATIVE:       "CHEAPER_ALTERNATIVE",

  // PASS rationales
  PRICED_ABOVE_MARKET:       "PRICED_ABOVE_MARKET",
  AUTHENTICITY_RISK:         "AUTHENTICITY_RISK",
  CONDITION_PRICE_MISMATCH:  "CONDITION_PRICE_MISMATCH",
  WEAK_RESALE_DEMAND:        "WEAK_RESALE_DEMAND",
  NO_DEAL_FOUND:             "NO_DEAL_FOUND",

  // Verdict-only fallback (no specific reason chosen)
  DEFAULT:                   "DEFAULT",
});

const VALID_REASONS = Object.freeze(new Set(Object.values(REASON_CODES)));

// Per-(verdict, reason) presentation. Strings are user-facing — no
// legacy enums, no internal jargon. These are the only strings that
// can appear in a notification title/body.
//
// Each entry MUST be consistent with the verdict's emotional polarity:
//   BUY  — green / positive
//   HOLD — neutral / cautious
//   PASS — red / discouraging
const PRESENTATION = freezeDeep({
  BUY: {
    [REASON_CODES.PRICE_BELOW_MARKET]:    { title: "Below-market price",     body: "This price beats the typical market rate." },
    [REASON_CODES.STRONG_RESALE_DEMAND]:  { title: "Strong resale demand",   body: "Demand is hot and supply is tight." },
    [REASON_CODES.ARBITRAGE_OPPORTUNITY]: { title: "Cross-market upside",    body: "Same item sells higher elsewhere." },
    [REASON_CODES.PRICE_DROP_ALERT]:      { title: "Price drop",             body: "Your watched item just dropped in price." },
    [REASON_CODES.BUY_WINDOW_OPEN]:       { title: "Buy window open",        body: "Seasonally favorable price right now." },
    [REASON_CODES.DEFAULT]:               { title: "Buy",                    body: "Signals support this purchase." },
  },
  HOLD: {
    [REASON_CODES.AUTH_VERIFICATION_NEEDED]: { title: "Verify authenticity first", body: "Worth checking authenticity before you commit." },
    [REASON_CODES.WAIT_FOR_BETTER_PRICE]:    { title: "Wait for a better price",   body: "Price is fair but better windows are likely." },
    [REASON_CODES.INSUFFICIENT_CONFIDENCE]:  { title: "More signal needed",        body: "Not enough comps to lock the call yet." },
    [REASON_CODES.CONDITION_AMBIGUOUS]:      { title: "Condition unclear",         body: "The item's condition needs a closer look." },
    [REASON_CODES.CHEAPER_ALTERNATIVE]:      { title: "Cheaper option exists",     body: "A comparable alternative is priced lower." },
    [REASON_CODES.DEFAULT]:                  { title: "Hold",                      body: "Wait for clearer signals." },
  },
  PASS: {
    [REASON_CODES.PRICED_ABOVE_MARKET]:      { title: "Priced above market",       body: "This is over the typical market rate." },
    [REASON_CODES.AUTHENTICITY_RISK]:        { title: "Authenticity risk",         body: "Signals point to elevated authenticity risk." },
    [REASON_CODES.CONDITION_PRICE_MISMATCH]: { title: "Condition / price mismatch",body: "Asking price doesn't match the condition." },
    [REASON_CODES.WEAK_RESALE_DEMAND]:       { title: "Weak resale demand",        body: "Demand for this item is soft right now." },
    [REASON_CODES.NO_DEAL_FOUND]:            { title: "No deal found",             body: "Couldn't find a clear deal on this scan." },
    [REASON_CODES.DEFAULT]:                  { title: "Pass",                      body: "Signals don't support this purchase." },
  },
});

// Anything in this set, if it appears anywhere in a generated title or
// body, is a regression. The test suite enforces it exhaustively, but
// runtime callers can also assert via assertNotificationClean.
const FORBIDDEN_LEGACY_PHRASES = Object.freeze([
  "STRONG_BUY", "STRONG BUY",
  "GOOD_DEAL", "GREAT_FLIP",
  "STEAL_DEAL", "STEAL DEAL",
  "BUY_WITH_CAUTION", "BUY WITH CAUTION",
  "AUTHENTICATE_FIRST", "AUTHENTICATE FIRST",
  "PRICE_TRAP",
  "INSUFFICIENT_DATA",
  "OVERPRICED",  // legacy enum — say "above market" instead
]);

const FORBIDDEN_RX = new RegExp(
  FORBIDDEN_LEGACY_PHRASES
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "i"
);

/**
 * @typedef {object} CleanNotification
 * @property {Verdict} verdict
 * @property {string}  reasonCode    A REASON_CODES value.
 * @property {string}  title
 * @property {string}  body
 * @property {string}  source        Caller path / dispatch site identifier.
 * @property {Record<string, unknown>} data
 * @property {number}  ts
 */

/**
 * Build a clean notification from canonical inputs only.
 *
 * @param {object} args
 * @param {unknown} args.verdict       Will be asserted canonical (throws on legacy).
 * @param {unknown} [args.reasonCode]  Optional REASON_CODES value; falls back to DEFAULT.
 * @param {string}  [args.source]      Caller path (e.g. "price_drop", "scan_complete").
 * @param {Record<string, unknown>} [args.data]   Side data (URLs, prices, etc).
 *                                                 Must NOT contain legacy strings.
 * @returns {CleanNotification}
 */
export function buildNotificationFromVerdict({ verdict, reasonCode, source, data }) {
  const v = assertVerdict(verdict, `notification:${source ?? "unknown"}`);
  const code = pickReason(reasonCode, v);
  const tpl  = PRESENTATION[v][code] ?? PRESENTATION[v][REASON_CODES.DEFAULT];

  const note = {
    verdict: v,
    reasonCode: code,
    title: tpl.title,
    body:  tpl.body,
    source: typeof source === "string" && source.length > 0 ? source : "default",
    data: sanitizeData(data),
    ts: Date.now(),
  };

  // Self-check: this should never trip given the frozen lookup, but if
  // someone introduces a contaminated template at review time, the gate
  // catches it before the notification ships.
  assertNotificationClean(note);
  return note;
}

/**
 * Compatibility shim for callers that have a record-shaped object on
 * hand. Pulls verdict + reasonCode safely and routes through the
 * canonical builder. Throws if no canonical verdict can be resolved —
 * we'd rather suppress a notification than ship one with a missing
 * verdict to the device.
 *
 * @param {object} args
 * @param {object} args.record           A scan / payload-shaped object.
 * @param {string} [args.source]
 * @param {Record<string, unknown>} [args.data]
 * @param {string} [args.reasonCode]    Override; otherwise derived from record.
 * @returns {CleanNotification | null}
 */
export function buildNotification({ record, source, data, reasonCode }) {
  const candidate =
    record?.verdict ??
    record?.buyOrPass?.verdict ??
    record?.buySignal ??
    record?.profitIntel?.buySignal ??
    null;
  const v = normalizeVerdict(candidate);
  if (!v) return null;

  const code = reasonCode ?? record?.reasonCode ?? record?.buyOrPass?.reasonCode ?? null;
  return buildNotificationFromVerdict({ verdict: v, reasonCode: code, source, data });
}

/**
 * Hard gate. Throws if any forbidden legacy phrase appears in the
 * title or body of a built notification. Use at dispatch sites that
 * accept notifications from outside this module.
 *
 * @param {{ title?: unknown, body?: unknown }} note
 * @returns {void}
 */
export function assertNotificationClean(note) {
  const title = typeof note?.title === "string" ? note.title : "";
  const body  = typeof note?.body  === "string" ? note.body  : "";
  if (FORBIDDEN_RX.test(title) || FORBIDDEN_RX.test(body)) {
    throw new Error(
      `[notification] forbidden legacy phrase in payload — title=${JSON.stringify(title)}, body=${JSON.stringify(body)}`
    );
  }
}

/**
 * @param {unknown} reason
 * @param {Verdict} verdict
 * @returns {string}
 */
function pickReason(reason, verdict) {
  if (typeof reason !== "string" || reason.length === 0) return REASON_CODES.DEFAULT;
  if (!VALID_REASONS.has(reason)) return REASON_CODES.DEFAULT;
  // Reject reasons that don't have a presentation entry for this verdict.
  if (!PRESENTATION[verdict][reason]) return REASON_CODES.DEFAULT;
  return reason;
}

/**
 * Strip any string fields whose value matches a forbidden legacy
 * phrase. Numbers / nested objects pass through untouched. We don't
 * deep-mutate — corrupted data should be archived to .legacy at the
 * persistence layer (Phase 7), not propagated to notifications.
 *
 * @param {unknown} data
 * @returns {Record<string, unknown>}
 */
function sanitizeData(data) {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (data))) {
    if (typeof v === "string" && FORBIDDEN_RX.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** @template T @param {T} obj @returns {Readonly<T>} */
function freezeDeep(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  for (const v of Object.values(obj)) freezeDeep(v);
  return Object.freeze(obj);
}

/**
 * @param {unknown} value
 * @returns {value is Verdict}
 */
export function isCanonicalVerdictForNotification(value) {
  return isCanonicalVerdict(value);
}
