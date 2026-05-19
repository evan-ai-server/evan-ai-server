// src/outcomeLearning.js
// Outcome-Trained Intelligence — learns from real buy/sell outcomes to bias
// future decisions. Accumulates per-category and per-query outcome priors.
// Redis-backed. Cheap to read (HGET), cheap to write (HINCRBYFLOAT).

// ── Redis key schema ──────────────────────────────────────────────────────────
// outcome_learn:cat:{userId}        HASH  — category-level priors
//   fields: {cat}:scans, {cat}:buys, {cat}:sells, {cat}:profitCents, {cat}:wins, {cat}:losses
// outcome_learn:query:{userId}      HASH  — query-level priors (normalized query hash)
//   fields: {qhash}:scans, {qhash}:wins, {qhash}:losses, {qhash}:profitCents
// outcome_learn:aff:{userId}        HASH  — category affinity scores (float 0–1)
//   fields: {cat}:affinity, {cat}:updatedAt

const KEY_CAT   = (uid) => `outcome_learn:cat:${uid}`;
const KEY_QUERY = (uid) => `outcome_learn:query:${uid}`;
const KEY_AFF   = (uid) => `outcome_learn:aff:${uid}`;

const CAT_TTL   = 365 * 86400;  // 1 year
const QUERY_TTL = 180 * 86400;  // 6 months

// ── Record Outcome ────────────────────────────────────────────────────────────

/**
 * Record a buy/sell outcome into the learning system.
 * Called after buy-outcome is confirmed.
 *
 * @param {object} params
 *   category     — item category (string)
 *   query        — search query used (string|null)
 *   didBuy       — boolean
 *   profitCents  — realized profit in cents (may be negative, null if not sold)
 *   didSell      — boolean
 */
export async function recordOutcomeLearning(redis, userId, {
  category    = "",
  query       = null,
  didBuy      = false,
  profitCents = null,  // cents, signed
  didSell     = false,
  buySignal   = null,  // legacy "STRONG BUY" / "GOOD DEAL" / "FAIR" / etc
  verdict     = null,  // canonical "BUY" | "HOLD" | "PASS" — Phase 2 boundary
}) {
  if (!redis || !userId) return;

  const cat    = sanitizeCat(category);
  const profit = (profitCents != null && Number.isFinite(Number(profitCents)))
    ? Math.round(Number(profitCents))
    : null;

  const catKey  = KEY_CAT(userId);
  const catPipe = redis.pipeline();

  catPipe.hincrby(catKey, `${cat}:scans`, 1);
  if (didBuy)  catPipe.hincrby(catKey, `${cat}:buys`, 1);
  if (didSell) catPipe.hincrby(catKey, `${cat}:sells`, 1);

  if (profit !== null) {
    catPipe.hincrbyfloat(catKey, `${cat}:profitCents`, profit);
    if (profit > 0)  catPipe.hincrby(catKey, `${cat}:wins`, 1);
    if (profit <= 0) catPipe.hincrby(catKey, `${cat}:losses`, 1);
  }
  catPipe.expire(catKey, CAT_TTL);
  await catPipe.exec();

  // Update affinity
  await refreshCategoryAffinity(redis, userId, cat);

  // Query-level tracking
  if (query) {
    const qhash = hashQuery(query);
    const qKey  = KEY_QUERY(userId);
    const qPipe = redis.pipeline();
    qPipe.hincrby(qKey, `${qhash}:scans`, 1);
    if (profit !== null) {
      qPipe.hincrbyfloat(qKey, `${qhash}:profitCents`, profit);
      if (profit > 0)  qPipe.hincrby(qKey, `${qhash}:wins`, 1);
      if (profit <= 0) qPipe.hincrby(qKey, `${qhash}:losses`, 1);
    }
    // Store the canonical query so we can surface it later
    qPipe.hset(qKey, `${qhash}:query`, query.slice(0, 200));
    qPipe.expire(qKey, QUERY_TTL);
    await qPipe.exec();
  }
}

/**
 * Get category-level outcome priors for a user.
 * Returns sorted list: [{ category, scans, buys, sells, wins, losses, profitCents, affinityScore }]
 */
export async function getCategoryOutcomePrior(redis, userId) {
  if (!redis || !userId) return [];
  try {
    const [catRaw, affRaw] = await Promise.all([
      redis.hgetall(KEY_CAT(userId)),
      redis.hgetall(KEY_AFF(userId)),
    ]);
    if (!catRaw) return [];

    const cats = new Map();
    for (const [field, val] of Object.entries(catRaw)) {
      const [cat, metric] = splitFirst(field);
      if (!cat || !metric) continue;
      if (!cats.has(cat)) cats.set(cat, { category: cat, scans: 0, buys: 0, sells: 0, wins: 0, losses: 0, profitCents: 0 });
      const entry = cats.get(cat);
      if (metric === "scans")       entry.scans       += Number(val) || 0;
      if (metric === "buys")        entry.buys         = Number(val) || 0;
      if (metric === "sells")       entry.sells        = Number(val) || 0;
      if (metric === "wins")        entry.wins         = Number(val) || 0;
      if (metric === "losses")      entry.losses       = Number(val) || 0;
      if (metric === "profitCents") entry.profitCents  = Number(val) || 0;
    }

    return [...cats.values()].map((entry) => {
      const affScore = Number(affRaw?.[`${entry.category}:affinity`] || 0);
      const hitRate  = entry.sells > 0 ? round2((entry.wins / entry.sells) * 100) : null;
      return { ...entry, affinityScore: round2(affScore), hitRate };
    }).sort((a, b) => b.profitCents - a.profitCents);
  } catch {
    return [];
  }
}

/**
 * Get query-level outcome priors.
 * Returns list of { query, scans, wins, losses, profitCents }
 */
export async function getQueryOutcomePrior(redis, userId, limit = 20) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.hgetall(KEY_QUERY(userId));
    if (!raw) return [];

    const queries = new Map();
    for (const [field, val] of Object.entries(raw)) {
      const [qhash, metric] = splitFirst(field);
      if (!qhash || !metric) continue;
      if (!queries.has(qhash)) queries.set(qhash, { qhash, query: null, scans: 0, wins: 0, losses: 0, profitCents: 0 });
      const entry = queries.get(qhash);
      if (metric === "query")       entry.query        = String(val).slice(0, 200);
      if (metric === "scans")       entry.scans        = Number(val) || 0;
      if (metric === "wins")        entry.wins         = Number(val) || 0;
      if (metric === "losses")      entry.losses       = Number(val) || 0;
      if (metric === "profitCents") entry.profitCents  = Number(val) || 0;
    }

    return [...queries.values()]
      .filter((q) => q.query)
      .sort((a, b) => b.profitCents - a.profitCents)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get category affinity scores for a user.
 * Returns: [{ category, affinityScore }] sorted desc.
 */
export async function getUserCategoryAffinity(redis, userId) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.hgetall(KEY_AFF(userId));
    if (!raw) return [];

    const affinities = [];
    for (const [field, val] of Object.entries(raw)) {
      if (!field.endsWith(":affinity")) continue;
      const cat = field.replace(/:affinity$/, "");
      affinities.push({ category: cat, affinityScore: round2(Number(val) || 0) });
    }
    return affinities.sort((a, b) => b.affinityScore - a.affinityScore);
  } catch {
    return [];
  }
}

/**
 * Apply outcome biases to a profit intel object.
 * Adjusts buy signal interpretation based on the user's track record.
 *
 * @returns {{ biasedBuySignal, biasNote, originalBuySignal }}
 */
export function applyOutcomeBiasesToDecision({
  buySignal         = null,
  category          = "",
  categoryPrior     = null,  // { wins, losses, profitCents, affinityScore } or null
  userHitRate       = null,
}) {
  if (!buySignal) return { biasedBuySignal: buySignal, biasNote: null, originalBuySignal: buySignal };

  let biasedBuySignal = buySignal;
  let biasNote        = null;

  // If user has a bad track record in this category → downgrade GOOD DEAL to FAIR
  if (categoryPrior && buySignal === "GOOD DEAL") {
    const catLosses = categoryPrior.losses || 0;
    const catWins   = categoryPrior.wins   || 0;
    const total     = catWins + catLosses;
    if (total >= 3 && catLosses > catWins) {
      biasedBuySignal = "FAIR";
      biasNote = `Your track record in ${sanitizeCat(category)} is below 50% — Evan is being extra cautious`;
    }
  }

  // If user has a very good track record → bump FAIR to GOOD DEAL
  if (categoryPrior && buySignal === "FAIR" && (userHitRate || 0) >= 72) {
    const catWins   = categoryPrior.wins   || 0;
    const catLosses = categoryPrior.losses || 0;
    const total     = catWins + catLosses;
    if (total >= 5 && catWins / total >= 0.70) {
      biasedBuySignal = "GOOD DEAL";
      biasNote = `Your track record in ${sanitizeCat(category)} is strong — Evan upgraded the signal`;
    }
  }

  // Very poor global hit rate → cap GOOD DEAL (but not STRONG BUY)
  if (buySignal === "GOOD DEAL" && userHitRate !== null && userHitRate < 30) {
    biasedBuySignal = "FAIR";
    biasNote = `Global hit rate (${userHitRate}%) is low — Evan is being conservative`;
  }

  return { biasedBuySignal, biasNote, originalBuySignal: buySignal };
}

// ── Bracket adjustment from outcome priors ────────────────────────────────────
//
// Translates a user's track record in a category into a signed pct shift that
// dealComparator applies to the bracket median. Direction:
//
//   winRate < 0.45 → negative shift → bracket median moves DOWN → the scan
//     looks RELATIVELY more expensive vs the bracket → verdict skews toward
//     HOLD / PASS. Rationale: this user loses money here, don't egg them on.
//
//   winRate > 0.65 → positive shift → bracket median moves UP → scan looks
//     RELATIVELY cheaper → verdict skews toward BUY. Rationale: this user
//     wins consistently here, trust the instinct.
//
//   0.45 ≤ winRate ≤ 0.65 → no shift (the "you're in the noise" middle).
//
// Sample dampening: the raw pct is multiplied by confidence = min(1, samples/20).
// 5 samples = 25% strength, 20+ samples = full strength. Below 5 samples we
// return 0 outright — not enough data to bias anything.
//
// @param prior — entry from getCategoryOutcomePrior(), or null
// @returns { pct, samples, confidence, reason }
export function computeBracketAdjustmentFromPrior(prior, {
  minSamples  = 5,
  maxShiftPct = 15,
  lowerBound  = 0.45,
  upperBound  = 0.65,
  fullConfAt  = 20,
} = {}) {
  if (!prior) {
    return { pct: 0, samples: 0, confidence: 0, reason: "no_prior" };
  }

  const wins      = Number(prior.wins)   || 0;
  const losses    = Number(prior.losses) || 0;
  const decisions = wins + losses;

  if (decisions < minSamples) {
    return { pct: 0, samples: decisions, confidence: 0, reason: "insufficient_samples" };
  }

  const winRate = wins / decisions;
  let rawPct = 0;
  let reason = "neutral";

  if (winRate < lowerBound) {
    rawPct = -((lowerBound - winRate) / lowerBound) * maxShiftPct;
    reason = "losing_category_tighten";
  } else if (winRate > upperBound) {
    rawPct = ((winRate - upperBound) / (1 - upperBound)) * maxShiftPct;
    reason = "winning_category_loosen";
  }

  // Sample-aware dampening
  const confidence = Math.min(1, decisions / fullConfAt);
  const damped     = rawPct * confidence;

  // Clamp
  const clamped = Math.max(-maxShiftPct, Math.min(maxShiftPct, damped));

  return {
    pct:        round2(clamped),
    samples:    decisions,
    confidence: round2(confidence),
    reason,
  };
}

// ── Affinity Refresh ──────────────────────────────────────────────────────────

// ── Return outcome recording ──────────────────────────────────────────────────

/**
 * Record whether a sold item was returned by the buyer.
 * Used to build empirical return rate data per category.
 *
 * Call from /scan/buy-outcome when didReturn is provided.
 */
export async function recordReturnOutcome(redis, userId, { category = "", didReturn = false } = {}) {
  if (!redis || !userId) return;
  const cat    = sanitizeCat(category);
  const catKey = KEY_CAT(userId);
  const pipe   = redis.pipeline();
  pipe.hincrby(catKey, `${cat}:return_attempts`, 1);
  if (didReturn) pipe.hincrby(catKey, `${cat}:returns`, 1);
  pipe.expire(catKey, CAT_TTL);
  await pipe.exec().catch(() => {});
}

async function refreshCategoryAffinity(redis, userId, cat) {
  try {
    const catKey = KEY_CAT(userId);
    const raw    = await redis.hmget(
      catKey,
      `${cat}:scans`, `${cat}:buys`, `${cat}:wins`, `${cat}:losses`, `${cat}:profitCents`,
    );

    const scans       = Number(raw[0]) || 0;
    const buys        = Number(raw[1]) || 0;
    const wins        = Number(raw[2]) || 0;
    const losses      = Number(raw[3]) || 0;
    const profitCents = Number(raw[4]) || 0;

    // Affinity formula: mix of engagement (scans+buys) and profitability
    const engagementScore = Math.min(1, (scans + buys * 2) / 20);
    const profitScore     = profitCents > 0 ? Math.min(1, profitCents / 10000) : 0;
    const hitRateScore    = (wins + losses) > 0 ? wins / (wins + losses) : 0.5;
    const affinity        = round2(engagementScore * 0.4 + profitScore * 0.35 + hitRateScore * 0.25);

    const affKey = KEY_AFF(userId);
    await redis.hset(affKey, `${cat}:affinity`, String(affinity), `${cat}:updatedAt`, String(Date.now()));
    await redis.expire(affKey, CAT_TTL);
  } catch {
    // non-fatal
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeCat(cat) {
  return String(cat || "general").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
}

function hashQuery(query) {
  // Simple stable hash — not cryptographic, just for field namespacing
  let h = 0;
  const s = String(query || "").toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return `q${(h >>> 0).toString(36)}`;
}

function splitFirst(str) {
  const idx = str.lastIndexOf(":");
  if (idx === -1) return [str, null];
  return [str.slice(0, idx), str.slice(idx + 1)];
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
