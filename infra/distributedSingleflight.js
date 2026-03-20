// infra/distributedSingleflight.js
import crypto from "crypto";

const LOCAL_INFLIGHT = new Map();

function shortHash(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDistributedSingleflight({
  redis,
  namespace = "evanai:singleflight:v1",
  instanceId = "unknown",
  lockTtlMs = 15_000,
  resultTtlSec = 45,
  waitMs = 12_000,
  pollMs = 125,
} = {}) {
  async function run(rawKey, worker) {
    const localKey = String(rawKey || "");
    if (!localKey || typeof worker !== "function") {
      return await worker();
    }

    if (LOCAL_INFLIGHT.has(localKey)) {
      return await LOCAL_INFLIGHT.get(localKey);
    }

    const task = (async () => {
      if (!redis) {
        return await worker();
      }

      const hashed = shortHash(localKey);
      const lockKey = `${namespace}:lock:${hashed}`;
      const resultKey = `${namespace}:result:${hashed}`;
      const token = `${instanceId}:${crypto.randomBytes(8).toString("hex")}`;

      const releaseScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0
      `;

      async function readCachedResult() {
        const raw = await redis.get(resultKey);
        if (!raw) return null;

        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }

      async function executeLocked() {
        try {
          const result = await worker();
          await redis.setex(resultKey, resultTtlSec, JSON.stringify(result));
          await redis.eval(releaseScript, 1, lockKey, token);
          return result;
        } catch (err) {
          await redis.eval(releaseScript, 1, lockKey, token).catch(() => {});
          throw err;
        }
      }

      const cached = await readCachedResult();
      if (cached != null) return cached;

      const acquired = await redis.set(lockKey, token, "PX", lockTtlMs, "NX");
      if (acquired === "OK") {
        return await executeLocked();
      }

      const deadline = Date.now() + waitMs;

      while (Date.now() < deadline) {
        const shared = await readCachedResult();
        if (shared != null) return shared;

        const retryAcquire = await redis.set(lockKey, token, "PX", lockTtlMs, "NX");
        if (retryAcquire === "OK") {
          return await executeLocked();
        }

        await sleep(pollMs);
      }

      const finalShared = await readCachedResult();
      if (finalShared != null) return finalShared;

      // fail-open only after waiting; avoids hard outage
      return await worker();
    })();

    LOCAL_INFLIGHT.set(localKey, task);

    try {
      return await task;
    } finally {
      LOCAL_INFLIGHT.delete(localKey);
    }
  }

  return {
    run,
  };
}
