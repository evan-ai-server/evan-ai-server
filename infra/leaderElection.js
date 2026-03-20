// infra/leaderElection.js
import crypto from "crypto";
export function createLeaderElection({
  redis,
  key = "evanai:leader:v1",
  instanceId = "unknown",
  ttlMs = 15_000,
  renewMs = 5_000,
  onChange = () => {},
} = {}) {
  let leader = false;
  let stopped = false;
  let timer = null;

  const token = `${instanceId}:${crypto.randomBytes(8).toString("hex")}`;

  const renewScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    end
    return 0
  `;

  const releaseScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    end
    return 0
  `;

  function setLeader(next) {
    if (leader === next) return;
    leader = next;

    try {
      onChange(leader);
    } catch {}
  }

  async function tick() {
    if (stopped) return;

    if (!redis) {
      setLeader(true);
      return;
    }

    try {
      const acquired = await redis.set(key, token, "PX", ttlMs, "NX");

      if (acquired === "OK") {
        setLeader(true);
        return;
      }

      const renewed = await redis.eval(
        renewScript,
        1,
        key,
        token,
        String(ttlMs)
      );

      setLeader(Boolean(Number(renewed || 0)));
    } catch {
      setLeader(false);
    }
  }

  function start() {
    if (timer) return;

    stopped = false;

    Promise.resolve().then(tick).catch(() => {});

    timer = setInterval(() => {
      tick().catch(() => {});
    }, Math.max(1000, renewMs));

    timer.unref?.();
  }

  async function stop() {
    stopped = true;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (redis) {
      try {
        await redis.eval(releaseScript, 1, key, token);
      } catch {}
    }

    setLeader(false);
  }

  function isLeader() {
    return leader;
  }

  return {
    start,
    stop,
    isLeader,
  };
}
