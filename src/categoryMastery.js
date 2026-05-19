// src/categoryMastery.js
// Per-user category mastery scoring.
//
// Mastery = composite of win rate + sample size + profit consistency.
// Levels: NOVICE, LEARNING, COMPETENT, EXPERT
//
// Source data:
//   signalCalibrator: sbWinRate (0–100), gdWinRate (0–100), totalSamples, categoryHeat
//   outcomeLearning:  affinityScore (0–1), hitRate (0–100), wins, losses
//
// isSafeAutonomous: EXPERT mastery + not a replica-risk category.
// Only suggested for low-dollar items (< AUTONOMOUS_PRICE_CAP).
// Never suggested for replica-risk categories regardless of mastery.

import { getCategoryCalibration }  from "./signalCalibrator.js";
import { getCategoryOutcomePrior } from "./outcomeLearning.js";

export const MASTERY_LEVELS = {
  NOVICE:    "NOVICE",     // <5 samples or <40% win rate
  LEARNING:  "LEARNING",  // 5–14 samples, 40–60% win rate
  COMPETENT: "COMPETENT", // 15+ samples, 60–75% win rate
  EXPERT:    "EXPERT",    // 15+ samples, 75%+ win rate
};

// Categories where autonomous buying is NEVER safe regardless of mastery
const REPLICA_RISK_CATEGORIES = new Set([
  "luxury", "watches", "handbags", "sneakers", "jewelry",
  "collectibles", "trading cards", "coins", "designer",
]);

// Max price for safe-autonomous recommendation
export const AUTONOMOUS_PRICE_CAP = 50;

/**
 * Compute mastery for a single category.
 *
 * @returns {{
 *   category, masteryLevel, masteryScore,
 *   sbWinRate, gdWinRate, totalSamples,
 *   affinityScore, categoryHeat,
 *   isSafeAutonomous, autonomousReason
 * }}
 */
export async function computeCategoryMastery(redis, userId, category) {
  if (!redis || !userId || !category) return _emptyMastery(category);

  try {
    const catNorm = String(category).toLowerCase().trim();

    const [cal, priorList] = await Promise.all([
      getCategoryCalibration(redis, userId, catNorm).catch(() => null),
      getCategoryOutcomePrior(redis, userId).catch(() => []),
    ]);

    const prior = Array.isArray(priorList)
      ? priorList.find((p) => p.category === catNorm) || null
      : null;

    const totalSamples  = Number(cal?.totalSamples || 0);
    const sbWinRate     = cal?.sbWinRate  != null ? Number(cal.sbWinRate)  : null; // 0–100
    const gdWinRate     = cal?.gdWinRate  != null ? Number(cal.gdWinRate)  : null; // 0–100
    const categoryHeat  = cal?.categoryHeat || "COLD";
    const affinityScore = prior?.affinityScore != null ? Number(prior.affinityScore) : null;
    const hitRate       = prior?.hitRate       != null ? Number(prior.hitRate)       : null; // 0–100

    // Effective win rate: prefer per-signal STRONG BUY rate (most relevant),
    // fall back to overall hit rate from outcome priors
    const effectiveWinRate = sbWinRate ?? hitRate ?? 0;

    const masteryScore = _scoreMastery(totalSamples, effectiveWinRate, gdWinRate, affinityScore);
    const masteryLevel = _levelFromData(totalSamples, effectiveWinRate);

    const isSafeAutonomous = masteryLevel === MASTERY_LEVELS.EXPERT
      && !REPLICA_RISK_CATEGORIES.has(catNorm);

    return {
      category: catNorm,
      masteryLevel,
      masteryScore:    round2(masteryScore),
      sbWinRate:       sbWinRate  != null ? round2(sbWinRate)  : null,
      gdWinRate:       gdWinRate  != null ? round2(gdWinRate)  : null,
      totalSamples,
      affinityScore:   affinityScore != null ? round2(affinityScore) : null,
      categoryHeat,
      isSafeAutonomous,
      autonomousReason: isSafeAutonomous
        ? `${totalSamples} outcomes in ${catNorm} — strong track record supports confident buying under $${AUTONOMOUS_PRICE_CAP}`
        : null,
    };
  } catch {
    return _emptyMastery(category);
  }
}

/**
 * Get mastery for all categories the user has outcome data in.
 * Returns Map<category, masteryObject>.
 */
export async function getCategoryMasteryMap(redis, userId) {
  if (!redis || !userId) return new Map();
  try {
    const priorList = await getCategoryOutcomePrior(redis, userId).catch(() => []);
    if (!Array.isArray(priorList) || priorList.length === 0) return new Map();

    const results = await Promise.all(
      priorList.map((p) => computeCategoryMastery(redis, userId, p.category))
    );

    const map = new Map();
    for (const m of results) {
      if (m?.category) map.set(m.category, m);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Build a per-user suspension recommendation for a category.
 * Returns null if no suspension is warranted.
 *
 * Suspension criteria: 3+ losses AND win rate < 40% AND at least 4 total trades.
 *
 * @returns {{ shouldSuspend, category, lossStreak, winCount, totalTrades,
 *             winRate, reason, alternatives }} | null
 */
export async function buildCategorySuspensionRecommendation(redis, userId, category, {
  masteryOverride = null,
} = {}) {
  if (!redis || !userId || !category) return null;

  try {
    const catNorm   = String(category).toLowerCase().trim();
    const priorList = await getCategoryOutcomePrior(redis, userId).catch(() => []);
    const prior     = Array.isArray(priorList)
      ? priorList.find((p) => p.category === catNorm)
      : null;

    const losses  = Number(prior?.losses || 0);
    const wins    = Number(prior?.wins   || 0);
    const total   = losses + wins;
    const winFrac = total > 0 ? (wins / total) : null;

    const shouldSuspend = losses >= 3 && winFrac != null && winFrac < 0.40 && total >= 4;
    if (!shouldSuspend) return null;

    const winRate = round2((winFrac ?? 0) * 100);

    // Find stronger alternative categories
    let alternatives = [];
    try {
      const masteryMap = await getCategoryMasteryMap(redis, userId);
      alternatives = Array.from(masteryMap.values())
        .filter((m) => m.category !== catNorm && ["COMPETENT", "EXPERT"].includes(m.masteryLevel))
        .sort((a, b) => b.masteryScore - a.masteryScore)
        .slice(0, 2)
        .map((m) => m.category);
    } catch { /* ignore */ }

    return {
      shouldSuspend: true,
      category:    catNorm,
      lossStreak:  losses,
      winCount:    wins,
      totalTrades: total,
      winRate,
      reason:      `${losses} losses in ${catNorm} — ${winRate}% win rate. Evan recommends pausing this category.`,
      alternatives,
    };
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mastery score 0–100:
 *   Volume component  0–30 pts (saturates at 30 samples)
 *   Win rate component 0–50 pts
 *   Affinity component 0–20 pts
 */
function _scoreMastery(totalSamples, effectiveWinRate, gdWinRate, affinityScore) {
  if (totalSamples < 1) return 0;
  const volumePts  = Math.min(30, (totalSamples / 30) * 30);
  const winPts     = ((effectiveWinRate ?? 0) / 100) * 50;
  const affPts     = affinityScore != null ? Number(affinityScore) * 20 : 0;
  return Math.min(100, volumePts + winPts + affPts);
}

function _levelFromData(totalSamples, effectiveWinRate) {
  if (totalSamples < 5 || effectiveWinRate == null) return MASTERY_LEVELS.NOVICE;
  if (effectiveWinRate < 40) return MASTERY_LEVELS.NOVICE;
  if (totalSamples < 15 || effectiveWinRate < 60)  return MASTERY_LEVELS.LEARNING;
  if (effectiveWinRate < 75) return MASTERY_LEVELS.COMPETENT;
  return MASTERY_LEVELS.EXPERT;
}

function _emptyMastery(category) {
  return {
    category:         category ? String(category).toLowerCase().trim() : null,
    masteryLevel:     MASTERY_LEVELS.NOVICE,
    masteryScore:     0,
    sbWinRate:        null,
    gdWinRate:        null,
    totalSamples:     0,
    affinityScore:    null,
    categoryHeat:     "COLD",
    isSafeAutonomous: false,
    autonomousReason: null,
  };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
