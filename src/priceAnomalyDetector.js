// src/priceAnomalyDetector.js
// Statistical price anomaly detection: z-score outlier analysis,
// stolen/fake/mislabeled low outliers, price manipulation high anchors,
// ghost listing detection.

// ── Z-score thresholds ────────────────────────────────────────────────────────
const Z_EXTREME_LOW  = -2.5;  // critical — almost certainly fake/stolen/mislabeled
const Z_SUSPICIOUS_LOW  = -1.8;  // high risk
const Z_WARNING_LOW  = -1.3;  // worth flagging
const Z_WARNING_HIGH =  1.5;  // possible price gouging / anchor listing
const Z_EXTREME_HIGH =  2.5;  // almost certainly a price anchor / scam listing

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute mean and standard deviation of a price array.
 */
function priceStats(prices) {
  if (!prices.length) return { mean: 0, std: 0, median: 0 };
  const mean   = prices.reduce((s, v) => s + v, 0) / prices.length;
  const std    = Math.sqrt(prices.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / prices.length);
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { mean: round2(mean), std: round2(std), median: round2(median) };
}

/**
 * Compute z-score for a single price against a distribution.
 */
function zScore(price, mean, std) {
  if (!std || std === 0) return 0;
  return round2((price - mean) / std);
}

/**
 * Classify a price anomaly from its z-score.
 */
function classifyAnomaly(z) {
  if (z <= Z_EXTREME_LOW)   return { type: "extreme_low",  severity: "critical", direction: "low"  };
  if (z <= Z_SUSPICIOUS_LOW)return { type: "suspicious_low",severity: "high",   direction: "low"  };
  if (z <= Z_WARNING_LOW)   return { type: "warning_low",  severity: "moderate",direction: "low"  };
  if (z >= Z_EXTREME_HIGH)  return { type: "extreme_high", severity: "high",    direction: "high" };
  if (z >= Z_WARNING_HIGH)  return { type: "warning_high", severity: "moderate",direction: "high" };
  return null;
}

/**
 * Detect ghost listings: multiple listings clustered at an artificially high price
 * with no sold comps nearby — used to inflate perceived market value.
 */
function detectGhostListings(uiItems = [], stats = {}) {
  const { median, std } = stats;
  if (!median || !std) return null;

  // Ghost signal: ≥3 listings priced ≥1.5 std above median, none sold
  const highUnsolded = uiItems.filter(item => {
    const p    = finiteOrNull(item?.totalPrice ?? item?.price);
    const sold = item?.sold === true;
    return p && !sold && p > median + std * 1.5;
  });

  if (highUnsolded.length < 3) return null;

  const avgGhostPrice = round2(
    highUnsolded.reduce((s, i) => s + (finiteOrNull(i?.totalPrice ?? i?.price) || 0), 0) / highUnsolded.length
  );

  return {
    detected:      true,
    count:         highUnsolded.length,
    avgGhostPrice,
    aboveMedianPct: round2(((avgGhostPrice - median) / median) * 100),
    signal:        `${highUnsolded.length} unsold high-price listings cluster above market — possible price anchoring to inflate perceived value`,
  };
}

/**
 * Detect if the scanned price itself is anomalous vs the market.
 */
export function analyzeScannedPriceAnomaly(scannedPrice, uiItems = []) {
  const scanned = finiteOrNull(scannedPrice);
  if (!scanned) return null;

  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean);

  if (prices.length < 3) return null;

  const stats    = priceStats(prices);
  const z        = zScore(scanned, stats.mean, stats.std);
  const anomaly  = classifyAnomaly(z);

  if (!anomaly) return { isAnomalous: false, z, ...stats };

  const LOW_EXPLANATIONS = {
    extreme_low:    "Price is extremely below market — high probability of counterfeit, stolen goods, or mislabeled item",
    suspicious_low: "Price is suspiciously below market — verify authenticity and seller before buying",
    warning_low:    "Price is noticeably below market — investigate condition and source",
  };
  const HIGH_EXPLANATIONS = {
    extreme_high:   "Price is far above market — likely a price anchor, scam, or uninformed seller",
    warning_high:   "Price is above market — negotiate down or find a better listing",
  };

  const explanation = LOW_EXPLANATIONS[anomaly.type] || HIGH_EXPLANATIONS[anomaly.type] || "";

  return {
    isAnomalous:   true,
    z,
    anomalyType:   anomaly.type,
    severity:      anomaly.severity,
    direction:     anomaly.direction,
    scannedPrice:  scanned,
    marketMean:    stats.mean,
    marketMedian:  stats.median,
    marketStd:     stats.std,
    explanation,
    action:        anomaly.direction === "low"
      ? "Investigate before buying — do not proceed without authentication"
      : "Look for better-priced listings — this one is overpriced",
  };
}

/**
 * Score every item in the market result set for price anomalies.
 * Returns flagged outliers with their z-scores and risk classifications.
 */
export function flagMarketAnomalies(uiItems = []) {
  const prices = uiItems
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean);

  if (prices.length < 4) return { stats: null, flagged: [], ghostListings: null };

  const stats   = priceStats(prices);
  const flagged = [];

  for (const item of uiItems) {
    const p = finiteOrNull(item?.totalPrice ?? item?.price);
    if (!p) continue;
    const z       = zScore(p, stats.mean, stats.std);
    const anomaly = classifyAnomaly(z);
    if (!anomaly) continue;

    flagged.push({
      item:     { title: item?.title || "", source: item?.source || "", url: item?.url || "", price: p },
      z,
      anomalyType: anomaly.type,
      severity:    anomaly.severity,
      direction:   anomaly.direction,
      signal:      anomaly.direction === "low"
        ? `Listed at $${p.toFixed(2)} — ${Math.abs(z).toFixed(1)}σ below market (${anomaly.severity} risk)`
        : `Listed at $${p.toFixed(2)} — ${z.toFixed(1)}σ above market (possible anchor)`,
    });
  }

  const ghostListings = detectGhostListings(uiItems, stats);

  // Sort: critical/high severity first
  const SEVERITY_RANK = { critical: 3, high: 2, moderate: 1 };
  flagged.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  return {
    stats,
    flagged,
    ghostListings: ghostListings || null,
    hasCriticalAnomaly: flagged.some(f => f.severity === "critical"),
    topSignal: flagged[0]?.signal || ghostListings?.signal || null,
  };
}

/**
 * Master price anomaly payload.
 */
export function buildPriceAnomalyPayload({
  scannedPrice = null,
  uiItems      = [],
} = {}) {
  const scannedAnomaly = analyzeScannedPriceAnomaly(scannedPrice, uiItems);
  const marketAnomalies = flagMarketAnomalies(uiItems);

  const hasAnomaly = scannedAnomaly?.isAnomalous || marketAnomalies?.hasCriticalAnomaly;

  return {
    hasAnomaly,
    scannedPriceAnomaly: scannedAnomaly || null,
    marketAnomalies:     marketAnomalies || null,
    topSignal: scannedAnomaly?.isAnomalous
      ? scannedAnomaly.explanation
      : marketAnomalies?.topSignal || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
