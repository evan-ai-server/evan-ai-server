// src/categoryIntelligence.js
// Category Intelligence Orchestrator — Phase 15: Category Immortality.
//
// Single entry point that enriches a scan payload with all Phase 15 signals:
//   1. Replica marker scan (from knowledge base)
//   2. Defect surface impact estimate
//   3. Category-specific condition classification
//   4. Calendar context (events, market pressure)
//   5. Category identity score (per-user)
//   6. Local-market adjustment (where available)
//
// Called AFTER all signal computation and AFTER plan gating.
// CRITICAL INVARIANTS:
//   - Never modifies buySignal value — only adds context fields
//   - All writes are non-blocking (failures never surface to scan response)
//   - Pro-only fields are gated BEFORE this runs (gatingContext already set)

import { normalizeCategory, getCategoryProfile, CAT } from "./categoryRegistry.js";
import {
  scanReplicaMarkers,
  estimateDefectImpact,
  getLocalMarketMultiplier,
} from "./categoryKnowledgeBase.js";
import { classifyConditionForCategory } from "./categoryConditionProfiles.js";
import { getCategoryCalendarContext }   from "./categoryEventCalendar.js";
import { computeCategoryIdentityScore } from "./categoryIdentityEngines/index.js";

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Apply all Phase 15 category intelligence to a scan payload.
 * Mutates payload in place — adds `categoryIntelligence` field.
 *
 * @param {object} payload    — scan response (after signal computation + plan gating)
 * @param {object} opts
 *   redis       {object}
 *   userId      {string|null}
 *   category    {string|null}    — raw category string (will be normalized)
 *   itemText    {string|null}    — concatenated title + description for text analysis
 *   scannedPrice {number|null}
 *   medianMarket {number|null}   — median from comps
 *   metro       {string|null}    — metro area slug for local market adj
 *   plan        {string}         — "free" | "pro" | "internal"
 *
 * @returns {object} payload
 */
export async function applyCategoryIntelligenceToPayload(payload, {
  redis        = null,
  userId       = null,
  category     = null,
  itemText     = "",
  scannedPrice = null,
  medianMarket = null,
  metro        = null,
  plan         = "free",
} = {}) {
  if (!payload) return payload;

  const cat     = normalizeCategory(category);
  const profile = getCategoryProfile(cat);

  // Run all enrichment steps concurrently
  const [
    replicaScan,
    defectResult,
    conditionResult,
    calendarContext,
    identityScore,
  ] = await Promise.all([
    // 1. Replica marker scan
    profile.hasKnowledgeBase
      ? Promise.resolve(scanReplicaMarkers(cat, itemText, scannedPrice, medianMarket))
      : Promise.resolve(null),

    // 2. Defect impact
    profile.hasKnowledgeBase
      ? Promise.resolve(estimateDefectImpact(cat, itemText))
      : Promise.resolve(null),

    // 3. Category-specific condition
    profile.hasConditionProfile
      ? Promise.resolve(classifyConditionForCategory(cat, itemText))
      : Promise.resolve(null),

    // 4. Calendar context
    profile.hasEventCalendar && redis
      ? getCategoryCalendarContext(redis, cat).catch(() => null)
      : Promise.resolve(null),

    // 5. Category identity score (pro only — no PII risk, but depth is pro feature)
    userId && redis && profile.hasIdentityEngine
      ? computeCategoryIdentityScore(redis, userId, cat, extractIdentityCtx(payload)).catch(() => null)
      : Promise.resolve(null),
  ]);

  // 6. Local market adjustment (synchronous lookup)
  const localMultiplier = profile.hasLocalMarketAdj
    ? getLocalMarketMultiplier(cat, metro)
    : null;

  // ── Assemble categoryIntelligence ─────────────────────────────────────────

  const intel = {
    canonicalCategory: cat,
    replicaRisk:       profile.replicaRisk,
  };

  // Replica scan findings
  if (replicaScan) {
    intel.replicaScan = {
      positiveMarkers:  replicaScan.positiveCount,
      negativeMarkers:  replicaScan.negativeCount,
      redFlagFound:     replicaScan.redFlagFound,
      priceWarning:     replicaScan.priceWarning,
      authenticityTips: replicaScan.authenticityTips?.slice(0, 2) || [],
    };

    // If red flags found and category is HIGH risk, add a warning to payload
    if (replicaScan.redFlagFound && profile.replicaRisk === "HIGH") {
      payload.categoryReplicaFlag = {
        flagged: true,
        reason:  "Replica/fake indicators found in item text.",
        tips:    replicaScan.authenticityTips?.slice(0, 2) || [],
      };
    }

    // If price is suspiciously low vs. market, flag it
    if (replicaScan.priceWarning) {
      payload.categoryReplicaFlag = {
        ...(payload.categoryReplicaFlag || {}),
        priceWarning: true,
        reason: (payload.categoryReplicaFlag?.reason || "") +
                " Price is suspiciously low relative to market median.",
      };
    }
  }

  // Defect impact
  if (defectResult && defectResult.defectsFound.length > 0) {
    intel.defectAnalysis = {
      defectsFound:  defectResult.defectsFound,
      estimatedImpact: defectResult.impact,  // fraction: 0.0–0.90
      impactLabel:   defectImpactLabel(defectResult.impact),
    };
  }

  // Condition classification
  if (conditionResult) {
    intel.conditionClassification = {
      tier:       conditionResult.tier,
      label:      conditionResult.label,
      retention:  conditionResult.retention,
      confidence: conditionResult.confidence,
    };
  }

  // Calendar context
  if (calendarContext?.hasCalendarSignal) {
    intel.calendarContext = {
      marketPressure:  calendarContext.marketPressure,
      contextNote:     calendarContext.contextNote,
      activeEvents:    calendarContext.activeEvents?.slice(0, 2) || [],
      upcomingEvents:  calendarContext.upcomingEvents?.slice(0, 2) || [],
    };
  }

  // Identity score (only for paid plans — depth feature)
  if (identityScore && isPaidPlan(plan)) {
    intel.categoryIdentityScore = {
      score:      identityScore.score,
      confidence: identityScore.confidence,
      signal:     identityScore.signal,
    };
  }

  // Local market adjustment
  if (localMultiplier && localMultiplier !== 1.0 && medianMarket) {
    const adjustedPrice = Math.round(medianMarket * localMultiplier);
    intel.localMarketAdj = {
      metro,
      multiplier:     localMultiplier,
      adjustedMedian: adjustedPrice,
      note:           localMultiplier > 1.0
        ? `${metro} demand premium (~${Math.round((localMultiplier - 1) * 100)}%) above national median`
        : `${metro} demand discount (~${Math.round((1 - localMultiplier) * 100)}%) below national median`,
    };
  }

  payload.categoryIntelligence = intel;
  return payload;
}

// ── Context extractor ─────────────────────────────────────────────────────────
//
// Pulls identity engine context fields from the payload's visionIdentity
// or profitIntel, so callers don't need to pass them separately.

function extractIdentityCtx(payload) {
  const vi = payload?.visionIdentity || {};
  const pi = payload?.profitIntel    || {};
  return {
    brand:        vi.brand        || pi.brand        || null,
    model:        vi.model        || pi.model        || null,
    colorway:     vi.colorway     || vi.color        || null,
    size:         vi.size         || null,
    reference:    vi.reference    || vi.referenceNumber || null,
    material:     vi.material     || null,
    hardware:     vi.hardware     || null,
    storageGB:    vi.storageGB    || vi.storage       || null,
    game:         vi.game         || null,
    set:          vi.set          || vi.setName       || null,
    grade:        vi.grade        || vi.gradingGrade  || null,
  };
}

// ── Record outcome (called from outcome recording flow) ───────────────────────

/**
 * Record a realized outcome into the category identity engine.
 * Called non-blocking from POST /api/outcome or equivalent.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string} rawCategory
 * @param {object} outcome — { isWin, netProfit, buyPrice, sellPrice, ...identityFields }
 */
export async function recordCategoryOutcomeNonBlocking(redis, userId, rawCategory, outcome = {}) {
  if (!redis || !userId) return;
  const cat = normalizeCategory(rawCategory);
  try {
    const { recordCategoryOutcome } = await import("./categoryIdentityEngines/index.js");
    await recordCategoryOutcome(redis, userId, cat, outcome);
  } catch { /* non-fatal */ }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPaidPlan(plan) {
  return plan === "pro" || plan === "internal";
}

function defectImpactLabel(impact) {
  if (impact >= 0.50) return "severe";
  if (impact >= 0.30) return "moderate";
  if (impact >= 0.10) return "minor";
  return "negligible";
}
