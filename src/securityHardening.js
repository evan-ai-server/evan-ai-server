/**
 * src/securityHardening.js
 * Evan AI — Production Security Hardening Layer
 *
 * Implements:
 *   1. Honeytoken bot detection (shadow-ban with jittered responses)
 *   2. HMAC-SHA256 request signing for B2B/high-value endpoints
 *   3. Statistical outlier squashing (3σ) for pricing manipulation prevention
 *   4. Lightweight schema validator (Zod-style without the dependency)
 *   5. Injection-safe input sanitizer (beyond safeStr truncation)
 *   6. Safe error response helper (never leaks stack traces)
 *   7. Abuse tracker for rapid scan detection
 */

import crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// 1. HONEYTOKEN BOT DETECTION
// ─────────────────────────────────────────────────────────────────────────────
//
// Mobile clients include a lightweight client nonce in every scan/search request:
//   Header: X-Ev-Client-Token: <installId>:<timestamp>:<hmac_of_those_two>
//
// Bots that reverse-engineer the API spec typically omit or forge this header.
// On detection: we shadow-ban (slow response by 2-4s + jitter) rather than
// hard-block, so bots don't know they've been caught.
//
// Redis key: evan:honeytrap:{ip} → hit_count, EX 3600 (1h)

const HONEYTOKEN_SHADOW_DELAY_MS = 2500; // base delay for bots
const HONEYTOKEN_TTL              = 3600;
const _htKey = (ip) => `evan:honeytrap:${ip}`;

let _htRedis = null;
export function setHoneytokenRedis(r) { _htRedis = r; }

/** Mark this IP as a suspected bot */
async function _flagBot(ip) {
  if (!_htRedis) return;
  try {
    const k = _htKey(ip);
    const count = await _htRedis.incr(k);
    if (count === 1) await _htRedis.expire(k, HONEYTOKEN_TTL);
  } catch {}
}

/** True if IP is already shadow-banned */
async function _isFlagged(ip) {
  if (!_htRedis) return false;
  try {
    const v = Number((await _htRedis.get(_htKey(ip))) || 0);
    return v >= 2; // 2+ hits = confirmed bot
  } catch { return false; }
}

/**
 * Express middleware: validate X-Ev-Client-Token on scan/search routes.
 *
 * Token format: "{installId}:{tsMs}:{sig}"
 * sig = HMAC-SHA256(CLIENT_TOKEN_SECRET, `${installId}:${tsMs}`)
 *
 * Absence or invalid format → flag IP, shadow-ban (delayed response).
 * Expired timestamp (>5 min) → replay protection, flag.
 */
export function honeytokenMiddleware({ required = false } = {}) {
  const secret = String(process.env.CLIENT_TOKEN_SECRET || "");

  return async (req, res, next) => {
    const ip = _getIp(req);
    const token = String(req.headers["x-ev-client-token"] || "").trim();

    // Skip if no secret configured (dev mode)
    if (!secret) return next();

    // Check if already shadow-banned
    if (await _isFlagged(ip)) {
      const jitter = Math.floor(Math.random() * 1500);
      await _sleep(HONEYTOKEN_SHADOW_DELAY_MS + jitter);
      // Return plausible but empty result (bot doesn't know it's caught)
      return res.json({ ok: true, items: [], totalMatches: 0, _shadow: true });
    }

    if (!token) {
      await _flagBot(ip);
      if (required) {
        return res.status(400).json({ ok: false, error: "client_token_required" });
      }
      return next(); // soft mode: flag but don't block legitimate old clients
    }

    // Validate token structure
    const parts = token.split(":");
    if (parts.length !== 3) {
      await _flagBot(ip);
      return next();
    }

    const [installId, tsStr, sig] = parts;
    const tsMs = Number(tsStr);

    // Replay protection: reject tokens older than 5 minutes
    if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
      await _flagBot(ip);
      return next();
    }

    // Verify HMAC
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${installId}:${tsMs}`)
      .digest("hex");

    const sigBuf = Buffer.from(sig,      "hex");
    const expBuf = Buffer.from(expected, "hex");

    if (sigBuf.length !== expBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expBuf)) {
      await _flagBot(ip);
      return next();
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. HMAC-SHA256 REQUEST SIGNING (B2B Replay Protection)
// ─────────────────────────────────────────────────────────────────────────────
//
// B2B clients sign every request with their API key as the HMAC secret:
//
//   signature = HMAC-SHA256(apiKey, `${timestamp}:${sha256(rawBody)}`)
//
// Client sends:
//   X-Ev-Timestamp: <unix_ms>
//   X-Ev-Signature: <hex_signature>
//
// Server verifies signature is fresh (±5 min) and matches body.
// This prevents replaying intercepted scan results to forge transactions.

const B2B_SIGNING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compute the canonical signature for a request.
 * @param {string} apiKey  — the B2B API key (used as HMAC secret)
 * @param {string} body    — raw request body string
 * @param {string|number} timestamp — unix ms
 */
export function computeB2BSignature(apiKey, body, timestamp) {
  const bodyHash = crypto.createHash("sha256").update(String(body || "")).digest("hex");
  return crypto
    .createHmac("sha256", String(apiKey))
    .update(`${timestamp}:${bodyHash}`)
    .digest("hex");
}

/**
 * Express middleware: verify HMAC signature on B2B requests.
 * Must be applied AFTER raw body buffering.
 *
 * @param {object} opts
 *   required {boolean} — if false, logs warning but doesn't block (migration mode)
 */
export function b2bSignatureMiddleware({ required = true } = {}) {
  return (req, res, next) => {
    const apiKey    = String(req.headers["x-api-key"] || "").trim();
    const timestamp = String(req.headers["x-ev-timestamp"] || "").trim();
    const signature = String(req.headers["x-ev-signature"] || "").trim();

    // Skip if no signing headers present (older clients in migration mode)
    if (!timestamp && !signature) {
      if (required) {
        return res.status(400).json({ ok: false, error: "request_signing_required" });
      }
      return next();
    }

    const tsMs = Number(timestamp);
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > B2B_SIGNING_WINDOW_MS) {
      return res.status(400).json({ ok: false, error: "timestamp_expired" });
    }

    const rawBody = req.rawBody || JSON.stringify(req.body) || "";
    const expected = computeB2BSignature(apiKey, rawBody, tsMs);

    const sigBuf = Buffer.from(signature, "hex");
    const expBuf = Buffer.from(expected,  "hex");

    if (sigBuf.length !== expBuf.length ||
        !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ ok: false, error: "signature_invalid" });
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. STATISTICAL OUTLIER SQUASHING (3σ)
// ─────────────────────────────────────────────────────────────────────────────
//
// Removes listing prices that are more than 3 standard deviations from the
// mean BEFORE they reach the ranking/stats engine. This prevents a bad actor
// from inserting one $5000 "fake" listing to push the estimated value up.

/**
 * Filter an array of listing objects, removing extreme price outliers.
 *
 * @param {object[]} listings   — array with .price or .totalPrice
 * @param {number}   sigma      — sigma threshold (default 3.0)
 * @returns {object[]}          — listings with outliers removed
 */
export function squashPriceOutliers(listings, sigma = 3.0) {
  if (!Array.isArray(listings) || listings.length < 4) return listings;

  const prices = listings
    .map(i => Number(i?.totalPrice ?? i?.price ?? 0))
    .filter(p => Number.isFinite(p) && p > 0);

  if (prices.length < 4) return listings;

  const mean  = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);

  // If stdDev is tiny (very uniform pricing), no squashing needed
  if (stdDev < 0.01) return listings;

  const lo = mean - sigma * stdDev;
  const hi = mean + sigma * stdDev;

  const filtered = listings.filter(item => {
    const p = Number(item?.totalPrice ?? item?.price ?? 0);
    return p >= lo && p <= hi;
  });

  // Never filter everything out — keep at least 60% of original
  if (filtered.length < Math.ceil(listings.length * 0.6)) return listings;

  return filtered;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. LIGHTWEIGHT SCHEMA VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────
//
// Validates request bodies against a schema definition.
// Unknown fields are stripped (parameter pollution prevention).
// Usage:
//   const schema = { query: { type: "string", max: 220, required: true }, ... }
//   const { error, data } = validateSchema(schema, req.body);

/**
 * @param {Record<string, FieldDef>} schema
 * @param {object} input
 * @returns {{ ok: boolean, error?: string, data?: object }}
 */
export function validateSchema(schema, input) {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "body_must_be_object" };
  }

  const data = {};
  const errors = [];

  for (const [key, def] of Object.entries(schema)) {
    const raw = input[key];
    const isPresent = raw !== undefined && raw !== null && raw !== "";

    if (def.required && !isPresent) {
      errors.push(`${key}: required`);
      continue;
    }
    if (!isPresent) {
      if ("default" in def) data[key] = def.default;
      continue;
    }

    let val = raw;

    // Type checking
    if (def.type === "string") {
      if (typeof val !== "string") val = String(val);
      // Sanitize: strip control chars and zero-width chars
      val = val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\uFEFF]/g, "");
      if (def.max && val.length > def.max) val = val.slice(0, def.max);
      if (def.min && val.length < def.min) { errors.push(`${key}: too short`); continue; }
      if (def.pattern && !def.pattern.test(val)) { errors.push(`${key}: invalid format`); continue; }
      if (def.enum && !def.enum.includes(val)) { errors.push(`${key}: invalid value`); continue; }

    } else if (def.type === "number") {
      val = Number(val);
      if (!Number.isFinite(val)) { errors.push(`${key}: must be number`); continue; }
      if (def.min != null && val < def.min) { errors.push(`${key}: below minimum`); continue; }
      if (def.max != null && val > def.max) { errors.push(`${key}: above maximum`); continue; }

    } else if (def.type === "boolean") {
      val = val === true || val === "true" || val === 1 || val === "1";

    } else if (def.type === "array") {
      if (!Array.isArray(val)) { errors.push(`${key}: must be array`); continue; }
      if (def.maxItems && val.length > def.maxItems) val = val.slice(0, def.maxItems);

    } else if (def.type === "object") {
      if (typeof val !== "object" || Array.isArray(val) || val === null) {
        errors.push(`${key}: must be object`); continue;
      }
    }

    data[key] = val;
  }

  if (errors.length) return { ok: false, error: errors.join("; ") };
  return { ok: true, data };
}

/**
 * Express middleware factory: validates req.body against schema.
 * Strips unknown fields (parameter pollution prevention).
 * Rejects with 400 on validation failure.
 */
export function schemaMiddleware(schema) {
  return (req, res, next) => {
    const { ok, error, data } = validateSchema(schema, req.body);
    if (!ok) {
      return res.status(400).json({ ok: false, error: "validation_error", details: error });
    }
    req.body = data; // replace body with clean, validated data (unknown fields stripped)
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. INJECTION-SAFE INPUT SANITIZER
// ─────────────────────────────────────────────────────────────────────────────

/** Strips characters commonly used in injection attacks from a string */
export function sanitizeInput(s, max = 220) {
  if (typeof s !== "string") return "";
  return s
    .trim()
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .replace(/[<>'"`;\\]/g, "")                          // HTML/SQL/shell injection chars
    .replace(/\.\.\//g, "")                              // path traversal
    .replace(/\u200B-\u200F\uFEFF/g, "")                // zero-width chars
    .slice(0, max);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SAFE ERROR RESPONSE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Always returns a safe { ok: false, error: "..." } response.
 * NEVER exposes stack traces, error messages, or internal state.
 *
 * @param {Response} res — Express response object
 * @param {number}   status — HTTP status code
 * @param {string}   code   — short error code (snake_case)
 * @param {object}   [meta] — optional non-sensitive metadata
 */
export function safeError(res, status = 500, code = "internal_error", meta = {}) {
  return res.status(status).json({ ok: false, error: code, ...meta });
}

/**
 * Express error handler middleware — catches unhandled errors.
 * Install as the LAST app.use() before listen().
 */
export function globalErrorHandler(err, req, res, _next) {
  // Log internally (never expose to client)
  console.error("[ERROR]", req.method, req.path,
    err?.message || String(err),
    err?.code || ""
  );

  if (res.headersSent) return;

  const status = Number(err?.status || err?.statusCode || 500);
  return res.status(status >= 400 && status < 600 ? status : 500)
    .json({ ok: false, error: "internal_error" });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. ABUSE TRACKER (rapid scan detection)
// ─────────────────────────────────────────────────────────────────────────────
//
// Tracks scan rates per IP in a 10-second burst window.
// Used alongside the existing hardeningLayer rate limits for double-layer defense.

const _abuseCounts = new Map(); // ip → { count, windowStart }
const ABUSE_WINDOW_MS  = 10_000; // 10 second burst window
const ABUSE_BURST_MAX  = 5;      // max 5 scans in 10s
const ABUSE_BLOCK_MS   = 60_000; // 60s block on detection
const _abuseBlocked    = new Map(); // ip → blockedUntil

export function abuseTrackerMiddleware({ limitPaths = ["/market/search", "/api/vision/analyze", "/upload/presign"] } = {}) {
  return (req, res, next) => {
    const path = req.path;
    if (!limitPaths.some(p => path.startsWith(p))) return next();

    const ip = _getIp(req);
    const now = Date.now();

    // Check if blocked
    const blockedUntil = _abuseBlocked.get(ip);
    if (blockedUntil && now < blockedUntil) {
      return res.status(429).json({
        ok: false,
        error: "too_many_requests",
        retryAfter: Math.ceil((blockedUntil - now) / 1000),
      });
    }

    // Track burst count
    const entry = _abuseCounts.get(ip) || { count: 0, windowStart: now };
    if (now - entry.windowStart > ABUSE_WINDOW_MS) {
      entry.count = 1;
      entry.windowStart = now;
    } else {
      entry.count += 1;
    }
    _abuseCounts.set(ip, entry);

    if (entry.count > ABUSE_BURST_MAX) {
      _abuseBlocked.set(ip, now + ABUSE_BLOCK_MS);
      console.warn("[ABUSE_DETECTED]", ip, `${entry.count} hits in ${ABUSE_WINDOW_MS}ms`);
      return res.status(429).json({
        ok: false,
        error: "too_many_requests",
        retryAfter: Math.ceil(ABUSE_BLOCK_MS / 1000),
      });
    }

    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. COMMON SCHEMAS for critical endpoints
// ─────────────────────────────────────────────────────────────────────────────

export const SCHEMAS = {
  marketSearch: {
    query:            { type: "string",  max: 220, required: false },
    category:         { type: "string",  max: 80  },
    scannedPrice:     { type: "number",  min: 0, max: 999_999 },
    userId:           { type: "string",  max: 128 },
    zipCode:          { type: "string",  max: 10, pattern: /^\d{5}(-\d{4})?$|^$/ },
    sizeHint:         { type: "string",  max: 40  },
    imageHash:        { type: "string",  max: 128 },
    visionIdentity:   { type: "object"  },
    variants:         { type: "array",   maxItems: 12 },
    scanMode:         { type: "string",  max: 30  },
    location:         { type: "string",  max: 80  },
  },

  scanConsume: {
    userId:    { type: "string", max: 128 },
    guestId:   { type: "string", max: 128 },
    imageHash: { type: "string", max: 128 },
  },

  guestIdentify: {
    fingerprint: { type: "string", max: 128, required: true },
    installId:   { type: "string", max: 128 },
  },

  watchlistUpsert: {
    userId:  { type: "string", max: 128, required: true },
    query:   { type: "string", max: 220, required: true },
    scanId:  { type: "string", max: 64  },
    channel: { type: "string", max: 30, enum: ["email", "push", "both", "none"], default: "push" },
  },

  priceAlert: {
    userId:      { type: "string", max: 128, required: true },
    query:       { type: "string", max: 220, required: true },
    targetPrice: { type: "number", min: 0.01, max: 999_999 },
    direction:   { type: "string", enum: ["below", "above"] },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _getIp(req) {
  return (
    String(req.headers["cf-connecting-ip"] || "").trim() ||
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
