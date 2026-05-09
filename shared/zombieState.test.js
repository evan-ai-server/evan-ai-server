// shared/zombieState.test.js
// =====================================================================
// PHASE 12 — Zombie state regression suite.
//
// "Zombie state" = a stored/cached/incoming payload from BEFORE the
// canonical Verdict authority existed. These records and notifications
// can still drift through the system (legacy GREAT_FLIP scans, push
// notifications saved on the device, deep-link payloads with
// AUTHENTICATE_FIRST, half-decoded background-resume snapshots, …).
//
// This suite asserts that for every legacy / corrupted / half-formed
// shape, the system produces a CONSISTENT canonical experience across
// the surfaces the spec calls out:
//
//   - hero    (verdict label & color via verdictLabel/verdictColor)
//   - panel   (verdict on the API payload)
//   - card    (verdict on the persisted record)
//   - animation
//   - haptics
//   - sound
//   - analytics (verdict on the analytics event)
//
// We don't run the real device runtime here; instead, every surface
// is represented by the canonical-verdict producer that drives it.
// If those producers all return the same Verdict, the device cannot
// produce a "PASS text + BUY emotion" contradiction.
// =====================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  enforceVerdictOnPayload,
  isCanonicalVerdict,
  normalizeVerdict,
  sanitizePromptContext,
  verdictColor,
  verdictLabel,
} from "./verdict.js";
import { hydrateStoredScan, normalizeStoredScan } from "./storedScan.js";
import {
  REASON_CODES,
  buildNotification,
  buildNotificationFromVerdict,
} from "./notification.js";
import {
  buildVerdictAnalyticsEvent,
  reportVerdictDisagreement,
  setVerdictTelemetrySink,
} from "./verdictTelemetry.js";

// ── A "scan-shaped" probe that walks every surface ────────────────────
// Returns the canonical verdict each surface produces. If they all match,
// the system cannot exhibit the "PASS text + BUY emotion" failure mode.

function deriveAllSurfaces({ scan, expectedVerdict }) {
  const hydrated = hydrateStoredScan(scan, { telemetry: false });
  if (!hydrated) {
    return { dropped: true };
  }
  const verdict = hydrated.verdict;

  // Hero / panel / card derive from the same canonical verdict field.
  const hero        = verdictLabel(verdict);
  const heroColor   = verdictColor(verdict);
  const panelVerdict= enforceVerdictOnPayload({ verdict }, "panel").verdict;
  const cardVerdict = hydrated.verdict;

  // Notifications generated from canonical verdict + reasonCode.
  const note = buildNotification({
    record: hydrated,
    source: "test_zombie",
  });

  // Animation / haptics / sound — these are abstracted on device into
  // a (verdict → preset) map that mirrors verdictColor on the server.
  // We model the same mapping here so the test can fail if a future
  // change desyncs the preset table from the canonical verdict.
  const animation = ANIMATION_MAP[verdict];
  const haptics   = HAPTICS_MAP[verdict];
  const sound     = SOUND_MAP[verdict];

  // Analytics keyed by canonical verdict.
  const analytics = buildVerdictAnalyticsEvent({
    event:   "scan_zombie",
    verdict,
    source:  "cache",
    legacy:  scan?.legacy ?? null,
  });

  return {
    dropped: false,
    expectedVerdict,
    surfaces: {
      hero, heroColor, panelVerdict, cardVerdict,
      notificationVerdict: note?.verdict ?? null,
      animation, haptics, sound,
      analyticsVerdict: analytics.verdict,
    },
  };
}

// Server-side surrogate for the device emotional layer.
// On the device these are RN Animated presets / Haptics types /
// expo-av sound assets — but they're keyed off verdict. The canonical
// shape here proves the keying contract; the device tests assert the
// concrete preset wiring.
const ANIMATION_MAP = Object.freeze({ BUY: "celebrate", HOLD: "pulse",   PASS: "shake"  });
const HAPTICS_MAP   = Object.freeze({ BUY: "success",   HOLD: "warning", PASS: "error"  });
const SOUND_MAP     = Object.freeze({ BUY: "ding.wav",  HOLD: "tone.wav",PASS: "buzz.wav"});

function assertEverySurfaceMatches(out, expected) {
  assert.equal(out.dropped, false, "scan unexpectedly dropped");
  const s = out.surfaces;
  assert.equal(s.hero,                expected, `hero=${s.hero}`);
  assert.equal(s.panelVerdict,        expected, `panel=${s.panelVerdict}`);
  assert.equal(s.cardVerdict,         expected, `card=${s.cardVerdict}`);
  assert.equal(s.notificationVerdict, expected, `notif=${s.notificationVerdict}`);
  assert.equal(s.analyticsVerdict,    expected, `analytics=${s.analyticsVerdict}`);
  assert.equal(s.animation, ANIMATION_MAP[expected]);
  assert.equal(s.haptics,   HAPTICS_MAP[expected]);
  assert.equal(s.sound,     SOUND_MAP[expected]);
  // Color polarity check (the most direct "BUY emotion" canary).
  if (expected === "BUY")  assert.equal(s.heroColor, "green");
  if (expected === "PASS") assert.equal(s.heroColor, "red");
  if (expected === "HOLD") assert.equal(s.heroColor, "neutral");
}

// =====================================================================
// 1. legacy GREAT_FLIP scan
// =====================================================================
describe("zombie: legacy GREAT_FLIP scan", () => {
  it("produces BUY consistently across every surface", () => {
    const scan = {
      id: "z1",
      buySignal: "GREAT_FLIP",
      query: "supreme box logo hoodie",
      bestPrice: 350,
    };
    assertEverySurfaceMatches(deriveAllSurfaces({ scan, expectedVerdict: "BUY" }), "BUY");
  });
});

// =====================================================================
// 2. legacy BUY_WITH_CAUTION scan
// =====================================================================
describe("zombie: legacy BUY_WITH_CAUTION scan", () => {
  it("produces HOLD consistently — never BUY emotion", () => {
    const scan = {
      id: "z2",
      buySignal: "BUY_WITH_CAUTION",
      profitIntelSnapshot: { buySignal: "BUY_WITH_CAUTION" },
    };
    assertEverySurfaceMatches(deriveAllSurfaces({ scan, expectedVerdict: "HOLD" }), "HOLD");
  });
});

// =====================================================================
// 3. legacy AUTHENTICATE_FIRST scan
// =====================================================================
describe("zombie: legacy AUTHENTICATE_FIRST scan", () => {
  it("produces HOLD with no celebratory emotional cues", () => {
    const scan = { id: "z3", buySignal: "AUTHENTICATE_FIRST" };
    const out = deriveAllSurfaces({ scan, expectedVerdict: "HOLD" });
    assertEverySurfaceMatches(out, "HOLD");
    assert.notEqual(out.surfaces.haptics, "success");
    assert.notEqual(out.surfaces.animation, "celebrate");
    // Notification copy must NOT include AUTHENTICATE_FIRST verbatim.
    const note = buildNotification({ record: hydrateStoredScan(scan, { telemetry: false }) });
    assert.equal(/AUTHENTICATE/i.test(note.title + " " + note.body), false);
  });
});

// =====================================================================
// 4. corrupted cache scan (verdict cannot be salvaged)
// =====================================================================
describe("zombie: corrupted cache scan", () => {
  it("is dropped at hydration — never renders", () => {
    const scan = { id: "z4", verdict: "PURPLE_RAIN" };
    const out = deriveAllSurfaces({ scan, expectedVerdict: null });
    assert.equal(out.dropped, true);
    // Phase 7 telemetry: caller's responsibility, but verifying that
    // normalizeStoredScan returns dropped:true here protects the rest.
    const norm = normalizeStoredScan(scan, { telemetry: false });
    assert.equal(norm.dropped, true);
  });

  it("partially-corrupt scan with salvageable buySignal still hydrates correctly", () => {
    const scan = { id: "z4b", verdict: "ZOMBIE", buySignal: "OVERPRICED" };
    assertEverySurfaceMatches(deriveAllSurfaces({ scan, expectedVerdict: "PASS" }), "PASS");
  });
});

// =====================================================================
// 5. offline restore scan (came back from disk, schema_v1)
// =====================================================================
describe("zombie: offline restore scan (schema_v1)", () => {
  it("upgrades to v3 + canonical verdict on hydration", () => {
    const scan = {
      id: "z5",
      buySignal: "STEAL_DEAL",
      // No _schemaVersion — pre-Phase-7 record.
    };
    const out = deriveAllSurfaces({ scan, expectedVerdict: "BUY" });
    assertEverySurfaceMatches(out, "BUY");
    const norm = normalizeStoredScan(scan, { telemetry: false });
    assert.equal(norm.scan._schemaVersion, 3);
    assert.equal(norm.scan.legacy._origin, "schema_v1_upgrade");
  });
});

// =====================================================================
// 6. notification deep link scan
// =====================================================================
describe("zombie: notification deep-link scan", () => {
  it("a notification payload that named GREAT_FLIP can't render BUY emotion with PASS text", () => {
    // Simulate a stored-on-device notification that the user taps to
    // open the app. The deep-link payload carries the legacy alertType
    // but we always render from the canonical verdict.
    const deepLink = {
      alertType: "GREAT_FLIP",   // legacy
      verdict:   "BUY",          // canonical sent alongside
      data:      { signal: "STRONG_BUY" },  // legacy that must NOT render
    };
    const note = buildNotificationFromVerdict({
      verdict:    deepLink.verdict,
      reasonCode: REASON_CODES.PRICE_BELOW_MARKET,
      source:     "deep_link",
      data:       deepLink.data,
    });
    assert.equal(note.verdict, "BUY");
    // Forbidden phrase scrubber takes "STRONG_BUY" out of `data`:
    assert.equal("signal" in note.data, false);
    // Title/body are template-derived and free of legacy strings.
    assert.equal(/STRONG[_ ]BUY|GREAT[_ ]FLIP/i.test(note.title + note.body), false);
  });

  it("when the deep link drifts (alertType: STEAL but verdict: PASS), telemetry fires", () => {
    const events = [];
    setVerdictTelemetrySink((e) => events.push(e));
    try {
      reportVerdictDisagreement({
        trigger:  "server-vs-client",
        source:   "deep_link/zombie6",
        expected: "PASS",                 // canonical (server)
        received: "STEAL_DEAL",           // raw legacy on device
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].expected, "PASS");
      assert.equal(events[0].received, "BUY");  // STEAL_DEAL normalizes to BUY
    } finally {
      setVerdictTelemetrySink(null);
    }
  });
});

// =====================================================================
// 7. background resume scan
// =====================================================================
describe("zombie: background-resume scan (RN warm-start with stale state)", () => {
  it("re-hydrates from the cache normalizer; no half-formed render leaks", () => {
    // Background resume: the app process was suspended with a "stale"
    // scan in memory, OS killed and relaunched, RN restores from disk.
    // The disk record may be schema_v1; the hydrate path must repair it
    // before the UI binds.
    const onDisk = {
      id: "z7",
      verdict: "STRONG_BUY",   // pre-Phase-7 stored as legacy
      _schemaVersion: 2,
    };
    const out = deriveAllSurfaces({ scan: onDisk, expectedVerdict: "BUY" });
    assertEverySurfaceMatches(out, "BUY");

    // The persistence layer must have rewritten the doc (changed:true)
    // so subsequent loads short-circuit on the v3 fast path.
    const norm = normalizeStoredScan(onDisk, { telemetry: false });
    assert.equal(norm.changed, true);
    assert.equal(norm.scan._schemaVersion, 3);
  });

  it("when an LLM prompt context is rehydrated mid-flight, sanitizer fully scrubs legacy", () => {
    const ctx = {
      itemName:   "Jordan 1 retro",
      verdict:    "STRONG_BUY",
      buyVerdict: "GREAT_FLIP",
      buySignal:  "OVERPRICED",   // contradiction inside ctx
    };
    const { ctx: clean, drifted } = sanitizePromptContext(ctx);
    // Every verdict-bearing field is canonical or null.
    for (const f of ["verdict", "buyVerdict", "buySignal"]) {
      const v = clean[f];
      assert.ok(v === null || isCanonicalVerdict(v), `field ${f} = ${v}`);
    }
    assert.equal(drifted.length, 3);
  });
});

// =====================================================================
// X. acceptance-criteria sanity: surface fan-out is consistent
// =====================================================================
describe("acceptance: scan produces identical verdict across all surfaces", () => {
  // Cross-product of (legacy input × canonical target).
  const ZOMBIE_INPUTS = /** @type {const} */ ([
    [{ buySignal: "STRONG_BUY"        }, "BUY"],
    [{ buySignal: "GREAT_FLIP"        }, "BUY"],
    [{ buySignal: "STEAL_DEAL"        }, "BUY"],
    [{ buySignal: "GOOD_DEAL"         }, "BUY"],
    [{ buySignal: "BUY_WITH_CAUTION"  }, "HOLD"],
    [{ buySignal: "AUTHENTICATE_FIRST"}, "HOLD"],
    [{ buySignal: "WATCH"             }, "HOLD"],
    [{ buySignal: "OVERPRICED"        }, "PASS"],
    [{ buySignal: "RISKY"             }, "PASS"],
    [{ buySignal: "INSUFFICIENT_DATA" }, "PASS"],
    [{ buySignal: "PRICE_TRAP"        }, "PASS"],
  ]);

  for (const [stub, expected] of ZOMBIE_INPUTS) {
    it(`${stub.buySignal} → every surface = ${expected}`, () => {
      const scan = { id: `acc_${stub.buySignal}`, ...stub };
      assertEverySurfaceMatches(deriveAllSurfaces({ scan, expectedVerdict: expected }), expected);
    });
  }
});

// =====================================================================
// Y. failure mode prevention: PASS text + BUY emotion is impossible
// =====================================================================
describe("failure mode: PASS text + BUY emotion combination cannot exist", () => {
  it("a PASS verdict yields red color, error haptics, shake animation", () => {
    const out = deriveAllSurfaces({
      scan: { id: "fmp", buySignal: "OVERPRICED" },
      expectedVerdict: "PASS",
    });
    assert.equal(out.surfaces.heroColor, "red");
    assert.equal(out.surfaces.haptics,   "error");
    assert.equal(out.surfaces.animation, "shake");
    assert.notEqual(out.surfaces.heroColor, "green");
    assert.notEqual(out.surfaces.haptics, "success");
  });

  it("a HOLD verdict never produces 'success' haptics or 'celebrate' animation", () => {
    const out = deriveAllSurfaces({
      scan: { id: "fmh", buySignal: "BUY_WITH_CAUTION" },
      expectedVerdict: "HOLD",
    });
    assert.notEqual(out.surfaces.haptics, "success");
    assert.notEqual(out.surfaces.animation, "celebrate");
  });

  it("a notification cannot have BUY verdict with PASS-style copy", () => {
    const note = buildNotificationFromVerdict({
      verdict: "PASS",
      reasonCode: REASON_CODES.PRICED_ABOVE_MARKET,
    });
    // Body is fixed, derived from a frozen lookup keyed by verdict.
    assert.equal(/buy now|act fast|🔥/i.test(note.body), false);
    assert.equal(note.verdict, "PASS");
  });
});
