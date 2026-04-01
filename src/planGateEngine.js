// src/planGateEngine.js
// Plan Gate Engine — Phase 14: Money Engine.
//
// Defines the feature access matrix for free / pro / internal tiers.
// Applies plan-based gating to scan response payloads.
//
// CRITICAL INVARIANTS:
//   - Core signal truth is NEVER modified by plan tier.
//   - System warnings, uncertainty flags, and suspension are always included.
//   - Gating only withholds depth/personalization/analytics — never honesty.
//   - Revenue logic is kept completely separate from signal computation.
//
// Plan matrix:
//
// Feature                        | free | pro | internal
// -------------------------------|------|-----|----------
// Core signal (buySignal, price) |  ✓   |  ✓  |    ✓
// System warnings                |  ✓   |  ✓  |    ✓
// Safety suspension              |  ✓   |  ✓  |    ✓
// Basic price intel (top 3 comps)|  ✓   |  ✓  |    ✓
// Full comp list (top 10)        |  ✗   |  ✓  |    ✓
// Personal decision layer        |  ✗   |  ✓  |    ✓
// Category mastery               |  ✗   |  ✓  |    ✓
// Personal signal win rates      |  ✗   |  ✓  |    ✓
// Probability expression         |  ✗   |  ✓  |    ✓
// Capital lock risk              |  ✗   |  ✓  |    ✓
// Arbitrage detection            |  ✗   |  ✓  |    ✓
// Personal explanation           |  ✗   |  ✓  |    ✓
// Worst-category warning         |  ✗   |  ✓  |    ✓
// Financial identity profile     |  ✗   |  ✓  |    ✓
// Category performance ranking   |  ✗   |  ✓  |    ✓
// Tactic summary                 |  ✗   |  ✓  |    ✓
// Full feed (Phase 13 items)     |  ✗   |  ✓  |    ✓
// Exit intelligence              |  ✗   |  ✓  |    ✓
// Deal scout / alerts            |  ✗   |  ✓  |    ✓
// B2B valuation API              |  ✗   |  ✗  |    ✓ (API key-gated)
// Batch scan                     |  ✗   |  ✗  |    ✓ (API key-gated)

export const PLANS = {
  FREE:     "free",
  PRO:      "pro",
  INTERNAL: "internal",
};

export const FEATURES = {
  // Always available
  CORE_SIGNAL:          "core_signal",
  SYSTEM_WARNINGS:      "system_warnings",
  SAFETY_SUSPENSION:    "safety_suspension",
  BASIC_PRICE_INTEL:    "basic_price_intel",
  BASIC_FEED:           "basic_feed",

  // Pro-only (personalization + analytics depth)
  PERSONAL_DECISION:    "personal_decision",
  CATEGORY_MASTERY:     "category_mastery",
  SIGNAL_WIN_RATES:     "signal_win_rates",
  PROBABILITY_EXPR:     "probability_expr",
  CAPITAL_LOCK_RISK:    "capital_lock_risk",
  ARBITRAGE_DETECTION:  "arbitrage_detection",
  PERSONAL_EXPLAIN:     "personal_explain",
  WORST_CAT_WARNING:    "worst_cat_warning",
  FULL_COMP_LIST:       "full_comp_list",
  FINANCIAL_IDENTITY:   "financial_identity",
  CATEGORY_PERFORMANCE: "category_performance",
  TACTIC_SUMMARY:       "tactic_summary",
  FULL_FEED:            "full_feed",
  EXIT_INTELLIGENCE:    "exit_intelligence",
  DEAL_SCOUT:           "deal_scout",

  // Internal / B2B API-key-gated (not consumer plan)
  BATCH_SCAN:           "batch_scan",
  B2B_VALUATION:        "b2b_valuation",
};

const FEATURE_ACCESS = {
  [FEATURES.CORE_SIGNAL]:          ["free", "pro", "internal"],
  [FEATURES.SYSTEM_WARNINGS]:      ["free", "pro", "internal"],
  [FEATURES.SAFETY_SUSPENSION]:    ["free", "pro", "internal"],
  [FEATURES.BASIC_PRICE_INTEL]:    ["free", "pro", "internal"],
  [FEATURES.BASIC_FEED]:           ["free", "pro", "internal"],
  [FEATURES.PERSONAL_DECISION]:    ["pro", "internal"],
  [FEATURES.CATEGORY_MASTERY]:     ["pro", "internal"],
  [FEATURES.SIGNAL_WIN_RATES]:     ["pro", "internal"],
  [FEATURES.PROBABILITY_EXPR]:     ["pro", "internal"],
  [FEATURES.CAPITAL_LOCK_RISK]:    ["pro", "internal"],
  [FEATURES.ARBITRAGE_DETECTION]:  ["pro", "internal"],
  [FEATURES.PERSONAL_EXPLAIN]:     ["pro", "internal"],
  [FEATURES.WORST_CAT_WARNING]:    ["pro", "internal"],
  [FEATURES.FULL_COMP_LIST]:       ["pro", "internal"],
  [FEATURES.FINANCIAL_IDENTITY]:   ["pro", "internal"],
  [FEATURES.CATEGORY_PERFORMANCE]: ["pro", "internal"],
  [FEATURES.TACTIC_SUMMARY]:       ["pro", "internal"],
  [FEATURES.FULL_FEED]:            ["pro", "internal"],
  [FEATURES.EXIT_INTELLIGENCE]:    ["pro", "internal"],
  [FEATURES.DEAL_SCOUT]:           ["pro", "internal"],
  [FEATURES.BATCH_SCAN]:           ["internal"],
  [FEATURES.B2B_VALUATION]:        ["internal"],
};

const UPSELL_HINTS = {
  [FEATURES.PERSONAL_DECISION]:    "Pro unlocks Evan's personalized buy/sell recommendations calibrated from your actual trade history.",
  [FEATURES.CATEGORY_MASTERY]:     "Pro shows your mastery level per category — so you know where to trust your instincts.",
  [FEATURES.SIGNAL_WIN_RATES]:     "Pro surfaces your personal win rates per signal type, derived from real outcomes.",
  [FEATURES.PROBABILITY_EXPR]:     "Pro shows the observed win-rate probability for this exact deal type in your market.",
  [FEATURES.CAPITAL_LOCK_RISK]:    "Pro warns you when your capital is tied up in aging inventory before you commit more.",
  [FEATURES.ARBITRAGE_DETECTION]:  "Pro detects platform price gaps for the same item — real flip opportunities.",
  [FEATURES.PERSONAL_EXPLAIN]:     "Pro explains why this signal applies specifically to you based on your history.",
  [FEATURES.WORST_CAT_WARNING]:    "Pro warns you when you're about to buy in a category where you've historically lost money.",
  [FEATURES.FULL_COMP_LIST]:       "Pro shows the full comparable listing list — not just the top 3.",
  [FEATURES.FINANCIAL_IDENTITY]:   "Pro builds your financial identity from real outcomes — P&L, maturity tier, and signature tactics.",
  [FEATURES.CATEGORY_PERFORMANCE]: "Pro ranks every category you've traded by realized profit.",
  [FEATURES.TACTIC_SUMMARY]:       "Pro shows your win rate for each buying tactic you use.",
  [FEATURES.FULL_FEED]:            "Pro surfaces financial identity insights in your daily feed — strengths, weaknesses, milestones.",
  [FEATURES.EXIT_INTELLIGENCE]:    "Pro gives you exit intelligence — best platform, timing, and price to sell what you hold.",
  [FEATURES.DEAL_SCOUT]:           "Pro actively scouts deals in your best categories and alerts you.",
};

// ── Access checks ──────────────────────────────────────────────────────────────

/**
 * Check if a plan can access a feature.
 */
export function canAccessFeature(plan, featureKey) {
  const allowed = FEATURE_ACCESS[featureKey];
  if (!allowed) return false;
  return allowed.includes(plan);
}

/**
 * True if plan is pro or internal.
 */
export function isPaidPlan(plan) {
  return plan === "pro" || plan === "internal";
}

/**
 * Upsell hint for a gated feature.
 */
export function getPlanUpsellHint(featureKey) {
  return UPSELL_HINTS[featureKey] || "Upgrade to Pro to unlock this feature.";
}

/**
 * Gate a route handler: returns { allowed } or { allowed, response } for 403.
 * Usage: const gate = gateRoute(plan, FEATURES.FINANCIAL_IDENTITY);
 *        if (!gate.allowed) return res.status(403).json(gate.response);
 */
export function gateRoute(plan, featureKey) {
  if (canAccessFeature(plan, featureKey)) return { allowed: true };
  return {
    allowed: false,
    response: {
      ok:          false,
      error:       "pro_feature_required",
      feature:     featureKey,
      currentPlan: plan,
      upsellHint:  getPlanUpsellHint(featureKey),
    },
  };
}

// ── Payload gating ─────────────────────────────────────────────────────────────

// Pro-only payload fields: [fieldName, featureKey]
const PRO_ONLY_FIELDS = [
  ["personalAction",           FEATURES.PERSONAL_DECISION],
  ["userMode",                 FEATURES.PERSONAL_DECISION],
  ["personalWarnings",         FEATURES.PERSONAL_DECISION],
  ["isSafeAutonomous",         FEATURES.CATEGORY_MASTERY],
  ["categoryMastery",          FEATURES.CATEGORY_MASTERY],
  ["personalSignalWinRates",   FEATURES.SIGNAL_WIN_RATES],
  ["probabilityExpression",    FEATURES.PROBABILITY_EXPR],
  ["capitalLockRisk",          FEATURES.CAPITAL_LOCK_RISK],
  ["arbitrage",                FEATURES.ARBITRAGE_DETECTION],
  ["personalDowngrade",        FEATURES.PERSONAL_EXPLAIN],
  ["personalExplanation",      FEATURES.PERSONAL_EXPLAIN],
  ["explicitOverrideApplied",  FEATURES.PERSONAL_EXPLAIN],
  ["worstCategoryWarning",     FEATURES.WORST_CAT_WARNING],
];

// Issue 1: Signal label softening for free users — prevents overconfidence
// without changing the underlying signal value.
const FREE_SIGNAL_LABELS = {
  "STRONG BUY": "Potential opportunity",
  "GOOD DEAL":  "Possible deal",
};

/**
 * Apply plan gating to a scan response payload.
 *
 * Issue 1: Softens signal display labels for free users (underlying value unchanged).
 * Issue 2: Nulls gated fields + sets <field>Hidden=true instead of deleting.
 * Issue 6: Adds _gatingContext hook for future dynamic gating.
 *
 * MUST run AFTER all signal computation — never before.
 *
 * @param {object} payload  — scan response payload (mutated in place)
 * @param {string} plan     — "free" | "pro" | "internal"
 * @returns {object} payload
 */
export function applyPlanGatingToPayload(payload, plan) {
  if (!payload) return payload;

  // Issue 6: always attach gating context for future dynamic gating hooks
  payload._gatingContext = { plan, trustLevel: null };

  if (isPaidPlan(plan)) return payload; // no further changes for paid users

  const gatedFeatures = new Set();

  // Issue 2: null + hidden flag instead of delete — preserves payload shape
  for (const [field, feature] of PRO_ONLY_FIELDS) {
    if (payload[field] !== undefined) {
      payload[field]                = null;
      payload[`${field}Hidden`]     = true;
      gatedFeatures.add(feature);
    }
  }

  // Trim comp list to top 3
  if (payload.profitIntel?.items?.length > 3) {
    payload.profitIntel = {
      ...payload.profitIntel,
      items: payload.profitIntel.items.slice(0, 3),
    };
    gatedFeatures.add(FEATURES.FULL_COMP_LIST);
  }

  // Issue 1: Soften signal labels for free users — display label only,
  // underlying buySignal value preserved in profitIntel.buySignal.
  const rawSignal = payload.profitIntel?.buySignal;
  if (rawSignal && FREE_SIGNAL_LABELS[rawSignal]) {
    payload.buySignalLabel = FREE_SIGNAL_LABELS[rawSignal];
  }

  if (gatedFeatures.size > 0) {
    payload.planGating = {
      tier:            "free",
      gatedFeatures:   [...gatedFeatures],
      proFeatureCount: gatedFeatures.size,
      upsellHint:      "Upgrade to Pro to unlock personalized signals, portfolio intelligence, and arbitrage detection.",
    };
  }

  return payload;
}

/**
 * Gate Phase 13 daily feed items: remove financial identity items for free users.
 * Returns filtered arrays.
 */
export function gateFeedItemsForPlan(plan, {
  categoryStrengthItems = [],
  categoryWeaknessItems = [],
  profitMilestoneItem   = null,
} = {}) {
  if (isPaidPlan(plan)) {
    return { categoryStrengthItems, categoryWeaknessItems, profitMilestoneItem };
  }
  return { categoryStrengthItems: [], categoryWeaknessItems: [], profitMilestoneItem: null };
}
