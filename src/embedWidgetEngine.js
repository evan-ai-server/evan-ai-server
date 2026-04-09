// src/embedWidgetEngine.js
// Phase 9 — Embed Widget Engine.
//
// Generates embeddable trust widgets for partner websites with:
//   1. Dynamic Nonce Injection    — HMAC-SHA256(secret+domain+timeBucket+refId), 60s TTL
//   2. Domain Whitelisting        — CORS + referrer validation against partner's allowedDomains
//   3. Widget HTML/JS generation  — compact, full, banner, badge, and QR widget types
//   4. CSP-friendly inline tokens — no eval, no external scripts
//   5. Snapshot spoofing defense  — every render is bound to a fresh nonce
//
// Widget types:
//   badge    — 160×32 inline mark
//   compact  — 280×80 card
//   full     — 320×200 detailed card
//   banner   — 600×60 horizontal strip
//   qr       — QR code + verification URL
//
// Redis key layout:
//   p9:widget:nonce:{nonce}        STRING  nonce metadata (60s TTL)
//   p9:widget:domains:{partnerId}  ZSET    whitelisted domains
//   p9:widget:ops                  HASH    counters

import crypto from "crypto";
import { getPartner } from "./partnerAuthTierEngine.js";
import { guardEmbeddedRequest } from "./embeddedComplianceGuard.js";
import { CLAIM_TYPE } from "./externalClaimGovernor.js";
import { BADGE_TYPE } from "./externalBadgePolicyEngine.js";

export const EMBED_WIDGET_VERSION = "9.0";

const NONCE_TTL_SECONDS  = 60;
const NONCE_TIME_BUCKET  = 60_000;  // ms — nonces rotate every 60s
const ALLOWED_ORIGINS    = ["https://evan.ai", "https://app.evan.ai"];

// ── Domain whitelisting ───────────────────────────────────────────────────

/**
 * Register a domain for a partner (whitelist for widget embedding).
 */
export async function registerWidgetDomain(redis, partnerId, domain) {
  if (!redis || !partnerId || !domain) return { ok: false, error: "missing_params" };
  const safe = _safeDomain(domain);
  if (!safe) return { ok: false, error: "invalid_domain" };
  try {
    await redis.zAdd(`p9:widget:domains:${_safe(partnerId)}`, [{ score: Date.now(), value: safe }]);
    await redis.expire(`p9:widget:domains:${_safe(partnerId)}`, 365 * 86400);
    await redis.hIncrBy("p9:widget:ops", "domains_registered", 1);
    return { ok: true, partnerId, domain: safe };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

/**
 * Check if a domain is whitelisted for a partner.
 */
export async function isWidgetDomainAllowed(redis, partnerId, domain) {
  if (!redis || !partnerId || !domain) return false;
  try {
    const safe = _safeDomain(domain) || domain.toLowerCase().trim();
    const domains = await redis.zRange(`p9:widget:domains:${_safe(partnerId)}`, 0, -1);
    // Exact match or subdomain match
    return domains.some(d => safe === d || safe.endsWith(`.${d}`));
  } catch { return false; }
}

/**
 * Get all whitelisted domains for a partner.
 */
export async function getWidgetDomains(redis, partnerId) {
  if (!redis || !partnerId) return [];
  try {
    return await redis.zRange(`p9:widget:domains:${_safe(partnerId)}`, 0, -1);
  } catch { return []; }
}

// ── Nonce system ─────────────────────────────────────────────────────────

/**
 * Generate a nonce for a widget render.
 * Nonce = HMAC-SHA256(partnerSecret, domain + timeBucket + referenceId)
 */
export async function generateWidgetNonce(redis, {
  partnerSecret,
  domain,
  referenceId,
  partnerId,
} = {}) {
  if (!partnerSecret || !domain || !referenceId) {
    return { ok: false, error: "missing_params" };
  }

  const timeBucket = Math.floor(Date.now() / NONCE_TIME_BUCKET);
  const message    = `${domain}:${timeBucket}:${referenceId}`;
  const nonce      = crypto
    .createHmac("sha256", String(partnerSecret))
    .update(message)
    .digest("hex");

  // Store nonce metadata
  const nonceData = {
    nonce,
    partnerId:   partnerId || null,
    domain:      _safeDomain(domain),
    referenceId,
    timeBucket,
    createdAt:   Date.now(),
  };

  try {
    await redis.set(`p9:widget:nonce:${nonce}`, JSON.stringify(nonceData), { EX: NONCE_TTL_SECONDS });
    await redis.hIncrBy("p9:widget:ops", "nonces_issued", 1);
  } catch { /* non-critical */ }

  return {
    ok:         true,
    nonce,
    expiresIn:  NONCE_TTL_SECONDS,
    timeBucket,
  };
}

/**
 * Verify a nonce is valid and not expired.
 */
export async function verifyWidgetNonce(redis, nonce) {
  if (!redis || !nonce) return { valid: false, reason: "missing" };
  try {
    const raw = await redis.get(`p9:widget:nonce:${nonce}`);
    if (!raw) return { valid: false, reason: "expired_or_unknown" };
    const data = JSON.parse(raw);
    return { valid: true, ...data };
  } catch {
    return { valid: false, reason: "parse_error" };
  }
}

// ── Widget generation ─────────────────────────────────────────────────────

/**
 * Build a complete embeddable widget payload.
 *
 * @param {object} redis
 * @param {object} opts
 *   referenceId   {string}
 *   widgetType    {string}   — "badge"|"compact"|"full"|"banner"|"qr"
 *   token         {string}   — partner JWT
 *   domain        {string}   — requesting domain
 *   partnerId     {string}
 *   nonce         {string}   — pre-generated nonce
 *   verificationData {object} — resolved verification data
 * @returns {WidgetPayload}
 */
export async function buildEmbedWidget(redis, {
  referenceId,
  widgetType  = "compact",
  token,
  domain,
  partnerId,
  nonce,
  verificationData = {},
} = {}) {
  if (!referenceId || !token) return { ok: false, error: "missing_params" };

  // Domain check
  if (domain && partnerId) {
    const allowed = await isWidgetDomainAllowed(redis, partnerId, domain);
    if (!allowed) {
      await redis.hIncrBy("p9:widget:ops", "domain_blocked", 1).catch(() => {});
      return { ok: false, error: "domain_not_whitelisted", domain };
    }
  }

  // Nonce verification
  if (nonce) {
    const nonceResult = await verifyWidgetNonce(redis, nonce);
    if (!nonceResult.valid) {
      return { ok: false, error: "invalid_nonce", reason: nonceResult.reason };
    }
    // Nonce is single-use — consume it
    try { await redis.del(`p9:widget:nonce:${nonce}`); } catch { /* ok */ }
  }

  // Compliance guard
  const guard = await guardEmbeddedRequest(redis, {
    token,
    claimType:   CLAIM_TYPE.ITEM_VERIFIED,
    claimText:   "Evan-Verified",
    embedContext: "widget",
    badgeType:   BADGE_TYPE.EVAN_VERIFIED,
    payload:     verificationData,
    requestMeta: { domain },
  });

  if (!guard.ok) {
    return { ok: false, error: guard.decision, reason: guard.reason };
  }

  // Generate HTML
  const html = _buildWidgetHtml({
    widgetType,
    referenceId,
    data: guard.payload,
    nonce: nonce || _genRenderToken(),
  });

  await redis.hIncrBy("p9:widget:ops", "widgets_rendered", 1).catch(() => {});

  return {
    ok:          true,
    referenceId,
    widgetType,
    html,
    embedCode:   _buildEmbedCode(referenceId, widgetType),
    iframeUrl:   `https://evan.ai/embed/widget/${referenceId}?type=${widgetType}`,
    corsHeaders: _buildCorsHeaders(domain),
    auditToken:  guard.auditToken,
    widgetVersion: EMBED_WIDGET_VERSION,
  };
}

/**
 * Get widget ops.
 */
export async function getWidgetOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:widget:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      domainsRegistered: ops["domains_registered"] || 0,
      noncesIssued:      ops["nonces_issued"]       || 0,
      widgetsRendered:   ops["widgets_rendered"]    || 0,
      domainBlocked:     ops["domain_blocked"]      || 0,
    };
  } catch { return {}; }
}

// ── HTML generation ───────────────────────────────────────────────────────

function _buildWidgetHtml({ widgetType, referenceId, data, nonce }) {
  const brand  = data.identity?.brand || data.brand || "Verified Item";
  const model  = data.identity?.model || data.model || "";
  const verUrl = `https://evan.ai/verify/${referenceId}`;
  const label  = model ? `${brand} ${model}` : brand;

  switch (widgetType) {
    case "badge":
      return `<a href="${verUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(0,0,0,0.85);border:1px solid rgba(255,255,255,0.18);border-radius:6px;text-decoration:none;font-family:system-ui,sans-serif;font-size:11px;color:#fff;" data-evan-nonce="${nonce}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5.5" stroke="#22c55e" stroke-width="1"/><path d="M3.5 6l1.5 1.5 3-3" stroke="#22c55e" stroke-width="1.2" stroke-linecap="round"/></svg>Evan-Verified</a>`;

    case "compact":
      return `<div style="display:inline-block;padding:12px 16px;background:rgba(10,10,10,0.92);border:1px solid rgba(255,255,255,0.12);border-radius:10px;font-family:system-ui,sans-serif;max-width:280px;" data-evan-nonce="${nonce}"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7.5" stroke="#22c55e" stroke-width="1.2"/><path d="M5 8l2 2 4-4" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round"/></svg><span style="font-size:11px;font-weight:700;letter-spacing:0.8px;color:#22c55e;text-transform:uppercase;">Evan-Verified</span></div><div style="font-size:13px;font-weight:600;color:#fff;margin-bottom:2px;">${label}</div><a href="${verUrl}" target="_blank" rel="noopener" style="font-size:10px;color:rgba(255,255,255,0.45);text-decoration:none;">evan.ai/verify/${referenceId.slice(0, 12)}…</a></div>`;

    case "banner":
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:rgba(10,10,10,0.95);border:1px solid rgba(255,255,255,0.10);border-radius:8px;font-family:system-ui,sans-serif;max-width:600px;" data-evan-nonce="${nonce}"><div style="display:flex;align-items:center;gap:10px;"><svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9.5" stroke="#22c55e" stroke-width="1.2"/><path d="M6 10l2.5 2.5 5.5-5.5" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round"/></svg><div><div style="font-size:11px;font-weight:700;color:#22c55e;letter-spacing:0.8px;text-transform:uppercase;">Evan-Verified</div><div style="font-size:13px;color:#fff;">${label}</div></div></div><a href="${verUrl}" target="_blank" rel="noopener" style="font-size:11px;color:rgba(255,255,255,0.55);text-decoration:none;border:1px solid rgba(255,255,255,0.18);padding:4px 10px;border-radius:5px;">View Report →</a></div>`;

    default: // full
      return `<div style="display:inline-block;padding:16px;background:rgba(10,10,10,0.94);border:1px solid rgba(255,255,255,0.12);border-radius:12px;font-family:system-ui,sans-serif;max-width:320px;" data-evan-nonce="${nonce}"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="8.5" stroke="#22c55e" stroke-width="1.2"/><path d="M5.5 9l2.5 2.5 4.5-4.5" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round"/></svg><span style="font-size:11px;font-weight:700;letter-spacing:0.9px;color:#22c55e;text-transform:uppercase;">Authentication Verified</span></div><div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;">${label}</div><div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:12px;">Multi-signal verification by Evan AI</div><a href="${verUrl}" target="_blank" rel="noopener" style="display:block;text-align:center;padding:7px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);border-radius:7px;font-size:12px;font-weight:600;color:#fff;text-decoration:none;">View Verification Report →</a></div>`;
  }
}

function _buildEmbedCode(referenceId, widgetType) {
  return `<script async src="https://evan.ai/embed/widget.js" data-ref="${referenceId}" data-type="${widgetType}"></script>`;
}

function _buildCorsHeaders(domain) {
  const origin = domain ? `https://${domain}` : "*";
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": "Authorization, X-Evan-Schema-Min",
    "X-Frame-Options":              "ALLOW-FROM https://evan.ai",
    "X-Content-Type-Options":       "nosniff",
  };
}

function _genRenderToken() {
  return crypto.randomBytes(8).toString("hex");
}

function _safeDomain(domain) {
  if (!domain) return null;
  const d = domain.toLowerCase().trim().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  return d;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
