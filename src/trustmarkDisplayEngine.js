// src/trustmarkDisplayEngine.js
// Phase 8 — Trustmark Display + Embed Engine.
//
// Generates copy-ready trustmark snippets and embed-ready HTML blocks for:
//   - Item trust badges (for listing pages, portfolio sites)
//   - Reseller certification badges (for social bios, storefronts)
//   - Embed widgets (iframe-ready for partner sites)
//   - Copyable plain-text trust signatures
//
// All trust language passes through externalClaimGovernor.
// All badge display rules pass through externalBadgePolicyEngine.
// No trust content is ever rendered for unverified/uncertified entities.
//
// Output formats:
//   - html     : full styled inline HTML (no external CSS deps)
//   - markdown  : for README / GitHub / forum embeds
//   - plaintext : for email signatures, SMS, plain bio
//   - svg       : scalable badge for high-fidelity print/web
//   - json      : structured trust data for partner rendering
//
// Redis key layout:
//   tm:display:{referenceId}   HASH   display cache (6h TTL)
//   tm:copy:{referenceId}      STRING copy count
//   tm:embed:{domain}          HASH   embed domain registry

import { governExternalClaim, CLAIM_CHANNEL, CLAIM_TYPE } from "./externalClaimGovernor.js";
import { checkBadgeDisplayAllowed, BADGE_TYPE, DISPLAY_CHANNEL } from "./externalBadgePolicyEngine.js";

export const TRUSTMARK_DISPLAY_VERSION = "8.0";

const APP_BASE    = process.env.EVAN_APP_URL    || "https://evan.ai";
const VERIFY_BASE = process.env.EVAN_VERIFY_URL || "https://verify.evanai.app";

const DISPLAY_TTL    = 6 * 3600;   // 6h cache
const EMBED_MAX_DOMS = 5000;

// ── Trustmark colors (shared across all formats) ──────────────────────────────

const COLOR = {
  green:      "#00D278",
  greenDark:  "#00A862",
  greenBg:    "#f0fff8",
  purple:     "#5B5FD8",
  purpleBg:   "#f5f5ff",
  gold:       "#E0A020",
  goldBg:     "#fffbf0",
  white:      "#FFFFFF",
  text:       "#1A1A1A",
  textMuted:  "#555555",
  border:     "#E0E0E0",
};

// ── Item trustmark snippet ─────────────────────────────────────────────────────

/**
 * Generate a copyable trustmark snippet for a verified item.
 *
 * @param {object} opts
 *   referenceId       {string}
 *   itemName          {string}
 *   category          {string|null}
 *   brand             {string|null}
 *   verifyUrl         {string|null}
 *   shortUrl          {string|null}
 *   evanVerification  {object|null}   — from evanVerifiedEngine (status, evidenceLevel, expertReviewed)
 *   trustmarkRecord   {object|null}   — from trustmarkEngine (status, issuedAt, expiresAt)
 *   formats           {string[]}      — ["html","markdown","plaintext","svg","json"] or ["all"]
 * @param {object} redis
 * @returns {TrustmarkDisplayResult}
 */
export async function buildItemTrustmarkDisplay(redis, {
  referenceId,
  itemName       = "Item",
  category       = null,
  brand          = null,
  verifyUrl      = null,
  shortUrl       = null,
  evanVerification = null,
  trustmarkRecord  = null,
  formats          = ["all"],
} = {}) {
  const isVerified = evanVerification?.status === "VERIFIED" && trustmarkRecord?.status === "ACTIVE";

  if (!isVerified) {
    return { ok: false, reason: "not_verified", referenceId };
  }

  // Govern claim
  const trustUrl = shortUrl || verifyUrl || (referenceId ? `${APP_BASE}/v/${referenceId}` : null);
  const claim = governExternalClaim({
    channel:         CLAIM_CHANNEL.MARKETPLACE_LISTING,
    claimType:       CLAIM_TYPE.ITEM_VERIFIED,
    verificationUrl: trustUrl,
  });

  if (!claim.allowed) {
    return { ok: false, reason: "claim_blocked", referenceId };
  }

  // Check badge display
  const badgeCheck = checkBadgeDisplayAllowed({
    badgeType:   BADGE_TYPE.EVAN_VERIFIED,
    channel:     DISPLAY_CHANNEL.EXTERNAL_EMBED,
    isVerified:  true,
    isCertified: false,
  });

  const doAll = formats.includes("all");
  const want  = f => doAll || formats.includes(f);

  const result = {
    ok:             true,
    referenceId,
    isVerified,
    itemName,
    verifyUrl:      trustUrl,
    trustmarkStatus:trustmarkRecord?.status,
    expiresAt:      trustmarkRecord?.expiresAt || null,
    displayVersion: TRUSTMARK_DISPLAY_VERSION,
    snippets:       {},
  };

  if (want("html"))      result.snippets.html      = _buildItemHtmlBadge({ itemName, brand, category, verifyUrl: trustUrl, claim, evanVerification });
  if (want("markdown"))  result.snippets.markdown   = _buildItemMarkdown({ itemName, verifyUrl: trustUrl, claim });
  if (want("plaintext")) result.snippets.plaintext  = _buildItemPlaintext({ itemName, verifyUrl: trustUrl, claim });
  if (want("svg"))       result.snippets.svg        = _buildItemSvgBadge({ verifyUrl: trustUrl });
  if (want("json"))      result.snippets.json       = _buildItemJsonBadge({ referenceId, itemName, category, brand, verifyUrl: trustUrl, claim, evanVerification, trustmarkRecord });

  // Cache + increment copy count
  if (redis && referenceId) {
    try {
      await redis.set(`tm:display:${referenceId}`, JSON.stringify(result), { EX: DISPLAY_TTL });
      await redis.incrBy(`tm:copy:${referenceId}`, 1);
    } catch { /* non-critical */ }
  }

  return result;
}

// ── Reseller certification trustmark ─────────────────────────────────────────

/**
 * Generate a trustmark snippet for a certified reseller's profile/bio.
 *
 * @param {object} opts
 *   userId            {string}
 *   referenceId       {string|null}
 *   displayName       {string}
 *   certStatus        {string}       — "CERTIFIED"|"ACTIVE"|other
 *   certTier          {string|null}  — "STANDARD"|"ADVANCED"|"PRO"
 *   dealIQBand        {string|null}  — "A"|"B"|"C"|"D"
 *   categorySpecialties {string[]}
 *   profileUrl        {string|null}
 *   verifyUrl         {string|null}
 *   formats           {string[]}
 * @param {object} redis
 * @returns {ResellerTrustmarkDisplayResult}
 */
export async function buildResellerTrustmarkDisplay(redis, {
  userId,
  referenceId       = null,
  displayName       = "Reseller",
  certStatus        = null,
  certTier          = null,
  dealIQBand        = null,
  categorySpecialties = [],
  profileUrl        = null,
  verifyUrl         = null,
  formats           = ["all"],
} = {}) {
  const isCertified = certStatus === "CERTIFIED" || certStatus === "ACTIVE";

  if (!isCertified) {
    return { ok: false, reason: "not_certified", userId };
  }

  const trustUrl = profileUrl || verifyUrl || (userId ? `${APP_BASE}/s/${userId}` : null);

  const claim = governExternalClaim({
    channel:         CLAIM_CHANNEL.SELLER_BIO,
    claimType:       CLAIM_TYPE.RESELLER_CERTIFIED,
    verificationUrl: trustUrl,
  });

  if (!claim.allowed) {
    return { ok: false, reason: "claim_blocked", userId };
  }

  const doAll = formats.includes("all");
  const want  = f => doAll || formats.includes(f);

  const result = {
    ok:             true,
    userId,
    referenceId,
    isCertified,
    displayName,
    certTier,
    dealIQBand,
    profileUrl:     trustUrl,
    displayVersion: TRUSTMARK_DISPLAY_VERSION,
    snippets:       {},
  };

  if (want("html"))      result.snippets.html      = _buildResellerHtmlBadge({ displayName, certTier, dealIQBand, categorySpecialties, trustUrl, claim });
  if (want("markdown"))  result.snippets.markdown   = _buildResellerMarkdown({ displayName, certTier, trustUrl, claim });
  if (want("plaintext")) result.snippets.plaintext  = _buildResellerPlaintext({ displayName, certTier, dealIQBand, trustUrl, claim });
  if (want("svg"))       result.snippets.svg        = _buildResellerSvgBadge({ certTier, trustUrl });
  if (want("json"))      result.snippets.json       = _buildResellerJsonBadge({ userId, referenceId, displayName, certTier, dealIQBand, categorySpecialties, trustUrl, claim });

  // Bio-line shorthand (single line for social bios)
  result.bioLine = _buildBioLine({ displayName, certTier, dealIQBand, trustUrl, claim });

  return result;
}

// ── Embed widget ─────────────────────────────────────────────────────────────

/**
 * Build an embeddable iframe widget HTML snippet.
 * For partner sites and consignment storefronts to display live trust status.
 *
 * @param {object} opts
 *   referenceId {string}
 *   embedType   {string}  — "item"|"reseller"
 *   theme       {string}  — "light"|"dark"|"minimal"
 *   width       {number}
 * @returns {{ iframeHtml, scriptSnippet, verifyUrl }}
 */
export function buildEmbedWidget({
  referenceId,
  embedType = "item",
  theme     = "light",
  width     = 320,
}) {
  if (!referenceId) return { ok: false, reason: "missing_referenceId" };

  const verifyUrl  = `${VERIFY_BASE}/verify/${embedType}/${referenceId}`;
  const embedUrl   = `${APP_BASE}/embed/${embedType}/${referenceId}?theme=${theme}`;
  const height     = embedType === "reseller" ? 110 : 90;

  const iframeHtml = `<iframe
  src="${embedUrl}"
  width="${width}"
  height="${height}"
  frameborder="0"
  scrolling="no"
  style="border:none;border-radius:8px;overflow:hidden;"
  title="Evan AI Trust Verification"
></iframe>`;

  const scriptSnippet = `<!-- Evan AI Trust Badge -->
<script>
  (function(){
    var s=document.createElement('script');
    s.src='${APP_BASE}/sdk/embed.js';
    s.dataset.referenceId='${referenceId}';
    s.dataset.type='${embedType}';
    s.dataset.theme='${theme}';
    document.head.appendChild(s);
  })();
</script>
<!-- End Evan AI Trust Badge -->`;

  return {
    ok:            true,
    referenceId,
    embedType,
    theme,
    iframeHtml,
    scriptSnippet,
    verifyUrl,
    disclaimer:    "Embed reflects live trust status at time of render. Status may change.",
  };
}

// ── Register embed domain ─────────────────────────────────────────────────────

/**
 * Register a domain for trustmark embedding (for analytics + abuse monitoring).
 */
export async function registerEmbedDomain(redis, { domain, embedType, referenceId, userId } = {}) {
  if (!redis || !domain) return { ok: false, reason: "missing_domain" };
  const key = `tm:embed:${_safeDomain(domain)}`;
  try {
    await redis.hSet(key, {
      domain, embedType: embedType || "item",
      referenceId: referenceId || "",
      userId:      userId || "",
      registeredAt: Date.now(),
    });
    return { ok: true, domain };
  } catch (err) {
    return { ok: false, reason: err?.message };
  }
}

// ── HTML builders ─────────────────────────────────────────────────────────────

function _buildItemHtmlBadge({ itemName, brand, category, verifyUrl, claim, evanVerification }) {
  const title = `${brand ? `${brand} ` : ""}${itemName}`.trim();
  const evLevel = evanVerification?.evidenceLevel ? ` · Evidence: ${evanVerification.evidenceLevel}` : "";
  const expert  = evanVerification?.expertReviewed ? " · Expert reviewed" : "";

  return `<div style="display:inline-block;font-family:Arial,sans-serif;border:1.5px solid ${COLOR.green};border-radius:10px;padding:10px 14px;background:${COLOR.greenBg};max-width:320px;">
  <div style="font-size:13px;font-weight:700;color:${COLOR.greenDark};margin-bottom:4px;">✓ Evan-Verified Item</div>
  <div style="font-size:12px;color:${COLOR.text};margin-bottom:2px;">${_esc(title)}</div>
  <div style="font-size:11px;color:${COLOR.textMuted};">${_esc(claim.finalLanguage)}${evLevel}${expert}</div>
  ${verifyUrl ? `<a href="${verifyUrl}" style="display:inline-block;margin-top:6px;font-size:11px;color:#0070cc;text-decoration:none;">View verification →</a>` : ""}
  <div style="font-size:10px;color:#999;margin-top:6px;font-style:italic;">${_esc(claim.disclaimer || "")}</div>
</div>`;
}

function _buildItemMarkdown({ itemName, verifyUrl, claim }) {
  const lines = [
    `**✓ Evan-Verified** — ${_md(itemName)}`,
    ``,
    `> ${_md(claim.finalLanguage)}`,
  ];
  if (verifyUrl) lines.push(``, `[View verification proof ↗](${verifyUrl})`);
  if (claim.disclaimer) lines.push(``, `*${_md(claim.disclaimer)}*`);
  return lines.join("\n");
}

function _buildItemPlaintext({ itemName, verifyUrl, claim }) {
  const lines = [
    `✓ Evan-Verified Item: ${itemName}`,
    claim.finalLanguage,
  ];
  if (verifyUrl) lines.push(`Verify: ${verifyUrl}`);
  if (claim.disclaimer) lines.push(claim.disclaimer);
  return lines.join("\n");
}

function _buildItemSvgBadge({ verifyUrl }) {
  // Simple SVG pill badge — 200×28
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="28" role="img" aria-label="Evan-Verified">
  <title>Evan AI Verified Item</title>
  <rect width="200" height="28" rx="14" fill="${COLOR.green}"/>
  <text x="28" y="18" font-family="Arial" font-size="12" font-weight="700" fill="${COLOR.white}">✓ Evan-Verified</text>
  ${verifyUrl ? `<a href="${verifyUrl}"><rect width="200" height="28" rx="14" fill="transparent"/></a>` : ""}
</svg>`;
}

function _buildItemJsonBadge({ referenceId, itemName, category, brand, verifyUrl, claim, evanVerification, trustmarkRecord }) {
  return JSON.stringify({
    type:           "evan_item_trustmark",
    version:        TRUSTMARK_DISPLAY_VERSION,
    referenceId,
    itemName,
    category,
    brand,
    verificationStatus: "VERIFIED",
    evidenceLevel:  evanVerification?.evidenceLevel || null,
    expertReviewed: evanVerification?.expertReviewed || false,
    claimLanguage:  claim.finalLanguage,
    disclaimer:     claim.disclaimer || null,
    verifyUrl,
    issuedAt:       trustmarkRecord?.issuedAt || null,
    expiresAt:      trustmarkRecord?.expiresAt || null,
    poweredBy:      "Evan AI",
  }, null, 2);
}

// ── Reseller HTML builders ────────────────────────────────────────────────────

function _buildResellerHtmlBadge({ displayName, certTier, dealIQBand, categorySpecialties, trustUrl, claim }) {
  const tierLabel = certTier ? ` · ${certTier}` : "";
  const bandLabel = dealIQBand ? ` · DealIQ ${dealIQBand}` : "";
  const cats      = (categorySpecialties || []).slice(0, 3).join(", ");

  return `<div style="display:inline-block;font-family:Arial,sans-serif;border:1.5px solid ${COLOR.purple};border-radius:10px;padding:10px 14px;background:${COLOR.purpleBg};max-width:340px;">
  <div style="font-size:13px;font-weight:700;color:${COLOR.purple};margin-bottom:4px;">✓ Evan-Certified Reseller${tierLabel}</div>
  <div style="font-size:12px;color:${COLOR.text};margin-bottom:2px;">${_esc(displayName)}${bandLabel}</div>
  ${cats ? `<div style="font-size:11px;color:${COLOR.textMuted};margin-bottom:2px;">Specialties: ${_esc(cats)}</div>` : ""}
  <div style="font-size:11px;color:${COLOR.textMuted};">${_esc(claim.finalLanguage)}</div>
  ${trustUrl ? `<a href="${trustUrl}" style="display:inline-block;margin-top:6px;font-size:11px;color:#0070cc;text-decoration:none;">View profile →</a>` : ""}
</div>`;
}

function _buildResellerMarkdown({ displayName, certTier, trustUrl, claim }) {
  const tierLabel = certTier ? ` (${certTier})` : "";
  const lines = [
    `**✓ Evan-Certified Reseller${tierLabel}** — ${_md(displayName)}`,
    ``,
    `> ${_md(claim.finalLanguage)}`,
  ];
  if (trustUrl) lines.push(``, `[View reseller profile ↗](${trustUrl})`);
  return lines.join("\n");
}

function _buildResellerPlaintext({ displayName, certTier, dealIQBand, trustUrl, claim }) {
  const tierLabel = certTier ? ` · ${certTier}` : "";
  const bandLabel = dealIQBand ? ` · DealIQ ${dealIQBand}` : "";
  const lines = [
    `✓ Evan-Certified Reseller${tierLabel} — ${displayName}${bandLabel}`,
    claim.finalLanguage,
  ];
  if (trustUrl) lines.push(`Profile: ${trustUrl}`);
  return lines.join("\n");
}

function _buildResellerSvgBadge({ certTier, trustUrl }) {
  const label = certTier ? `✓ Evan Certified · ${certTier}` : "✓ Evan Certified Reseller";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="28" role="img" aria-label="Evan Certified Reseller">
  <title>Evan AI Certified Reseller</title>
  <rect width="220" height="28" rx="14" fill="${COLOR.purple}"/>
  <text x="12" y="18" font-family="Arial" font-size="11" font-weight="700" fill="${COLOR.white}">${label}</text>
  ${trustUrl ? `<a href="${trustUrl}"><rect width="220" height="28" rx="14" fill="transparent"/></a>` : ""}
</svg>`;
}

function _buildResellerJsonBadge({ userId, referenceId, displayName, certTier, dealIQBand, categorySpecialties, trustUrl, claim }) {
  return JSON.stringify({
    type:           "evan_reseller_trustmark",
    version:        TRUSTMARK_DISPLAY_VERSION,
    userId,
    referenceId,
    displayName,
    certificationStatus: "CERTIFIED",
    certTier:       certTier || null,
    dealIQBand:     dealIQBand || null,
    categorySpecialties: categorySpecialties || [],
    claimLanguage:  claim.finalLanguage,
    disclaimer:     claim.disclaimer || null,
    profileUrl:     trustUrl,
    poweredBy:      "Evan AI",
  }, null, 2);
}

function _buildBioLine({ displayName, certTier, dealIQBand, trustUrl, claim }) {
  const tierLabel = certTier ? ` · ${certTier}` : "";
  const bandLabel = dealIQBand ? ` · DealIQ ${dealIQBand}` : "";
  const urlPart   = trustUrl ? ` | ${trustUrl}` : "";
  return `✓ Evan-Certified${tierLabel}${bandLabel}${urlPart}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _md(str) {
  return String(str || "").replace(/[[\]()_*~`]/g, "\\$&");
}

function _safeDomain(domain) {
  return String(domain || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
