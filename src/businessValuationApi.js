// src/businessValuationApi.js
// B2B Valuation API Engine — Phase 12: Market Ownership / B2B Foundation.
//
// Produces structured market valuations for B2B clients using Evan's
// accumulated price index and calibration data. Does NOT run live scans —
// valuations are derived entirely from the category price index.
//
// HONESTY RULES (non-negotiable):
//   - Never fabricate confidence for data-poor categories.
//   - If the category lacks a price index, return failureReason = "category_not_indexed".
//   - Calibration warnings are NEVER suppressed for enterprise clients.
//   - B2B output is never more optimistic than consumer output for the same data.
//   - Grade C categories are returned with explicit low-confidence warnings.
//
// Failure reasons:
//   category_not_indexed    — no price index data for this category
//   insufficient_samples    — grade INSUFFICIENT (< 10 samples)
//   query_too_vague         — query string too short to resolve
//   price_index_unavailable — Redis error or data access failure
//   internal_error          — unexpected error (batch only)

import { getCategoryPriceIndex, assessValuationEligibility } from "./priceIndexEngine.js";

// Confidence by index grade (conservative ceiling — never overstated)
const GRADE_CONFIDENCE = { A: 0.85, B: 0.70, C: 0.45 };

const GRADE_LABELS = {
  A:            "high_confidence",
  B:            "moderate_confidence",
  C:            "low_confidence",
  INSUFFICIENT: "unresolved",
};

// Maximum items per batch request
export const B2B_BATCH_MAX = 25;

// ── Single-item valuation ─────────────────────────────────────────────────────

/**
 * Produce a market valuation for a single item.
 *
 * @param {object} redis
 * @param {object} params
 *   query     {string}       Item description (required, min 3 chars)
 *   category  {string}       Product category (required)
 *   askPrice  {number|null}  Client's current listing price (optional)
 *   itemRef   {string|null}  Client-provided pass-through reference ID
 * @returns {ValuationResult}
 */
export async function valuateItem(redis, { query, category, askPrice = null, itemRef = null } = {}) {
  // Load price index ahead of the shared builder so errors are catchable here
  let priceIndex = null;
  if (category && String(category).trim().length >= 2) {
    try {
      priceIndex = await getCategoryPriceIndex(redis, category);
    } catch {
      return _fail(itemRef, query, category, "price_index_unavailable");
    }
  }

  return _buildValuation({ query, category, askPrice, itemRef, priceIndex });
}

// ── Batch valuation ───────────────────────────────────────────────────────────

/**
 * Valuate a batch of items.
 * Capped at B2B_BATCH_MAX items. Items sharing a category reuse the same
 * price index lookup (one Redis round-trip per unique category).
 *
 * @param {object}   redis
 * @param {Array<{ query, category, askPrice?, itemRef? }>} items
 * @returns {BatchValuationResult}
 */
export async function valuateBatch(redis, items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "items_required", results: [] };
  }

  const batch = items.slice(0, B2B_BATCH_MAX);

  // Pre-fetch one price index per unique category
  const categories = [...new Set(batch.map((i) => i.category).filter(Boolean))];
  const indexMap   = {};
  await Promise.all(
    categories.map(async (cat) => {
      try {
        indexMap[cat] = await getCategoryPriceIndex(redis, cat);
      } catch {
        indexMap[cat] = null;
      }
    })
  );

  const results = await Promise.all(
    batch.map(async (item) => {
      try {
        const { query, category, askPrice, itemRef } = item;
        const priceIndex = indexMap[category] ?? null;
        return _buildValuation({ query, category, askPrice, itemRef, priceIndex });
      } catch {
        return _fail(item.itemRef ?? null, item.query ?? null, item.category ?? null, "internal_error");
      }
    })
  );

  return {
    ok:          true,
    count:       results.length,
    succeeded:   results.filter((r) => r.ok).length,
    failed:      results.filter((r) => !r.ok).length,
    results,
    generatedAt: new Date().toISOString(),
  };
}

// ── Core valuation builder (synchronous path after index is loaded) ───────────

function _buildValuation({ query, category, askPrice, itemRef, priceIndex }) {
  const base = {
    ok:            false,
    itemRef:       itemRef ?? null,
    query:         query   ?? null,
    category:      category ?? null,
    valuation:     null,
    confidence:    null,
    calibration:   null,
    warnings:      [],
    failureReason: null,
    generatedAt:   new Date().toISOString(),
  };

  if (!query || String(query).trim().length < 3) {
    return { ...base, failureReason: "query_too_vague" };
  }
  if (!category || String(category).trim().length < 2) {
    return { ...base, failureReason: "category_not_indexed" };
  }
  if (!priceIndex) {
    return { ...base, failureReason: "price_index_unavailable" };
  }

  const eligibility = assessValuationEligibility(priceIndex);
  if (!eligibility.ready) {
    return {
      ...base,
      failureReason: "insufficient_samples",
      valuation: {
        indexGrade:  "INSUFFICIENT",
        sampleCount: priceIndex.sampleCount ?? 0,
        _reason:     priceIndex._reason ?? null,
      },
    };
  }

  const { medianPrice, p25, p75, spread, priceRange, indexGrade, sampleCount, calibration } = priceIndex;

  // Accumulate warnings — never suppress
  const warnings = [];
  if (indexGrade === "C") {
    warnings.push("limited_price_data: fewer than 30 price samples for this category");
  }
  if (spread != null && spread > 0.5) {
    warnings.push("high_price_spread: market prices vary significantly — likely mixed conditions or variants");
  }
  if (calibration && calibration.isCalibrated === false) {
    warnings.push("calibration_pending: win-rate calibration is not yet available for this category");
  }
  if (calibration && calibration.sbWinRate != null && calibration.sbWinRate < 70) {
    warnings.push(`signal_underperforming: STRONG BUY win rate is ${calibration.sbWinRate}% (target ≥80%)`);
  }

  // Deal-strength context when askPrice is provided
  let dealContext = null;
  if (askPrice != null && medianPrice > 0) {
    const vsMedian = round2((medianPrice - Number(askPrice)) / medianPrice);
    const assessment =
      vsMedian >= 0.25 ? "well_below_market"
      : vsMedian >= 0.10 ? "below_market"
      : vsMedian >= -0.05 ? "at_market"
      : vsMedian >= -0.20 ? "above_market"
      : "significantly_above_market";

    if (vsMedian < -0.30) {
      warnings.push("ask_above_market: ask price is >30% above category median — slow sale likely");
    }

    dealContext = {
      askPrice:   round2(Number(askPrice)),
      vsMedian,
      assessment,
    };
  }

  // Confidence: grade baseline adjusted for calibration quality
  let confidence = GRADE_CONFIDENCE[indexGrade] ?? 0.45;
  if (calibration?.isCalibrated === true)   confidence = Math.min(1.0, confidence + 0.05);
  if (calibration?.calSamples >= 50)        confidence = Math.min(1.0, confidence + 0.03);
  if (indexGrade === "C")                   confidence = Math.max(0.35, confidence - 0.05);
  confidence = round2(confidence);

  return {
    ok:       true,
    itemRef:  itemRef  ?? null,
    query:    query    ?? null,
    category: category ?? null,

    valuation: {
      marketMedian:   medianPrice,
      p25,
      p75,
      priceRange,
      spread,
      sampleCount,
      indexGrade,
      valuationLabel: GRADE_LABELS[indexGrade] || "unresolved",
      dealContext,
    },

    confidence,

    calibration: calibration
      ? {
          sbWinRate:    calibration.sbWinRate    ?? null,
          gdWinRate:    calibration.gdWinRate    ?? null,
          isCalibrated: calibration.isCalibrated ?? false,
          calSamples:   calibration.calSamples   ?? null,
          health:       calibration.health       ?? null,
        }
      : null,

    warnings,
    failureReason: null,
    generatedAt:   new Date().toISOString(),
  };
}

function _fail(itemRef, query, category, reason) {
  return {
    ok:            false,
    itemRef:       itemRef   ?? null,
    query:         query     ?? null,
    category:      category  ?? null,
    valuation:     null,
    confidence:    null,
    calibration:   null,
    warnings:      [],
    failureReason: reason,
    generatedAt:   new Date().toISOString(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(v) {
  return v != null ? Math.round(Number(v) * 100) / 100 : null;
}
