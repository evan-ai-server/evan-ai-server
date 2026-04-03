// src/categoryDominationEngine.js
// Phase 2 — Category Domination Engine Orchestrator.
//
// Ties together all Phase 2 subsystems:
//   1. categoryAttributeExtractor   → extract structured attributes from identity
//   2. categoryAuthEngine           → authentication risk assessment
//   3. counterfeitMemory            → match against known fake patterns
//   4. categoryTrustModifiers       → compute trust score adjustments
//   5. Apply adjustments to payload  → trust score + buy signal affected
//
// Exports a single async function: applyCategoryDomination(redis, payload, opts)
// Called at each scan route (Routes A-D) right after applyCategoryIntelligenceToPayload.
//
// Side effects on payload:
//   - payload.categoryDomination   — full Phase 2 intel object
//   - payload.profitIntel.trustScore  — adjusted by trust delta
//   - payload.profitIntel.buySignal   — downgraded if blocking warnings active
//   - payload.authenticityIntel       — enriched with Phase 2 signals
//
// The system degrades gracefully: any subsystem failure is caught and skipped.

import { extractCategoryAttributes }               from "./categoryAttributeExtractor.js";
import { runCategoryAuthEngine }                   from "./categoryAuthEngine.js";
import { matchScanToCounterfeitPatterns }          from "./counterfeitMemory.js";
import { computeCategoryTrustAdjustments,
         applyCategoryTrustModifiers }             from "./categoryTrustModifiers.js";
import { hasDeepProfile, getConfidenceFloors }     from "./categoryProfiles.js";
import { CAT }                                     from "./categoryRegistry.js";

// ── Signal downgrade map ──────────────────────────────────────────────────────
// When a blocking warning fires, these signals are downgraded
const BLOCKING_DOWNGRADE = {
  "STRONG BUY":           "RISKY",
  "GREAT FLIP":           "RISKY",
  "GOOD DEAL":            "RISKY",
  "FAIR":                 "RISKY",
  "OVERPRICED":           "RISKY",
  "INSUFFICIENT DATA":    "RISKY",
  "RISKY":                "RISKY",
};

const SOFT_DOWNGRADE = {
  "STRONG BUY":           "GOOD DEAL",
  "GREAT FLIP":           "GOOD DEAL",
  "GOOD DEAL":            "FAIR",
  "FAIR":                 "FAIR",
  "OVERPRICED":           "OVERPRICED",
  "INSUFFICIENT DATA":    "INSUFFICIENT DATA",
  "RISKY":                "RISKY",
};

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the Category Domination Engine and apply results to the scan payload.
 *
 * @param {object} redis
 * @param {object} payload    — the assembled scan response payload (mutated in place)
 * @param {object} opts
 *   identity        {object}  — vision identity (visionIdentity)
 *   category        {string}  — canonical category
 *   scannedPrice    {number|null}
 *   rawText         {string}  — raw listing/image text
 *   visionConfidence{number}  — 0-1
 */
export async function applyCategoryDomination(redis, payload, {
  identity          = {},
  category          = "",
  scannedPrice      = null,
  rawText           = "",
  visionConfidence  = 0.5,
} = {}) {
  // Only run full Phase 2 for categories with deep profiles
  if (!hasDeepProfile(category)) {
    // Still run a lightweight counterfeit check for all categories
    await applyLightweightCounterfeitCheck(redis, payload, { identity, category, scannedPrice });
    return;
  }

  try {
    // ── Step 1: Extract structured attributes ─────────────────────────────────
    let extractionResult;
    try {
      extractionResult = extractCategoryAttributes({ identity, category, rawText });
    } catch (err) {
      console.error("[categoryDomination] extractCategoryAttributes error:", err?.message);
      extractionResult = { extractedAttributes: {}, presentFields: [], missingCriticalFields: [], missingRequiredFields: [], extractionConfidence: 0.3, extractionNotes: [] };
    }

    // ── Step 2: Counterfeit memory lookup (async) ─────────────────────────────
    let counterfeitMatches = [];
    try {
      counterfeitMatches = await matchScanToCounterfeitPatterns(redis, {
        category,
        extractedAttributes: extractionResult.extractedAttributes,
      });
    } catch (err) {
      console.error("[categoryDomination] counterfeit lookup error:", err?.message);
    }

    // ── Step 3: Authentication engine ─────────────────────────────────────────
    let authResult;
    try {
      authResult = runCategoryAuthEngine({
        extractionResult,
        category,
        scannedPrice,
        visionConfidence,
        counterfeitMatches,
        rawText,
      });
    } catch (err) {
      console.error("[categoryDomination] runCategoryAuthEngine error:", err?.message);
      authResult = null;
    }

    // ── Step 4: Trust adjustments ─────────────────────────────────────────────
    const currentTrustScore = payload?.profitIntel?.trustScore ?? payload?.trustScore ?? 0.5;
    let modifiers;
    try {
      modifiers = computeCategoryTrustAdjustments({
        category,
        extractionResult,
        authResult,
        counterfeitMatches,
        currentTrustScore,
        scannedPrice,
      });
    } catch (err) {
      console.error("[categoryDomination] computeCategoryTrustAdjustments error:", err?.message);
      modifiers = null;
    }

    // ── Step 5: Apply trust adjustments to payload ────────────────────────────
    const newTrustScore = modifiers
      ? applyCategoryTrustModifiers(currentTrustScore, modifiers)
      : currentTrustScore;

    if (payload?.profitIntel) {
      payload.profitIntel.trustScore = newTrustScore;
    }
    if (payload?.trustScore !== undefined) {
      payload.trustScore = newTrustScore;
    }

    // ── Step 6: Apply buy signal adjustments for blocking warnings ────────────
    const currentSignal = payload?.profitIntel?.buySignal || null;
    let finalSignal     = currentSignal;

    if (modifiers?.blockingWarnings?.length > 0 && currentSignal) {
      // Critical: confirmed fake patterns or catastrophic auth flags → RISKY
      const hasCounterfeitMatch = counterfeitMatches.length > 0;
      const isCriticalAuth      = authResult?.tier === "critical";

      if (hasCounterfeitMatch || isCriticalAuth) {
        finalSignal = BLOCKING_DOWNGRADE[currentSignal] || "RISKY";
      } else {
        // Soft downgrade for high-severity non-confirmed warnings
        finalSignal = SOFT_DOWNGRADE[currentSignal] || currentSignal;
      }

      if (finalSignal !== currentSignal && payload?.profitIntel) {
        payload.profitIntel.buySignal = finalSignal;
        // Record the downgrade reason
        const prevCapReason = payload.profitIntel.capReason || null;
        payload.profitIntel.capReason = prevCapReason
          ? `${prevCapReason}; category_auth_block`
          : "category_auth_block";
        payload.profitIntel.signalCapped = true;
      }
    } else if (modifiers?.shouldBlockBuySignal && currentSignal && !["RISKY", "OVERPRICED"].includes(currentSignal)) {
      // Trust floor violation without a blocking warning — soft downgrade
      finalSignal = SOFT_DOWNGRADE[currentSignal] || currentSignal;
      if (finalSignal !== currentSignal && payload?.profitIntel) {
        payload.profitIntel.buySignal = finalSignal;
        payload.profitIntel.capReason = payload.profitIntel.capReason
          ? `${payload.profitIntel.capReason}; category_trust_floor`
          : "category_trust_floor";
        payload.profitIntel.signalCapped = true;
      }
    }

    // ── Step 7: Enrich authenticityIntel in payload ───────────────────────────
    if (authResult && payload) {
      const existingAuth = payload.authenticityIntel || payload.profitIntel?.authenticityIntel || {};
      const enrichedAuth = {
        ...existingAuth,
        // Phase 2 additions
        categoryAuthRiskScore:   authResult.authenticityRiskScore,
        categoryAuthConfidence:  authResult.authenticityConfidence,
        categoryAuthTier:        authResult.tier,
        categoryAuthSignals:     authResult.authenticitySignals?.slice(0, 5) || [],
        categoryAuthWarnings:    authResult.authenticityWarnings || [],
        categoryRecommendedActions: authResult.recommendedActions || [],
        brandAuth:               authResult.brandAuth || null,
        hasBlockingWarning:      authResult.hasBlockingWarning,
      };

      if (payload.profitIntel) {
        payload.profitIntel.authenticityIntel = enrichedAuth;
      } else {
        payload.authenticityIntel = enrichedAuth;
      }
    }

    // ── Step 8: Attach full Phase 2 intel to payload ──────────────────────────
    payload.categoryDomination = {
      category,
      hasDeepProfile: true,

      // Attribute extraction
      structuredAttributes:       extractionResult.extractedAttributes,
      presentFields:              extractionResult.presentFields,
      missingCriticalFields:      extractionResult.missingCriticalFields,
      missingRequiredFields:      extractionResult.missingRequiredFields,
      extractionConfidence:       extractionResult.extractionConfidence,

      // Authentication
      categoryAuth: authResult ? {
        riskScore:    authResult.authenticityRiskScore,
        confidence:   authResult.authenticityConfidence,
        tier:         authResult.tier,
        warnings:     authResult.authenticityWarnings || [],
        signals:      authResult.authenticitySignals?.slice(0, 4) || [],
        brandAuth:    authResult.brandAuth || null,
        recommended:  authResult.recommendedActions || [],
        hasBlockingWarning: authResult.hasBlockingWarning,
      } : null,

      // Counterfeit memory
      counterfeitMatches: counterfeitMatches.slice(0, 3).map(m => ({
        patternId:    m.patternId,
        matchScore:   m.matchScore,
        matchedFields:m.matchedFields,
        fakeSignals:  m.fakeSignals?.slice(0, 3) || [],
        reportCount:  m.reportCount,
      })),
      counterfeitMatchCount: counterfeitMatches.length,

      // Trust
      categoryTrustAdjustments: modifiers ? {
        delta:               modifiers.delta,
        penalties:           modifiers.penalties,
        boosts:              modifiers.boosts,
        explanation:         modifiers.explanation,
        projectedTrustScore: modifiers.projectedTrustScore,
      } : null,
      finalTrustScore: newTrustScore,

      // Warnings
      warningCodes:      modifiers?.warningCodes    || [],
      blockingWarnings:  modifiers?.blockingWarnings || [],

      // Signal impact
      originalBuySignal: currentSignal,
      finalBuySignal:    finalSignal,
      signalDowngraded:  finalSignal !== currentSignal,
    };

  } catch (err) {
    console.error("[categoryDomination] fatal error:", err?.message);
    // Don't fail the response — attach minimal stub
    payload.categoryDomination = { category, hasDeepProfile: true, error: "engine_failure" };
  }
}

// ── Lightweight counterfeit check for non-deep categories ────────────────────

async function applyLightweightCounterfeitCheck(redis, payload, { identity, category, scannedPrice }) {
  try {
    const extractedAttributes = {
      brand: identity?.brand || null,
      model: identity?.model || identity?.productName || null,
    };

    const matches = await matchScanToCounterfeitPatterns(redis, {
      category,
      extractedAttributes,
    });

    if (matches.length > 0 && payload?.profitIntel) {
      const topMatch = matches[0];
      if (topMatch.matchScore >= 0.7) {
        // High-confidence match even for non-deep category
        const currentSignal = payload.profitIntel.buySignal;
        if (currentSignal && !["RISKY", "OVERPRICED"].includes(currentSignal)) {
          payload.profitIntel.buySignal = "RISKY";
          payload.profitIntel.capReason = "counterfeit_pattern_match";
          payload.profitIntel.signalCapped = true;
        }
      }

      payload.categoryDomination = {
        category,
        hasDeepProfile: false,
        counterfeitMatches: matches.slice(0, 2).map(m => ({
          patternId:  m.patternId,
          matchScore: m.matchScore,
          fakeSignals:m.fakeSignals?.slice(0, 2) || [],
        })),
        counterfeitMatchCount: matches.length,
      };
    }
  } catch { /* non-fatal */ }
}

// ── Category performance metrics ──────────────────────────────────────────────

/**
 * Get per-category ops stats for the Phase 2 domination engine.
 * Used by GET /category/ops endpoint.
 */
export async function getCategoryDominationStats(redis) {
  if (!redis) return {};
  try {
    const { getCounterfeitStats } = await import("./counterfeitMemory.js");
    const { getCorrectionStats }  = await import("./expertCorrections.js");

    const [cfStats, corrStats] = await Promise.all([
      getCounterfeitStats(redis).catch(() => ({})),
      getCorrectionStats(redis).catch(() => ({})),
    ]);

    return {
      counterfeitMemory: {
        totalPatterns: cfStats.totalPatterns || 0,
        totalMatches:  cfStats.totalMatches  || 0,
      },
      expertCorrections: {
        pending:  corrStats.pending  || 0,
        verified: corrStats.verified || 0,
      },
      deepCategories: [CAT.SNEAKERS, CAT.HANDBAGS, CAT.WATCHES],
    };
  } catch (err) {
    console.error("[categoryDomination] getCategoryDominationStats error:", err?.message);
    return {};
  }
}
