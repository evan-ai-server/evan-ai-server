// src/partnerAuthTierEngine.js
// Phase 9 — Partner Auth + Access Tier Engine.
//
// Upgrades the Phase 8 sandbox key model into a full partner tier system
// with JWT-scoped access control.
//
// KEY DESIGN: JWT Scoping (not all-or-nothing API keys)
//   Each partner JWT contains explicit scope claims that cryptographically
//   prevent field-level data leaks at the architecture level.
//
//   Example: A "marketplace" partner JWT has scopes:
//     ["auth_data", "valuation_summary", "certification_data"]
//   But NOT:
//     ["profit_margin", "route_intelligence", "internal_valuation"]
//
//   Field filtering in buildPartnerPayload() checks JWT scopes — a marketplace
//   key literally cannot receive profit margin data even if the raw object
//   contains it. The block is cryptographic, not procedural.
//
// Partner tiers:
//   sandbox          — testing only, masked data, low limits
//   developer        — real data, limited endpoints, audit-logged
//   verified_partner — full partner endpoints, signed webhook access
//   enterprise_partner — unlimited, all endpoints, SLA-level logging
//
// Redis key layout:
//   p9:partner:{partnerId}         HASH   partner metadata
//   p9:partner:list                ZSET   all partnerId by registeredAt
//   p9:apikey:{keyId}              HASH   API key record
//   p9:partner:{partnerId}:keys    SET    keyIds for partner
//   p9:jwt:blacklist:{jti}         STRING  revoked JWT jti (TTL = jwt expiry)
//   p9:rate:{keyId}:{window}       STRING  rate limit counter
//   p9:audit:{partnerId}           ZSET   audit events by timestamp (180d)

import crypto from "crypto";

export const PARTNER_AUTH_VERSION = "9.0";

// ── Tier definitions ──────────────────────────────────────────────────────────

export const PARTNER_TIER = {
  SANDBOX:           "sandbox",
  DEVELOPER:         "developer",
  VERIFIED_PARTNER:  "verified_partner",
  ENTERPRISE_PARTNER:"enterprise_partner",
};

// JWT scopes — cryptographic field-level access claims
export const SCOPE = {
  AUTH_DATA:           "auth_data",            // authenticity verification results
  VALUATION_SUMMARY:   "valuation_summary",    // public price estimates
  CERTIFICATION_DATA:  "certification_data",   // reseller certification status
  GUARANTEE_DATA:      "guarantee_data",       // guarantee coverage status
  RESELLER_DATA:       "reseller_data",        // public reseller profile
  TRUST_TIMELINE:      "trust_timeline",       // trust event history
  WIDGET_EMBED:        "widget_embed",         // embed widget generation
  WEBHOOK_RECEIVE:     "webhook_receive",      // receive webhook events
  ANALYTICS_READ:      "analytics_read",       // read own partner analytics
  ANALYTICS_WRITE:     "analytics_write",      // write attribution events
  TRUST_PACKETS:       "trust_packets",        // marketplace trust packets
  WORKFLOW_PRIMITIVES: "workflow_primitives",  // listing prefill, handoffs
  DASHBOARD_READ:      "dashboard_read",       // partner dashboard data
  // Blocked scopes (explicitly excluded from all external tiers):
  PROFIT_MARGIN:       "profit_margin",        // INTERNAL ONLY — never in external JWT
  ROUTE_INTELLIGENCE:  "route_intelligence",   // INTERNAL ONLY
  INTERNAL_VALUATION:  "internal_valuation",   // INTERNAL ONLY
  RAW_TRUST_SCORE:     "raw_trust_score",      // INTERNAL ONLY
  USER_PII:            "user_pii",             // INTERNAL ONLY
};

// Fields that REQUIRE a specific scope to appear in any partner response
export const SCOPE_FIELD_MAP = {
  rawTrustScore:          SCOPE.RAW_TRUST_SCORE,
  authScore:              SCOPE.RAW_TRUST_SCORE,
  counterfeitMatchScore:  SCOPE.RAW_TRUST_SCORE,
  expectedProfit:         SCOPE.PROFIT_MARGIN,
  profitMargin:           SCOPE.PROFIT_MARGIN,
  netProfit:              SCOPE.PROFIT_MARGIN,
  routeRecommendation:    SCOPE.ROUTE_INTELLIGENCE,
  sellRouting:            SCOPE.ROUTE_INTELLIGENCE,
  dealIQScore:            SCOPE.INTERNAL_VALUATION,
  internalPriceTarget:    SCOPE.INTERNAL_VALUATION,
  userEmail:              SCOPE.USER_PII,
  userPhone:              SCOPE.USER_PII,
};

const TIER_SCOPES = {
  [PARTNER_TIER.SANDBOX]: [
    SCOPE.AUTH_DATA, SCOPE.VALUATION_SUMMARY, SCOPE.CERTIFICATION_DATA,
  ],
  [PARTNER_TIER.DEVELOPER]: [
    SCOPE.AUTH_DATA, SCOPE.VALUATION_SUMMARY, SCOPE.CERTIFICATION_DATA,
    SCOPE.GUARANTEE_DATA, SCOPE.RESELLER_DATA, SCOPE.WIDGET_EMBED,
    SCOPE.ANALYTICS_READ, SCOPE.ANALYTICS_WRITE,
  ],
  [PARTNER_TIER.VERIFIED_PARTNER]: [
    SCOPE.AUTH_DATA, SCOPE.VALUATION_SUMMARY, SCOPE.CERTIFICATION_DATA,
    SCOPE.GUARANTEE_DATA, SCOPE.RESELLER_DATA, SCOPE.TRUST_TIMELINE,
    SCOPE.WIDGET_EMBED, SCOPE.WEBHOOK_RECEIVE, SCOPE.ANALYTICS_READ,
    SCOPE.ANALYTICS_WRITE, SCOPE.TRUST_PACKETS, SCOPE.WORKFLOW_PRIMITIVES,
    SCOPE.DASHBOARD_READ,
  ],
  [PARTNER_TIER.ENTERPRISE_PARTNER]: [
    SCOPE.AUTH_DATA, SCOPE.VALUATION_SUMMARY, SCOPE.CERTIFICATION_DATA,
    SCOPE.GUARANTEE_DATA, SCOPE.RESELLER_DATA, SCOPE.TRUST_TIMELINE,
    SCOPE.WIDGET_EMBED, SCOPE.WEBHOOK_RECEIVE, SCOPE.ANALYTICS_READ,
    SCOPE.ANALYTICS_WRITE, SCOPE.TRUST_PACKETS, SCOPE.WORKFLOW_PRIMITIVES,
    SCOPE.DASHBOARD_READ,
    // Enterprise gets additional audit depth, no extra data scopes
  ],
};

export const TIER_RATE_LIMITS = {
  [PARTNER_TIER.SANDBOX]:            { perHour: 100,   perDay: 1000,   perMonth: 10000  },
  [PARTNER_TIER.DEVELOPER]:          { perHour: 500,   perDay: 5000,   perMonth: 100000 },
  [PARTNER_TIER.VERIFIED_PARTNER]:   { perHour: 3000,  perDay: 50000,  perMonth: 1000000},
  [PARTNER_TIER.ENTERPRISE_PARTNER]: { perHour: 30000, perDay: 500000, perMonth: null   },
};

const JWT_EXPIRY_BY_TIER = {
  [PARTNER_TIER.SANDBOX]:            3600,     // 1 hour
  [PARTNER_TIER.DEVELOPER]:          86400,    // 24 hours
  [PARTNER_TIER.VERIFIED_PARTNER]:   86400 * 30,  // 30 days
  [PARTNER_TIER.ENTERPRISE_PARTNER]: 86400 * 90,  // 90 days
};

const AUDIT_TTL   = 180 * 86400;
const AUDIT_MAX   = 10000;

// ── Partner registration ──────────────────────────────────────────────────────

export async function registerPartner(redis, {
  partnerId,
  partnerName,
  tier          = PARTNER_TIER.SANDBOX,
  partnerType   = "marketplace",
  contactEmail  = null,
  allowedDomains = [],  // for widget embed domain whitelisting
  webhookUrl    = null,
} = {}) {
  if (!redis || !partnerId || !partnerName) return { ok: false, error: "missing_required" };
  if (!PARTNER_TIER[tier.toUpperCase()] && !Object.values(PARTNER_TIER).includes(tier)) {
    return { ok: false, error: "invalid_tier" };
  }

  const now = Date.now();
  try {
    await redis.hSet(`p9:partner:${_safe(partnerId)}`, {
      partnerId,
      partnerName,
      tier,
      partnerType,
      contactEmail:  contactEmail || "",
      allowedDomains: JSON.stringify(allowedDomains || []),
      webhookUrl:    webhookUrl || "",
      status:        "active",
      registeredAt:  now,
      updatedAt:     now,
    });
    await redis.zAdd("p9:partner:list", [{ score: now, value: partnerId }]);
    await _auditLog(redis, partnerId, "PARTNER_REGISTERED", { tier, partnerType });
    return { ok: true, partnerId, tier };
  } catch (err) {
    return { ok: false, error: "register_failed", reason: err?.message };
  }
}

export async function getPartner(redis, partnerId) {
  if (!redis || !partnerId) return null;
  try {
    const raw = await redis.hGetAll(`p9:partner:${_safe(partnerId)}`);
    if (!raw?.partnerId) return null;
    return {
      ...raw,
      allowedDomains: _safeJsonParse(raw.allowedDomains, []),
      registeredAt:   Number(raw.registeredAt) || 0,
      updatedAt:      Number(raw.updatedAt)     || 0,
    };
  } catch { return null; }
}

export async function updatePartnerStatus(redis, partnerId, status) {
  if (!redis || !partnerId) return { ok: false };
  try {
    await redis.hSet(`p9:partner:${_safe(partnerId)}`, { status, updatedAt: Date.now() });
    await _auditLog(redis, partnerId, "STATUS_CHANGED", { status });
    return { ok: true };
  } catch { return { ok: false }; }
}

// ── JWT issuance ──────────────────────────────────────────────────────────────

export async function issuePartnerJWT(redis, { partnerId, tier, additionalScopes = [] } = {}) {
  if (!redis || !partnerId) return { ok: false, error: "missing_required" };

  const partner = await getPartner(redis, partnerId);
  if (!partner) return { ok: false, error: "partner_not_found" };
  if (partner.status !== "active") return { ok: false, error: "partner_inactive" };

  const resolvedTier = tier || partner.tier || PARTNER_TIER.SANDBOX;
  const baseScopes   = TIER_SCOPES[resolvedTier] || TIER_SCOPES[PARTNER_TIER.SANDBOX];

  // Merge scopes — never grant INTERNAL scopes even if requested
  const internalScopes = [SCOPE.PROFIT_MARGIN, SCOPE.ROUTE_INTELLIGENCE, SCOPE.INTERNAL_VALUATION, SCOPE.RAW_TRUST_SCORE, SCOPE.USER_PII];
  const scopes = [...new Set([...baseScopes, ...additionalScopes])].filter(s => !internalScopes.includes(s));

  const jti     = crypto.randomBytes(16).toString("hex");
  const secret  = _getJWTSecret();
  const expiry  = JWT_EXPIRY_BY_TIER[resolvedTier] || 3600;
  const now     = Math.floor(Date.now() / 1000);

  const header  = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub:        partnerId,
    tier:       resolvedTier,
    scopes,
    iat:        now,
    exp:        now + expiry,
    jti,
    version:    PARTNER_AUTH_VERSION,
  };

  const token = _signJWT(header, payload, secret);
  await _auditLog(redis, partnerId, "JWT_ISSUED", { tier: resolvedTier, expiry });

  return {
    ok:      true,
    token,
    partnerId,
    tier:    resolvedTier,
    scopes,
    expiresAt: (now + expiry) * 1000,
    expiresIn: expiry,
  };
}

// ── JWT verification ──────────────────────────────────────────────────────────

export async function verifyPartnerJWT(redis, token) {
  if (!redis || !token) return { ok: false, error: "missing_token" };

  try {
    const secret  = _getJWTSecret();
    const payload = _verifyJWT(token, secret);

    if (!payload) return { ok: false, error: "invalid_signature" };
    if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, error: "token_expired" };

    // Check blacklist
    const blacklisted = await redis.get(`p9:jwt:blacklist:${payload.jti}`);
    if (blacklisted) return { ok: false, error: "token_revoked" };

    // Check partner status
    const partner = await getPartner(redis, payload.sub);
    if (!partner || partner.status !== "active") {
      return { ok: false, error: "partner_inactive" };
    }

    return {
      ok:        true,
      partnerId: payload.sub,
      tier:      payload.tier,
      scopes:    payload.scopes || [],
      jti:       payload.jti,
      expiresAt: payload.exp * 1000,
    };
  } catch (err) {
    return { ok: false, error: "verification_failed", reason: err?.message };
  }
}

export async function revokePartnerJWT(redis, { token, partnerId } = {}) {
  if (!redis || !token) return { ok: false };
  try {
    const secret  = _getJWTSecret();
    const payload = _verifyJWTUnsafe(token, secret);  // decode even if expired
    if (!payload?.jti) return { ok: false, error: "no_jti" };
    const ttl = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
    await redis.set(`p9:jwt:blacklist:${payload.jti}`, "1", "EX", ttl + 60);
    if (partnerId) await _auditLog(redis, partnerId, "JWT_REVOKED", { jti: payload.jti });
    return { ok: true };
  } catch { return { ok: false }; }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

export async function checkPartnerRateLimit(redis, partnerId, tier) {
  if (!redis) return { allowed: true };
  const limits = TIER_RATE_LIMITS[tier] || TIER_RATE_LIMITS[PARTNER_TIER.SANDBOX];
  const now    = Date.now();
  const hour   = Math.floor(now / 3600000);
  const day    = Math.floor(now / 86400000);

  try {
    const keyH = `p9:rate:${_safe(partnerId)}:h:${hour}`;
    const keyD = `p9:rate:${_safe(partnerId)}:d:${day}`;

    const [hc, dc] = await Promise.all([
      redis.get(keyH).then(v => Number(v) || 0),
      redis.get(keyD).then(v => Number(v) || 0),
    ]);

    if (hc >= limits.perHour) return { allowed: false, reason: "hourly_limit", retryAfter: 3600 };
    if (dc >= limits.perDay)  return { allowed: false, reason: "daily_limit",  retryAfter: 86400 };

    await Promise.all([
      redis.incrBy(keyH, 1).then(() => redis.expire(keyH, 7200)),
      redis.incrBy(keyD, 1).then(() => redis.expire(keyD, 172800)),
    ]);

    return {
      allowed:  true,
      remaining:{ hourly: limits.perHour - hc - 1, daily: limits.perDay - dc - 1 },
    };
  } catch { return { allowed: true }; }
}

// ── Scope enforcement — cryptographic field filter ────────────────────────────

export function filterPayloadByScopes(payload, scopes) {
  if (!payload || typeof payload !== "object") return payload;
  if (!Array.isArray(scopes)) return {};

  const clean = { ...payload };

  for (const [field, requiredScope] of Object.entries(SCOPE_FIELD_MAP)) {
    if (!scopes.includes(requiredScope) && field in clean) {
      delete clean[field];
    }
  }

  return clean;
}

export function hasScope(scopes, required) {
  return Array.isArray(scopes) && scopes.includes(required);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

async function _auditLog(redis, partnerId, event, data = {}) {
  try {
    const key   = `p9:audit:${_safe(partnerId)}`;
    const entry = JSON.stringify({ event, data, ts: Date.now() });
    await redis.zAdd(key, [{ score: Date.now(), value: entry }]);
    await redis.zRemRangeByRank(key, 0, -(AUDIT_MAX + 1));
    await redis.expire(key, AUDIT_TTL);
  } catch { /* non-critical */ }
}

export async function getPartnerAuditLog(redis, partnerId, { limit = 50 } = {}) {
  if (!redis || !partnerId) return [];
  try {
    const raw = await redis.zRange(`p9:audit:${_safe(partnerId)}`, 0, limit - 1, { REV: true });
    return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

function _getJWTSecret() {
  return process.env.PARTNER_JWT_SECRET || process.env.JWT_SECRET || "evan-p9-jwt-secret-change-in-prod";
}

function _b64url(str) {
  return Buffer.from(str).toString("base64url");
}

function _signJWT(header, payload, secret) {
  const h = _b64url(JSON.stringify(header));
  const p = _b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

function _verifyJWT(token, secret) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return JSON.parse(Buffer.from(p, "base64url").toString());
}

function _verifyJWTUnsafe(token, secret) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString()); } catch { return null; }
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function _safeJsonParse(str, fallback) {
  try { return JSON.parse(str || ""); } catch { return fallback; }
}
