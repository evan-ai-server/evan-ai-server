// src/embeddedComplianceGuard.js
// Phase 9 — Embedded Compliance Guard.
//
// DIRECT CHILD OF Phase 7 ExternalClaimGovernor.
//
// All embedded partner requests pass through this guard before any trust data
// is exposed. It enforces:
//   1. Claim governance — routes every outbound trust claim through
//      governExternalClaim() from externalClaimGovernor.js
//   2. Scope enforcement — partner JWT must carry the required scopes for the
//      requested data fields (via partnerAuthTierEngine.js)
//   3. Channel policy — checks that the requested display channel is allowed
//      for the claim type (via externalBadgePolicyEngine.js)
//   4. Compliance audit log — writes every decision to Redis for Phase 9 audit trail
//   5. Hard block on governance failures — returns BLOCKED with reason
//
// Redis key layout:
//   p9:compliance:audit:{partnerId}    ZSET  compliance events by timestamp
//   p9:compliance:ops                  HASH  aggregate counters

import {
  governExternalClaim,
  CLAIM_CHANNEL,
  CLAIM_TYPE,
  CLAIM_GOVERNOR_VERSION,
} from "./externalClaimGovernor.js";

import {
  checkBadgeDisplayAllowed,
  DISPLAY_CHANNEL,
  BADGE_POLICY_VERSION,
} from "./externalBadgePolicyEngine.js";

import {
  verifyPartnerJWT,
  filterPayloadByScopes,
  hasScope,
  SCOPE,
} from "./partnerAuthTierEngine.js";

export const COMPLIANCE_GUARD_VERSION = "9.0";

// ── Compliance decision codes ──────────────────────────────────────────────

export const COMPLIANCE_DECISION = {
  APPROVED:            "APPROVED",
  BLOCKED_GOVERNANCE:  "BLOCKED_GOVERNANCE",
  BLOCKED_SCOPE:       "BLOCKED_SCOPE",
  BLOCKED_CHANNEL:     "BLOCKED_CHANNEL",
  BLOCKED_JWT:         "BLOCKED_JWT",
  BLOCKED_RATE_LIMIT:  "BLOCKED_RATE_LIMIT",
  DEGRADED:            "DEGRADED",   // allowed but partial (non-critical field missing)
};

// Claim channel map: Phase 9 embed context → Phase 7 CLAIM_CHANNEL
const EMBED_TO_CLAIM_CHANNEL = {
  widget:       CLAIM_CHANNEL.PUBLIC_VERIFICATION,
  api:          CLAIM_CHANNEL.PARTNER_API,
  marketplace:  CLAIM_CHANNEL.MARKETPLACE_LISTING,
  export:       CLAIM_CHANNEL.LENDER_EXPORT,
  qr:           CLAIM_CHANNEL.PUBLIC_VERIFICATION,
  certificate:  CLAIM_CHANNEL.PUBLIC_VERIFICATION,
};

// Display channel map: Phase 9 embed context → Phase 7 DISPLAY_CHANNEL
const EMBED_TO_DISPLAY_CHANNEL = {
  widget:      DISPLAY_CHANNEL.PUBLIC_PAGE,
  marketplace: DISPLAY_CHANNEL.MARKETPLACE_LISTING,
  api:         DISPLAY_CHANNEL.PARTNER_API,
  export:      DISPLAY_CHANNEL.LENDER_EXPORT,
  qr:          DISPLAY_CHANNEL.PUBLIC_PAGE,
  certificate: DISPLAY_CHANNEL.PUBLIC_PAGE,
};

// ── Core guard function ───────────────────────────────────────────────────

/**
 * Guard an embedded trust request.
 * This is the single entry point — all Phase 9 engines call this before
 * exposing trust data to a partner.
 *
 * @param {object} redis
 * @param {object} opts
 *   token       {string}        — partner JWT
 *   claimType   {string}        — CLAIM_TYPE value
 *   claimText   {string}        — the claim text to be displayed
 *   embedContext {string}       — "widget"|"api"|"marketplace"|"export"|"qr"|"certificate"
 *   badgeType   {string|null}   — BADGE_TYPE value (if displaying a badge)
 *   payload     {object}        — the data payload to filter by scopes
 *   requestMeta {object}        — { ip, referrer, domain } for audit
 * @returns {ComplianceResult}
 */
export async function guardEmbeddedRequest(redis, {
  token,
  claimType   = CLAIM_TYPE.VERIFIED_ITEM,
  claimText   = "",
  embedContext = "api",
  badgeType   = null,
  payload     = {},
  requestMeta = {},
} = {}) {
  const now = Date.now();

  // 1. Verify JWT
  const jwtResult = await verifyPartnerJWT(redis, token);
  if (!jwtResult.ok) {
    await _logComplianceEvent(redis, {
      partnerId: "unknown",
      decision:  COMPLIANCE_DECISION.BLOCKED_JWT,
      reason:    jwtResult.error || jwtResult.reason || "invalid_jwt",
      claimType,
      embedContext,
      requestMeta,
      timestamp: now,
    });
    return {
      ok:         false,
      decision:   COMPLIANCE_DECISION.BLOCKED_JWT,
      reason:     jwtResult.error || jwtResult.reason || "invalid_jwt",
      payload:    null,
      auditToken: null,
    };
  }

  const { partnerId, tier, scopes } = jwtResult;

  // 2. Governance check via Phase 7 ExternalClaimGovernor
  const channel = EMBED_TO_CLAIM_CHANNEL[embedContext] || CLAIM_CHANNEL.API;
  const governResult = governExternalClaim({
    claimType,
    claimText,
    channel,
    partnerId,
  });

  if (!governResult.allowed) {
    await _logComplianceEvent(redis, {
      partnerId,
      decision:  COMPLIANCE_DECISION.BLOCKED_GOVERNANCE,
      reason:    governResult.reason || "claim_governance_failed",
      claimType,
      embedContext,
      requestMeta,
      timestamp: now,
    });
    await _incrOps(redis, "blocked_governance");
    return {
      ok:         false,
      decision:   COMPLIANCE_DECISION.BLOCKED_GOVERNANCE,
      reason:     governResult.reason || "claim_governance_failed",
      payload:    null,
      auditToken: _buildAuditToken({ partnerId, claimType, embedContext, now }),
    };
  }

  // 3. Badge/channel policy check (if badge is requested)
  if (badgeType) {
    const displayChannel = EMBED_TO_DISPLAY_CHANNEL[embedContext] || DISPLAY_CHANNEL.API_RESPONSE;
    const channelAllowed = checkBadgeDisplayAllowed(badgeType, displayChannel);
    if (!channelAllowed.allowed) {
      await _logComplianceEvent(redis, {
        partnerId,
        decision:  COMPLIANCE_DECISION.BLOCKED_CHANNEL,
        reason:    `badge_${badgeType}_not_allowed_on_${displayChannel}`,
        claimType,
        embedContext,
        requestMeta,
        timestamp: now,
      });
      await _incrOps(redis, "blocked_channel");
      return {
        ok:         false,
        decision:   COMPLIANCE_DECISION.BLOCKED_CHANNEL,
        reason:     channelAllowed.reason || `badge not permitted on ${displayChannel}`,
        payload:    null,
        auditToken: _buildAuditToken({ partnerId, claimType, embedContext, now }),
      };
    }
  }

  // 4. Scope-filtered payload
  const filteredPayload = filterPayloadByScopes(payload, scopes);

  // 5. Check if any critical scopes are missing (degraded vs full)
  const hasProfitData  = payload.expectedProfit  != null || payload.profitMargin != null;
  const hasProfit      = hasScope(scopes, SCOPE.PROFIT_MARGIN);
  const decision = (hasProfitData && !hasProfit)
    ? COMPLIANCE_DECISION.DEGRADED
    : COMPLIANCE_DECISION.APPROVED;

  // 6. Log approval
  await _logComplianceEvent(redis, {
    partnerId,
    decision,
    reason:    null,
    claimType,
    embedContext,
    requestMeta,
    timestamp: now,
  });
  await _incrOps(redis, decision === COMPLIANCE_DECISION.APPROVED ? "approved" : "degraded");

  return {
    ok:              true,
    decision,
    partnerId,
    tier,
    scopes,
    payload:         filteredPayload,
    governResult,
    auditToken:      _buildAuditToken({ partnerId, claimType, embedContext, now }),
    complianceVersion: COMPLIANCE_GUARD_VERSION,
    governorVersion: CLAIM_GOVERNOR_VERSION,
    badgePolicyVersion: BADGE_POLICY_VERSION,
  };
}

/**
 * Batch guard — run guardEmbeddedRequest for an array of claims.
 * All-or-nothing: if any claim is blocked, the entire batch is blocked.
 *
 * @param {object} redis
 * @param {string} token        — single JWT for entire batch
 * @param {Array}  claims       — array of { claimType, claimText, embedContext, badgeType, payload }
 * @returns {BatchComplianceResult}
 */
export async function guardEmbeddedBatch(redis, token, claims = []) {
  const results = await Promise.all(
    claims.map(claim => guardEmbeddedRequest(redis, { token, ...claim }))
  );

  const blocked = results.filter(r => !r.ok);
  if (blocked.length > 0) {
    return {
      ok:       false,
      decision: blocked[0].decision,
      reason:   blocked[0].reason,
      blocked:  blocked.length,
      total:    claims.length,
    };
  }

  return {
    ok:       true,
    decision: COMPLIANCE_DECISION.APPROVED,
    results,
    total:    claims.length,
    passed:   results.length,
  };
}

/**
 * Get compliance audit log for a partner.
 */
export async function getComplianceAuditLog(redis, partnerId, { limit = 50 } = {}) {
  if (!redis || !partnerId) return [];
  try {
    const raw = await redis.zRange(
      `p9:compliance:audit:${_safe(partnerId)}`,
      0, limit - 1,
      { REV: true }
    );
    return raw
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Get aggregate compliance ops.
 */
export async function getComplianceOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:compliance:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      approved:          ops["approved"]           || 0,
      degraded:          ops["degraded"]            || 0,
      blockedGovernance: ops["blocked_governance"]  || 0,
      blockedChannel:    ops["blocked_channel"]     || 0,
      blockedJwt:        ops["blocked_jwt"]         || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────

async function _logComplianceEvent(redis, event) {
  if (!redis) return;
  try {
    const { partnerId, timestamp } = event;
    const key = `p9:compliance:audit:${_safe(partnerId)}`;
    await redis.zAdd(key, [{ score: timestamp, value: JSON.stringify(event) }]);
    await redis.zRemRangeByRank(key, 0, -501);  // keep last 500 events per partner
    await redis.expire(key, 90 * 86400);         // 90-day retention
  } catch { /* non-critical */ }
}

async function _incrOps(redis, counter) {
  if (!redis) return;
  try { await redis.hIncrBy("p9:compliance:ops", counter, 1); } catch { /* non-critical */ }
}

function _buildAuditToken({ partnerId, claimType, embedContext, now }) {
  // Non-cryptographic audit correlation token (human-readable trace ID)
  return `cg_${_safe(partnerId).slice(0, 8)}_${claimType.slice(0, 6)}_${now}`;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
