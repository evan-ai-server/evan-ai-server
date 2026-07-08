// src/usageLimitEngine.js
// Phase B2: unified backend daily + weekly usage enforcement.
//
// Rolling per-user windows (not global midnight): a window starts at the
// first counted use after the previous window elapsed, and resets exactly
// windowMs later — implemented via Redis INCR + a PEXPIRE set only on the
// first increment of a window, so the key's own TTL *is* the window state.
// No local-memory fallback on Redis failure — unlike the older
// incrementDistributedWindowCounter helper, this deliberately fails CLOSED
// (returns ok:false) so a Redis outage can never grant unlimited scans on
// a costly route.
//
// Redis keys:
//   usage:daily:{userId}          STRING  count, PX = remaining ms in window
//   usage:weekly:{userId}         STRING  count, PX = remaining ms in window
//   usage:dedup:{userId}:{scanId} STRING  {pending, fingerprint, result?} JSON, EX 600s
//     — fingerprint binds the scanId to a server-computed hash of the
//     actual uploaded content, so a client can't dedupe/bypass by reusing
//     one scanId across different uploads (see consumeUsage).

const DAY_MS  = 24 * 60 * 60 * 1000;
const WEEK_MS = 7  * DAY_MS;
const DEDUP_TTL_SEC = 600; // 10 min — long enough to cover client retries

const USAGE_LIMITS = {
  free:     { daily: 3,   weekly: 10  },
  hunter:   { daily: 30,  weekly: 150 },
  pro:      { daily: 150, weekly: 750 },
  internal: { daily: Infinity, weekly: Infinity },
};

const KEY_DAILY  = (userId) => `usage:daily:${userId}`;
const KEY_WEEKLY = (userId) => `usage:weekly:${userId}`;
const KEY_DEDUP  = (userId, scanId) => `usage:dedup:${userId}:${scanId}`;

export function normalizeUsagePlan(plan) {
  const p = String(plan || "").toLowerCase().trim();
  return USAGE_LIMITS[p] ? p : "free";
}

export function getUsageLimitsForPlan(plan) {
  return USAGE_LIMITS[normalizeUsagePlan(plan)];
}

/**
 * Pure rolling-window reducer — storage-agnostic, no side effects.
 * Given a previous {windowStartMs, used} and now, returns the EFFECTIVE
 * state: a fresh window (used:0, windowStartMs:nowMs) if windowMs has
 * elapsed since windowStartMs, otherwise the previous state unchanged.
 */
export function getRollingWindowState(nowMs, windowMs, previousState) {
  const prev =
    previousState && Number.isFinite(previousState.windowStartMs)
      ? previousState
      : { windowStartMs: nowMs, used: 0 };

  const elapsed = nowMs - prev.windowStartMs;
  if (elapsed >= windowMs) {
    return { windowStartMs: nowMs, used: 0 };
  }
  return { windowStartMs: prev.windowStartMs, used: prev.used || 0 };
}

/**
 * Pure allowance decision given already-resolved daily/weekly window
 * states. No Redis, no side effects — the shared decision core.
 */
export function evaluateUsageAllowance({ plan, dailyState, weeklyState }) {
  const limits = getUsageLimitsForPlan(plan);

  if (!Number.isFinite(limits.daily)) {
    return { canScan: true, reason: null };
  }
  if (dailyState.used >= limits.daily) {
    return { canScan: false, reason: "daily_limit" };
  }
  if (weeklyState.used >= limits.weekly) {
    return { canScan: false, reason: "weekly_limit" };
  }
  return { canScan: true, reason: null };
}

function windowResetAtISO(windowStartMs, windowMs) {
  return new Date(windowStartMs + windowMs).toISOString();
}

function buildStatusResult({ consumed, canScan, reason, plan, dailyState, weeklyState }) {
  const limits = getUsageLimitsForPlan(plan);
  return {
    ok: true,
    consumed,
    deduped: false,
    canScan,
    reason,
    plan,
    daily: {
      used: dailyState.used,
      limit: limits.daily,
      remaining: Math.max(0, limits.daily - dailyState.used),
      resetAt: windowResetAtISO(dailyState.windowStartMs, DAY_MS),
    },
    weekly: {
      used: weeklyState.used,
      limit: limits.weekly,
      remaining: Math.max(0, limits.weekly - weeklyState.used),
      resetAt: windowResetAtISO(weeklyState.windowStartMs, WEEK_MS),
    },
  };
}

function unlimitedResult(plan) {
  return {
    ok: true,
    consumed: true,
    deduped: false,
    canScan: true,
    reason: null,
    plan,
    daily:  { used: 0, limit: null, remaining: null, resetAt: null },
    weekly: { used: 0, limit: null, remaining: null, resetAt: null },
  };
}

async function readWindowState(redisClient, key, nowMs, windowMs) {
  const raw = await redisClient.get(key);
  let previousState = null;
  if (raw) {
    try { previousState = JSON.parse(raw); } catch { previousState = null; }
  }
  return getRollingWindowState(nowMs, windowMs, previousState);
}

async function writeWindowState(redisClient, key, state, windowMs, nowMs) {
  // TTL = remaining time in THIS window, so a stale key can never outlive
  // the window it describes and the key's own expiry doubles as resetAt.
  const remainingMs = Math.max(1000, state.windowStartMs + windowMs - nowMs);
  await redisClient.set(key, JSON.stringify(state), "PX", remainingMs);
}

/**
 * Atomically consume one unit of usage against both the daily and weekly
 * windows, idempotent by scanId — but idempotency is bound to a server-
 * computed requestFingerprint (e.g. sha256 of the uploaded file's actual
 * bytes), never to scanId alone. SECURITY: without this binding, a caller
 * could reuse one scanId across unlimited different uploads and replay the
 * same "already consumed, allowed" decision forever, bypassing quota
 * entirely. The SAME scanId with a DIFFERENT fingerprint is rejected as
 * idempotency_conflict, not silently replayed and not silently consumed
 * under someone else's dedup slot. A scanId with no fingerprint at all
 * fails closed — an unbound scanId is exactly the bypass vector this
 * guards against, so there is no safe way to dedupe without one.
 * Never grants access when Redis is unavailable — returns { ok:false }
 * instead so the caller can fail closed (503), rather than silently
 * allowing unlimited scans.
 */
export async function consumeUsage({ userId, plan, scanId, requestFingerprint, redisClient, nowMs = Date.now(), cost = 1 }) {
  const normalizedPlan = normalizeUsagePlan(plan);
  const limits = getUsageLimitsForPlan(normalizedPlan);

  if (!Number.isFinite(limits.daily)) {
    return unlimitedResult(normalizedPlan);
  }

  if (!redisClient) {
    return { ok: false, error: "usage_check_unavailable" };
  }

  const safeScanId = String(scanId || "").trim().slice(0, 128) || null;
  const safeFingerprint = String(requestFingerprint || "").trim().slice(0, 128) || null;
  const dedupKey = safeScanId ? KEY_DEDUP(userId, safeScanId) : null;

  try {
    if (dedupKey) {
      if (!safeFingerprint) {
        return { ok: false, error: "usage_check_unavailable" };
      }

      const claimPayload = JSON.stringify({ pending: true, fingerprint: safeFingerprint });
      const claimed = await redisClient.set(dedupKey, claimPayload, "EX", DEDUP_TTL_SEC, "NX");

      if (claimed !== "OK") {
        const cachedRaw = await redisClient.get(dedupKey).catch(() => null);
        let cached = null;
        try { cached = cachedRaw ? JSON.parse(cachedRaw) : null; } catch { cached = null; }

        if (!cached) {
          // Unreadable/corrupt entry — fail closed rather than dedupe blind.
          return { ok: false, error: "usage_check_unavailable" };
        }

        if (cached.fingerprint !== safeFingerprint) {
          // Same scanId, DIFFERENT upload — the bypass pattern. Reject
          // outright: never a valid retry, never consumed as fresh either.
          return { ok: false, error: "idempotency_conflict" };
        }

        if (cached.pending) {
          // Genuinely concurrent duplicate of the SAME upload, still
          // resolving — fail closed rather than risk a double-consume.
          return { ok: false, error: "usage_check_unavailable" };
        }

        // Same scanId, same upload, already resolved — true idempotent replay.
        return { ...cached.result, deduped: true, consumed: false };
      }
    }

    const dailyKey  = KEY_DAILY(userId);
    const weeklyKey = KEY_WEEKLY(userId);

    const dailyState  = await readWindowState(redisClient, dailyKey,  nowMs, DAY_MS);
    const weeklyState = await readWindowState(redisClient, weeklyKey, nowMs, WEEK_MS);

    const allowance = evaluateUsageAllowance({ plan: normalizedPlan, dailyState, weeklyState });

    let result;
    if (!allowance.canScan) {
      // Blocked attempts never increment — only successful consumption counts.
      result = buildStatusResult({
        consumed: false, canScan: false, reason: allowance.reason,
        plan: normalizedPlan, dailyState, weeklyState,
      });
    } else {
      const newDaily  = { windowStartMs: dailyState.windowStartMs,  used: dailyState.used  + cost };
      const newWeekly = { windowStartMs: weeklyState.windowStartMs, used: weeklyState.used + cost };
      await Promise.all([
        writeWindowState(redisClient, dailyKey,  newDaily,  DAY_MS,  nowMs),
        writeWindowState(redisClient, weeklyKey, newWeekly, WEEK_MS, nowMs),
      ]);
      result = buildStatusResult({
        consumed: true, canScan: true, reason: null,
        plan: normalizedPlan, dailyState: newDaily, weeklyState: newWeekly,
      });
    }

    if (dedupKey) {
      await redisClient
        .set(dedupKey, JSON.stringify({ pending: false, fingerprint: safeFingerprint, result }), "EX", DEDUP_TTL_SEC)
        .catch(() => {});
    }

    return result;
  } catch {
    return { ok: false, error: "usage_check_unavailable" };
  }
}

/**
 * Read-only usage status — no consumption. Returns { ok:false } on Redis
 * failure rather than fabricating a misleading "0 used" result.
 */
export async function getUsageStatus({ userId, plan, redisClient, nowMs = Date.now() }) {
  const normalizedPlan = normalizeUsagePlan(plan);
  const limits = getUsageLimitsForPlan(normalizedPlan);

  if (!Number.isFinite(limits.daily)) {
    return unlimitedResult(normalizedPlan);
  }

  if (!redisClient) {
    return { ok: false, error: "usage_check_unavailable" };
  }

  try {
    const dailyState  = await readWindowState(redisClient, KEY_DAILY(userId),  nowMs, DAY_MS);
    const weeklyState = await readWindowState(redisClient, KEY_WEEKLY(userId), nowMs, WEEK_MS);
    const allowance = evaluateUsageAllowance({ plan: normalizedPlan, dailyState, weeklyState });
    return buildStatusResult({
      consumed: false, canScan: allowance.canScan, reason: allowance.reason,
      plan: normalizedPlan, dailyState, weeklyState,
    });
  } catch {
    return { ok: false, error: "usage_check_unavailable" };
  }
}
