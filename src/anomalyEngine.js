// src/anomalyEngine.js
// Anomaly Engine — Phase 16: No-Decay System.
//
// Detects system-wide deterioration before users do.
// Pulls metrics from existing Redis structures (accuracy, drift, cluster,
// attribution, latency) and evaluates them against baselines.
//
// All checks are read-only.  Anomalies are persisted to Redis for ops review.
// Nothing here touches the scan hot path.
//
// Redis keys:
//   anomaly:active        STRING JSON  — current anomaly state (1h TTL)
//   anomaly:history:{date} LIST JSON   — daily event log (30d TTL, max 1000/day)

import { getGlobalCalibration }   from "./accuracyEngine.js";
import { runClusterScan }         from "./badCallClusterEngine.js";
import { getGlobalAttributionStats } from "./revenueAttribution.js";

const KEY_ACTIVE  = "anomaly:active";
const KEY_HISTORY = (d) => `anomaly:history:${d}`;
const ACTIVE_TTL  = 3600;        // 1h
const HISTORY_TTL = 30 * 86400;  // 30d
const MAX_HISTORY = 1000;

// ── Anomaly definitions ───────────────────────────────────────────────────────
//
// Each detector returns { anomalyId, severity, title, detail, metric,
//   baseline, current, threshold, suggestedAction, autoAction? }
// severity: "critical" | "high" | "medium" | "low"

const DETECTORS = [
  // ── A01: STRONG BUY false-positive spike ─────────────────────────────────
  {
    id:    "A01",
    name:  "STRONG BUY win-rate collapse",
    check: async (redis) => {
      const cal = await getGlobalCalibration(redis).catch(() => null);
      if (!cal) return null;

      const sb = cal?.["STRONG BUY"];
      if (!sb || !sb.reportedWinRate) return null;

      const expected = 0.80;  // SIGNAL_TARGETS.STRONG_BUY from accuracyEngine
      const actual   = sb.reportedWinRate;
      const scans    = sb.scans || 0;

      if (scans < 20) return null;  // not enough data

      const dropPct = (expected - actual) / expected;
      if (dropPct < 0.10) return null;  // within tolerance

      const severity = dropPct >= 0.30 ? "critical" : dropPct >= 0.20 ? "high" : "medium";
      return {
        anomalyId:      "A01",
        title:          "STRONG BUY win-rate below target",
        detail:         `Win rate ${(actual * 100).toFixed(1)}% vs expected ${(expected * 100).toFixed(0)}% (${(dropPct * 100).toFixed(0)}% below target)`,
        metric:         "strong_buy_win_rate",
        baseline:       expected,
        current:        actual,
        threshold:      expected * 0.90,
        severity,
        suggestedAction: "Review recent STRONG BUY calls. Check category thresholds for drift. Consider runWeeklyAudit.",
      };
    },
  },

  // ── A02: GOOD DEAL win-rate collapse ───────────────────────────────────────
  {
    id:    "A02",
    name:  "GOOD DEAL win-rate collapse",
    check: async (redis) => {
      const cal = await getGlobalCalibration(redis).catch(() => null);
      if (!cal) return null;

      const gd = cal?.["GOOD DEAL"];
      if (!gd || !gd.reportedWinRate) return null;

      const expected = 0.62;
      const actual   = gd.reportedWinRate;
      const scans    = gd.scans || 0;
      if (scans < 20) return null;

      const dropPct = (expected - actual) / expected;
      if (dropPct < 0.12) return null;

      const severity = dropPct >= 0.30 ? "critical" : dropPct >= 0.20 ? "high" : "medium";
      return {
        anomalyId:      "A02",
        title:          "GOOD DEAL win-rate below target",
        detail:         `Win rate ${(actual * 100).toFixed(1)}% vs expected ${(expected * 100).toFixed(0)}%`,
        metric:         "good_deal_win_rate",
        baseline:       expected,
        current:        actual,
        threshold:      expected * 0.88,
        severity,
        suggestedAction: "Review GOOD DEAL threshold. Check calibrationAudit for recent suppressions.",
      };
    },
  },

  // ── A03: Bad-call cluster detected ────────────────────────────────────────
  {
    id:    "A03",
    name:  "Bad-call cluster in active category",
    check: async (redis) => {
      const clusters = await runClusterScan(redis).catch(() => null);
      if (!clusters?.alerts?.length) return null;

      const alerts = clusters.alerts;
      const topAlert = alerts[0];
      const severity = topAlert.severity === "ALERT" ? "critical"
        : topAlert.severity === "WARN" ? "high" : "medium";

      return {
        anomalyId:      "A03",
        title:          `Bad-call cluster: ${topAlert.category} / ${topAlert.signal}`,
        detail:         `${topAlert.recentLosses} losses in ${topAlert.windowDays}d window — ${(topAlert.lossRate * 100).toFixed(0)}% loss rate. ${alerts.length} total cluster(s) active.`,
        metric:         "bad_call_cluster",
        baseline:       0.50,
        current:        topAlert.lossRate,
        threshold:      0.60,
        severity,
        suggestedAction: "Suppress category signal tier via incident controls. Run badCallReplay for root cause.",
        affectedCategory: topAlert.category,
        affectedSignal:   topAlert.signal,
      };
    },
  },

  // ── A04: Affiliate click quality collapse ─────────────────────────────────
  {
    id:    "A04",
    name:  "Affiliate click quality collapse",
    check: async (redis) => {
      const stats = await getGlobalAttributionStats(redis, { days: 3 }).catch(() => []);
      if (!stats?.length) return null;

      let totalHigh = 0, totalLow = 0;
      for (const day of stats) {
        totalHigh += Number(day.affiliateClicks             || 0);
        totalLow  += Number(day.affiliateClicks_lowQuality  || 0);
      }

      const total = totalHigh + totalLow;
      if (total < 30) return null;  // not enough data

      const lowQualityRate = totalLow / total;
      if (lowQualityRate < 0.40) return null;

      const severity = lowQualityRate >= 0.70 ? "high" : "medium";
      return {
        anomalyId:      "A04",
        title:          "High proportion of low-quality affiliate clicks",
        detail:         `${(lowQualityRate * 100).toFixed(0)}% of ${total} clicks are low-quality (< 1.5s dwell time) over last 3 days`,
        metric:         "affiliate_click_quality",
        baseline:       0.20,
        current:        lowQualityRate,
        threshold:      0.40,
        severity,
        suggestedAction: "Check if affiliate links are being rendered in a spammy position. Review click dwell time distribution.",
      };
    },
  },

  // ── A05: Degraded scan spike (oracle timeout) ─────────────────────────────
  {
    id:    "A05",
    name:  "Elevated oracle / degraded-completion rate",
    check: async (redis) => {
      if (!redis) return null;
      try {
        const stats = await redis.hgetall("metrics:oracle_completions").catch(() => null);
        if (!stats) return null;
        const total    = parseInt(stats.total    || "0");
        const degraded = parseInt(stats.degraded || "0");
        if (total < 50) return null;
        const rate = degraded / total;
        if (rate < 0.12) return null;
        const severity = rate >= 0.30 ? "critical" : rate >= 0.20 ? "high" : "medium";
        return {
          anomalyId:      "A05",
          title:          "Elevated oracle / degraded scan rate",
          detail:         `${(rate * 100).toFixed(0)}% of ${total} scans are degraded (oracle fallback)`,
          metric:         "oracle_rate",
          baseline:       0.05,
          current:        rate,
          threshold:      0.12,
          severity,
          suggestedAction: "Check SERP API health, timeout config, and marketplace source availability.",
        };
      } catch { return null; }
    },
  },

  // ── A06: B2B overconfidence anomaly ───────────────────────────────────────
  {
    id:    "A06",
    name:  "B2B valuation returning high confidence for low-grade categories",
    check: async (redis) => {
      if (!redis) return null;
      try {
        // Check the b2b_overconfidence counter incremented by consistencyGuard
        const count = await redis.get("anomaly:b2b_overconfidence_count").catch(() => null);
        if (!count || parseInt(count) < 3) return null;
        const n = parseInt(count);
        const severity = n >= 10 ? "high" : "medium";
        return {
          anomalyId:      "A06",
          title:          "B2B valuation overconfidence violations detected",
          detail:         `${n} B2B valuations returned stronger confidence than index grade allows (detected by consistencyGuard)`,
          metric:         "b2b_overconfidence",
          baseline:       0,
          current:        n,
          threshold:      3,
          severity,
          suggestedAction: "Review businessValuationApi.js confidence mapping. Check priceIndex grades for affected categories.",
        };
      } catch { return null; }
    },
  },

  // ── A07: Scan-time latency spike (P95 breach) ─────────────────────────────
  {
    id:    "A07",
    name:  "Scan P95 latency breach",
    check: async (redis) => {
      if (!redis) return null;
      try {
        const latKey = "metrics:latency:scan_p95_ms";
        const raw    = await redis.get(latKey).catch(() => null);
        if (!raw) return null;
        const p95Ms = parseFloat(raw);
        const BASE  = 8000;   // 8s baseline
        const WARN  = 14000;  // 14s warn
        const CRIT  = 20000;  // 20s critical
        if (p95Ms < WARN) return null;
        const severity = p95Ms >= CRIT ? "critical" : "high";
        return {
          anomalyId:      "A07",
          title:          "Scan P95 latency exceeds threshold",
          detail:         `P95 scan latency is ${(p95Ms / 1000).toFixed(1)}s (threshold: ${WARN / 1000}s, critical: ${CRIT / 1000}s)`,
          metric:         "scan_p95_latency_ms",
          baseline:       BASE,
          current:        p95Ms,
          threshold:      WARN,
          severity,
          suggestedAction: "Check SERP API and OpenAI latency. Review recent deploy for performance regression.",
        };
      } catch { return null; }
    },
  },

  // ── A08: Category win-rate collapse for a specific category ───────────────
  {
    id:    "A08",
    name:  "Per-category signal win-rate collapse",
    check: async (redis) => {
      if (!redis) return null;
      try {
        // Category-level calibration keys: calibrator:global:{category}
        const keys = await redis.keys("calibrator:global:*").catch(() => []);
        if (!keys.length) return null;

        const collapses = [];
        for (const key of keys.slice(0, 20)) {
          const cat  = key.replace("calibrator:global:", "");
          const h    = await redis.hgetall(key).catch(() => null);
          if (!h) continue;

          const sbTotal = parseInt(h.sb_total || "0");
          const sbWins  = parseInt(h.sb_wins  || "0");
          if (sbTotal < 10) continue;

          const rate = sbWins / sbTotal;
          if (rate < 0.55) {  // below 55% for STRONG BUY in any category
            collapses.push({ category: cat, rate, total: sbTotal });
          }
        }

        if (!collapses.length) return null;
        collapses.sort((a, b) => a.rate - b.rate);
        const worst = collapses[0];

        const severity = worst.rate < 0.40 ? "critical" : worst.rate < 0.50 ? "high" : "medium";
        return {
          anomalyId:      "A08",
          title:          `Category win-rate collapse: ${worst.category}`,
          detail:         `STRONG BUY win rate is ${(worst.rate * 100).toFixed(0)}% for ${worst.category} (${worst.total} trades). ${collapses.length} categories affected.`,
          metric:         "category_sb_win_rate",
          baseline:       0.80,
          current:        worst.rate,
          threshold:      0.55,
          severity,
          suggestedAction: `Suppress STRONG BUY for ${worst.category} via incident controls. Run calibrationAudit.`,
          affectedCategory: worst.category,
          allCollapsed:     collapses.slice(0, 5),
        };
      } catch { return null; }
    },
  },
];

// ── Runner ─────────────────────────────────────────────────────────────────────

/**
 * Run all anomaly detectors and persist results.
 *
 * @param {object} redis
 * @returns {Promise<AnomalyReport>}
 */
export async function runAnomalyDetection(redis) {
  if (!redis) return emptyReport();

  const start    = Date.now();
  const active   = [];
  const all      = [];

  for (const detector of DETECTORS) {
    try {
      const result = await detector.check(redis);
      if (result) {
        result.detectedAt = new Date().toISOString();
        active.push(result);
        all.push(result);
      }
    } catch { /* each detector fails silently */ }
  }

  // Persist to Redis
  const report = {
    scannedAt:  new Date().toISOString(),
    durationMs: Date.now() - start,
    active,
    criticalCount: active.filter((a) => a.severity === "critical").length,
    highCount:     active.filter((a) => a.severity === "high").length,
    total:         active.length,
  };

  try {
    await redis.set(KEY_ACTIVE, JSON.stringify(report), "EX", ACTIVE_TTL);
    // Append to history
    const dateKey = todayUTC();
    const ev      = JSON.stringify({ runAt: report.scannedAt, summary: { total: report.total, critical: report.criticalCount, high: report.highCount }, active });
    await redis.lpush(KEY_HISTORY(dateKey), ev);
    await redis.ltrim(KEY_HISTORY(dateKey), 0, MAX_HISTORY - 1);
    await redis.expire(KEY_HISTORY(dateKey), HISTORY_TTL);
  } catch { /* non-fatal */ }

  return report;
}

/**
 * Get the last anomaly detection result from Redis cache.
 */
export async function getActiveAnomalies(redis) {
  if (!redis) return emptyReport();
  try {
    const raw = await redis.get(KEY_ACTIVE);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  return emptyReport();
}

/**
 * Get anomaly history for N days.
 */
export async function getAnomalyHistory(redis, { days = 7 } = {}) {
  if (!redis) return [];
  try {
    const now    = new Date();
    const entries = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const dateKey = d.toISOString().slice(0, 10);
      const raw  = await redis.lrange(KEY_HISTORY(dateKey), 0, 99).catch(() => []);
      const items = raw
        .map((r) => { try { return JSON.parse(r); } catch { return null; } })
        .filter(Boolean);
      if (items.length) entries.push({ date: dateKey, runs: items });
    }
    return entries;
  } catch { return []; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function emptyReport() {
  return { scannedAt: new Date().toISOString(), durationMs: 0, active: [], criticalCount: 0, highCount: 0, total: 0 };
}
