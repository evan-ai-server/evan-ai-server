// src/failureFingerprintEngine.js
// Failure fingerprint pattern detection and scan-time enforcement.
//
// A "failure fingerprint" is the combination of scan conditions present when a user
// suffered a realized loss. When the same pattern recurs at scan time, Evan downgrades
// the signal proactively — before the user acts.
//
// Pattern dimensions (all required for a match):
//   buySignal  — signal tier at time of loss (STRONG BUY, GOOD DEAL, FAIR)
//   depthTier  — market depth tier (INSUFFICIENT, THIN, DEVELOPING, ADEQUATE, DEEP)
//   priceRange — "low" (<$75), "mid" ($75–$300), "high" (>$300)
//   category   — item category
//
// Enforcement threshold: 3+ losses in the same pattern before enforcement kicks in.
// Enforcement effect: downgrade signal one tier (STRONG BUY→GOOD DEAL, GOOD DEAL→FAIR).
// Never escalates a signal.
//
// Storage:
//   Redis HASH  key: failprint:{userId}
//               field: <fingerprintKey>   value: JSON { count, lastAt }

const KEY_FAIL  = (uid) => `failprint:${uid}`;
const TTL       = 365 * 86400;
const ENFORCE_THRESHOLD = 3;

// Signal downgrade map — one tier down, no escalation
const DOWNGRADE_MAP = {
  "STRONG BUY": "GOOD DEAL",
  "GOOD DEAL":  "FAIR",
  "FAIR":       "FAIR",   // floor — already the minimum actionable tier
};

// ── Build key ────────────────────────────────────────────────────────────────

/**
 * Build a fingerprint key from scan context dimensions.
 */
export function buildFingerprintKey({ buySignal, depthTier, priceRange, category }) {
  const sig = String(buySignal  || "").replace(/\s+/g, "_").toLowerCase().slice(0, 20);
  const dep = String(depthTier  || "").replace(/\s+/g, "_").toLowerCase().slice(0, 20);
  const prc = String(priceRange || "").toLowerCase().slice(0, 10);
  const cat = String(category   || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  return `${sig}|${dep}|${prc}|${cat}`;
}

// ── Record a loss ─────────────────────────────────────────────────────────────

/**
 * Record a failure fingerprint when a realized loss is confirmed.
 * Call this from POST /scan/buy-outcome when isWin === false.
 *
 * @param {object} params — { buySignal, depthTier, priceRange, category }
 */
export async function recordFailurePattern(redis, userId, { buySignal, depthTier, priceRange, category }) {
  if (!redis || !userId || !buySignal) return;
  try {
    const key     = buildFingerprintKey({ buySignal, depthTier, priceRange, category });
    const rawVal  = await redis.hget(KEY_FAIL(userId), key);
    const prev    = rawVal ? JSON.parse(rawVal) : { count: 0, lastAt: 0 };
    const updated = { count: prev.count + 1, lastAt: Date.now() };
    await redis.pipeline()
      .hset(KEY_FAIL(userId), key, JSON.stringify(updated))
      .expire(KEY_FAIL(userId), TTL)
      .exec();
  } catch { /* non-fatal */ }
}

// ── Load all fingerprints ─────────────────────────────────────────────────────

/**
 * Load all failure fingerprints for a user.
 * @returns {{ fingerprintKey: string, count: number, lastAt: number }[]}
 */
export async function loadFailureFingerprints(redis, userId) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.hgetall(KEY_FAIL(userId));
    if (!raw) return [];
    return Object.entries(raw).map(([key, val]) => {
      try {
        const parsed = JSON.parse(val);
        return { fingerprintKey: key, count: Number(parsed.count || 0), lastAt: Number(parsed.lastAt || 0) };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ── Match at scan time ────────────────────────────────────────────────────────

/**
 * Check whether the current scan context matches a known failure pattern that
 * has reached the enforcement threshold.
 *
 * @returns {{ matched: true, fingerprintKey, matchCount, downgradeRec } | null}
 */
export async function matchFailurePattern(redis, userId, { buySignal, depthTier, priceRange, category }) {
  if (!redis || !userId || !buySignal) return null;
  try {
    const key   = buildFingerprintKey({ buySignal, depthTier, priceRange, category });
    const rawVal = await redis.hget(KEY_FAIL(userId), key);
    if (!rawVal) return null;

    const parsed = JSON.parse(rawVal);
    const count  = Number(parsed.count || 0);
    if (count < ENFORCE_THRESHOLD) return null;

    return {
      matched:        true,
      fingerprintKey: key,
      matchCount:     count,
      downgradeRec:   DOWNGRADE_MAP[buySignal] || buySignal,
    };
  } catch { return null; }
}

// ── Enforce at scan time ──────────────────────────────────────────────────────

/**
 * Apply failure gate: if a match exists and would change the signal, return the
 * downgraded signal and enforcement context.
 * Safe to call with null matchResult (no-op).
 *
 * @returns {{ signal: string, enforced: boolean, reason: string | null }}
 */
export function enforceFailureGate(buySignal, matchResult) {
  if (!matchResult?.matched) {
    return { signal: buySignal, enforced: false, reason: null };
  }
  const downgraded = matchResult.downgradeRec || buySignal;
  if (downgraded === buySignal) {
    return { signal: buySignal, enforced: false, reason: null };
  }
  return {
    signal:   downgraded,
    enforced: true,
    reason:   `This exact pattern has failed ${matchResult.matchCount} times — signal adjusted from ${buySignal} to ${downgraded}`,
  };
}
