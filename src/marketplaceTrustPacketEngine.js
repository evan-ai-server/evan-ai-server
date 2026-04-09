// src/marketplaceTrustPacketEngine.js
// Phase 9 — Marketplace Trust Packet Engine.
//
// Generates structured trust packets for specific marketplace contexts.
// Each packet type is optimized for a different consumer:
//
//   marketplace   — Item trust summary for eBay, Grailed, Poshmark, Mercari, Facebook
//   seller        — Reseller trust + certification summary for seller profiles
//   valuation     — Price credibility packet for lending/insurance/consignment
//   guarantee     — Active guarantee status packet for buyer confidence
//
// All packets pass through embeddedComplianceGuard before field exposure.
// Marketplace packets include channel-appropriate claim language (softened per Phase 7).
//
// Redis key layout:
//   p9:tp:{type}:{referenceId}   STRING  cached packet (TTL varies)
//   p9:tp:ops                    HASH    counters

import { guardEmbeddedRequest } from "./embeddedComplianceGuard.js";
import { CLAIM_TYPE } from "./externalClaimGovernor.js";
import { BADGE_TYPE } from "./externalBadgePolicyEngine.js";

export const TRUST_PACKET_VERSION = "9.0";

export const PACKET_TYPE = {
  MARKETPLACE: "marketplace",
  SELLER:      "seller",
  VALUATION:   "valuation",
  GUARANTEE:   "guarantee",
};

const PACKET_TTL = {
  marketplace: 300,   // 5 min
  seller:      600,   // 10 min
  valuation:   120,   // 2 min — price-sensitive
  guarantee:   180,   // 3 min
};

// ── Core packet builder ───────────────────────────────────────────────────

/**
 * Build a marketplace trust packet.
 *
 * @param {object} redis
 * @param {object} opts
 *   packetType      {string}   — PACKET_TYPE.*
 *   referenceId     {string}   — trust reference ID
 *   token           {string}   — partner JWT
 *   embedContext    {string}   — "marketplace"|"api"|"widget"
 *   sourceData      {object}   — raw trust data (from resolver or reference engine)
 * @returns {TrustPacket}
 */
export async function buildTrustPacket(redis, {
  packetType   = PACKET_TYPE.MARKETPLACE,
  referenceId,
  token,
  embedContext  = "marketplace",
  sourceData    = {},
} = {}) {
  if (!redis || !referenceId || !token) {
    return { ok: false, error: "missing_params" };
  }

  // Cache check
  const cacheKey = `p9:tp:${packetType}:${_safe(referenceId)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      await _incrOps(redis, "cache_hit");
      return { ...JSON.parse(cached), fromCache: true };
    }
  } catch { /* skip */ }

  // Compliance guard
  const claimType = packetType === PACKET_TYPE.SELLER
    ? CLAIM_TYPE.RESELLER_CERTIFIED
    : CLAIM_TYPE.ITEM_VERIFIED;
  const badgeType = packetType === PACKET_TYPE.SELLER
    ? BADGE_TYPE.EVAN_CERTIFIED
    : BADGE_TYPE.EVAN_VERIFIED;

  const guard = await guardEmbeddedRequest(redis, {
    token,
    claimType,
    claimText:   "Evan-Verified",
    embedContext,
    badgeType,
    payload:     sourceData,
    requestMeta: {},
  });

  if (!guard.ok) {
    return { ok: false, error: guard.decision, reason: guard.reason, referenceId };
  }

  // Build packet by type
  const packet = _buildPacketByType({
    packetType,
    referenceId,
    data: guard.payload,
    guard,
  });

  // Cache
  try {
    await redis.set(cacheKey, JSON.stringify(packet), { EX: PACKET_TTL[packetType] || 180 });
  } catch { /* non-critical */ }

  await _incrOps(redis, `${packetType}_built`);
  return packet;
}

/**
 * Get trust packet ops summary.
 */
export async function getTrustPacketOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:tp:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      marketplaceBuilt: ops["marketplace_built"] || 0,
      sellerBuilt:      ops["seller_built"]      || 0,
      valuationBuilt:   ops["valuation_built"]   || 0,
      guaranteeBuilt:   ops["guarantee_built"]   || 0,
      cacheHits:        ops["cache_hit"]         || 0,
    };
  } catch { return {}; }
}

// ── Packet builders ───────────────────────────────────────────────────────

function _buildPacketByType({ packetType, referenceId, data, guard }) {
  const now   = Date.now();
  const base  = {
    ok:              true,
    packetId:        `tp_${packetType}_${referenceId}_${now}`,
    packetType,
    referenceId,
    verifyUrl:       `https://evan.ai/verify/${referenceId}`,
    badgeUrl:        `https://evan.ai/badge/${referenceId}`,
    issuedAt:        now,
    expiresAt:       now + (PACKET_TTL[packetType] * 1000),
    auditToken:      guard.auditToken,
    trustPacketVersion: TRUST_PACKET_VERSION,
  };

  switch (packetType) {
    case PACKET_TYPE.MARKETPLACE:
      return {
        ...base,
        itemId:         data.itemId        || referenceId,
        trustLevel:     _trustLevel(data),
        verifiedAt:     data.verifiedAt    || data.issuedAt || now,
        brand:          data.identity?.brand || data.brand || null,
        model:          data.identity?.model || data.model || null,
        itemType:       data.identity?.itemType || null,
        condition:      data.condition     || null,
        confidenceBand: _confidenceBand(data.confidence),
        // Claim language (softened per Phase 7 governance)
        claimLanguage:  "Authentication verified by Evan AI",
        claimDisclaimer: "Verification reflects scan data at time of analysis. See verification report for details.",
        // Marketplace-specific listing text
        listingText:    _buildListingText(data),
        downstream_trust_id: data.downstream_trust_id || null,
      };

    case PACKET_TYPE.SELLER:
      return {
        ...base,
        sellerId:       data.sellerId || referenceId,
        trustLevel:     _trustLevel(data),
        certTier:       data.certTier || null,
        verifiedAt:     data.verifiedAt || now,
        trustScore:     data.trustScore || null,
        totalVerified:  data.totalVerified || null,
        // Claim language
        claimLanguage:  "Evan-Certified Reseller",
        claimDisclaimer: "Certification reflects reseller history verified by Evan AI.",
        bioText:        data.certTier
          ? `Evan ${data.certTier}-Certified Reseller · evan.ai/verify/${referenceId}`
          : `Evan-Verified Reseller · evan.ai/verify/${referenceId}`,
      };

    case PACKET_TYPE.VALUATION:
      return {
        ...base,
        itemId:         data.itemId        || referenceId,
        trustLevel:     _trustLevel(data),
        verifiedAt:     data.verifiedAt    || now,
        brand:          data.identity?.brand || data.brand || null,
        model:          data.identity?.model || data.model || null,
        condition:      data.condition     || null,
        // Price data — only exposed if scope allows (guard.payload handles this)
        priceEstimate:  data.priceEstimate  || data.priceRange || null,
        confidenceBand: _confidenceBand(data.confidence),
        valuationBasis: "Market comparables + condition adjustment",
        valuationDisclaimer: "Price estimate for collateral reference only. Not a guarantee of sale value.",
      };

    case PACKET_TYPE.GUARANTEE:
      return {
        ...base,
        itemId:              data.itemId || referenceId,
        guaranteeActive:     !!(data.guarantee?.active),
        guaranteeExpiresAt:  data.guarantee?.expiresAt || null,
        coverageLevel:       data.guarantee?.coverageLevel || null,
        claimLanguage:       data.guarantee?.active
          ? "Evan Buyer Guarantee active — disputes handled by Evan AI"
          : "Evan verification complete — no active buyer guarantee",
        claimDisclaimer: "Guarantee subject to Evan AI terms. See verification report.",
      };

    default:
      return { ...base, packetType: "unknown" };
  }
}

function _trustLevel(data) {
  const confidence = Number(data.confidence) || 0;
  const hasSku = !!(data.institutionalIds?.sku || data.institutionalIds?.serialNumber);
  if (confidence >= 0.80 && hasSku) return "FULL";
  if (confidence >= 0.65)          return "HIGH";
  if (confidence >= 0.50)          return "MEDIUM";
  return "LOW";
}

function _confidenceBand(confidence) {
  const c = Number(confidence) || 0;
  if (c >= 0.85) return "HIGH";
  if (c >= 0.65) return "MEDIUM";
  if (c >= 0.45) return "LOW";
  return "VERY_LOW";
}

function _buildListingText(data) {
  const brand = data.identity?.brand || data.brand || "";
  const model = data.identity?.model || data.model || "";
  const item  = [brand, model].filter(Boolean).join(" ") || "This item";
  return `${item} — Authentication verified by Evan AI · See verification: evan.ai/verify/...`;
}

async function _incrOps(redis, counter) {
  if (!redis) return;
  try { await redis.hIncrBy("p9:tp:ops", counter, 1); } catch { /* non-critical */ }
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
