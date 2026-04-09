// src/partnerSchemaContracts.js
// Phase 9 — Partner Schema Contracts + Schema Pinning + Legacy Transformer.
//
// B2B integration stability layer.  When partners build against Evan's API
// they pin to a schema version so we can evolve the data model without
// breaking downstream integrations.
//
// Responsibilities:
//   1. SCHEMA REGISTRY  — canonical versioned public schemas for each endpoint
//   2. SCHEMA PINNING   — partners declare min_schema_version; requests are
//                         rejected if the server schema is below their minimum
//   3. LEGACY COMPAT    — transforms new-format responses to the shape expected
//                         by older schema versions (forward-compat bridge)
//   4. CONTRACT AUDIT   — logs schema version mismatches for ops visibility
//
// Response headers:
//   X-Evan-Schema-Version: {version}
//   X-Evan-Schema-Min:     {minVersion}  (echoes partner's declared min)
//
// Redis key layout:
//   p9:schema:pins:{partnerId}    STRING  partner's pinned min version
//   p9:schema:ops                 HASH    counters

export const SCHEMA_CONTRACTS_VERSION = "9.0";

// ── Current server schema versions per endpoint group ─────────────────────

export const CURRENT_SCHEMA = {
  verification: "3.0",
  trust_packet: "2.0",
  distribution: "2.0",
  partner_auth:  "1.0",
  analytics:    "2.0",
  webhook:      "1.0",
};

// ── Schema definitions (public contract) ─────────────────────────────────
// Each version lists its canonical field set.
// Fields marked optional: true may be absent.

const SCHEMA_REGISTRY = {
  verification: {
    "1.0": {
      required: ["referenceId", "verified", "status", "badgeUrl"],
      optional: ["brand", "model", "expiresAt"],
      deprecated: [],
    },
    "2.0": {
      required: ["referenceId", "verified", "status", "badgeUrl", "verifyUrl", "referenceType"],
      optional: ["brand", "model", "expiresAt", "confidenceBand", "trustmarkStatus"],
      deprecated: [],
    },
    "3.0": {
      required: ["referenceId", "verified", "status", "badgeUrl", "verifyUrl", "referenceType", "issuedAt"],
      optional: ["brand", "model", "expiresAt", "confidenceBand", "trustmarkStatus", "auditHash", "institutionalIds"],
      deprecated: [],
    },
  },
  trust_packet: {
    "1.0": {
      required: ["packetId", "itemId", "trustLevel", "verifiedAt"],
      optional: ["brand", "model", "priceEstimate"],
      deprecated: [],
    },
    "2.0": {
      required: ["packetId", "itemId", "trustLevel", "verifiedAt", "packetType"],
      optional: ["brand", "model", "priceEstimate", "condition", "certTier", "downstream_trust_id"],
      deprecated: [],
    },
  },
  distribution: {
    "1.0": {
      required: ["recommendations", "topChannel"],
      optional: ["certTier", "trustFootprint"],
      deprecated: [],
    },
    "2.0": {
      required: ["recommendations", "topChannel", "totalChannels"],
      optional: ["certTier", "trustFootprint", "isVerified", "isCertified"],
      deprecated: [],
    },
  },
  partner_auth: {
    "1.0": {
      required: ["partnerId", "tier", "scopes", "expiresAt"],
      optional: ["jti"],
      deprecated: [],
    },
  },
  analytics: {
    "1.0": {
      required: ["attributionId", "eventType", "timestamp"],
      optional: ["downstream_trust_id", "partnerId"],
      deprecated: [],
    },
    "2.0": {
      required: ["attributionId", "eventType", "timestamp", "referenceId"],
      optional: ["downstream_trust_id", "partnerId", "conversionValue", "sessionId"],
      deprecated: [],
    },
  },
  webhook: {
    "1.0": {
      required: ["webhookId", "eventType", "payload", "deliveredAt"],
      optional: ["signature", "retryCount"],
      deprecated: [],
    },
  },
};

// ── Schema compatibility transformers ─────────────────────────────────────
// Transform new-format data to old schema shapes for backward compat.

const LEGACY_TRANSFORMERS = {
  // verification 3.0 → 2.0
  "verification:3.0→2.0": (data) => {
    const out = { ...data };
    delete out.issuedAt;
    delete out.auditHash;
    delete out.institutionalIds;
    return out;
  },
  // verification 2.0 → 1.0
  "verification:2.0→1.0": (data) => {
    const out = { ...data };
    delete out.verifyUrl;
    delete out.referenceType;
    delete out.confidenceBand;
    delete out.trustmarkStatus;
    return out;
  },
  // trust_packet 2.0 → 1.0
  "trust_packet:2.0→1.0": (data) => {
    const out = { ...data };
    delete out.packetType;
    delete out.condition;
    delete out.certTier;
    delete out.downstream_trust_id;
    return out;
  },
  // distribution 2.0 → 1.0
  "distribution:2.0→1.0": (data) => {
    const out = { ...data };
    delete out.totalChannels;
    delete out.isVerified;
    delete out.isCertified;
    return out;
  },
  // analytics 2.0 → 1.0
  "analytics:2.0→1.0": (data) => {
    const out = { ...data };
    delete out.referenceId;
    delete out.conversionValue;
    delete out.sessionId;
    return out;
  },
};

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Check if the server's current schema version satisfies a partner's minimum.
 *
 * @param {string} endpoint  — schema group key (e.g. "verification")
 * @param {string} minVersion — partner's minimum required version
 * @returns {{ ok: boolean, reason?: string, serverVersion: string }}
 */
export function checkSchemaCompatibility(endpoint, minVersion) {
  const serverVersion = CURRENT_SCHEMA[endpoint];
  if (!serverVersion) {
    return { ok: false, reason: `unknown_endpoint_${endpoint}`, serverVersion: null };
  }
  if (!minVersion) {
    return { ok: true, serverVersion, minVersion: null };
  }
  const compat = _versionGte(serverVersion, minVersion);
  return {
    ok:            compat,
    reason:        compat ? null : `schema_below_minimum: server=${serverVersion} min=${minVersion}`,
    serverVersion,
    minVersion,
    endpoint,
  };
}

/**
 * Transform a data payload from the current schema version down to a
 * target (older) version.
 *
 * @param {string} endpoint     — schema group
 * @param {string} targetVersion — version the partner expects
 * @param {object} data         — current-version data
 * @returns {{ ok: boolean, data: object, transformsApplied: string[] }}
 */
export function transformToVersion(endpoint, targetVersion, data) {
  const serverVersion = CURRENT_SCHEMA[endpoint];
  if (!serverVersion) return { ok: false, reason: "unknown_endpoint", data };
  if (targetVersion === serverVersion) return { ok: true, data, transformsApplied: [] };

  const chain  = _buildTransformChain(endpoint, serverVersion, targetVersion);
  const applied = [];
  let current  = { ...data };

  for (const step of chain) {
    const transformer = LEGACY_TRANSFORMERS[step];
    if (!transformer) {
      return { ok: false, reason: `no_transformer_for_${step}`, data: current, transformsApplied: applied };
    }
    current = transformer(current);
    applied.push(step);
  }

  return { ok: true, data: current, transformsApplied: applied };
}

/**
 * Pin a partner's minimum schema version in Redis.
 */
export async function pinPartnerSchema(redis, partnerId, endpoint, minVersion) {
  if (!redis || !partnerId || !endpoint) return { ok: false };
  try {
    const key = `p9:schema:pins:${_safe(partnerId)}`;
    await redis.hSet(key, endpoint, minVersion);
    await redis.expire(key, 365 * 86400);
    await redis.hIncrBy("p9:schema:ops", "pins_written", 1);
    return { ok: true, partnerId, endpoint, minVersion };
  } catch (err) {
    return { ok: false, reason: err?.message };
  }
}

/**
 * Get a partner's pinned schema versions.
 */
export async function getPartnerSchemaPins(redis, partnerId) {
  if (!redis || !partnerId) return {};
  try {
    return await redis.hGetAll(`p9:schema:pins:${_safe(partnerId)}`) || {};
  } catch { return {}; }
}

/**
 * Get the full schema contract for an endpoint + version.
 * Used by partner documentation and integration validators.
 */
export function getSchemaContract(endpoint, version = null) {
  const ep = SCHEMA_REGISTRY[endpoint];
  if (!ep) return null;
  const v = version || CURRENT_SCHEMA[endpoint];
  return ep[v] ? { endpoint, version: v, ...ep[v] } : null;
}

/**
 * Get all current schema versions (for API documentation / introspection).
 */
export function getAllCurrentSchemas() {
  return Object.entries(CURRENT_SCHEMA).map(([endpoint, version]) => ({
    endpoint,
    version,
    contract: SCHEMA_REGISTRY[endpoint]?.[version] || null,
  }));
}

/**
 * Get schema ops.
 */
export async function getSchemaOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hGetAll("p9:schema:ops");
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return { pinsWritten: ops["pins_written"] || 0, transformsApplied: ops["transforms"] || 0 };
  } catch { return {}; }
}

// ── Middleware helper ──────────────────────────────────────────────────────

/**
 * Express-style schema middleware factory.
 * Validates min_schema_version header and applies legacy transform if needed.
 *
 * Usage:
 *   app.use("/api/verify/*", schemaMiddleware("verification"))
 */
export function schemaMiddleware(endpoint) {
  return function(req, res, next) {
    const minVersion = req.headers["x-evan-schema-min"] || req.query.schema_version || null;
    res.setHeader("X-Evan-Schema-Version", CURRENT_SCHEMA[endpoint] || "unknown");

    if (minVersion) {
      const check = checkSchemaCompatibility(endpoint, minVersion);
      if (!check.ok) {
        return res.status(400).json({
          ok:     false,
          error:  "schema_version_mismatch",
          detail: check.reason,
          serverVersion: check.serverVersion,
          minVersion,
        });
      }
      res.setHeader("X-Evan-Schema-Min", minVersion);
      // Store target version for response transformer
      req._schemaEndpoint    = endpoint;
      req._schemaTargetVersion = minVersion;
    }

    next();
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function _versionGte(serverVer, minVer) {
  // Simple semver-style major.minor comparison
  const [sMaj, sMin = 0] = serverVer.split(".").map(Number);
  const [mMaj, mMin = 0] = minVer.split(".").map(Number);
  if (sMaj !== mMaj) return sMaj > mMaj;
  return sMin >= mMin;
}

function _buildTransformChain(endpoint, fromVersion, toVersion) {
  // Build the sequence of transformers needed to go from→to
  // Works by stepping down one minor/major version at a time
  const chain = [];
  let current = fromVersion;
  while (current !== toVersion) {
    const prev = _prevVersion(endpoint, current);
    if (!prev) break;
    chain.push(`${endpoint}:${current}→${prev}`);
    current = prev;
    if (current === toVersion) break;
  }
  return chain;
}

function _prevVersion(endpoint, version) {
  const ep = SCHEMA_REGISTRY[endpoint];
  if (!ep) return null;
  const versions = Object.keys(ep).sort((a, b) => {
    const [aMaj, aMin = 0] = a.split(".").map(Number);
    const [bMaj, bMin = 0] = b.split(".").map(Number);
    return aMaj !== bMaj ? aMaj - bMaj : aMin - bMin;
  });
  const idx = versions.indexOf(version);
  return idx > 0 ? versions[idx - 1] : null;
}

function _safe(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
