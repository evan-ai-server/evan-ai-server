// src/shareableLinkEngine.js
// Phase 8 — Shareable Verification Link Engine.
//
// Users must be able to share Evan trust externally with a single tap.
// This engine generates the complete sharing package:
//   - Stable shareable URLs (evan.ai/v/{referenceId} for items, evan.ai/s/{userId} for resellers)
//   - Open Graph meta tags for rich preview cards in iMessage, WhatsApp, Twitter, etc.
//   - QR code generation for physical/in-person trust display (swap meets, conventions)
//   - Copy-ready share text for different contexts
//
// OG strategy: when a buyer receives a verification link in a text message, the
// preview card shows "Evan-Verified ✓" with the item category — before they even click.
// That is the trust signal that drives purchasing confidence and viral sharing.
//
// QR strategy: a reseller at a physical market can display their Evan QR code on a
// card/phone. Buyer scans → sees certified profile → trusts the seller immediately.
//
// Uses externalTrustReferenceEngine for live verification status.
// Uses externalClaimGovernor for safe share-text language.
//
// Redis key layout:
//   share:link:{referenceId}   HASH   click count, share count, created
//   share:profile:{userId}     HASH   profile view count, qr scans
//   share:ops                  HASH   global share ops counters

import { REFERENCE_TYPE, REFERENCE_STATUS } from "./externalTrustReferenceEngine.js";
import { governExternalClaim, CLAIM_CHANNEL, CLAIM_TYPE } from "./externalClaimGovernor.js";

export const SHARE_VERSION = "8.0";

// ── Base URLs ─────────────────────────────────────────────────────────────────

const APP_BASE      = process.env.EVAN_APP_URL      || "https://evan.ai";
const VERIFY_BASE   = process.env.EVAN_VERIFY_URL   || "https://verify.evanai.app";
const OG_IMAGE_BASE = process.env.EVAN_OG_IMAGE_URL || "https://assets.evanai.app/og";
const QR_API_BASE   = "https://api.qrserver.com/v1/create-qr-code";

// ── Redis key builders ─────────────────────────────────────────────────────────

const KEY_LINK    = refId  => `share:link:${refId}`;
const KEY_PROFILE = userId => `share:profile:${_safe(userId)}`;
const KEY_OPS     = ()     => `share:ops`;

const LINK_TTL    = 365 * 86400;   // 1 year

// ── Shareable item verification link ─────────────────────────────────────────

/**
 * Generate the complete sharing package for an Evan-Verified item.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceId      {string}   — extref referenceId from Phase 7
 *   referenceRecord  {object}   — the full extref record (for status/summary)
 *   itemName         {string}   — human name (e.g. "Nike Air Max 90")
 *   category         {string}   — for OG image selection
 *   brand            {string|null}
 *   userId           {string|null}  — user sharing this link
 * @returns {ShareableItemLink}
 */
export async function buildShareableItemLink(redis, {
  referenceId,
  referenceRecord  = null,
  itemName         = null,
  category         = "item",
  brand            = null,
  userId           = null,
} = {}) {
  if (!referenceId) return null;

  const verifyUrl  = `${VERIFY_BASE}/verify/item/${referenceId}`;
  const shortUrl   = `${APP_BASE}/v/${referenceId}`;
  const isActive   = referenceRecord?.status === REFERENCE_STATUS.ACTIVE;
  const itemTitle  = _buildItemTitle(itemName, brand, category);

  // Claim-safe share text
  const claimResult = governExternalClaim({
    channel:         CLAIM_CHANNEL.MARKETPLACE_LISTING,
    claimType:       CLAIM_TYPE.ITEM_VERIFIED,
    verificationUrl: shortUrl,
  });

  const shareText   = isActive
    ? `${itemTitle} — ${claimResult.finalLanguage || `Evan-Verified. Verify: ${shortUrl}`}`
    : `Verification status: ${referenceRecord?.status || "UNKNOWN"}. Check: ${shortUrl}`;

  const ogMeta = buildItemOGMeta({ referenceId, itemTitle, category, brand, verifyUrl, shortUrl, isActive, referenceRecord });
  const qrCode = buildQRCode(shortUrl, { size: 300, label: `Evan-Verified: ${itemTitle}` });

  // Track in Redis
  if (redis) {
    await redis.hSet(KEY_LINK(referenceId), {
      referenceId, shortUrl, verifyUrl,
      itemTitle, category, brand: brand || "",
      createdBy:   userId || "unknown",
      createdAt:   Date.now(),
      clickCount:  0,
      shareCount:  0,
    }).catch(() => {});
    await redis.expire(KEY_LINK(referenceId), LINK_TTL).catch(() => {});
    await redis.hIncrBy(KEY_OPS(), "links_created", 1).catch(() => {});
  }

  return {
    referenceId,
    shortUrl,
    verifyUrl,
    itemTitle,
    isActive,
    shareText,
    copyText:    shareText,
    ogMeta,
    qrCode,
    disclaimer:  claimResult.disclaimer || null,
    shareVersion:SHARE_VERSION,
  };
}

// ── Shareable reseller profile link ──────────────────────────────────────────

/**
 * Generate the complete sharing package for an Evan-Certified reseller profile.
 * Includes QR code for physical display at swap meets / conventions.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId          {string}
 *   referenceId     {string|null}  — extref referenceId for reseller cert
 *   displayName     {string|null}
 *   certStatus      {string|null}
 *   certTier        {string|null}
 *   dealIQBand      {string|null}  — "A"|"B"|"C"|"D"
 *   categorySpecialties {string[]}
 * @returns {ShareableResellerLink}
 */
export async function buildShareableResellerLink(redis, {
  userId,
  referenceId     = null,
  displayName     = null,
  certStatus      = null,
  certTier        = null,
  dealIQBand      = null,
  categorySpecialties = [],
} = {}) {
  if (!userId) return null;

  const profileUrl = `${APP_BASE}/s/${_safe(userId)}`;
  const verifyUrl  = referenceId ? `${VERIFY_BASE}/verify/reseller/${referenceId}` : null;
  const isCertified = certStatus === "CERTIFIED";
  const name        = displayName || "Evan Reseller";

  // QR code for physical display — larger size for print
  const qrCode = buildQRCode(profileUrl, {
    size: 400,
    label: `Evan Profile: ${name}`,
    format: "png",
  });

  // QR code embed HTML for physical card / email signature
  const qrEmbedHtml = buildQREmbedHtml(profileUrl, {
    name,
    isCertified,
    dealIQBand,
    verifyUrl,
  });

  const ogMeta = buildResellerOGMeta({
    userId, displayName: name, certStatus, certTier,
    dealIQBand, categorySpecialties, profileUrl, verifyUrl,
  });

  // Claim-safe share text for seller bio
  const claimResult = isCertified
    ? governExternalClaim({ channel: CLAIM_CHANNEL.SELLER_BIO, claimType: CLAIM_TYPE.RESELLER_CERTIFIED, verificationUrl: verifyUrl || profileUrl })
    : null;

  const shareText = isCertified && claimResult?.allowed
    ? `${name} — ${claimResult.finalLanguage} ${profileUrl}`
    : `${name} — Reseller profile on Evan AI: ${profileUrl}`;

  if (redis) {
    await redis.hSet(KEY_PROFILE(userId), {
      userId, profileUrl, referenceId: referenceId || "",
      displayName: name, certStatus: certStatus || "",
      createdAt: Date.now(), viewCount: 0, qrScanCount: 0,
    }).catch(() => {});
    await redis.hIncrBy(KEY_OPS(), "profiles_shared", 1).catch(() => {});
  }

  return {
    userId,
    profileUrl,
    verifyUrl,
    referenceId,
    displayName:  name,
    isCertified,
    certTier,
    dealIQBand,
    categorySpecialties,
    shareText,
    copyText:     shareText,
    ogMeta,
    qrCode,
    qrEmbedHtml,
    disclaimer:   isCertified && claimResult?.disclaimer ? claimResult.disclaimer : null,
    shareVersion: SHARE_VERSION,
  };
}

// ── Open Graph meta tag builders ─────────────────────────────────────────────

/**
 * Build OG meta tags for an item verification page.
 * These are injected into the HTML head of the /verify/item/:id page.
 * When shared in iMessage / WhatsApp / Twitter, shows a rich preview card.
 */
export function buildItemOGMeta({
  referenceId, itemTitle, category, brand, verifyUrl, shortUrl, isActive, referenceRecord,
} = {}) {
  const statusLabel = isActive ? "Evan-Verified ✓" : (referenceRecord?.status === "REVOKED" ? "Revoked" : "Expired");
  const catLabel    = category ? ` · ${_capitalizeCategory(category)}` : "";
  const brandLabel  = brand    ? ` · ${brand}` : "";

  return {
    "og:type":        "website",
    "og:url":         shortUrl || verifyUrl,
    "og:title":       `${statusLabel}${brandLabel}${catLabel}`,
    "og:description": isActive
      ? `${itemTitle || "This item"} has been verified by Evan AI. View full authentication evidence.`
      : `Verification status: ${referenceRecord?.status || "UNKNOWN"}. This credential may no longer be valid.`,
    "og:image":       `${OG_IMAGE_BASE}/item-${isActive ? "verified" : "revoked"}.png`,
    "og:image:width": "1200",
    "og:image:height":"630",
    "og:image:alt":   statusLabel,
    "og:site_name":   "Evan AI",
    "twitter:card":   "summary_large_image",
    "twitter:title":  `${statusLabel}${brandLabel}${catLabel}`,
    "twitter:description": isActive
      ? `Verified by Evan AI. Tap to see full authentication evidence.`
      : `This Evan credential is no longer active.`,
    "twitter:image":  `${OG_IMAGE_BASE}/item-${isActive ? "verified" : "revoked"}.png`,
    "twitter:site":   "@evanai",
    "theme-color":    isActive ? "#00D278" : "#888888",
    canonical:        shortUrl || verifyUrl,
    _rendered:        _renderOGHtml({ isActive, itemTitle, statusLabel, catLabel, brandLabel, shortUrl, verifyUrl, ogImage: `${OG_IMAGE_BASE}/item-${isActive ? "verified" : "revoked"}.png` }),
  };
}

/**
 * Build OG meta tags for a reseller profile page.
 */
export function buildResellerOGMeta({
  userId, displayName, certStatus, certTier, dealIQBand,
  categorySpecialties, profileUrl, verifyUrl,
} = {}) {
  const isCertified = certStatus === "CERTIFIED";
  const statusLabel = isCertified ? "Evan-Certified Reseller ✓" : "Evan Reseller";
  const cats        = (categorySpecialties || []).slice(0, 3).map(_capitalizeCategory).join(", ");
  const dealBand    = dealIQBand && isCertified ? ` · DealIQ: ${dealIQBand}` : "";

  return {
    "og:type":         "profile",
    "og:url":          profileUrl,
    "og:title":        `${displayName || "Evan Reseller"} — ${statusLabel}`,
    "og:description":  isCertified
      ? `${displayName || "This reseller"} is Evan-Certified${cats ? ` · Specializes in ${cats}` : ""}${dealBand}. Tap to view their verified profile.`
      : `${displayName || "This reseller"} has a profile on Evan AI. View their resale activity.`,
    "og:image":        `${OG_IMAGE_BASE}/reseller-${isCertified ? "certified" : "standard"}.png`,
    "og:image:width":  "1200",
    "og:image:height": "630",
    "og:image:alt":    statusLabel,
    "og:site_name":    "Evan AI",
    "twitter:card":    "summary_large_image",
    "twitter:title":   `${displayName || "Evan Reseller"} — ${statusLabel}`,
    "twitter:description": isCertified
      ? `Verified reseller on Evan AI. Certified · ${cats || "Resale"}${dealBand}`
      : `Reseller profile on Evan AI.`,
    "twitter:image":   `${OG_IMAGE_BASE}/reseller-${isCertified ? "certified" : "standard"}.png`,
    "twitter:site":    "@evanai",
    "theme-color":     isCertified ? "#5B5FD8" : "#888888",
    canonical:         profileUrl,
    _rendered:         _renderResellerOGHtml({ displayName, statusLabel, profileUrl, verifyUrl, isCertified, cats, dealBand, ogImage: `${OG_IMAGE_BASE}/reseller-${isCertified ? "certified" : "standard"}.png` }),
  };
}

// ── QR code builders ─────────────────────────────────────────────────────────

/**
 * Build a QR code package for a URL.
 * Returns multiple formats: the QR image URL, a data URI endpoint, and embed HTML.
 *
 * @param {string} url        — the URL to encode
 * @param {object} opts
 *   size   {number}   — pixel size (default 300)
 *   label  {string}   — descriptive label for accessibility
 *   format {string}   — "png"|"svg" (default "png")
 * @returns {QRCodePackage}
 */
export function buildQRCode(url, {
  size   = 300,
  label  = "Evan Verification",
  format = "png",
} = {}) {
  if (!url) return null;
  const encoded  = encodeURIComponent(url);
  const imageUrl = `${QR_API_BASE}/?size=${size}x${size}&data=${encoded}&format=${format}&margin=1&color=000000&bgcolor=ffffff`;
  const imgTag   = `<img src="${imageUrl}" alt="${label}" width="${size}" height="${size}" style="display:block;" />`;

  return {
    url,
    imageUrl,
    size,
    format,
    label,
    imgTag,
    // Instructions for physical printing
    printInstructions: `Download and print at ${size}px or larger. Minimum 1.5" × 1.5" for reliable scanning.`,
    embedHtml: `<a href="${url}" style="display:inline-block;text-decoration:none;">${imgTag}<br/><span style="font-family:sans-serif;font-size:11px;color:#666;">${label}</span></a>`,
  };
}

/**
 * Build a styled QR code embed HTML block for reseller profile cards.
 * Designed for "Scan my Evan Profile" physical display.
 */
export function buildQREmbedHtml(profileUrl, {
  name        = "Reseller",
  isCertified = false,
  dealIQBand  = null,
  verifyUrl   = null,
} = {}) {
  const encoded  = encodeURIComponent(profileUrl);
  const qrUrl    = `${QR_API_BASE}/?size=300x300&data=${encoded}&format=png&margin=1`;
  const badge    = isCertified ? "Evan-Certified Reseller" : "Evan Reseller";
  const bandLine = isCertified && dealIQBand ? `<div style="font-size:11px;color:#5B5FD8;font-weight:700;margin-top:2px;">DealIQ: ${dealIQBand}</div>` : "";

  return `
<div style="font-family:system-ui,sans-serif;text-align:center;padding:16px;background:#fff;border:1px solid #e0e0e0;border-radius:12px;display:inline-block;max-width:200px;">
  <img src="${qrUrl}" alt="Scan to view ${name}'s Evan profile" width="160" height="160" style="display:block;margin:0 auto 8px;" />
  <div style="font-weight:700;font-size:13px;color:#111;">${name}</div>
  <div style="font-size:11px;color:${isCertified ? "#00D278" : "#888"};font-weight:600;margin-top:2px;">${badge}</div>
  ${bandLine}
  <div style="font-size:10px;color:#999;margin-top:6px;">Scan to verify on Evan AI</div>
  ${verifyUrl ? `<div style="font-size:9px;color:#bbb;margin-top:2px;word-break:break-all;">${verifyUrl}</div>` : ""}
</div>`.trim();
}

// ── Share event recording ─────────────────────────────────────────────────────

/**
 * Record a share event (user shared a link externally).
 * Feeds into network effect signals.
 */
export async function recordShareEvent(redis, referenceId, { userId = null, platform = null } = {}) {
  if (!redis || !referenceId) return;
  try {
    await redis.hIncrBy(KEY_LINK(referenceId), "shareCount", 1);
    await redis.hIncrBy(KEY_OPS(), "total_shares", 1);
    if (platform) await redis.hIncrBy(KEY_OPS(), `platform.${platform}`, 1);
  } catch {}
}

/**
 * Record a click/view event on a shared link.
 */
export async function recordLinkClick(redis, referenceId) {
  if (!redis || !referenceId) return;
  try {
    await redis.hIncrBy(KEY_LINK(referenceId), "clickCount", 1);
    await redis.hIncrBy(KEY_OPS(), "total_clicks", 1);
  } catch {}
}

/**
 * Record a QR code scan event on a reseller profile.
 */
export async function recordQRScan(redis, userId) {
  if (!redis || !userId) return;
  try {
    await redis.hIncrBy(KEY_PROFILE(userId), "qrScanCount", 1);
    await redis.hIncrBy(KEY_OPS(), "total_qr_scans", 1);
  } catch {}
}

export async function getShareOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      linksCreated:   ops["links_created"]  || 0,
      profilesShared: ops["profiles_shared"]|| 0,
      totalShares:    ops["total_shares"]   || 0,
      totalClicks:    ops["total_clicks"]   || 0,
      totalQRScans:   ops["total_qr_scans"] || 0,
      byPlatform:     Object.fromEntries(Object.entries(ops).filter(([k]) => k.startsWith("platform.")).map(([k,v]) => [k.replace("platform.",""),v])),
    };
  } catch { return {}; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _buildItemTitle(itemName, brand, category) {
  if (itemName) return itemName;
  const parts = [brand, _capitalizeCategory(category)].filter(Boolean);
  return parts.join(" ") || "Item";
}

function _capitalizeCategory(cat) {
  if (!cat) return "";
  return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function _renderOGHtml({ isActive, itemTitle, statusLabel, catLabel, brandLabel, shortUrl, verifyUrl, ogImage }) {
  return [
    `<title>${statusLabel}${brandLabel}${catLabel} — Evan AI</title>`,
    `<meta name="description" content="${isActive ? `${itemTitle || "Item"} verified by Evan AI.` : "This credential is no longer active."}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${shortUrl || verifyUrl}" />`,
    `<meta property="og:title" content="${statusLabel}${brandLabel}${catLabel}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:site_name" content="Evan AI" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${statusLabel}${brandLabel}${catLabel}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<link rel="canonical" href="${shortUrl || verifyUrl}" />`,
  ].join("\n");
}

function _renderResellerOGHtml({ displayName, statusLabel, profileUrl, verifyUrl, isCertified, cats, dealBand, ogImage }) {
  const desc = isCertified
    ? `${displayName} is Evan-Certified${cats ? ` · ${cats}` : ""}${dealBand}.`
    : `${displayName} has a reseller profile on Evan AI.`;
  return [
    `<title>${displayName} — ${statusLabel} — Evan AI</title>`,
    `<meta name="description" content="${desc}" />`,
    `<meta property="og:type" content="profile" />`,
    `<meta property="og:url" content="${profileUrl}" />`,
    `<meta property="og:title" content="${displayName} — ${statusLabel}" />`,
    `<meta property="og:description" content="${desc}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:site_name" content="Evan AI" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${displayName} — ${statusLabel}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<link rel="canonical" href="${profileUrl}" />`,
  ].join("\n");
}
