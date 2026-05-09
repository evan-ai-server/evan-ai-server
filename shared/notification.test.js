// shared/notification.test.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  REASON_CODES,
  assertNotificationClean,
  buildNotification,
  buildNotificationFromVerdict,
} from "./notification.js";
import { VerdictLeakError } from "./verdict.js";

const LEGACY_PHRASES = [
  "STRONG_BUY", "STRONG BUY",
  "GOOD_DEAL", "GREAT_FLIP",
  "STEAL_DEAL", "STEAL DEAL",
  "BUY_WITH_CAUTION", "BUY WITH CAUTION",
  "AUTHENTICATE_FIRST", "AUTHENTICATE FIRST",
  "PRICE_TRAP",
  "INSUFFICIENT_DATA",
  "OVERPRICED",
];

function containsLegacy(s) {
  if (typeof s !== "string") return false;
  const upper = s.toUpperCase();
  return LEGACY_PHRASES.some((p) => upper.includes(p.toUpperCase()));
}

describe("buildNotificationFromVerdict: canonical verdict gate", () => {
  it("throws on a legacy verdict string", () => {
    assert.throws(
      () => buildNotificationFromVerdict({ verdict: "STRONG_BUY" }),
      VerdictLeakError
    );
  });

  it("throws on null / undefined", () => {
    assert.throws(() => buildNotificationFromVerdict({ verdict: null }), VerdictLeakError);
    assert.throws(() => buildNotificationFromVerdict({}), VerdictLeakError);
  });

  it("accepts BUY/HOLD/PASS", () => {
    for (const v of ["BUY", "HOLD", "PASS"]) {
      const n = buildNotificationFromVerdict({ verdict: v });
      assert.equal(n.verdict, v);
      assert.equal(typeof n.title, "string");
      assert.equal(typeof n.body, "string");
    }
  });
});

describe("buildNotificationFromVerdict: reason code routing", () => {
  it("uses the matching template when verdict + reason match", () => {
    const n = buildNotificationFromVerdict({
      verdict: "BUY",
      reasonCode: REASON_CODES.PRICE_DROP_ALERT,
    });
    assert.match(n.title, /price drop/i);
    assert.equal(n.reasonCode, REASON_CODES.PRICE_DROP_ALERT);
  });

  it("falls back to DEFAULT when reason has no template for that verdict", () => {
    const n = buildNotificationFromVerdict({
      verdict: "PASS",
      reasonCode: REASON_CODES.PRICE_DROP_ALERT,  // PRICE_DROP_ALERT only valid for BUY
    });
    assert.equal(n.reasonCode, REASON_CODES.DEFAULT);
  });

  it("falls back to DEFAULT when reason isn't in REASON_CODES", () => {
    const n = buildNotificationFromVerdict({
      verdict: "BUY",
      reasonCode: "STRONG_BUY",  // legacy enum, NOT a reason
    });
    assert.equal(n.reasonCode, REASON_CODES.DEFAULT);
  });
});

describe("buildNotificationFromVerdict: ZERO legacy strings in output", () => {
  // Exhaustively walks every (verdict, reason) combo and asserts that
  // neither title nor body contains any forbidden legacy phrase.
  it("no legacy phrases ever appear in title or body", () => {
    for (const v of ["BUY", "HOLD", "PASS"]) {
      for (const r of Object.values(REASON_CODES)) {
        const n = buildNotificationFromVerdict({ verdict: v, reasonCode: r });
        assert.equal(containsLegacy(n.title), false, `title leaked legacy: ${n.title}`);
        assert.equal(containsLegacy(n.body),  false, `body leaked legacy: ${n.body}`);
      }
    }
  });

  it("forbidden phrases in `data` are stripped", () => {
    const n = buildNotificationFromVerdict({
      verdict: "BUY",
      reasonCode: REASON_CODES.PRICE_BELOW_MARKET,
      data: { signal: "STRONG_BUY", url: "https://x", priceCents: 1500 },
    });
    assert.equal("signal" in n.data, false);
    assert.equal(n.data.url, "https://x");
    assert.equal(n.data.priceCents, 1500);
  });
});

describe("buildNotification: record-shaped input", () => {
  it("returns null when no canonical verdict can be derived", () => {
    assert.equal(buildNotification({ record: {} }), null);
    assert.equal(buildNotification({ record: { verdict: "PURPLE" } }), null);
  });

  it("normalizes legacy buySignal", () => {
    const n = buildNotification({ record: { buySignal: "GREAT_FLIP" } });
    assert.equal(n.verdict, "BUY");
    assert.equal(containsLegacy(n.title), false);
    assert.equal(containsLegacy(n.body), false);
  });

  it("prefers record.verdict over record.buySignal when present", () => {
    const n = buildNotification({
      record: { verdict: "PASS", buySignal: "STRONG_BUY" },
    });
    assert.equal(n.verdict, "PASS");
  });

  it("never produces 'AUTHENTICATE_FIRST' in body for legacy AUTHENTICATE_FIRST input", () => {
    const n = buildNotification({ record: { buySignal: "AUTHENTICATE_FIRST" } });
    assert.equal(n.verdict, "HOLD");
    assert.equal(containsLegacy(n.title), false);
    assert.equal(containsLegacy(n.body), false);
  });

  it("never produces 'BUY_WITH_CAUTION' anywhere", () => {
    const n = buildNotification({ record: { buySignal: "BUY_WITH_CAUTION" } });
    assert.equal(n.verdict, "HOLD");
    assert.equal(containsLegacy(n.title), false);
    assert.equal(containsLegacy(n.body), false);
  });
});

describe("assertNotificationClean", () => {
  it("throws when title contains a forbidden phrase", () => {
    assert.throws(() => assertNotificationClean({
      title: "🔥 STRONG_BUY: nice item",
      body: "ok",
    }), /forbidden legacy phrase/);
  });

  it("throws when body contains a forbidden phrase", () => {
    assert.throws(() => assertNotificationClean({
      title: "ok",
      body: "Verdict: GREAT_FLIP",
    }), /forbidden legacy phrase/);
  });

  it("passes a clean notification", () => {
    assert.doesNotThrow(() => assertNotificationClean({
      title: "Below-market price",
      body: "This price beats the typical market rate.",
    }));
  });
});
