// shared/storedScan.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  STORED_SCAN_SCHEMA_VERSION,
  buildFreshStoredScan,
  hydrateStoredScan,
  isStoredScanFresh,
  normalizeStoredScan,
} from "./storedScan.js";
import { setVerdictTelemetrySink } from "./verdictTelemetry.js";

describe("STORED_SCAN_SCHEMA_VERSION", () => {
  it("is 3", () => {
    assert.equal(STORED_SCAN_SCHEMA_VERSION, 3);
  });
});

describe("normalizeStoredScan: null / malformed input", () => {
  it("returns dropped:true for null", () => {
    const out = normalizeStoredScan(null, { telemetry: false });
    assert.equal(out.scan, null);
    assert.equal(out.dropped, true);
    assert.equal(out.changed, false);
  });

  it("returns dropped:true for arrays", () => {
    const out = normalizeStoredScan([1, 2, 3], { telemetry: false });
    assert.equal(out.dropped, true);
    assert.equal(out.scan, null);
  });

  it("returns dropped:true for primitives", () => {
    assert.equal(normalizeStoredScan("BUY", { telemetry: false }).dropped, true);
    assert.equal(normalizeStoredScan(42, { telemetry: false }).dropped, true);
  });

  it("returns dropped:true for an unrecoverable verdict", () => {
    const out = normalizeStoredScan({ id: "x", verdict: "PURPLE_RAIN" }, { telemetry: false });
    assert.equal(out.scan, null);
    assert.equal(out.dropped, true);
    assert.equal(out.changed, true);
  });
});

describe("normalizeStoredScan: fast path (already canonical at v3)", () => {
  it("returns unchanged when verdict is canonical and version is current", () => {
    const fresh = {
      id: "scan_1",
      verdict: "BUY",
      _schemaVersion: 3,
      legacy: { buySignal: "STRONG_BUY", _origin: "schema_v3_write" },
    };
    const out = normalizeStoredScan(fresh, { telemetry: false });
    assert.equal(out.changed, false);
    assert.equal(out.dropped, false);
    assert.equal(out.scan, fresh);   // identity preserved
  });

  it("does NOT short-circuit when version matches but verdict isn't canonical", () => {
    const broken = { id: "x", verdict: "STRONG_BUY", _schemaVersion: 3 };
    const out = normalizeStoredScan(broken, { telemetry: false });
    assert.equal(out.changed, true);
    assert.equal(out.scan.verdict, "BUY");
  });
});

describe("normalizeStoredScan: v1 → v3 upgrade", () => {
  it("upgrades a record that only has legacy buySignal", () => {
    const v1 = {
      id: "scan_42",
      query: "supreme box logo",
      buySignal: "STRONG_BUY",
      primaryAction: "BUY",
      bestPrice: 250,
    };
    const out = normalizeStoredScan(v1, { telemetry: false });
    assert.equal(out.changed, true);
    assert.equal(out.dropped, false);
    assert.equal(out.scan.verdict, "BUY");
    assert.equal(out.scan._schemaVersion, 3);
    assert.equal(out.scan.legacy.buySignal, "STRONG_BUY");
    assert.equal(out.scan.legacy.primaryAction, "BUY");
    assert.equal(out.scan.legacy._origin, "schema_v1_upgrade");
    // Record body is preserved
    assert.equal(out.scan.id, "scan_42");
    assert.equal(out.scan.query, "supreme box logo");
    assert.equal(out.scan.bestPrice, 250);
    // Top-level legacy verdict fields are stripped
    assert.equal("buySignal" in out.scan, false);
    assert.equal("primaryAction" in out.scan, false);
  });

  it("falls back to profitIntelSnapshot.buySignal", () => {
    const v1 = {
      id: "scan_43",
      profitIntelSnapshot: { buySignal: "GOOD_DEAL", priceStats: { median: 100 } },
    };
    const out = normalizeStoredScan(v1, { telemetry: false });
    assert.equal(out.scan.verdict, "BUY");
    assert.equal(out.scan.legacy.profitIntelBuySignal, "GOOD_DEAL");
    // Non-verdict data inside profitIntelSnapshot is preserved
    assert.equal(out.scan.profitIntelSnapshot.priceStats.median, 100);
  });

  it("legacy GREAT_FLIP normalizes to BUY", () => {
    const v1 = { id: "x", buySignal: "GREAT_FLIP" };
    const out = normalizeStoredScan(v1, { telemetry: false });
    assert.equal(out.scan.verdict, "BUY");
    assert.equal(out.scan.legacy.buySignal, "GREAT_FLIP");
  });

  it("legacy BUY_WITH_CAUTION normalizes to HOLD", () => {
    const v1 = { id: "x", buySignal: "BUY_WITH_CAUTION" };
    const out = normalizeStoredScan(v1, { telemetry: false });
    assert.equal(out.scan.verdict, "HOLD");
    assert.equal(out.scan.legacy.buySignal, "BUY_WITH_CAUTION");
  });

  it("legacy AUTHENTICATE_FIRST normalizes to HOLD", () => {
    const v1 = { id: "x", buySignal: "AUTHENTICATE_FIRST" };
    const out = normalizeStoredScan(v1, { telemetry: false });
    assert.equal(out.scan.verdict, "HOLD");
    assert.equal(out.scan.legacy.buySignal, "AUTHENTICATE_FIRST");
  });

  it("legacy OVERPRICED normalizes to PASS", () => {
    const v1 = { id: "x", buySignal: "OVERPRICED" };
    const out = normalizeStoredScan(v1, { telemetry: false });
    assert.equal(out.scan.verdict, "PASS");
  });
});

describe("normalizeStoredScan: v2 → v3 upgrade", () => {
  it("upgrades a v2 doc that already had a canonical top-level verdict", () => {
    const v2 = {
      id: "scan_v2",
      verdict: "PASS",
      buySignal: "OVERPRICED",
      _schemaVersion: 2,
    };
    const out = normalizeStoredScan(v2, { telemetry: false });
    assert.equal(out.changed, true);
    assert.equal(out.scan._schemaVersion, 3);
    assert.equal(out.scan.verdict, "PASS");
    assert.equal(out.scan.legacy.buySignal, "OVERPRICED");
    assert.equal(out.scan.legacy._origin, "schema_v2_upgrade");
  });

  it("when v2 verdict and legacy disagree, prefers the explicit verdict field", () => {
    const v2 = {
      id: "x",
      verdict: "PASS",
      buySignal: "STRONG_BUY",  // contradictory but archived
      _schemaVersion: 2,
    };
    const out = normalizeStoredScan(v2, { telemetry: false });
    assert.equal(out.scan.verdict, "PASS");
    assert.equal(out.scan.legacy.buySignal, "STRONG_BUY");
  });
});

describe("normalizeStoredScan: legacy archive carry-forward", () => {
  it("preserves keys already on .legacy when re-normalizing", () => {
    const stale = {
      id: "x",
      verdict: "STRONG_BUY",         // requires re-normalization
      _schemaVersion: 3,
      legacy: { extraKey: "preserved-me", _origin: "schema_v1_upgrade" },
    };
    const out = normalizeStoredScan(stale, { telemetry: false });
    assert.equal(out.changed, true);
    assert.equal(out.scan.legacy.extraKey, "preserved-me");
    assert.equal(out.scan.legacy._origin, "schema_v3_repaired");
  });
});

describe("hydrateStoredScan", () => {
  it("returns the normalized scan or null", () => {
    assert.equal(hydrateStoredScan(null, { telemetry: false }), null);
    assert.equal(
      hydrateStoredScan({ verdict: "PURPLE" }, { telemetry: false }),
      null
    );
    const ok = hydrateStoredScan({ id: "y", buySignal: "STEAL_DEAL" }, { telemetry: false });
    assert.equal(ok.verdict, "BUY");
  });
});

describe("isStoredScanFresh", () => {
  it("true only when v3 + canonical verdict", () => {
    assert.equal(isStoredScanFresh({ verdict: "BUY", _schemaVersion: 3 }), true);
    assert.equal(isStoredScanFresh({ verdict: "BUY", _schemaVersion: 2 }), false);
    assert.equal(isStoredScanFresh({ verdict: "STRONG_BUY", _schemaVersion: 3 }), false);
    assert.equal(isStoredScanFresh(null), false);
    assert.equal(isStoredScanFresh("BUY"), false);
  });
});

describe("buildFreshStoredScan", () => {
  it("stamps v3 + archives legacy", () => {
    const out = buildFreshStoredScan(
      { id: "x", buySignal: "STRONG_BUY", primaryAction: "BUY", query: "q" },
      "BUY"
    );
    assert.equal(out._schemaVersion, 3);
    assert.equal(out.verdict, "BUY");
    assert.equal(out.legacy.buySignal, "STRONG_BUY");
    assert.equal(out.legacy._origin, "schema_v3_write");
    assert.equal("buySignal" in out, false);
  });

  it("throws when handed a non-canonical verdict (programmer error)", () => {
    assert.throws(
      () => buildFreshStoredScan({ id: "x" }, "STRONG_BUY"),
      /non-canonical verdict/
    );
  });
});

describe("normalizeStoredScan: telemetry", () => {
  it("emits cache-vs-normalized when verdict was non-canonical", () => {
    const events = [];
    setVerdictTelemetrySink((e) => events.push(e));
    try {
      normalizeStoredScan({ id: "x", verdict: "STRONG_BUY", _schemaVersion: 2 });
      assert.equal(events.length, 1);
      assert.equal(events[0].trigger, "cache-vs-normalized");
    } finally {
      setVerdictTelemetrySink(null);
    }
  });

  it("does NOT emit telemetry on the canonical v3 fast path", () => {
    const events = [];
    setVerdictTelemetrySink((e) => events.push(e));
    try {
      normalizeStoredScan({ id: "x", verdict: "BUY", _schemaVersion: 3 });
      assert.equal(events.length, 0);
    } finally {
      setVerdictTelemetrySink(null);
    }
  });

  it("emits unrecoverable telemetry when verdict cannot be salvaged", () => {
    const events = [];
    setVerdictTelemetrySink((e) => events.push(e));
    try {
      const out = normalizeStoredScan({ id: "x", verdict: "PURPLE_RAIN" });
      assert.equal(out.dropped, true);
      assert.equal(events.length, 1);
      assert.match(events[0].source, /unrecoverable/);
    } finally {
      setVerdictTelemetrySink(null);
    }
  });

  it("can suppress telemetry with telemetry:false", () => {
    const events = [];
    setVerdictTelemetrySink((e) => events.push(e));
    try {
      normalizeStoredScan(
        { id: "x", verdict: "STRONG_BUY", _schemaVersion: 2 },
        { telemetry: false }
      );
      assert.equal(events.length, 0);
    } finally {
      setVerdictTelemetrySink(null);
    }
  });
});
