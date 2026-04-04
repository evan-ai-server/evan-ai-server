// src/highStakesDowngradeRules.js
// Phase 4 — High-Stakes Downgrade Rules.
//
// A second safety net that runs AFTER Phase 2 trust adjustments and Phase 4
// auth evidence model. These are HARD RULES — they do not score or blend.
// They either fire or they don't, and when they fire, the action is applied.
//
// Why this is separate from Phase 2 signal downgrade:
//   Phase 2 downgrades based on trust modifiers and blocking warning codes.
//   Phase 4 rules operate on the assembled state (trust + auth evidence + price)
//   and can catch failure modes that Phase 2 cannot see in isolation.
//
// Rules run sequentially. Multiple rules can fire — each applies its action.
// Actions are non-destructive rewrites (cap, force, strip, flag, penalty).
//
// Non-negotiable principles:
//   1. Never hallucinate certainty — weak evidence must reduce, not increase, confidence
//   2. Affiliate links must not coexist with LIKELY_COUNTERFEIT or review-required state
//   3. STRONG BUY must not coexist with INSUFFICIENT_EVIDENCE
//   4. Expensive items + weak auth must be downgraded, not ignored
//   5. Multiple blocking warnings compound — do not treat them independently

// ── Signal order (strongest to weakest) ──────────────────────────────────────

const SIGNAL_ORDER = [
  "STRONG BUY",
  "GREAT FLIP",
  "GOOD DEAL",
  "FAIR",
  "RISKY",
  "OVERPRICED",
  "INSUFFICIENT DATA",
];

const SIGNAL_RANK = Object.fromEntries(SIGNAL_ORDER.map((s, i) => [s, i]));

/** Cap current signal to at most maxSignal. Lower rank = stronger signal. */
function capSignal(current, maxSignal) {
  const curRank = SIGNAL_RANK[current] ?? 6;
  const capRank = SIGNAL_RANK[maxSignal] ?? 6;
  return curRank <= capRank ? maxSignal : current; // keep current if already weaker/equal
}

// ── Fake-prone categories ─────────────────────────────────────────────────────

const FAKE_PRONE = new Set(["sneakers", "handbags", "watches", "luxury"]);

// ── Rule definitions ──────────────────────────────────────────────────────────

const RULES = [
  // HSR-01: Confirmed counterfeit — force RISKY regardless
  {
    id:          "HSR-01",
    description: "Counterfeit verdict → force RISKY",
    condition: ({ authEvidence }) =>
      authEvidence.verdict === "LIKELY_COUNTERFEIT",
    action: { type: "force_signal", signal: "RISKY", capReason: "likely_counterfeit" },
    trustAdjust: -0.20,
    warning: { code: "HSR_LIKELY_COUNTERFEIT", severity: "CRITICAL", blocking: true,
               message: "Authentication evidence indicates likely counterfeit. Purchase not recommended." },
  },

  // HSR-02: Multiple blocking negative signals — force RISKY
  {
    id:          "HSR-02",
    description: "Multiple blocking authentication warnings → force RISKY",
    condition: ({ authEvidence }) =>
      authEvidence.negativeSignals.filter(s => s.blocking).length >= 2,
    action: { type: "force_signal", signal: "RISKY", capReason: "multiple_blocking_warnings" },
    trustAdjust: -0.15,
    warning: { code: "HSR_MULTIPLE_BLOCKING", severity: "CRITICAL", blocking: true,
               message: "Multiple authentication red flags detected. This item poses significant risk." },
  },

  // HSR-03: Affiliate + review recommended → strip affiliate
  {
    id:          "HSR-03",
    description: "Affiliate links suppressed when review recommended",
    condition: ({ authEvidence, payload }) =>
      authEvidence.reviewRecommended &&
      (payload?.profitIntel?.affiliate != null || payload?.affiliate != null),
    action: { type: "strip_affiliate", reason: "review_recommended" },
    trustAdjust: 0,
    warning: null,
  },

  // HSR-04: Affiliate + HIGH_RISK trust state → strip affiliate
  {
    id:          "HSR-04",
    description: "Affiliate links suppressed when trust state is HIGH_RISK_AUTH",
    condition: ({ trustState }) =>
      trustState === "HIGH_RISK_AUTH",
    action: { type: "strip_affiliate", reason: "high_risk_auth_state" },
    trustAdjust: 0,
    warning: null,
  },

  // HSR-05: STRONG BUY + insufficient evidence → cap to GOOD DEAL
  {
    id:          "HSR-05",
    description: "STRONG BUY with insufficient auth evidence → cap to GOOD DEAL",
    condition: ({ currentSignal, authEvidence }) =>
      currentSignal === "STRONG BUY" &&
      authEvidence.verdict === "INSUFFICIENT_EVIDENCE",
    action: { type: "cap_signal", maxSignal: "GOOD DEAL", capReason: "insufficient_auth_evidence" },
    trustAdjust: -0.06,
    warning: { code: "HSR_STRONG_BUY_UNVERIFIED", severity: "MEDIUM", blocking: false,
               message: "STRONG BUY signal present but authentication evidence is insufficient. Signal capped." },
  },

  // HSR-06: High value (>$500) + WEAK evidence → cap to FAIR
  {
    id:          "HSR-06",
    description: "Expensive item with weak auth evidence → cap to FAIR",
    condition: ({ scannedPrice, authEvidence }) =>
      scannedPrice != null && scannedPrice > 500 &&
      authEvidence.evidenceStrength === "WEAK",
    action: { type: "cap_signal", maxSignal: "FAIR", capReason: "expensive_weak_evidence" },
    trustAdjust: -0.08,
    warning: { code: "HSR_HIGH_VALUE_WEAK_EVIDENCE", severity: "HIGH", blocking: false,
               message: `High-value item with weak authentication evidence. Verification required before purchase.` },
  },

  // HSR-07: Very high value (>$2000) + UNCERTAIN + no serial/reference
  {
    id:          "HSR-07",
    description: "Very high value + uncertain auth + missing identity markers → trust penalty",
    condition: ({ scannedPrice, authEvidence }) =>
      scannedPrice != null && scannedPrice > 2000 &&
      authEvidence.verdict === "UNCERTAIN" &&
      authEvidence.missingSignals.some(s =>
        ["serial_number", "MISSING_SERIALNUMBER", "MISSING_REFERENCE",
         "WTCH_005", "HBAG_003"].includes(s.code)),
    action: { type: "trust_penalty", amount: -0.12 },
    trustAdjust: -0.12,
    warning: { code: "HSR_PREMIUM_MISSING_ID", severity: "HIGH", blocking: false,
               message: "High-value item missing key identity markers (serial/reference). Provenance cannot be confirmed." },
  },

  // HSR-08: Fake-prone category + auth score < 0.35 + not already RISKY → cap to FAIR
  {
    id:          "HSR-08",
    description: "Fake-prone category with poor auth score → cap to FAIR",
    condition: ({ category, authEvidence, currentSignal }) =>
      FAKE_PRONE.has(category) &&
      authEvidence.authScore < 0.35 &&
      !["RISKY", "OVERPRICED", "INSUFFICIENT DATA"].includes(currentSignal),
    action: { type: "cap_signal", maxSignal: "FAIR", capReason: "fake_prone_weak_auth" },
    trustAdjust: -0.06,
    warning: { code: "HSR_FAKE_PRONE_WEAK_AUTH", severity: "HIGH", blocking: false,
               message: "Item is in a high-counterfeit category with weak authentication score. Signal capped for safety." },
  },

  // HSR-09: Good price signal but conflicting auth evidence → add conflict flag
  {
    id:          "HSR-09",
    description: "Positive price signal conflicts with auth concerns → conflict flag",
    condition: ({ currentSignal, authEvidence }) =>
      ["STRONG BUY", "GOOD DEAL", "GREAT FLIP"].includes(currentSignal) &&
      authEvidence.negativeSignals.length >= 1 &&
      authEvidence.authScore < 0.50,
    action: { type: "add_flag", flag: "SIGNAL_AUTH_CONFLICT" },
    trustAdjust: -0.04,
    warning: { code: "HSR_PRICE_AUTH_CONFLICT", severity: "MEDIUM", blocking: false,
               message: "Positive price signal conflicts with authentication concerns. Verify before committing." },
  },

  // HSR-10: NONE evidence strength → add no-evidence flag regardless of signal
  {
    id:          "HSR-10",
    description: "No authentication evidence → add warning",
    condition: ({ authEvidence }) =>
      authEvidence.evidenceStrength === "NONE",
    action: { type: "add_flag", flag: "NO_AUTH_EVIDENCE" },
    trustAdjust: 0,
    warning: { code: "HSR_NO_AUTH_EVIDENCE", severity: "MEDIUM", blocking: false,
               message: "Insufficient data to assess authenticity. Price analysis may be unreliable." },
  },
];

// ── Apply rules ───────────────────────────────────────────────────────────────

/**
 * Apply all high-stakes downgrade rules to the assembled payload state.
 *
 * @param {object} opts
 *   payload         {object}  — the assembled scan payload (mutated in place)
 *   authEvidence    {object}  — from authEvidenceModel
 *   trustState      {string}  — from trustStateEngine
 *   category        {string}
 *   scannedPrice    {number|null}
 * @returns {HighStakesResult}
 */
export function applyHighStakesDowngradeRules({
  payload,
  authEvidence,
  trustState,
  category,
  scannedPrice,
} = {}) {
  if (!payload || !authEvidence) {
    return { rulesTriggered: [], warnings: [], flagsAdded: [], trustAdjust: 0 };
  }

  const currentSignal = payload?.profitIntel?.buySignal || null;
  const rulesTriggered = [];
  const warnings = [];
  const flagsAdded = [];
  let cumulativeTrustAdjust = 0;

  const ctx = { payload, authEvidence, trustState, category, scannedPrice, currentSignal };

  for (const rule of RULES) {
    let fired = false;
    try {
      fired = rule.condition({ ...ctx, currentSignal: payload?.profitIntel?.buySignal || currentSignal });
    } catch { fired = false; }

    if (!fired) continue;

    rulesTriggered.push(rule.id);
    cumulativeTrustAdjust += rule.trustAdjust;

    // Apply action
    const action = rule.action;
    switch (action.type) {
      case "force_signal": {
        if (payload?.profitIntel?.buySignal) {
          payload.profitIntel.buySignal = action.signal;
          payload.profitIntel.capReason = payload.profitIntel.capReason
            ? `${payload.profitIntel.capReason}; ${action.capReason}`
            : action.capReason;
          payload.profitIntel.signalCapped = true;
        }
        break;
      }
      case "cap_signal": {
        const curSig = payload?.profitIntel?.buySignal;
        if (curSig) {
          const capped = capSignal(curSig, action.maxSignal);
          if (capped !== curSig) {
            payload.profitIntel.buySignal = capped;
            payload.profitIntel.capReason = payload.profitIntel.capReason
              ? `${payload.profitIntel.capReason}; ${action.capReason}`
              : action.capReason;
            payload.profitIntel.signalCapped = true;
          }
        }
        break;
      }
      case "strip_affiliate": {
        if (payload?.profitIntel?.affiliate) {
          payload.profitIntel.affiliate = null;
          payload.profitIntel._affiliateStripped = action.reason;
        }
        if (payload?.affiliate) {
          payload.affiliate = null;
        }
        break;
      }
      case "trust_penalty": {
        const cur = payload?.profitIntel?.trustScore ?? payload?.trustScore ?? 0.5;
        const adj = Math.max(0.05, cur + action.amount);
        if (payload?.profitIntel) payload.profitIntel.trustScore = Math.round(adj * 1000) / 1000;
        if (payload?.trustScore !== undefined) payload.trustScore = Math.round(adj * 1000) / 1000;
        break;
      }
      case "add_flag": {
        flagsAdded.push(action.flag);
        if (payload?.profitIntel) {
          if (!Array.isArray(payload.profitIntel._authFlags)) {
            payload.profitIntel._authFlags = [];
          }
          payload.profitIntel._authFlags.push(action.flag);
        }
        break;
      }
    }

    if (rule.warning) warnings.push(rule.warning);
  }

  // Apply cumulative trust adjustment from all fired rules
  if (cumulativeTrustAdjust < 0) {
    const cur = payload?.profitIntel?.trustScore ?? payload?.trustScore ?? 0.5;
    const adj = Math.max(0.05, cur + cumulativeTrustAdjust);
    const rounded = Math.round(adj * 1000) / 1000;
    if (payload?.profitIntel) payload.profitIntel.trustScore = rounded;
    if (payload?.trustScore !== undefined) payload.trustScore = rounded;
  }

  return {
    rulesTriggered,
    warnings,
    flagsAdded,
    trustAdjust: Math.round(cumulativeTrustAdjust * 1000) / 1000,
    finalSignal: payload?.profitIntel?.buySignal || null,
  };
}
