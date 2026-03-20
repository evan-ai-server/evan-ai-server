// infra/durableIdempotency.js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDurableIdempotencyMiddleware({
  redis,
  namespace = "evanai:idem:v2",
  headerName = "idempotency-key",
  defaultTtlSec = 24 * 60 * 60,
  waitMs = 10_000,
  pollMs = 125,
} = {}) {
  return function build(scope = "write") {
    return async function durableIdempotency(req, res, next) {
      const inboundKey =
        String(req.headers[headerName] || "").trim() ||
        String(req.headers["x-idempotency-key"] || "").trim();

      if (!inboundKey || !redis) {
        return next();
      }

      const actor =
        String(
          req.userId ||
            req.auth?.userId ||
            req.headers["x-device-id"] ||
            req.ip ||
            "anon"
        ).slice(0, 128);

      const baseKey = `${namespace}:${scope}:${actor}:${inboundKey}`;
      const lockKey = `${baseKey}:lock`;
      const resultKey = `${baseKey}:result`;
      const token = `${Date.now()}:${Math.random().toString(16).slice(2)}`;

      try {
        const cached = await redis.get(resultKey);
        if (cached) {
          const parsed = JSON.parse(cached);

          return res.status(Number(parsed?.statusCode || 200)).json(
            parsed?.payload ?? { ok: true }
          );
        }
      } catch {}

      try {
        const locked = await redis.set(lockKey, token, "PX", waitMs, "NX");

        if (locked !== "OK") {
          const deadline = Date.now() + waitMs;

          while (Date.now() < deadline) {
            const cached = await redis.get(resultKey);

            if (cached) {
              const parsed = JSON.parse(cached);
              return res.status(Number(parsed?.statusCode || 200)).json(
                parsed?.payload ?? { ok: true }
              );
            }

            await sleep(pollMs);
          }

          return res.status(409).json({
            ok: false,
            error: "request_in_progress",
          });
        }
      } catch {
        return next();
      }

      const originalJson = res.json.bind(res);
      let committed = false;

      res.json = function patchedJson(payload) {
        if (!committed) {
          committed = true;

          Promise.resolve()
            .then(async () => {
              await redis.setex(
                resultKey,
                defaultTtlSec,
                JSON.stringify({
                  statusCode: res.statusCode || 200,
                  payload,
                })
              );

              await redis.del(lockKey);
            })
            .catch(async () => {
              try {
                await redis.del(lockKey);
              } catch {}
            });
        }

        return originalJson(payload);
      };

      res.on("close", () => {
        if (!committed) {
          redis.del(lockKey).catch(() => {});
        }
      });

      return next();
    };
  };
}
