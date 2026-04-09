// src/partnerDashboardEngine.js
// Phase 9 — Partner Dashboard Engine.
//
// Operational visibility for partners: usage metrics, conversion tracking,
// trust health, webhook status, and schema pin status — all scoped per partner.
//
// Dashboard snapshot includes:
//   - API usage: calls today/this hour vs rate limit
//   - Trust activity: verifications resolved, packets built, widgets rendered
//   - Conversion metrics: downstream_trust_id attributions, total conversion value
//   - Webhook health: delivery success rate, pending retries
//   - Compliance status: approval rate, block events
//   - Schema pins: which versions are pinned per endpoint
//
// Redis key layout:
//   p9:dash:snapshot:{partnerId}   STRING  cached dashboard snapshot (5min TTL)
//   p9:dash:ops                    HASH    aggregate counters

import { getPartner, checkPartnerRateLimit, getPartnerAuditLog, TIER_RATE_LIMITS } from "./partnerAuthTierEngine.js";
import { getComplianceAuditLog, getComplianceOps } from "./embeddedComplianceGuard.js";
import { getPartnerAnalyticsEvents, getAnalyticsOps } from "./embeddedAnalyticsEngine.js";
import { getPartnerWebhooks, getWebhookOps } from "./partnerWebhookEngine.js";
import { getPartnerSchemaPins, getAllCurrentSchemas } from "./partnerSchemaContracts.js";
import { getWidgetOps } from "./embedWidgetEngine.js";
import { getFailsafeOps } from "./embeddedFailsafeEngine.js";
import { getTrustPacketOps } from "./marketplaceTrustPacketEngine.js";

export const DASHBOARD_VERSION = "9.0";

const SNAPSHOT_TTL = 5 * 60;  // 5 minute cache

// ── Core dashboard builder ─────────────────────────────────────────────────

/**
 * Build a full dashboard snapshot for a partner.
 *
 * @param {object} redis
 * @param {string} partnerId
 * @param {object} opts
 *   forceRefresh {boolean}  — bypass cache
 * @returns {DashboardSnapshot}
 */
export async function buildPartnerDashboard(redis, partnerId, { forceRefresh = false } = {}) {
  if (!redis || !partnerId) return { ok: false, error: "missing_params" };

  // Cache check
  if (!forceRefresh) {
    try {
      const cached = await redis.get(`p9:dash:snapshot:${_safe(partnerId)}`);
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip */ }
  }

  const [
    partner,
    complianceLog,
    analyticsEvents,
    webhooks,
    schemaPins,
    complianceOps,
    analyticsOps,
    webhookOps,
    widgetOps,
    failsafeOps,
    trustPacketOps,
  ] = await Promise.all([
    getPartner(redis, partnerId),
    getComplianceAuditLog(redis, partnerId, { limit: 20 }),
    getPartnerAnalyticsEvents(redis, partnerId, { limit: 20 }),
    getPartnerWebhooks(redis, partnerId),
    getPartnerSchemaPins(redis, partnerId),
    getComplianceOps(redis),
    getAnalyticsOps(redis),
    getWebhookOps(redis),
    getWidgetOps(redis),
    getFailsafeOps(redis),
    getTrustPacketOps(redis),
  ]);

  if (!partner) return { ok: false, error: "partner_not_found", partnerId };

  // Rate limit status
  const rateLimitStatus = await _getRateLimitStatus(redis, partnerId, partner.tier);

  // Compliance health
  const totalDecisions  = complianceOps.approved + complianceOps.degraded +
    complianceOps.blockedGovernance + complianceOps.blockedChannel + complianceOps.blockedJwt;
  const approvalRate    = totalDecisions > 0
    ? Math.round(((complianceOps.approved + complianceOps.degraded) / totalDecisions) * 100)
    : 100;

  // Webhook health
  const totalDeliveries = webhookOps.deliveriesOk + webhookOps.deliveriesFailed;
  const webhookSuccessRate = totalDeliveries > 0
    ? Math.round((webhookOps.deliveriesOk / totalDeliveries) * 100)
    : 100;

  // Recent conversion events from analytics
  const conversions = analyticsEvents.filter(e => e.eventType === "PURCHASE_ATTRIBUTED" || e.eventType === "RESALE_COMPLETED");

  const snapshot = {
    ok:              true,
    partnerId,
    partnerName:     partner.name || partnerId,
    tier:            partner.tier,
    status:          partner.status,
    generatedAt:     Date.now(),
    dashboardVersion: DASHBOARD_VERSION,

    apiUsage: {
      ...rateLimitStatus,
      tier: partner.tier,
    },

    trustActivity: {
      widgetsRendered:   widgetOps.widgetsRendered   || 0,
      packetsBuilt:      (trustPacketOps.marketplaceBuilt || 0) + (trustPacketOps.sellerBuilt || 0) +
                         (trustPacketOps.valuationBuilt || 0) + (trustPacketOps.guaranteeBuilt || 0),
      marketplacePackets: trustPacketOps.marketplaceBuilt   || 0,
      sellerPackets:      trustPacketOps.sellerBuilt         || 0,
      noncesIssued:       widgetOps.noncesIssued             || 0,
      domainsRegistered:  widgetOps.domainsRegistered        || 0,
    },

    conversions: {
      total:               analyticsOps.conversions          || 0,
      totalConversionValue: analyticsOps.totalConversionValue || 0,
      recentConversions:   conversions.slice(0, 5),
      widgetViews:         analyticsOps.widgetViews          || 0,
      badgeClicks:         analyticsOps.badgeClicks          || 0,
    },

    complianceHealth: {
      approvalRate,
      totalDecisions,
      approved:          complianceOps.approved          || 0,
      degraded:          complianceOps.degraded          || 0,
      blockedGovernance: complianceOps.blockedGovernance || 0,
      blockedChannel:    complianceOps.blockedChannel    || 0,
      recentEvents:      complianceLog.slice(0, 5),
    },

    webhookHealth: {
      endpoints:        webhooks.length,
      successRate:      webhookSuccessRate,
      deliveriesOk:     webhookOps.deliveriesOk         || 0,
      deliveriesFailed: webhookOps.deliveriesFailed      || 0,
      exhausted:        webhookOps.deliveriesExhausted   || 0,
      activeEndpoints:  webhooks.filter(w => w.active).length,
    },

    failsafeHealth: {
      staleServes:      failsafeOps.staleServes             || 0,
      revokedBlocks:    failsafeOps.revokedBlocks           || 0,
      expiredServes:    failsafeOps.expiredServes           || 0,
      rateLimitBlocks:  failsafeOps.rateLimitedBlocks       || 0,
    },

    schemaPins,
    currentSchemas: getAllCurrentSchemas().map(s => ({ endpoint: s.endpoint, version: s.version })),

    overallHealth: _computeOverallHealth({
      approvalRate,
      webhookSuccessRate,
      failsafeOps,
      rateLimitStatus,
    }),
  };

  // Cache
  try {
    await redis.set(`p9:dash:snapshot:${_safe(partnerId)}`, JSON.stringify(snapshot), { EX: SNAPSHOT_TTL });
  } catch { /* non-critical */ }

  await redis.hIncrBy("p9:dash:ops", "snapshots_built", 1).catch(() => {});
  return snapshot;
}

/**
 * Get partner dashboard ops.
 */
export async function getDashboardOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:dash:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return { snapshotsBuilt: ops["snapshots_built"] || 0 };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function _getRateLimitStatus(redis, partnerId, tier) {
  if (!redis) return { hourly: { used: 0, limit: 0 }, daily: { used: 0, limit: 0 } };
  try {
    const limits = TIER_RATE_LIMITS[tier] || { perHour: 100, perDay: 1000 };
    const now    = Date.now();
    const hBucket = Math.floor(now / 3_600_000);
    const dBucket = Math.floor(now / 86_400_000);

    const [hCount, dCount] = await Promise.all([
      redis.get(`p9:rate:${_safe(partnerId)}:h:${hBucket}`),
      redis.get(`p9:rate:${_safe(partnerId)}:d:${dBucket}`),
    ]);

    return {
      hourly: { used: Number(hCount) || 0, limit: limits.perHour },
      daily:  { used: Number(dCount) || 0, limit: limits.perDay  },
    };
  } catch {
    return { hourly: { used: 0, limit: 0 }, daily: { used: 0, limit: 0 } };
  }
}

function _computeOverallHealth({ approvalRate, webhookSuccessRate, failsafeOps, rateLimitStatus }) {
  if (failsafeOps.revokedBlocks > 0)  return "CRITICAL";
  if (approvalRate < 70)              return "DEGRADED";
  if (webhookSuccessRate < 80)        return "DEGRADED";
  if (approvalRate < 90)              return "MONITOR";
  if (webhookSuccessRate < 95)        return "MONITOR";
  return "HEALTHY";
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
