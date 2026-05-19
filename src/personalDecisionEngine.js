// src/personalDecisionEngine.js
// Personal Decision Engine — orchestrates per-user personalization at scan time.
//
// CRITICAL INVARIANTS:
//   - Personalization sits AFTER all base trust/depth/safety logic.
//   - Never overrides: market depth gates, liquidity caps, replica risk,
//     category-level suppression, thin market caps, identity quality gates.
//   - Only produces DOWNGRADES, never upgrades — base truth has final say.
//   - Every enforcement is explainable in plain text fields.
//
// Systems orchestrated:
//   1. User operating mode — PROTECT / BALANCED / AGGRESSIVE
//   2. Failure fingerprint enforcement — pattern-matched downgrade at scan time
//   3. Category mastery scoring — NOVICE / LEARNING / COMPETENT / EXPERT
//   4. Category suspension recommendation — pause bad-performing categories
//   5. Personal action mapping — BUY / NEGOTIATE / WATCH / SKIP / SELL_FIRST / PAUSE_CATEGORY
//   6. Signal-level win rates surfaced to frontend
//   7. Safe-to-act-alone detection — narrow case for proven expert buyers

import { computeAccuracyProfile }       from "./accuracyEngine.js";
import { getCategoryOutcomePrior }       from "./outcomeLearning.js";
import {
  computeCategoryMastery,
  buildCategorySuspensionRecommendation,
  AUTONOMOUS_PRICE_CAP,
} from "./categoryMastery.js";
import {
  matchFailurePattern,
  enforceFailureGate,
} from "./failureFingerprintEngine.js";

// ── Operating mode ────────────────────────────────────────────────────────────

export const OPERATING_MODES = {
  PROTECT:    "PROTECT",    // poor track record or new user — tighter gates
  BALANCED:   "BALANCED",   // default
  AGGRESSIVE: "AGGRESSIVE", // proven profitable, loosened friction
};

// Redis key for user preference (90-day TTL)
const KEY_USER_MODE = (uid) => `user:mode:${uid}`;
const MODE_TTL = 90 * 86400;

/**
 * Compute the user's current operating mode.
 *
 * Derived from their accuracy profile and trade record.
 * User can set a preference that is respected within safe bounds:
 *   - User can always elect PROTECT
 *   - User can elect BALANCED if derived is BALANCED or AGGRESSIVE
 *   - User cannot elect AGGRESSIVE if derived is PROTECT or BALANCED
 *
 * @returns {{ mode, reason, derivedMode, userPref, derivedAt }}
 */
export async function computeUserOperatingMode(redis, userId) {
  const _default = { mode: OPERATING_MODES.BALANCED, reason: "no_data", derivedMode: OPERATING_MODES.BALANCED, userPref: null, derivedAt: Date.now() };
  if (!redis || !userId) return _default;

  try {
    const [accuracyProfile, categoryPriors, userPrefRaw] = await Promise.all([
      computeAccuracyProfile(redis, userId).catch(() => null),
      getCategoryOutcomePrior(redis, userId).catch(() => []),
      redis.get(KEY_USER_MODE(userId)).catch(() => null),
    ]);

    const totalReported = Number(accuracyProfile?.totalReported || 0);
    const totalScans    = Number(accuracyProfile?.totalScans    || 0);
    const overallAcc    = Number(accuracyProfile?.overallAccuracy || 0); // bias-corrected, 0–100

    const allLosses = Array.isArray(categoryPriors)
      ? categoryPriors.reduce((s, p) => s + Number(p?.losses || 0), 0) : 0;
    const allWins   = Array.isArray(categoryPriors)
      ? categoryPriors.reduce((s, p) => s + Number(p?.wins   || 0), 0) : 0;
    const totalTrades = allWins + allLosses;

    let derivedMode, derivedReason;

    if (totalScans < 3 || totalReported < 1) {
      derivedMode   = OPERATING_MODES.BALANCED;
      derivedReason = "new_user_insufficient_data";
    } else if (
      overallAcc < 40 ||
      (allLosses >= 3 && totalTrades >= 4 && allWins / totalTrades < 0.40)
    ) {
      derivedMode   = OPERATING_MODES.PROTECT;
      derivedReason = overallAcc < 40
        ? `Low accuracy: ${overallAcc.toFixed(0)}% corrected win rate`
        : `Poor trade record: ${allLosses} losses in ${totalTrades} trades`;
    } else if (overallAcc >= 70 && totalReported >= 20 && allWins > allLosses) {
      derivedMode   = OPERATING_MODES.AGGRESSIVE;
      derivedReason = `Strong accuracy: ${overallAcc.toFixed(0)}% win rate across ${totalReported} outcomes`;
    } else {
      derivedMode   = OPERATING_MODES.BALANCED;
      derivedReason = `Standard accuracy: ${overallAcc.toFixed(0)}% across ${totalReported} outcomes`;
    }

    // Apply user preference — cap upward to derived level
    const userPref   = userPrefRaw && OPERATING_MODES[userPrefRaw] ? userPrefRaw : null;
    let   finalMode  = derivedMode;

    if (userPref === OPERATING_MODES.PROTECT) {
      // User always allowed to elect PROTECT
      finalMode     = OPERATING_MODES.PROTECT;
      derivedReason = "user_elected_protect_mode";
    } else if (userPref === OPERATING_MODES.BALANCED && derivedMode !== OPERATING_MODES.PROTECT) {
      finalMode     = OPERATING_MODES.BALANCED;
      derivedReason = "user_elected_balanced_mode";
    } else if (userPref === OPERATING_MODES.AGGRESSIVE && derivedMode === OPERATING_MODES.AGGRESSIVE) {
      // Only allow AGGRESSIVE preference when derivation also qualifies
      finalMode     = OPERATING_MODES.AGGRESSIVE;
      derivedReason = "user_elected_aggressive_mode_confirmed";
    }
    // Otherwise: derived mode wins (user wanted higher friction but data disagrees)

    return { mode: finalMode, reason: derivedReason, derivedMode, userPref, derivedAt: Date.now() };
  } catch {
    return _default;
  }
}

/**
 * Persist a user's preferred operating mode.
 * Preference is bounded at runtime by derivedMode — cannot force AGGRESSIVE.
 */
export async function setUserOperatingMode(redis, userId, mode) {
  if (!redis || !userId || !OPERATING_MODES[mode]) return false;
  try {
    await redis.set(KEY_USER_MODE(userId), mode, "EX", MODE_TTL);
    return true;
  } catch { return false; }
}

// ── Main personalization layer ────────────────────────────────────────────────

/**
 * Apply the personal decision layer. Call AFTER all base trust and gate logic.
 *
 * @param {object} params
 *   redis, pgPool, userId
 *   buySignal    — signal after ALL base gates (depthGate, replicaRisk, suppression)
 *   category     — item category
 *   price        — scan-time price for autonomous check
 *   depthTier    — market depth tier (from marketDepthGate)
 *   confidenceV2 — 0–1 confidence
 *   warnings     — existing warning strings
 *   hardCapped   — true if any base gate already capped the signal
 *
 * @returns {{
 *   finalSignal, personalAction, userMode,
 *   categoryMastery, personalSignalWinRates,
 *   suspension, personalDowngrade,
 *   isSafeAutonomous, personalWarnings, personalExplanation
 * }}
 */
export async function applyPersonalDecisionLayer(redis, pgPool, userId, {
  buySignal    = null,
  category     = null,
  price        = null,
  depthTier    = null,
  confidenceV2 = null,
  warnings     = [],
  hardCapped   = false,
} = {}) {
  const _noop = {
    finalSignal:            buySignal,
    personalAction:         _defaultAction(buySignal),
    userMode:               OPERATING_MODES.BALANCED,
    categoryMastery:        null,
    personalSignalWinRates: null,
    suspension:             null,
    personalDowngrade:      null,
    isSafeAutonomous:       false,
    personalWarnings:       [],
    personalExplanation:    null,
  };

  if (!redis || !userId || !buySignal) return _noop;

  try {
    const priceNum   = price != null ? Number(price) : null;
    const priceRange = priceNum == null     ? null
      : priceNum < 75                       ? "low"
      : priceNum < 300                      ? "mid"
      : "high";

    // Load all personalization data concurrently
    const [operatingMode, masteryResult, failureMatch, accuracyProfile, suspension] =
      await Promise.all([
        computeUserOperatingMode(redis, userId).catch(() => ({ mode: OPERATING_MODES.BALANCED, reason: "error_fallback" })),
        category ? computeCategoryMastery(redis, userId, category).catch(() => null)                          : Promise.resolve(null),
        matchFailurePattern(redis, userId, { buySignal, depthTier, priceRange, category }).catch(() => null),
        computeAccuracyProfile(redis, userId).catch(() => null),
        category ? buildCategorySuspensionRecommendation(redis, userId, category).catch(() => null)           : Promise.resolve(null),
      ]);

    const userMode        = operatingMode.mode;
    const personalWarnings = [];
    let   finalSignal      = buySignal;
    let   personalDowngrade = null;

    // ── 1. Failure fingerprint enforcement (user-specific pattern gate) ────────
    // Applies even when hardCapped is false — this is a user-level override, not
    // a market-level gate. Does NOT fire when signal was already hard-capped by
    // market gates (don't double-penalize).
    if (!hardCapped) {
      const gate = enforceFailureGate(buySignal, failureMatch);
      if (gate.enforced) {
        finalSignal     = gate.signal;
        personalDowngrade = { from: buySignal, to: gate.signal, reason: gate.reason };
        personalWarnings.push(gate.reason);
      }
    }

    // ── 2. Operating mode signal cap ───────────────────────────────────────────
    // PROTECT: cap at GOOD DEAL maximum. Only fires if signal wasn't already
    // downgraded to GOOD DEAL or below by the fingerprint gate.
    if (!hardCapped && userMode === OPERATING_MODES.PROTECT && finalSignal === "STRONG BUY") {
      const protectReason = "PROTECT mode active — your recent results warrant caution";
      finalSignal = "GOOD DEAL";
      if (!personalDowngrade) {
        personalDowngrade = { from: "STRONG BUY", to: "GOOD DEAL", reason: protectReason };
      }
      personalWarnings.push(protectReason);
    }
    // AGGRESSIVE: no signal upgrades — base gates already applied max valid signal

    // ── 3. Signal-level win rates ──────────────────────────────────────────────
    let personalSignalWinRates = null;
    if (accuracyProfile?.signalBreakdown?.length > 0) {
      const bd = accuracyProfile.signalBreakdown;
      const find = (sig) => bd.find((b) => b.signal === sig);
      const sbEntry = find("STRONG BUY");
      const gdEntry = find("GOOD DEAL");
      const faEntry = find("FAIR");
      personalSignalWinRates = {
        strongBuyHitRate:    sbEntry?.biasedWinRate   != null ? round2(sbEntry.biasedWinRate)   : null,
        goodDealHitRate:     gdEntry?.biasedWinRate   != null ? round2(gdEntry.biasedWinRate)   : null,
        fairOverrideHitRate: faEntry?.biasedWinRate   != null ? round2(faEntry.biasedWinRate)   : null,
        totalOutcomes:       Number(accuracyProfile.totalReported || 0),
        overallAccuracy:     accuracyProfile.overallAccuracy != null
          ? round2(Number(accuracyProfile.overallAccuracy)) : null,
      };
    }

    // ── 4. Personal action ─────────────────────────────────────────────────────
    let personalAction = _defaultAction(finalSignal);

    // Suspension overrides action — category is in trouble
    if (suspension?.shouldSuspend) {
      personalAction = "PAUSE_CATEGORY";
      personalWarnings.push(suspension.reason);
    }

    // PROTECT mode: raise friction for buy actions
    if (userMode === OPERATING_MODES.PROTECT) {
      if (personalAction === "BUY")       personalAction = "NEGOTIATE";
      else if (personalAction === "NEGOTIATE") personalAction = "WATCH";
    }

    // ── 5. Safe-to-act-alone detection ────────────────────────────────────────
    // Only: EXPERT mastery + low-dollar + no active downgrade + strong signal
    const isSafeAutonomous = !!(
      masteryResult?.isSafeAutonomous
      && priceNum != null
      && priceNum <= AUTONOMOUS_PRICE_CAP
      && !suspension?.shouldSuspend
      && !personalDowngrade
      && (finalSignal === "STRONG BUY" || finalSignal === "GOOD DEAL")
    );

    // ── 6. Explanation ────────────────────────────────────────────────────────
    const explanationParts = [];
    if (personalDowngrade) {
      explanationParts.push(personalDowngrade.reason);
    } else if (masteryResult?.masteryLevel === "EXPERT" && category) {
      explanationParts.push(`You have a strong track record in ${category} — signal unchanged`);
    }
    if (userMode !== OPERATING_MODES.BALANCED) {
      explanationParts.push(`You are in ${userMode} mode: ${operatingMode.reason}`);
    }
    if (suspension?.shouldSuspend) {
      explanationParts.push(suspension.reason);
    }

    return {
      finalSignal,
      personalAction,
      userMode,
      categoryMastery:        masteryResult  || null,
      personalSignalWinRates: personalSignalWinRates || null,
      suspension:             suspension?.shouldSuspend ? suspension : null,
      personalDowngrade:      personalDowngrade || null,
      isSafeAutonomous,
      personalWarnings:       personalWarnings.length > 0 ? personalWarnings : [],
      personalExplanation:    explanationParts.length > 0 ? explanationParts.join(". ") : null,
    };
  } catch {
    return _noop;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Maps base signal → default personal action verb
// BUY = confirmed recommendation; NEGOTIATE = act but seek discount;
// WATCH = monitor, don't commit; SKIP = pass
function _defaultAction(signal) {
  const MAP = {
    "STRONG BUY":        "BUY",
    "GOOD DEAL":         "NEGOTIATE",
    "FAIR":              "WATCH",
    "OVERPRICED":        "SKIP",
    "RISKY":             "SKIP",
    "INSUFFICIENT DATA": "SKIP",
  };
  return MAP[signal] || "SKIP";
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
