// src/ecosystemLeverageEngine.js
// Phase 7 — Ecosystem Leverage Dashboard + Partner Economics Model.
//
// Measures whether Evan is becoming infrastructure. If external trust is real,
// these metrics will show it. If they stay at zero, the trust layer is unused.
//
// Ecosystem leverage metrics answer:
//   - How many verified items have been published externally?
//   - How many certified resellers have active public profiles?
//   - How many trustmark lookups have happened?
//   - How many partner API calls have been made?
//   - Are partners experiencing low dispute rates (evidence of trust quality)?
//   - Are trustmarks being revoked at a healthy vs. alarming rate?
//
// Partner economics model defines the structural monetization layer.
// This is NOT about charging yet — it's about designing the economic
// infrastructure correctly so pricing decisions are coherent later.
//
// Monetization modes:
//   API_SUBSCRIPTION      — flat monthly rate for partner API access
//   VERIFICATION_LOOKUP   — per-lookup fee for /verify/* calls
//   CERTIFICATION_FEE     — reseller certification program fee
//   ROUTE_INTELLIGENCE    — route recommendation API subscription
//   COUNTERFEIT_RISK_API  — counterfeit risk signal subscription
//   VALUATION_API         — per-query valuation API
//   TRUST_PACKET          — per-export fee for portable trust packets
//   GUARANTEE_FEE         — transaction fee on guarantee-backed sales
//   INSTITUTION_ANALYTICS — bulk analytics licensing
//
// Redis key layout:
//   eco:metric:{metricName}                STRING/HASH  aggregate metric
//   eco:partner:{partnerType}:{metric}     HASH         per-partner metric
//   eco:category:{category}:{metric}       HASH         per-category metric
//   eco:ops                                HASH         ops counters

export const ECOSYSTEM_VERSION = "7.0";

export const ECO_METRIC = {
  VERIFIED_ITEMS_EXTERNAL:       "verified_items_published_externally",
  CERTIFIED_RESELLERS_PUBLIC:    "certified_resellers_public",
  TRUSTMARK_LOOKUPS:             "trustmark_lookups",
  PARTNER_API_CALLS:             "partner_api_calls",
  GUARANTEE_LOOKUPS:             "guarantee_lookups",
  ROUTE_OUTCOME_EXPORTS:         "route_outcome_exports",
  TRUST_PACKET_EXPORTS:          "trust_packet_exports",
  PARTNER_DISPUTE_RATE_EVENTS:   "partner_dispute_rate_events",
  TRUSTMARK_REVOCATIONS:         "trustmark_revocations",
  MARKETPLACE_TRUST_USAGE:       "marketplace_trust_usage",
  INSTITUTIONAL_ADOPTION:        "institutional_adoption_signals",
  VERIFICATION_LOOKUPS_PUBLIC:   "verification_lookups_public",
  CLAIM_GOVERNOR_BLOCKS:         "claim_governor_blocks",
  CLAIM_GOVERNOR_SOFTENS:        "claim_governor_softens",
  PARTNER_CONVERSION_EVENTS:     "partner_conversion_events",
};

const KEY_METRIC   = metric                    => `eco:metric:${metric}`;
const KEY_PARTNER  = (partnerType, metric)     => `eco:partner:${partnerType}:${metric}`;
const KEY_CATEGORY = (category, metric)        => `eco:category:${_safe(category)}:${metric}`;
const KEY_CHANNEL  = (channel, metric)         => `eco:channel:${channel}:${metric}`;
const KEY_OPS      = ()                        => `eco:ops`;

// ── Increment metrics ─────────────────────────────────────────────────────────

/**
 * Increment an ecosystem metric counter.
 * Optionally also increments per-partner and per-category breakdowns.
 *
 * @param {object} redis
 * @param {string} metric      — ECO_METRIC.*
 * @param {number} delta       — amount to increment (default 1)
 * @param {object} dimensions  — { partnerType, category, channel, badgeType, riskLevel }
 */
export async function incrementLeverageMetric(redis, metric, delta = 1, {
  partnerType = null,
  category    = null,
  channel     = null,
} = {}) {
  if (!redis || !metric) return;
  try {
    await redis.incrBy(KEY_METRIC(metric), delta);
    if (partnerType) await redis.hIncrBy(KEY_PARTNER(partnerType, metric), "count", delta);
    if (category)    await redis.hIncrBy(KEY_CATEGORY(category, metric),   "count", delta);
    if (channel)     await redis.hIncrBy(KEY_CHANNEL(channel, metric),     "count", delta);
    await redis.hIncrBy(KEY_OPS(), "total_increments", 1);
  } catch { /* non-fatal */ }
}

// ── Get ecosystem metrics ─────────────────────────────────────────────────────

/**
 * Get the full ecosystem leverage metrics snapshot.
 * This is the primary dashboard for Evan's infrastructure status.
 */
export async function getEcosystemMetrics(redis) {
  if (!redis) return _emptyMetrics();
  try {
    const metricKeys   = Object.values(ECO_METRIC);
    const metricValues = await Promise.all(
      metricKeys.map(k => redis.get(KEY_METRIC(k)).then(v => Number(v) || 0).catch(() => 0))
    );

    const metrics = {};
    metricKeys.forEach((k, i) => { metrics[k] = metricValues[i]; });

    return {
      metrics,
      summary: {
        totalVerifiedExternal:    metrics[ECO_METRIC.VERIFIED_ITEMS_EXTERNAL],
        totalCertifiedPublic:     metrics[ECO_METRIC.CERTIFIED_RESELLERS_PUBLIC],
        totalTrustmarkLookups:    metrics[ECO_METRIC.TRUSTMARK_LOOKUPS],
        totalPartnerApiCalls:     metrics[ECO_METRIC.PARTNER_API_CALLS],
        totalGuaranteeLookups:    metrics[ECO_METRIC.GUARANTEE_LOOKUPS],
        totalTrustPacketExports:  metrics[ECO_METRIC.TRUST_PACKET_EXPORTS],
        totalRevocations:         metrics[ECO_METRIC.TRUSTMARK_REVOCATIONS],
        totalInstitutionalSignals:metrics[ECO_METRIC.INSTITUTIONAL_ADOPTION],
        claimGovernorBlockRate: metrics[ECO_METRIC.CLAIM_GOVERNOR_BLOCKS] > 0
          ? Math.round(
              metrics[ECO_METRIC.CLAIM_GOVERNOR_BLOCKS] /
              (metrics[ECO_METRIC.CLAIM_GOVERNOR_BLOCKS] + metrics[ECO_METRIC.CLAIM_GOVERNOR_SOFTENS] + 1) * 100
            ) / 100
          : 0,
      },
      generatedAt:       Date.now(),
      ecosystemVersion:  ECOSYSTEM_VERSION,
    };
  } catch { return _emptyMetrics(); }
}

/**
 * Get per-partner metrics breakdown.
 */
export async function getPartnerMetrics(redis, partnerType) {
  if (!redis || !partnerType) return {};
  try {
    const out = {};
    for (const metric of Object.values(ECO_METRIC)) {
      const raw = await redis.hGet(KEY_PARTNER(partnerType, metric), "count").catch(() => null);
      if (raw) out[metric] = Number(raw) || 0;
    }
    return { partnerType, metrics: out, generatedAt: Date.now() };
  } catch { return {}; }
}

/**
 * Get per-category metrics breakdown.
 */
export async function getCategoryMetrics(redis, category) {
  if (!redis || !category) return {};
  try {
    const out = {};
    for (const metric of [
      ECO_METRIC.VERIFIED_ITEMS_EXTERNAL,
      ECO_METRIC.TRUSTMARK_LOOKUPS,
      ECO_METRIC.TRUSTMARK_REVOCATIONS,
    ]) {
      const raw = await redis.hGet(KEY_CATEGORY(category, metric), "count").catch(() => null);
      if (raw) out[metric] = Number(raw) || 0;
    }
    return { category, metrics: out, generatedAt: Date.now() };
  } catch { return {}; }
}

// ── Partner economics model ───────────────────────────────────────────────────

export const MONETIZATION_MODE = {
  API_SUBSCRIPTION:    "API_SUBSCRIPTION",
  VERIFICATION_LOOKUP: "VERIFICATION_LOOKUP",
  CERTIFICATION_FEE:   "CERTIFICATION_FEE",
  ROUTE_INTELLIGENCE:  "ROUTE_INTELLIGENCE",
  COUNTERFEIT_RISK:    "COUNTERFEIT_RISK_API",
  VALUATION_API:       "VALUATION_API",
  TRUST_PACKET:        "TRUST_PACKET",
  GUARANTEE_FEE:       "GUARANTEE_FEE",
  INSTITUTION_ANALYTICS:"INSTITUTION_ANALYTICS",
};

// Partner economics policies — structural, not operational yet
const PARTNER_ECONOMICS = {
  MARKETPLACE: {
    partnerType:      "MARKETPLACE",
    monetizationMode: [MONETIZATION_MODE.API_SUBSCRIPTION, MONETIZATION_MODE.VERIFICATION_LOOKUP],
    pricingUnit:      "per_month_flat_plus_per_lookup_overage",
    trustDependency:  "HIGH",    // value entirely depends on trust quality
    guaranteeDependency:"MEDIUM",
    dataDependency:   "LOW",
    minimumVolume:    100,       // minimum lookups/month to sustain
    revshareEligible: false,
    contractRequired: true,
    auditRequired:    true,
    economics_version: ECOSYSTEM_VERSION,
  },
  INSURANCE: {
    partnerType:      "INSURANCE",
    monetizationMode: [MONETIZATION_MODE.VALUATION_API, MONETIZATION_MODE.TRUST_PACKET],
    pricingUnit:      "per_query",
    trustDependency:  "HIGH",
    guaranteeDependency:"HIGH",  // guarantee coverage data is core to insurance
    dataDependency:   "HIGH",
    minimumVolume:    50,
    revshareEligible: true,      // revshare on guarantee-backed claims
    contractRequired: true,
    auditRequired:    true,
    economics_version: ECOSYSTEM_VERSION,
  },
  LENDER: {
    partnerType:      "LENDER",
    monetizationMode: [MONETIZATION_MODE.VALUATION_API, MONETIZATION_MODE.VERIFICATION_LOOKUP],
    pricingUnit:      "per_query",
    trustDependency:  "HIGH",
    guaranteeDependency:"LOW",
    dataDependency:   "HIGH",
    minimumVolume:    20,
    revshareEligible: false,
    contractRequired: true,
    auditRequired:    true,
    economics_version: ECOSYSTEM_VERSION,
  },
  RETAILER: {
    partnerType:      "RETAILER",
    monetizationMode: [MONETIZATION_MODE.API_SUBSCRIPTION, MONETIZATION_MODE.COUNTERFEIT_RISK],
    pricingUnit:      "per_month_flat",
    trustDependency:  "MEDIUM",
    guaranteeDependency:"LOW",
    dataDependency:   "MEDIUM",
    minimumVolume:    500,       // higher volume needed (returns are frequent)
    revshareEligible: false,
    contractRequired: true,
    auditRequired:    false,
    economics_version: ECOSYSTEM_VERSION,
  },
  CONSIGNMENT: {
    partnerType:      "CONSIGNMENT",
    monetizationMode: [MONETIZATION_MODE.VERIFICATION_LOOKUP, MONETIZATION_MODE.VALUATION_API],
    pricingUnit:      "per_intake",
    trustDependency:  "HIGH",
    guaranteeDependency:"MEDIUM",
    dataDependency:   "MEDIUM",
    minimumVolume:    30,
    revshareEligible: true,      // revshare on items that sell via consignment after Evan intake
    contractRequired: true,
    auditRequired:    true,
    economics_version: ECOSYSTEM_VERSION,
  },
  AUTH_PROVIDER: {
    partnerType:      "AUTH_PROVIDER",
    monetizationMode: [MONETIZATION_MODE.API_SUBSCRIPTION, MONETIZATION_MODE.COUNTERFEIT_RISK],
    pricingUnit:      "per_month_flat_plus_per_query",
    trustDependency:  "HIGH",
    guaranteeDependency:"LOW",
    dataDependency:   "HIGH",
    minimumVolume:    200,
    revshareEligible: false,
    contractRequired: true,
    auditRequired:    true,
    economics_version: ECOSYSTEM_VERSION,
  },
  ESTATE_LIQUIDATION: {
    partnerType:      "ESTATE_LIQUIDATION",
    monetizationMode: [MONETIZATION_MODE.VALUATION_API, MONETIZATION_MODE.TRUST_PACKET],
    pricingUnit:      "per_item",
    trustDependency:  "MEDIUM",
    guaranteeDependency:"LOW",
    dataDependency:   "HIGH",
    minimumVolume:    10,
    revshareEligible: true,
    contractRequired: true,
    auditRequired:    false,
    economics_version: ECOSYSTEM_VERSION,
  },
};

/**
 * Get the economics policy for a partner type.
 */
export function getPartnerEconomicsPolicy(partnerType) {
  return PARTNER_ECONOMICS[partnerType] || null;
}

/**
 * Get all partner economics policies.
 */
export function getAllPartnerEconomicsPolicies() {
  return Object.values(PARTNER_ECONOMICS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _emptyMetrics() {
  const metrics = {};
  for (const k of Object.values(ECO_METRIC)) metrics[k] = 0;
  return {
    metrics,
    summary: {
      totalVerifiedExternal: 0, totalCertifiedPublic: 0, totalTrustmarkLookups: 0,
      totalPartnerApiCalls: 0, totalGuaranteeLookups: 0, totalTrustPacketExports: 0,
      totalRevocations: 0, totalInstitutionalSignals: 0, claimGovernorBlockRate: 0,
    },
    generatedAt: Date.now(),
    ecosystemVersion: ECOSYSTEM_VERSION,
  };
}

function _safe(id) {
  return String(id || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 50);
}
