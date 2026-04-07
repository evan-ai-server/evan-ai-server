// src/externalFeedbackEngine.js
// Phase 8 — External Feedback + Issue Reporting Engine.
//
// Closes the trust loop by accepting feedback from buyers, sellers, and
// platform partners about item authenticity, reseller behavior, and
// verification accuracy.
//
// Feedback types:
//   - BUYER_DISPUTE:          buyer received item inconsistent with Evan trust
//   - ACCURACY_REPORT:        third party disputes the verification outcome
//   - CONDITION_MISMATCH:     item condition differed from claimed
//   - COUNTERFEIT_ALLEGATION: buyer believes item is counterfeit
//   - POSITIVE_CONFIRMATION:  buyer confirms authenticity matched
//   - RESELLER_COMPLAINT:     behavior/conduct issue with certified reseller
//   - PARTNER_SIGNAL:         automated signal from a partner integration
//
// Severity model:
//   - CRITICAL (COUNTERFEIT_ALLEGATION, BUYER_DISPUTE)  → triggers revocation review
//   - HIGH     (ACCURACY_REPORT, CONDITION_MISMATCH)    → flags for ops review
//   - MEDIUM   (RESELLER_COMPLAINT)                     → logged + monitored
//   - LOW      (POSITIVE_CONFIRMATION, PARTNER_SIGNAL)  → logged, no action
//
// Revocation trigger:
//   - ≥ 2 CRITICAL reports for same referenceId within 30 days → auto-flag for revocation
//   - Revocation is flagged, NOT executed automatically — ops confirms
//
// Redis key layout:
//   fb:report:{reportId}           STRING  full report record (180d TTL)
//   fb:ref:{referenceId}:reports   ZSET    reportIds by timestamp
//   fb:ref:{referenceId}:critical  STRING  critical count (30d rolling TTL)
//   fb:user:{userId}:submitted     ZSET    reportIds submitted by user (90d)
//   fb:ops                         HASH    aggregate counters
//   fb:revocation_flags            ZSET    referenceIds flagged for revocation (score=timestamp)

import crypto from "crypto";

export const FEEDBACK_VERSION = "8.0";

export const FEEDBACK_TYPE = {
  BUYER_DISPUTE:          "BUYER_DISPUTE",
  ACCURACY_REPORT:        "ACCURACY_REPORT",
  CONDITION_MISMATCH:     "CONDITION_MISMATCH",
  COUNTERFEIT_ALLEGATION: "COUNTERFEIT_ALLEGATION",
  POSITIVE_CONFIRMATION:  "POSITIVE_CONFIRMATION",
  RESELLER_COMPLAINT:     "RESELLER_COMPLAINT",
  PARTNER_SIGNAL:         "PARTNER_SIGNAL",
};

const SEVERITY = {
  [FEEDBACK_TYPE.COUNTERFEIT_ALLEGATION]: "CRITICAL",
  [FEEDBACK_TYPE.BUYER_DISPUTE]:          "CRITICAL",
  [FEEDBACK_TYPE.ACCURACY_REPORT]:        "HIGH",
  [FEEDBACK_TYPE.CONDITION_MISMATCH]:     "HIGH",
  [FEEDBACK_TYPE.RESELLER_COMPLAINT]:     "MEDIUM",
  [FEEDBACK_TYPE.POSITIVE_CONFIRMATION]:  "LOW",
  [FEEDBACK_TYPE.PARTNER_SIGNAL]:         "LOW",
};

const REPORT_TTL          = 180 * 86400;
const CRITICAL_WINDOW     = 30  * 86400;  // 30-day rolling window
const CRITICAL_THRESHOLD  = 2;            // reports within window → flag

// ── Submit feedback report ────────────────────────────────────────────────────

/**
 * Submit an external feedback report for a trust reference.
 *
 * @param {object} redis
 * @param {object} opts
 *   feedbackType   {string}       — FEEDBACK_TYPE.*
 *   referenceId    {string|null}  — item or reseller external reference
 *   submittedBy    {string|null}  — user id or "anonymous"
 *   submitterRole  {string|null}  — "buyer"|"seller"|"partner"|"ops"
 *   platform       {string|null}  — where the item was purchased/listed
 *   description    {string|null}  — free-text, sanitized
 *   evidence       {string[]}     — array of URLs or evidence keys
 *   partnerTag     {string|null}  — if from partner integration
 * @returns {{ ok, reportId, severity, revocationFlagged }}
 */
export async function submitFeedbackReport(redis, {
  feedbackType,
  referenceId    = null,
  submittedBy    = null,
  submitterRole  = null,
  platform       = null,
  description    = null,
  evidence       = [],
  partnerTag     = null,
} = {}) {
  if (!redis || !feedbackType) return { ok: false, error: "missing_required" };
  if (!FEEDBACK_TYPE[feedbackType]) return { ok: false, error: "invalid_feedback_type" };

  const now      = Date.now();
  const reportId = `fbr_${crypto.randomBytes(6).toString("hex")}`;
  const severity = SEVERITY[feedbackType] || "LOW";

  const report = {
    reportId,
    feedbackType,
    severity,
    referenceId:   referenceId || null,
    submittedBy:   _safe(submittedBy || "anonymous"),
    submitterRole: submitterRole || null,
    platform:      platform || null,
    description:   _sanitizeText(description),
    evidence:      (Array.isArray(evidence) ? evidence : []).slice(0, 5).map(_sanitizeUrl),
    partnerTag:    partnerTag || null,
    status:        "RECEIVED",
    submittedAt:   now,
    reviewedAt:    null,
    resolution:    null,
    feedbackVersion: FEEDBACK_VERSION,
  };

  try {
    await redis.set(`fb:report:${reportId}`, JSON.stringify(report), { EX: REPORT_TTL });

    if (referenceId) {
      await redis.zAdd(`fb:ref:${referenceId}:reports`, [{ score: now, value: reportId }]);
    }

    if (submittedBy) {
      await redis.zAdd(`fb:user:${_safe(submittedBy)}:submitted`, [{ score: now, value: reportId }]);
      await redis.expire(`fb:user:${_safe(submittedBy)}:submitted`, 90 * 86400);
    }

    await redis.hIncrBy("fb:ops", "total_reports", 1);
    await redis.hIncrBy("fb:ops", `type.${feedbackType}`, 1);
    await redis.hIncrBy("fb:ops", `severity.${severity}`, 1);

    // Revocation flag logic for CRITICAL reports
    let revocationFlagged = false;
    if (severity === "CRITICAL" && referenceId) {
      revocationFlagged = await _checkRevocationThreshold(redis, referenceId, now);
    }

    return { ok: true, reportId, severity, revocationFlagged };
  } catch (err) {
    return { ok: false, error: "submit_failed", reason: err?.message };
  }
}

// ── Get reports for a reference ───────────────────────────────────────────────

/**
 * Get all feedback reports for a given referenceId (most recent first).
 */
export async function getReportsForReference(redis, referenceId, { limit = 20 } = {}) {
  if (!redis || !referenceId) return [];

  try {
    const reportIds = await redis.zRange(
      `fb:ref:${referenceId}:reports`, 0, limit - 1,
      { REV: true }
    );

    const reports = await Promise.all(
      reportIds.map(id =>
        redis.get(`fb:report:${id}`).then(raw => raw ? JSON.parse(raw) : null)
      )
    );

    return reports.filter(Boolean);
  } catch { return []; }
}

/**
 * Get feedback summary for a referenceId.
 */
export async function getReferenceFeedbackSummary(redis, referenceId) {
  if (!redis || !referenceId) return null;

  try {
    const reports = await getReportsForReference(redis, referenceId, { limit: 100 });

    const byType     = {};
    const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };

    for (const r of reports) {
      byType[r.feedbackType]        = (byType[r.feedbackType] || 0) + 1;
      bySeverity[r.severity]        = (bySeverity[r.severity] || 0) + 1;
    }

    const isRevocationFlagged = await redis.zScore("fb:revocation_flags", referenceId);

    return {
      referenceId,
      totalReports:       reports.length,
      byType,
      bySeverity,
      positiveCount:      byType[FEEDBACK_TYPE.POSITIVE_CONFIRMATION] || 0,
      criticalCount:      bySeverity.CRITICAL,
      isRevocationFlagged:isRevocationFlagged !== null,
      revocationFlaggedAt:isRevocationFlagged ? Number(isRevocationFlagged) : null,
      mostRecentAt:       reports[0]?.submittedAt || null,
    };
  } catch { return null; }
}

// ── Ops: mark report reviewed ─────────────────────────────────────────────────

/**
 * Mark a feedback report as reviewed with a resolution.
 */
export async function markReportReviewed(redis, reportId, { resolution, reviewedBy } = {}) {
  if (!redis || !reportId) return { ok: false, error: "missing_required" };

  try {
    const raw = await redis.get(`fb:report:${reportId}`);
    if (!raw) return { ok: false, error: "report_not_found" };

    const report = JSON.parse(raw);
    report.status     = "REVIEWED";
    report.resolution = resolution || null;
    report.reviewedBy = reviewedBy || null;
    report.reviewedAt = Date.now();

    await redis.set(`fb:report:${reportId}`, JSON.stringify(report), { EX: REPORT_TTL });
    await redis.hIncrBy("fb:ops", "reports_reviewed", 1);

    return { ok: true, reportId, resolution };
  } catch (err) {
    return { ok: false, error: "review_failed", reason: err?.message };
  }
}

// ── Get flagged references ────────────────────────────────────────────────────

/**
 * Get list of referenceIds flagged for revocation review (most urgent first).
 */
export async function getRevocationFlags(redis, limit = 20) {
  if (!redis) return [];
  try {
    const flags = await redis.zRange("fb:revocation_flags", 0, limit - 1, { REV: true, WITHSCORES: true });
    const out   = [];
    for (let i = 0; i < flags.length; i += 2) {
      out.push({ referenceId: flags[i], flaggedAt: Number(flags[i + 1]) || 0 });
    }
    return out;
  } catch { return []; }
}

/**
 * Clear a revocation flag after ops review.
 */
export async function clearRevocationFlag(redis, referenceId) {
  if (!redis || !referenceId) return { ok: false };
  try {
    await redis.zRem("fb:revocation_flags", referenceId);
    await redis.hIncrBy("fb:ops", "flags_cleared", 1);
    return { ok: true, referenceId };
  } catch { return { ok: false }; }
}

/**
 * Get global feedback ops summary.
 */
export async function getFeedbackOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("fb:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;

    return {
      totalReports:     ops["total_reports"]     || 0,
      reportsReviewed:  ops["reports_reviewed"]  || 0,
      flagsCleared:     ops["flags_cleared"]     || 0,
      bySeverity: {
        critical: ops["severity.CRITICAL"] || 0,
        high:     ops["severity.HIGH"]     || 0,
        medium:   ops["severity.MEDIUM"]   || 0,
        low:      ops["severity.LOW"]      || 0,
      },
      byType: Object.fromEntries(
        Object.entries(ops)
          .filter(([k]) => k.startsWith("type."))
          .map(([k, v]) => [k.replace("type.", ""), v])
      ),
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _checkRevocationThreshold(redis, referenceId, now) {
  const criticalKey = `fb:ref:${referenceId}:critical`;
  const count       = await redis.incrBy(criticalKey, 1);

  // Set TTL on first write
  if (count === 1) await redis.expire(criticalKey, CRITICAL_WINDOW);

  if (count >= CRITICAL_THRESHOLD) {
    await redis.zAdd("fb:revocation_flags", [{ score: now, value: referenceId }]);
    await redis.hIncrBy("fb:ops", "revocation_flags_raised", 1);
    return true;
  }

  return false;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function _sanitizeText(text) {
  if (!text || typeof text !== "string") return null;
  // Strip HTML tags and limit length
  return text.replace(/<[^>]*>/g, "").trim().slice(0, 2000);
}

function _sanitizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  // Only allow http/https URLs
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.slice(0, 500);
  return null;
}
