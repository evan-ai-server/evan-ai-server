// src/trustStateEngine.js
// Phase 4 — Trust State Engine.
//
// Maps computed trust signals to 5 user-facing trust states.
// These states are designed to:
//   - Be unambiguous for UI rendering
//   - Be explainable to end users without technical context
//   - Prepare for "Evan Authenticated" guarantee system (Phase 5)
//   - Drive downstream behavior (listing language, review requirements, affiliate policy)
//
// Trust States (from most to least confident):
//   VERIFIED_CONFIDENT          — strong evidence, low risk, item credible
//   PROBABLE_BUT_VERIFY         — reasonable evidence, some gaps, verify before high-stakes
//   HIGH_RISK_AUTH              — authentication concerns present, proceed with extreme caution
//   MARKET_GOOD_BUT_AUTH_UNCERTAIN — market signal is positive but authenticity not confirmable
//   INSUFFICIENT_EVIDENCE       — not enough data to give a meaningful verdict

// ── State constants ───────────────────────────────────────────────────────────

export const TRUST_STATES = {
  VERIFIED_CONFIDENT:               "VERIFIED_CONFIDENT",
  PROBABLE_BUT_VERIFY:              "PROBABLE_BUT_VERIFY",
  HIGH_RISK_AUTH:                   "HIGH_RISK_AUTH",
  MARKET_GOOD_BUT_AUTH_UNCERTAIN:   "MARKET_GOOD_BUT_AUTH_UNCERTAIN",
  INSUFFICIENT_EVIDENCE:            "INSUFFICIENT_EVIDENCE",
};

// ── State metadata ────────────────────────────────────────────────────────────

export const TRUST_STATE_META = {
  VERIFIED_CONFIDENT: {
    label:        "High Confidence",
    shortLabel:   "Confident",
    userMessage:  "Strong authentication evidence. Evan found multiple markers consistent with a genuine item.",
    guidance:     "You can proceed with higher confidence. Standard due diligence still applies.",
    color:        "green",
    icon:         "shield-check",
    listingAllowed: true,
    affiliateAllowed: true,
    requiresReview: false,
  },
  PROBABLE_BUT_VERIFY: {
    label:        "Probable — Verify",
    shortLabel:   "Verify",
    userMessage:  "Evidence is promising but incomplete. Key markers were not confirmed.",
    guidance:     "Verify 1-2 specific details before completing a high-value purchase.",
    color:        "yellow",
    icon:         "shield-half",
    listingAllowed: true,
    affiliateAllowed: true,
    requiresReview: false,
  },
  HIGH_RISK_AUTH: {
    label:        "Authentication Risk",
    shortLabel:   "High Risk",
    userMessage:  "One or more authentication concerns were detected. This item may not be genuine.",
    guidance:     "Do not purchase without expert authentication. Affiliate links are suppressed.",
    color:        "red",
    icon:         "shield-x",
    listingAllowed: false,
    affiliateAllowed: false,
    requiresReview: true,
  },
  MARKET_GOOD_BUT_AUTH_UNCERTAIN: {
    label:        "Price OK — Auth Unknown",
    shortLabel:   "Auth Unknown",
    userMessage:  "The price looks strong for this item, but Evan could not confirm authenticity.",
    guidance:     "Investigate authenticity independently before buying. The price is good IF it is real.",
    color:        "orange",
    icon:         "shield-question",
    listingAllowed: true,
    affiliateAllowed: false,
    requiresReview: false,
  },
  INSUFFICIENT_EVIDENCE: {
    label:        "Insufficient Evidence",
    shortLabel:   "No Evidence",
    userMessage:  "Evan does not have enough information to assess this item's authenticity.",
    guidance:     "Request more details from the seller or use an authentication service.",
    color:        "gray",
    icon:         "shield-off",
    listingAllowed: true,
    affiliateAllowed: true,
    requiresReview: false,
  },
};

// ── Positive buy signals ──────────────────────────────────────────────────────

const POSITIVE_SIGNALS = new Set(["STRONG BUY", "GREAT FLIP", "GOOD DEAL"]);

// ── Core state computation ────────────────────────────────────────────────────

/**
 * Compute the user-facing trust state from resolved signals.
 *
 * @param {object} opts
 *   trustScore        {number}   — final trust score (0-1) after all adjustments
 *   verdict           {string}   — from authEvidenceModel: LIKELY_AUTHENTIC | LIKELY_COUNTERFEIT | UNCERTAIN | INSUFFICIENT_EVIDENCE
 *   evidenceStrength  {string}   — STRONG | MEDIUM | WEAK | NONE
 *   hasBlockingWarning{boolean}
 *   authScore         {number}   — 0-1 normalized auth quality score
 *   buySignal         {string|null}
 *   category          {string}
 * @returns {string} TRUST_STATES member
 */
export function computeTrustState({
  trustScore        = 0.5,
  verdict           = "UNCERTAIN",
  evidenceStrength  = "WEAK",
  hasBlockingWarning = false,
  authScore         = 0.5,
  buySignal         = null,
  category          = "",
} = {}) {
  // 1. HIGH_RISK_AUTH — any confirmed authentication problem wins immediately
  if (hasBlockingWarning) return TRUST_STATES.HIGH_RISK_AUTH;
  if (verdict === "LIKELY_COUNTERFEIT") return TRUST_STATES.HIGH_RISK_AUTH;

  // 2. INSUFFICIENT_EVIDENCE — no meaningful data at all
  if (evidenceStrength === "NONE" || verdict === "INSUFFICIENT_EVIDENCE") {
    return TRUST_STATES.INSUFFICIENT_EVIDENCE;
  }

  // 3. VERIFIED_CONFIDENT — strong evidence, good trust, clean verdict
  if (
    verdict === "LIKELY_AUTHENTIC" &&
    (evidenceStrength === "STRONG" || evidenceStrength === "MEDIUM") &&
    trustScore >= 0.68 &&
    authScore >= 0.55
  ) {
    return TRUST_STATES.VERIFIED_CONFIDENT;
  }

  // 4. HIGH_RISK_AUTH — weak evidence in fake-prone category with concerning auth score
  const fakeProne = ["sneakers", "handbags", "watches", "luxury"].includes(category);
  if (fakeProne && authScore < 0.35 && evidenceStrength === "WEAK") {
    return TRUST_STATES.HIGH_RISK_AUTH;
  }

  // 5. MARKET_GOOD_BUT_AUTH_UNCERTAIN — signal is positive but evidence can't confirm auth
  if (
    buySignal && POSITIVE_SIGNALS.has(buySignal) &&
    (verdict === "UNCERTAIN" || evidenceStrength === "WEAK")
  ) {
    return TRUST_STATES.MARKET_GOOD_BUT_AUTH_UNCERTAIN;
  }

  // 6. PROBABLE_BUT_VERIFY — decent trust but evidence is incomplete
  if (
    trustScore >= 0.52 &&
    (verdict === "LIKELY_AUTHENTIC" || verdict === "UNCERTAIN") &&
    (evidenceStrength === "STRONG" || evidenceStrength === "MEDIUM")
  ) {
    return TRUST_STATES.PROBABLE_BUT_VERIFY;
  }

  // 7. Safe default
  return TRUST_STATES.INSUFFICIENT_EVIDENCE;
}

/**
 * Get the full metadata object for a trust state.
 */
export function getTrustStateMeta(state) {
  return TRUST_STATE_META[state] || TRUST_STATE_META[TRUST_STATES.INSUFFICIENT_EVIDENCE];
}

/**
 * Whether affiliate links are permitted for a given trust state.
 */
export function isAffiliatePermitted(trustState) {
  return TRUST_STATE_META[trustState]?.affiliateAllowed ?? true;
}

/**
 * Whether listing generation with strong claims is permitted.
 */
export function isListingClaimsPermitted(trustState) {
  return TRUST_STATE_META[trustState]?.listingAllowed ?? true;
}
