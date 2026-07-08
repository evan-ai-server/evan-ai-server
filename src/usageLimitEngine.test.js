// src/usageLimitEngine.test.js
// node --test src/usageLimitEngine.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUsagePlan,
  getUsageLimitsForPlan,
  getRollingWindowState,
  evaluateUsageAllowance,
  consumeUsage,
  getUsageStatus,
} from "./usageLimitEngine.js";

const DAY_MS  = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// ── Minimal in-memory fake Redis ─────────────────────────────────────────
// Implements just the ioredis surface usageLimitEngine.js calls (get, set
// with variadic EX/PX/NX options, del), with real expiry semantics — lets
// the tests exercise the actual Redis-backed code paths, not a mock of
// the module's own logic.
function createFakeRedis() {
  const store = new Map(); // key -> { value, expiresAt: msEpoch|null }

  function isLive(entry) {
    return !!entry && (entry.expiresAt === null || entry.expiresAt > Date.now());
  }

  return {
    async get(key) {
      const entry = store.get(key);
      if (!isLive(entry)) { store.delete(key); return null; }
      return entry.value;
    },
    async set(key, value, ...args) {
      let ttlMs = null;
      let nx = false;
      for (let i = 0; i < args.length; i++) {
        const flag = String(args[i]).toUpperCase();
        if (flag === "EX") ttlMs = Number(args[++i]) * 1000;
        else if (flag === "PX") ttlMs = Number(args[++i]);
        else if (flag === "NX") nx = true;
      }
      if (nx && isLive(store.get(key))) return null;
      store.set(key, { value: String(value), expiresAt: ttlMs != null ? Date.now() + ttlMs : null });
      return "OK";
    },
    async del(key) { store.delete(key); },
  };
}

function throwingRedis(message = "redis unavailable") {
  return {
    async get() { throw new Error(message); },
    async set() { throw new Error(message); },
    async del() { throw new Error(message); },
  };
}

// ── 1-3: per-plan limits ─────────────────────────────────────────────────

test("free limits are 3/day and 10/week", () => {
  assert.deepEqual(getUsageLimitsForPlan("free"), { daily: 3, weekly: 10 });
});

test("hunter limits are 30/day and 150/week", () => {
  assert.deepEqual(getUsageLimitsForPlan("hunter"), { daily: 30, weekly: 150 });
});

test("pro limits are 150/day and 750/week", () => {
  assert.deepEqual(getUsageLimitsForPlan("pro"), { daily: 150, weekly: 750 });
});

// ── 4: internal unlimited ────────────────────────────────────────────────

test("internal is unlimited", async () => {
  const limits = getUsageLimitsForPlan("internal");
  assert.equal(Number.isFinite(limits.daily), false);
  assert.equal(Number.isFinite(limits.weekly), false);

  const redis = throwingRedis(); // must not even be touched for internal
  const result = await consumeUsage({ userId: "u1", plan: "internal", scanId: "s1", redisClient: redis });
  assert.equal(result.ok, true);
  assert.equal(result.canScan, true);
  assert.equal(result.daily.limit, null);
});

// ── 5-6: allowance decisions (pure) ──────────────────────────────────────

test("daily cap blocks when daily used reaches limit", () => {
  const now = Date.now();
  const dailyState  = { windowStartMs: now, used: 3 };
  const weeklyState = { windowStartMs: now, used: 3 };
  const r = evaluateUsageAllowance({ plan: "free", dailyState, weeklyState });
  assert.equal(r.canScan, false);
  assert.equal(r.reason, "daily_limit");
});

test("weekly cap blocks even when daily allows", () => {
  const now = Date.now();
  const dailyState  = { windowStartMs: now, used: 0 };  // well under daily limit
  const weeklyState = { windowStartMs: now, used: 10 }; // at weekly limit
  const r = evaluateUsageAllowance({ plan: "free", dailyState, weeklyState });
  assert.equal(r.canScan, false);
  assert.equal(r.reason, "weekly_limit");
});

// ── 7-8: rolling reset (pure) ─────────────────────────────────────────────

test("rolling daily reset after 24h", () => {
  const now = Date.now();
  const staleState = { windowStartMs: now - DAY_MS - 1, used: 3 };
  const result = getRollingWindowState(now, DAY_MS, staleState);
  assert.equal(result.used, 0);
  assert.equal(result.windowStartMs, now);
});

test("daily window does NOT reset before 24h elapses", () => {
  const now = Date.now();
  const freshState = { windowStartMs: now - (DAY_MS - 1000), used: 2 };
  const result = getRollingWindowState(now, DAY_MS, freshState);
  assert.equal(result.used, 2);
  assert.equal(result.windowStartMs, freshState.windowStartMs);
});

test("rolling weekly reset after 7 days", () => {
  const now = Date.now();
  const staleState = { windowStartMs: now - WEEK_MS - 1, used: 10 };
  const result = getRollingWindowState(now, WEEK_MS, staleState);
  assert.equal(result.used, 0);
  assert.equal(result.windowStartMs, now);
});

// ── 9: scanId idempotency, bound to a server-computed fingerprint ────────

test("same scanId + same fingerprint is idempotent and does not double-count", async () => {
  const redis = createFakeRedis();
  const opts = { userId: "u1", plan: "free", scanId: "scan-abc", requestFingerprint: "fp-image-A", redisClient: redis };

  const first = await consumeUsage(opts);
  assert.equal(first.ok, true);
  assert.equal(first.consumed, true);
  assert.equal(first.deduped, false);
  assert.equal(first.daily.used, 1);

  const retry = await consumeUsage(opts);
  assert.equal(retry.ok, true);
  assert.equal(retry.deduped, true);
  assert.equal(retry.consumed, false);
  assert.equal(retry.daily.used, 1); // unchanged — did not double-count

  const status = await getUsageStatus({ userId: "u1", plan: "free", redisClient: redis });
  assert.equal(status.daily.used, 1);
});

test("SECURITY: same scanId + DIFFERENT fingerprint is rejected, not bypassed or double-consumed", async () => {
  const redis = createFakeRedis();
  const fixedScanId = "attacker-reused-scan-id";

  const first = await consumeUsage({
    userId: "u1", plan: "free", scanId: fixedScanId, requestFingerprint: "fp-real-image-1", redisClient: redis,
  });
  assert.equal(first.consumed, true);
  assert.equal(first.daily.used, 1);

  // Same scanId, but a genuinely different upload — must NOT replay the
  // cached "allowed" decision, and must NOT silently consume as fresh.
  const attempt2 = await consumeUsage({
    userId: "u1", plan: "free", scanId: fixedScanId, requestFingerprint: "fp-DIFFERENT-image-2", redisClient: redis,
  });
  assert.equal(attempt2.ok, false);
  assert.equal(attempt2.error, "idempotency_conflict");

  const attempt3 = await consumeUsage({
    userId: "u1", plan: "free", scanId: fixedScanId, requestFingerprint: "fp-yet-ANOTHER-image-3", redisClient: redis,
  });
  assert.equal(attempt3.ok, false);
  assert.equal(attempt3.error, "idempotency_conflict");

  // Quota must still show exactly 1 used — the bypass attempts consumed nothing.
  const status = await getUsageStatus({ userId: "u1", plan: "free", redisClient: redis });
  assert.equal(status.daily.used, 1);
});

test("a different scanId + same fingerprint consumes again (dedup is scoped per scanId)", async () => {
  const redis = createFakeRedis();
  await consumeUsage({ userId: "u1", plan: "free", scanId: "scan-1", requestFingerprint: "fp-same-image", redisClient: redis });
  const second = await consumeUsage({ userId: "u1", plan: "free", scanId: "scan-2", requestFingerprint: "fp-same-image", redisClient: redis });
  assert.equal(second.consumed, true);
  assert.equal(second.daily.used, 2);
});

test("missing fingerprint (scanId present) fails closed", async () => {
  const redis = createFakeRedis();
  const result = await consumeUsage({ userId: "u1", plan: "free", scanId: "scan-no-fp", redisClient: redis });
  assert.equal(result.ok, false);
  assert.equal(result.error, "usage_check_unavailable");

  // Nothing should have been consumed.
  const status = await getUsageStatus({ userId: "u1", plan: "free", redisClient: redis });
  assert.equal(status.daily.used, 0);
});

test("consumeUsage blocks at the free daily limit and does not increment further", async () => {
  const redis = createFakeRedis();
  for (let i = 0; i < 3; i++) {
    const r = await consumeUsage({ userId: "u1", plan: "free", scanId: `s${i}`, requestFingerprint: `fp-${i}`, redisClient: redis });
    assert.equal(r.canScan, true);
  }
  const blocked = await consumeUsage({ userId: "u1", plan: "free", scanId: "s3", requestFingerprint: "fp-3", redisClient: redis });
  assert.equal(blocked.canScan, false);
  assert.equal(blocked.reason, "daily_limit");
  assert.equal(blocked.consumed, false);
  assert.equal(blocked.daily.used, 3); // did not increment past the limit
});

// ── 10: unknown plan defaults safely to free ─────────────────────────────

test("missing/unknown plan defaults safely to free", () => {
  assert.equal(normalizeUsagePlan(undefined), "free");
  assert.equal(normalizeUsagePlan(null), "free");
  assert.equal(normalizeUsagePlan("totally_made_up_plan"), "free");
  assert.deepEqual(getUsageLimitsForPlan("nonsense"), { daily: 3, weekly: 10 });
});

// ── 11: Redis error fails closed ─────────────────────────────────────────

test("consumeUsage fails closed (ok:false) when Redis errors, never grants access", async () => {
  const redis = throwingRedis();
  const result = await consumeUsage({ userId: "u1", plan: "free", scanId: "s1", requestFingerprint: "fp-1", redisClient: redis });
  assert.equal(result.ok, false);
  assert.equal(result.error, "usage_check_unavailable");
  assert.equal(result.canScan, undefined); // no allowance opinion offered on failure
});

test("consumeUsage fails closed when redisClient is null (not internal plan)", async () => {
  const result = await consumeUsage({ userId: "u1", plan: "pro", scanId: "s1", redisClient: null });
  assert.equal(result.ok, false);
  assert.equal(result.error, "usage_check_unavailable");
});

test("getUsageStatus fails closed (ok:false) when Redis errors", async () => {
  const redis = throwingRedis();
  const result = await getUsageStatus({ userId: "u1", plan: "hunter", redisClient: redis });
  assert.equal(result.ok, false);
  assert.equal(result.error, "usage_check_unavailable");
});
