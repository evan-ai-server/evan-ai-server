// src/evanScoreExplainer.js
// Evan Score Explainer: generates a plain-English breakdown of every signal
// that drives Evan's recommendation. The trust layer — users understand WHY
// Evan says what it says, not just what to do.
// "Here's why Evan says BUY: [1] 23% below market [2] Hot demand [3] Low risk"

// ── Signal extraction rules ───────────────────────────────────────────────────
// Each rule: condition fn → { emoji, headline, detail, sentiment }
const SIGNAL_RULES = [
  // ── Price signals ──────────────────────────────────────────────────────────
  {
    id:    "price_steal",
    check: (b) => b?.dealComparator?.verdict === "steal",
    extract: (b) => {
      const pct = b?.dealComparator?.savingsPct ?? b?.dealComparator?.discountPct;
      return {
        emoji: "🔥", sentiment: "positive",
        headline: `Price is ${pct ? pct.toFixed(0) + "% " : ""}below market — this is a steal`,
        detail: `The listed price is significantly under the market median of $${b?.consensus?.median?.toFixed(2) ?? "?"}.`,
      };
    },
  },
  {
    id:    "price_good",
    check: (b) => b?.dealComparator?.verdict === "good",
    extract: (b) => ({
      emoji: "✅", sentiment: "positive",
      headline: "Good price — below market median",
      detail: `Listed at $${b?.scannedPrice?.toFixed?.(2) ?? b?.bestPrice?.toFixed?.(2) ?? "?"}, market median is ~$${b?.consensus?.median?.toFixed(2) ?? "?"}.`,
    }),
  },
  {
    id:    "price_fair",
    check: (b) => b?.dealComparator?.verdict === "fair",
    extract: (b) => ({
      emoji: "📊", sentiment: "neutral",
      headline: "Price is at market — fair but no deal",
      detail: "Listed near the market median. Buy if you need it, but no resale margin here.",
    }),
  },
  {
    id:    "price_high",
    check: (b) => b?.dealComparator?.verdict === "high" || b?.dealComparator?.verdict === "price_trap",
    extract: (b) => ({
      emoji: "⚠️", sentiment: "negative",
      headline: "Overpriced — above market median",
      detail: `Market median is ~$${b?.consensus?.median?.toFixed(2) ?? "?"}. This listing is priced higher than comparables.`,
    }),
  },

  // ── Demand signals ─────────────────────────────────────────────────────────
  {
    id:    "demand_hot",
    check: (b) => b?.demandSignals?.tier === "hot",
    extract: () => ({
      emoji: "🔥", sentiment: "positive",
      headline: "Demand is HOT — sells fast",
      detail: "High sell-through rate in this category right now. Buyers are moving quickly.",
    }),
  },
  {
    id:    "demand_warm",
    check: (b) => b?.demandSignals?.tier === "warm",
    extract: () => ({
      emoji: "📈", sentiment: "positive",
      headline: "Demand is healthy",
      detail: "Consistent buyer activity in this category.",
    }),
  },
  {
    id:    "demand_cold",
    check: (b) => b?.demandSignals?.tier === "cold" || b?.demandSignals?.tier === "cool",
    extract: () => ({
      emoji: "🥶", sentiment: "negative",
      headline: "Demand is weak — slow market",
      detail: "Low sell-through rate. Expect slower resale if you're flipping.",
    }),
  },

  // ── Risk signals ───────────────────────────────────────────────────────────
  {
    id:    "risk_low",
    check: (b) => b?.riskScore?.tier === "safe" || (b?.riskScore?.score ?? 1) < 0.2,
    extract: () => ({
      emoji: "🛡️", sentiment: "positive",
      headline: "Low risk — clean buy",
      detail: "No significant auth risk, condition concerns, or market red flags detected.",
    }),
  },
  {
    id:    "risk_high",
    check: (b) => b?.riskScore?.tier === "risky" || b?.riskScore?.tier === "avoid",
    extract: (b) => ({
      emoji: "🚨", sentiment: "negative",
      headline: `High purchase risk — ${b?.riskScore?.tier}`,
      detail: b?.riskScore?.topFactors?.[0]
        ? `Top concern: ${b.riskScore.topFactors[0]?.label || b.riskScore.topFactors[0]}`
        : "Multiple risk factors detected. Proceed with caution.",
    }),
  },

  // ── Flip signals ───────────────────────────────────────────────────────────
  {
    id:    "flip_legendary",
    check: (b) => (b?.flipScore?.flipScore?.score ?? 0) >= 88,
    extract: (b) => ({
      emoji: "💎", sentiment: "positive",
      headline: `Flip Score ${b.flipScore.flipScore.score}/100 — LEGENDARY opportunity`,
      detail: b?.flipScore?.flipScore?.topSignal || "Exceptional combination of price, demand, and risk.",
    }),
  },
  {
    id:    "flip_hot",
    check: (b) => (b?.flipScore?.flipScore?.score ?? 0) >= 72 && (b?.flipScore?.flipScore?.score ?? 0) < 88,
    extract: (b) => ({
      emoji: "⚡", sentiment: "positive",
      headline: `Flip Score ${b.flipScore.flipScore.score}/100 — strong flip`,
      detail: b?.flipScore?.flipScore?.topSignal || "Good margin with manageable risk.",
    }),
  },

  // ── Condition signals ──────────────────────────────────────────────────────
  {
    id:    "condition_damage",
    check: (b) => b?.conditionForensics?.hasDetectedDamage,
    extract: (b) => {
      const top = b.conditionForensics?.detections?.[0];
      const pct = b.conditionForensics?.impact?.totalImpactPct;
      return {
        emoji: "🔍", sentiment: "negative",
        headline: `Condition issue: ${top?.label ?? "damage detected"} (−${pct ?? "?"}% impact)`,
        detail: `${b.conditionForensics.detections.length} condition issue(s) detected. Fair price: $${b.conditionForensics?.fairConditionPrice?.toFixed(2) ?? "?"}.`,
      };
    },
  },

  // ── Auth signals ───────────────────────────────────────────────────────────
  {
    id:    "auth_risk",
    check: (b) => ["high", "extreme"].includes(b?.authenticityIntel?.riskTier),
    extract: (b) => ({
      emoji: "🚫", sentiment: "negative",
      headline: `Authentication risk: ${b.authenticityIntel?.riskTier}`,
      detail: b?.authenticityIntel?.topSignal || "High fake risk detected. Authenticate before purchasing.",
    }),
  },

  // ── Fake detector signals ──────────────────────────────────────────────────
  {
    id:    "fake_listing",
    check: (b) => (b?.fakeDetector?.listing?.riskScore ?? 0) >= 45,
    extract: (b) => {
      const score = b.fakeDetector.listing.riskScore;
      return {
        emoji: "🚨", sentiment: "negative",
        headline: `Listing fraud risk: ${score}/100`,
        detail: b?.fakeDetector?.listing?.topSignal || `${b.fakeDetector.listing.indicatorCount} fraud indicators detected.`,
      };
    },
  },

  // ── Market momentum ────────────────────────────────────────────────────────
  {
    id:    "momentum_surging",
    check: (b) => b?.marketMomentum?.overallTier === "surging" || b?.marketMomentum?.overallTier === "rising",
    extract: (b) => ({
      emoji: "📈", sentiment: "positive",
      headline: `Market is ${b.marketMomentum.overallTier} — prices moving up`,
      detail: b?.marketMomentum?.topSignal || "Recent sold comps trending higher.",
    }),
  },
  {
    id:    "momentum_falling",
    check: (b) => b?.marketMomentum?.overallTier === "falling" || b?.marketMomentum?.overallTier === "softening",
    extract: (b) => ({
      emoji: "📉", sentiment: "negative",
      headline: `Market is ${b.marketMomentum.overallTier} — prices declining`,
      detail: b?.marketMomentum?.topSignal || "Recent sold comps trending lower.",
    }),
  },

  // ── Resale speed ───────────────────────────────────────────────────────────
  {
    id:    "fast_resale",
    check: (b) => (b?.resaleSpeed?.fastestDays ?? 99) <= 4,
    extract: (b) => ({
      emoji: "⚡", sentiment: "positive",
      headline: `Fast resale: ~${b.resaleSpeed.fastestDays} day${b.resaleSpeed.fastestDays !== 1 ? "s" : ""} on ${b.resaleSpeed.fastestPlatform}`,
      detail: "High sell-through velocity means low holding cost risk.",
    }),
  },

  // ── Seasonal timing ────────────────────────────────────────────────────────
  {
    id:    "seasonal_buy",
    check: (b) => b?.seasonalFlip?.flipTiming?.verdict === "BUY_NOW",
    extract: (b) => ({
      emoji: "🗓️", sentiment: "positive",
      headline: "Good time to buy — seasonal demand dip",
      detail: b?.seasonalFlip?.flipTiming?.signal || "Current month is historically a low-demand window.",
    }),
  },
  {
    id:    "seasonal_sell",
    check: (b) => b?.seasonalFlip?.flipTiming?.verdict === "SELL_NOW",
    extract: (b) => ({
      emoji: "🗓️", sentiment: "positive",
      headline: "Good time to sell — peak demand window",
      detail: b?.seasonalFlip?.flipTiming?.signal || "Current month has historically strong demand.",
    }),
  },

  // ── Price prediction ───────────────────────────────────────────────────────
  {
    id:    "price_dropping",
    check: (b) => b?.priceProjection?.projection?.verdict === "WAIT",
    extract: (b) => ({
      emoji: "⏳", sentiment: "negative",
      headline: "Price expected to drop — consider waiting",
      detail: b?.priceProjection?.projection?.verdictNote || "90-day projection shows significant decline.",
    }),
  },

  // ── Substitute exists ──────────────────────────────────────────────────────
  {
    id:    "substitute_exists",
    check: (b) => b?.smartSubstitutes?.top?.savings > 20,
    extract: (b) => {
      const sub = b.smartSubstitutes.top;
      return {
        emoji: "💡", sentiment: "neutral",
        headline: `Cheaper alternative: ${sub.label} saves ~$${sub.savings.toFixed(0)}`,
        detail: `${sub.typeLabel} — ${sub.note || ""}`.trim(),
      };
    },
  },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Extract all active signals from a full scan result bundle.
 */
export function extractSignals(bundle = {}) {
  const signals = [];

  for (const rule of SIGNAL_RULES) {
    try {
      if (rule.check(bundle)) {
        const signal = rule.extract(bundle);
        signals.push({ id: rule.id, ...signal });
      }
    } catch { /* skip broken rules */ }
  }

  // Sort: negative first (most important), then positive
  const ORDER = { negative: 0, neutral: 1, positive: 2 };
  signals.sort((a, b) => (ORDER[a.sentiment] ?? 1) - (ORDER[b.sentiment] ?? 1));

  return signals;
}

/**
 * Build a numbered plain-English explanation.
 */
export function buildExplanation(bundle = {}) {
  const signals = extractSignals(bundle);
  if (!signals.length) return { signals: [], explanation: "Not enough data to explain this recommendation.", signalCount: 0 };

  const recommendation = bundle?.evanSummary?.recommendation || bundle?.dealComparator?.verdict || "REVIEW";

  const numbered = signals.map((s, i) => ({
    number:    i + 1,
    ...s,
    line:      `[${i + 1}] ${s.emoji} ${s.headline}`,
  }));

  const positives = numbered.filter(s => s.sentiment === "positive");
  const negatives = numbered.filter(s => s.sentiment === "negative");

  const summary = negatives.length > 0 && positives.length > 0
    ? `${positives.length} reason${positives.length !== 1 ? "s" : ""} to buy, ${negatives.length} concern${negatives.length !== 1 ? "s" : ""} to review`
    : negatives.length > 0
    ? `${negatives.length} concern${negatives.length !== 1 ? "s" : ""} — proceed carefully`
    : `${positives.length} positive signal${positives.length !== 1 ? "s" : ""} — looks good`;

  return {
    recommendation,
    summary,
    signals:        numbered,
    signalCount:    signals.length,
    positiveCount:  positives.length,
    negativeCount:  negatives.length,
    topLines:       numbered.slice(0, 5).map(s => s.line),
    explanation:    `Evan says ${recommendation} because: ${numbered.slice(0, 3).map(s => s.headline.toLowerCase()).join("; ")}.`,
  };
}

/**
 * Master Evan score explainer payload.
 */
export function buildEvanScoreExplainerPayload(bundle = {}) {
  const result = buildExplanation(bundle);
  return {
    explainer:  result,
    topSignal:  result.explanation || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
