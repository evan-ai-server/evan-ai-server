// src/categoryTrustModifiers.js
// Phase 2 — Category Trust Modifiers.
//
// Computes trustScore adjustments based on:
//   - Missing/invalid category attributes (structural penalties)
//   - Authentication risk assessment (from categoryAuthEngine)
//   - Counterfeit memory matches (from counterfeitMemory)
//   - Category-specific confidence floors
//
// Integrates with the existing trustScore pipeline in index.js.
// The returned delta is added to the trustScore BEFORE TruthGuard runs.
//
// Output: {
//   delta              number   — total adjustment (-0.60 to +0.05)
//   penalties          Penalty[]
//   boosts             Boost[]
//   warningCodes       string[]  — machine-readable codes for all active warnings
//   blockingWarnings   string[]  — codes that should block buy signal
//   explanation        string    — human-readable summary
//   shouldBlockBuySignal boolean
// }

import { getDeepCategoryProfile, getConfidenceFloors, isBlockingWarning, hasDeepProfile } from "./categoryProfiles.js";
import { CAT } from "./categoryRegistry.js";

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Compute trust adjustments for a category-deep scan.
 *
 * @param {object} opts
 *   category            {string}  — canonical category
 *   extractionResult    {object}  — from categoryAttributeExtractor
 *   authResult          {object}  — from categoryAuthEngine (may be null for non-deep categories)
 *   counterfeitMatches  {Array}   — from counterfeitMemory
 *   currentTrustScore   {number}  — the trustScore before this adjustment
 *   scannedPrice        {number|null}
 * @returns {TrustModifierResult}
 */
export function computeCategoryTrustAdjustments({
  category           = "",
  extractionResult   = {},
  authResult         = null,
  counterfeitMatches = [],
  currentTrustScore  = 0.5,
  scannedPrice       = null,
} = {}) {
  const profile = getDeepCategoryProfile(category);
  const floors  = getConfidenceFloors(category);
  const penalties = [];
  const boosts    = [];
  let   delta     = 0;

  // Only apply deep penalties for categories that have full profiles
  const isDeep = hasDeepProfile(category);

  // ── 1. Missing critical field penalties ────────────────────────────────────
  const missingCritical = extractionResult.missingCriticalFields || [];
  for (const field of missingCritical) {
    const penaltyKey = `${field}_missing`;
    const penalty    = profile.trustPenalties?.[penaltyKey];
    if (penalty) {
      const p = {
        type:    "missing_critical_field",
        field,
        delta:   penalty,
        reason:  `Critical field '${field}' not identified — cannot complete auth or pricing assessment`,
      };
      penalties.push(p);
      delta += penalty;
    }
  }

  // ── 2. Missing required (non-critical) fields — minor penalty ─────────────
  const missingRequired = extractionResult.missingRequiredFields || [];
  for (const field of missingRequired) {
    if (missingCritical.includes(field)) continue;  // already penalized
    const penalty = -0.02;
    penalties.push({
      type:  "missing_required_field",
      field,
      delta: penalty,
      reason: `Required field '${field}' not present — reduces pricing precision`,
    });
    delta += penalty;
  }

  // ── 3. Low extraction confidence ─────────────────────────────────────────
  const extrConf = extractionResult.extractionConfidence ?? 0.5;
  if (isDeep && extrConf < 0.4) {
    const penalty = -0.08;
    penalties.push({
      type:  "low_extraction_confidence",
      delta: penalty,
      reason: `Attribute extraction confidence ${pct(extrConf)} — identity too uncertain for reliable assessment`,
    });
    delta += penalty;
  } else if (isDeep && extrConf < 0.6) {
    const penalty = -0.04;
    penalties.push({
      type:  "moderate_extraction_confidence",
      delta: penalty,
      reason: `Attribute extraction confidence ${pct(extrConf)} — some identity fields incomplete`,
    });
    delta += penalty;
  }

  // ── 4. Authentication risk penalties ──────────────────────────────────────
  if (authResult) {
    const authPenalty = authResult.trustPenalty || 0;  // already computed in engine
    if (authPenalty < 0) {
      penalties.push({
        type:  "auth_risk",
        delta: authPenalty,
        reason: `Authentication risk ${pct(authResult.authenticityRiskScore)} (${authResult.tier}) — trust penalty applied`,
      });
      delta += authPenalty;
    }

    // Blocking warning compounds penalty
    if (authResult.hasBlockingWarning) {
      const blockingPenalty = -0.10;
      penalties.push({
        type:  "blocking_warning",
        delta: blockingPenalty,
        reason: "One or more blocking authenticity warnings active — buy signal suppressed",
      });
      delta += blockingPenalty;
    }
  }

  // ── 5. Counterfeit memory match penalties ─────────────────────────────────
  if (counterfeitMatches.length > 0) {
    const topMatch = counterfeitMatches[0];
    const cfPenalty = Math.max(-0.30, -0.12 - (topMatch.matchScore * 0.18));
    penalties.push({
      type:    "counterfeit_match",
      matches: counterfeitMatches.length,
      topScore: topMatch.matchScore,
      delta:   round2(cfPenalty),
      reason:  `Matched ${counterfeitMatches.length} known counterfeit pattern(s) — top score ${pct(topMatch.matchScore)}`,
    });
    delta += cfPenalty;
  }

  // ── 6. Small boost for strong extraction ─────────────────────────────────
  if (isDeep && extrConf >= 0.85 && missingCritical.length === 0 && (!authResult || authResult.tier === "low")) {
    const boost = 0.03;
    boosts.push({
      type:  "complete_extraction",
      delta: boost,
      reason: "All critical attributes identified and authentication risk is low",
    });
    delta += boost;
  }

  // ── Cap total delta ───────────────────────────────────────────────────────
  delta = Math.max(-0.60, Math.min(0.05, delta));

  // ── Collect warning codes ─────────────────────────────────────────────────
  const allWarnings     = authResult?.authenticityWarnings || [];
  const warningCodes    = allWarnings.map(w => w.code);
  const blockingCodes   = allWarnings.filter(w => w.blocking).map(w => w.code);

  // ── Should we block the buy signal? ──────────────────────────────────────
  const projectedTrust = currentTrustScore + delta;
  const shouldBlockBuySignal =
    blockingCodes.length > 0 ||
    projectedTrust < floors.minTrustForBuySignal ||
    (authResult?.authenticityRiskScore ?? 0) > floors.maxAuthRiskForGoodDeal;

  // ── Human-readable explanation ────────────────────────────────────────────
  const explanation = buildExplanation(delta, penalties, boosts, authResult, counterfeitMatches);

  return {
    delta:               round2(delta),
    penalties,
    boosts,
    warningCodes,
    blockingWarnings:    blockingCodes,
    explanation,
    shouldBlockBuySignal,
    projectedTrustScore: round2(clamp01(projectedTrust)),
    confidenceFloors:    floors,
  };
}

/**
 * Apply category trust adjustments to an existing trustScore.
 * Returns the clamped adjusted trust score.
 *
 * @param {number} trustScore   — existing trust score (0-1)
 * @param {object} modifiers    — result from computeCategoryTrustAdjustments
 * @returns {number}
 */
export function applyCategoryTrustModifiers(trustScore, modifiers) {
  if (!modifiers) return trustScore;
  return clamp01((trustScore || 0) + (modifiers.delta || 0));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildExplanation(delta, penalties, boosts, authResult, counterfeitMatches) {
  const parts = [];

  if (delta < -0.20) {
    parts.push(`Significant trust reduction (${sign(delta)}) applied`);
  } else if (delta < -0.05) {
    parts.push(`Moderate trust reduction (${sign(delta)}) applied`);
  } else if (delta > 0) {
    parts.push(`Minor trust boost (+${round2(delta)}) applied`);
  } else {
    parts.push("No significant trust adjustment");
  }

  if (penalties.length > 0) {
    const top = penalties.slice(0, 2).map(p => p.reason).join("; ");
    parts.push(`Key penalties: ${top}`);
  }

  if (authResult?.tier === "critical" || authResult?.tier === "high") {
    parts.push(`Auth risk is ${authResult.tier} — verify authenticity before purchase`);
  }

  if (counterfeitMatches.length > 0) {
    parts.push(`${counterfeitMatches.length} counterfeit pattern match(es) found`);
  }

  return parts.join(". ");
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

function sign(v) {
  const n = round2(v);
  return n >= 0 ? `+${n}` : String(n);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
