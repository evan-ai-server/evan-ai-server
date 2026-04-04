// src/authEvidenceModel.js
// Phase 4 — Authentication Evidence Model.
//
// Translates the raw outputs of Phase 2 (auth engine, counterfeit memory,
// trust modifiers, attribute extraction) + Phase 4 auth rules into a single,
// structured, machine-readable authentication evidence object.
//
// This is NOT a new scoring layer. It is a structured TRANSLATION layer.
// Every field in the output is derived from actual pipeline signals — no
// invented text, no generic filler.
//
// Output shape:
//   authenticationEvidence: {
//     category, brand,
//     confidence,           — how confident we are in the evidence assessment itself (0-1)
//     verdict,              — LIKELY_AUTHENTIC | LIKELY_COUNTERFEIT | UNCERTAIN | INSUFFICIENT_EVIDENCE
//     evidenceStrength,     — STRONG | MEDIUM | WEAK | NONE
//     authScore,            — 0-1 normalized auth quality score (from rule evaluations)
//     positiveSignals[],    — confirmed indicators of authenticity
//     negativeSignals[],    — red flags or concerns
//     missingSignals[],     — signals we wanted but couldn't evaluate
//     requiredChecks[],     — concrete physical verification steps
//     reviewRecommended,    — boolean
//     reviewUrgency,        — HIGH | MEDIUM | LOW | null
//     trustImpact,          — net trust delta from auth evidence (for display)
//     warningCodes[],       — machine-readable warning codes from Phase 2
//   }

// ── Verdict constants ─────────────────────────────────────────────────────────

export const AUTH_VERDICT = {
  LIKELY_AUTHENTIC:      "LIKELY_AUTHENTIC",
  LIKELY_COUNTERFEIT:    "LIKELY_COUNTERFEIT",
  UNCERTAIN:             "UNCERTAIN",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
};

export const EVIDENCE_STRENGTH = {
  STRONG: "STRONG",
  MEDIUM: "MEDIUM",
  WEAK:   "WEAK",
  NONE:   "NONE",
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function r2(n) { return Math.round(n * 100) / 100; }

/**
 * Compute verdict from the assembled evidence signals.
 *
 * Priority order (highest wins):
 *  1. Any blocking warning or confirmed counterfeit match → LIKELY_COUNTERFEIT
 *  2. Auth tier = critical → LIKELY_COUNTERFEIT
 *  3. Extraction confidence < 0.35 → INSUFFICIENT_EVIDENCE
 *  4. All: low auth risk + good extraction + no neg signals → LIKELY_AUTHENTIC
 *  5. Default → UNCERTAIN
 */
function deriveVerdict({
  hasBlockingWarning,
  counterfeitMatches,
  authRiskScore,
  extractionConfidence,
  authTier,
  positiveSignalCount,
  negativeSignalCount,
  blockingNegativeSignalCount,
}) {
  // Definitive counterfeit indicators
  if (blockingNegativeSignalCount >= 1) return AUTH_VERDICT.LIKELY_COUNTERFEIT;
  if (counterfeitMatches.length > 0 && counterfeitMatches[0].matchScore >= 0.60)
    return AUTH_VERDICT.LIKELY_COUNTERFEIT;
  if (hasBlockingWarning) return AUTH_VERDICT.LIKELY_COUNTERFEIT;
  if (authTier === "critical") return AUTH_VERDICT.LIKELY_COUNTERFEIT;

  // Insufficient data
  if (extractionConfidence < 0.30) return AUTH_VERDICT.INSUFFICIENT_EVIDENCE;
  if (positiveSignalCount === 0 && negativeSignalCount === 0)
    return AUTH_VERDICT.INSUFFICIENT_EVIDENCE;

  // Likely authentic
  if (
    authRiskScore < 0.30 &&
    extractionConfidence >= 0.68 &&
    positiveSignalCount >= 3 &&
    negativeSignalCount === 0
  ) return AUTH_VERDICT.LIKELY_AUTHENTIC;

  if (
    authRiskScore < 0.40 &&
    extractionConfidence >= 0.55 &&
    positiveSignalCount >= 2 &&
    blockingNegativeSignalCount === 0
  ) return AUTH_VERDICT.LIKELY_AUTHENTIC;

  return AUTH_VERDICT.UNCERTAIN;
}

/**
 * Compute evidence strength from signal counts and extraction confidence.
 */
function deriveEvidenceStrength({
  extractionConfidence,
  positiveSignalCount,
  negativeSignalCount,
  blockingNegativeSignalCount,
  ruleEvalCount,
}) {
  if (extractionConfidence < 0.25 || ruleEvalCount === 0)
    return EVIDENCE_STRENGTH.NONE;

  if (blockingNegativeSignalCount >= 1 && positiveSignalCount >= 2)
    return EVIDENCE_STRENGTH.STRONG; // Strong evidence of a problem

  if (positiveSignalCount >= 4 && negativeSignalCount === 0 && extractionConfidence >= 0.75)
    return EVIDENCE_STRENGTH.STRONG;
  if (positiveSignalCount >= 2 && blockingNegativeSignalCount === 0 && extractionConfidence >= 0.55)
    return EVIDENCE_STRENGTH.MEDIUM;
  if (positiveSignalCount >= 1 || negativeSignalCount >= 1)
    return EVIDENCE_STRENGTH.WEAK;

  return EVIDENCE_STRENGTH.NONE;
}

/**
 * Compute confidence in the evidence assessment itself.
 * This is how sure we are about our evidence quality — not about the item.
 */
function deriveEvidenceConfidence({
  extractionConfidence,
  visionConfidence,
  ruleEvalCount,
  positiveSignalCount,
  negativeSignalCount,
}) {
  let conf = 0.35; // base

  // Extraction quality
  if (extractionConfidence >= 0.80) conf += 0.20;
  else if (extractionConfidence >= 0.60) conf += 0.12;
  else if (extractionConfidence >= 0.40) conf += 0.06;

  // Vision quality
  if (visionConfidence >= 0.80) conf += 0.15;
  else if (visionConfidence >= 0.60) conf += 0.08;

  // Rule coverage
  if (ruleEvalCount >= 6) conf += 0.15;
  else if (ruleEvalCount >= 3) conf += 0.08;

  // Signal richness
  const totalSignals = positiveSignalCount + negativeSignalCount;
  if (totalSignals >= 4) conf += 0.10;
  else if (totalSignals >= 2) conf += 0.05;

  return Math.min(0.98, Math.round(conf * 100) / 100);
}

/**
 * Review urgency from price and verdict.
 */
function deriveReviewUrgency(scannedPrice, verdict, hasBlockingWarning) {
  if (verdict === AUTH_VERDICT.LIKELY_COUNTERFEIT || hasBlockingWarning)
    return "HIGH";
  if (scannedPrice != null && scannedPrice >= 500 && verdict === AUTH_VERDICT.UNCERTAIN)
    return "MEDIUM";
  if (scannedPrice != null && scannedPrice >= 200 && verdict === AUTH_VERDICT.UNCERTAIN)
    return "LOW";
  return null;
}

// ── Build positive signals from pipeline outputs ──────────────────────────────

function extractPositiveSignals({ authResult, ruleResults, extractionResult }) {
  const signals = [];

  // From auth engine positive signals
  if (authResult?.authenticitySignals) {
    for (const sig of authResult.authenticitySignals) {
      if (sig.direction === "positive" || sig.direction === "safe") {
        signals.push({
          code:   sig.type || "AUTH_SIGNAL",
          label:  humanizeSignalType(sig.type),
          weight: sig.weight ?? 0.10,
          detail: sig.detail || "",
          source: "auth_engine",
        });
      }
    }
  }

  // From passing rule results
  if (Array.isArray(ruleResults)) {
    for (const r of ruleResults) {
      if (r.passed === true && r.signal === "positive") {
        signals.push({
          code:   r.ruleId,
          label:  r.description,
          weight: r.weight,
          detail: r.detail,
          source: "auth_rules",
        });
      }
    }
  }

  // Extraction completeness is itself a positive signal if high
  if (extractionResult?.extractionConfidence >= 0.75) {
    signals.push({
      code:   "EXTRACTION_COMPLETE",
      label:  "Good attribute coverage",
      weight: 0.08,
      detail: `${extractionResult.presentFields?.length || 0} attributes identified from listing.`,
      source: "extraction",
    });
  }

  return signals;
}

// ── Build negative signals from pipeline outputs ──────────────────────────────

function extractNegativeSignals({ authResult, ruleResults, counterfeitMatches }) {
  const signals = [];

  // Counterfeit memory matches
  for (const match of counterfeitMatches.slice(0, 3)) {
    signals.push({
      code:     "COUNTERFEIT_PATTERN_MATCH",
      label:    "Known counterfeit pattern matched",
      weight:   0.50,
      detail:   `Pattern match score ${match.matchScore.toFixed(2)}. Signals: ${match.fakeSignals?.slice(0, 2).join(", ") || "pattern match"}.`,
      blocking: match.matchScore >= 0.60,
      source:   "counterfeit_memory",
    });
  }

  // From auth engine warnings
  if (authResult?.authenticityWarnings) {
    for (const w of authResult.authenticityWarnings) {
      signals.push({
        code:     w.code || "AUTH_WARNING",
        label:    w.message || "Authentication warning",
        weight:   w.severity === "CRITICAL" ? 0.45 : w.severity === "HIGH" ? 0.30 : 0.15,
        detail:   w.message || "",
        blocking: w.blocking ?? false,
        source:   "auth_engine",
      });
    }
  }

  // From failing rule results
  if (Array.isArray(ruleResults)) {
    for (const r of ruleResults) {
      if (r.passed === false && r.signal === "negative") {
        signals.push({
          code:     r.ruleId,
          label:    r.description,
          weight:   r.weight,
          detail:   r.detail,
          blocking: r.blocking,
          source:   "auth_rules",
        });
      }
    }
  }

  return signals;
}

// ── Build missing signals ─────────────────────────────────────────────────────

function extractMissingSignals({ ruleResults, extractionResult }) {
  const signals = [];

  // From unknown-result rules (couldn't evaluate)
  if (Array.isArray(ruleResults)) {
    for (const r of ruleResults) {
      if (r.passed === null) {
        signals.push({
          code:       r.ruleId,
          label:      r.description,
          importance: r.weight >= 0.35 ? "HIGH" : r.weight >= 0.20 ? "MEDIUM" : "LOW",
          impact:     `Could not evaluate: ${r.detail}`,
          source:     "auth_rules",
        });
      }
    }
  }

  // Missing critical fields
  if (Array.isArray(extractionResult?.missingCriticalFields)) {
    for (const field of extractionResult.missingCriticalFields) {
      signals.push({
        code:       `MISSING_${field.toUpperCase()}`,
        label:      `${field.replace(/_/g, " ")} not found`,
        importance: "HIGH",
        impact:     `Missing ${field} prevents full authentication verification.`,
        source:     "extraction",
      });
    }
  }

  return signals;
}

// ── Build required checks ─────────────────────────────────────────────────────

function buildRequiredChecks({ ruleResults, authResult }) {
  const checks = [];
  const seen = new Set();

  if (Array.isArray(ruleResults)) {
    for (const r of ruleResults) {
      if (r.actionRequired && !seen.has(r.actionRequired)) {
        seen.add(r.actionRequired);
        checks.push({
          check:    r.actionRequired,
          reason:   r.detail,
          urgency:  r.blocking ? "HIGH" : r.passed === null ? "MEDIUM" : "LOW",
          ruleId:   r.ruleId,
        });
      }
    }
  }

  if (authResult?.recommendedActions) {
    for (const action of authResult.recommendedActions) {
      if (!seen.has(action)) {
        seen.add(action);
        checks.push({
          check:   action,
          reason:  "Recommended by authentication engine",
          urgency: "MEDIUM",
          ruleId:  null,
        });
      }
    }
  }

  // Sort: HIGH urgency first
  return checks.sort((a, b) => {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return (order[a.urgency] ?? 2) - (order[b.urgency] ?? 2);
  }).slice(0, 8);
}

// ── Humanize signal type codes ────────────────────────────────────────────────

function humanizeSignalType(type) {
  const map = {
    vision_confidence: "Vision quality",
    extraction_completeness: "Attribute coverage",
    missing_critical_fields: "Critical field coverage",
    price_floor_check: "Price consistency",
    counterfeit_memory_match: "Counterfeit pattern check",
    category_specific: "Category-specific marker",
    brand_fake_tells: "Brand tell detection",
  };
  return map[type] || (type || "").replace(/_/g, " ");
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build the structured authentication evidence model.
 *
 * @param {object} opts
 *   category           {string}
 *   brand              {string|null}
 *   extractionResult   {object}  — from categoryAttributeExtractor
 *   authResult         {object}  — from categoryAuthEngine
 *   counterfeitMatches {Array}   — from counterfeitMemory
 *   modifiers          {object}  — from categoryTrustModifiers
 *   authRuleResults    {object}  — from categoryAuthRules (ruleResults, authScore)
 *   scannedPrice       {number|null}
 *   visionConfidence   {number}
 * @returns {AuthenticationEvidence}
 */
export function buildAuthEvidenceModel({
  category          = "",
  brand             = null,
  extractionResult  = {},
  authResult        = null,
  counterfeitMatches = [],
  modifiers         = null,
  authRuleResults   = {},
  scannedPrice      = null,
  visionConfidence  = 0.5,
} = {}) {
  try {
    const ruleResults      = authRuleResults?.ruleResults || [];
    const extractionConf   = extractionResult?.extractionConfidence ?? 0.4;
    const authRiskScore    = authResult?.authenticityRiskScore ?? 0.5;
    const authTier         = authResult?.tier ?? "moderate";
    const hasBlockingWarn  = authResult?.hasBlockingWarning ?? false;
    const authScore        = authRuleResults?.authScore ?? 0.50;

    // Build signal lists
    const positiveSignals  = extractPositiveSignals({ authResult, ruleResults, extractionResult });
    const negativeSignals  = extractNegativeSignals({ authResult, ruleResults, counterfeitMatches });
    const missingSignals   = extractMissingSignals({ ruleResults, extractionResult });
    const requiredChecks   = buildRequiredChecks({ ruleResults, authResult });

    const posCount = positiveSignals.length;
    const negCount = negativeSignals.length;
    const blockingNeg = negativeSignals.filter(s => s.blocking).length;

    // Derive verdict, strength, confidence
    const verdict = deriveVerdict({
      hasBlockingWarning:          hasBlockingWarn,
      counterfeitMatches,
      authRiskScore,
      extractionConfidence:        extractionConf,
      authTier,
      positiveSignalCount:         posCount,
      negativeSignalCount:         negCount,
      blockingNegativeSignalCount: blockingNeg,
    });

    const evidenceStrength = deriveEvidenceStrength({
      extractionConfidence:        extractionConf,
      positiveSignalCount:         posCount,
      negativeSignalCount:         negCount,
      blockingNegativeSignalCount: blockingNeg,
      ruleEvalCount:               ruleResults.length,
    });

    const confidence = deriveEvidenceConfidence({
      extractionConfidence: extractionConf,
      visionConfidence,
      ruleEvalCount:        ruleResults.length,
      positiveSignalCount:  posCount,
      negativeSignalCount:  negCount,
    });

    // Review recommendation
    const reviewRecommended = (
      verdict === AUTH_VERDICT.LIKELY_COUNTERFEIT ||
      hasBlockingWarn ||
      (scannedPrice != null && scannedPrice >= 300 && verdict === AUTH_VERDICT.UNCERTAIN) ||
      (scannedPrice != null && scannedPrice >= 150 && evidenceStrength === EVIDENCE_STRENGTH.WEAK)
    );
    const reviewUrgency = deriveReviewUrgency(scannedPrice, verdict, hasBlockingWarn);

    // Net trust impact from auth evidence (for display only — actual trust adjusted in Phase 2)
    const trustImpact = r2(modifiers?.delta ?? 0);

    // Warning codes from Phase 2
    const warningCodes = [
      ...(modifiers?.warningCodes || []),
      ...(modifiers?.blockingWarnings || []),
    ];

    return {
      category,
      brand:             brand || extractionResult?.extractedAttributes?.brand || null,
      confidence:        r2(confidence),
      verdict,
      evidenceStrength,
      authScore:         r2(authScore),
      positiveSignals:   positiveSignals.slice(0, 8),
      negativeSignals:   negativeSignals.slice(0, 8),
      missingSignals:    missingSignals.slice(0, 6),
      requiredChecks:    requiredChecks.slice(0, 6),
      reviewRecommended,
      reviewUrgency,
      trustImpact,
      warningCodes,
    };
  } catch (err) {
    console.error("[authEvidenceModel] error:", err?.message);
    // Safe empty evidence — always INSUFFICIENT rather than false claims
    return {
      category,
      brand,
      confidence:        0.10,
      verdict:           AUTH_VERDICT.INSUFFICIENT_EVIDENCE,
      evidenceStrength:  EVIDENCE_STRENGTH.NONE,
      authScore:         0.50,
      positiveSignals:   [],
      negativeSignals:   [],
      missingSignals:    [],
      requiredChecks:    [],
      reviewRecommended: false,
      reviewUrgency:     null,
      trustImpact:       0,
      warningCodes:      [],
    };
  }
}
