// src/userDecisionProfile.js
// Learned Per-User Decision Profile.
//
// Distinct from personalAgent.js (which takes signals and outputs one action)
// and outcomeLearning.js (which tracks raw outcome counts).
//
// This file synthesizes ALL available user data into a single evolved behavioral
// profile that answers: "who is this user as a buyer, and what rules should Evan
// follow specifically for them?"
//
// Outputs personalized:
//   - risk tolerance (0–1, learned not assumed)
//   - price point sweet spot (where they win)
//   - failure fingerprints (conditions to avoid for this user)
//   - personalized signal thresholds (override generic dealStrength gates)
//   - momentum score (improving or degrading over time)
//   - behavioral mode (GROW / PROTECT / EXPLOIT)
//
// Redis key schema:
//   udp:{userId}   STRING  — full profile JSON, cached 6h
//   udp:pt:{userId} HASH   — price tier stats (rolling 90 days)
//     fields: {tier}:buys, {tier}:wins, {tier}:profitCents
//   udp:fp:{userId} HASH   — failure pattern tally
//     fields: {fpKey}:count  (failure fingerprint occurrences)

const KEY_PROFILE   = (uid) => `udp:${uid}`;
const KEY_PRICE_TIER = (uid) => `udp:pt:${uid}`;
const KEY_FAIL_FP   = (uid) => `udp:fp:${uid}`;

const PROFILE_TTL   = 6  * 3600;   // recompute every 6h
const PRICE_TIER_TTL = 90 * 86400; // 90 days rolling
const FAIL_FP_TTL   = 60 * 86400;  // 60 days

// ── Price tier buckets ────────────────────────────────────────────────────────
const PRICE_TIERS = [
  { key: "micro",  label: "Under $25",    min: 0,   max: 25  },
  { key: "low",    label: "$25–$75",      min: 25,  max: 75  },
  { key: "mid",    label: "$75–$150",     min: 75,  max: 150 },
  { key: "upper",  label: "$150–$300",    min: 150, max: 300 },
  { key: "high",   label: "$300–$600",    min: 300, max: 600 },
  { key: "luxury", label: "Over $600",    min: 600, max: Infinity },
];

// ── Behavioral mode thresholds ────────────────────────────────────────────────
// GROW:    new user or improving — use standard thresholds, encourage action
// PROTECT: losing money — tighten thresholds, restrict to STRONG BUY only
// EXPLOIT: profitable, consistent — loosen thresholds, maximize opportunity count
const BEHAVIORAL_MODES = {
  GROW:    { dealStrengthFloor: 0.20, minConfidence: 0.55, allowGoodDeal: true,  label: "Building your track record" },
  PROTECT: { dealStrengthFloor: 0.30, minConfidence: 0.70, allowGoodDeal: false, label: "Protecting your capital" },
  EXPLOIT: { dealStrengthFloor: 0.15, minConfidence: 0.50, allowGoodDeal: true,  label: "Maximizing opportunities" },
};

// ── Record a price-tier outcome ───────────────────────────────────────────────

/**
 * Record buy/sell outcome by price tier.
 * Called alongside recordOutcomeLearning.
 */
export async function recordPriceTierOutcome(redis, userId, {
  buyPrice    = null,
  profitCents = null,
  didSell     = false,
}) {
  if (!redis || !userId) return;
  const price = Number(buyPrice);
  if (!Number.isFinite(price) || price <= 0) return;

  const tier = PRICE_TIERS.find((t) => price >= t.min && price < t.max) || PRICE_TIERS[PRICE_TIERS.length - 1];
  const key  = KEY_PRICE_TIER(userId);
  const pipe = redis.pipeline();

  pipe.hincrby(key, `${tier.key}:buys`, 1);
  if (didSell && profitCents != null) {
    pipe.hincrbyfloat(key, `${tier.key}:profitCents`, Math.round(Number(profitCents)));
    if (Number(profitCents) > 0) pipe.hincrby(key, `${tier.key}:wins`, 1);
  }
  pipe.expire(key, PRICE_TIER_TTL);
  await pipe.exec().catch(() => {});
}

/**
 * Record a failure fingerprint.
 * Failure FP = conditions present when user lost money.
 * Examples: "thin_market+good_deal", "high_price+low_confidence", "no_brand+strong_buy"
 */
export async function recordFailureFingerprint(redis, userId, {
  buySignal      = null,
  depthTier      = null,
  confidenceV2   = null,
  priceRange     = null,
  category       = null,
}) {
  if (!redis || !userId) return;

  const parts = [];
  if (depthTier === "THIN" || depthTier === "INSUFFICIENT") parts.push("thin_mkt");
  if (buySignal === "GOOD DEAL") parts.push("good_deal");
  if (buySignal === "STRONG BUY") parts.push("strong_buy");
  if (confidenceV2 != null && Number(confidenceV2) < 0.55) parts.push("low_conf");
  if (priceRange) parts.push(priceRange);
  if (category) parts.push(String(category).toLowerCase().slice(0, 20).replace(/\s+/g, "_"));

  if (!parts.length) return;
  const fpKey = parts.sort().join("+");

  const key = KEY_FAIL_FP(userId);
  await redis.hincrby(key, `${fpKey}:count`, 1).catch(() => {});
  await redis.expire(key, FAIL_FP_TTL).catch(() => {});
}

// ── Build decision profile ────────────────────────────────────────────────────

/**
 * Build the full personalized decision profile for a user.
 *
 * @param {object} inputs
 *   categoryPriors    — from getCategoryOutcomePrior()
 *   accuracyProfile   — from computeAccuracyProfile()
 *   portfolioPerf     — from getPortfolioPerformance()
 *   categoryAffinities — from getUserCategoryAffinity()
 *   portfolioCount    — number of items currently held
 *
 * @returns {UserDecisionProfile}
 */
export function buildUserDecisionProfile({
  categoryPriors    = [],
  accuracyProfile   = null,
  portfolioPerf     = null,
  categoryAffinities = [],
  priceTierStats    = {},
  failureFingerprints = {},
  portfolioCount    = 0,
}) {
  // ── Risk tolerance ────────────────────────────────────────────────────────
  const hitRate      = portfolioPerf?.hitRate ?? null;
  const totalSells   = categoryPriors.reduce((s, c) => s + (c.sells || 0), 0);
  const totalWins    = categoryPriors.reduce((s, c) => s + (c.wins  || 0), 0);
  const totalBuys    = categoryPriors.reduce((s, c) => s + (c.buys  || 0), 0);
  const totalProfit  = categoryPriors.reduce((s, c) => s + (c.profitCents || 0), 0);

  // Risk tolerance: 0 = very cautious, 1 = very aggressive
  let riskTolerance = 0.5; // default: balanced
  if (hitRate !== null) {
    if (hitRate >= 75)      riskTolerance = Math.min(0.90, 0.5 + (hitRate - 50) / 100);
    else if (hitRate < 40)  riskTolerance = Math.max(0.10, hitRate / 100);
    else                    riskTolerance = 0.40 + (hitRate - 40) / 100;
  }

  // ── Price tier sweet spot ─────────────────────────────────────────────────
  const tierStats = buildPriceTierBreakdown(priceTierStats);
  const sweetSpot = findPriceSweetSpot(tierStats);

  // ── Failure fingerprints ──────────────────────────────────────────────────
  const topFailures = buildTopFailures(failureFingerprints);

  // ── Winning categories ────────────────────────────────────────────────────
  const winningCats = categoryPriors
    .filter((c) => c.sells >= 2 && c.wins > c.losses)
    .sort((a, b) => (b.wins / Math.max(b.sells, 1)) - (a.wins / Math.max(a.sells, 1)))
    .slice(0, 3)
    .map((c) => ({ category: c.category, hitRate: c.hitRate, profitCents: c.profitCents }));

  const losingCats = categoryPriors
    .filter((c) => c.sells >= 2 && c.losses > c.wins)
    .sort((a, b) => (b.losses / Math.max(b.sells, 1)) - (a.losses / Math.max(a.sells, 1)))
    .slice(0, 3)
    .map((c) => ({ category: c.category, hitRate: c.hitRate }));

  // ── Behavioral mode ───────────────────────────────────────────────────────
  const isNewUser   = totalBuys < 3;
  const isLosing    = hitRate !== null && hitRate < 38;
  const isProfitable = hitRate !== null && hitRate >= 68 && totalProfit > 0;

  const mode = isNewUser    ? "GROW"
             : isLosing     ? "PROTECT"
             : isProfitable ? "EXPLOIT"
             : "GROW";

  const thresholds = BEHAVIORAL_MODES[mode];

  // ── Personalized signal thresholds ───────────────────────────────────────
  // Adjust generic gates based on this user's track record
  const personalizedGates = {
    // Minimum dealStrength to act on GOOD DEAL
    goodDealMinStrength:   round2(thresholds.dealStrengthFloor + (riskTolerance < 0.4 ? 0.08 : 0)),
    // Minimum confidence to trust a scan
    minConfidence:         thresholds.minConfidence,
    // Whether GOOD DEAL is allowed (PROTECT mode = STRONG BUY only)
    allowGoodDeal:         thresholds.allowGoodDeal,
    // Minimum comps before acting (beyond system gate)
    minCompsToAct:         mode === "PROTECT" ? 25 : 15,
    // Max price point to act (based on sweet spot + risk tolerance)
    maxActionPrice:        sweetSpot?.upperBound ?? null,
  };

  // ── Momentum ──────────────────────────────────────────────────────────────
  const correctedAccuracy = accuracyProfile?.overallAccuracy ?? null;
  const reportedAccuracy  = accuracyProfile?.reportedAccuracy ?? null;
  const momentum          = correctedAccuracy != null && reportedAccuracy != null
    ? correctedAccuracy >= 60 ? "IMPROVING"
    : correctedAccuracy >= 45 ? "STABLE"
    : "DECLINING"
    : null;

  // ── Advice ────────────────────────────────────────────────────────────────
  const advice = buildPersonalizedAdvice({
    mode, hitRate, winningCats, losingCats, sweetSpot, topFailures,
    portfolioCount, totalBuys, totalProfit,
  });

  return {
    mode,
    modeLabel:            BEHAVIORAL_MODES[mode].label,
    riskTolerance:        round2(riskTolerance),
    hitRate,
    totalBuys,
    totalSells,
    totalProfit:          round2(totalProfit / 100), // dollars
    winningCategories:    winningCats,
    losingCategories:     losingCats,
    sweetSpot,
    topFailurePatterns:   topFailures,
    personalizedGates,
    momentum,
    correctedAccuracy,
    portfolioCount,
    isNewUser,
    advice,
    generatedAt:          Date.now(),
  };
}

/**
 * Load raw price tier and failure fingerprint data from Redis.
 * Call before buildUserDecisionProfile.
 */
export async function loadUserProfileData(redis, userId) {
  if (!redis || !userId) return { priceTierStats: {}, failureFingerprints: {} };
  try {
    const [ptRaw, fpRaw] = await Promise.all([
      redis.hgetall(KEY_PRICE_TIER(userId)),
      redis.hgetall(KEY_FAIL_FP(userId)),
    ]);
    return {
      priceTierStats:      ptRaw || {},
      failureFingerprints: fpRaw || {},
    };
  } catch {
    return { priceTierStats: {}, failureFingerprints: {} };
  }
}

/**
 * Cache and retrieve full decision profile.
 */
export async function getCachedDecisionProfile(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(KEY_PROFILE(userId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function cacheDecisionProfile(redis, userId, profile) {
  if (!redis || !userId || !profile) return;
  await redis.set(KEY_PROFILE(userId), JSON.stringify(profile), "EX", PROFILE_TTL).catch(() => {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPriceTierBreakdown(raw = {}) {
  return PRICE_TIERS.map((tier) => {
    const buys        = Number(raw[`${tier.key}:buys`]        || 0);
    const wins        = Number(raw[`${tier.key}:wins`]        || 0);
    const profitCents = Number(raw[`${tier.key}:profitCents`] || 0);
    const hitRate     = buys > 0 ? round2((wins / buys) * 100) : null;
    return { ...tier, buys, wins, profitCents, hitRate };
  }).filter((t) => t.buys > 0);
}

function findPriceSweetSpot(tierStats = []) {
  // Sweet spot: price tier with most wins + highest hitRate
  if (!tierStats.length) return null;
  const ranked = tierStats
    .filter((t) => t.wins >= 1)
    .sort((a, b) => {
      const hitA = a.hitRate ?? 0;
      const hitB = b.hitRate ?? 0;
      return (hitB * b.wins) - (hitA * a.wins); // weighted by volume
    });
  if (!ranked.length) return null;
  const top = ranked[0];
  return {
    tier:       top.key,
    label:      top.label,
    lowerBound: top.min,
    upperBound: top.max === Infinity ? null : top.max,
    hitRate:    top.hitRate,
    wins:       top.wins,
  };
}

function buildTopFailures(raw = {}) {
  const entries = Object.entries(raw)
    .filter(([k]) => k.endsWith(":count"))
    .map(([k, v]) => ({ pattern: k.replace(/:count$/, ""), count: Number(v) || 0 }))
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return entries;
}

function buildPersonalizedAdvice({
  mode, hitRate, winningCats, losingCats, sweetSpot, topFailures,
  portfolioCount, totalBuys, totalProfit,
}) {
  const advice = [];

  if (totalBuys === 0) {
    advice.push("Make your first scan to start building your personal track record.");
    return advice;
  }

  if (mode === "PROTECT") {
    advice.push(`Hit rate (${hitRate?.toFixed(0)}%) is below threshold — Evan is restricting you to STRONG BUY signals only.`);
    if (losingCats.length > 0) advice.push(`Avoid ${losingCats[0].category} until your track record improves there.`);
  }

  if (mode === "EXPLOIT") {
    advice.push(`${hitRate?.toFixed(0)}% hit rate — you're in exploit mode. Evan will find you more opportunities.`);
    if (winningCats.length > 0) advice.push(`Double down on ${winningCats[0].category} — your best category.`);
  }

  if (sweetSpot) {
    advice.push(`Your price sweet spot is ${sweetSpot.label} (${sweetSpot.hitRate?.toFixed(0)}% win rate) — prioritize these.`);
  }

  if (topFailures.length > 0 && topFailures[0].count >= 3) {
    const fp = topFailures[0].pattern.replace(/_/g, " ").replace(/\+/g, " + ");
    advice.push(`Pattern to avoid: ${fp} — you've lost on this combination ${topFailures[0].count} times.`);
  }

  if (totalProfit > 0) {
    advice.push(`$${(totalProfit / 100).toFixed(0)} realized profit — reinvest in categories with >60% hit rate.`);
  }

  if (portfolioCount >= 5) {
    advice.push(`${portfolioCount} items holding — focus on selling before buying more.`);
  }

  return advice;
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
