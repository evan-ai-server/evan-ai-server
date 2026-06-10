// src/scanSla.js
// Phase 4H.5 — SLA budget helpers. Pure functions for testability.
// node --test src/scanSla.test.js

export const SCAN_SLA_MS               = 5000;
export const VISION_DEADLINE_MS        = 3300;
export const MARKET_MAX_DEADLINE_MS    = 1700;
export const MARKET_MIN_DEADLINE_MS    = 800;
export const SLA_EXHAUSTED_THRESHOLD   = 800;

/**
 * Given remaining scan SLA budget, compute the market deadline.
 * Returns null if remainingMs is unknown (fall back to MARKET_MAX_DEADLINE_MS).
 */
export function computeMarketDeadlineMs(remainingMs, maxMs = MARKET_MAX_DEADLINE_MS) {
  if (remainingMs === null || remainingMs === undefined) return maxMs;
  return Math.max(MARKET_MIN_DEADLINE_MS, Math.min(remainingMs - 250, maxMs));
}

/**
 * Returns true when the remaining SLA budget is too small to do anything useful.
 */
export function isSlaExhausted(remainingMs) {
  return remainingMs !== null && remainingMs !== undefined && remainingMs <= SLA_EXHAUSTED_THRESHOLD;
}

/**
 * The clean-fail payload emitted when SLA is exhausted before market search starts.
 */
export function buildSlaExhaustedPayload(reason = "scan_sla_exhausted_before_market") {
  return {
    items: [],
    reason,
    displayMode: "rescan_needed",
    trust: "none",
  };
}

/**
 * The clean-fail payload emitted when market first-payload deadline fires.
 */
export function buildMarketTimeoutPayload() {
  return {
    items: [],
    reason: "market_first_payload_timeout",
    displayMode: "rescan_needed",
    trust: "none",
  };
}

/**
 * Returns true when a payload from the server/stream is a clean fail
 * that should never be rendered as result cards.
 */
export function isCleanFailPayload(payload) {
  if (!payload) return false;
  return (
    payload.displayMode === "rescan_needed" ||
    payload.trust === "none" ||
    payload.reason === "market_first_payload_timeout" ||
    payload.reason === "scan_sla_exhausted_before_market" ||
    payload.blocked === "generic_query_post_recovery"
  );
}
