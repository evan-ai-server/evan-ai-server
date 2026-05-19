// src/personalAgent.js
// Personal AI Agent — "Evan" as a decision-maker.
// Synthesizes all signals into ONE clear action per situation.
// Knows the user's history, style, category preferences, and outcomes.

// ── Action enum ───────────────────────────────────────────────────────────────
// BUY_NOW       — buy immediately, conditions are right
// NEGOTIATE     — try to get a lower price first
// WATCH_PRICE   — add to watchlist, wait for target
// SKIP          — not worth it; save your budget
// SELL_NOW      — if holding, list it today
// HOLD          — keep holding; conditions improving
// RESEARCH_MORE — need more data before deciding

// ── Urgency enum ──────────────────────────────────────────────────────────────
// IMMEDIATE — act today
// SOON      — act within a few days
// MODERATE  — no rush, but don't sleep on it
// LOW       — plenty of time

/**
 * Build the personal agent decision for a given scan/opportunity.
 *
 * @returns {{ action, urgency, reason, support, confidence, agentNote }}
 */
export function buildPersonalAgentDecision({
  buySignal         = null,
  primaryAction     = null,
  timingSignal      = null,
  dealStrength      = 0,
  demandScore       = 0,
  resaleScore       = 0,
  confidenceV2      = 0,
  priceStats        = null,
  warnings          = [],
  category          = "",
  userAffinityScore = 0,    // 0–1, how much this user likes this category
  userHitRate       = null, // null or 0–100, % of buys that were profitable
  portfolioCount    = 0,    // items currently held
  budgetRemaining   = null, // null = unknown
  isWatched         = false,
  isOwned           = false,
  negotiationRoom   = 0,    // estimated % room to negotiate
}) {
  // ── Gate: if already owned, give a hold/sell recommendation ──────────────
  if (isOwned) {
    return buildHoldOrSellDecision({ timingSignal, resaleScore, demandScore, userHitRate });
  }

  // ── Gate: insufficient data → research ───────────────────────────────────
  if (buySignal === "INSUFFICIENT DATA" || confidenceV2 < 0.38) {
    return {
      action:    "RESEARCH_MORE",
      urgency:   "LOW",
      reason:    "Not enough market data to make a confident call",
      support:   ["Try scanning from a different angle", "Search by brand + model number", "Check serial or model number first"],
      confidence: round2(confidenceV2 || 0),
      agentNote: "Evan needs more data before committing.",
    };
  }

  // ── Gate: RISKY or OVERPRICED → skip unless user has strong affinity ──────
  if (["RISKY", "OVERPRICED"].includes(buySignal)) {
    if (userAffinityScore >= 0.75 && dealStrength > 0) {
      return {
        action:    "WATCH_PRICE",
        urgency:   "LOW",
        reason:    `You like ${category || "this category"} but conditions are risky right now`,
        support:   ["Price is above market", "Set a lower target and wait", "Better deals available in this category"],
        confidence: 0.55,
        agentNote: "Strong category interest but not the right deal — watch instead.",
      };
    }
    return {
      action:    "SKIP",
      urgency:   "LOW",
      reason:    buySignal === "OVERPRICED" ? "Priced above what the market supports" : "Too many risk flags on this deal",
      support:   buildSkipReasons(warnings, priceStats),
      confidence: 0.70,
      agentNote: "Evan says skip — this one isn't it.",
    };
  }

  // ── STRONG BUY path ───────────────────────────────────────────────────────
  if (buySignal === "STRONG BUY") {
    // If negotiation room is meaningful (>8%), try to negotiate first
    if (negotiationRoom >= 8 && dealStrength < 0.35) {
      return {
        action:    "NEGOTIATE",
        urgency:   "SOON",
        reason:    `Strong deal, but you may get ${Math.round(negotiationRoom)}% off if you offer below ask`,
        support:   [`Market median: $${priceStats?.median?.toFixed(2) || "?"}`, "Seller has incentive to move quickly", "Offer 85–90% of asking price"],
        confidence: 0.72,
        agentNote: "Great deal but room to improve — try negotiating first.",
      };
    }

    // If timing says wait, still buy now if urgency is very high
    if (timingSignal === "WAIT" && demandScore < 50) {
      return {
        action:    "WATCH_PRICE",
        urgency:   "MODERATE",
        reason:    "Good deal but price may dip further — add to watchlist",
        support:   [`Target: $${priceStats?.low ? (priceStats.low * 0.95).toFixed(2) : "below current"}`, "No strong time pressure on this item"],
        confidence: 0.62,
        agentNote: "Solid signal but price might improve — watch.",
      };
    }

    return {
      action:    "BUY_NOW",
      urgency:   timingSignal === "BUY_NOW" ? "IMMEDIATE" : "SOON",
      reason:    buildBuyNowReason({ dealStrength, demandScore, priceStats, category }),
      support:   buildBuyNowSupport({ dealStrength, demandScore, resaleScore, priceStats, userHitRate }),
      confidence: round2(Math.min(0.95, 0.75 + (dealStrength || 0) * 0.4)),
      agentNote: "Evan says buy — all signals aligned.",
    };
  }

  // ── GOOD DEAL path ────────────────────────────────────────────────────────
  if (buySignal === "GOOD DEAL") {
    if (timingSignal === "WAIT") {
      return {
        action:    "WATCH_PRICE",
        urgency:   "MODERATE",
        reason:    "Good deal — but better timing may be available soon",
        support:   ["Set a target price 10% below current", "Check back in 1–2 weeks", "Demand isn't urgent right now"],
        confidence: 0.60,
        agentNote: "Good deal, questionable timing — wait for the right moment.",
      };
    }
    if (negotiationRoom >= 12) {
      return {
        action:    "NEGOTIATE",
        urgency:   "SOON",
        reason:    "Good deal with room to negotiate lower",
        support:   [`Try offering $${priceStats?.low ? (priceStats.low * 0.92).toFixed(2) : "below ask"}`, `Market low: $${priceStats?.low?.toFixed(2) || "?"}`],
        confidence: 0.65,
        agentNote: "Negotiate down — you have leverage.",
      };
    }
    return {
      action:    "BUY_NOW",
      urgency:   demandScore >= 55 ? "SOON" : "MODERATE",
      reason:    `Solid deal — ${Math.round((dealStrength || 0) * 100)}% below market median`,
      support:   buildBuyNowSupport({ dealStrength, demandScore, resaleScore, priceStats, userHitRate }),
      confidence: round2(0.62 + (dealStrength || 0) * 0.2),
      agentNote: "Good deal — go for it.",
    };
  }

  // ── FAIR path ─────────────────────────────────────────────────────────────
  if (buySignal === "FAIR") {
    if (isWatched) {
      return {
        action:    "WATCH_PRICE",
        urgency:   "LOW",
        reason:    "Price is fair but not compelling — your target might be closer than you think",
        support:   ["Update your target price", "Price is at or near market median", "Keep watching for a better moment"],
        confidence: 0.55,
        agentNote: "You're watching this — nothing has changed. Keep waiting.",
      };
    }
    return {
      action:    "SKIP",
      urgency:   "LOW",
      reason:    "Priced at or above fair market — no edge here",
      support:   ["Market median price — you're not getting a deal", "Better opportunities likely in this category"],
      confidence: 0.58,
      agentNote: "Fair price isn't a deal. Skip unless you need it urgently.",
    };
  }

  // Default fallback
  return {
    action:    "RESEARCH_MORE",
    urgency:   "LOW",
    reason:    "Signal unclear — gather more data",
    support:   ["Try a more specific search query", "Check price history", "Look for more listings"],
    confidence: 0.40,
    agentNote: "Not enough to act on — research first.",
  };
}

/**
 * Build the "next best action" summary for a user's opportunity profile.
 * Given all active watched items, portfolio, and discovery results.
 */
export function buildNextBestAction({
  watchlistAlerts    = [],
  discoveryOpps      = [],
  portfolioItems     = [],
  userHitRate        = null,
  budgetRemaining    = null,
}) {
  // Priority 1: any HIGH alert on watchlist
  const highAlerts = watchlistAlerts.filter((a) => a.priority === "HIGH");
  if (highAlerts.length > 0) {
    const top = highAlerts[0];
    return {
      action:      "BUY_NOW",
      urgency:     "IMMEDIATE",
      target:      `${top.brand || ""} ${top.model || ""}`.trim() || "Watched item",
      reason:      top.reason || "Price hit your target",
      source:      "watchlist_alert",
      alertType:   top.alertType,
      currentPrice: top.currentPrice,
    };
  }

  // Priority 2: top discovery opportunity that's STRONG BUY
  const topDisc = discoveryOpps.find((o) => o.buySignal === "STRONG BUY");
  if (topDisc) {
    return {
      action:      "BUY_NOW",
      urgency:     "SOON",
      target:      [topDisc.brand, topDisc.model].filter(Boolean).join(" ") || topDisc.query,
      reason:      `New strong buy opportunity in ${topDisc.category || "your categories"}`,
      source:      "discovery",
      opportunityScore: topDisc.opportunityScore,
      priceStats:  topDisc.priceStats,
    };
  }

  // Priority 3: portfolio items that should be listed
  const holdTooLong = portfolioItems.filter((item) =>
    item.lifecycleStatus === "HOLDING" &&
    item.purchasedAt &&
    (Date.now() - item.purchasedAt) > 30 * 86400 * 1000, // >30 days
  );
  if (holdTooLong.length > 0) {
    const item = holdTooLong[0];
    return {
      action:  "SELL_NOW",
      urgency: "SOON",
      target:  item.title || item.category || "Portfolio item",
      reason:  "You've been holding this for 30+ days — time to list it",
      source:  "portfolio",
      itemId:  item.itemId,
    };
  }

  // Priority 4: MEDIUM watchlist alert
  const medAlerts = watchlistAlerts.filter((a) => a.priority === "MEDIUM");
  if (medAlerts.length > 0) {
    const top = medAlerts[0];
    return {
      action:      "WATCH_PRICE",
      urgency:     "MODERATE",
      target:      `${top.brand || ""} ${top.model || ""}`.trim() || "Watched item",
      reason:      top.reason || "Price dropped — check this item",
      source:      "watchlist_alert",
      alertType:   top.alertType,
    };
  }

  // Priority 5: Good discovery deals
  const goodDisc = discoveryOpps.find((o) => o.buySignal === "GOOD DEAL");
  if (goodDisc) {
    return {
      action:      "BUY_NOW",
      urgency:     "MODERATE",
      target:      [goodDisc.brand, goodDisc.model].filter(Boolean).join(" ") || goodDisc.query,
      reason:      `Good deal in ${goodDisc.category || "your categories"} — worth a look`,
      source:      "discovery",
      opportunityScore: goodDisc.opportunityScore,
    };
  }

  return {
    action:  "SCAN",
    urgency: "LOW",
    target:  null,
    reason:  "No urgent opportunities right now — keep scanning",
    source:  "default",
  };
}

/**
 * Build user opportunity policy — a personalized decision profile.
 * Used by the agent to weight decisions.
 */
export function buildUserOpportunityPolicy({
  categoryStats       = [],
  userHitRate         = null,
  portfolioCount      = 0,
  avgMarginPct        = null,
  totalRealizedGain   = 0,
}) {
  const bestCat  = categoryStats.sort((a, b) => (b.profitCents || 0) - (a.profitCents || 0))[0];
  const topCats  = categoryStats.slice(0, 3).map((s) => s.category);
  const isNewUser = !userHitRate && portfolioCount === 0;

  const riskProfile = !userHitRate         ? "UNKNOWN"
                    : userHitRate >= 70     ? "PROFITABLE"
                    : userHitRate >= 45     ? "DEVELOPING"
                    : "CAUTIOUS";

  const agentBias = riskProfile === "PROFITABLE" ? "favor-deals"
                  : riskProfile === "CAUTIOUS"    ? "conservative"
                  : "balanced";

  const advice = [];
  if (isNewUser)           advice.push("Scan more items to build your performance profile.");
  if (riskProfile === "PROFITABLE" && avgMarginPct >= 20)
                           advice.push(`Your margins (avg ${avgMarginPct?.toFixed(0)}%) are strong — focus on volume.`);
  if (riskProfile === "CAUTIOUS") advice.push("Hit rate below 45% — stick to STRONG BUY signals for now.");
  if (bestCat)             advice.push(`Your best category is ${bestCat.category} — prioritize it.`);
  if (totalRealizedGain > 500) advice.push(`$${totalRealizedGain.toFixed(0)} realized — reinvest in your top categories.`);

  return {
    riskProfile,
    agentBias,
    topCategories:    topCats,
    bestCategory:     bestCat?.category || null,
    hitRate:          userHitRate,
    avgMarginPct,
    totalRealizedGain,
    advice,
    isNewUser,
    generatedAt:      Date.now(),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHoldOrSellDecision({ timingSignal, resaleScore, demandScore, userHitRate }) {
  if (timingSignal === "SELL_NOW" || (resaleScore >= 75 && demandScore >= 60)) {
    return {
      action:    "SELL_NOW",
      urgency:   "SOON",
      reason:    "Market conditions favor selling now",
      support:   ["Demand is high", "Resale score strong", "List before demand peaks"],
      confidence: 0.72,
      agentNote: "Evan says list it now — conditions are right.",
    };
  }
  return {
    action:    "HOLD",
    urgency:   "LOW",
    reason:    "Hold — market hasn't peaked yet",
    support:   ["Resale conditions not optimal", "Demand score moderate", "Wait for better timing"],
    confidence: 0.58,
    agentNote: "Not the right time to sell — hold.",
  };
}

function buildBuyNowReason({ dealStrength, demandScore, priceStats, category }) {
  if (dealStrength >= 0.35) return `${Math.round(dealStrength * 100)}% below market — exceptional value in ${category || "this category"}`;
  if (demandScore >= 65)    return `High demand + strong deal — ${category || "this item"} moves fast`;
  return `Strong buy signal — below market median of $${priceStats?.median?.toFixed(2) || "?"}`;
}

function buildBuyNowSupport({ dealStrength, demandScore, resaleScore, priceStats, userHitRate }) {
  const support = [];
  if (priceStats?.median) support.push(`Market median: $${priceStats.median.toFixed(2)}`);
  if (dealStrength >= 0.20) support.push(`${Math.round(dealStrength * 100)}% below median`);
  if (demandScore >= 50)  support.push(`Demand score: ${Math.round(demandScore)}/100`);
  if (resaleScore >= 70)  support.push(`Resale score: ${Math.round(resaleScore)}/100 — flippable`);
  if (userHitRate >= 60)  support.push(`Your hit rate: ${userHitRate}% — trust your instincts`);
  return support.slice(0, 4);
}

function buildSkipReasons(warnings = [], priceStats) {
  const reasons = [];
  if (priceStats?.median) reasons.push(`Market median: $${priceStats.median.toFixed(2)}`);
  const hasConflict = warnings.some((w) => w.type?.includes("conflict") || w.code?.includes("conflict"));
  if (hasConflict)  reasons.push("Vision and market data conflict — verify manually");
  const hasLowConf  = warnings.some((w) => w.type === "low_confidence");
  if (hasLowConf)   reasons.push("Low identification confidence — check item details first");
  if (reasons.length === 0) reasons.push("Better opportunities exist in this category");
  return reasons.slice(0, 3);
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
