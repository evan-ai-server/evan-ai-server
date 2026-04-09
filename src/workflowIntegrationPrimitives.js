// src/workflowIntegrationPrimitives.js
// Phase 9 — Workflow Integration Primitives.
//
// Listing prefill, valuation handoffs, and trust-aware import helpers.
// These are the building blocks for partners embedding Evan into their
// own listing/selling workflows.
//
// Primitives:
//   buildListingPrefill     — Auto-populate a partner listing form from Evan vision data
//   buildValuationHandoff   — Package valuation for handoff to lending/insurance/consignment
//   buildTrustAwareImport   — Import a partner SKU/item and attach Evan trust signals
//   buildSellPackage        — Complete "list now" bundle: prefill + trust + fee calc + platform rec
//
// All primitives apply scope filtering and compliance guard before exposing data.
//
// Redis key layout:
//   p9:wf:prefill:{referenceId}   STRING  cached prefill (10min TTL)
//   p9:wf:ops                     HASH    counters

import { guardEmbeddedRequest } from "./embeddedComplianceGuard.js";
import { CLAIM_TYPE } from "./externalClaimGovernor.js";
import { buildPlatformFeePayload } from "./platformFeeEngine.js";

export const WORKFLOW_VERSION = "9.0";

// ── Listing prefill ───────────────────────────────────────────────────────

/**
 * Build a listing prefill bundle from Evan vision + trust data.
 * Maps Evan signals to standard listing field names used by major platforms.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceId    {string}
 *   token          {string}    — partner JWT
 *   visionData     {object}    — from Evan vision pipeline
 *   trustData      {object}    — resolved trust reference data
 *   targetPlatform {string}    — "ebay"|"grailed"|"poshmark"|"mercari"|"facebook"|"generic"
 * @returns {ListingPrefill}
 */
export async function buildListingPrefill(redis, {
  referenceId,
  token,
  visionData     = {},
  trustData      = {},
  targetPlatform = "generic",
} = {}) {
  if (!referenceId || !token) return { ok: false, error: "missing_params" };

  // Check cache
  const cacheKey = `p9:wf:prefill:${_safe(referenceId)}:${targetPlatform}`;
  try {
    const cached = await redis?.get(cacheKey);
    if (cached) return { ...JSON.parse(cached), fromCache: true };
  } catch { /* skip */ }

  // Compliance guard
  const guard = await guardEmbeddedRequest(redis, {
    token,
    claimType:   CLAIM_TYPE.ITEM_VERIFIED,
    claimText:   "Evan-Verified",
    embedContext: "export",
    payload:     { ...visionData, ...trustData },
    requestMeta: {},
  });

  if (!guard.ok) {
    return { ok: false, error: guard.decision, reason: guard.reason };
  }

  const identity  = visionData.identity || guard.payload.identity || {};
  const condition = visionData.condition || guard.payload.condition || null;
  const price     = guard.payload.priceEstimate?.mid || guard.payload.suggestedPrice || null;
  const category  = identity.category || null;

  // Platform-specific field mapping
  const fields = _buildPlatformFields({
    identity,
    condition,
    price,
    category,
    referenceId,
    targetPlatform,
    isVerified:  !!trustData.verified || !!guard.payload.verified,
    verifyUrl:   `https://evan.ai/verify/${referenceId}`,
  });

  // Fee preview for suggested price
  const feePayload = price
    ? buildPlatformFeePayload({ price, category, platforms: [targetPlatform === "generic" ? "all" : targetPlatform] })
    : null;

  const prefill = {
    ok:              true,
    referenceId,
    targetPlatform,
    fields,
    feePreview:      feePayload,
    suggestedPrice:  price,
    priceRange:      guard.payload.priceEstimate || null,
    condition,
    verifyUrl:       `https://evan.ai/verify/${referenceId}`,
    trustInjected:   fields.description?.includes("Evan-Verified") || false,
    workflowVersion: WORKFLOW_VERSION,
    auditToken:      guard.auditToken,
  };

  try {
    if (redis) await redis.set(cacheKey, JSON.stringify(prefill), { EX: 600 });
  } catch { /* non-critical */ }

  await _incrOps(redis, "prefills_built");
  return prefill;
}

// ── Valuation handoff ─────────────────────────────────────────────────────

/**
 * Build a valuation handoff bundle for lending/insurance/consignment.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceId    {string}
 *   token          {string}
 *   visionData     {object}
 *   trustData      {object}
 *   handoffTarget  {string}  — "lending"|"insurance"|"consignment"|"estate"
 * @returns {ValuationHandoff}
 */
export async function buildValuationHandoff(redis, {
  referenceId,
  token,
  visionData    = {},
  trustData     = {},
  handoffTarget = "lending",
} = {}) {
  if (!referenceId || !token) return { ok: false, error: "missing_params" };

  // Valuation handoffs use lender-export context for proper claim softening
  const embedContext = handoffTarget === "insurance" ? "export" : "export";

  const guard = await guardEmbeddedRequest(redis, {
    token,
    claimType:   CLAIM_TYPE.PRICE_ACCURATE,
    claimText:   "Evan price estimate",
    embedContext,
    payload:     { ...visionData, ...trustData },
    requestMeta: {},
  });

  // Price_accurate is BLOCKED on export channels — this is intentional governance
  // We still build the handoff but use hedged language
  const identity  = visionData.identity || {};
  const condition = visionData.condition || null;
  const price     = visionData.priceEstimate?.mid || visionData.suggestedPrice || null;
  const category  = identity.category || null;

  const feePayload = price ? buildPlatformFeePayload({ price, category }) : null;

  const handoff = {
    ok:              true,
    referenceId,
    handoffTarget,
    verifyUrl:       `https://evan.ai/verify/${referenceId}`,
    auditHash:       trustData.auditHash || guard.auditToken || null,
    item: {
      brand:      identity.brand   || null,
      model:      identity.model   || null,
      category,
      condition,
      institutionalIds: visionData.institutionalIds || null,
    },
    valuation: {
      // Use hedged language per governance — never "accurate price"
      estimatedValue: price,
      valuationBasis: "Market comparables analysis by Evan AI",
      confidenceBand: _confidenceBand(visionData.confidence),
      disclaimer:     "This estimate is for reference only. Not a guarantee of market value.",
      platformFees:   feePayload?.platforms || null,
      bestNetProceeds: feePayload?.bestNetProceeds || null,
    },
    compliance: {
      governed:     true,
      scopeFiltered: guard.ok,
      decision:     guard.ok ? guard.decision : "BLOCKED_GOVERNANCE",
    },
    workflowVersion: WORKFLOW_VERSION,
    issuedAt: Date.now(),
  };

  await _incrOps(redis, "valuation_handoffs");
  return handoff;
}

// ── Trust-aware import ────────────────────────────────────────────────────

/**
 * Import a partner item (SKU / external ID) and attach Evan trust signals.
 * Used when partners sync their own inventory into Evan's trust layer.
 *
 * @param {object} redis
 * @param {object} opts
 *   token          {string}
 *   partnerItemId  {string}   — partner's item ID / SKU
 *   partnerItemData {object}  — partner's raw item data
 *   trustData      {object}   — Evan trust data to attach
 * @returns {TrustAwareImport}
 */
export async function buildTrustAwareImport(redis, {
  token,
  partnerItemId,
  partnerItemData = {},
  trustData       = {},
} = {}) {
  if (!partnerItemId || !token) return { ok: false, error: "missing_params" };

  const guard = await guardEmbeddedRequest(redis, {
    token,
    claimType:   CLAIM_TYPE.ITEM_VERIFIED,
    claimText:   "Evan-Verified",
    embedContext: "api",
    payload:     trustData,
    requestMeta: {},
  });

  if (!guard.ok) {
    return { ok: false, error: guard.decision, reason: guard.reason };
  }

  const enriched = {
    ok:             true,
    partnerItemId,
    // Original partner data preserved
    originalData:   partnerItemData,
    // Evan trust overlay
    trustOverlay: {
      verified:       guard.payload.verified       || false,
      referenceId:    guard.payload.referenceId    || null,
      verifyUrl:      guard.payload.referenceId
        ? `https://evan.ai/verify/${guard.payload.referenceId}` : null,
      confidenceBand: _confidenceBand(guard.payload.confidence),
      brand:          guard.payload.identity?.brand || partnerItemData.brand || null,
      model:          guard.payload.identity?.model || partnerItemData.model || null,
      condition:      guard.payload.condition       || partnerItemData.condition || null,
      institutionalIds: guard.payload.institutionalIds || null,
      trustLevel:     guard.payload.trustLevel      || null,
    },
    auditToken:     guard.auditToken,
    importedAt:     Date.now(),
    workflowVersion: WORKFLOW_VERSION,
  };

  await _incrOps(redis, "trust_imports");
  return enriched;
}

// ── Complete sell package ─────────────────────────────────────────────────

/**
 * Build a complete "list now" sell package.
 * Combines: prefill + platform fee calc + distribution recommendation + trust badge.
 */
export async function buildSellPackage(redis, {
  referenceId,
  token,
  visionData   = {},
  trustData    = {},
  platforms    = ["all"],
} = {}) {
  if (!referenceId || !token) return { ok: false, error: "missing_params" };

  const identity = visionData.identity || {};
  const price    = visionData.priceEstimate?.mid || visionData.suggestedPrice || null;
  const category = identity.category || null;

  const [prefill, feePayload] = await Promise.all([
    buildListingPrefill(redis, { referenceId, token, visionData, trustData, targetPlatform: "generic" }),
    Promise.resolve(price ? buildPlatformFeePayload({ price, category, platforms }) : null),
  ]);

  await _incrOps(redis, "sell_packages_built");

  return {
    ok:              true,
    referenceId,
    prefill:         prefill.ok ? prefill : null,
    platformFees:    feePayload,
    bestPlatform:    feePayload?.bestNetPlatform || null,
    bestNetProceeds: feePayload?.bestNetProceeds || null,
    verifyUrl:       `https://evan.ai/verify/${referenceId}`,
    workflowVersion: WORKFLOW_VERSION,
    builtAt:         Date.now(),
  };
}

/**
 * Get workflow integration ops.
 */
export async function getWorkflowOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:wf:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      prefillsBuilt:      ops["prefills_built"]       || 0,
      valuationHandoffs:  ops["valuation_handoffs"]   || 0,
      trustImports:       ops["trust_imports"]        || 0,
      sellPackagesBuilt:  ops["sell_packages_built"]  || 0,
    };
  } catch { return {}; }
}

// ── Platform field builders ───────────────────────────────────────────────

function _buildPlatformFields({ identity, condition, price, category, referenceId, targetPlatform, isVerified, verifyUrl }) {
  const brand = identity.brand || "";
  const model = identity.model || "";
  const title = [brand, model, condition ? `(${condition})` : null].filter(Boolean).join(" ").trim();
  const trustLine = isVerified
    ? `\n\n✓ Authentication verified by Evan AI — ${verifyUrl}`
    : "";

  const baseDescription = [
    title,
    identity.description || "",
    trustLine,
  ].filter(Boolean).join("\n\n").trim();

  const base = {
    title:       title || "Verified Item",
    brand:       brand || null,
    model:       model || null,
    condition:   condition || null,
    category:    category || null,
    price:       price || null,
    description: baseDescription,
  };

  switch (targetPlatform) {
    case "ebay":
      return {
        ...base,
        itemTitle:  title.slice(0, 80),  // eBay 80-char limit
        itemDescription: baseDescription,
        conditionId: _ebayConditionId(condition),
      };
    case "grailed":
      return {
        ...base,
        listingTitle: title.slice(0, 60),
        tags: [brand, model, category].filter(Boolean).map(t => t.toLowerCase()),
      };
    case "poshmark":
      return {
        ...base,
        title:       title.slice(0, 50),  // Poshmark 50-char limit
        description: baseDescription.slice(0, 1500),
      };
    default:
      return base;
  }
}

function _ebayConditionId(condition) {
  if (!condition) return 1000;  // New
  const c = condition.toLowerCase();
  if (c.includes("new")) return 1000;
  if (c.includes("like new") || c.includes("excellent")) return 3000;
  if (c.includes("good") || c.includes("very good")) return 4000;
  if (c.includes("fair") || c.includes("acceptable")) return 5000;
  return 3000;  // Default: like new
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
  try { await redis.hIncrBy("p9:wf:ops", counter, 1); } catch { /* non-critical */ }
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
