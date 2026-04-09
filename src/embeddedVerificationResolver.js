// src/embeddedVerificationResolver.js
// Phase 9 — Embedded Verification Resolver.
//
// Fast trust reference resolution for embedded contexts.
// Supports three display modes:
//   badge   — minimal: { verified, referenceId, badgeUrl, expiresAt }
//   compact — card-sized: adds brand, model, confidence band, trustmark
//   full    — all fields: adds condition, priceRange, certTier, auditHash
//
// All resolution passes through embeddedComplianceGuard before data is returned.
// Responses are cached in Redis (TTL varies by mode).
//
// Redis key layout:
//   p9:vr:{mode}:{referenceId}    STRING  cached resolution (TTL by mode)
//   p9:vr:ops                     HASH    counters

import { getExternalReference, getPublicVerificationPayload, getPartnerVerificationPayload, REFERENCE_STATUS } from "./externalTrustReferenceEngine.js";
import { guardEmbeddedRequest } from "./embeddedComplianceGuard.js";
import { CLAIM_TYPE } from "./externalClaimGovernor.js";
import { BADGE_TYPE } from "./externalBadgePolicyEngine.js";

export const RESOLVER_VERSION = "9.0";

const CACHE_TTL = {
  badge:   300,   // 5 min  — badge is simple, short TTL ok
  compact: 180,   // 3 min
  full:    60,    // 1 min  — full includes price data, stale fast
};

// ── Core resolver ─────────────────────────────────────────────────────────

/**
 * Resolve a trust reference for embedding.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceId  {string}        — evan reference ID
 *   mode         {string}        — "badge"|"compact"|"full"
 *   token        {string}        — partner JWT
 *   embedContext {string}        — "widget"|"api"|"marketplace"|"export"|"qr"|"certificate"
 *   requestMeta  {object}        — { ip, referrer, domain }
 * @returns {ResolvedVerification}
 */
export async function resolveEmbeddedVerification(redis, {
  referenceId,
  mode        = "badge",
  token,
  embedContext = "widget",
  requestMeta  = {},
} = {}) {
  if (!redis || !referenceId || !token) {
    return { ok: false, error: "missing_params" };
  }

  // Check cache
  const cacheKey = `p9:vr:${mode}:${_safe(referenceId)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      await _incrOps(redis, "cache_hit");
      return { ...JSON.parse(cached), fromCache: true };
    }
  } catch { /* skip */ }

  // Fetch the reference record
  const ref = await getExternalReference(redis, referenceId);
  if (!ref) {
    return { ok: false, error: "reference_not_found", referenceId };
  }

  // Check reference is active
  if (ref.status !== REFERENCE_STATUS.ACTIVE) {
    return {
      ok:          false,
      error:       "reference_inactive",
      status:      ref.status,
      referenceId,
    };
  }

  // Get the payload based on mode
  let rawPayload;
  if (mode === "full") {
    rawPayload = await getPartnerVerificationPayload(redis, referenceId);
  } else {
    rawPayload = await getPublicVerificationPayload(redis, referenceId);
  }
  if (!rawPayload) {
    return { ok: false, error: "payload_unavailable", referenceId };
  }

  // Run compliance guard
  const claimType = ref.referenceType === "RESELLER_CERTIFIED"
    ? CLAIM_TYPE.RESELLER_CERTIFIED
    : CLAIM_TYPE.ITEM_VERIFIED;

  const badgeType = ref.referenceType === "RESELLER_CERTIFIED"
    ? BADGE_TYPE.EVAN_CERTIFIED
    : BADGE_TYPE.EVAN_VERIFIED;

  const guard = await guardEmbeddedRequest(redis, {
    token,
    claimType,
    claimText:   "Evan-Verified",
    embedContext,
    badgeType,
    payload:     rawPayload,
    requestMeta,
  });

  if (!guard.ok) {
    return { ok: false, error: guard.decision, reason: guard.reason, referenceId };
  }

  // Shape response by mode
  const response = _shapeResponse({ mode, ref, payload: guard.payload, guard, referenceId });

  // Cache
  try {
    await redis.set(cacheKey, JSON.stringify(response), { EX: CACHE_TTL[mode] || 120 });
  } catch { /* non-critical */ }

  await _incrOps(redis, "resolved");
  return response;
}

/**
 * Batch resolve multiple references (for listing pages, multi-item widgets).
 * Returns partial results — unresolvable refs get { ok: false } entries.
 */
export async function resolveEmbeddedBatch(redis, { referenceIds = [], mode = "badge", token, embedContext = "widget" } = {}) {
  if (!referenceIds.length) return { ok: true, results: [], total: 0 };

  const results = await Promise.all(
    referenceIds.map(referenceId =>
      resolveEmbeddedVerification(redis, { referenceId, mode, token, embedContext })
    )
  );

  return {
    ok:       true,
    results,
    total:    referenceIds.length,
    resolved: results.filter(r => r.ok).length,
    failed:   results.filter(r => !r.ok).length,
  };
}

/**
 * Get resolver ops.
 */
export async function getResolverOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:vr:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return { resolved: ops["resolved"] || 0, cacheHits: ops["cache_hit"] || 0 };
  } catch { return {}; }
}

// ── Response shaping ──────────────────────────────────────────────────────

function _shapeResponse({ mode, ref, payload, guard, referenceId }) {
  const base = {
    ok:             true,
    referenceId,
    mode,
    verified:       true,
    status:         ref.status,
    referenceType:  ref.referenceType,
    issuedAt:       ref.issuedAt || null,
    expiresAt:      ref.expiresAt || null,
    badgeUrl:       `https://evan.ai/badge/${referenceId}`,
    verifyUrl:      `https://evan.ai/verify/${referenceId}`,
    resolverVersion: RESOLVER_VERSION,
    auditToken:     guard.auditToken,
    decision:       guard.decision,
  };

  if (mode === "badge") return base;

  const compact = {
    ...base,
    brand:          payload.identity?.brand || null,
    model:          payload.identity?.model || null,
    itemType:       payload.identity?.itemType || null,
    confidenceBand: _confidenceBand(payload.confidence),
    trustmarkStatus: payload.trustmark?.status || null,
  };

  if (mode === "compact") return compact;

  // Full mode
  return {
    ...compact,
    condition:     payload.condition || null,
    priceRange:    payload.priceRange || null,
    certTier:      payload.certTier || null,
    auditHash:     payload.auditHash || null,
    institutionalIds: payload.institutionalIds || null,
    signalMap:     payload.signalMap || null,
  };
}

function _confidenceBand(confidence) {
  const c = Number(confidence) || 0;
  if (c >= 0.85) return "HIGH";
  if (c >= 0.65) return "MEDIUM";
  if (c >= 0.45) return "LOW";
  return "VERY_LOW";
}

async function _incrOps(redis, counter) {
  if (!redis) return;
  try { await redis.hIncrBy("p9:vr:ops", counter, 1); } catch { /* non-critical */ }
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
