// src/smartAlertEngine.js
// Smart alert engine: determines when a scan warrants a push notification,
// builds the full notification payload with title, body, urgency, and action.

// ── Alert type definitions ────────────────────────────────────────────────────
const ALERT_TYPES = {
  STEAL_DEAL:        { urgency: "critical", ttl: 3600,   icon: "🔥" },
  GOOD_DEAL:         { urgency: "high",     ttl: 7200,   icon: "✅" },
  BUY_WINDOW_OPEN:   { urgency: "high",     ttl: 86400,  icon: "📅" },
  PRICE_TRAP:        { urgency: "high",     ttl: 86400,  icon: "🚫" },
  AUTH_RISK:         { urgency: "critical", ttl: 86400,  icon: "⚠️" },
  ARBITRAGE:         { urgency: "high",     ttl: 7200,   icon: "💰" },
  TREND_DIP:         { urgency: "medium",   ttl: 172800, icon: "📉" },
  DEMAND_SPIKE:      { urgency: "high",     ttl: 3600,   icon: "🔊" },
  CONDITION_MISMATCH:{ urgency: "medium",   ttl: 86400,  icon: "⚖️" },
  SUBSTITUTE_FOUND:  { urgency: "low",      ttl: 172800, icon: "💡" },
};

// ── Urgency rank for deduplication ────────────────────────────────────────────
const URGENCY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Evaluate all intel payloads and determine which alerts should fire.
 * Returns ordered list of alerts from most to least urgent.
 */
export function evaluateAlertTriggers({
  dealComparator    = null,
  authenticityIntel = null,
  arbitrageIntel    = null,
  trendIntel        = null,
  demandSignals     = null,
  conditionPricing  = null,
  substituteIntel   = null,
  priceHistoryIntel = null,
  riskScore         = null,
  identity          = {},
  scannedPrice      = null,
} = {}) {
  const alerts = [];

  // ── STEAL / GOOD DEAL ──────────────────────────────────────────────────────
  const verdict = dealComparator?.verdict?.verdict;
  if (verdict === "steal") {
    alerts.push({
      type:    "STEAL_DEAL",
      signal:  dealComparator.verdict.signal,
      savings: dealComparator.verdict.savingsVsMedian,
    });
  } else if (verdict === "good_deal") {
    alerts.push({
      type:   "GOOD_DEAL",
      signal: dealComparator.verdict.signal,
    });
  }

  // ── PRICE TRAP ────────────────────────────────────────────────────────────
  if (verdict === "price_trap") {
    alerts.push({
      type:   "PRICE_TRAP",
      signal: dealComparator.verdict.signal,
    });
  }

  // ── AUTH RISK ─────────────────────────────────────────────────────────────
  const authTier = authenticityIntel?.tier;
  if (authTier === "critical" || authTier === "high") {
    alerts.push({
      type:   "AUTH_RISK",
      signal: authenticityIntel.topSignal || authenticityIntel.recommendation,
    });
  }

  // ── ARBITRAGE ────────────────────────────────────────────────────────────
  const arb = arbitrageIntel?.platformArbitrage;
  if (arb?.found && arb.roi >= 20) {
    alerts.push({
      type:   "ARBITRAGE",
      signal: arb.signal,
      roi:    arb.roi,
    });
  }

  // ── TREND DIP (blue-chip in fading = buy the dip) ─────────────────────────
  if (trendIntel?.buyTheDip) {
    alerts.push({
      type:   "TREND_DIP",
      signal: `Blue-chip dip opportunity — ${trendIntel.buyAdvice}`,
    });
  }

  // ── DEMAND SPIKE ──────────────────────────────────────────────────────────
  if (demandSignals?.demandTier === "hot" && demandSignals?.scarcity?.tier === "scarce") {
    alerts.push({
      type:   "DEMAND_SPIKE",
      signal: `Scarce supply + hot demand — buy window closing fast`,
    });
  }

  // ── CONDITION MISMATCH ────────────────────────────────────────────────────
  if (conditionPricing?.mismatch?.hasMismatch && (conditionPricing.mismatch.premiumPct ?? 0) > 20) {
    alerts.push({
      type:   "CONDITION_MISMATCH",
      signal: conditionPricing.mismatch.signal,
    });
  }

  // ── BUY WINDOW OPEN (seasonal low) ───────────────────────────────────────
  if (priceHistoryIntel?.verdict === "buy_now" && verdict !== "price_trap") {
    alerts.push({
      type:   "BUY_WINDOW_OPEN",
      signal: priceHistoryIntel.verdictSignal,
    });
  }

  // ── SUBSTITUTE FOUND (save money signal) ─────────────────────────────────
  if (substituteIntel?.hasSavings && (substituteIntel.topSavingsDollars ?? 0) >= 30) {
    alerts.push({
      type:   "SUBSTITUTE_FOUND",
      signal: substituteIntel.signals?.[0] || "Cheaper alternative found",
      savings:substituteIntel.topSavingsDollars,
    });
  }

  // Sort by urgency rank descending
  return alerts.sort((a, b) =>
    (URGENCY_RANK[ALERT_TYPES[b.type]?.urgency] ?? 0) -
    (URGENCY_RANK[ALERT_TYPES[a.type]?.urgency] ?? 0)
  );
}

/**
 * Build a push notification payload for a single alert.
 */
export function buildNotificationPayload(alert, identity = {}, scannedPrice = null) {
  const meta     = ALERT_TYPES[alert.type] || { urgency: "medium", ttl: 86400, icon: "ℹ️" };
  const itemLabel = [identity?.brand, identity?.model].filter(Boolean).join(" ") || "This item";
  const price     = scannedPrice !== null ? `$${Number(scannedPrice).toFixed(2)}` : null;

  const TEMPLATES = {
    STEAL_DEAL: {
      title: `🔥 Steal: ${itemLabel}`,
      body:  `${alert.signal}${price ? ` at ${price}` : ""}. Act fast.`,
      action:"View deal",
    },
    GOOD_DEAL: {
      title: `✅ Good deal on ${itemLabel}`,
      body:  alert.signal,
      action:"View listing",
    },
    PRICE_TRAP: {
      title: `🚫 Overpriced: ${itemLabel}`,
      body:  `${alert.signal}. Find a better price.`,
      action:"Compare prices",
    },
    AUTH_RISK: {
      title: `⚠️ Auth risk: ${itemLabel}`,
      body:  alert.signal,
      action:"View auth tips",
    },
    ARBITRAGE: {
      title: `💰 ${alert.roi?.toFixed(0) ?? ""}% ROI opportunity`,
      body:  alert.signal,
      action:"View details",
    },
    TREND_DIP: {
      title: `📉 Buy the dip: ${itemLabel}`,
      body:  alert.signal,
      action:"View analysis",
    },
    DEMAND_SPIKE: {
      title: `🔊 High demand: ${itemLabel}`,
      body:  alert.signal,
      action:"Act now",
    },
    CONDITION_MISMATCH: {
      title: `⚖️ Price mismatch: ${itemLabel}`,
      body:  alert.signal,
      action:"See fair price",
    },
    BUY_WINDOW_OPEN: {
      title: `📅 Good time to buy: ${itemLabel}`,
      body:  alert.signal,
      action:"View timing",
    },
    SUBSTITUTE_FOUND: {
      title: `💡 Save ${alert.savings ? "$" + alert.savings.toFixed(0) : "money"} on ${itemLabel}`,
      body:  alert.signal,
      action:"See alternatives",
    },
  };

  const template = TEMPLATES[alert.type] || {
    title: `${meta.icon} Alert: ${itemLabel}`,
    body:  alert.signal,
    action:"View",
  };

  return {
    alertType:   alert.type,
    urgency:     meta.urgency,
    ttlSeconds:  meta.ttl,
    title:       template.title,
    body:        template.body,
    action:      template.action,
    icon:        meta.icon,
    data:        { signal: alert.signal, type: alert.type },
  };
}

/**
 * Master smart alert payload.
 * Returns the top alert as primary + full alert list.
 */
export function buildSmartAlertPayload({
  dealComparator    = null,
  authenticityIntel = null,
  arbitrageIntel    = null,
  trendIntel        = null,
  demandSignals     = null,
  conditionPricing  = null,
  substituteIntel   = null,
  priceHistoryIntel = null,
  riskScore         = null,
  identity          = {},
  scannedPrice      = null,
} = {}) {
  const triggeredAlerts = evaluateAlertTriggers({
    dealComparator, authenticityIntel, arbitrageIntel, trendIntel,
    demandSignals, conditionPricing, substituteIntel, priceHistoryIntel,
    riskScore, identity, scannedPrice,
  });

  if (!triggeredAlerts.length) {
    return { hasAlerts: false, alertCount: 0, primaryAlert: null, allAlerts: [] };
  }

  const primaryAlert    = triggeredAlerts[0];
  const primaryPayload  = buildNotificationPayload(primaryAlert, identity, scannedPrice);
  const allPayloads     = triggeredAlerts.map(a => buildNotificationPayload(a, identity, scannedPrice));

  return {
    hasAlerts:    true,
    alertCount:   triggeredAlerts.length,
    primaryAlert: primaryPayload,
    allAlerts:    allPayloads,
    topUrgency:   ALERT_TYPES[primaryAlert.type]?.urgency || "medium",
  };
}
