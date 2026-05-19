/**
 * rateLimiter.js — Per-platform and per-user bid rate enforcement
 *
 * We voluntarily self-limit to 60% of platform API quotas.
 * This leaves headroom for legitimate browsing activity from the same OAuth token,
 * prevents triggering platform abuse detection thresholds, and provides
 * natural variance that makes traffic look organic.
 *
 * Enforcement is layered:
 *   1. Per-user daily and hourly limits (prevent runaway bids)
 *   2. Per-platform limits (eBay/Poshmark quotas)
 *   3. Minimum inter-call interval (prevents burst patterns)
 */

// ─── Platform Limits ─────────────────────────────────────────────────────────
// Set at 60% of the documented platform API quotas.
const PLATFORM_LIMITS = {
  ebay: {
    perHour: 120,           // eBay Negotiation API: 200/hr → self-limit to 120
    perDay: 3_000,          // 5,000/day → self-limit to 3,000
    minIntervalMs: 30_000,  // 30s minimum between calls
  },
  poshmark: {
    perHour: 60,            // Poshmark offer API: 100/hr → self-limit to 60
    perDay: 1_000,
    minIntervalMs: 60_000,  // 60s minimum
  },
  default: {
    perHour: 40,
    perDay: 500,
    minIntervalMs: 90_000,
  },
};

// ─── Per-user Limits ──────────────────────────────────────────────────────────
const USER_LIMITS = {
  perHour:  8,   // No one clicks "Buy" 8+ times per hour legitimately
  perDay:   30,  // 30 offers/day is aggressive — typical reseller does 5–10
};

// ─── State Store ──────────────────────────────────────────────────────────────
// In production, use Redis for distributed rate limiting across server instances.
// Schema: key → { count: number, windowStart: number }
const _userHourly  = new Map();  // userId → { count, windowStart }
const _userDaily   = new Map();  // userId → { count, windowStart }
const _platHourly  = new Map();  // platform → { count, windowStart }
const _platDaily   = new Map();  // platform → { count, windowStart }
const _lastCall    = new Map();  // platform → timestamp of last dispatch

function _now() { return Date.now(); }
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS  = 24 * HOUR_MS;

function _getWindow(map, key, windowMs) {
  const entry = map.get(key);
  const now = _now();
  if (!entry || now - entry.windowStart > windowMs) {
    const fresh = { count: 0, windowStart: now };
    map.set(key, fresh);
    return fresh;
  }
  return entry;
}

// ─── BidRateLimiter ───────────────────────────────────────────────────────────
export class BidRateLimiter {
  /**
   * Check if a bid dispatch is allowed right now.
   * Returns { allowed: true } or { allowed: false, reason: string, retryAfterMs: number }
   *
   * @param {string} userId
   * @param {"ebay" | "poshmark" | string} platform
   */
  canDispatch(userId, platform) {
    const platLimits = PLATFORM_LIMITS[platform] ?? PLATFORM_LIMITS.default;
    const now = _now();

    // 1. Minimum inter-call interval (platform)
    const lastCallTs = _lastCall.get(platform) ?? 0;
    const sinceLast  = now - lastCallTs;
    if (sinceLast < platLimits.minIntervalMs) {
      return {
        allowed: false,
        reason: "MIN_INTERVAL",
        retryAfterMs: platLimits.minIntervalMs - sinceLast,
      };
    }

    // 2. Platform hourly
    const platHr = _getWindow(_platHourly, platform, HOUR_MS);
    if (platHr.count >= platLimits.perHour) {
      return {
        allowed: false,
        reason: "PLATFORM_HOURLY",
        retryAfterMs: HOUR_MS - (now - platHr.windowStart),
      };
    }

    // 3. Platform daily
    const platDay = _getWindow(_platDaily, platform, DAY_MS);
    if (platDay.count >= platLimits.perDay) {
      return {
        allowed: false,
        reason: "PLATFORM_DAILY",
        retryAfterMs: DAY_MS - (now - platDay.windowStart),
      };
    }

    // 4. User hourly
    const userHr = _getWindow(_userHourly, userId, HOUR_MS);
    if (userHr.count >= USER_LIMITS.perHour) {
      return {
        allowed: false,
        reason: "USER_HOURLY",
        retryAfterMs: HOUR_MS - (now - userHr.windowStart),
      };
    }

    // 5. User daily
    const userDay = _getWindow(_userDaily, userId, DAY_MS);
    if (userDay.count >= USER_LIMITS.perDay) {
      return {
        allowed: false,
        reason: "USER_DAILY",
        retryAfterMs: DAY_MS - (now - userDay.windowStart),
      };
    }

    return { allowed: true };
  }

  /**
   * Record a successful dispatch. Call AFTER the platform API call succeeds.
   *
   * @param {string} userId
   * @param {string} platform
   */
  record(userId, platform) {
    const now = _now();
    _lastCall.set(platform, now);

    _getWindow(_userHourly,  userId,   HOUR_MS).count++;
    _getWindow(_userDaily,   userId,   DAY_MS).count++;
    _getWindow(_platHourly,  platform, HOUR_MS).count++;
    _getWindow(_platDaily,   platform, DAY_MS).count++;
  }

  /**
   * Returns current usage stats for a user (safe to return to client).
   */
  usage(userId, platform) {
    const platLimits = PLATFORM_LIMITS[platform] ?? PLATFORM_LIMITS.default;
    const now = _now();
    const userHr  = _getWindow(_userHourly,  userId,   HOUR_MS);
    const userDay = _getWindow(_userDaily,   userId,   DAY_MS);
    const platHr  = _getWindow(_platHourly,  platform, HOUR_MS);

    return {
      user: {
        hourly:  { used: userHr.count,  limit: USER_LIMITS.perHour },
        daily:   { used: userDay.count, limit: USER_LIMITS.perDay },
      },
      platform: {
        hourly:  { used: platHr.count,  limit: platLimits.perHour },
        minIntervalRemaining: Math.max(0, platLimits.minIntervalMs - (now - (_lastCall.get(platform) ?? 0))),
      },
    };
  }
}

export const rateLimiter = new BidRateLimiter();
