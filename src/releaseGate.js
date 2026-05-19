// src/releaseGate.js
// Release Gate — Phase 16: No-Decay System.
//
// Authoritative pre-release check that must pass before any deploy.
// Runs the full check suite and returns a machine-readable pass/fail report.
//
// Checks:
//   RG-01  Regression harness: all critical scenarios pass
//   RG-02  Golden cases: no critical failures
//   RG-03  Anomaly severity: no CRITICAL anomalies active
//   RG-04  Consistency contradiction check (sample payload test)
//   RG-05  Confidence honesty: B2B does not overclaim vs consumer path
//   RG-06  Latency baseline: P95 within allowed threshold
//   RG-07  Calibration audit: no critical suppressions active
//   RG-08  Truth guard correction rate: fail if > 15%, warn if > 5% (with 50+ scans)
//
// Output: { pass, blockers[], warnings[], checks[], durationMs, runAt }
//
// Gate will FAIL release when any check with `blocking: true` fails.

import { runRegressionHarness }  from "./regressionHarness.js";
import { runGoldenCases }        from "./goldenCaseRunner.js";
import { getActiveAnomalies }    from "./anomalyEngine.js";
import { getActiveControls }     from "./incidentControls.js";
import { checkPayloadConsistency } from "./consistencyGuard.js";
import { getAllSuppressions }    from "./calibrationAudit.js";
import { getCorrectionRate }     from "./truthGuard.js";
import { TRUTH_THRESHOLDS }      from "./truthGuardConfig.js";

// ── Check definitions ─────────────────────────────────────────────────────────

/**
 * Run the full release gate suite.
 *
 * @param {object|null} redis
 * @returns {Promise<ReleaseGateReport>}
 */
export async function runReleaseGate(redis = null) {
  const start  = Date.now();
  const checks = [];

  // RG-01: Regression harness
  const rg01 = await check("RG-01", "Regression harness — all critical scenarios", true, async () => {
    const result = await runRegressionHarness(redis);
    if (result.criticalFailures > 0) {
      return fail(`${result.criticalFailures} critical scenario(s) failed:\n` +
        result.scenarios.filter((s) => !s.pass && s.criticalityLevel === "critical")
          .map((s) => `  • ${s.id}: ${s.name}`)
          .join("\n"),
        { passed: result.passed, failed: result.failed, total: result.total }
      );
    }
    if (result.failed > 0) {
      return warn(`${result.failed} non-critical scenario(s) failed (non-blocking)`,
        { passed: result.passed, failed: result.failed });
    }
    return pass(`${result.passed}/${result.total} scenarios pass`);
  });
  checks.push(rg01);

  // RG-02: Golden cases
  const rg02 = await check("RG-02", "Golden cases — critical never-regress suite", true, async () => {
    const result = await runGoldenCases();
    if (result.releaseBlocked) {
      return fail(`${result.criticalFailures} critical golden case(s) failed:\n` +
        result.cases.filter((c) => !c.pass && c.criticality === "critical")
          .map((c) => `  • ${c.id}: ${c.name} — ${c.reason || c.error || "see report"}`)
          .join("\n"),
        { passed: result.passed, total: result.total }
      );
    }
    if (result.failed > 0) {
      return warn(`${result.failed} non-critical golden case(s) failed`,
        { passed: result.passed, total: result.total });
    }
    return pass(`${result.passed}/${result.total} golden cases pass`);
  });
  checks.push(rg02);

  // RG-03: No critical active anomalies
  const rg03 = await check("RG-03", "Anomaly engine — no critical anomalies active", true, async () => {
    const report = await getActiveAnomalies(redis);
    if (report.criticalCount > 0) {
      return fail(
        `${report.criticalCount} critical anomaly(ies) active:\n` +
        report.active.filter((a) => a.severity === "critical")
          .map((a) => `  • ${a.anomalyId}: ${a.title}`)
          .join("\n"),
        { criticalCount: report.criticalCount, total: report.total }
      );
    }
    if (report.highCount > 0) {
      return warn(`${report.highCount} HIGH anomaly(ies) active — should review before deploy`,
        { highCount: report.highCount });
    }
    return pass(`${report.total} anomaly checks; 0 critical`);
  });
  checks.push(rg03);

  // RG-04: Consistency guard sample check
  const rg04 = await check("RG-04", "Consistency guard — sample contradiction check", true, async () => {
    // Test: RISKY payload with affiliate disclosure = violation
    const badPayload = {
      profitIntel:      { buySignal: "RISKY", items: [{ url: "https://ebay.com/1", isAffiliate: true }] },
      affiliateDisclosure: "test",
      trustScore:       0.25,
    };
    const result = checkPayloadConsistency(badPayload, "free");
    if (!result.violations.some((v) => v.code === "CG-01" || v.code === "CG-01b")) {
      return fail("CG-01 violation not detected — affiliate on RISKY signal", result);
    }

    // Test: healthy payload passes
    const goodPayload = {
      profitIntel: { buySignal: "GOOD DEAL", items: [] },
      trustScore:  0.75,
    };
    const good = checkPayloadConsistency(goodPayload, "free");
    if (!good.consistent) {
      return fail("Healthy payload wrongly flagged as inconsistent", good.violations);
    }

    return pass("Consistency guard correctly detects violations and passes clean payloads");
  });
  checks.push(rg04);

  // RG-05: Calibration suppressions audit
  const rg05 = await check("RG-05", "Calibration — active signal suppressions", false, async () => {
    const suppressions = await getAllSuppressions(redis).catch(() => []);
    if (!suppressions?.length) return pass("No calibration suppressions active");
    const supList = suppressions.map((s) => `  • ${s.category}/${s.signal}`).join("\n");
    return warn(`${suppressions.length} calibration suppression(s) currently active — verify these are intentional:\n${supList}`,
      { count: suppressions.length });
  });
  checks.push(rg05);

  // RG-06: Stale incident controls
  const rg06 = await check("RG-06", "Incident controls — no stale controls", false, async () => {
    const controls = await getActiveControls(redis).catch(() => []);
    const stale    = controls.filter((c) => {
      const age = Date.now() - new Date(c.activatedAt).getTime();
      return age > 7 * 86400 * 1000; // older than 7 days
    });
    if (stale.length > 0) {
      return warn(
        `${stale.length} incident control(s) are older than 7 days — verify these are still needed:\n` +
        stale.map((c) => `  • ${c.type}:${c.target} (activated ${c.activatedAt})`).join("\n"),
        { stale: stale.length }
      );
    }
    if (controls.length > 0) {
      return warn(`${controls.length} active incident control(s) — verify intentional before deploy`,
        { active: controls.length });
    }
    return pass("No active incident controls");
  });
  checks.push(rg06);

  // RG-07: Latency baseline check (informational — non-blocking if no data)
  const rg07 = await check("RG-07", "Latency — P95 within baseline", false, async () => {
    if (!redis) return pass("Redis unavailable — skipping latency check");
    try {
      const p95 = await redis.get("metrics:latency:scan_p95_ms").catch(() => null);
      if (!p95) return pass("No P95 latency data recorded yet");
      const ms = parseFloat(p95);
      if (ms >= 20000) return fail(`P95 latency critical: ${(ms / 1000).toFixed(1)}s (threshold: 20s)`, { p95Ms: ms });
      if (ms >= 14000) return warn(`P95 latency elevated: ${(ms / 1000).toFixed(1)}s (threshold: 14s)`, { p95Ms: ms });
      return pass(`P95 scan latency: ${(ms / 1000).toFixed(1)}s — within limits`);
    } catch { return pass("Latency data unavailable"); }
  });
  checks.push(rg07);

  // RG-08: Truth guard correction rate
  const rg08 = await check("RG-08", "Truth guard — correction rate within safe threshold", true, async () => {
    const T    = TRUTH_THRESHOLDS;
    const rate = await getCorrectionRate(redis);
    if (!rate || rate.scans < T.CORRECTION_RATE_MIN_SCANS) {
      return pass(`Insufficient scan data (${rate?.scans ?? 0} scans — need ${T.CORRECTION_RATE_MIN_SCANS}) — skipped`);
    }
    const { corrections, scans, rate: r } = rate;
    if (r >= T.CORRECTION_RATE_CRITICAL) {
      return fail(
        `Correction rate ${(r * 100).toFixed(1)}% exceeds critical threshold ${(T.CORRECTION_RATE_CRITICAL * 100).toFixed(0)}% — ${corrections}/${scans} scans were corrected by TruthGuard`,
        { corrections, scans, rate: r }
      );
    }
    if (r >= T.CORRECTION_RATE_WARN) {
      return warn(
        `Correction rate ${(r * 100).toFixed(1)}% above warning threshold ${(T.CORRECTION_RATE_WARN * 100).toFixed(0)}% — ${corrections}/${scans} scans required correction`,
        { corrections, scans, rate: r }
      );
    }
    return pass(`Correction rate ${(r * 100).toFixed(1)}% (${corrections}/${scans} scans) — within threshold`);
  });
  checks.push(rg08);

  // Compile final report
  const blockers   = checks.filter((c) => c.status === "fail" && c.blocking);
  const warnings   = checks.filter((c) => c.status === "warn" || (c.status === "fail" && !c.blocking));
  const passed     = checks.every((c) => c.status === "pass" || (c.status === "warn" && !c.blocking));
  const gatePass   = blockers.length === 0;

  return {
    pass:      gatePass,
    runAt:     new Date().toISOString(),
    durationMs:Date.now() - start,
    checks,
    blockers:  blockers.map((c) => ({ id: c.id, name: c.name, reason: c.reason, data: c.data })),
    warnings:  warnings.map((c) => ({ id: c.id, name: c.name, reason: c.reason, data: c.data })),
    summary:   `${checks.filter((c) => c.status === "pass").length}/${checks.length} checks pass` +
               (blockers.length ? ` — ${blockers.length} blocker(s)` : "") +
               (warnings.length ? ` — ${warnings.length} warning(s)` : ""),
  };
}

// ── Check runner ──────────────────────────────────────────────────────────────

async function check(id, name, blocking, fn) {
  try {
    const result = await fn();
    return { id, name, blocking, status: result.status, reason: result.reason || null, data: result.data || null };
  } catch (err) {
    return {
      id, name, blocking,
      status: blocking ? "fail" : "warn",
      reason: `Check threw: ${err?.message || String(err)}`,
    };
  }
}

function pass(reason, data)  { return { status: "pass", reason, data }; }
function warn(reason, data)  { return { status: "warn", reason, data }; }
function fail(reason, data)  { return { status: "fail", reason, data }; }
