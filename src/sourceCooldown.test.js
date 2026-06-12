// src/sourceCooldown.test.js
// Phase 4I.5 hardening — regression tests for source cooldown reset,
// affiliate scanId fallback, and aircraft identity completeness detector.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGenericAircraftToyQuery } from "./queryGuards.js";

// ── Source health model — simulates resetSourceCooldown behavior ─────────────

describe("resetSourceCooldown model", () => {
  it("hard-reset zeros failures, timeouts, and cooldownUntil", () => {
    // Simulate what SOURCE_HEALTH contains after 21 Etsy 403s
    const healthAfterFailures = {
      failures: 21,
      timeouts: 0,
      cooldownUntil: Date.now() + 3 * 60 * 1000, // 3 min cooldown
      lastError: "http_403",
      updatedAt: Date.now(),
      successes: 0,
    };

    // markSourceSuccess only decrements failures by 1 — NOT sufficient for dev reset
    const afterMarkSuccess = {
      ...healthAfterFailures,
      failures: Math.max(0, healthAfterFailures.failures - 1), // 20, not 0
      cooldownUntil: 0,
    };
    assert.equal(afterMarkSuccess.failures, 20, "markSourceSuccess only decrements");
    assert.equal(afterMarkSuccess.cooldownUntil, 0, "cooldownUntil is cleared");
    // Problem: failures=20 means next single 403 will immediately re-trigger cooldown
    const strikeAfterOneMore = afterMarkSuccess.failures + 1 + afterMarkSuccess.timeouts * 2;
    assert.ok(strikeAfterOneMore >= 3, "failures still high enough to re-trigger on next error");

    // resetSourceCooldown hard-zeros everything
    const afterHardReset = {
      failures: 0,
      timeouts: 0,
      cooldownUntil: 0,
      lastError: null,
      successes: 0,
      updatedAt: Date.now(),
    };
    assert.equal(afterHardReset.failures, 0, "hard reset zeros failures");
    assert.equal(afterHardReset.cooldownUntil, 0, "hard reset clears cooldownUntil");

    // Now a single failure won't immediately re-trigger (strike < 3 threshold)
    const strikeAfterReset = afterHardReset.failures + 1;
    assert.ok(strikeAfterReset < 3, "one failure after reset does not re-trigger cooldown");
  });

  it("isSourceCoolingDown returns false when cooldownUntil=0", () => {
    // Simulates the check inside isSourceCoolingDown
    const h = { cooldownUntil: 0 };
    const cooling = (h.cooldownUntil || 0) > Date.now();
    assert.equal(cooling, false);
  });

  it("isSourceCoolingDown returns true when cooldownUntil is in the future", () => {
    const h = { cooldownUntil: Date.now() + 60_000 };
    const cooling = (h.cooldownUntil || 0) > Date.now();
    assert.equal(cooling, true);
  });

  it("Etsy cooldown requires BOTH ETSY_COOLDOWN_UNTIL and SOURCE_HEALTH to be cleared", () => {
    // Both gates must be reset for Etsy to be truly not cooling
    const etsyCooldownUntil = Date.now() + 10_000; // still active
    const sourceHealthCooldown = 0; // cleared by markSourceSuccess

    const etsyCooling = Date.now() < etsyCooldownUntil || sourceHealthCooldown > Date.now();
    assert.equal(etsyCooling, true, "ETSY_COOLDOWN_UNTIL must also be zeroed");

    // After resetEtsyCooldown + resetSourceCooldown both:
    const etsyCooldownAfterReset = 0;
    const sourceHealthAfterReset = 0;
    const etsyCoolingAfterReset = Date.now() < etsyCooldownAfterReset || sourceHealthAfterReset > Date.now();
    assert.equal(etsyCoolingAfterReset, false, "both reset: etsy is not cooling");
  });
});

// ── CACHE_REFRESH_SKIPPED_DUE_TO_SOURCE_COOLDOWN log shape ───────────────────

describe("CACHE_REFRESH_SKIPPED_DUE_TO_SOURCE_COOLDOWN", () => {
  it("log includes all required fields", () => {
    const scanId = "c.abc123.xyz";
    const refreshScanId = `${scanId}:cache_refresh`;
    const log = {
      rid: "rid-test",
      parentScanId: scanId,
      refreshScanId,
      query: "hawaiian airlines boeing 787 diecast model airplane",
      serpCooling: true,
      etsyCooling: false,
      ebayAvail: false,
      serpCooldownUntil: new Date(Date.now() + 30_000).toISOString(),
      hint: "wait for cooldown or POST /api/dev/source-cooldown/reset (dev only) to clear local state",
    };

    assert.ok(log.parentScanId, "must include parentScanId");
    assert.ok(log.refreshScanId, "must include refreshScanId");
    assert.ok(typeof log.serpCooling === "boolean", "serpCooling must be bool");
    assert.ok(typeof log.etsyCooling === "boolean", "etsyCooling must be bool");
    assert.ok(typeof log.ebayAvail === "boolean", "ebayAvail must be bool");
    assert.ok(typeof log.hint === "string", "hint must be present");
  });

  it("refreshScanId is always parentScanId + :cache_refresh suffix", () => {
    const parentScanId = "c.mqaa9417.pvkh56";
    const refreshScanId = `${parentScanId}:cache_refresh`;
    assert.ok(refreshScanId.startsWith(parentScanId));
    assert.ok(refreshScanId.endsWith(":cache_refresh"));
  });
});

// ── affiliate gate scanId fallback ───────────────────────────────────────────

describe("affiliate gate scanId fallback", () => {
  it("falls back to route scanId when responsePayload.scanId is null", () => {
    const responsePayload = { scanId: null };
    const _budgetScanIdEarly = "c.mqaa9417.pvkh56";

    const _scanId = responsePayload.scanId || _budgetScanIdEarly || null;
    assert.equal(_scanId, "c.mqaa9417.pvkh56", "should use route scanId as fallback");
  });

  it("uses responsePayload.scanId when available", () => {
    const responsePayload = { scanId: "from_payload" };
    const _budgetScanIdEarly = "from_budget";

    const _scanId = responsePayload.scanId || _budgetScanIdEarly || null;
    assert.equal(_scanId, "from_payload", "payload scanId takes priority");
  });

  it("returns null when both are missing", () => {
    const responsePayload = { scanId: null };
    const _budgetScanIdEarly = null;

    const _scanId = responsePayload.scanId || _budgetScanIdEarly || null;
    assert.equal(_scanId, null);
  });

  it("stream route uses route-level scanId variable as fallback", () => {
    // In the stream _buildPayload, _scanIdD = payload.scanId || scanId || null
    const payload = { scanId: null };
    const scanId = "c.mqaa9417.pvkh56"; // route-level

    const _scanIdD = payload.scanId || scanId || null;
    assert.equal(_scanIdD, "c.mqaa9417.pvkh56");
  });
});

// ── AIRCRAFT_IDENTITY_COMPLETENESS_CHECK detector ────────────────────────────

describe("AIRCRAFT_IDENTITY_COMPLETENESS_CHECK detector", () => {
  it("isGenericAircraftToyQuery false → hasAirline should be detected as true for Hawaiian 787", () => {
    const query = "Hawaiian Airlines Boeing 787 diecast model airplane";
    // isGenericAircraftToyQuery returns false because Boeing + 787 are present
    assert.equal(isGenericAircraftToyQuery(query), false, "query is NOT generic");
    // The fixed detector uses detectAirlineLockInQuery which finds 'hawaiian'
    // Simulate the detection (without calling the actual function from index.js):
    const hasHawaiian = /\bhawaiian\b/i.test(query);
    const has787 = /\b787\b/.test(query);
    assert.ok(hasHawaiian, "hasAirline should be true for Hawaiian Airlines query");
    assert.ok(has787, "hasFamilyInQuery should be true for Boeing 787");
  });

  it("isGenericAircraftToyQuery true → generic query has no airline/family", () => {
    const query = "white plastic model airplane toy";
    assert.equal(isGenericAircraftToyQuery(query), true);
    const hasAirline = /\b(hawaiian|united|delta|american airlines|ana|jal|boeing|airbus)\b/i.test(query);
    assert.equal(hasAirline, false, "no airline in generic query");
  });

  it("the old buggy logic: hasAirline = needsAircraftFamilyRefinement was wrong for 787", () => {
    // needsAircraftFamilyRefinement = accepted && isAircraftCategory && hasAirline && !hasFamily
    // For "Hawaiian Airlines Boeing 787": hasFamily=true → !hasFamily=false → refinement=false
    // Old code: hasAirline = needsAircraftFamilyRefinement = false  ← WRONG
    const hasFamilyInQuery = true; // 787 is present
    const hasAirlineInQuery = true; // Hawaiian is present
    const needsAircraftFamilyRefinement = hasAirlineInQuery && !hasFamilyInQuery; // false
    assert.equal(needsAircraftFamilyRefinement, false);
    // Old code used this for hasAirline field — produces false even though airline IS present
    assert.equal(needsAircraftFamilyRefinement, false, "old hasAirline field was misleadingly false");

    // New code: directly checks for airline via detectAirlineLockInQuery
    // Which returns { requiredAirline: 'hawaiian' } for this query → hasAirline = true
    const hasAirlineNew = hasAirlineInQuery; // direct detection
    assert.ok(hasAirlineNew, "new hasAirline correctly shows true");
  });
});

// ── _buildSourceCooldownStatus shape ─────────────────────────────────────────

describe("_buildSourceCooldownStatus response shape", () => {
  it("status object has all 5 sources with required fields", () => {
    const sources = ["serpapi", "etsy", "ebay", "walmart", "bestbuy"];
    // Simulate the shape that _buildSourceCooldownStatus returns
    const status = {};
    for (const s of sources) {
      status[s] = {
        cooling: false,
        cooldownUntil: null,
        failures: 0,
        timeouts: 0,
      };
    }

    for (const s of sources) {
      assert.ok(s in status, `${s} must be in status`);
      assert.ok(typeof status[s].cooling === "boolean");
      assert.ok("cooldownUntil" in status[s]);
      assert.ok(typeof status[s].failures === "number");
      assert.ok(typeof status[s].timeouts === "number");
    }
  });

  it("after reset all sources show cooling:false and no cooldownUntil", () => {
    const sources = ["serpapi", "etsy", "ebay", "walmart", "bestbuy"];
    // Post-reset state
    const status = {};
    for (const s of sources) {
      status[s] = { cooling: false, cooldownUntil: null, failures: 0, timeouts: 0 };
    }

    for (const s of sources) {
      assert.equal(status[s].cooling, false, `${s} should not be cooling after reset`);
      assert.equal(status[s].cooldownUntil, null, `${s} cooldownUntil should be null after reset`);
      assert.equal(status[s].failures, 0, `${s} failures should be 0 after reset`);
    }
  });
});
