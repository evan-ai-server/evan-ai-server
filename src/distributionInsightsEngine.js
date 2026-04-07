// src/distributionInsightsEngine.js
// Phase 8 — Distribution Insights + Trustmark Safety Monitor.
//
// Two responsibilities:
//
//   1. DISTRIBUTION PLAYBOOK
//      Generates channel-by-channel distribution recommendations for
//      a reseller or item, based on:
//        - Category performance signals
//        - Partner network coverage
//        - Current sell routing intelligence
//        - Certification tier
//        - Trust footprint (external engagement score)
//
//   2. TRUSTMARK SAFETY MONITOR
//      Continuously monitors the trustmark ecosystem for:
//        - Expired trustmarks still displaying (stale trust)
//        - High feedback rates on verified items (trust degradation)
//        - Unusual partner API patterns (potential abuse)
//        - Category-level anomalies (sudden spike in disputes)
//        - Leaderboard health (top items + resellers quality check)
//
// Redis key layout:
//   dist:playbook:{userId}         STRING  cached playbook (12h TTL)
//   dist:monitor:alerts            ZSET    active alerts by severity score
//   dist:monitor:log               ZSET    monitor run log by timestamp
//   dist:ops                       HASH    aggregate counters

import { getCategoryAdoptionScores, getTopEngagedItems, getTopActiveResellers, getUsageOps } from "./externalUsageTracker.js";
import { getFeedbackOps, getRevocationFlags } from "./externalFeedbackEngine.js";
import { getSandboxOps } from "./partnerSandboxEngine.js";

export const DISTRIBUTION_VERSION = "8.0";

// ── Distribution channel configs ──────────────────────────────────────────────

const DISTRIBUTION_CHANNELS = {
  ebay: {
    id:         "ebay",
    label:      "eBay",
    type:       "marketplace",
    reach:      "massive",
    trustValue: "high",      // Evan trust language has high value here
    bestFor:    ["electronics", "collectibles", "sneakers", "watches"],
    minTier:    null,        // no cert required
  },
  grailed: {
    id:         "grailed",
    label:      "Grailed",
    type:       "marketplace",
    reach:      "targeted",
    trustValue: "very_high", // fashion buyers are trust-sensitive
    bestFor:    ["streetwear", "designer", "vintage"],
    minTier:    null,
  },
  poshmark: {
    id:         "poshmark",
    label:      "Poshmark",
    type:       "marketplace",
    reach:      "large",
    trustValue: "high",
    bestFor:    ["womens_fashion", "handbags", "accessories"],
    minTier:    null,
  },
  mercari: {
    id:         "mercari",
    label:      "Mercari",
    type:       "marketplace",
    reach:      "large",
    trustValue: "medium",    // less trust-sensitive buyer base
    bestFor:    ["general", "toys", "home_goods"],
    minTier:    null,
  },
  facebook: {
    id:         "facebook",
    label:      "Facebook Marketplace",
    type:       "marketplace",
    reach:      "local",
    trustValue: "high",      // local buyers want proof of trust
    bestFor:    ["furniture", "electronics", "cars"],
    minTier:    null,
  },
  consignment: {
    id:         "consignment",
    label:      "Consignment Partners",
    type:       "partner",
    reach:      "curated",
    trustValue: "very_high",
    bestFor:    ["luxury", "watches", "handbags", "sneakers"],
    minTier:    "ADVANCED",  // requires advanced cert
  },
  institutional: {
    id:         "institutional",
    label:      "Institutional Buyers",
    type:       "partner",
    reach:      "limited",
    trustValue: "very_high",
    bestFor:    ["high_value", "rare", "collectibles"],
    minTier:    "PRO",
  },
};

const PLAYBOOK_TTL = 12 * 3600;

// ── Distribution playbook ─────────────────────────────────────────────────────

/**
 * Build a distribution channel playbook for a reseller or item.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId            {string|null}
 *   certTier          {string|null}     — "STANDARD"|"ADVANCED"|"PRO"
 *   category          {string|null}
 *   subCategory       {string|null}
 *   price             {number|null}
 *   isVerified        {boolean}
 *   isCertified       {boolean}
 *   engagementScore   {number}          — from externalUsageTracker
 *   sellRouting       {object|null}     — from sellRoutingEngine
 * @returns {PlaybookResult}
 */
export async function buildDistributionPlaybook(redis, {
  userId          = null,
  certTier        = null,
  category        = null,
  subCategory     = null,
  price           = null,
  isVerified      = false,
  isCertified     = false,
  engagementScore = 0,
  sellRouting     = null,
} = {}) {
  if (!redis) return { ok: false, error: "no_redis" };

  // Check cache
  if (userId) {
    try {
      const cached = await redis.get(`dist:playbook:${_safe(userId)}`);
      if (cached) return { ...JSON.parse(cached), fromCache: true };
    } catch { /* skip cache */ }
  }

  // Get category adoption signals
  const categoryScores = await getCategoryAdoptionScores(redis, 20);
  const catScore = categoryScores.find(c => c.category === _safe(category))?.adoptionScore || 0;

  // Score each channel
  const recommendations = [];

  for (const [channelId, cfg] of Object.entries(DISTRIBUTION_CHANNELS)) {
    const score = _scoreChannel({
      cfg, category, subCategory, price, certTier,
      isVerified, isCertified, engagementScore, catScore, sellRouting,
    });

    if (score.eligible) {
      recommendations.push({
        channelId,
        label:       cfg.label,
        type:        cfg.type,
        priority:    score.priority,
        score:       score.total,
        eligible:    true,
        reasons:     score.reasons,
        tips:        _getChannelTips({ cfg, isVerified, isCertified, certTier, price }),
        trustValue:  cfg.trustValue,
      });
    }
  }

  // Sort by priority then score
  recommendations.sort((a, b) => {
    const pOrder = { primary: 0, secondary: 1, tertiary: 2 };
    const pDiff  = (pOrder[a.priority] ?? 9) - (pOrder[b.priority] ?? 9);
    return pDiff !== 0 ? pDiff : b.score - a.score;
  });

  const playbook = {
    ok:              true,
    userId,
    category,
    isVerified,
    isCertified,
    certTier,
    recommendations,
    topChannel:      recommendations[0] || null,
    totalChannels:   recommendations.length,
    trustFootprint:  _describeTrustFootprint(engagementScore),
    generatedAt:     Date.now(),
    distributionVersion: DISTRIBUTION_VERSION,
  };

  // Cache
  if (userId && redis) {
    try {
      await redis.set(`dist:playbook:${_safe(userId)}`, JSON.stringify(playbook), { EX: PLAYBOOK_TTL });
    } catch { /* non-critical */ }
  }

  return playbook;
}

// ── Trustmark safety monitor ──────────────────────────────────────────────────

/**
 * Run a full trustmark safety monitor scan.
 * Checks for trust integrity issues across the ecosystem.
 *
 * @param {object} redis
 * @returns {MonitorResult}
 */
export async function runTrustmarkSafetyMonitor(redis) {
  if (!redis) return { ok: false, error: "no_redis" };

  const now    = Date.now();
  const alerts = [];

  try {
    // 1. Check feedback health
    const feedbackOps = await getFeedbackOps(redis);
    if (feedbackOps.bySeverity?.critical > 0) {
      alerts.push({
        alertId:  `mon_crit_${now}`,
        type:     "HIGH_CRITICAL_FEEDBACK",
        severity: "HIGH",
        message:  `${feedbackOps.bySeverity.critical} critical feedback reports pending review`,
        data:     { criticalCount: feedbackOps.bySeverity.critical },
        firedAt:  now,
      });
    }

    // 2. Check revocation flags
    const revocationFlags = await getRevocationFlags(redis, 50);
    if (revocationFlags.length > 0) {
      alerts.push({
        alertId:  `mon_rev_${now}`,
        type:     "REVOCATION_FLAGS_PENDING",
        severity: "CRITICAL",
        message:  `${revocationFlags.length} trust references flagged for revocation review`,
        data:     { flagCount: revocationFlags.length, flags: revocationFlags.slice(0, 5) },
        firedAt:  now,
      });
    }

    // 3. Check usage ops for anomalies
    const usageOps = await getUsageOps(redis);
    const partnerCallRate = usageOps.partnerApiCalls || 0;
    if (partnerCallRate > 10000) {
      alerts.push({
        alertId:  `mon_api_${now}`,
        type:     "HIGH_PARTNER_API_VOLUME",
        severity: "MEDIUM",
        message:  `Unusually high partner API call volume: ${partnerCallRate}`,
        data:     { partnerApiCalls: partnerCallRate },
        firedAt:  now,
      });
    }

    // 4. Sandbox ops health
    const sandboxOps = await getSandboxOps(redis);
    const revokedRatio = sandboxOps.keysIssued > 0
      ? sandboxOps.keysRevoked / sandboxOps.keysIssued
      : 0;
    if (revokedRatio > 0.3 && sandboxOps.keysIssued > 10) {
      alerts.push({
        alertId:  `mon_keys_${now}`,
        type:     "HIGH_KEY_REVOCATION_RATE",
        severity: "MEDIUM",
        message:  `High API key revocation rate: ${Math.round(revokedRatio * 100)}% of issued keys revoked`,
        data:     { revoked: sandboxOps.keysRevoked, issued: sandboxOps.keysIssued },
        firedAt:  now,
      });
    }

    // 5. Check top items leaderboard for staleness
    const topItems = await getTopEngagedItems(redis, 10);
    const topResellers = await getTopActiveResellers(redis, 10);

    // Store alerts
    for (const alert of alerts) {
      const severityScore = { CRITICAL: 100, HIGH: 70, MEDIUM: 40, LOW: 10 }[alert.severity] || 10;
      await redis.zAdd("dist:monitor:alerts", [{ score: severityScore * 1e10 + now, value: JSON.stringify(alert) }]);
    }

    // Keep alerts list manageable (last 200)
    await redis.zRemRangeByRank("dist:monitor:alerts", 0, -201);

    // Log run
    await redis.zAdd("dist:monitor:log", [{ score: now, value: `run_${now}` }]);
    await redis.expire("dist:monitor:log", 30 * 86400);

    // Ops
    await redis.hIncrBy("dist:ops", "monitor_runs", 1);
    await redis.hIncrBy("dist:ops", "alerts_fired", alerts.length);

    return {
      ok:          true,
      ranAt:       now,
      alertCount:  alerts.length,
      alerts,
      health: {
        criticalAlerts: alerts.filter(a => a.severity === "CRITICAL").length,
        highAlerts:     alerts.filter(a => a.severity === "HIGH").length,
        mediumAlerts:   alerts.filter(a => a.severity === "MEDIUM").length,
        status:         alerts.some(a => a.severity === "CRITICAL") ? "CRITICAL"
                      : alerts.some(a => a.severity === "HIGH")     ? "DEGRADED"
                      : alerts.length > 0                           ? "MONITOR"
                      : "HEALTHY",
      },
      ecosystem: {
        topItemCount:     topItems.length,
        topResellerCount: topResellers.length,
        usageSummary:     usageOps,
        feedbackSummary:  feedbackOps,
      },
      distributionVersion: DISTRIBUTION_VERSION,
    };
  } catch (err) {
    return { ok: false, error: "monitor_failed", reason: err?.message };
  }
}

/**
 * Get current active alerts from the monitor.
 */
export async function getActiveMonitorAlerts(redis, limit = 20) {
  if (!redis) return [];
  try {
    const raw = await redis.zRange("dist:monitor:alerts", 0, limit - 1, { REV: true });
    return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * Get distribution + monitor ops summary.
 */
export async function getDistributionOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("dist:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      monitorRuns:  ops["monitor_runs"]  || 0,
      alertsFired:  ops["alerts_fired"]  || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _scoreChannel({ cfg, category, subCategory, price, certTier, isVerified, isCertified, engagementScore, catScore, sellRouting }) {
  const reasons = [];
  let total     = 0;

  // Cert tier gate
  if (cfg.minTier) {
    const tierOrder = { STANDARD: 1, ADVANCED: 2, PRO: 3 };
    const userTier  = tierOrder[certTier] || 0;
    const minTier   = tierOrder[cfg.minTier] || 0;
    if (userTier < minTier) {
      return { eligible: false, total: 0, priority: null, reasons: [] };
    }
  }

  // Category fit
  const norm = (category || "").toLowerCase().replace(/\s+/g, "_");
  const fits = cfg.bestFor.some(b => norm.includes(b) || b.includes(norm));
  if (fits) {
    total += 30;
    reasons.push(`Strong category fit for ${cfg.label}`);
  }

  // Trust value alignment
  if (isVerified && (cfg.trustValue === "high" || cfg.trustValue === "very_high")) {
    total += 20;
    reasons.push("Verified trust language is valued on this channel");
  }

  // Price tier
  if (price != null) {
    if (price >= 200 && cfg.type === "partner")      { total += 15; reasons.push("High-value item suits partner channel"); }
    if (price >= 100 && cfg.type === "marketplace")  { total += 10; reasons.push("Mid/high value suits trust-driven marketplace"); }
    if (price < 50  && cfg.type === "marketplace")   { total += 5;  reasons.push("Lower price point suits mass marketplace"); }
  }

  // Engagement score (trust footprint already built)
  if (engagementScore >= 50) { total += 10; reasons.push("Strong trust footprint boosts marketplace performance"); }

  // Sell routing signal
  if (sellRouting?.topPlatform === cfg.id) { total += 20; reasons.push("Top platform from Evan routing intelligence"); }

  // Category adoption signal
  if (catScore >= 10) { total += 5; reasons.push("Category has strong Evan adoption"); }

  // Priority bucketing
  const priority = total >= 55 ? "primary" : total >= 35 ? "secondary" : "tertiary";

  return { eligible: true, total, priority, reasons };
}

function _getChannelTips({ cfg, isVerified, isCertified, certTier, price }) {
  const tips = [];
  if (isVerified)  tips.push(`Include the Evan verification link in your ${cfg.label} listing`);
  if (isCertified) tips.push(`Mention your Evan certification in the seller bio`);
  if (cfg.id === "ebay" && isVerified) tips.push("Use the HTML trust block for maximum visual impact");
  if (cfg.id === "grailed")            tips.push("Lead with verification — Grailed buyers are highly trust-sensitive");
  if (cfg.type === "partner")          tips.push("Contact Evan partner onboarding for consignment intake");
  return tips;
}

function _describeTrustFootprint(score) {
  if (score >= 100) return "established";
  if (score >= 40)  return "growing";
  if (score >= 10)  return "early";
  return "new";
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
