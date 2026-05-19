// src/truthGuardConfig.js
import { normalizeCategory } from "./learningStore.js";
// Truth Guard Configuration — Phase 18 / Phase 19.
//
// All TruthGuard thresholds live here so they can be audited and
// overridden without touching logic code.
//
// Phase 19: supports dynamic adaptive threshold cache (populated by
// adaptiveThresholds.refreshThresholdCache at startup + hourly).
// Adaptive adjustments can only RAISE thresholds, never lower them.

// ── In-memory adaptive cache ──────────────────────────────────────────────────
// Keys: normalised category strings
// Values: { trustBoost: number, reason: string, computedAt: string, stats: {...} }
let _adaptiveCache = {};

/**
 * Replace the adaptive threshold cache.
 * Called by adaptiveThresholds.refreshThresholdCache after reading Redis.
 *
 * @param {object} cache — { [category]: { trustBoost, ... } }
 */
export function setAdaptiveCache(cache) {
  _adaptiveCache = (cache && typeof cache === "object") ? cache : {};
}

export const TRUTH_THRESHOLDS = {
  /** trust < this → force RISKY (last-resort catch, regardless of signal) */
  MIN_TRUST_CRITICAL:   0.30,

  /** trust < this → GOOD DEAL reverts to FAIR (matches buildBuySignal T_GD_TRUST) */
  MIN_TRUST_GOOD_DEAL:  0.45,

  /** trust < this → STRONG BUY blocked (mirrors buildBuySignal T_SB_TRUST) */
  MIN_TRUST_STRONG_BUY: 0.55,

  /** signals that must never carry expectedProfit or affiliate links */
  UNSAFE_SIGNALS: new Set(["RISKY", "INSUFFICIENT DATA", "OVERPRICED"]),

  /** correction rate (corrections/scans) that triggers release gate warn */
  CORRECTION_RATE_WARN:    0.05,   // 5%

  /** correction rate that triggers release gate FAIL */
  CORRECTION_RATE_CRITICAL: 0.15,  // 15%

  /** min scan count before correction rate check is meaningful */
  CORRECTION_RATE_MIN_SCANS: 50,
};

/**
 * Per-category threshold overrides.
 * Allows tighter thresholds for high-replica or volatile categories.
 * Format: { [normalizedCategory]: Partial<typeof TRUTH_THRESHOLDS> }
 *
 * Example:
 *   sneakers: { MIN_TRUST_GOOD_DEAL: 0.52 }  // tighter gate for high-replica category
 */
export const CATEGORY_OVERRIDES = {
  // sneakers: { MIN_TRUST_GOOD_DEAL: 0.52 },
  // watches:  { MIN_TRUST_GOOD_DEAL: 0.52 },
};

/**
 * Get effective thresholds for a category.
 * Merges (in order): global base → static CATEGORY_OVERRIDES → adaptive cache.
 * Adaptive adjustments are capped at MAX_ADAPTIVE_BOOST above the base threshold.
 * Falls back to global TRUTH_THRESHOLDS if no overrides exist.
 *
 * @param {string|null} category
 * @returns {typeof TRUTH_THRESHOLDS}
 */
export function getThresholdsForCategory(category = null) {
  if (!category) return TRUTH_THRESHOLDS;
  const cat = normalizeCategory(category);

  // Layer 1: static category overrides
  const staticOverride = CATEGORY_OVERRIDES[cat];
  const base = staticOverride ? { ...TRUTH_THRESHOLDS, ...staticOverride } : TRUTH_THRESHOLDS;

  // Layer 2: adaptive cache (populated by adaptiveThresholds.refreshThresholdCache)
  const adaptive = _adaptiveCache[cat];
  if (!adaptive?.trustBoost) return base;

  const MAX_BOOST = 0.20; // hard cap: never raise any threshold by more than 0.20
  const boost     = Math.min(Math.max(0, adaptive.trustBoost), MAX_BOOST);
  return {
    ...base,
    MIN_TRUST_CRITICAL:   Math.min(base.MIN_TRUST_CRITICAL   + boost, base.MIN_TRUST_CRITICAL   + MAX_BOOST),
    MIN_TRUST_GOOD_DEAL:  Math.min(base.MIN_TRUST_GOOD_DEAL  + boost, base.MIN_TRUST_GOOD_DEAL  + MAX_BOOST),
    MIN_TRUST_STRONG_BUY: Math.min(base.MIN_TRUST_STRONG_BUY + boost, base.MIN_TRUST_STRONG_BUY + MAX_BOOST),
  };
}
