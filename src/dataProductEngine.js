// src/dataProductEngine.js
// Phase 6 — Data Product Layer + B2B API Response Models.
//
// Defines the 7 licensable data product schemas and the versioned external-facing
// response contracts for Evan's B2B API.
//
// Data products (future licensing):
//   1. PRICE_FLOOR_INTELLIGENCE      — p10/p25/median price floors by item+category
//   2. PRICE_SPREAD_INDEX            — bid-ask spread + market depth per category
//   3. SELL_VELOCITY_INDEX           — platform-specific median days to sale
//   4. SELLER_RELIABILITY_SCORE      — aggregated seller risk across platforms
//   5. COUNTERFEIT_INCIDENT_FEED     — anonymized counterfeit detection events
//   6. VERIFICATION_TREND_FEED       — verification volume, pass rate, category mix
//   7. ROUTE_PERFORMANCE_INDEX       — routing accuracy + net estimation accuracy per platform
//
// B2B API response contracts (versioned, external-facing):
//   valuationResponse         — standardized valuation output
//   verificationResponse      — Evan-Verified status + claim language
//   sellerRiskResponse        — seller risk scoring for B2B buyers/marketplaces
//   routeRecommendationResponse — sell routing for resellers
//
// Non-negotiables:
//   1. No PII in data products — only platform usernames, never real names or emails.
//   2. Data products are read-only exports — no mutation via this layer.
//   3. All counts are minimum-aggregated (no single-user data is exposed).
//   4. B2B response models are versioned — consumers must specify version.
//   5. Auth evidence is summarized qualitatively — no raw model scores in B2B output.

import { getPlatformLeverageMetrics, getAllLeverageMetrics } from "./routeOutcomeMemory.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DATA_PRODUCT_VERSION = "6.0";
export const B2B_API_VERSION      = "v2";  // increment on breaking changes

// Minimum record count before a data product bucket is exposed externally
// (prevents single-user inference attacks)
const MIN_RECORDS_FOR_EXPORT = 10;

// ── Data product schemas ───────────────────────────────────────────────────────

export const DATA_PRODUCTS = {
  PRICE_FLOOR_INTELLIGENCE: {
    id:          "price_floor_intelligence",
    name:        "Price Floor Intelligence",
    description: "p10, p25, median price floors by item query and category. Updated rolling 90d.",
    fields:      ["query", "category", "p10", "p25", "median", "sampleSize", "windowDays", "computedAt"],
    refreshRate: "daily",
    pricing:     "per_query",
    status:      "available",
  },
  PRICE_SPREAD_INDEX: {
    id:          "price_spread_index",
    name:        "Price Spread Index",
    description: "Bid-ask spread and market depth per category. Indicates buy/sell opportunity.",
    fields:      ["category", "medianAsk", "medianBid", "spread", "spreadPct", "depth", "computedAt"],
    refreshRate: "daily",
    status:      "available",
  },
  SELL_VELOCITY_INDEX: {
    id:          "sell_velocity_index",
    name:        "Sell Velocity Index",
    description: "Observed median days to sale per platform per category, from Evan outcome memory.",
    fields:      ["platformId", "category", "medianDaysToSale", "sampleSize", "computedAt"],
    refreshRate: "weekly",
    status:      "available_when_sufficient_data",
  },
  SELLER_RELIABILITY_SCORE: {
    id:          "seller_reliability_score",
    name:        "Seller Reliability Score",
    description: "Aggregated seller reliability metrics for B2B platforms verifying sellers.",
    fields:      ["platformId", "sellerId", "riskScore", "riskLevel", "evidenceCount", "lastUpdated"],
    refreshRate: "real_time",
    pricing:     "per_lookup",
    status:      "available",
    pii_note:    "Platform username only; no real-name data stored.",
  },
  COUNTERFEIT_INCIDENT_FEED: {
    id:          "counterfeit_incident_feed",
    name:        "Counterfeit Incident Feed",
    description: "Anonymized counterfeit detection events with category, brand, and confidence signal.",
    fields:      ["incidentId", "category", "brand", "verdict", "evidenceStrength", "reportedAt"],
    refreshRate: "real_time",
    pricing:     "subscription",
    status:      "available",
    pii_note:    "No scanId, userId, or item-specific data exposed.",
  },
  VERIFICATION_TREND_FEED: {
    id:          "verification_trend_feed",
    name:        "Verification Trend Feed",
    description: "Aggregated verification volume, pass rates, and category mix over time.",
    fields:      ["date", "category", "verificationCount", "passRate", "expertReviewRate"],
    refreshRate: "daily",
    status:      "available",
  },
  ROUTE_PERFORMANCE_INDEX: {
    id:          "route_performance_index",
    name:        "Route Performance Index",
    description: "Routing accuracy and net estimation accuracy per platform, from outcome memory.",
    fields:      ["platformId", "totalOutcomes", "avgRouteAccuracy", "netAccuracyRate", "avgDaysError"],
    refreshRate: "weekly",
    status:      "available_when_sufficient_data",
  },
};

// ── Data product readiness check ───────────────────────────────────────────────

/**
 * Check which data products are ready for external exposure.
 * "Ready" means: sufficient data AND minimum aggregation thresholds met.
 *
 * @param {object} redis
 * @param {object} opts
 *   verificationOps  {object}  — from getVerificationOps()
 *   trustmarkOps     {object}  — from getTrustmarkOps()
 *   priceFloorOps    {object}  — from getPriceFloorOps() (if available)
 * @returns {Promise<DataProductReadinessReport>}
 */
export async function getDataProductReadiness(redis, {
  verificationOps = {},
  trustmarkOps    = {},
  priceFloorOps   = {},
} = {}) {
  const leverageMetrics = redis ? await getAllLeverageMetrics(redis).catch(() => ({})) : {};

  const totalVerifications = verificationOps.total || 0;
  const totalTrustmarks    = trustmarkOps.issued    || 0;
  const totalOutcomes      = Object.values(leverageMetrics)
    .reduce((acc, m) => acc + (m?.totalOutcomes || 0), 0);

  const products = {};

  for (const [key, schema] of Object.entries(DATA_PRODUCTS)) {
    let ready      = false;
    let readyScore = 0;
    let notes      = "";

    switch (schema.id) {
      case "price_floor_intelligence":
        ready      = totalVerifications >= MIN_RECORDS_FOR_EXPORT;
        readyScore = Math.min(1, totalVerifications / 100);
        notes      = `${totalVerifications} verification records`;
        break;

      case "price_spread_index":
        ready      = totalVerifications >= MIN_RECORDS_FOR_EXPORT * 5;
        readyScore = Math.min(1, totalVerifications / 500);
        notes      = `${totalVerifications} records (need 50+ for spread computation)`;
        break;

      case "sell_velocity_index":
        ready      = totalOutcomes >= MIN_RECORDS_FOR_EXPORT;
        readyScore = Math.min(1, totalOutcomes / 50);
        notes      = `${totalOutcomes} outcome records across platforms`;
        break;

      case "seller_reliability_score":
        ready      = true;   // real-time per-lookup — always available
        readyScore = 1;
        notes      = "Per-lookup; requires minimum 3 events per seller for non-null score";
        break;

      case "counterfeit_incident_feed":
        ready      = totalVerifications >= MIN_RECORDS_FOR_EXPORT;
        readyScore = Math.min(1, totalVerifications / 50);
        notes      = "Anonymized; no PII. Feed suppressed below 10 verifications.";
        break;

      case "verification_trend_feed":
        ready      = totalVerifications >= MIN_RECORDS_FOR_EXPORT;
        readyScore = Math.min(1, totalVerifications / 100);
        notes      = `${totalVerifications} verifications; ${totalTrustmarks} trustmarks issued`;
        break;

      case "route_performance_index":
        ready      = totalOutcomes >= MIN_RECORDS_FOR_EXPORT;
        readyScore = Math.min(1, totalOutcomes / 30);
        notes      = `${totalOutcomes} route outcome records`;
        break;
    }

    products[schema.id] = {
      ...schema,
      ready,
      readyScore:  Math.round(readyScore * 100) / 100,
      notes,
    };
  }

  return {
    products,
    summary: {
      totalVerifications,
      totalTrustmarks,
      totalRouteOutcomes: totalOutcomes,
      readyCount:   Object.values(products).filter(p => p.ready).length,
      totalProducts: Object.keys(products).length,
    },
    generatedAt:     Date.now(),
    dataProductVersion: DATA_PRODUCT_VERSION,
  };
}

// ── Route performance index ────────────────────────────────────────────────────

/**
 * Build the Route Performance Index data product.
 * Only exported if sufficient outcome data exists.
 */
export async function buildRoutePerformanceIndex(redis) {
  if (!redis) return null;
  const metrics = await getAllLeverageMetrics(redis);

  const rows = [];
  for (const [platformId, m] of Object.entries(metrics)) {
    if (!m || m.totalOutcomes < MIN_RECORDS_FOR_EXPORT) continue;
    rows.push({
      platformId,
      totalOutcomes:    m.totalOutcomes,
      avgRouteAccuracy: m.avgRouteAccuracy,
      netAccuracyRate:  m.netAccuracyRate,
      avgNetError:      m.avgNetError,
      avgDaysError:     m.avgDaysError,
      dataQuality:      m.dataQuality,
      byCategory:       m.byCategory,
    });
  }

  rows.sort((a, b) => b.totalOutcomes - a.totalOutcomes);

  return {
    productId:    "route_performance_index",
    rows,
    rowCount:     rows.length,
    generatedAt:  Date.now(),
    version:      DATA_PRODUCT_VERSION,
  };
}

// ── B2B API Response Models ───────────────────────────────────────────────────

/**
 * Build a standardized B2B valuation response.
 * Used by POST /api/b2b/valuate
 *
 * @param {object} internalResult — internal valuation result from categoryDominationEngine
 * @param {string} requestId
 * @returns {object} B2B valuation response
 */
export function buildB2BValuationResponse(internalResult, requestId = null) {
  if (!internalResult) return _b2bError("no_result", requestId);

  const {
    query, category,
    priceFloor, priceCeiling, marketMedian,
    confidence, dataSource, soldsFound,
    recommendation,
  } = internalResult;

  return {
    api_version:   B2B_API_VERSION,
    request_id:    requestId,
    object:        "valuation",
    query:         query || null,
    category:      category || null,
    pricing: {
      floor:       priceFloor    || null,
      ceiling:     priceCeiling  || null,
      median:      marketMedian  || null,
      confidence:  confidence    || null,
    },
    market: {
      dataSource:  dataSource    || null,
      soldsFound:  soldsFound    || null,
    },
    recommendation: recommendation || null,
    generated_at:  Date.now(),
  };
}

/**
 * Build a standardized B2B verification response.
 * Used by POST /api/b2b/trust-verify
 *
 * @param {object} evanVerification — Phase 5 evanVerification record
 * @param {object} trustmarkRecord  — trustmark record (if exists)
 * @param {string} requestId
 * @returns {object} B2B verification response
 */
export function buildB2BVerificationResponse(evanVerification, trustmarkRecord, requestId = null) {
  if (!evanVerification) return _b2bError("no_verification_record", requestId);

  const isVerified = evanVerification.status === "VERIFIED";
  const tm         = trustmarkRecord;

  return {
    api_version:      B2B_API_VERSION,
    request_id:       requestId,
    object:           "verification",
    verified:         isVerified,
    verification: {
      status:         evanVerification.status,
      trustState:     evanVerification.trustState     || null,
      evidenceLevel:  evanVerification.evidenceLevel  || null,
      expertReviewed: evanVerification.expertReviewed || false,
      expertVerdict:  evanVerification.expertVerdict  || null,
      // Qualitative auth summary only — no raw model scores
      authSummary:    evanVerification.authSummary    || null,
    },
    trustmark: tm ? {
      trustmarkId:    tm.trustmarkId,
      referenceId:    tm.referenceId,
      status:         tm.status,
      issuedAt:       tm.issuedAt,
      expiresAt:      tm.expiresAt,
      evidenceLevel:  tm.verificationSummary?.evidenceStrength || null,
    } : null,
    claim_language:   isVerified ? (evanVerification.claimLanguage || null) : null,
    generated_at:     Date.now(),
  };
}

/**
 * Build a standardized B2B seller risk response.
 * Used by POST /api/b2b/seller-risk
 *
 * @param {object} counterpartyResult — from getCounterpartyRisk()
 * @param {object} certRecord         — from getCertificationRecord() (if available)
 * @param {string} requestId
 * @returns {object} B2B seller risk response
 */
export function buildB2BSellerRiskResponse(counterpartyResult, certRecord, requestId = null) {
  if (!counterpartyResult) return _b2bError("no_counterparty_data", requestId);

  const isCertified = certRecord?.status === "CERTIFIED";

  return {
    api_version:   B2B_API_VERSION,
    request_id:    requestId,
    object:        "seller_risk",
    platform:      counterpartyResult.platformId   || null,
    // Note: sellerId is platform username, never real name
    risk: {
      score:       counterpartyResult.counterpartyRisk,
      level:       counterpartyResult.riskLevel,
      scamFlagged: counterpartyResult.scamFlagged  || false,
      dataQuality: counterpartyResult.dataQuality  || "NO_DATA",
    },
    certification: isCertified ? {
      status:     certRecord.status,
      tier:       certRecord.tier,
      dealIQScore:certRecord.dealIQ?.overallScore || null,
      certifiedAt:certRecord.certifiedAt,
      expiresAt:  certRecord.expiresAt,
    } : null,
    generated_at:  Date.now(),
  };
}

/**
 * Build a standardized B2B route recommendation response.
 * Used by POST /api/b2b/route-recommend
 *
 * @param {object} sellRouting — from computeSellRouting()
 * @param {string} requestId
 * @returns {object} B2B route recommendation response
 */
export function buildB2BRouteRecommendationResponse(sellRouting, requestId = null) {
  if (!sellRouting) return _b2bError("no_routing_result", requestId);
  if (sellRouting.is_fallback) return _b2bError(sellRouting.reasonCodes?.[0] || "routing_failed", requestId);

  const top = (sellRouting.platformOptions || []).find(
    p => p.platformId === sellRouting.recommendedPlatform
  );

  return {
    api_version:          B2B_API_VERSION,
    request_id:           requestId,
    object:               "route_recommendation",
    recommended_platform: sellRouting.recommendedPlatform,
    confidence:           sellRouting.confidence,
    input: {
      price:              sellRouting.inputPrice,
      category:           sellRouting.category,
      condition:          sellRouting.condition,
      sell_urgency:       sellRouting.sellUrgency,
    },
    top_option: top ? {
      platform:           top.displayName,
      net_expected:       top.netExpected,
      risk_adjusted_net:  top.riskAdjustedNet,
      confidence_adjusted_net: top.confidenceAdjustedNet,
      expected_days:      top.expectedDaysToSale,
      fee_pct:            top.feePct,
      // Trust adjustments: qualitative only
      trust_bonus:        top.trustAdjustment?.bonusReason   || null,
      trust_penalty:      top.trustAdjustment?.penaltyReason || null,
      tradeoff:           top.tradeoffSummary,
    } : null,
    alternatives: (sellRouting.platformOptions || [])
      .filter(p => p.eligible && p.platformId !== sellRouting.recommendedPlatform)
      .slice(0, 3)
      .map(p => ({
        platform:     p.displayName,
        net_adjusted: p.confidenceAdjustedNet,
        expected_days:p.expectedDaysToSale,
        tradeoff:     p.tradeoffSummary,
      })),
    reason_codes:         sellRouting.reasonCodes,
    monetization_policy:  sellRouting.monetizationPolicyCleared
      ? "user_aligned"
      : "review_required",
    generated_at:         Date.now(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _b2bError(code, requestId) {
  return {
    api_version:  B2B_API_VERSION,
    request_id:   requestId,
    error:        code,
    generated_at: Date.now(),
  };
}
