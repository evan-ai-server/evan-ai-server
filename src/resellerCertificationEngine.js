// src/resellerCertificationEngine.js
// Phase 5 — Evan-Certified Reseller Engine + DealIQ Professional Score.
//
// Reseller certification is based on MEASURABLE BEHAVIOR, not vanity metrics.
// No badges for scan volume alone. No rewards for activity divorced from quality.
//
// What certification measures:
//   - Scan-to-outcome discipline (do they record results?)
//   - Signal adherence quality (do they follow Evan's signals successfully?)
//   - Authentication reliability (are their auth confidence reads correct?)
//   - Trust-safe behavior (do they use trust-safe listing language?)
//   - Counterfeit incident rate (have they sourced confirmed counterfeits?)
//   - Dispute rate (how often do buyers dispute their transactions?)
//   - Consistency over time (not just a hot streak)
//
// Certification tiers:
//   NONE          — default, no history
//   CERTIFIED     — solid track record, meets all base thresholds
//   CERTIFIED_PLUS — excellent track record, strong outcome data
//   ELITE         — reserved for top 1% (criteria TBD in Phase 6)
//
// Certification status:
//   NONE           — no certification
//   CERTIFIED      — active certification
//   PROBATION      — past certification, recent issues detected
//   INELIGIBLE     — disqualifying event (confirmed counterfeit sourcing)
//   REVIEW_REQUIRED — borderline, needs manual review
//
// DealIQ is the professional trust score embedded in this engine.
// It is auditable, score-grounded, and drives certification tier decisions.
//
// Redis key layout:
//   cert:user:{userId}      STRING  certification record (2yr TTL, refreshed on evaluation)
//   cert:ops                HASH    ops counters

import { getUserTrustHistory }      from "./trustHistoryEngine.js";
import { getUserInventory,
         getInventoryCounts }       from "./inventoryEngine.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CERT_STATUS = {
  NONE:             "NONE",
  CERTIFIED:        "CERTIFIED",
  PROBATION:        "PROBATION",
  INELIGIBLE:       "INELIGIBLE",
  REVIEW_REQUIRED:  "REVIEW_REQUIRED",
};

export const CERT_TIER = {
  NONE:          "NONE",
  CERTIFIED:     "CERTIFIED",
  CERTIFIED_PLUS: "CERTIFIED_PLUS",
  ELITE:         "ELITE",
};

export const CERT_VERSION = "5.0";

// Minimum scan history needed to produce a reliable score
const MIN_SCANS_FOR_EVAL = 5;
// Minimum inventory records needed for outcome-based scoring
const MIN_INVENTORY_FOR_OUTCOME_SCORE = 3;

// ── Redis key builders ────────────────────────────────────────────────────────

const KEY_USER  = userId => `cert:user:${userId}`;
const KEY_OPS   = ()     => `cert:ops`;
const CERT_TTL  = 2 * 365 * 86400;

// ── Core evaluation ───────────────────────────────────────────────────────────

/**
 * Compute reseller certification and DealIQ score for a user.
 * Reads from trust history, inventory, and optionally outcome records.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} [opts]
 *   forceRefresh   {boolean}  — ignore cached record and recompute
 *   disputeRate    {number}   — injected externally if available (0-1, lower is better)
 *   counterfeitIncidents {number} — confirmed counterfeit sources by this user
 * @returns {Promise<CertificationRecord>}
 */
export async function computeResellerCertification(redis, userId, {
  forceRefresh        = false,
  disputeRate         = 0,
  counterfeitIncidents = 0,
} = {}) {
  if (!redis || !userId) {
    return _buildInsufficientResult(userId, "no_redis_or_user");
  }

  // Return cached if not forcing refresh (cert evaluation is expensive)
  if (!forceRefresh) {
    const cached = await getCertificationRecord(redis, userId);
    if (cached && (Date.now() - cached.evaluatedAt) < 24 * 3600000) {
      // Cache for 24 hours
      return cached;
    }
  }

  try {
    // Gather data from trust history
    const [trustHistory, inventoryCounts] = await Promise.all([
      getUserTrustHistory(redis, userId, { limit: 100 }).catch(() => ({ records: [], total: 0 })),
      getInventoryCounts(redis, userId).catch(() => ({ active: 0, sold: 0, dead: 0, returned: 0, total: 0 })),
    ]);

    const trustRecords   = trustHistory.records || [];
    const totalScans     = trustHistory.total || 0;
    const totalInventory = inventoryCounts.total || 0;

    // Insufficient data check
    if (totalScans < MIN_SCANS_FOR_EVAL) {
      const result = _buildInsufficientResult(userId, "insufficient_scan_history", {
        totalScans,
        required: MIN_SCANS_FOR_EVAL,
      });
      await _storeCertification(redis, userId, result);
      return result;
    }

    // ── Score components ──────────────────────────────────────────────────────

    // 1. Scan volume score (0-100)
    const scanVolumeScore = _scaledScore(totalScans, 5, 200);

    // 2. Outcome closure score (0-100) — how often purchases are closed out
    const soldCount     = inventoryCounts.sold || 0;
    const totalBought   = inventoryCounts.total || 1;
    const outcomeClosureRate = totalInventory >= MIN_INVENTORY_FOR_OUTCOME_SCORE
      ? Math.min(soldCount / totalBought, 1.0)
      : null;
    const outcomeClosureScore = outcomeClosureRate !== null
      ? Math.round(outcomeClosureRate * 100)
      : 50;  // neutral if insufficient data

    // 3. Signal adherence score (0-100) — how well they follow strong buy signals
    // Proxy: ratio of STRONG BUY / GREAT FLIP signals in recent trust records
    const strongSignals = trustRecords.filter(r =>
      r.finalBuySignal === "STRONG BUY" || r.finalBuySignal === "GREAT FLIP"
    ).length;
    const riskSignals   = trustRecords.filter(r => r.finalBuySignal === "RISKY").length;
    const signalAdherenceScore = trustRecords.length > 0
      ? Math.round(Math.max(0, (strongSignals - riskSignals * 0.5) / trustRecords.length * 100))
      : 50;

    // 4. Authentication reliability score (0-100) — based on trust state distribution
    const confidentRecords = trustRecords.filter(r =>
      r.trustState === "VERIFIED_CONFIDENT" || r.trustState === "PROBABLE_BUT_VERIFY"
    ).length;
    const highRiskRecords  = trustRecords.filter(r => r.trustState === "HIGH_RISK_AUTH").length;
    const authReliabilityScore = trustRecords.length > 0
      ? Math.round(
          Math.max(0, (confidentRecords - highRiskRecords * 2) / trustRecords.length * 100)
        )
      : 50;

    // 5. Trust safety score (0-100) — based on absence of counterfeit incidents and warnings
    const counterfeitFlaggedRecords = trustRecords.filter(r =>
      r.authVerdict === "LIKELY_COUNTERFEIT" ||
      r.counterfeitFlags?.length > 0
    ).length;
    const trustSafetyScore = trustRecords.length > 0
      ? Math.max(0, 100 - Math.round((counterfeitFlaggedRecords / trustRecords.length) * 200))
      : 75;

    // 6. Dispute rate score (0-100) — 0 disputes = 100, each dispute penalizes
    const disputeRateScore = Math.max(0, Math.round((1 - disputeRate * 5) * 100));

    // 7. Counterfeit incident score — confirmed sourcing incidents are disqualifying
    const counterfeitIncidentScore = counterfeitIncidents === 0 ? 100
      : counterfeitIncidents === 1 ? 30
      : 0;

    // ── DealIQ overall score ──────────────────────────────────────────────────

    const weights = {
      scanVolume:            0.10,
      outcomeClosure:        0.20,
      signalAdherence:       0.20,
      authReliability:       0.20,
      trustSafety:           0.15,
      disputeRate:           0.10,
      counterfeitIncident:   0.05,
    };

    const rawScore =
      scanVolumeScore          * weights.scanVolume +
      outcomeClosureScore      * weights.outcomeClosure +
      signalAdherenceScore     * weights.signalAdherence +
      authReliabilityScore     * weights.authReliability +
      trustSafetyScore         * weights.trustSafety +
      disputeRateScore         * weights.disputeRate +
      counterfeitIncidentScore * weights.counterfeitIncident;

    const overallDealIQ = Math.min(100, Math.max(0, Math.round(rawScore)));

    const dealIQ = {
      overallScore:                  overallDealIQ,
      scanVolumeScore,
      outcomeClosureScore,
      outcomeClosureRate,
      signalAdherenceScore,
      authenticationReliabilityScore: authReliabilityScore,
      trustSafetyScore,
      disputeRateScore,
      counterfeitIncidentScore,
      disputePenalty:                Math.round((1 - disputeRateScore / 100) * -20),
      certificationImpact:           0,  // set below after tier determination
      dataQuality:                   _dataQuality(totalScans, totalInventory),
      computedAt:                    Date.now(),
    };

    // ── Certification determination ───────────────────────────────────────────

    const reasonCodes = [];
    let certStatus    = CERT_STATUS.NONE;
    let certTier      = CERT_TIER.NONE;

    // Hard blocks
    if (counterfeitIncidents >= 2) {
      reasonCodes.push("MULTIPLE_CONFIRMED_COUNTERFEIT_INCIDENTS");
      certStatus = CERT_STATUS.INELIGIBLE;
    } else if (counterfeitIncidents === 1) {
      reasonCodes.push("CONFIRMED_COUNTERFEIT_INCIDENT");
      certStatus = CERT_STATUS.PROBATION;
    } else if (overallDealIQ >= 75 && totalScans >= 20 && trustSafetyScore >= 70) {
      // Eligible for CERTIFIED_PLUS
      if (overallDealIQ >= 88 && soldCount >= 10 && authReliabilityScore >= 80) {
        certTier   = CERT_TIER.CERTIFIED_PLUS;
        reasonCodes.push("HIGH_DEAL_IQ", "STRONG_OUTCOME_TRACK_RECORD", "HIGH_AUTH_RELIABILITY");
      } else {
        certTier   = CERT_TIER.CERTIFIED;
        reasonCodes.push("MEETS_BASE_THRESHOLDS");
      }
      certStatus = CERT_STATUS.CERTIFIED;
      dealIQ.certificationImpact = certTier === CERT_TIER.CERTIFIED_PLUS ? 10 : 5;
    } else if (overallDealIQ >= 60 && totalScans >= 10) {
      // Borderline — review required
      certStatus = CERT_STATUS.REVIEW_REQUIRED;
      reasonCodes.push("BORDERLINE_DEAL_IQ");
      if (trustSafetyScore < 60) reasonCodes.push("TRUST_SAFETY_BELOW_THRESHOLD");
      if (authReliabilityScore < 50) reasonCodes.push("AUTH_RELIABILITY_BELOW_THRESHOLD");
    } else {
      certStatus = CERT_STATUS.NONE;
      if (totalScans < 20) reasonCodes.push("INSUFFICIENT_SCAN_VOLUME");
      if (overallDealIQ < 60) reasonCodes.push("DEAL_IQ_BELOW_THRESHOLD");
    }

    const now = Date.now();
    const record = {
      userId,
      eligible:   certStatus === CERT_STATUS.CERTIFIED,
      status:     certStatus,
      tier:       certTier,
      scoreComponents: {
        scanVolumeScore,
        outcomeClosureScore,
        signalAdherenceScore,
        authReliabilityScore,
        trustSafetyScore,
        disputeRateScore,
        counterfeitIncidentScore,
        totalScore: overallDealIQ,
      },
      dealIQ,
      reasonCodes,
      certifiedAt:  certStatus === CERT_STATUS.CERTIFIED ? now : null,
      expiresAt:    certStatus === CERT_STATUS.CERTIFIED ? now + 180 * 86400000 : null,  // 6 months
      reviewAt:     certStatus === CERT_STATUS.REVIEW_REQUIRED ? now + 30 * 86400000 : null,
      evaluatedAt:  now,
      policyVersion: CERT_VERSION,
      dataSummary: {
        totalScans,
        totalInventory,
        soldCount,
        confidentScans:   confidentRecords,
        highRiskScans:    highRiskRecords,
        counterfeitFlags: counterfeitFlaggedRecords,
      },
    };

    await _storeCertification(redis, userId, record);
    return record;

  } catch (err) {
    console.error("[resellerCert] computeResellerCertification error:", err?.message);
    return _buildInsufficientResult(userId, "evaluation_error");
  }
}

// ── Read / ops ────────────────────────────────────────────────────────────────

export async function getCertificationRecord(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(KEY_USER(userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function getCertificationOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalEvaluated:   ops["evaluated"] || 0,
      certified:        ops["status.CERTIFIED"] || 0,
      certifiedPlus:    ops["tier.CERTIFIED_PLUS"] || 0,
      probation:        ops["status.PROBATION"] || 0,
      ineligible:       ops["status.INELIGIBLE"] || 0,
      reviewRequired:   ops["status.REVIEW_REQUIRED"] || 0,
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _storeCertification(redis, userId, record) {
  try {
    await redis.set(KEY_USER(userId), JSON.stringify(record), { EX: CERT_TTL });
    await redis.hIncrBy(KEY_OPS(), "evaluated", 1);
    await redis.hIncrBy(KEY_OPS(), `status.${record.status}`, 1);
    if (record.tier !== CERT_TIER.NONE) {
      await redis.hIncrBy(KEY_OPS(), `tier.${record.tier}`, 1);
    }
  } catch { /* non-fatal */ }
}

function _buildInsufficientResult(userId, reason, extras = {}) {
  return {
    userId,
    eligible:    false,
    status:      CERT_STATUS.NONE,
    tier:        CERT_TIER.NONE,
    scoreComponents: null,
    dealIQ: {
      overallScore: null,
      dataQuality: "INSUFFICIENT",
      computedAt: Date.now(),
    },
    reasonCodes:    [reason.toUpperCase()],
    certifiedAt:    null,
    expiresAt:      null,
    reviewAt:       null,
    evaluatedAt:    Date.now(),
    policyVersion:  CERT_VERSION,
    ...extras,
  };
}

function _scaledScore(value, min, max) {
  if (value <= min) return 0;
  if (value >= max) return 100;
  return Math.round(((value - min) / (max - min)) * 100);
}

function _dataQuality(totalScans, totalInventory) {
  if (totalScans >= 50 && totalInventory >= 10) return "RICH";
  if (totalScans >= 20 && totalInventory >= 3)  return "MODERATE";
  if (totalScans >= 5)                           return "SPARSE";
  return "INSUFFICIENT";
}
