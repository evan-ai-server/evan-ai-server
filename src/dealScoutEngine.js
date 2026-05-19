// src/dealScoutEngine.js
// Deal Scout — generates 3–5 personalized buy targets for a user.
//
// Scout targets are NOT generic category filler.
// Each target is selected based on:
//   1. Categories where user has >= LEARNING mastery (proven pattern)
//   2. Current live opportunities with score >= 55 in those categories
//   3. Capital availability (skip if user is capital-locked)
//   4. Seasonal timing (use priceHistoryIntelligence to avoid bad windows)
//   5. Price range calibrated to user's historical sweet spot
//
// Returns exactly 3–5 targets with WHY this item, WHY now, WHAT price to aim for.
//
// Redis keys:
//   scout:snapshot:{userId}  STRING  — latest scout result (3h TTL)
//   scout:seen:{userId}      SET     — fingerprints recently surfaced (24h TTL)

import { getSeasonalPricePosition } from "./priceHistoryIntelligence.js";

const KEY_SCOUT_SNAPSHOT = (uid) => `scout:snapshot:${uid}`;
const KEY_SCOUT_SEEN     = (uid) => `scout:seen:${uid}`;

const SNAPSHOT_TTL = 3  * 3600;   // 3h
const SEEN_TTL     = 24 * 3600;   // 24h dedup window
const MIN_OPP_SCORE = 55;         // minimum opportunity score to consider
const MIN_MASTERY_LEVELS = new Set(["LEARNING", "COMPETENT", "EXPERT"]);
const TARGET_COUNT_MIN = 3;
const TARGET_COUNT_MAX = 5;

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Score a discovery opportunity as a scout candidate for a specific user.
 *
 * Higher score = better personalized fit.
 * Base: opportunity score (0–100)
 * Modifiers:
 *   +20 if user has EXPERT mastery in this category
 *   +10 if user has COMPETENT mastery
 *   +5  if user has LEARNING mastery
 *   +15 if price is within user's historical sweet spot
 *   +10 if category is user's top category
 *   −20 if seasonal timing is BAD (at seasonal peak, wait recommended)
 *   −10 if item is already in user's seen set
 *
 * @param {object} opp             — discovery opportunity
 * @param {object} userCtx         — { masteryMap, topCategories, priceSweet, seenFps }
 * @returns {{ score, reasons }}
 */
export function scoreScoutCandidate(opp, userCtx = {}) {
  const { masteryMap = new Map(), topCategories = [], priceSweet = null, seenFps = new Set() } = userCtx;

  let score   = opp.opportunityScore || 0;
  const reasons = [];

  const cat = String(opp?.category || "").toLowerCase().trim();

  // Mastery modifier
  const mastery = masteryMap.get(cat);
  if (mastery?.masteryLevel === "EXPERT") {
    score += 20;
    reasons.push(`Expert track record in ${cat}`);
  } else if (mastery?.masteryLevel === "COMPETENT") {
    score += 10;
    reasons.push(`Good track record in ${cat}`);
  } else if (mastery?.masteryLevel === "LEARNING") {
    score += 5;
    reasons.push(`Developing track record in ${cat}`);
  }

  // Top category bonus
  if (topCategories[0] === cat) {
    score += 10;
    reasons.push(`Your top category`);
  } else if (topCategories.includes(cat)) {
    score += 5;
  }

  // Price range fit
  if (priceSweet && opp.priceStats?.median) {
    const median = opp.priceStats.median;
    const inRange = median >= priceSweet.min * 0.80 && median <= priceSweet.max * 1.20;
    if (inRange) {
      score += 15;
      reasons.push(`Price fits your typical range ($${Math.round(priceSweet.min)}–$${Math.round(priceSweet.max)})`);
    }
  }

  // Seen recently — devalue
  if (seenFps.has(opp.fingerprint)) score -= 10;

  return { score: Math.min(100, Math.round(score)), reasons };
}

/**
 * Apply capital availability filter.
 * If user has CRITICAL capital lock, remove all targets above $50.
 * If HIGH capital lock, remove targets above $150.
 *
 * @param {Array}  candidates
 * @param {object} capitalBlock — from buildCapitalBlockSignal (may be null)
 * @returns {Array} filtered candidates
 */
export function applyCapitalFilter(candidates, capitalBlock) {
  if (!capitalBlock?.shouldBlock) return candidates;

  const capLimit = capitalBlock.urgencyLevel === "CRITICAL" ? 50 : 150;
  return candidates.filter(c => {
    const price = c.opp?.priceStats?.median ?? Infinity;
    return price <= capLimit;
  });
}

/**
 * Apply seasonal timing filter.
 * Removes targets where seasonal analysis says "wait" (at seasonal peak).
 *
 * @param {Array} candidates — array of { opp, score, reasons }
 * @returns {Array} filtered (items at bad seasonal windows are removed or penalized)
 */
export function applyTimingFilter(candidates) {
  return candidates.map(c => {
    const cat = String(c.opp?.category || "").toLowerCase().trim();
    try {
      const seasonal = getSeasonalPricePosition(cat);
      if (seasonal?.buySignal === "WAIT" && seasonal?.position === "at_peak") {
        // Don't fully remove — reduce score and add context
        return { ...c, score: Math.max(0, c.score - 15), reasons: [...c.reasons, `Seasonal peak for ${cat} — may dip soon`] };
      }
      if (seasonal?.buySignal === "BUY_NOW") {
        return { ...c, score: Math.min(100, c.score + 8), reasons: [...c.reasons, `Seasonal low for ${cat}`] };
      }
    } catch { /* priceHistoryIntelligence returns null for unknown categories */ }
    return c;
  });
}

// ── Scout target builder ──────────────────────────────────────────────────────

/**
 * Build a single scout target card for the feed.
 *
 * @param {object} opp     — discovery opportunity
 * @param {number} rank    — 1-based rank in the scout list
 * @param {Array}  reasons — personalization reasons from scoring
 * @returns {object} scout card
 */
export function buildScoutCard(opp, rank, reasons = []) {
  const name = [opp.brand, opp.model].filter(Boolean).join(" ") || opp.query || opp.category || "Item";
  const priceTarget = opp.priceStats?.low
    ? round2(opp.priceStats.low * 0.95)  // target slightly below market low
    : opp.priceStats?.median
      ? round2(opp.priceStats.median * 0.90)
      : null;

  const signalLabel = opp.buySignal === "STRONG BUY" ? "Strong buy zone"
    : opp.buySignal === "GOOD DEAL" ? "Good deal zone" : null;

  const whyNow = reasons.slice(0, 2).join(" · ") || `Active market in ${opp.category || "this category"}`;

  return {
    scoutId:         `scout_${opp.fingerprint || Date.now()}_${rank}`,
    dedupeKey:       `scout_${opp.fingerprint || opp.query}_${rank}`,
    rank,
    query:           opp.query,
    category:        opp.category,
    brand:           opp.brand || null,
    model:           opp.model || null,
    fingerprint:     opp.fingerprint || null,
    buySignal:       opp.buySignal,
    signalLabel,
    opportunityScore: opp.opportunityScore,
    priceTarget,
    priceStats:      opp.priceStats || null,
    listingCount:    opp.listingCount || null,
    bestListing:     opp.bestListing || null,
    whyThisItem:     whyNow,
    whyNow:          signalLabel || "Conditions align",
    whatToDo:        `Search for "${opp.query}" — aim for $${priceTarget?.toFixed(0) ?? "below median"}`,
    reasoning:       opp.reasoning || null,
    freshListingCount: opp.freshListingCount || null,
    generatedAt:     Date.now(),
  };
}

// ── Snapshot storage ──────────────────────────────────────────────────────────

/**
 * Store a scout snapshot for a user.
 */
export async function storeScoutSnapshot(redis, userId, targets) {
  if (!redis || !userId || !targets?.length) return;
  const snap = { userId, targets, generatedAt: Date.now() };
  await redis.set(KEY_SCOUT_SNAPSHOT(userId), JSON.stringify(snap), "EX", SNAPSHOT_TTL).catch(() => {});
}

/**
 * Load the latest scout snapshot for a user.
 * @returns {{ targets, generatedAt } | null}
 */
export async function loadScoutSnapshot(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(KEY_SCOUT_SNAPSHOT(userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Mark fingerprints as seen (dedup).
 */
async function markScoutSeen(redis, userId, fingerprints = []) {
  if (!redis || !userId || !fingerprints.length) return;
  await redis.sadd(KEY_SCOUT_SEEN(userId), ...fingerprints).catch(() => {});
  await redis.expire(KEY_SCOUT_SEEN(userId), SEEN_TTL).catch(() => {});
}

async function loadScoutSeenFps(redis, userId) {
  if (!redis || !userId) return new Set();
  try {
    const members = await redis.smembers(KEY_SCOUT_SEEN(userId));
    return new Set(members || []);
  } catch { return new Set(); }
}

// ── Main generator ────────────────────────────────────────────────────────────

/**
 * Build deal scout targets for a user.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} ctx
 *   discoveryOpps     — opportunities from getDiscoverySnapshot or opportunityScanner
 *   masteryMap        — Map<category, masteryObject> from getCategoryMasteryMap
 *   topCategories     — string[] from buildUserOpportunityPolicy
 *   capitalBlock      — from buildCapitalBlockSignal (may be null)
 *   priceSweet        — { min, max } user's typical price range (may be null)
 *
 * @returns {{ targets: Array<ScoutCard>, count: number, generatedAt: number }}
 */
export async function buildDealScoutTargets(redis, userId, {
  discoveryOpps  = [],
  masteryMap     = new Map(),
  topCategories  = [],
  capitalBlock   = null,
  priceSweet     = null,
} = {}) {
  const _empty = { targets: [], count: 0, generatedAt: Date.now() };
  if (!userId) return _empty;

  try {
    const seenFps = await loadScoutSeenFps(redis, userId);
    const userCtx = { masteryMap, topCategories, priceSweet, seenFps };

    // Filter: only categories with proven mastery, only strong enough signals
    const eligible = discoveryOpps
      .filter(opp => {
        if (!opp?.buySignal) return false;
        if (!["STRONG BUY", "GOOD DEAL"].includes(opp.buySignal)) return false;
        if ((opp.opportunityScore || 0) < MIN_OPP_SCORE) return false;
        // Must have a category with some user track record
        const cat = String(opp.category || "").toLowerCase().trim();
        const mastery = masteryMap.get(cat);
        if (!mastery) return false; // no data in this category = skip
        return MIN_MASTERY_LEVELS.has(mastery.masteryLevel);
      });

    if (!eligible.length) return _empty;

    // Score and annotate
    let scored = eligible.map(opp => {
      const { score, reasons } = scoreScoutCandidate(opp, userCtx);
      return { opp, score, reasons };
    });

    // Apply capital filter
    scored = applyCapitalFilter(scored, capitalBlock);

    // Apply timing filter
    scored = applyTimingFilter(scored);

    // Sort by composite score
    scored.sort((a, b) => b.score - a.score);

    // Dedup by category — at most 2 from any single category
    const catCount = {};
    const dedupedSorted = scored.filter(c => {
      const cat = c.opp?.category || "";
      catCount[cat] = (catCount[cat] || 0) + 1;
      return catCount[cat] <= 2;
    });

    // Take 3–5 targets
    const finalCount = Math.min(TARGET_COUNT_MAX, Math.max(TARGET_COUNT_MIN, dedupedSorted.length));
    const selected   = dedupedSorted.slice(0, finalCount);

    const targets = selected.map((c, i) => buildScoutCard(c.opp, i + 1, c.reasons));

    // Mark these fingerprints as seen
    const fps = targets.map(t => t.fingerprint).filter(Boolean);
    if (fps.length) await markScoutSeen(redis, userId, fps);

    // Store snapshot
    await storeScoutSnapshot(redis, userId, targets);

    return { targets, count: targets.length, generatedAt: Date.now() };
  } catch { return _empty; }
}

// ── Helper ────────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(Number(v) * 100) / 100; }
