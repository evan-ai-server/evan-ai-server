// shared/storedScan.js
// =====================================================================
// PHASE 7 — Persistence normalization.
//
// One job: every scan that is read out of storage MUST come back with a
// canonical verdict, regardless of when it was written or which legacy
// system put it there.
//
// Storage shape (post-Phase-7):
//
//   {
//     ...record fields...,
//     verdict:        "BUY" | "HOLD" | "PASS",   // canonical, mandatory
//     reasonCode:     string | null,             // canonical reason code
//     legacy: {                                  // archived, not authoritative
//       buySignal:               <string>?,
//       primaryAction:           <string>?,
//       profitIntelBuySignal:    <string>?,
//       _origin:                 "schema_v1" | "schema_v2" | "schema_v3"
//     },
//     _schemaVersion: 3
//   }
//
// Hard rules:
//   - The output of normalizeStoredScan ALWAYS satisfies isCanonicalVerdict
//     on `verdict`, OR returns null (record is permanently corrupt).
//   - On every load, callers MUST run scans through this function and
//     rewrite storage when `changed === true`. No legacy strings may
//     survive hydration.
//   - This module is the only place that reads/writes _schemaVersion.
//   - Bumping the schema version means: add a new branch in upgrade()
//     and a new test fixture in storedScan.test.js. Do not silently
//     mutate the existing branches.
// =====================================================================

import {
  isCanonicalVerdict,
  normalizeVerdict,
} from "./verdict.js";
import { reportCacheDrift } from "./verdictTelemetry.js";

/** @typedef {import("./verdictContract.js").Verdict} Verdict */

/**
 * Current schema version. Bumped whenever the on-disk shape changes in
 * a way that requires a one-time upgrade pass on load.
 *
 *   v1 — pre-Phase-0. Held legacy `buySignal` strings only.
 *   v2 — Phase 0/1. Added `verdict` field but didn't rewrite legacy.
 *   v3 — Phase 7. Canonical `verdict` is authoritative; legacy is
 *        archived under `.legacy.*` and is no longer load-bearing.
 *
 * @type {3}
 */
export const STORED_SCAN_SCHEMA_VERSION = 3;

/** @typedef {{ scan: object | null, changed: boolean, legacy: Record<string, unknown>, dropped: boolean }} NormalizedStoredScan */

/**
 * Normalize a stored scan record on load.
 *
 * Behaviour:
 *   - Input null / not-an-object  → returns { scan: null, changed: false, dropped: true }
 *   - Already at schema v3 with canonical verdict
 *                                 → returns { scan, changed: false }
 *   - v1/v2 with recoverable verdict
 *                                 → upgrades to v3, archives legacy strings
 *   - Verdict cannot be recovered → returns { scan: null, changed: true, dropped: true }
 *
 * The caller decides what to do with `dropped`. The recommended pattern
 * for the saved-scans list is to delete the doc; the recommended pattern
 * for the history list is to skip the row.
 *
 * @param {unknown} scan
 * @param {{ source?: string, telemetry?: boolean }} [opts]
 * @returns {NormalizedStoredScan}
 */
export function normalizeStoredScan(scan, opts = {}) {
  const source = typeof opts.source === "string" ? opts.source : "storedScan";
  const telemetry = opts.telemetry !== false;

  if (scan == null || typeof scan !== "object" || Array.isArray(scan)) {
    return { scan: null, changed: false, legacy: {}, dropped: true };
  }

  const record = /** @type {Record<string, unknown>} */ (scan);
  const existingVersion = numberOrNull(record._schemaVersion);
  const existingVerdict = record.verdict;

  // ── Fast path: already canonical at current schema version ────────
  if (
    existingVersion === STORED_SCAN_SCHEMA_VERSION &&
    isCanonicalVerdict(existingVerdict)
  ) {
    return { scan: record, changed: false, legacy: {}, dropped: false };
  }

  // ── Legacy collection ─────────────────────────────────────────────
  // Pull every known legacy verdict surface into one bag. We keep the
  // raw values (not normalized) so that telemetry / migration tooling
  // can reconstruct the writer's intent later.
  const legacy = collectLegacy(record);

  // ── Verdict resolution ────────────────────────────────────────────
  // Try in priority order:
  //   1. existing top-level `verdict` (already normalized in v2)
  //   2. legacy buySignal (the most common writer)
  //   3. profitIntelSnapshot.buySignal
  //   4. primaryAction (last-ditch)
  /** @type {Verdict | null} */
  let canonical =
    normalizeVerdict(existingVerdict) ??
    normalizeVerdict(legacy.buySignal) ??
    normalizeVerdict(legacy.profitIntelBuySignal) ??
    normalizeVerdict(legacy.primaryAction) ??
    null;

  if (canonical === null) {
    // No path to a canonical verdict. Telemetry fires; the doc is dropped.
    if (telemetry) {
      try { reportCacheDrift(`${source}/unrecoverable`, existingVerdict, { legacy }); } catch {}
    }
    return { scan: null, changed: true, legacy, dropped: true };
  }

  // ── Build the upgraded record ─────────────────────────────────────
  const upgraded = upgrade(record, canonical, legacy, existingVersion);

  // Telemetry: fire only when storage actually held non-canonical data.
  // (existingVerdict already canonical at v2 → no event; v1 missing
  // verdict entirely → also no event because there's nothing to drift
  // *from*. This keeps the signal high-quality.)
  if (telemetry && existingVerdict != null && !isCanonicalVerdict(existingVerdict)) {
    try { reportCacheDrift(source, existingVerdict, { upgradedTo: canonical, schemaVersion: existingVersion }); } catch {}
  }

  return { scan: upgraded, changed: true, legacy, dropped: false };
}

/**
 * Convenience: same as normalizeStoredScan but suitable for `.map(...)`
 * chains that want a single `scan | null` out (no metadata).
 *
 * @param {unknown} scan
 * @param {{ source?: string }} [opts]
 * @returns {object | null}
 */
export function hydrateStoredScan(scan, opts = {}) {
  return normalizeStoredScan(scan, opts).scan;
}

/**
 * Cheap predicate — true iff a record is at the current schema version
 * with a canonical verdict. Use to short-circuit rewrite storms.
 *
 * @param {unknown} scan
 * @returns {boolean}
 */
export function isStoredScanFresh(scan) {
  if (scan == null || typeof scan !== "object" || Array.isArray(scan)) return false;
  const record = /** @type {Record<string, unknown>} */ (scan);
  return (
    numberOrNull(record._schemaVersion) === STORED_SCAN_SCHEMA_VERSION &&
    isCanonicalVerdict(record.verdict)
  );
}

/**
 * Build a v3 record from incoming write data. Use this on the WRITE
 * side too so newly-saved scans never carry legacy strings as their
 * authoritative verdict.
 *
 * @param {object} record   The scan body the writer assembled.
 * @param {Verdict} verdict Canonical verdict (caller-asserted).
 * @returns {object}
 */
export function buildFreshStoredScan(record, verdict) {
  if (!isCanonicalVerdict(verdict)) {
    // Writers must pass canonical. This is a programming error, not user input.
    throw new Error(`buildFreshStoredScan: non-canonical verdict ${JSON.stringify(verdict)}`);
  }
  const legacy = collectLegacy(record);
  const cleaned = stripTopLevelLegacyVerdictFields(record);
  return {
    ...cleaned,
    verdict,
    legacy: { ...legacy, _origin: "schema_v3_write" },
    _schemaVersion: STORED_SCAN_SCHEMA_VERSION,
  };
}

// ── Internal ─────────────────────────────────────────────────────────

/**
 * @param {Record<string, unknown>} record
 */
function collectLegacy(record) {
  const profitIntelSnapshot =
    isObject(record.profitIntelSnapshot) ? record.profitIntelSnapshot : null;
  const profitIntel =
    isObject(record.profitIntel) ? record.profitIntel : null;
  const dealComparator =
    isObject(record.dealComparator) ? record.dealComparator : null;
  const dealVerdict =
    isObject(dealComparator?.verdict) ? dealComparator.verdict : null;
  const existingLegacy =
    isObject(record.legacy) ? record.legacy : {};

  /** @type {Record<string, unknown>} */
  const out = {};
  putIfString(out, "buySignal",            record.buySignal);
  putIfString(out, "primaryAction",        record.primaryAction);
  putIfString(out, "profitIntelBuySignal", profitIntelSnapshot?.buySignal ?? profitIntel?.buySignal);
  putIfString(out, "dealQualityVerdict",   dealVerdict?.verdict);
  putIfString(out, "dealEngineVerdict",    dealVerdict?.dealEngineVerdict);

  // Carry forward anything the previous writer already archived under
  // .legacy so we don't lose history on re-normalization.
  for (const [k, v] of Object.entries(existingLegacy)) {
    if (k === "_origin") continue;
    if (out[k] == null && v != null) out[k] = v;
  }

  return out;
}

/**
 * @param {Record<string, unknown>} record
 * @param {Verdict} canonical
 * @param {Record<string, unknown>} legacy
 * @param {number | null} fromVersion
 * @returns {Record<string, unknown>}
 */
function upgrade(record, canonical, legacy, fromVersion) {
  const stripped = stripTopLevelLegacyVerdictFields(record);
  const origin =
    fromVersion === 2 ? "schema_v2_upgrade" :
    fromVersion === 3 ? "schema_v3_repaired" :
    "schema_v1_upgrade";
  return {
    ...stripped,
    verdict: canonical,
    legacy: { ...legacy, _origin: origin },
    _schemaVersion: STORED_SCAN_SCHEMA_VERSION,
  };
}

/**
 * Remove fields that we have explicitly archived under .legacy. We keep
 * `profitIntelSnapshot` because it carries non-verdict data (priceStats,
 * dealStrength) that downstream code still reads.
 *
 * @param {Record<string, unknown>} record
 */
function stripTopLevelLegacyVerdictFields(record) {
  const { buySignal: _bs, primaryAction: _pa, _schemaVersion: _v, legacy: _l, ...rest } = record;
  return rest;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** @param {Record<string, unknown>} obj @param {string} key @param {unknown} value */
function putIfString(obj, key, value) {
  if (typeof value === "string" && value.length > 0) obj[key] = value;
}

/** @param {unknown} v */
function numberOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
