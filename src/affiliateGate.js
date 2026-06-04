// src/affiliateGate.js
// Phase 4C.1 — Affiliate eligibility gate.
//
// Affiliate links may only attach to a scan the app is genuinely confident in.
// The legacy gate keyed only on profitIntel.buySignal + trustScore, so an
// optimistic legacy "GOOD DEAL" signal could attach an affiliate link even when
// the canonical verdict was HOLD on pricing-signal-only / evidence-limited
// evidence. This module makes the gate respect the canonical verdict and the
// real evidence quality so we never monetize a result we tell the user to hold.
//
// Pure + synchronous; no I/O.

// Canonical buyOrPass verdict that is affiliate-eligible. The canonical set is
// {BUY, HOLD, PASS, SKIP, AVOID}; only BUY is a genuine buy recommendation.
export const AFFILIATE_BUY_VERDICTS = new Set(["BUY"]);

// Evidence tiers too weak to monetize. (verifiedListingCount>0 is also required,
// which already excludes every non-verified tier — this is belt-and-suspenders
// and keeps the named blockers explicit for log/audit clarity.)
export const AFFILIATE_WEAK_EVIDENCE_TIERS = new Set([
  "pricing_signal_only",
  "thin_pricing_signal",
  "estimate_only",
  "no_evidence",
]);

/**
 * Decide whether affiliate links may attach.
 * Returns { eligible: boolean, reason: string|null }.
 *
 * Blocks (in priority order) when:
 *  - trustScore < minTrust
 *  - signal is a weak signal
 *  - canonical verdict is present and not BUY
 *  - evidence tier is a weak tier (e.g. pricing_signal_only)
 *  - verdictStrengthCap === "evidence_limited"
 *  - verifiedListingCount === 0
 *  - canShowStrongLanguage === false
 */
export function evaluateAffiliateEligibility(input = {}) {
  const {
    signal = null,
    trustScore = 0,
    minTrust = 0.45,
    weakSignals = null,
    verdict = null,
    evidenceTier = null,
    verdictStrengthCap = null,
    verifiedListingCount = 0,
    canShowStrongLanguage = null,
  } = input || {};

  if (!(Number(trustScore) >= Number(minTrust))) {
    return { eligible: false, reason: "trust_below_threshold" };
  }
  if (weakSignals && typeof weakSignals.has === "function" && weakSignals.has(signal)) {
    return { eligible: false, reason: "weak_signal" };
  }
  if (verdict != null && !AFFILIATE_BUY_VERDICTS.has(verdict)) {
    return { eligible: false, reason: "verdict_not_buy" };
  }
  if (evidenceTier != null && AFFILIATE_WEAK_EVIDENCE_TIERS.has(evidenceTier)) {
    return { eligible: false, reason: "weak_evidence_tier" };
  }
  if (verdictStrengthCap === "evidence_limited") {
    return { eligible: false, reason: "evidence_limited" };
  }
  if (!(Number(verifiedListingCount) > 0)) {
    return { eligible: false, reason: "no_verified_listings" };
  }
  if (canShowStrongLanguage === false) {
    return { eligible: false, reason: "cannot_show_strong" };
  }
  return { eligible: true, reason: null };
}

/** Convenience wrapper that reads the trust fields off a response payload. */
export function evaluateAffiliateEligibilityForPayload(payload, opts = {}) {
  const cal = payload?.confidenceCalibration || {};
  return evaluateAffiliateEligibility({
    signal:                opts.signal ?? null,
    trustScore:            opts.trustScore ?? 0,
    minTrust:              opts.minTrust ?? 0.45,
    weakSignals:           opts.weakSignals ?? null,
    verdict:               payload?.buyOrPass?.verdict ?? null,
    evidenceTier:          cal.evidenceTier ?? null,
    verdictStrengthCap:    cal.verdictStrengthCap ?? null,
    verifiedListingCount:  cal.evidence?.verifiedListingCount ?? 0,
    canShowStrongLanguage: cal.canShowStrongLanguage ?? null,
  });
}
