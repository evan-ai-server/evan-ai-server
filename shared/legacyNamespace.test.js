// shared/legacyNamespace.test.js
// Phase 3 legacy-namespace tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleLegacyNamespace } from "./legacyNamespace.js";

test("assembleLegacyNamespace returns a frozen object even on empty input", () => {
  const ns = assembleLegacyNamespace({});
  assert.equal(Object.isFrozen(ns), true);
  assert.equal(ns.profitIntelBuySignal,      null);
  assert.equal(ns.dealQualityVerdict,        null);
  assert.equal(ns.dealQualityVerdictLabel,   null);
  assert.equal(ns.dealEngineVerdict,         null);
  assert.equal(ns.swarmBuySignal,            null);
  assert.equal(ns.smartAlertType,            null);
  assert.deepEqual(ns._trace,                []);
});

test("assembleLegacyNamespace tolerates null and undefined input", () => {
  assert.equal(Object.isFrozen(assembleLegacyNamespace(null)),      true);
  assert.equal(Object.isFrozen(assembleLegacyNamespace(undefined)), true);
});

test("assembleLegacyNamespace pulls every known legacy verdict surface", () => {
  const payload = {
    profitIntel:    { buySignal: "STRONG BUY" },
    dealComparator: {
      verdict: {
        verdict:           "steal",
        verdictLabel:      "STEAL",
        dealEngineVerdict: "BUY",
      },
    },
    swarmResult: { buySignal: "STRONG_BUY" },
    smartAlerts: { primaryAlert: { alertType: "STEAL_DEAL" } },
  };
  const ns = assembleLegacyNamespace(payload);
  assert.equal(ns.profitIntelBuySignal,    "STRONG BUY");
  assert.equal(ns.dealQualityVerdict,      "steal");
  assert.equal(ns.dealQualityVerdictLabel, "STEAL");
  assert.equal(ns.dealEngineVerdict,       "BUY");
  assert.equal(ns.swarmBuySignal,          "STRONG_BUY");
  assert.equal(ns.smartAlertType,          "STEAL_DEAL");
});

test("assembleLegacyNamespace _trace records each legacy system + canonical mapping", () => {
  const ns = assembleLegacyNamespace({
    profitIntel: { buySignal: "STRONG BUY" },
    swarmResult: { buySignal: "GOOD_DEAL" },
    dealComparator: { verdict: { verdict: "price_trap" } },
  });
  assert.equal(ns._trace.length, 3);
  const bySystem = Object.fromEntries(ns._trace.map(t => [t.system, t]));
  assert.equal(bySystem["profitIntel.buySignal"].normalized,          "BUY");
  assert.equal(bySystem["swarmOrchestrator.buySignal"].normalized,    "BUY");
  assert.equal(bySystem["dealComparator.verdict.verdict"].normalized, "PASS");
});

test("assembleLegacyNamespace _trace marks unmappable legacy values with normalized: null", () => {
  const ns = assembleLegacyNamespace({
    profitIntel: { buySignal: "ZOMBIE_SIGNAL_FROM_2024" },
  });
  assert.equal(ns._trace[0].system,     "profitIntel.buySignal");
  assert.equal(ns._trace[0].raw,        "ZOMBIE_SIGNAL_FROM_2024");
  assert.equal(ns._trace[0].normalized, null);
});

test("assembleLegacyNamespace _trace skips legacy systems that produced nothing", () => {
  const ns = assembleLegacyNamespace({ profitIntel: { buySignal: "BUY" } });
  assert.equal(ns._trace.length, 1);
  assert.equal(ns._trace[0].system, "profitIntel.buySignal");
});

test("assembleLegacyNamespace _trace entries are individually frozen", () => {
  const ns = assembleLegacyNamespace({ profitIntel: { buySignal: "STRONG BUY" } });
  assert.equal(Object.isFrozen(ns._trace),    true);
  assert.equal(Object.isFrozen(ns._trace[0]), true);
});

test("assembleLegacyNamespace ignores empty strings and non-string types", () => {
  const ns = assembleLegacyNamespace({
    profitIntel: { buySignal: "" },
    swarmResult: { buySignal: 0 },
    dealComparator: { verdict: { verdict: { nested: "object" } } },
  });
  assert.equal(ns.profitIntelBuySignal, null);
  assert.equal(ns.swarmBuySignal,       null);
  assert.equal(ns.dealQualityVerdict,   null);
  assert.deepEqual(ns._trace,           []);
});

test("assembleLegacyNamespace prefers swarmResult.buySignal over swarm.buySignal alias", () => {
  const ns = assembleLegacyNamespace({
    swarmResult: { buySignal: "PRIMARY" },
    swarm:       { buySignal: "FALLBACK" },
  });
  assert.equal(ns.swarmBuySignal, "PRIMARY");
});

test("assembleLegacyNamespace falls back to swarm.buySignal when swarmResult missing", () => {
  const ns = assembleLegacyNamespace({ swarm: { buySignal: "FALLBACK" } });
  assert.equal(ns.swarmBuySignal, "FALLBACK");
});
