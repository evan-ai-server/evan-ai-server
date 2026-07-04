// src/revenueAttribution.js
// Revenue Attribution — Phase 14: Money Engine.
//
// Tracks the monetization funnel without coupling to signal computation:
//   scan → affiliate click → subscription event
//
// All writes are non-blocking — attribution failures never affect scan responses.
//
// Redis keys:
//   rev:scan:{userId}:{YYYY-MM-DD}   HASH   scanCount, plan buckets, category counts
//   rev:click:{userId}:{YYYY-MM-DD}  HASH   affiliateClicks, source/cat/program counts
//   rev:sub:{userId}                 STRING  last subscription record (1yr TTL)
//   rev:daily:{YYYY-MM-DD}           LIST   raw event stream (30d TTL, max 10k/day)
//   rev:agg:{YYYY-MM-DD}             HASH   global daily aggregates across all users

const KEY_SCAN  = (uid, d) => `rev:scan:${uid}:${d}`;
const KEY_CLICK = (uid, d) => `rev:click:${uid}:${d}`;
const KEY_SUB   = (uid)    => `rev:sub:${uid}`;
const KEY_DAILY = (d)      => `rev:daily:${d}`;
const KEY_AGG   = (d)      => `rev:agg:${d}`;

const EVENT_TTL = 30  * 86400;  // 30 days
const SUB_TTL   = 365 * 86400;  // 1 year
const MAX_EVENTS_PER_DAY = 10_000;

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function buildDateKeys(days) {
  const keys = [];
  const now  = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

// ── Event recording ────────────────────────────────────────────────────────────

/**
 * Record a scan attribution event.
 * Call non-blocking from every scan response (all plans).
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts
 *   scanId   {string}  — scan identifier
 *   plan     {string}  — "free" | "pro" | "internal"
 *   category {string}  — item category
 *   signal   {string}  — buySignal value
 */
export async function recordScanEvent(redis, userId, {
  scanId   = null,
  plan     = "free",
  category = null,
  signal   = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const date    = todayUTC();
    const scanKey = KEY_SCAN(userId, date);
    const aggKey  = KEY_AGG(date);
    const pipe    = redis.pipeline();

    // Per-user daily counts
    pipe.hincrby(scanKey, "scanCount", 1);
    pipe.hincrby(scanKey, `plan_${plan}`, 1);
    if (category) pipe.hincrby(scanKey, `cat_${String(category).toLowerCase().slice(0, 40)}`, 1);
    if (signal)   pipe.hincrby(scanKey, `sig_${signal.replace(/\s+/g, "_").toLowerCase()}`, 1);
    pipe.expire(scanKey, EVENT_TTL);

    // Global daily aggregate
    pipe.hincrby(aggKey, "totalScans", 1);
    pipe.hincrby(aggKey, `plan_${plan}`, 1);
    pipe.expire(aggKey, EVENT_TTL);

    // Raw event stream (ops visibility)
    const ev = JSON.stringify({
      t: "scan", uid: userId, scanId, plan, cat: category, sig: signal, at: Date.now(),
    });
    pipe.lpush(KEY_DAILY(date), ev);
    pipe.ltrim(KEY_DAILY(date), 0, MAX_EVENTS_PER_DAY - 1);
    pipe.expire(KEY_DAILY(date), EVENT_TTL);

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// Issue 4: Minimum interaction duration before a click is counted as high-quality.
// Clicks under this threshold are recorded as low_quality and excluded from
// primary aggregate counts (they are still logged for debugging).
const MIN_CLICK_DURATION_MS = 1500;

/**
 * Record an affiliate click.
 * Called from POST /attribution/click when client taps a listing URL.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} opts
 *   scanId      {string}
 *   source      {string}   — e.g. "ebay", "amazon"
 *   category    {string}
 *   program     {string}   — affiliate program id
 *   durationMs  {number}   — ms between scan result render and click (from client)
 */
export async function recordAffiliateClickEvent(redis, userId, {
  scanId     = null,
  source     = null,
  category   = null,
  program    = null,
  durationMs = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    // Issue 4: classify click quality; low-quality clicks are logged but not
    // counted in primary aggregate metrics to keep attribution clean.
    const quality = (durationMs != null && Number(durationMs) < MIN_CLICK_DURATION_MS)
      ? "low_quality"
      : "high";

    const date     = todayUTC();
    const clickKey = KEY_CLICK(userId, date);
    const aggKey   = KEY_AGG(date);
    const pipe     = redis.pipeline();

    if (quality === "high") {
      pipe.hincrby(clickKey, "affiliateClicks", 1);
      if (source)   pipe.hincrby(clickKey, `src_${source}`, 1);
      if (category) pipe.hincrby(clickKey, `cat_${String(category).toLowerCase().slice(0, 40)}`, 1);
      if (program)  pipe.hincrby(clickKey, `prog_${program}`, 1);
      pipe.hincrby(aggKey, "affiliateClicks", 1);
      if (program) pipe.hincrby(aggKey, `prog_${program}`, 1);
    } else {
      // Low-quality: count separately so ops can review without polluting metrics
      pipe.hincrby(clickKey, "affiliateClicks_lowQuality", 1);
      pipe.hincrby(aggKey,   "affiliateClicks_lowQuality", 1);
    }
    pipe.expire(clickKey, EVENT_TTL);
    pipe.expire(aggKey,   EVENT_TTL);

    const ev = JSON.stringify({
      t: "click", uid: userId, scanId, source, cat: category, prog: program,
      quality, durationMs, at: Date.now(),
    });
    pipe.lpush(KEY_DAILY(date), ev);
    pipe.ltrim(KEY_DAILY(date), 0, MAX_EVENTS_PER_DAY - 1);
    pipe.expire(KEY_DAILY(date), EVENT_TTL);

    await pipe.exec();
  } catch { /* non-fatal */ }
}

/**
 * Record a subscription lifecycle event.
 * Called from POST /attribution/subscription (RevenueCat webhook or client report).
 *
 * event: "activated" | "renewed" | "cancelled" | "restored" | "trial_started"
 *
 * SECURITY: this record is ANALYTICS-ONLY. clientReportedPlan is
 * self-reported by whatever called the endpoint (today: the mobile client;
 * there is no signed webhook source yet) and must never be read as trusted
 * entitlement — true plan/entitlement resolution is JWT/server-verified only
 * (see getResolvedPlan in index.js). trusted/entitlement/verifiedPlan/
 * verifiedAt are fixed at their safe defaults until a verified source exists.
 */
export async function recordSubscriptionEvent(redis, userId, {
  event  = null,
  clientReportedPlan = null,
  source = null,  // "revenuecat_webhook" | "client_report" | "manual"
} = {}) {
  if (!redis || !userId) return;
  try {
    const date = todayUTC();
    const pipe = redis.pipeline();

    // Update user's subscription record
    const record = JSON.stringify({
      clientReportedPlan, event, source, at: Date.now(),
      trusted: false, entitlement: false, verifiedPlan: null, verifiedAt: null,
    });
    pipe.set(KEY_SUB(userId), record, "EX", SUB_TTL);

    // Global aggregate
    const aggKey = KEY_AGG(date);
    pipe.hincrby(aggKey, `sub_${event || "unknown"}`, 1);
    pipe.expire(aggKey, EVENT_TTL);

    // Raw event stream
    const ev = JSON.stringify({
      t: "subscription", uid: userId, event, clientReportedPlan, source, at: Date.now(),
    });
    pipe.lpush(KEY_DAILY(date), ev);
    pipe.ltrim(KEY_DAILY(date), 0, MAX_EVENTS_PER_DAY - 1);
    pipe.expire(KEY_DAILY(date), EVENT_TTL);

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Reading ────────────────────────────────────────────────────────────────────

/**
 * Get per-user attribution stats over N days.
 * Returns { scans, clicks, subscription } keyed by date.
 */
export async function getUserAttributionStats(redis, userId, { days = 30 } = {}) {
  if (!redis || !userId) return null;
  try {
    const dates = buildDateKeys(days);
    const [subRaw, ...pairs] = await Promise.all([
      redis.get(KEY_SUB(userId)).catch(() => null),
      ...dates.map((d) => Promise.all([
        redis.hgetall(KEY_SCAN(userId, d)).catch(() => null),
        redis.hgetall(KEY_CLICK(userId, d)).catch(() => null),
      ])),
    ]);

    const result = { scans: {}, clicks: {}, subscription: null };
    if (subRaw) {
      try { result.subscription = JSON.parse(subRaw); } catch { /* ignore */ }
    }
    for (let i = 0; i < dates.length; i++) {
      const [scanHash, clickHash] = pairs[i];
      if (scanHash  && Object.keys(scanHash).length  > 0) result.scans[dates[i]]  = scanHash;
      if (clickHash && Object.keys(clickHash).length > 0) result.clicks[dates[i]] = clickHash;
    }
    return result;
  } catch { return null; }
}

/**
 * Get global daily aggregate stats across all users.
 * Returns array of { date, ...counts } for the last N days.
 */
export async function getGlobalAttributionStats(redis, { days = 7 } = {}) {
  if (!redis) return [];
  try {
    const dates = buildDateKeys(days);
    const hashes = await Promise.all(
      dates.map((d) => redis.hgetall(KEY_AGG(d)).catch(() => null))
    );
    return dates.map((date, i) => ({
      date,
      ...(hashes[i] ? Object.fromEntries(
        Object.entries(hashes[i]).map(([k, v]) => [k, Number(v) || 0])
      ) : {}),
    }));
  } catch { return []; }
}

/**
 * Get recent raw events for a specific day (ops use).
 * Returns up to `limit` most-recent events.
 */
export async function getDailyEvents(redis, { date = null, limit = 100 } = {}) {
  if (!redis) return [];
  try {
    const d = date || todayUTC();
    const raw = await redis.lrange(KEY_DAILY(d), 0, limit - 1);
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
