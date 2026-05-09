// shared/legacyNamespace.js
// =====================================================================
// PHASE 3 — Legacy isolation.
//
// The Evan AI codebase has multiple parallel "verdict" systems that
// predate the canonical Verdict authority (Phase 0). Per spec, these
// must exist ONLY under a `legacy: { ... }` namespace and must NEVER
// drive UI, emotion, or analytics. The canonical truth is and only is
// `buyOrPass.verdict`.
//
// This module assembles the legacy namespace from a server response
// payload. The frontend (Phase 4/5) should consume `legacy.*` for
// debugging and migration tracing only — never for emotional state.
//
// Known parallel systems isolated here:
//
//   profitIntel.buySignal        — STRONG BUY / GOOD DEAL / FAIR /
//                                   OVERPRICED / RISKY / INSUFFICIENT DATA
//   dealComparator.verdict       — steal / good_deal / fair /
//                                   overpriced / price_trap
//   dealEngineVerdict            — BUY / CHECK / PASS triplet
//   swarmOrchestrator.BUY_SIGNAL — STRONG_BUY / GOOD_DEAL / WATCH /
//                                   ALPHA_CANDIDATE / PASS
//   smartAlertEngine.alertType   — STEAL_DEAL / GOOD_DEAL / etc
//                                   (template selectors; not legacy
//                                    per se but mirrored here for
//                                    completeness so the client can
//                                    inspect the dispatch chain).
//
// Hard rule: the values in this namespace are READ-ONLY references
// for legacy-aware tooling. Anything that needs to make an emotional
// decision must read `responsePayload.buyOrPass.verdict` instead.
// =====================================================================

import { normalizeVerdict } from "./verdict.js";

/**
 * @typedef {object} LegacyNamespace
 * @property {string | null} profitIntelBuySignal
 * @property {string | null} dealQualityVerdict        Internal "steal"/"good_deal"/etc
 * @property {string | null} dealQualityVerdictLabel   "STEAL" / "GOOD DEAL" / etc
 * @property {string | null} dealEngineVerdict         BUY / CHECK / PASS
 * @property {string | null} swarmBuySignal
 * @property {string | null} smartAlertType
 * @property {Array<{ system: string, raw: unknown, normalized: import("./verdictContract.js").Verdict | null }>} _trace
 *           For Phase 6 telemetry: which legacy systems contributed and
 *           how each maps to canonical (or null if no mapping).
 */

/**
 * Build the legacy namespace for a server response. Always returns a
 * frozen object so downstream consumers cannot accidentally mutate.
 *
 * @param {object} payload Full server response payload (or any subset).
 * @returns {Readonly<LegacyNamespace>}
 */
export function assembleLegacyNamespace(payload = {}) {
  const profitIntelBuySignal = stringOrNull(payload?.profitIntel?.buySignal);
  const dealQualityVerdict   = stringOrNull(payload?.dealComparator?.verdict?.verdict);
  const dealQualityLabel     = stringOrNull(payload?.dealComparator?.verdict?.verdictLabel);
  const dealEngineVerdict    = stringOrNull(payload?.dealComparator?.verdict?.dealEngineVerdict);
  const swarmBuySignal       = stringOrNull(payload?.swarmResult?.buySignal ?? payload?.swarm?.buySignal);
  const smartAlertType       = stringOrNull(payload?.smartAlerts?.primaryAlert?.alertType);

  /** @type {LegacyNamespace["_trace"]} */
  const trace = [];
  const push = (system, raw) => {
    if (raw == null) return;
    trace.push({ system, raw, normalized: normalizeVerdict(raw) });
  };
  push("profitIntel.buySignal",          profitIntelBuySignal);
  push("dealComparator.verdict.verdict", dealQualityVerdict);
  push("dealEngineVerdict",              dealEngineVerdict);
  push("swarmOrchestrator.buySignal",    swarmBuySignal);
  push("smartAlertEngine.alertType",     smartAlertType);

  return Object.freeze({
    profitIntelBuySignal,
    dealQualityVerdict,
    dealQualityVerdictLabel: dealQualityLabel,
    dealEngineVerdict,
    swarmBuySignal,
    smartAlertType,
    _trace: Object.freeze(trace.map(Object.freeze)),
  });
}

/** @param {unknown} v */
function stringOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
