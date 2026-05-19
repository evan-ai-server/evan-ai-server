// src/signalCalibrator.js
// Per-Category Signal Threshold Calibrator.
//
// Problem: the system uses fixed thresholds (dealStrength >= 0.25, demandScore >= 50)
// that don't account for category-specific dynamics.
//   Sneakers: high volatility — needs higher dealStrength to be reliable
//   Electronics: fast-moving — timing signal more important than spread
//   Vintage: thin market always — confidence gate must be tighter
//
// Solution: learn per-category threshold multipliers from actual outcomes.
// Each time an outcome is recorded, update the calibration for that category.
// The calibrator outputs threshold overrides that assembleProfitIntel can use.
//
// Redis key schema:
//   calibrator:cat:{userId}:{category}   HASH
//     fields: strongbuy_wins, strongbuy_total, gooddeal_wins, gooddeal_total,
//             avg_deal_strength_win, avg_deal_strength_loss,
//             avg_confidence_win, avg_confidence_loss,
//             time_to_sale_sum, time_to_sale_count, updatedAt
//   calibrator:global:{category}         HASH  — cross-user baseline
//     same fields

const KEY_USER_CAL   = (uid, cat) => `calibrator:cat:${uid}:${sanitizeCat(cat)}`;
const KEY_GLOBAL_CAL = (cat)      => `calibrator:global:${sanitizeCat(cat)}`;
const CAL_TTL        = 180 * 86400; // 6 months

// Minimum samples before calibration overrides defaults
const MIN_SAMPLES_TO_CALIBRATE = 5;

// How much to shift thresholds per unit of calibration signal (dampened)
const SHIFT_DAMPER = 0.4;

// ── Record calibration sample ─────────────────────────────────────────────────

/**
 * Record a single outcome sample into the calibration system.
 * Call this after a buy+sell outcome is known.
 *
 * @param {object} params
 *   category      — item category
 *   buySignal     — the signal shown at scan time
 *   dealStrength  — deal strength at scan time (0–1)
 *   confidenceV2  — confidence at scan time (0–1)
 *   isWin         — boolean: was this a profitable outcome?
 *   daysToSale    — number of days from buy to sell (null if not sold)
 */
export async function recordCalibrationSample(redis, userId, {
  category     = "",
  buySignal    = null,
  dealStrength = 0,
  confidenceV2 = 0,
  isWin        = null,
  daysToSale   = null,
}) {
  if (!redis || !userId || !buySignal || isWin === null) return;
  const cat = sanitizeCat(category);
  if (!cat) return;

  const isStrongBuy = buySignal === "STRONG BUY";
  const isGoodDeal  = buySignal === "GOOD DEAL";

  const pipe = redis.pipeline();
  const userKey   = KEY_USER_CAL(userId, cat);
  const globalKey = KEY_GLOBAL_CAL(cat);

  for (const key of [userKey, globalKey]) {
    if (isStrongBuy) {
      pipe.hincrby(key, "sb_total", 1);
      if (isWin) pipe.hincrby(key, "sb_wins", 1);
    }
    if (isGoodDeal) {
      pipe.hincrby(key, "gd_total", 1);
      if (isWin) pipe.hincrby(key, "gd_wins", 1);
    }

    // Track average deal strength at win vs loss
    const ds = round4(Number(dealStrength) || 0);
    const cv = round4(Number(confidenceV2) || 0);
    if (isWin) {
      pipe.hincrbyfloat(key, "ds_win_sum",  ds);
      pipe.hincrby(key,     "ds_win_count", 1);
      pipe.hincrbyfloat(key, "cv_win_sum",  cv);
      pipe.hincrby(key,     "cv_win_count", 1);
    } else {
      pipe.hincrbyfloat(key, "ds_loss_sum",  ds);
      pipe.hincrby(key,     "ds_loss_count", 1);
      pipe.hincrbyfloat(key, "cv_loss_sum",  cv);
      pipe.hincrby(key,     "cv_loss_count", 1);
    }

    // Time to sale
    if (daysToSale != null && Number.isFinite(Number(daysToSale))) {
      pipe.hincrbyfloat(key, "tte_sum",   Math.max(0, Number(daysToSale)));
      pipe.hincrby(key,     "tte_count", 1);
    }

    pipe.hset(key, "updatedAt", String(Date.now()));
    pipe.expire(key, CAL_TTL);
  }

  await pipe.exec().catch(() => {});
}

// ── Read calibration ──────────────────────────────────────────────────────────

/**
 * Get calibrated threshold overrides for a user+category.
 * Returns null if insufficient data for calibration.
 *
 * @returns {{
 *   category,
 *   sbWinRate:           number|null,   // STRONG BUY observed win rate (0–100)
 *   gdWinRate:           number|null,   // GOOD DEAL observed win rate (0–100)
 *   avgDsWin:            number|null,   // avg deal strength at wins
 *   avgDsLoss:           number|null,   // avg deal strength at losses
 *   avgCvWin:            number|null,   // avg confidence at wins
 *   avgDaysToSale:       number|null,
 *   dealStrengthOverride: number|null,  // recommended minimum dealStrength for this category
 *   confidenceOverride:   number|null,  // recommended minimum confidence
 *   categoryHeat:         string,       // HOT / WARM / COOL / COLD
 *   isCalibrated:         boolean,
 * }}
 */
export async function getCategoryCalibration(redis, userId, category) {
  if (!redis || !userId || !category) return defaultCalibration(category);

  try {
    const cat     = sanitizeCat(category);
    const userKey = KEY_USER_CAL(userId, cat);
    const raw     = await redis.hgetall(userKey);

    // Fall back to global if user has insufficient data
    const sbTotal = Number(raw?.sb_total || 0);
    const gdTotal = Number(raw?.gd_total || 0);
    const total   = sbTotal + gdTotal;

    let data = raw;
    let source = "user";
    if (total < MIN_SAMPLES_TO_CALIBRATE) {
      const globalRaw = await redis.hgetall(KEY_GLOBAL_CAL(cat));
      if (globalRaw && Object.keys(globalRaw).length > 0) {
        data   = globalRaw;
        source = "global";
      } else {
        return defaultCalibration(category);
      }
    }

    const sbWins  = Number(data.sb_wins  || 0);
    const sbTot   = Number(data.sb_total || 0);
    const gdWins  = Number(data.gd_wins  || 0);
    const gdTot   = Number(data.gd_total || 0);

    const sbWinRate = sbTot >= 3 ? round2((sbWins / sbTot) * 100) : null;
    const gdWinRate = gdTot >= 3 ? round2((gdWins / gdTot) * 100) : null;

    const dsWinSum   = Number(data.ds_win_sum   || 0);
    const dsWinCount = Number(data.ds_win_count || 0);
    const dsLossSum  = Number(data.ds_loss_sum  || 0);
    const dsLossCount = Number(data.ds_loss_count || 0);
    const cvWinSum   = Number(data.cv_win_sum   || 0);
    const cvWinCount = Number(data.cv_win_count || 0);
    const tteSum     = Number(data.tte_sum      || 0);
    const tteCount   = Number(data.tte_count    || 0);

    const avgDsWin   = dsWinCount  > 0 ? round4(dsWinSum  / dsWinCount)  : null;
    const avgDsLoss  = dsLossCount > 0 ? round4(dsLossSum / dsLossCount) : null;
    const avgCvWin   = cvWinCount  > 0 ? round4(cvWinSum  / cvWinCount)  : null;
    const avgDaysToSale = tteCount > 0 ? round2(tteSum / tteCount)       : null;

    // Compute threshold overrides
    // If winning deals had avg deal strength of 0.32, floor should be ~0.28 (shift down a bit)
    // If losing deals had avg deal strength of 0.20, we know 0.20 is too low for this category
    let dealStrengthOverride = null;
    if (avgDsWin !== null && avgDsLoss !== null) {
      // Midpoint between win avg and loss avg, biased toward win side
      const rawOverride = (avgDsWin * 0.7 + avgDsLoss * 0.3);
      dealStrengthOverride = round4(Math.min(0.40, Math.max(0.10, rawOverride)));
    } else if (avgDsWin !== null) {
      dealStrengthOverride = round4(Math.max(0.10, avgDsWin * 0.85));
    }

    let confidenceOverride = null;
    if (avgCvWin !== null) {
      confidenceOverride = round4(Math.max(0.45, avgCvWin * 0.90));
    }

    // Category heat: based on STRONG BUY win rate
    const categoryHeat = sbWinRate === null ? "UNKNOWN"
      : sbWinRate >= 80 ? "HOT"
      : sbWinRate >= 65 ? "WARM"
      : sbWinRate >= 45 ? "COOL"
      : "COLD";

    const isCalibrated = (sbTot + gdTot) >= MIN_SAMPLES_TO_CALIBRATE;

    return {
      category,
      source,
      sbWinRate,
      gdWinRate,
      avgDsWin,
      avgDsLoss,
      avgCvWin,
      avgDaysToSale,
      dealStrengthOverride,
      confidenceOverride,
      categoryHeat,
      isCalibrated,
      totalSamples: sbTot + gdTot,
    };
  } catch {
    return defaultCalibration(category);
  }
}

/**
 * Get global calibration for a category (cross-user, no privacy concern).
 */
export async function getGlobalCategoryCalibration(redis, category) {
  if (!redis || !category) return defaultCalibration(category);
  try {
    const raw = await redis.hgetall(KEY_GLOBAL_CAL(sanitizeCat(category)));
    if (!raw || !Object.keys(raw).length) return defaultCalibration(category);

    const sbWins = Number(raw.sb_wins  || 0);
    const sbTot  = Number(raw.sb_total || 0);
    const gdWins = Number(raw.gd_wins  || 0);
    const gdTot  = Number(raw.gd_total || 0);

    return {
      category,
      source:          "global",
      sbWinRate:       sbTot >= 5 ? round2((sbWins / sbTot) * 100) : null,
      gdWinRate:       gdTot >= 5 ? round2((gdWins / gdTot) * 100) : null,
      totalSamples:    sbTot + gdTot,
      categoryHeat:    sbTot >= 5
        ? ((sbWins / sbTot) >= 0.80 ? "HOT" : (sbWins / sbTot) >= 0.65 ? "WARM" : "COOL")
        : "UNKNOWN",
      isCalibrated:    (sbTot + gdTot) >= 10,
    };
  } catch {
    return defaultCalibration(category);
  }
}

/**
 * Apply calibration overrides to a signal evaluation.
 * Returns adjusted dealStrength floor and confidence floor for this category+user.
 */
export function applyCalibrationToGates(calibration, defaultGates = {}) {
  if (!calibration?.isCalibrated) return defaultGates;

  const gates = { ...defaultGates };

  // Override deal strength floor if calibration shows a different minimum
  if (calibration.dealStrengthOverride != null) {
    // Only tighten, never loosen beyond what default already requires
    // Unless user is HOT in this category, in which case we can loosen slightly
    if (calibration.categoryHeat === "HOT") {
      gates.dealStrengthFloor = Math.max(0.10, calibration.dealStrengthOverride * (1 - SHIFT_DAMPER * 0.3));
    } else if (calibration.categoryHeat === "COLD") {
      gates.dealStrengthFloor = Math.max(
        defaultGates.dealStrengthFloor || 0.20,
        calibration.dealStrengthOverride * (1 + SHIFT_DAMPER * 0.2),
      );
    } else {
      gates.dealStrengthFloor = calibration.dealStrengthOverride;
    }
    gates.dealStrengthFloor = round4(gates.dealStrengthFloor);
  }

  if (calibration.confidenceOverride != null) {
    gates.minConfidence = Math.max(
      defaultGates.minConfidence || 0.50,
      calibration.confidenceOverride,
    );
    gates.minConfidence = round4(gates.minConfidence);
  }

  return gates;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultCalibration(category) {
  return {
    category,
    source:              "default",
    sbWinRate:           null,
    gdWinRate:           null,
    avgDsWin:            null,
    avgDsLoss:           null,
    avgCvWin:            null,
    avgDaysToSale:       null,
    dealStrengthOverride: null,
    confidenceOverride:   null,
    categoryHeat:        "UNKNOWN",
    isCalibrated:        false,
    totalSamples:        0,
  };
}

function sanitizeCat(cat) {
  return String(cat || "general").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }
function round4(v) { return Math.round(Number(v) * 10000) / 10000; }
