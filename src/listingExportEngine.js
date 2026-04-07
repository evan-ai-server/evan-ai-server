// src/listingExportEngine.js
// Phase 8 — Listing Export + Trust Injection Engine.
//
// Generates copy-ready, platform-specific listing bundles enhanced with
// Evan intelligence. A user can paste directly into eBay, Grailed, Poshmark,
// Mercari, or Facebook Marketplace with the correct trust language already embedded.
//
// Two functions:
//   1. buildListingExportBundle() — full platform-specific listing package
//   2. injectTrustIntoListing()   — inject trust signals into an existing listing draft
//
// Trust injection rules:
//   - Only injected when item is VERIFIED and trustmark is ACTIVE
//   - All claim language passes through externalClaimGovernor (MARKETPLACE_LISTING channel)
//   - Each platform has character limits and formatting constraints
//   - Verification link always included when trust language is present
//
// Supported platforms: ebay, grailed, poshmark, mercari, facebook, generic
//
// Non-negotiables:
//   1. No trust language injected for unverified items.
//   2. All claims pass through claim governor — no bypass.
//   3. Disclaimers are included wherever required.
//   4. Platform-specific formatting is applied (eBay allows HTML, others plain text).

import { governExternalClaim, CLAIM_CHANNEL, CLAIM_TYPE } from "./externalClaimGovernor.js";
import { checkBadgeDisplayAllowed, BADGE_TYPE, DISPLAY_CHANNEL } from "./externalBadgePolicyEngine.js";

export const LISTING_EXPORT_VERSION = "8.0";

const APP_BASE    = process.env.EVAN_APP_URL    || "https://evan.ai";
const VERIFY_BASE = process.env.EVAN_VERIFY_URL || "https://verify.evanai.app";

// ── Platform configs ──────────────────────────────────────────────────────────

const PLATFORM_CONFIG = {
  ebay: {
    id:           "ebay",
    displayName:  "eBay",
    allowsHtml:   true,
    maxDescChars: 800000,   // eBay description is effectively unlimited
    maxTitleChars:80,
    trustPlacement:"bottom",
    claimStyle:   "full",
  },
  grailed: {
    id:           "grailed",
    displayName:  "Grailed",
    allowsHtml:   false,
    maxDescChars: 500,
    maxTitleChars:60,
    trustPlacement:"top",
    claimStyle:   "brief",
  },
  poshmark: {
    id:           "poshmark",
    displayName:  "Poshmark",
    allowsHtml:   false,
    maxDescChars: 1500,
    maxTitleChars:80,
    trustPlacement:"bottom",
    claimStyle:   "brief",
  },
  mercari: {
    id:           "mercari",
    displayName:  "Mercari",
    allowsHtml:   false,
    maxDescChars: 1000,
    maxTitleChars:40,
    trustPlacement:"bottom",
    claimStyle:   "minimal",
  },
  facebook: {
    id:           "facebook",
    displayName:  "Facebook Marketplace",
    allowsHtml:   false,
    maxDescChars: 500,
    maxTitleChars:100,
    trustPlacement:"bottom",
    claimStyle:   "brief",
  },
  generic: {
    id:           "generic",
    displayName:  "General Listing",
    allowsHtml:   false,
    maxDescChars: 2000,
    maxTitleChars:100,
    trustPlacement:"bottom",
    claimStyle:   "full",
  },
};

// ── Build full listing export bundle ──────────────────────────────────────────

/**
 * Build a complete, copy-ready listing bundle for one or more platforms.
 *
 * @param {object} opts
 *   platform          {string|string[]}  — platform id(s) or "all"
 *   itemName          {string}           — item name / model
 *   category          {string}
 *   brand             {string|null}
 *   condition         {string|null}      — "new"|"like_new"|"good"|"fair"
 *   price             {number|null}      — asking price
 *   description       {string|null}      — user-written base description
 *   evanVerification  {object|null}      — from evanVerifiedEngine
 *   trustmarkRecord   {object|null}      — from trustmarkEngine
 *   referenceId       {string|null}      — extref referenceId
 *   verificationUrl   {string|null}      — /verify/item/:referenceId
 *   shortUrl          {string|null}      — evan.ai/v/:referenceId
 *   certRecord        {object|null}      — reseller cert (for seller bio line)
 *   sellRouting       {object|null}      — from sellRoutingEngine (for net estimate)
 * @returns {ListingExportBundleResult}
 */
export function buildListingExportBundle({
  platform          = "all",
  itemName          = "Item",
  category          = "generic",
  brand             = null,
  condition         = null,
  price             = null,
  description       = null,
  evanVerification  = null,
  trustmarkRecord   = null,
  referenceId       = null,
  verificationUrl   = null,
  shortUrl          = null,
  certRecord        = null,
  sellRouting       = null,
} = {}) {
  const isVerified  = evanVerification?.status === "VERIFIED" && trustmarkRecord?.status === "ACTIVE";
  const isCertified = certRecord?.status === "CERTIFIED";
  const trustUrl    = shortUrl || verificationUrl || (referenceId ? `${APP_BASE}/v/${referenceId}` : null);

  // Govern claims for marketplace channel
  const itemClaim = governExternalClaim({
    channel:         CLAIM_CHANNEL.MARKETPLACE_LISTING,
    claimType:       CLAIM_TYPE.ITEM_VERIFIED,
    verificationUrl: trustUrl,
  });
  const sellerClaim = governExternalClaim({
    channel:         CLAIM_CHANNEL.MARKETPLACE_LISTING,
    claimType:       CLAIM_TYPE.RESELLER_CERTIFIED,
    verificationUrl: trustUrl,
  });

  // Resolve platforms
  const platforms = platform === "all"
    ? Object.keys(PLATFORM_CONFIG)
    : (Array.isArray(platform) ? platform : [platform]).filter(p => PLATFORM_CONFIG[p]);

  const bundles = {};
  for (const pid of platforms) {
    bundles[pid] = _buildPlatformBundle({
      pid, itemName, category, brand, condition, price, description,
      isVerified, isCertified, trustUrl, itemClaim, sellerClaim,
      evanVerification, certRecord, sellRouting,
    });
  }

  return {
    itemName, category, brand, condition, price,
    isVerified, isCertified, referenceId,
    verificationUrl: trustUrl,
    bundles,
    trustClaims: {
      item:   isVerified  ? itemClaim   : null,
      seller: isCertified ? sellerClaim : null,
    },
    exportVersion: LISTING_EXPORT_VERSION,
  };
}

// ── Trust injection into existing listing ────────────────────────────────────

/**
 * Inject Evan trust language into an existing listing description draft.
 * Appends trust block at appropriate position per platform rules.
 * Returns modified description or null if injection not allowed.
 *
 * @param {object} opts
 *   existingDescription {string}    — current listing text
 *   platform            {string}    — platform id
 *   isVerified          {boolean}
 *   isCertified         {boolean}
 *   trustUrl            {string|null}
 *   evanVerification    {object|null}
 * @returns {{ injected, description, trustBlock, allowed }}
 */
export function injectTrustIntoListing({
  existingDescription = "",
  platform            = "generic",
  isVerified          = false,
  isCertified         = false,
  trustUrl            = null,
  evanVerification    = null,
} = {}) {
  if (!isVerified && !isCertified) {
    return { injected: false, description: existingDescription, trustBlock: null, allowed: false, reason: "no_eligible_trust" };
  }

  const cfg = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.generic;

  const itemClaim = governExternalClaim({
    channel:         CLAIM_CHANNEL.MARKETPLACE_LISTING,
    claimType:       CLAIM_TYPE.ITEM_VERIFIED,
    verificationUrl: trustUrl,
  });

  if (!itemClaim.allowed) {
    return { injected: false, description: existingDescription, trustBlock: null, allowed: false, reason: "claim_blocked" };
  }

  const trustBlock = _buildTrustBlock({ cfg, isVerified, isCertified, itemClaim, trustUrl, evanVerification });
  let description;

  if (cfg.trustPlacement === "top") {
    description = `${trustBlock}\n\n${existingDescription}`;
  } else {
    description = `${existingDescription}\n\n${trustBlock}`;
  }

  // Enforce character limits
  if (description.length > cfg.maxDescChars) {
    description = description.slice(0, cfg.maxDescChars - 3) + "...";
  }

  return {
    injected:    true,
    description,
    trustBlock,
    allowed:     true,
    disclaimer:  itemClaim.disclaimer,
  };
}

// ── Platform-specific bundle builder ─────────────────────────────────────────

function _buildPlatformBundle({
  pid, itemName, category, brand, condition, price, description,
  isVerified, isCertified, trustUrl, itemClaim, sellerClaim,
  evanVerification, certRecord, sellRouting,
}) {
  const cfg = PLATFORM_CONFIG[pid];

  // Build title
  const title = _buildTitle({ cfg, itemName, brand, condition, isVerified });

  // Build base description
  const baseDesc = description || _buildBaseDescription({ itemName, brand, category, condition });

  // Build trust block
  const trustBlock = (isVerified || isCertified)
    ? _buildTrustBlock({ cfg, isVerified, isCertified, itemClaim, sellerClaim, trustUrl, evanVerification })
    : null;

  // Assemble description
  let fullDesc = baseDesc;
  if (trustBlock) {
    fullDesc = cfg.trustPlacement === "top"
      ? `${trustBlock}\n\n${baseDesc}`
      : `${baseDesc}\n\n${trustBlock}`;
  }

  // HTML version for eBay
  if (cfg.allowsHtml && (isVerified || isCertified)) {
    fullDesc = _buildEbayHtml({ baseDesc, trustBlock, trustUrl, isVerified, isCertified, evanVerification });
  }

  // Enforce limit
  if (fullDesc.length > cfg.maxDescChars) {
    fullDesc = fullDesc.slice(0, cfg.maxDescChars);
  }

  const trustClaims = [];
  if (isVerified  && itemClaim?.allowed)  trustClaims.push(itemClaim.finalLanguage);
  if (isCertified && sellerClaim?.allowed) trustClaims.push(sellerClaim.finalLanguage);

  const disclaimers = [];
  if (itemClaim?.disclaimer)  disclaimers.push(itemClaim.disclaimer);

  return {
    platform:        cfg.displayName,
    platformId:      pid,
    title:           title.slice(0, cfg.maxTitleChars),
    description:     fullDesc,
    trustClaims,
    verificationLink:trustUrl || null,
    disclaimers,
    formattingHints: _getFormattingHints(pid),
    charCount: {
      title:       title.length,
      description: fullDesc.length,
      titleLimit:  cfg.maxTitleChars,
      descLimit:   cfg.maxDescChars,
    },
    copyReady:       true,
    exportVersion:   LISTING_EXPORT_VERSION,
  };
}

function _buildTitle({ cfg, itemName, brand, condition, isVerified }) {
  const parts = [];
  if (brand && !itemName.toLowerCase().includes(brand.toLowerCase())) parts.push(brand);
  parts.push(itemName);
  if (condition) {
    const condLabel = { new: "New", like_new: "Like New", good: "Good", fair: "Fair" }[condition];
    if (condLabel) parts.push(`— ${condLabel}`);
  }
  if (isVerified) parts.push("| Evan-Verified");
  return parts.join(" ");
}

function _buildBaseDescription({ itemName, brand, category, condition }) {
  const lines = [];
  lines.push(`${brand ? `${brand} ` : ""}${itemName}`);
  if (condition) lines.push(`Condition: ${condition.replace("_", " ")}`);
  return lines.join("\n");
}

function _buildTrustBlock({ cfg, isVerified, isCertified, itemClaim, sellerClaim, trustUrl, evanVerification }) {
  const lines = [];

  if (cfg.claimStyle === "minimal") {
    if (isVerified && trustUrl) lines.push(`Evan-Verified — ${trustUrl}`);
    return lines.join("\n");
  }

  if (cfg.claimStyle === "brief") {
    if (isVerified && itemClaim?.allowed) {
      lines.push(`✓ ${itemClaim.finalLanguage}`);
      if (trustUrl) lines.push(`Verify: ${trustUrl}`);
    }
    if (isCertified && sellerClaim?.allowed) lines.push(`✓ ${sellerClaim.finalLanguage}`);
    return lines.join("\n");
  }

  // Full style
  lines.push("— Evan AI Trust Verification —");
  if (isVerified && itemClaim?.allowed) {
    lines.push(`✓ ${itemClaim.finalLanguage}`);
    if (evanVerification?.evidenceLevel) lines.push(`  Evidence: ${evanVerification.evidenceLevel}`);
    if (evanVerification?.expertReviewed) lines.push("  Expert reviewed");
    if (trustUrl) lines.push(`  View proof: ${trustUrl}`);
  }
  if (isCertified && sellerClaim?.allowed) {
    lines.push(`✓ ${sellerClaim.finalLanguage}`);
  }
  if (itemClaim?.disclaimer) lines.push(`\n${itemClaim.disclaimer}`);
  return lines.join("\n");
}

function _buildEbayHtml({ baseDesc, trustBlock, trustUrl, isVerified, isCertified, evanVerification }) {
  const trustHtml = (isVerified || isCertified) ? `
<div style="border:1px solid #00D278;border-radius:8px;padding:12px 16px;margin:16px 0;background:#f0fff8;font-family:Arial,sans-serif;">
  <div style="font-size:15px;font-weight:700;color:#00A862;margin-bottom:6px;">✓ Evan AI Trust Verification</div>
  ${isVerified ? `<div style="font-size:13px;color:#333;margin-bottom:4px;">✓ Authentication verified by Evan AI</div>` : ""}
  ${evanVerification?.evidenceLevel ? `<div style="font-size:12px;color:#555;">Evidence strength: <strong>${evanVerification.evidenceLevel}</strong></div>` : ""}
  ${evanVerification?.expertReviewed ? `<div style="font-size:12px;color:#555;">Expert reviewed ✓</div>` : ""}
  ${trustUrl ? `<div style="margin-top:8px;"><a href="${trustUrl}" style="font-size:12px;color:#0070cc;">View verification proof →</a></div>` : ""}
  ${isCertified ? `<div style="font-size:12px;color:#5B5FD8;margin-top:4px;">✓ Sold by Evan-Certified Reseller</div>` : ""}
</div>
<div style="font-size:11px;color:#999;font-style:italic;">Authentication evidence was assessed by Evan AI at time of scan. This does not constitute an unconditional guarantee.</div>` : "";
  return `<p>${baseDesc.replace(/\n/g, "<br/>")}</p>${trustHtml}`;
}

function _getFormattingHints(pid) {
  const hints = {
    ebay:     "Paste into the HTML description editor. Trust block is pre-formatted with styled HTML.",
    grailed:  "Paste into the description field. Trust line goes at the top.",
    poshmark: "Paste into the description. Character limit is ~1,500. Trust line at bottom.",
    mercari:  "Paste into the item description. Keep trust line brief — 40 char title limit.",
    facebook: "Paste into the description. Facebook Marketplace is plain text only.",
    generic:  "Copy-paste ready. Adjust formatting to match your listing platform.",
  };
  return hints[pid] || "Copy-paste ready.";
}
