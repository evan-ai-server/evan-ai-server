// src/addictionEngine.js
// Retention + Engagement Engine.
//
// Designed around behavioral psychology loops that keep users returning daily
// without dark patterns. Every trigger is grounded in real data:
//   Streak    — consecutive profitable days (reward)
//   Urgency   — items with rising demand or closing windows (FOMO)
//   Regret    — missed profits with real dollar amounts (loss aversion)
//   Progress  — win rate improving over rolling window (investment)
//   Heat      — categories heating up in real time (curiosity)
//
// All triggers are opt-out, not dark-pattern compelled.
//
// Redis key schema:
//   addiction:streak:{userId}   HASH   — streak data
//     fields: activeDays, profitableDays, lastActiveDate, lastProfitDate, currentStreak, bestStreak
//   addiction:urgency:{userId}  ZSET   — urgency items scored by urgency level
//   addiction:heat:{category}   STRING — category heat score (shared, not per-user)

const KEY_STREAK  = (uid) => `addiction:streak:${uid}`;
const KEY_URGENCY = (uid) => `addiction:urgency:${uid}`;
const KEY_HEAT    = (cat) => `addiction:heat:${sanitizeCat(cat)}`;

const STREAK_TTL  = 365 * 86400;
const URGENCY_TTL = 48  * 3600;   // urgency items expire in 48h
const HEAT_TTL    = 6   * 3600;   // category heat refreshes every 6h

// ── Streak tracking ───────────────────────────────────────────────────────────

/**
 * Record a daily active scan event. Maintains consecutive active-day streak.
 * Call once per day per user when they open the app.
 */
export async function recordDailyActivity(redis, userId) {
  if (!redis || !userId) return null;
  const key     = KEY_STREAK(userId);
  const today   = todayStr();

  try {
    const raw  = await redis.hgetall(key);
    const last = raw?.lastActiveDate || null;

    let currentStreak = Number(raw?.currentStreak || 0);
    let bestStreak    = Number(raw?.bestStreak    || 0);
    let activeDays    = Number(raw?.activeDays    || 0);

    if (last === today) {
      // Already recorded today — return current state
      return buildStreakPayload(raw);
    }

    const yesterday = yesterdayStr();
    if (last === yesterday) {
      currentStreak += 1;       // consecutive day
    } else {
      currentStreak = 1;        // streak broken
    }

    bestStreak = Math.max(bestStreak, currentStreak);
    activeDays += 1;

    const pipe = redis.pipeline();
    pipe.hset(key,
      "currentStreak",  String(currentStreak),
      "bestStreak",     String(bestStreak),
      "activeDays",     String(activeDays),
      "lastActiveDate", today,
    );
    pipe.expire(key, STREAK_TTL);
    await pipe.exec();

    return buildStreakPayload({ currentStreak, bestStreak, activeDays,
      lastActiveDate: today, lastProfitDate: raw?.lastProfitDate || null,
      profitableDays: raw?.profitableDays || 0,
    });
  } catch {
    return null;
  }
}

/**
 * Record a profitable day. Call when a sell outcome is profitable.
 */
export async function recordProfitableDay(redis, userId) {
  if (!redis || !userId) return;
  const key   = KEY_STREAK(userId);
  const today = todayStr();

  try {
    const raw            = await redis.hgetall(key);
    const lastProfitDate = raw?.lastProfitDate || null;
    if (lastProfitDate === today) return; // already recorded

    const profitableDays = Number(raw?.profitableDays || 0) + 1;
    await redis.hset(key,
      "profitableDays", String(profitableDays),
      "lastProfitDate", today,
    );
    await redis.expire(key, STREAK_TTL);
  } catch {}
}

/**
 * Get current streak data for a user.
 */
export async function getStreakData(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.hgetall(KEY_STREAK(userId));
    if (!raw || !Object.keys(raw).length) return null;
    return buildStreakPayload(raw);
  } catch {
    return null;
  }
}

// ── Urgency triggers ──────────────────────────────────────────────────────────

/**
 * Add an urgency trigger for a user.
 * Triggers surface in the daily feed with time-sensitive framing.
 *
 * @param {object} trigger
 *   type        — PRICE_RISING | LISTING_ENDING | DEMAND_SPIKE | RESTOCK_RISK | COMPETITOR_BOUGHT
 *   title       — display title
 *   body        — detail text
 *   urgencyScore — 0–100
 *   actionData  — { query, category, itemId, ... }
 */
export async function addUrgencyTrigger(redis, userId, trigger) {
  if (!redis || !userId || !trigger) return;

  const entry = JSON.stringify({
    triggerId:   `urg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type:        trigger.type || "GENERIC",
    title:       String(trigger.title || "").slice(0, 120),
    body:        String(trigger.body  || "").slice(0, 300),
    urgencyScore: Math.min(100, Math.max(0, Number(trigger.urgencyScore || 50))),
    actionData:  trigger.actionData || {},
    expiresAt:   Date.now() + (trigger.ttlMs || URGENCY_TTL * 1000),
    createdAt:   Date.now(),
  });

  const key = KEY_URGENCY(userId);
  await redis.zadd(key, trigger.urgencyScore || 50, entry);
  await redis.zremrangebyrank(key, 0, -16); // keep top 15
  await redis.expire(key, URGENCY_TTL);
}

/**
 * Get active urgency triggers for a user (sorted by urgency, highest first).
 */
export async function getUrgencyTriggers(redis, userId, limit = 5) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.zrevrange(KEY_URGENCY(userId), 0, limit - 1);
    const now = Date.now();
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean)
      .filter((t) => !t.expiresAt || t.expiresAt > now);
  } catch {
    return [];
  }
}

// ── Category heat ─────────────────────────────────────────────────────────────

/**
 * Update category heat score (0–100). Higher = more activity/urgency in this category.
 * Called from the opportunity scanner or watchlist refresh.
 *
 * Heat formula:
 *   base = (newListingsPerHour * 5) + (priceDeltaPct * 2) + (demandScore * 0.5)
 *   Capped at 100.
 */
export async function updateCategoryHeat(redis, category, {
  newListingsPerHour = 0,
  priceDeltaPct      = 0,   // positive = prices rising
  demandScore        = 50,
  topOpportunityScore = 0,
}) {
  if (!redis || !category) return;

  const raw = Math.min(100, Math.round(
    (newListingsPerHour * 5) +
    (Math.abs(priceDeltaPct) * 2) +
    (demandScore * 0.3) +
    (topOpportunityScore * 0.2),
  ));

  const heat = { score: raw, category, updatedAt: Date.now(),
    label: raw >= 75 ? "ON FIRE" : raw >= 55 ? "HEATING UP" : raw >= 35 ? "ACTIVE" : "QUIET" };

  await redis.set(KEY_HEAT(category), JSON.stringify(heat), "EX", HEAT_TTL);
}

export async function getCategoryHeat(redis, category) {
  if (!redis || !category) return null;
  try {
    const raw = await redis.get(KEY_HEAT(sanitizeCat(category)));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ── Progress feedback ─────────────────────────────────────────────────────────

/**
 * Compute a "you're improving" signal by comparing rolling win rates.
 * Returns null if insufficient data.
 *
 * @param {object[]} signalBreakdown — from computeAccuracyProfile().signalBreakdown
 * @param {object}   prior30         — win rate 30 days ago (stored separately)
 */
export function computeProgressSignal(signalBreakdown = [], prior30WinRate = null) {
  const sbData = signalBreakdown.find((b) => b.signal === "STRONG BUY");
  const gdData = signalBreakdown.find((b) => b.signal === "GOOD DEAL");

  const currentRate = sbData?.biasedWinRate ?? gdData?.biasedWinRate ?? null;
  if (currentRate === null) return null;

  if (prior30WinRate === null) {
    return {
      isImproving:   null,
      currentRate,
      prior30Rate:   null,
      delta:         null,
      label:         "Keep scanning to build your track record",
    };
  }

  const delta      = round2(currentRate - prior30WinRate);
  const isImproving = delta > 3;   // >3% improvement is meaningful
  const isDeclining = delta < -5;  // >5% decline is a warning

  return {
    isImproving,
    isDeclining,
    currentRate,
    prior30Rate: prior30WinRate,
    delta,
    label: isImproving
      ? `Win rate up ${delta.toFixed(0)}% this month — you're getting sharper`
      : isDeclining
      ? `Win rate down ${Math.abs(delta).toFixed(0)}% — focus on STRONG BUY signals`
      : "Win rate holding steady",
  };
}

// ── Daily money feed augmentation ─────────────────────────────────────────────

/**
 * Build addiction-layer cards for the daily feed.
 * These sit ABOVE the standard feed entries as hook cards.
 *
 * @returns {FeedEntry[]}
 */
export function buildAddictionFeedCards({
  streak            = null,
  urgencyTriggers   = [],
  missedOpps        = [],
  progressSignal    = null,
  categoryHeat      = [],
  portfolioItems    = [],
}) {
  const cards = [];

  // ── Card 1: Streak card (if streak >= 2 days) ────────────────────────────
  if (streak?.currentStreak >= 2) {
    const emoji = streak.currentStreak >= 14 ? "🔥🔥" : streak.currentStreak >= 7 ? "🔥" : "⚡";
    cards.push({
      feedId:    `streak_${Date.now()}`,
      dedupeKey: "streak_card",
      section:   "STREAK",
      priority:  "HIGH",
      title:     `${streak.currentStreak}-day streak ${emoji}`,
      subtitle:  streak.profitableDays > 0
        ? `${streak.profitableDays} profitable days out of ${streak.activeDays} active`
        : `Active ${streak.activeDays} day${streak.activeDays !== 1 ? "s" : ""} straight`,
      body:      streak.currentStreak >= streak.bestStreak
        ? "Personal best — keep it going"
        : `Best streak: ${streak.bestStreak} days`,
      action:    "OPEN_FEED",
      actionData: {},
      score:     90 + Math.min(10, streak.currentStreak),
      generatedAt: Date.now(),
    });
  }

  // ── Card 2: Urgency triggers (HOT items) ────────────────────────────────
  for (const trigger of urgencyTriggers.slice(0, 2)) {
    if (!trigger?.title) continue;
    cards.push({
      feedId:    `urg_${trigger.triggerId || Date.now()}`,
      dedupeKey: `urg_${trigger.triggerId}`,
      section:   "URGENCY",
      priority:  trigger.urgencyScore >= 75 ? "HIGH" : "MEDIUM",
      title:     trigger.title,
      subtitle:  urgencyTypeLabel(trigger.type),
      body:      trigger.body || null,
      action:    "VIEW_LISTING",
      actionData: trigger.actionData || {},
      score:     trigger.urgencyScore || 60,
      generatedAt: Date.now(),
    });
  }

  // ── Card 3: Missed profit regret (most impactful first) ─────────────────
  const topMissed = missedOpps
    .filter((m) => m?.potentialProfit > 10)
    .sort((a, b) => (b.potentialProfit || 0) - (a.potentialProfit || 0))
    .slice(0, 1)[0];

  if (topMissed) {
    const profit = topMissed.potentialProfit.toFixed(2);
    cards.push({
      feedId:    `regret_${topMissed.missedId || Date.now()}`,
      dedupeKey: `regret_${topMissed.missedId}`,
      section:   "MISSED",
      priority:  "MEDIUM",
      title:     `You left $${profit} on the table`,
      subtitle:  `${topMissed.buySignal} signal you didn't act on · ${topMissed.category || ""}`,
      body:      topMissed.lesson?.tip || null,
      action:    "SET_ALERT",
      actionData: { category: topMissed.category, query: topMissed.query },
      score:     75,
      generatedAt: Date.now(),
    });
  }

  // ── Card 4: Progress feedback ────────────────────────────────────────────
  if (progressSignal?.isImproving === true) {
    cards.push({
      feedId:    `progress_${Date.now()}`,
      dedupeKey: "progress_card",
      section:   "PROGRESS",
      priority:  "LOW",
      title:     progressSignal.label,
      subtitle:  `Win rate: ${progressSignal.currentRate?.toFixed(0)}% (+${progressSignal.delta?.toFixed(0)}% this month)`,
      body:      "Your decisions are getting sharper — Evan is learning from your outcomes too.",
      action:    "VIEW_STATS",
      actionData: {},
      score:     55,
      generatedAt: Date.now(),
    });
  }

  // ── Card 5: Hot category ─────────────────────────────────────────────────
  const hotCat = categoryHeat.find((h) => h?.score >= 65);
  if (hotCat) {
    cards.push({
      feedId:    `heat_${hotCat.category}_${Date.now()}`,
      dedupeKey: `heat_${hotCat.category}`,
      section:   "HEAT",
      priority:  "MEDIUM",
      title:     `${hotCat.category} is ${hotCat.label}`,
      subtitle:  `Activity spiking — new deals appearing fast`,
      body:      null,
      action:    "BROWSE_CATEGORY",
      actionData: { category: hotCat.category },
      score:     hotCat.score,
      generatedAt: Date.now(),
    });
  }

  // ── Card 6: Portfolio holding too long ──────────────────────────────────
  const urgentHold = portfolioItems.find((item) =>
    item.lifecycleStatus === "HOLDING" &&
    item.purchasedAt &&
    (Date.now() - item.purchasedAt) > 60 * 86400 * 1000, // 60 days
  );
  if (urgentHold) {
    const heldDays = Math.round((Date.now() - urgentHold.purchasedAt) / 86400000);
    cards.push({
      feedId:    `hold_urg_${urgentHold.itemId || Date.now()}`,
      dedupeKey: `hold_urg_${urgentHold.itemId}`,
      section:   "PORTFOLIO_ACTION",
      priority:  "HIGH",
      title:     `${urgentHold.title || "Item"} held ${heldDays} days — list it`,
      subtitle:  "Capital is locked up. Market conditions may be peaking.",
      body:      null,
      action:    "SET_STATUS",
      actionData: { itemId: urgentHold.itemId, suggestedStatus: "LISTED" },
      score:     85,
      generatedAt: Date.now(),
    });
  }

  return cards.sort((a, b) => b.score - a.score);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStreakPayload(raw = {}) {
  const currentStreak = Number(raw.currentStreak || 0);
  const bestStreak    = Number(raw.bestStreak    || 0);
  const activeDays    = Number(raw.activeDays    || 0);
  const profitableDays = Number(raw.profitableDays || 0);

  const streakLabel = currentStreak >= 30 ? "Unstoppable"
    : currentStreak >= 14 ? "On Fire"
    : currentStreak >= 7  ? "Hot Streak"
    : currentStreak >= 3  ? "Building"
    : currentStreak === 2 ? "Getting Started"
    : "Day 1";

  return {
    currentStreak,
    bestStreak,
    activeDays,
    profitableDays,
    lastActiveDate:  raw.lastActiveDate  || null,
    lastProfitDate:  raw.lastProfitDate  || null,
    streakLabel,
    isPersonalBest:  currentStreak > 0 && currentStreak >= bestStreak,
  };
}

function urgencyTypeLabel(type) {
  const LABELS = {
    PRICE_RISING:      "Price is climbing — act soon",
    LISTING_ENDING:    "Listing ends soon",
    DEMAND_SPIKE:      "Demand spike detected",
    RESTOCK_RISK:      "Supply shrinking",
    COMPETITOR_BOUGHT: "Similar buyers are moving",
    GENERIC:           "Time-sensitive opportunity",
  };
  return LABELS[type] || LABELS.GENERIC;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10); // "2026-03-27"
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function sanitizeCat(cat) {
  return String(cat || "general").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
