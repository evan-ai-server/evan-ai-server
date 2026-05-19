/**
 * ironShield.js — Error masking, internal audit, and opaque response codes
 *
 * SECURITY PRINCIPLE: External API responses reveal NOTHING about internal state.
 * A failed bid due to token decryption failure looks identical to a rate limit.
 * This prevents reverse-engineering of our bidding curves, vault structure,
 * or platform authentication patterns.
 *
 * Two-layer system:
 *   1. EXTERNAL: Opaque BID_ERR_XX code returned to frontend/client
 *   2. INTERNAL: Full structured error logged to private audit sink only
 */

// ─── Opaque Error Code Map ────────────────────────────────────────────────────
// Keys: internal error identifiers. Values: external codes.
// The mapping itself is never serialized to any response.
export const BID_ERROR_CODES = Object.freeze({
  // Vault / auth
  TOKEN_NOT_FOUND:        "BID_ERR_01",
  DECRYPT_FAIL:           "BID_ERR_02",
  EPHEMERAL_TIMEOUT:      "BID_ERR_03",
  TOKEN_REVOKED:          "BID_ERR_04",
  OAUTH_EXPIRED:          "BID_ERR_05",
  // Platform errors
  PLATFORM_RATE_LIMIT:    "BID_ERR_10",
  LISTING_GONE:           "BID_ERR_11",
  OFFER_REJECTED_FAST:    "BID_ERR_12",
  LISTING_NOT_ELIGIBLE:   "BID_ERR_13",
  PLATFORM_MAINTENANCE:   "BID_ERR_14",
  // Capital / risk controls
  CAPITAL_CAP_HIT:        "BID_ERR_20",
  DAILY_BID_LIMIT:        "BID_ERR_21",
  BELOW_ROI_FLOOR:        "BID_ERR_22",
  LOW_ACCEPTANCE_PROB:    "BID_ERR_23",
  // Internal errors
  OFFER_CALC_FAIL:        "BID_ERR_30",
  DISPATCH_FAIL:          "BID_ERR_31",
  // Catch-all
  UNKNOWN:                "BID_ERR_99",
});

// Reverse map for internal use: BID_ERR_01 → TOKEN_NOT_FOUND
const _reverseMap = Object.fromEntries(
  Object.entries(BID_ERROR_CODES).map(([k, v]) => [v, k])
);

// ─── Internal Audit Store ─────────────────────────────────────────────────────
// Never exposed via any API route. In production, forward to your internal
// log aggregator (CloudWatch Logs, Datadog, Loki — behind VPC, IAM-gated).
const _internalAudit = [];

/**
 * Log a real error internally with full context.
 * The external caller only ever sees the opaque code.
 *
 * @param {object} params
 * @param {string} params.bidId
 * @param {string} params.userId
 * @param {string} params.platform
 * @param {string} params.internalCode   — key from BID_ERROR_CODES
 * @param {Error|string} params.err      — real error object/message
 * @param {object} [params.context]      — additional diagnostic data
 */
export function auditBidError({ bidId, userId, platform, internalCode, err, context = {} }) {
  const entry = {
    ts: new Date().toISOString(),
    bidId,
    userId: userId ? `${userId.slice(0, 6)}…` : null,  // truncate for log safety
    platform,
    internalCode,
    externalCode: BID_ERROR_CODES[internalCode] ?? BID_ERROR_CODES.UNKNOWN,
    errMessage: err instanceof Error ? err.message : String(err),
    errStack: err instanceof Error ? err.stack?.slice(0, 400) : null,
    context,
  };

  _internalAudit.push(entry);

  // Developer stderr only — never stdout (which may be captured by log shippers
  // configured to forward to external services)
  if (process.env.NODE_ENV !== "production" || process.env.VAULT_DEBUG === "1") {
    process.stderr.write(`[IRON_SHIELD] ${JSON.stringify(entry)}\n`);
  }
  // TODO: forward entry to your internal sink here, e.g.:
  // await logSink.write('bid-errors', entry);
}

/**
 * Log a successful bid dispatch internally.
 */
export function auditBidSuccess({ bidId, userId, platform, offerPrice, listingId }) {
  const entry = {
    ts: new Date().toISOString(),
    event: "BID_DISPATCHED",
    bidId,
    userId: userId ? `${userId.slice(0, 6)}…` : null,
    platform,
    listingId,
    offerPrice,
  };
  _internalAudit.push(entry);
}

/**
 * Map any error to an opaque external code.
 * Accepts: Error object, vaultCode string, HTTP status code, or raw string.
 *
 * @param {Error|string|number} err
 * @returns {string}  — opaque BID_ERR_XX string
 */
export function toOpaqueCode(err) {
  // Vault errors have a .vaultCode property
  if (err?.vaultCode) {
    return BID_ERROR_CODES[err.vaultCode] ?? BID_ERROR_CODES.UNKNOWN;
  }

  // HTTP status codes from platform APIs
  if (typeof err === "number") {
    if (err === 429) return BID_ERROR_CODES.PLATFORM_RATE_LIMIT;
    if (err === 404) return BID_ERROR_CODES.LISTING_GONE;
    if (err === 503) return BID_ERROR_CODES.PLATFORM_MAINTENANCE;
    return BID_ERROR_CODES.UNKNOWN;
  }

  // String internal codes
  if (typeof err === "string" && BID_ERROR_CODES[err]) {
    return BID_ERROR_CODES[err];
  }

  // Error messages — map common patterns without leaking specifics
  const msg = err?.message ?? String(err);
  if (/rate.?limit/i.test(msg))   return BID_ERROR_CODES.PLATFORM_RATE_LIMIT;
  if (/not found|404/i.test(msg)) return BID_ERROR_CODES.LISTING_GONE;
  if (/decrypt|auth.?tag/i.test(msg)) return BID_ERROR_CODES.DECRYPT_FAIL;
  if (/capital/i.test(msg))       return BID_ERROR_CODES.CAPITAL_CAP_HIT;

  return BID_ERROR_CODES.UNKNOWN;
}

/**
 * Wraps an async bidding function with Iron Shield error handling.
 * - On success: returns { ok: true, ...result }
 * - On failure: logs internally, returns { ok: false, code: "BID_ERR_XX" }
 *
 * @param {string} bidId
 * @param {string} userId
 * @param {string} platform
 * @param {() => Promise<any>} fn
 */
export async function withIronShield(bidId, userId, platform, fn) {
  try {
    const result = await fn();
    return { ok: true, ...result };
  } catch (err) {
    const internalCode = err?.vaultCode ?? "UNKNOWN";
    auditBidError({ bidId, userId, platform, internalCode, err });
    return {
      ok: false,
      code: toOpaqueCode(err),
      // NO internal detail exposed here
    };
  }
}

// ─── Internal audit accessor (admin route only) ───────────────────────────────
export function _getInternalAudit(limit = 100) {
  return _internalAudit.slice(-limit);
}

export function _resolveOpaqueCode(externalCode) {
  return _reverseMap[externalCode] ?? null;
}
