// src/dailyFeed.js
// Daily Opportunity Feed — personalized ranked deal surface.
// Sections: watchlist alerts, discovery opportunities, missed follow-ups, portfolio actions.
// Deduped, scored, and section-sorted by urgency.
// Designed to pull users back daily with actionable intel — no dark patterns.

import { shouldSellBeforeBuying, buildFullExitIntel } from "./exitIntelligence.js";

// ── Feed section types ────────────────────────────────────────────────────────
// ALERT                  — watchlist alert (target hit / new low / relist / similar / escalation)
// SELL_FIRST             — portfolio item that must sell before buying more
// LIST_NOW               — item ready to list (20+ days held, market stable)
// DISCOUNT_NOW           — item needs price cut to move (stale / market dropped)
// WRONG_CALL             — Evan's STRONG BUY that resulted in a loss (non-dismissible)
// GOOD_CALL_CONFIRMED    — Evan's STRONG BUY confirmed by realized profit (positive signal)
// CATEGORY_SUSPENSION    — user has repeated losses in a category
// PERSONAL_WARNING       — user-specific pattern enforcement (failure fingerprint, mode change)
// SKILL_CONFIRMED        — user has reached COMPETENT or EXPERT mastery in a category
// HOLD_CONFIRMED         — item should be held — market conditions haven't turned yet
// ARBITRAGE              — cross-platform arbitrage opportunity (strict identity match)
// VELOCITY_DROP          — rapid price drop with seller urgency signals
// DEAL_SCOUT             — proactive buy target from scout engine (personalized, not generic)
// REINVESTMENT_ANALOG    — live analog for a missed opportunity (high-confidence match only)
// DISCOVERY              — new deal found in user's categories
// MISSED                 — past pass that could inform future decisions
// MISSED_PROFIT          — pass with real traceable evidence price rose after scan
// PORTFOLIO_ACTION       — portfolio item needing attention
// RESCAN                 — previously scanned item with price movement
// TIP                    — personalized tip based on scan pattern
// CATEGORY_STRENGTH      — user is consistently profitable in a category (real P&L evidence)
// CATEGORY_WEAKNESS      — user is consistently losing money in a category (real P&L evidence)
// PROFIT_MILESTONE       — user crossed a realized net-profit milestone

// ── Feed entry schema ─────────────────────────────────────────────────────────
// { feedId, section, priority, title, subtitle, body, action, actionData,
//   score, generatedAt }

/**
 * Build the complete daily opportunity feed for a user.
 *
 * @returns {{ sections, totalCount, hasHighPriority, generatedAt }}
 */
export function buildDailyOpportunityFeed({
  watchlistAlerts      = [],
  discoveryOpps        = [],
  missedOpps           = [],
  portfolioItems       = [],
  categoryStats        = [],
  userPolicy           = null,
  rescanDrifts         = [],
  wrongCallItems       = [],       // { scanId, signal, outcome, gateSuspected, scannedAt }
  goodCallItems        = [],       // { scanId, signal, realizedProfit, category, soldAt } — GOOD_CALL_CONFIRMED
  missedProfitItems    = [],       // { scanId, passedAt, priceAtScan, priceNow, delta, category } — MISSED_PROFIT
  categorySuspensions  = [],       // { category, lossCount, winRate, winningAlts }
  personalWarnings     = [],       // { message, category, patternType, matchCount } — PERSONAL_WARNING
  skillConfirmedItems  = [],       // { category, masteryLevel, sbWinRate, totalSamples } — SKILL_CONFIRMED
  listNowItems         = [],       // { scanId, category, purchasePrice, daysHeld, exitIntel } — LIST_NOW
  discountNowItems     = [],       // { scanId, category, purchasePrice, daysHeld, exitIntel, repriceDelta } — DISCOUNT_NOW
  holdConfirmedItems   = [],       // { scanId, category, daysHeld, exitIntel, holdReason } — HOLD_CONFIRMED
  arbitrageItems       = [],       // { arbitrageId, buyPlatform, sellPlatform, netDollars, ... } — ARBITRAGE
  velocityAlerts       = [],       // from analyzeVelocityForItem — VELOCITY_DROP
  scoutTargets         = [],       // from buildDealScoutTargets — DEAL_SCOUT
  reinvestmentCards    = [],       // from buildReinvestmentCards — REINVESTMENT_ANALOG
  // Phase 13: behavioral lock-in — financial identity surfaces
  categoryStrengthItems = [],    // [{ category, netProfitRealized, winRate, totalTrades, masteryLevel }]
  categoryWeaknessItems = [],    // [{ category, netProfitRealized, winRate, totalTrades, lossCount }]
  profitMilestoneItem   = null,  // { milestone, netProfitRealized, nextMilestone } | null
  limit                = 25,
}) {
  const entries = [];

  // ── Section 0: Sell-first cards — prepend before any buy opportunities ────
  if (shouldSellBeforeBuying(portfolioItems)) {
    const now = Date.now();
    for (const item of portfolioItems) {
      const addedAt  = Number(item?.addedAt ?? item?.purchasedAt);
      if (!addedAt) continue;
      const daysHeld = Math.round((now - addedAt) / 86400000);
      if (daysHeld <= 45) continue;
      entries.push(buildSellFirstEntry(item, daysHeld));
    }
  }

  // ── Section 0b: Wrong-call cards — non-dismissible acknowledgments ────────
  for (const wc of wrongCallItems.slice(0, 2)) {
    entries.push(buildWrongCallEntry(wc));
  }

  // ── Section 0d: Good-call confirmed — positive reinforcement (realized) ──
  // Only surfaces when realizedProfit is a confirmed actual value (not estimated).
  for (const gc of goodCallItems.slice(0, 2)) {
    entries.push(buildGoodCallConfirmedEntry(gc));
  }

  // ── Section 0c: Category suspension cards ────────────────────────────────
  for (const cs of categorySuspensions.slice(0, 2)) {
    entries.push(buildCategorySuspensionEntry(cs));
  }

  // ── Section 0e: Personal warnings (failure fingerprint enforcement) ────────
  // Only surfaces confirmed enforcement events, not informational notices.
  for (const pw of personalWarnings.filter((w) => w?.message && w.matchCount >= 3).slice(0, 2)) {
    entries.push(buildPersonalWarningEntry(pw));
  }

  // ── Section 0f: Skill confirmed (mastery milestone reached) ───────────────
  // Only surfaces when user reaches COMPETENT or EXPERT for the first time.
  for (const sk of skillConfirmedItems.filter((s) => ["COMPETENT", "EXPERT"].includes(s?.masteryLevel)).slice(0, 2)) {
    entries.push(buildSkillConfirmedEntry(sk));
  }

  // ── Phase 13: Category weakness — surfaces before buy opportunities ─────────
  // Only fires for categories with real negative P&L (≥3 completed trades).
  for (const cw of categoryWeaknessItems.slice(0, 2)) {
    entries.push(buildCategoryWeaknessEntry(cw));
  }

  // ── Phase 13: Profit milestones — real realized P&L crossing a threshold ───
  if (profitMilestoneItem) {
    entries.push(buildProfitMilestoneEntry(profitMilestoneItem));
  }

  // ── Phase 13: Category strength — best performing categories ─────────────
  for (const cs of categoryStrengthItems.slice(0, 2)) {
    entries.push(buildCategoryStrengthEntry(cs));
  }

  // ── Section 0g: List-now cards — portfolio items ready to list ─────────────
  for (const item of listNowItems.slice(0, 3)) {
    entries.push(buildListNowEntry(item));
  }

  // ── Section 0h: Discount-now cards — stale items needing a price cut ───────
  for (const item of discountNowItems.slice(0, 3)) {
    entries.push(buildDiscountNowEntry(item));
  }

  // ── Section 0i: Hold confirmed — positive hold signal ─────────────────────
  for (const item of holdConfirmedItems.slice(0, 2)) {
    entries.push(buildHoldConfirmedEntry(item));
  }

  // ── Section 0j: Arbitrage opportunities ───────────────────────────────────
  // Only surfaces strict identity-matched arbitrage, never fuzzy matches.
  for (const arb of arbitrageItems.filter(a => a?.score >= 40).slice(0, 2)) {
    entries.push(buildArbitrageEntry(arb));
  }

  // ── Section 0k: Velocity drop alerts ──────────────────────────────────────
  // Only RAPID tier, still below market median, rate-limited.
  for (const va of velocityAlerts.filter(a => a?.velocityTier === "RAPID").slice(0, 3)) {
    entries.push(buildVelocityEntry(va));
  }

  // ── Section 1: Watchlist alerts (highest priority) ────────────────────────
  for (const alert of watchlistAlerts.slice(0, 5)) {
    entries.push(buildAlertEntry(alert));
  }

  // ── Section 2: Discovery opportunities ────────────────────────────────────
  const topDiscs = rankDiscoveryForFeed(discoveryOpps, 8);
  for (const opp of topDiscs) {
    entries.push(buildDiscoveryEntry(opp));
  }

  // ── Section 2b: Deal Scout targets ────────────────────────────────────────
  // Personalized proactive targets. Max 5, minimum opportunityScore 55.
  for (const scout of scoutTargets.slice(0, 5)) {
    entries.push(buildScoutEntry(scout));
  }

  // ── Section 2c: Reinvestment analogs ──────────────────────────────────────
  // Only surfaces when a strong live analog exists for a missed opportunity.
  for (const card of reinvestmentCards.slice(0, 2)) {
    if (card.section === "REINVESTMENT_ANALOG") {
      entries.push(card); // already formatted by buildReinvestmentCard
    }
  }

  // ── Section 3: Portfolio actions ──────────────────────────────────────────
  const portActions = detectPortfolioActions(portfolioItems);
  for (const action of portActions.slice(0, 3)) {
    entries.push(action);
  }

  // ── Section 4: Rescan drifts (verdict changed) ────────────────────────────
  const drifts = rescanDrifts.filter((d) => d.verdictChanged).slice(0, 2);
  for (const drift of drifts) {
    entries.push(buildRescanEntry(drift));
  }

  // ── Section 5: Missed opportunities (learning) ────────────────────────────
  const topMissed = missedOpps
    .filter((m) => m.buySignal === "STRONG BUY")
    .slice(0, 2);
  for (const missed of topMissed) {
    entries.push(buildMissedEntry(missed));
  }

  // ── Section 5b: Missed profit — real traceable evidence (not speculative) ─
  // Only surfaces when priceAtScan, priceNow, and delta are from real market data,
  // not fabricated or estimated from scan-time signals.
  const topMissedProfit = missedProfitItems
    .filter((m) => m.delta != null && m.delta > 0 && m.priceAtScan != null && m.priceNow != null)
    .slice(0, 2);
  for (const mp of topMissedProfit) {
    entries.push(buildMissedProfitEntry(mp));
  }

  // ── Section 6: Personalized tip ───────────────────────────────────────────
  const tip = buildPersonalizedTip({ categoryStats, userPolicy, watchlistAlerts, discoveryOpps });
  if (tip) entries.push(tip);

  // Dedup + rank + cap
  const ranked = rankFeedSections(dedupeFeedItems(entries), limit);

  const hasHighPriority = ranked.some((e) => e.priority === "HIGH" || e.section === "ALERT"
    || e.section === "SELL_FIRST" || e.section === "WRONG_CALL");

  return {
    sections:        groupFeedBySections(ranked),
    flatFeed:        ranked,
    totalCount:      ranked.length,
    hasHighPriority,
    generatedAt:     Date.now(),
  };
}

/**
 * Rank feed entries: alerts first, then by score desc.
 */
export function rankFeedSections(entries = [], limit = 25) {
  const SECTION_ORDER = {
    SELL_FIRST: 0, WRONG_CALL: 0, CATEGORY_SUSPENSION: 0, PERSONAL_WARNING: 0,
    CATEGORY_WEAKNESS: 0,   // Phase 13: financial loss pattern — high priority warning
    ARBITRAGE: 1, VELOCITY_DROP: 1, ALERT: 1,
    PORTFOLIO_ACTION: 2, LIST_NOW: 2, DISCOUNT_NOW: 2,
    GOOD_CALL_CONFIRMED: 3, SKILL_CONFIRMED: 3,
    PROFIT_MILESTONE: 3,    // Phase 13: realized profit milestone — alongside positive signals
    CATEGORY_STRENGTH: 3,   // Phase 13: best category confirmation — alongside skill signals
    DEAL_SCOUT: 4, DISCOVERY: 4, REINVESTMENT_ANALOG: 4, HOLD_CONFIRMED: 4,
    RESCAN: 5, MISSED: 6, MISSED_PROFIT: 7, TIP: 8,
  };
  return entries
    .sort((a, b) => {
      const sectionDiff = (SECTION_ORDER[a.section] ?? 9) - (SECTION_ORDER[b.section] ?? 9);
      if (sectionDiff !== 0) return sectionDiff;
      return (b.score || 0) - (a.score || 0);
    })
    .slice(0, limit);
}

/**
 * Dedup feed entries by fingerprint / key.
 */
export function dedupeFeedItems(entries = []) {
  const seen = new Set();
  return entries.filter((e) => {
    if (!e) return false;
    const key = e.dedupeKey || e.feedId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Hydrate raw discovery/alert data into feed cards.
 * Convenience wrapper for API response building.
 */
export function hydrateFeedCards(flatFeed = []) {
  return flatFeed.map((entry) => ({
    ...entry,
    // Ensure all required display fields are present
    title:    entry.title    || "Opportunity",
    subtitle: entry.subtitle || "",
    body:     entry.body     || null,
    action:   entry.action   || null,
  }));
}

// ── Entry builders ────────────────────────────────────────────────────────────

function buildSellFirstEntry(item, daysHeld) {
  const name    = item?.title || item?.model || item?.category || "Item";
  const hof     = item?.exitIntel?.holdOrFold || "LIST_NOW";
  const price   = item?.exitIntel?.recommendedListPrice;
  const plat    = item?.exitIntel?.preferredPlatform;
  const priceStr = price ? ` at $${Number(price).toFixed(0)}` : "";
  const platStr  = plat  ? ` on ${plat}` : "";
  return {
    feedId:      `sell_first_${item.itemId || item.id}_${Date.now()}`,
    dedupeKey:   `sell_first_${item.itemId || item.id}`,
    section:     "SELL_FIRST",
    priority:    "HIGH",
    title:       `Sell ${name} first — held ${daysHeld} days`,
    subtitle:    `List${priceStr}${platStr} before buying more`,
    body:        hof === "DISCOUNT"
      ? "This item has been sitting. Consider reducing price to move it."
      : "Capital is locked. Free it up before taking on new inventory.",
    action:      "VIEW_PORTFOLIO_ITEM",
    actionData:  {
      portfolioItemId:      item.itemId || item.id,
      itemName:             name,
      holdOrFold:           hof,
      recommendedListPrice: price ?? null,
      preferredPlatform:    plat ?? null,
    },
    score:       100,
    generatedAt: Date.now(),
    dismissible: false,
  };
}

function buildWrongCallEntry(wc) {
  return {
    feedId:      `wrong_call_${wc.scanId}_${Date.now()}`,
    dedupeKey:   `wrong_call_${wc.scanId}`,
    section:     "WRONG_CALL",
    priority:    "HIGH",
    title:       `Evan called ${wc.signal || "STRONG BUY"} — you lost money`,
    subtitle:    wc.gateSuspected
      ? `Likely cause: ${wc.gateSuspected}`
      : "We're analyzing what went wrong",
    body:        [
      `Original signal: ${wc.signal || "STRONG BUY"}`,
      wc.outcome != null ? `Outcome: $${Number(wc.outcome) > 0 ? "+" : ""}${Number(wc.outcome).toFixed(0)}` : null,
      wc.gateSuspected ? `What failed: ${wc.gateSuspected}` : null,
      "Evan has adjusted calibration for this category.",
    ].filter(Boolean).join(" · "),
    action:      "VIEW_SCAN",
    actionData:  { scanId: wc.scanId },
    score:       95,
    generatedAt: Date.now(),
    dismissible: false,      // non-dismissible for 24h
    expiresAt:   Date.now() + 24 * 3600 * 1000,
  };
}

function buildCategorySuspensionEntry(cs) {
  const winningStr = Array.isArray(cs.winningAlts) && cs.winningAlts.length
    ? `Your stronger categories: ${cs.winningAlts.slice(0, 2).join(", ")}.`
    : null;
  return {
    feedId:      `cat_suspend_${cs.category}_${Date.now()}`,
    dedupeKey:   `cat_suspend_${cs.category}`,
    section:     "CATEGORY_SUSPENSION",
    priority:    "HIGH",
    title:       `Pause buying ${cs.category}`,
    subtitle:    `${cs.lossCount} losses — ${Math.round((cs.winRate ?? 0) * 100)}% win rate in this category`,
    body:        [
      `You've lost ${cs.lossCount} of your last buys in ${cs.category}.`,
      "Evan recommends pausing until your track record improves.",
      winningStr,
    ].filter(Boolean).join(" "),
    action:      "BROWSE_CATEGORY",
    actionData:  { category: cs.winningAlts?.[0] || null },
    score:       90,
    generatedAt: Date.now(),
    dismissible: true,
  };
}

function buildAlertEntry(alert) {
  const title = [alert.brand, alert.model].filter(Boolean).join(" ") || "Watched item";
  return {
    feedId:     `alert_${alert.itemId || alert.alertType}_${Date.now()}`,
    dedupeKey:  `alert_${alert.itemId}`,
    section:    "ALERT",
    priority:   alert.priority || "HIGH",
    title,
    subtitle:   alertSubtitle(alert),
    body:       alert.reason || null,
    action:     "VIEW_LISTING",
    actionData: { itemId: alert.itemId, alertType: alert.alertType, currentPrice: alert.currentPrice },
    score:      alert.priority === "HIGH" ? 100 : 80,
    generatedAt: Date.now(),
  };
}

function buildDiscoveryEntry(opp) {
  const title = [opp.brand, opp.model].filter(Boolean).join(" ") || opp.query || "New opportunity";
  return {
    feedId:     opp.discoveryId || `disc_${Date.now()}`,
    dedupeKey:  `disc_${opp.fingerprint || opp.query}`,
    section:    "DISCOVERY",
    priority:   opp.buySignal === "STRONG BUY" ? "HIGH" : opp.buySignal === "GOOD DEAL" ? "MEDIUM" : "LOW",
    title,
    subtitle:   discSubtitle(opp),
    body:       opp.reasoning || null,
    action:     "SEARCH",
    actionData: { query: opp.query, category: opp.category, priceStats: opp.priceStats },
    score:      opp.opportunityScore || 50,
    generatedAt: Date.now(),
  };
}

function buildRescanEntry(drift) {
  return {
    feedId:     `rescan_${drift.scanId}_${Date.now()}`,
    dedupeKey:  `rescan_${drift.scanId}`,
    section:    "RESCAN",
    priority:   "MEDIUM",
    title:      "Price signal changed on a saved scan",
    subtitle:   drift.verdictDelta ? `Verdict: ${drift.verdictDelta}` : "Market conditions changed",
    body:       drift.currentReasoning || null,
    action:     "VIEW_SCAN",
    actionData: { scanId: drift.scanId, verdictDelta: drift.verdictDelta },
    score:      60,
    generatedAt: Date.now(),
  };
}

function buildMissedEntry(missed) {
  const title = [missed.brand, missed.model].filter(Boolean).join(" ") || missed.query || "Past deal";
  return {
    feedId:     `missed_${missed.missedId || Date.now()}`,
    dedupeKey:  `missed_${missed.missedId}`,
    section:    "MISSED",
    priority:   "LOW",
    title:      `You passed on a ${missed.buySignal} — ${title}`,
    subtitle:   missed.potentialProfit > 0
      ? `$${missed.potentialProfit.toFixed(2)} potential profit left on the table`
      : "Strong buy signal you didn't act on",
    body:       missed.lesson?.tip || null,
    action:     "SET_ALERT",
    actionData: { category: missed.category, query: missed.query },
    score:      40,
    generatedAt: Date.now(),
  };
}

function buildPersonalWarningEntry(pw) {
  const catStr = pw.category ? ` in ${pw.category}` : "";
  return {
    feedId:      `personal_warn_${pw.category || "global"}_${Date.now()}`,
    dedupeKey:   `personal_warn_${pw.category || "global"}_${pw.patternType || "fingerprint"}`,
    section:     "PERSONAL_WARNING",
    priority:    "HIGH",
    title:       `This pattern has failed you ${pw.matchCount} times${catStr}`,
    subtitle:    pw.message || "Evan adjusted the signal based on your history",
    body:        [
      pw.patternType ? `Pattern type: ${pw.patternType}` : null,
      pw.category    ? `Category: ${pw.category}` : null,
      `${pw.matchCount} matching losses recorded — Evan downgraded the signal`,
    ].filter(Boolean).join(" · "),
    action:      "VIEW_HISTORY",
    actionData:  { category: pw.category || null },
    score:       88,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:   Date.now() + 48 * 3600 * 1000,
  };
}

function buildSkillConfirmedEntry(sk) {
  const levelLabel = sk.masteryLevel === "EXPERT" ? "Expert" : "Competent";
  const winStr = sk.sbWinRate != null ? `${sk.sbWinRate}% win rate` : null;
  const sampStr = sk.totalSamples ? `${sk.totalSamples} outcomes` : null;
  return {
    feedId:      `skill_${sk.category}_${Date.now()}`,
    dedupeKey:   `skill_${sk.category}_${sk.masteryLevel}`,
    section:     "SKILL_CONFIRMED",
    priority:    "MEDIUM",
    title:       `${levelLabel} buyer in ${sk.category}`,
    subtitle:    [winStr, sampStr].filter(Boolean).join(" · ") || `${levelLabel} mastery reached`,
    body:        sk.masteryLevel === "EXPERT"
      ? `You've built a strong track record in ${sk.category}. For low-dollar items, your judgment is reliable.`
      : `Your results in ${sk.category} are improving — keep scanning to build further accuracy.`,
    action:      "BROWSE_CATEGORY",
    actionData:  { category: sk.category },
    score:       65,
    generatedAt: Date.now(),
    dismissible: true,
  };
}

function buildGoodCallConfirmedEntry(gc) {
  const profitStr = gc.realizedProfit != null
    ? `+$${Number(gc.realizedProfit).toFixed(2)} confirmed`
    : "Profit confirmed";
  const catStr = gc.category ? ` in ${gc.category}` : "";
  return {
    feedId:      `good_call_${gc.scanId}_${Date.now()}`,
    dedupeKey:   `good_call_${gc.scanId}`,
    section:     "GOOD_CALL_CONFIRMED",
    priority:    "MEDIUM",
    title:       `${gc.signal || "STRONG BUY"} paid off${catStr}`,
    subtitle:    profitStr,
    body:        [
      `Signal: ${gc.signal || "STRONG BUY"}`,
      gc.soldAt ? `Sold: ${new Date(gc.soldAt).toLocaleDateString()}` : null,
      gc.category ? `Category: ${gc.category}` : null,
    ].filter(Boolean).join(" · "),
    action:      "VIEW_SCAN",
    actionData:  { scanId: gc.scanId },
    score:       70,
    generatedAt: Date.now(),
    dismissible: true,
  };
}

function buildMissedProfitEntry(mp) {
  const delta   = Number(mp.delta);
  const pctStr  = mp.priceAtScan > 0
    ? ` (up ${Math.round(((mp.priceNow - mp.priceAtScan) / mp.priceAtScan) * 100)}%)`
    : "";
  const catStr  = mp.category ? ` · ${mp.category}` : "";
  return {
    feedId:      `missed_profit_${mp.scanId}_${Date.now()}`,
    dedupeKey:   `missed_profit_${mp.scanId}`,
    section:     "MISSED_PROFIT",
    priority:    "LOW",
    title:       `Price rose $${delta.toFixed(2)} after your pass${catStr}`,
    subtitle:    `Was $${Number(mp.priceAtScan).toFixed(2)}, now $${Number(mp.priceNow).toFixed(2)}${pctStr}`,
    body:        [
      "Price movement confirmed by current market data — not estimated.",
      mp.passedAt ? `You scanned: ${new Date(mp.passedAt).toLocaleDateString()}` : null,
    ].filter(Boolean).join(" "),
    action:      "VIEW_SCAN",
    actionData:  { scanId: mp.scanId },
    score:       35,
    generatedAt: Date.now(),
    dismissible: true,
  };
}

function buildArbitrageEntry(arb) {
  const netStr  = `+$${Number(arb.netDollars).toFixed(0)} net`;
  const spread  = `${Number(arb.netMarginPct || arb.netPct * 100).toFixed(0)}% spread`;
  return {
    feedId:      `arb_${arb.arbitrageId || Date.now()}`,
    dedupeKey:   `arb_${arb.buyPlatform}_${arb.sellPlatform}_${Math.round(arb.buyPrice)}_${Math.round(arb.sellPrice)}`,
    section:     "ARBITRAGE",
    priority:    arb.score >= 65 ? "HIGH" : "MEDIUM",
    title:       `Arbitrage: ${arb.brand || ""} ${arb.model || ""}`.trim() || "Cross-platform arbitrage",
    subtitle:    `Buy ${arb.buyPlatform} at $${Number(arb.buyPrice).toFixed(0)} → sell ${arb.sellPlatform} at $${Number(arb.sellPrice).toFixed(0)} — ${netStr} (${spread})`,
    body:        arb.reasoning || null,
    action:      "VIEW_LISTING",
    actionData:  {
      url:          arb.buyListingUrl || null,
      buyPlatform:  arb.buyPlatform,
      sellPlatform: arb.sellPlatform,
      buyPrice:     arb.buyPrice,
      sellPrice:    arb.sellPrice,
      netProfit:    arb.netDollars,
    },
    score:       arb.score || 50,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:   Date.now() + 12 * 3600 * 1000, // arbitrage windows close fast
  };
}

function buildVelocityEntry(va) {
  return {
    feedId:      `vel_${va.fingerprint || Date.now()}_${Date.now()}`,
    dedupeKey:   `vel_${va.fingerprint || va.title}_${Math.round(va.currentPrice || 0)}`,
    section:     "VELOCITY_DROP",
    priority:    va.priority || "MEDIUM",
    title:       va.title || "Rapid price drop detected",
    subtitle:    va.reason,
    body:        va.urgencySignals?.length ? va.urgencySignals.join(" · ") : null,
    action:      va.url ? "VIEW_LISTING" : "SEARCH",
    actionData:  {
      url:          va.url || null,
      currentPrice: va.currentPrice,
      buySignal:    va.buySignal,
    },
    score:       va.buySignal === "STRONG BUY" ? 85 : 72,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:   Date.now() + 8 * 3600 * 1000, // velocity signals expire quickly
  };
}

function buildScoutEntry(scout) {
  return {
    feedId:      scout.scoutId || `scout_${Date.now()}`,
    dedupeKey:   scout.dedupeKey || `scout_${scout.fingerprint || scout.query}`,
    section:     "DEAL_SCOUT",
    priority:    scout.buySignal === "STRONG BUY" ? "HIGH" : "MEDIUM",
    title:       `Scout target: ${[scout.brand, scout.model].filter(Boolean).join(" ") || scout.query || scout.category}`,
    subtitle:    scout.whyThisItem || scout.whyNow,
    body:        scout.whatToDo || null,
    action:      "SEARCH",
    actionData:  {
      query:    scout.query,
      category: scout.category,
      priceTarget: scout.priceTarget,
    },
    score:       scout.opportunityScore || 55,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:   Date.now() + 24 * 3600 * 1000,
  };
}

function buildListNowEntry(item) {
  const name   = item?.title || item?.category || "Item";
  const plat   = item?.exitIntel?.preferredPlatform;
  const price  = item?.exitIntel?.recommendedListPrice;
  const conf   = item?.exitIntel?.exitConfidence;
  const priceStr = price ? `$${Number(price).toFixed(0)}` : null;
  const platStr  = plat  ? ` on ${plat}` : "";
  const confStr  = conf  != null ? `${conf}% exit confidence` : null;
  return {
    feedId:      `list_now_${item.scanId || item.itemId}_${Date.now()}`,
    dedupeKey:   `list_now_${item.scanId || item.itemId}`,
    section:     "LIST_NOW",
    priority:    "MEDIUM",
    title:       `List ${name} now — ${item.daysHeld || 0} days held`,
    subtitle:    [priceStr ? `${priceStr}${platStr}` : null, confStr].filter(Boolean).join(" · ") || "Good time to list — market is stable",
    body:        item.exitIntel?.relistTiming?.reason || "Market conditions favor listing now.",
    action:      "VIEW_PORTFOLIO_ITEM",
    actionData:  {
      scanId:               item.scanId || item.itemId,
      category:             item.category,
      holdOrFold:           "LIST_NOW",
      recommendedListPrice: price ?? null,
      preferredPlatform:    plat ?? null,
    },
    score:       72,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:   Date.now() + 72 * 3600 * 1000,
  };
}

function buildDiscountNowEntry(item) {
  const name    = item?.title || item?.category || "Item";
  const delta   = item?.exitIntel?.repriceDelta;
  const price   = item?.exitIntel?.recommendedListPrice;
  const plat    = item?.exitIntel?.preferredPlatform;
  const dropStr = delta ? `-$${Number(delta.dropAmount).toFixed(0)} (${Number(delta.dropPct).toFixed(0)}% off ask)` : null;
  const priceStr = price ? `Target: $${Number(price).toFixed(0)}` : null;
  return {
    feedId:      `discount_now_${item.scanId || item.itemId}_${Date.now()}`,
    dedupeKey:   `discount_now_${item.scanId || item.itemId}`,
    section:     "DISCOUNT_NOW",
    priority:    (item.capitalRisk === "CRITICAL" || item.capitalRisk === "HIGH") ? "HIGH" : "MEDIUM",
    title:       `Reprice ${name} to move it`,
    subtitle:    [dropStr, priceStr].filter(Boolean).join(" · ") || `${item.daysHeld || 0} days without sale — reduce ask`,
    body:        delta?.reason || item.exitIntel?.relistTiming?.reason || "Price reduction recommended to compete with current market.",
    action:      "VIEW_PORTFOLIO_ITEM",
    actionData:  {
      scanId:               item.scanId || item.itemId,
      category:             item.category,
      holdOrFold:           "DISCOUNT",
      recommendedListPrice: price ?? null,
      preferredPlatform:    plat ?? null,
      repriceDelta:         delta ?? null,
    },
    score:       item.capitalRisk === "CRITICAL" ? 92 : item.capitalRisk === "HIGH" ? 82 : 65,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:   Date.now() + 48 * 3600 * 1000,
  };
}

function buildHoldConfirmedEntry(item) {
  const name   = item?.title || item?.category || "Item";
  const price  = item?.exitIntel?.recommendedListPrice;
  const conf   = item?.exitIntel?.exitConfidence;
  const timing = item?.exitIntel?.relistTiming;
  const trigStr = timing?.triggerDays > 0 ? `Revisit in ${timing.triggerDays} days` : null;
  const confStr = conf != null ? `${conf}% exit confidence` : null;
  return {
    feedId:      `hold_${item.scanId || item.itemId}_${Date.now()}`,
    dedupeKey:   `hold_${item.scanId || item.itemId}`,
    section:     "HOLD_CONFIRMED",
    priority:    "LOW",
    title:       `Hold ${name} — not yet time to sell`,
    subtitle:    item.holdReason || [trigStr, confStr].filter(Boolean).join(" · ") || "Market hasn't peaked yet for this item",
    body:        timing?.reason || null,
    action:      "VIEW_PORTFOLIO_ITEM",
    actionData:  {
      scanId:               item.scanId || item.itemId,
      category:             item.category,
      holdOrFold:           "HOLD",
      recommendedListPrice: price ?? null,
    },
    score:       30,
    generatedAt: Date.now(),
    dismissible: true,
  };
}

function buildPersonalizedTip({ categoryStats, userPolicy, watchlistAlerts, discoveryOpps }) {
  if (!userPolicy) return null;

  let title, body, action, actionData;

  if (userPolicy.isNewUser) {
    title  = "Scan your first item to build your deal profile";
    body   = "Evan learns from every scan — the more you scan, the smarter the recommendations";
    action = "START_SCAN";
  } else if (userPolicy.riskProfile === "CAUTIOUS") {
    title  = "Tip: Focus on STRONG BUY signals only";
    body   = `Your hit rate is ${userPolicy.hitRate?.toFixed(0) || "low"}% — be selective. Only act on Evan's strongest signals.`;
    action = "LEARN_MORE";
  } else if (userPolicy.bestCategory) {
    const catDiscoveries = discoveryOpps.filter((o) => o.category === userPolicy.bestCategory);
    if (catDiscoveries.length > 0) {
      title  = `New ${userPolicy.bestCategory} deals in your top category`;
      body   = `${catDiscoveries.length} opportunity${catDiscoveries.length > 1 ? "ies" : "y"} found — your strongest category`;
      action = "BROWSE_CATEGORY";
      actionData = { category: userPolicy.bestCategory };
    }
  }

  if (!title) return null;

  return {
    feedId:      `tip_${Date.now()}`,
    dedupeKey:   `tip_policy`,
    section:     "TIP",
    priority:    "LOW",
    title,
    subtitle:    "Personalized for you",
    body,
    action:      action || "DISMISS",
    actionData:  actionData || {},
    score:       20,
    generatedAt: Date.now(),
  };
}

// ── Portfolio action detection ─────────────────────────────────────────────────

function detectPortfolioActions(portfolioItems = []) {
  const entries = [];
  const now = Date.now();

  for (const item of portfolioItems) {
    if (!item) continue;

    // Held for >45 days → suggest listing
    if (item.lifecycleStatus === "HOLDING" && item.purchasedAt) {
      const held = (now - item.purchasedAt) / 86400000;
      if (held >= 45) {
        entries.push({
          feedId:     `port_action_${item.itemId}_${Date.now()}`,
          dedupeKey:  `port_action_${item.itemId}`,
          section:    "PORTFOLIO_ACTION",
          priority:   held >= 90 ? "HIGH" : "MEDIUM",
          title:      `${item.title || item.category || "Item"} — held ${Math.round(held)} days`,
          subtitle:   "Time to list this? Market conditions may not get better",
          body:       null,
          action:     "SET_STATUS",
          actionData: { itemId: item.itemId, suggestedStatus: "LISTED" },
          score:      held >= 90 ? 75 : 55,
          generatedAt: now,
        });
      }
    }
  }

  return entries.sort((a, b) => b.score - a.score);
}

// ── Group feed into sections for display ──────────────────────────────────────

function groupFeedBySections(entries = []) {
  const sections = {};
  for (const entry of entries) {
    const s = entry.section || "OTHER";
    if (!sections[s]) sections[s] = [];
    sections[s].push(entry);
  }
  return sections;
}

function rankDiscoveryForFeed(opps = [], limit = 8) {
  return opps
    .filter((o) => o?.buySignal && ["STRONG BUY", "GOOD DEAL"].includes(o.buySignal))
    .sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
    .slice(0, limit);
}

function alertSubtitle(alert) {
  if (alert.alertType === "target_hit") return `Hit $${alert.currentPrice?.toFixed(2)} — at or below your target`;
  if (alert.alertType === "new_low")    return `New low: $${alert.currentPrice?.toFixed(2)} (down ${alert.dropPct}%)`;
  if (alert.alertType === "significant_drop") return `Down ${alert.dropPct}% from $${alert.addedPrice?.toFixed(2)}`;
  return `Price: $${alert.currentPrice?.toFixed(2)}`;
}

function discSubtitle(opp) {
  const parts = [];
  if (opp.buySignal)     parts.push(opp.buySignal);
  if (opp.priceStats?.median) parts.push(`$${opp.priceStats.median.toFixed(2)} median`);
  if (opp.listingCount)  parts.push(`${opp.listingCount} listings`);
  return parts.join(" · ");
}

// ── Phase 13: Financial identity feed entry builders ──────────────────────────

/**
 * CATEGORY_STRENGTH: user has positive realized P&L + COMPETENT/EXPERT mastery.
 * Only fires when surfacing real earned financial calibration.
 */
function buildCategoryStrengthEntry(item) {
  const cat      = item.category;
  const profit   = item.netProfitRealized;
  const winRate  = item.winRate;
  const trades   = item.totalTrades;
  const mastery  = item.masteryLevel;

  const profitStr  = profit  != null ? `+$${Math.abs(Number(profit)).toFixed(0)} net realized` : null;
  const winStr     = winRate != null ? `${winRate}% win rate` : null;
  const tradesStr  = trades  != null ? `${trades} trades` : null;

  return {
    feedId:     `cat_strength_${cat}_${Date.now()}`,
    dedupeKey:  `cat_strength_${cat}`,
    section:    "CATEGORY_STRENGTH",
    priority:   "MEDIUM",
    title:      `${cat} is your strongest category`,
    subtitle:   [profitStr, winStr, tradesStr].filter(Boolean).join(" · "),
    body:       mastery === "EXPERT"
      ? `You've built real edge in ${cat} — your P&L and win rate show consistent execution.`
      : `You're profitable in ${cat}. Keep tracking outcomes to deepen your edge here.`,
    action:     "BROWSE_CATEGORY",
    actionData: { category: cat },
    score:      68,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:  Date.now() + 7 * 24 * 3600 * 1000,
  };
}

/**
 * CATEGORY_WEAKNESS: user has negative realized P&L or win rate < 40%.
 * Influences warnings at scan time (see index.js _applyPersonalDecisionToPayload).
 */
function buildCategoryWeaknessEntry(item) {
  const cat     = item.category;
  const profit  = item.netProfitRealized;
  const winRate = item.winRate;
  const losses  = item.lossCount;

  const lossStr   = losses  != null ? `${losses} losses recorded` : null;
  const profitStr = profit  != null ? `-$${Math.abs(Number(profit)).toFixed(0)} net` : null;
  const winStr    = winRate != null ? `${winRate}% win rate` : null;

  return {
    feedId:     `cat_weakness_${cat}_${Date.now()}`,
    dedupeKey:  `cat_weakness_${cat}`,
    section:    "CATEGORY_WEAKNESS",
    priority:   "MEDIUM",
    title:      `Your results in ${cat} are consistently poor`,
    subtitle:   [profitStr || lossStr, winStr].filter(Boolean).join(" · "),
    body:       [
      `You've lost money in ${cat} across ${item.totalTrades} trades.`,
      "Evan will apply tighter gates on your next scan here.",
      "Consider pausing this category until your track record improves.",
    ].join(" "),
    action:     "VIEW_HISTORY",
    actionData: { category: cat },
    score:      75,
    generatedAt: Date.now(),
    dismissible: true,
    expiresAt:  Date.now() + 3 * 24 * 3600 * 1000,
  };
}

/**
 * PROFIT_MILESTONE: user crossed a realized net-profit milestone.
 * Only fires once per milestone crossing — never inflated or estimated.
 */
function buildProfitMilestoneEntry(item) {
  const m    = item.milestone;
  const net  = item.netProfitRealized;
  const next = item.nextMilestone;

  const mStr   = `$${Number(m).toLocaleString()}`;
  const nextStr = next ? ` (next: $${Number(next).toLocaleString()})` : "";

  return {
    feedId:     `profit_milestone_${m}_${Date.now()}`,
    dedupeKey:  `profit_milestone_${m}`,
    section:    "PROFIT_MILESTONE",
    priority:   "MEDIUM",
    title:      `${mStr} realized — milestone crossed`,
    subtitle:   `Net profit confirmed: $${Number(net).toFixed(2)}${nextStr}`,
    body:       [
      `You've now realized over ${mStr} in net profit across your tracked trades.`,
      "This is confirmed realized money — not estimated.",
    ].join(" "),
    action:     "VIEW_PERFORMANCE",
    actionData: { milestone: m, netProfitRealized: net },
    score:      80,
    generatedAt: Date.now(),
    dismissible: true,
  };
}
