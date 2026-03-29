// src/categoryThresholdEngine.js
// Category-Specific Signal Thresholds — Phase 10 Accuracy Dominance.
//
// PHILOSOPHY:
//   Global floors are the unconditional safety baseline.
//   A category earns its own threshold ONLY after enough real outcome data exists.
//   Low-sample categories cannot self-upgrade — they fall back to global floors.
//   Category overrides can tighten thresholds (protective) or modestly loosen them
//   (earned permissiveness with a hard cap). They CANNOT break safety floors.
//
// Threshold keys:
//   STRONG_BUY_DEAL_STRENGTH   — min dealStrength for SB signal  (default: 0.25)
//   STRONG_BUY_CONFIDENCE      — min confidenceV2 for SB signal  (default: 0.60)
//   STRONG_BUY_TRUST           — min trustScore for SB signal    (default: 0.55)
//   STRONG_BUY_IDENTITY        — min identityQuality for SB      (default: 0.45)
//   GOOD_DEAL_DEAL_STRENGTH    — min dealStrength for GD signal  (default: 0.18)
//   GOOD_DEAL_RESALE_SCORE     — min resaleScore for GD signal   (default: 52)
//   GOOD_DEAL_TRUST            — min trustScore for GD signal    (default: 0.45)
//
// Redis keys:
//   cat_thresh:{category}             STRING  — cached computed thresholds (7d TTL)
//   cat_fp:{category}:{signal}        ZSET    — false-positive events (180d rolling)
//
// Threshold lifecycle:
//   1. Outcomes accumulate via recordCalibrationSample (signalCalibrator.js)
//   2. getCategoryCalibration() returns win rates / avg deal strengths
//   3. computeCategoryThresholds() derives per-category overrides (SYNCHRONOUS)
//   4. buildBuySignal() receives merged thresholds at scan time
//   5. Ops can inspect via GET /api/ops/category-thresholds/:category

// ── Global floor constants (the hard minimum — cannot go below these) ─────────

export const GLOBAL_FLOORS = {
  STRONG_BUY_DEAL_STRENGTH:  0.25,  // mirrors current buildBuySignal gate
  STRONG_BUY_CONFIDENCE:     0.60,  // mirrors current buildBuySignal gate
  STRONG_BUY_TRUST:          0.55,  // mirrors current buildBuySignal gate
  STRONG_BUY_IDENTITY:       0.45,  // mirrors current buildBuySignal gate
  GOOD_DEAL_DEAL_STRENGTH:   0.18,  // mirrors current buildBuySignal gate
  GOOD_DEAL_RESALE_SCORE:    52,    // mirrors current buildBuySignal gate
  GOOD_DEAL_TRUST:           0.45,  // mirrors current buildBuySignal gate
};

// Minimum samples before a category can override global floors
const MIN_SAMPLES_TO_OVERRIDE = 20;
// Higher bar required for tightening (more conservative — don't restrict without evidence)
const MIN_SAMPLES_TO_TIGHTEN  = 50;
// Maximum loosening allowed below global floor (strict)
const MAX_LOOSEN_DELTA         = 0.03;  // e.g., STRONG_BUY_DEAL_STRENGTH can go no lower than 0.22
// Maximum tightening above global floor
const MAX_TIGHTEN_DELTA        = 0.12;

const FP_TTL = 180 * 24 * 3600;  // 180d retention for false-positive events
const KEY_CAT_THRESH = (cat)         => `cat_thresh:${normalizeCat(cat)}`;
const KEY_FP_EVENTS  = (cat, signal) => `cat_fp:${normalizeCat(cat)}:${signal.replace(/\s+/g, "_")}`;

// ── False-positive tracking ────────────────────────────────────────────────────

/**
 * Record a false-positive event for a category + signal pair.
 * Called when a confirmed wrong call (STRONG BUY / GOOD DEAL → loss) is recorded.
 *
 * Stores the gate-level features at the time of the scan so we can analyze
 * which feature ranges are systematically producing false positives.
 */
export async function recordFalsePositive(redis, {
  category, signal, dealStrength, confidence, trustScore, scannedAt,
}) {
  if (!redis || !category || !signal) return;
  const key   = KEY_FP_EVENTS(category, signal);
  const entry = JSON.stringify({
    ds: dealStrength ?? null,
    cv: confidence   ?? null,
    ts: trustScore   ?? null,
    at: scannedAt    || Date.now(),
  });
  await redis.zadd(key, Date.now(), entry);
  await redis.zremrangebyrank(key, 0, -201);   // keep newest 200
  await redis.expire(key, FP_TTL);
}

/**
 * Load recent false-positive events for a category/signal.
 * @param {number} maxAgeMs — default 180 days
 */
export async function loadFalsePositives(redis, category, signal, maxAgeMs = FP_TTL * 1000) {
  if (!redis || !category || !signal) return [];
  try {
    const minScore = Date.now() - maxAgeMs;
    const raw = await redis.zrangebyscore(KEY_FP_EVENTS(category, signal), minScore, "+inf");
    return raw
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Summarize false positive patterns for a category + signal.
 * Returns basic stats useful for ops dashboards.
 */
export async function getFalsePositiveSummary(redis, category, signal) {
  const fps = await loadFalsePositives(redis, category, signal).catch(() => []);
  if (!fps.length) return null;

  const dsList = fps.map((f) => f.ds).filter((v) => v != null);
  const cvList = fps.map((f) => f.cv).filter((v) => v != null);

  const avg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

  return {
    category,
    signal,
    fpCount:         fps.length,
    avgDealStrength: dsList.length ? round4(avg(dsList)) : null,
    avgConfidence:   cvList.length ? round4(avg(cvList)) : null,
    oldestAt:        fps[0]?.at || null,
    newestAt:        fps[fps.length - 1]?.at || null,
  };
}

// ── Threshold computation (SYNCHRONOUS) ───────────────────────────────────────

/**
 * Derive category-specific threshold overrides from calibration data.
 * Returns ONLY overrides — caller merges with GLOBAL_FLOORS.
 *
 * This is synchronous — it uses already-loaded calibration data.
 * No Redis access at call time.
 *
 * @param {object} calibration — from getCategoryCalibration (signalCalibrator.js)
 * @returns {object} partial threshold map (only keys that differ from global floors)
 */
export function computeCategoryThresholds(calibration) {
  if (!calibration || !calibration.totalSamples) return {};
  if (calibration.totalSamples < MIN_SAMPLES_TO_OVERRIDE)  return {};

  const { totalSamples, avgDsWin, avgDsLoss, avgCvWin, sbWinRate, gdWinRate, source } = calibration;
  const overrides = {};

  // ── STRONG_BUY_DEAL_STRENGTH ───────────────────────────────────────────────
  if (totalSamples >= MIN_SAMPLES_TO_TIGHTEN && avgDsWin !== null) {
    const floor = GLOBAL_FLOORS.STRONG_BUY_DEAL_STRENGTH;

    if (avgDsWin > floor + 0.06) {
      // Category's winning deals cluster at higher DS — tighten to match
      const tightened = Math.min(floor + MAX_TIGHTEN_DELTA, avgDsWin * 0.72 + floor * 0.28);
      overrides.STRONG_BUY_DEAL_STRENGTH = round4(tightened);
    } else if (sbWinRate !== null && sbWinRate < 60) {
      // Category is chronically under-performing — tighten conservatively
      const tightened = Math.min(floor + 0.04, floor + MAX_TIGHTEN_DELTA * 0.35);
      overrides.STRONG_BUY_DEAL_STRENGTH = round4(tightened);
    } else if (sbWinRate !== null && sbWinRate >= 90 && avgDsWin < floor + 0.02) {
      // Category has exceptional win rate at moderate DS — earn modest loosening
      const loosened = Math.max(floor - MAX_LOOSEN_DELTA, floor - 0.02);
      overrides.STRONG_BUY_DEAL_STRENGTH = round4(loosened);
    }
  }

  // ── STRONG_BUY_CONFIDENCE ─────────────────────────────────────────────────
  if (totalSamples >= MIN_SAMPLES_TO_TIGHTEN && avgCvWin !== null) {
    const floor = GLOBAL_FLOORS.STRONG_BUY_CONFIDENCE;
    if (avgCvWin > floor + 0.08) {
      overrides.STRONG_BUY_CONFIDENCE = round4(Math.min(floor + 0.10, avgCvWin * 0.90));
    }
  }

  // ── GOOD_DEAL_DEAL_STRENGTH ────────────────────────────────────────────────
  if (totalSamples >= MIN_SAMPLES_TO_OVERRIDE && avgDsWin !== null && gdWinRate !== null) {
    const floor = GLOBAL_FLOORS.GOOD_DEAL_DEAL_STRENGTH;
    if (totalSamples >= MIN_SAMPLES_TO_TIGHTEN && avgDsWin > floor + 0.05) {
      overrides.GOOD_DEAL_DEAL_STRENGTH = round4(Math.min(floor + 0.05, avgDsWin * 0.78));
    } else if (gdWinRate >= 85 && totalSamples >= MIN_SAMPLES_TO_TIGHTEN) {
      // Excellent GD win rate — modest loosening earned
      overrides.GOOD_DEAL_DEAL_STRENGTH = round4(Math.max(floor - MAX_LOOSEN_DELTA, floor - 0.02));
    }
  }

  // ── Anti-permissiveness guard ──────────────────────────────────────────────
  // Global-source calibration (not user's own data): only allow tightening
  if (source === "global") {
    for (const key of Object.keys(overrides)) {
      if (overrides[key] < GLOBAL_FLOORS[key]) {
        delete overrides[key];  // no loosening on global-source data
      }
    }
  }

  return overrides;
}

/**
 * Build the full effective threshold set for a category.
 * Merges global floors → calibration-derived overrides → explicit operator overrides.
 * Global floors act as absolute hard limits — explicit overrides can only TIGHTEN.
 *
 * Priority (highest wins):
 *   1. explicit ops overrides (from autoTuningEngine — confirmed, logged, reversible)
 *   2. calibration-derived overrides (from computeCategoryThresholds)
 *   3. GLOBAL_FLOORS (unconditional floor)
 *
 * This is SYNCHRONOUS — pass pre-loaded explicitOverrides from async scan context.
 *
 * @param {object|null} calibration       — from getCategoryCalibration
 * @param {object}      explicitOverrides  — from loadExplicitThresholdOverrides() (Phase 11)
 * @returns {object} merged thresholds + metadata
 */
export function buildEffectiveThresholds(calibration, explicitOverrides = {}) {
  const calOverrides      = calibration ? computeCategoryThresholds(calibration) : {};
  const hasCalOverride    = Object.keys(calOverrides).length > 0;
  const hasExplicitOverride = explicitOverrides && Object.keys(explicitOverrides).length > 0;

  const merged = {};
  for (const [key, floor] of Object.entries(GLOBAL_FLOORS)) {
    // Start with calibration-derived override or floor
    let value = calOverrides[key] !== undefined
      ? round4(Math.max(floor - MAX_LOOSEN_DELTA, calOverrides[key]))
      : floor;

    // Apply explicit ops override on top (Phase 11: auto-tuning confirmed adjustment)
    // Explicit overrides can only TIGHTEN (must be >= current value after cal-override)
    if (hasExplicitOverride && explicitOverrides[key] !== undefined) {
      const explicit = Number(explicitOverrides[key]);
      // Hard rule: explicit cannot go below global floor
      if (Number.isFinite(explicit) && explicit >= floor) {
        value = round4(Math.max(value, explicit)); // take the tighter of the two
      }
    }

    merged[key] = value;
  }

  const source = hasExplicitOverride ? "explicit_ops" : hasCalOverride ? "category" : "global";

  return {
    ...merged,
    _source:          source,
    _sampleCount:     calibration?.totalSamples || 0,
    _isCalibrated:    calibration?.isCalibrated || false,
    _overrides:       hasCalOverride    ? calOverrides      : null,
    _explicitOverrides: hasExplicitOverride ? explicitOverrides : null,
  };
}

// ── Redis storage (for ops inspection) ────────────────────────────────────────

/**
 * Persist computed category thresholds to Redis for audit/inspection.
 * Not required at runtime — thresholds are re-computed from calibration each scan.
 */
export async function storeCategoryThresholds(redis, category, thresholds) {
  if (!redis || !category) return;
  const data = { ...thresholds, category, storedAt: Date.now() };
  await redis.set(KEY_CAT_THRESH(category), JSON.stringify(data), "EX", 7 * 24 * 3600).catch(() => {});
}

export async function loadStoredCategoryThresholds(redis, category) {
  if (!redis || !category) return null;
  try {
    const raw = await redis.get(KEY_CAT_THRESH(category));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}

function round4(v) { return Math.round(Number(v) * 10000) / 10000; }
