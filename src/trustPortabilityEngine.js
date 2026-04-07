// src/trustPortabilityEngine.js
// Phase 7 — Trust Portability Engine.
//
// Builds portable, self-contained trust packets that let Evan's trust evidence
// travel outside the app safely. This is how Evan becomes infrastructure:
// trust evidence becomes a portable object that can be presented in:
//   - Dispute defense (buyer presents packet to platform)
//   - Insurance claim support (packet accompanies claim filing)
//   - Marketplace trust review (platform checks seller's packet)
//   - Consignment intake (consignor authenticates with trust packet)
//   - Fraud investigation (packet provides forensic chain)
//   - Guarantee claim review (ops uses packet to adjudicate)
//
// Packet types:
//   ITEM_TRUST           — trust evidence for a scanned item
//   RESELLER_TRUST       — reseller certification + track record
//   DISPUTE_DEFENSE      — buyer's evidence packet for platform dispute
//   GUARANTEE_CLAIM      — packet for guarantee claim adjudication
//   INSURANCE_SUPPORT    — valuation + auth evidence for insurance
//
// Each packet:
//   - Has a unique packetId
//   - Has a verifiable auditHash
//   - Is channel-aware (public-safe vs partner-safe fields)
//   - Has an expiry (short-lived for dispute use; longer for reference)
//   - Is read-only export — no mutation via this layer
//
// Redis key layout:
//   tp:packet:{packetId}    STRING  packet record (90d TTL default)
//   tp:ops                  HASH    ops counters

import crypto from "crypto";
import { buildAuditHash, EXTREF_VERSION } from "./externalTrustReferenceEngine.js";

export const PORTABILITY_VERSION = "7.0";

export const PACKET_TYPE = {
  ITEM_TRUST:       "ITEM_TRUST",
  RESELLER_TRUST:   "RESELLER_TRUST",
  DISPUTE_DEFENSE:  "DISPUTE_DEFENSE",
  GUARANTEE_CLAIM:  "GUARANTEE_CLAIM",
  INSURANCE_SUPPORT:"INSURANCE_SUPPORT",
};

export const EXPORT_CHANNEL = {
  PUBLIC:       "PUBLIC",
  PARTNER:      "PARTNER",
  INTERNAL:     "INTERNAL",
  DISPUTE:      "DISPUTE",      // dispute resolution context
  INSURANCE:    "INSURANCE",
  LENDER:       "LENDER",
};

const PACKET_TTL = 90 * 86400;   // 90 days default

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_PACKET = id => `tp:packet:${id}`;
const KEY_OPS    = () => `tp:ops`;

// ── Build portable trust packet ───────────────────────────────────────────────

/**
 * Build and store a portable trust packet.
 *
 * @param {object} redis
 * @param {object} opts
 *   packetType          {string}    — PACKET_TYPE.*
 *   subjectId           {string}    — scanId, userId, or policyId
 *   subjectType         {string}    — "item"|"reseller"|"policy"
 *   trustStatus         {string}    — current trust status summary
 *   evidenceSummary     {object}    — qualitative evidence (public-safe)
 *   policySnapshot      {object}    — relevant policy at time of issue
 *   verificationReference {object}  — extref record (referenceId, verificationUrl)
 *   requestedBy         {string}    — "user"|"partner"|"ops"
 *   exportChannel       {string}    — EXPORT_CHANNEL.*
 *   ttlSeconds          {number}    — override default TTL
 * @returns {Promise<{ ok, packetId?, packet? }>}
 */
export async function buildPortableTrustPacket(redis, {
  packetType,
  subjectId,
  subjectType,
  trustStatus       = null,
  evidenceSummary   = {},
  policySnapshot    = {},
  verificationReference = null,
  requestedBy       = "user",
  exportChannel     = EXPORT_CHANNEL.PUBLIC,
  ttlSeconds        = PACKET_TTL,
} = {}) {
  if (!redis || !packetType || !subjectId) {
    return { ok: false, error: "missing_required" };
  }
  if (!PACKET_TYPE[packetType]) {
    return { ok: false, error: "invalid_packet_type" };
  }

  try {
    const now      = Date.now();
    const packetId = `tpk_${crypto.randomBytes(10).toString("hex")}`;
    const expiresAt = now + (ttlSeconds * 1000);

    // Determine channel safety
    const publicSafe  = _isPublicSafe(exportChannel);
    const partnerSafe = _isPartnerSafe(exportChannel);

    const packet = {
      packetId,
      packetType,
      subjectId,
      subjectType,
      trustStatus,
      evidenceSummary: _sanitizeEvidenceSummary(evidenceSummary, exportChannel),
      policySnapshot:  _sanitizePolicySnapshot(policySnapshot, exportChannel),
      verificationReference: verificationReference ? {
        referenceId:     verificationReference.referenceId,
        referenceType:   verificationReference.referenceType,
        verificationUrl: verificationReference.verificationUrl,
        status:          verificationReference.status,
        issuedAt:        verificationReference.issuedAt,
        expiresAt:       verificationReference.expiresAt,
      } : null,
      exportChannel,
      publicSafe,
      partnerSafe,
      requestedBy,
      issuedAt:    now,
      expiresAt,
      auditHash:   null,
      portabilityVersion: PORTABILITY_VERSION,
    };

    // Compute audit hash over canonical fields
    packet.auditHash = _packetAuditHash(packet);

    await redis.set(KEY_PACKET(packetId), JSON.stringify(packet), { EX: ttlSeconds });
    await redis.hIncrBy(KEY_OPS(), "total_created", 1);
    await redis.hIncrBy(KEY_OPS(), `channel.${exportChannel}`, 1);
    await redis.hIncrBy(KEY_OPS(), `type.${packetType}`, 1);

    return { ok: true, packetId, packet };
  } catch (err) {
    return { ok: false, error: "build_failed", reason: err?.message };
  }
}

/**
 * Retrieve a portable trust packet.
 */
export async function getPortableTrustPacket(redis, packetId) {
  if (!redis || !packetId) return null;
  try {
    const raw = await redis.get(KEY_PACKET(packetId));
    if (!raw) return null;
    const packet = JSON.parse(raw);
    // Check expiry
    if (packet.expiresAt && Date.now() > packet.expiresAt) {
      return { ...packet, expired: true };
    }
    return packet;
  } catch { return null; }
}

/**
 * Export a packet filtered for a specific channel.
 * Removes any fields that should not appear in the target channel.
 */
export function exportPacketForChannel(packet, targetChannel) {
  if (!packet) return null;

  const channelPublic  = _isPublicSafe(targetChannel);
  const channelPartner = _isPartnerSafe(targetChannel);

  // If requesting more access than what the packet was built for, return only what's safe
  const effectivePublic  = channelPublic  && packet.publicSafe;
  const effectivePartner = channelPartner && (packet.publicSafe || packet.partnerSafe);

  return {
    packetId:             packet.packetId,
    packetType:           packet.packetType,
    subjectType:          packet.subjectType,
    trustStatus:          packet.trustStatus,
    evidenceSummary:      packet.evidenceSummary,
    verificationReference:packet.verificationReference,
    exportChannel:        targetChannel,
    publicSafe:           effectivePublic,
    partnerSafe:          effectivePartner,
    issuedAt:             packet.issuedAt,
    expiresAt:            packet.expiresAt,
    auditHash:            packet.auditHash,
    portabilityVersion:   PORTABILITY_VERSION,
    // policySnapshot: only for partner+
    ...( effectivePartner ? { policySnapshot: packet.policySnapshot } : {} ),
  };
}

// ── Convenience builders ──────────────────────────────────────────────────────

/**
 * Build an item trust packet from a trustmark + verification record.
 * Suitable for dispute defense, marketplace trust review, consignment intake.
 */
export async function buildItemTrustPacket(redis, {
  scanId,
  trustmarkRecord,
  evanVerification,
  referenceRecord,
  exportChannel = EXPORT_CHANNEL.PARTNER,
} = {}) {
  if (!scanId) return { ok: false, error: "missing_scanId" };

  const evidenceSummary = {
    evidenceLevel:    evanVerification?.evidenceLevel   || null,
    expertReviewed:   evanVerification?.expertReviewed  || false,
    category:         evanVerification?.category        || null,
    brand:            evanVerification?.brand           || null,
    // Never include raw model scores
  };

  const policySnapshot = {
    verificationVersion: evanVerification?.verificationVersion || null,
    trustmarkStatus:     trustmarkRecord?.status || null,
    issuedAt:            trustmarkRecord?.issuedAt || null,
    expiresAt:           trustmarkRecord?.expiresAt || null,
  };

  return buildPortableTrustPacket(redis, {
    packetType:   PACKET_TYPE.ITEM_TRUST,
    subjectId:    scanId,
    subjectType:  "item",
    trustStatus:  evanVerification?.status || null,
    evidenceSummary,
    policySnapshot,
    verificationReference: referenceRecord || null,
    exportChannel,
  });
}

/**
 * Build a reseller trust packet from certification + identity records.
 */
export async function buildResellerTrustPacket(redis, {
  userId,
  certRecord,
  identityProfile,
  referenceRecord,
  exportChannel = EXPORT_CHANNEL.PARTNER,
} = {}) {
  if (!userId) return { ok: false, error: "missing_userId" };

  const evidenceSummary = {
    certificationStatus:  certRecord?.status || "NONE",
    certificationTier:    certRecord?.tier   || "NONE",
    dealIQBand:           identityProfile?.dealIQ?.band || null,
    categorySpecialties:  identityProfile?.categorySpecialties || [],
    trustLevel:           identityProfile?.trustLevel || "INSUFFICIENT",
    // No raw DealIQ score
  };

  const policySnapshot = {
    certVersion:  certRecord?.certVersion || null,
    certifiedAt:  certRecord?.certifiedAt || null,
    expiresAt:    certRecord?.expiresAt   || null,
    tier:         certRecord?.tier        || null,
  };

  return buildPortableTrustPacket(redis, {
    packetType:   PACKET_TYPE.RESELLER_TRUST,
    subjectId:    userId,
    subjectType:  "reseller",
    trustStatus:  certRecord?.status || "NONE",
    evidenceSummary,
    policySnapshot,
    verificationReference: referenceRecord || null,
    exportChannel,
  });
}

// ── Ops ───────────────────────────────────────────────────────────────────────

export async function getTrustPortabilityOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalCreated: ops["total_created"] || 0,
      byChannel: Object.fromEntries(
        Object.entries(ops).filter(([k]) => k.startsWith("channel.")).map(([k, v]) => [k.replace("channel.", ""), v])
      ),
      byType: Object.fromEntries(
        Object.entries(ops).filter(([k]) => k.startsWith("type.")).map(([k, v]) => [k.replace("type.", ""), v])
      ),
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _isPublicSafe(channel) {
  return [EXPORT_CHANNEL.PUBLIC, EXPORT_CHANNEL.DISPUTE].includes(channel);
}

function _isPartnerSafe(channel) {
  return [EXPORT_CHANNEL.PARTNER, EXPORT_CHANNEL.INSURANCE, EXPORT_CHANNEL.LENDER,
          EXPORT_CHANNEL.DISPUTE].includes(channel);
}

function _sanitizeEvidenceSummary(evidence, channel) {
  if (!evidence) return {};
  // Strip any internal-only fields regardless of channel
  const UNSAFE = ["rawTrustScore", "authScore", "counterfeitMatchScore", "oracleDecision",
                  "modelVersion", "signalDebug", "categoryRuleThresholds"];
  const clean = { ...evidence };
  for (const field of UNSAFE) delete clean[field];
  return clean;
}

function _sanitizePolicySnapshot(snapshot, channel) {
  if (!snapshot) return {};
  // Policy snapshot is always partner-safe minimum
  // For public channel, further restrict
  if (_isPublicSafe(channel) && !_isPartnerSafe(channel)) {
    return {
      verificationVersion: snapshot.verificationVersion,
      status:              snapshot.status,
      issuedAt:            snapshot.issuedAt,
    };
  }
  const UNSAFE = ["categoryRuleThresholds", "modelVersion", "rawScores"];
  const clean = { ...snapshot };
  for (const field of UNSAFE) delete clean[field];
  return clean;
}

function _packetAuditHash(packet) {
  const canonical = {
    packetId:    packet.packetId,
    packetType:  packet.packetType,
    subjectId:   packet.subjectId,
    trustStatus: packet.trustStatus,
    issuedAt:    packet.issuedAt,
    expiresAt:   packet.expiresAt,
    portabilityVersion: packet.portabilityVersion,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);
}
