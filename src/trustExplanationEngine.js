// src/trustExplanationEngine.js
// Phase 4 — Trust Explanation Engine.
//
// Produces a structured, evidence-backed trust explanation for every scan.
// STRICT RULE: every explanation field must come from actual pipeline signals.
// No generic filler. No invented text. No "AI confidence" language.
//
// Output shape:
//   trustExplanation: {
//     overallTrustScore,
//     evidenceLevel,           — STRONG | MEDIUM | WEAK | NONE
//     confidenceDrivers[],     — things that INCREASE trust
//     confidencePenalties[],   — things that REDUCE trust
//     authenticationDrivers[], — authentication-specific positive signals
//     pricingDrivers[],        — market pricing signals
//     riskDrivers[],           — risk and concern signals
//     finalReasonSummary,      — 1-2 sentence human explanation (real signals only)
//     userGuidance,            — what to do next
//     verificationSteps[],     — concrete steps if review recommended
//   }

// ── Helpers ───────────────────────────────────────────────────────────────────

function r2(n) { return Math.round(n * 100) / 100; }

function pct(n) { return Math.round((n || 0) * 100) + "%"; }

// ── Confidence driver builders ────────────────────────────────────────────────

function buildConfidenceDrivers({ extractionResult, visionConfidence, authRuleResults, modifiers }) {
  const drivers = [];

  // Extraction quality
  const exConf = extractionResult?.extractionConfidence ?? 0;
  const presentCount = extractionResult?.presentFields?.length ?? 0;
  if (exConf >= 0.75) {
    drivers.push({
      factor: "Attribute coverage",
      impact: "+",
      detail: `${presentCount} item attributes identified — sufficient for analysis.`,
    });
  }

  // Vision confidence
  if (visionConfidence >= 0.75) {
    drivers.push({
      factor: "Image quality",
      impact: "+",
      detail: `High image clarity (${pct(visionConfidence)}) — identity signals are reliable.`,
    });
  } else if (visionConfidence >= 0.55) {
    drivers.push({
      factor: "Image quality",
      impact: "~",
      detail: `Moderate image clarity (${pct(visionConfidence)}) — key attributes visible.`,
    });
  }

  // Auth rules passing
  const passCount = authRuleResults?.passCount ?? 0;
  if (passCount >= 3) {
    drivers.push({
      factor: "Authentication checks passed",
      impact: "+",
      detail: `${passCount} authentication markers confirmed.`,
    });
  } else if (passCount >= 1) {
    drivers.push({
      factor: "Authentication checks passed",
      impact: "+",
      detail: `${passCount} authentication marker(s) confirmed.`,
    });
  }

  // Small trust boost from completeness
  if (modifiers?.boosts?.length > 0) {
    for (const boost of modifiers.boosts) {
      drivers.push({
        factor: "Completeness boost",
        impact: "+",
        detail: boost.reason || "High attribute completeness.",
      });
    }
  }

  return drivers.slice(0, 5);
}

// ── Confidence penalty builders ───────────────────────────────────────────────

function buildConfidencePenalties({ extractionResult, authRuleResults, modifiers, authEvidence }) {
  const penalties = [];

  // Extraction gaps
  const critMissing = extractionResult?.missingCriticalFields?.length ?? 0;
  if (critMissing >= 2) {
    penalties.push({
      factor: "Critical fields missing",
      impact: "-",
      detail: `${critMissing} critical identifiers absent: ${extractionResult.missingCriticalFields.slice(0, 3).join(", ")}.`,
    });
  } else if (critMissing === 1) {
    penalties.push({
      factor: "Critical field missing",
      impact: "-",
      detail: `Key identifier "${extractionResult.missingCriticalFields[0]}" not found.`,
    });
  }

  // Low extraction confidence
  const exConf = extractionResult?.extractionConfidence ?? 0;
  if (exConf < 0.40) {
    penalties.push({
      factor: "Low attribute coverage",
      impact: "-",
      detail: `Only ${pct(exConf)} of expected attributes identified. Analysis may be incomplete.`,
    });
  }

  // Auth rule failures
  const failCount = authRuleResults?.failCount ?? 0;
  if (failCount >= 2) {
    penalties.push({
      factor: "Authentication checks failed",
      impact: "-",
      detail: `${failCount} authentication checks did not pass.`,
    });
  } else if (failCount === 1) {
    const failedRule = authRuleResults?.ruleResults?.find(r => r.passed === false);
    if (failedRule) {
      penalties.push({
        factor: "Authentication check failed",
        impact: "-",
        detail: failedRule.detail,
      });
    }
  }

  // Phase 2 trust penalties
  if (modifiers?.penalties?.length > 0) {
    const highPenalties = modifiers.penalties.filter(p => Math.abs(p.delta || 0) >= 0.06);
    for (const pen of highPenalties.slice(0, 2)) {
      penalties.push({
        factor: pen.type || "Trust penalty",
        impact: "-",
        detail: pen.reason || `Trust reduced by ${Math.abs(pen.delta || 0).toFixed(2)}.`,
      });
    }
  }

  // Unverified signals
  const unknownCount = authRuleResults?.unknownCount ?? 0;
  if (unknownCount >= 3) {
    penalties.push({
      factor: "Unverifiable markers",
      impact: "-",
      detail: `${unknownCount} authentication markers could not be evaluated — data was not available.`,
    });
  }

  return penalties.slice(0, 5);
}

// ── Authentication driver builders ────────────────────────────────────────────

function buildAuthDrivers({ authEvidence, authRuleResults }) {
  const drivers = [];

  // Positive signals from evidence model
  for (const sig of (authEvidence?.positiveSignals || []).slice(0, 4)) {
    drivers.push({
      signal: sig.label || sig.code,
      direction: "positive",
      detail: sig.detail,
    });
  }

  // Negative signals from evidence model
  for (const sig of (authEvidence?.negativeSignals || []).slice(0, 3)) {
    drivers.push({
      signal: sig.label || sig.code,
      direction: "negative",
      detail: sig.detail,
    });
  }

  return drivers.slice(0, 6);
}

// ── Pricing driver builders ───────────────────────────────────────────────────

function buildPricingDrivers({ scannedPrice, authEvidence, modifiers }) {
  const drivers = [];

  // Price floor check result
  const priceSignal = authEvidence?.positiveSignals?.find(s =>
    s.code?.includes("PRICE") || s.label?.toLowerCase().includes("price"));
  if (priceSignal) {
    drivers.push({ factor: "Price consistency", direction: "positive", detail: priceSignal.detail });
  }

  const pricePenalty = authEvidence?.negativeSignals?.find(s =>
    s.code?.includes("PRICE") || s.label?.toLowerCase().includes("price"));
  if (pricePenalty) {
    drivers.push({ factor: "Price concern", direction: "negative", detail: pricePenalty.detail });
  }

  // HSR warnings about price
  if (scannedPrice != null && scannedPrice > 500) {
    drivers.push({ factor: "High-value item", direction: "neutral", detail: `At $${scannedPrice}, authentication is more critical.` });
  }

  return drivers.slice(0, 4);
}

// ── Risk driver builders ──────────────────────────────────────────────────────

function buildRiskDrivers({ authEvidence, highStakesResult, category }) {
  const drivers = [];

  // Counterfeit memory
  const cfSignal = authEvidence?.negativeSignals?.find(s => s.code === "COUNTERFEIT_PATTERN_MATCH");
  if (cfSignal) {
    drivers.push({
      risk:     "Known counterfeit pattern",
      severity: cfSignal.blocking ? "CRITICAL" : "HIGH",
      detail:   cfSignal.detail,
    });
  }

  // Blocking failures from rules
  for (const r of (authEvidence?.negativeSignals || []).filter(s => s.blocking && s.code !== "COUNTERFEIT_PATTERN_MATCH")) {
    drivers.push({
      risk:     r.label || r.code,
      severity: "CRITICAL",
      detail:   r.detail,
    });
  }

  // High-stakes rule warnings
  for (const w of (highStakesResult?.warnings || [])) {
    if (w.severity === "CRITICAL" || w.severity === "HIGH") {
      drivers.push({
        risk:     w.code,
        severity: w.severity,
        detail:   w.message,
      });
    }
  }

  // Fake-prone category note
  if (["sneakers", "handbags", "watches"].includes(category)) {
    drivers.push({
      risk:     "High-counterfeit category",
      severity: "LOW",
      detail:   `${category} is one of the most counterfeited categories. Evan applies tighter authentication gates.`,
    });
  }

  return drivers.slice(0, 5);
}

// ── Final reason summary ──────────────────────────────────────────────────────

function buildFinalReasonSummary({ verdict, evidenceStrength, authEvidence, trustScore, category, scannedPrice }) {
  // Rule: lead with the dominant factor, use actual signals, no filler

  // Definitive counterfeit
  if (verdict === "LIKELY_COUNTERFEIT") {
    const topNeg = authEvidence?.negativeSignals?.[0];
    const cfMatch = authEvidence?.negativeSignals?.find(s => s.code === "COUNTERFEIT_PATTERN_MATCH");
    if (cfMatch) {
      return `Evan matched a known counterfeit pattern for this item. ${cfMatch.detail.split(".")[0]}.`;
    }
    if (topNeg) {
      return `Authentication check failed: ${topNeg.detail.split(".")[0]}. This is a blocking concern.`;
    }
    return "Critical authentication failures detected. This item should not be purchased without expert verification.";
  }

  // Insufficient evidence
  if (verdict === "INSUFFICIENT_EVIDENCE") {
    const missingCount = authEvidence?.missingSignals?.length ?? 0;
    const critFields = authEvidence?.missingSignals?.filter(s => s.importance === "HIGH").slice(0, 2).map(s => s.label).join(", ");
    if (critFields) {
      return `Unable to assess authenticity — ${critFields} could not be confirmed from available information.`;
    }
    return `Insufficient attributes to evaluate authenticity for this ${category || "item"}. More data needed.`;
  }

  // Likely authentic with strong evidence
  if (verdict === "LIKELY_AUTHENTIC" && evidenceStrength === "STRONG") {
    const topPos = authEvidence?.positiveSignals?.[0];
    const posCount = authEvidence?.positiveSignals?.length ?? 0;
    if (topPos) {
      return `Strong authentication evidence found — ${posCount} positive marker(s) confirmed including ${topPos.label.toLowerCase()}.`;
    }
    return "Strong authentication evidence — key markers are consistent with a genuine item.";
  }

  // Likely authentic with medium evidence
  if (verdict === "LIKELY_AUTHENTIC") {
    const posCount = authEvidence?.positiveSignals?.length ?? 0;
    const unkCount = authEvidence?.missingSignals?.length ?? 0;
    if (unkCount > 0) {
      return `Positive authentication signals found (${posCount} confirmed) but ${unkCount} marker(s) could not be verified.`;
    }
    return `Authentication checks are favorable — ${posCount} positive signal(s) found, no blocking concerns.`;
  }

  // Uncertain
  if (evidenceStrength === "WEAK") {
    const posCount = authEvidence?.positiveSignals?.length ?? 0;
    const negCount = authEvidence?.negativeSignals?.length ?? 0;
    if (negCount > 0 && posCount > 0) {
      return `Conflicting evidence — ${posCount} positive signal(s) offset by ${negCount} concern(s). Manual verification recommended.`;
    }
    if (negCount > 0) {
      return `Authentication concerns present (${negCount} flag(s)) with limited positive evidence. Proceed with caution.`;
    }
    return `Authentication evidence is thin — only ${posCount} signal(s) could be evaluated.`;
  }

  // Price good but auth uncertain
  if (scannedPrice != null && scannedPrice > 100) {
    return `Pricing looks favorable at $${scannedPrice}, but authentication evidence is incomplete. Verify before purchase.`;
  }

  return "Authentication assessment is inconclusive. Review available evidence before committing.";
}

// ── User guidance builder ─────────────────────────────────────────────────────

function buildUserGuidance({ verdict, reviewRecommended, reviewUrgency, trustScore }) {
  if (verdict === "LIKELY_COUNTERFEIT") {
    return "Do not purchase. If you believe the item may be genuine, have it physically authenticated by a certified expert before any payment.";
  }
  if (reviewRecommended && reviewUrgency === "HIGH") {
    return "Expert authentication strongly recommended before purchasing. Use a reputable service — GOAT, StockX, Entrupy, or a certified watchmaker.";
  }
  if (reviewRecommended) {
    return "Authentication verification recommended. Ask the seller for additional photos of key markers, or use an authentication service.";
  }
  if (verdict === "LIKELY_AUTHENTIC" && trustScore >= 0.70) {
    return "Proceed with standard reseller diligence. Evan's signals are positive, but always inspect in person if possible.";
  }
  if (verdict === "INSUFFICIENT_EVIDENCE") {
    return "Request more information from the seller before buying. Specifically ask for photos of authentication markers.";
  }
  return "Review the verification steps below and ask the seller for any missing information.";
}

// ── Verification steps ────────────────────────────────────────────────────────

function buildVerificationSteps({ requiredChecks, authEvidence, category }) {
  const steps = [];
  const seen  = new Set();

  // High urgency checks first
  for (const check of (requiredChecks || []).filter(c => c.urgency === "HIGH")) {
    if (!seen.has(check.check)) {
      steps.push(check.check);
      seen.add(check.check);
    }
  }

  // Missing signal actions
  for (const sig of (authEvidence?.missingSignals || []).filter(s => s.importance === "HIGH")) {
    const step = `Obtain the ${sig.label.toLowerCase()} from the seller.`;
    if (!seen.has(step)) {
      steps.push(step);
      seen.add(step);
    }
  }

  // Remaining checks
  for (const check of (requiredChecks || []).filter(c => c.urgency !== "HIGH")) {
    if (!seen.has(check.check)) {
      steps.push(check.check);
      seen.add(check.check);
    }
  }

  // Category-specific default steps
  const catDefaults = {
    sneakers: ["Use GOAT or StockX authentication service for shoes over $100."],
    handbags: ["Use Entrupy or Real Authentication for any bag over $500."],
    watches:  ["Use a certified watchmaker or Rolex Authorized Dealer for watch verification."],
  };
  for (const step of (catDefaults[category] || [])) {
    if (!seen.has(step)) {
      steps.push(step);
      seen.add(step);
    }
  }

  return steps.slice(0, 6);
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build the trust explanation object.
 *
 * @param {object} opts
 *   trustScore        {number}
 *   authEvidence      {object}    — from authEvidenceModel
 *   authRuleResults   {object}    — from categoryAuthRules
 *   modifiers         {object}    — from categoryTrustModifiers
 *   highStakesResult  {object}    — from highStakesDowngradeRules
 *   extractionResult  {object}    — from categoryAttributeExtractor
 *   category          {string}
 *   scannedPrice      {number|null}
 *   visionConfidence  {number}
 * @returns {TrustExplanation}
 */
export function buildTrustExplanation({
  trustScore        = 0.5,
  authEvidence      = {},
  authRuleResults   = {},
  modifiers         = null,
  highStakesResult  = {},
  extractionResult  = {},
  category          = "",
  scannedPrice      = null,
  visionConfidence  = 0.5,
} = {}) {
  try {
    const verdict          = authEvidence.verdict || "UNCERTAIN";
    const evidenceStrength = authEvidence.evidenceStrength || "WEAK";
    const reviewRecommended = authEvidence.reviewRecommended ?? false;
    const reviewUrgency    = authEvidence.reviewUrgency ?? null;

    const confidenceDrivers = buildConfidenceDrivers({
      extractionResult, visionConfidence, authRuleResults, modifiers,
    });
    const confidencePenalties = buildConfidencePenalties({
      extractionResult, authRuleResults, modifiers, authEvidence,
    });
    const authenticationDrivers = buildAuthDrivers({ authEvidence, authRuleResults });
    const pricingDrivers = buildPricingDrivers({ scannedPrice, authEvidence, modifiers });
    const riskDrivers = buildRiskDrivers({ authEvidence, highStakesResult, category });

    const finalReasonSummary = buildFinalReasonSummary({
      verdict, evidenceStrength, authEvidence, trustScore, category, scannedPrice,
    });
    const userGuidance = buildUserGuidance({ verdict, reviewRecommended, reviewUrgency, trustScore });
    const verificationSteps = buildVerificationSteps({
      requiredChecks: authEvidence.requiredChecks,
      authEvidence,
      category,
    });

    return {
      overallTrustScore:      r2(trustScore),
      evidenceLevel:          evidenceStrength,
      confidenceDrivers,
      confidencePenalties,
      authenticationDrivers,
      pricingDrivers,
      riskDrivers,
      finalReasonSummary,
      userGuidance,
      verificationSteps,
    };
  } catch (err) {
    console.error("[trustExplanationEngine] error:", err?.message);
    return {
      overallTrustScore: r2(trustScore),
      evidenceLevel:     "NONE",
      confidenceDrivers: [],
      confidencePenalties: [],
      authenticationDrivers: [],
      pricingDrivers: [],
      riskDrivers: [],
      finalReasonSummary: "Trust explanation could not be generated.",
      userGuidance: "Use standard reseller diligence.",
      verificationSteps: [],
    };
  }
}
