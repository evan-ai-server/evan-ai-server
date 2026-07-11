import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usableItemCount,
  hasUsablePayload,
  isUsablePayloadCacheEntry,
} from "./marketPayloadCacheUsability.js";

// ── usableItemCount ──────────────────────────────────────────────────────────
test("usableItemCount: counts items on a normal payload", () => {
  assert.equal(usableItemCount({ items: [{ title: "a" }, { title: "b" }] }), 2);
});

test("usableItemCount: 0 for an empty items array", () => {
  assert.equal(usableItemCount({ items: [] }), 0);
});

test("usableItemCount: 0 for missing/non-array items, null, non-object", () => {
  assert.equal(usableItemCount({}), 0);
  assert.equal(usableItemCount({ items: "not-an-array" }), 0);
  assert.equal(usableItemCount(null), 0);
  assert.equal(usableItemCount(undefined), 0);
  assert.equal(usableItemCount("string"), 0);
});

test("usableItemCount: does not trust fullPayload/status/ok metadata alone", () => {
  // The proven incident shape: fullPayload:true, status:"complete", a verdict
  // block present — but items is empty. Must count 0, not be fooled by flags.
  assert.equal(
    usableItemCount({
      items: [],
      fullPayload: true,
      status: "complete",
      ok: true,
      buyOrPass: { verdict: "HOLD" },
    }),
    0
  );
});

// ── hasUsablePayload ─────────────────────────────────────────────────────────
test("hasUsablePayload: true for >=1 item", () => {
  assert.equal(hasUsablePayload({ items: [{ title: "x" }] }), true);
});

test("hasUsablePayload: false for the proven-incident 0-item full payload shape", () => {
  const incidentPayload = {
    items: [],
    fullPayload: true,
    status: "complete",
    buyOrPass: { verdict: "HOLD" },
    confidenceCalibration: { tier: 3 },
    query: "Hawaiian Airlines Airbus A330 diecast model",
  };
  assert.equal(hasUsablePayload(incidentPayload), false);
});

test("hasUsablePayload: false for null/undefined/non-object", () => {
  assert.equal(hasUsablePayload(null), false);
  assert.equal(hasUsablePayload(undefined), false);
  assert.equal(hasUsablePayload(42), false);
});

// ── isUsablePayloadCacheEntry ────────────────────────────────────────────────
test("isUsablePayloadCacheEntry: true for a real cached entry with items", () => {
  const entry = {
    payload: { items: [{ title: "A330 GeminiJets 1:400" }] },
    ts: Date.now(),
    route: "/market/search/stream",
  };
  assert.equal(isUsablePayloadCacheEntry(entry), true);
});

test("isUsablePayloadCacheEntry: false for the incident's 0-item cached entry", () => {
  const entry = {
    payload: { items: [], fullPayload: true, status: "complete" },
    ts: Date.now(),
    route: "/market/search/stream",
    layer: "internal",
  };
  assert.equal(isUsablePayloadCacheEntry(entry), false);
});

test("isUsablePayloadCacheEntry: false for missing entry / missing payload", () => {
  assert.equal(isUsablePayloadCacheEntry(null), false);
  assert.equal(isUsablePayloadCacheEntry(undefined), false);
  assert.equal(isUsablePayloadCacheEntry({}), false);
  assert.equal(isUsablePayloadCacheEntry({ payload: null }), false);
});

// ── Incident replay (Phase C0.1 / Phase 6) ───────────────────────────────────
// index.js binds a network port at import time (app.listen with no
// require.main / import.meta guard), so it cannot be imported from a test
// file — every existing test in this repo exercises extracted pure src/
// modules instead, and this fix follows that convention. This harness
// reimplements, using ONLY the exported helpers above, the exact control
// flow added at the two edited call sites (getMarketScanResult /
// setMarketScanResult in index.js) so the wiring is proven at the highest
// practical level without duplicating cache-key derivation or touching the
// running server. Anything logged goes into a plain array instead of
// console.log so assertions can inspect it directly.
function makeSimulatedCrossRouteCache() {
  const store = new Map();
  const writeLog = [];
  const readLog = [];

  // Mirrors the new guard at the top of index.js's setMarketScanResult.
  function set(key, payloadWrapper) {
    if (!hasUsablePayload(payloadWrapper?.payload)) {
      writeLog.push({
        marker: "MARKET_EMPTY_PAYLOAD_CACHE_WRITE_SKIPPED",
        route: payloadWrapper?.route || null,
        layer: payloadWrapper?.layer || null,
        itemCount: usableItemCount(payloadWrapper?.payload),
      });
      return;
    }
    store.set(key, { ...payloadWrapper, ts: Date.now() });
  }

  // Mirrors the new guard inside index.js's getMarketScanResult loop body.
  function get(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (!isUsablePayloadCacheEntry(entry)) {
      readLog.push({
        marker: "MARKET_EMPTY_PAYLOAD_CACHE_IGNORED",
        hitKey: key,
        itemCount: usableItemCount(entry.payload),
      });
      store.delete(key);
      return null;
    }
    return { ...entry, hitKey: key };
  }

  return { store, writeLog, readLog, set, get };
}

test("incident replay: L1 internal branch's 0-item write never reaches the cache", () => {
  const cache = makeSimulatedCrossRouteCache();
  const key = "scan:c.mrf0zivy.mgyy";
  // The exact proven-incident shape: aircraft identity lock zeroed the items
  // (strongFamilyCount 0) but the payload still looked "complete".
  cache.set(key, {
    payload: {
      items: [],
      fullPayload: true,
      status: "complete",
      query: "Hawaiian Airlines Airbus A330 diecast model",
    },
    route: "/market/search/stream",
    layer: "internal",
  });
  assert.equal(cache.store.has(key), false, "a 0-item payload must never be persisted");
  assert.equal(cache.writeLog.length, 1);
  assert.equal(cache.writeLog[0].marker, "MARKET_EMPTY_PAYLOAD_CACHE_WRITE_SKIPPED");
  assert.equal(cache.writeLog[0].layer, "internal");
});

test("incident replay: fallback route reads a miss, not a poisoned hit, when the write was skipped", () => {
  const cache = makeSimulatedCrossRouteCache();
  const key = "img:655f98d4d474c7dc2da8164066c0432c9b70d44afa93a6b50acc1bf782c84ad1";
  cache.set(key, { payload: { items: [] }, route: "/market/search/stream", layer: "internal" });
  // The legacy fallback (/market/search) reads the SAME key the stream wrote.
  const hit = cache.get(key);
  assert.equal(hit, null, "empty cache entry must read back as a miss, not PAYLOAD_CACHE_HIT");
  // A null return means the caller (index.js line ~30733's
  // `if (_crossRouteCache && _crossRouteCache.payload)`) falls through to
  // PAYLOAD_CACHE_MISS and its unmodified fresh-provider / budget-refund
  // logic — that logic lives outside this pure module and is verified by
  // code inspection (see final report), not re-tested here.
});

test("incident replay: a legacy poisoned entry already in memory self-heals on next read", () => {
  const cache = makeSimulatedCrossRouteCache();
  const key = "scan:c.legacy_poisoned_pre_fix";
  // Simulate an entry written before this fix shipped (bypasses the new
  // write guard entirely, direct Map insert) to prove the read-side guard
  // alone is sufficient to neutralize memory that is already poisoned.
  cache.store.set(key, { payload: { items: [] }, ts: Date.now(), route: "/market/search/stream" });
  const first = cache.get(key);
  assert.equal(first, null);
  assert.equal(cache.store.has(key), false, "poisoned entry must be deleted on read (self-heal)");
  assert.equal(cache.readLog.length, 1);
  assert.equal(cache.readLog[0].marker, "MARKET_EMPTY_PAYLOAD_CACHE_IGNORED");
});

test("incident replay: non-empty entry still hits normally, unaffected", () => {
  const cache = makeSimulatedCrossRouteCache();
  const key = "scan:c.healthy_scan";
  cache.set(key, {
    payload: {
      items: [{ title: "Hawaiian Airlines A330 GeminiJets 1:400", price: 42 }],
      fullPayload: true,
    },
    route: "/market/search/stream",
    layer: "serp",
  });
  const hit = cache.get(key);
  assert.ok(hit, "non-empty payload must still be a valid hit");
  assert.equal(hit.payload.items.length, 1);
  assert.equal(cache.readLog.length, 0, "no MARKET_EMPTY_PAYLOAD_CACHE_IGNORED for a healthy entry");
  assert.equal(cache.writeLog.length, 0, "no write-skip for a healthy entry");
});

test("incident replay: write-skip does not mutate the caller's own payload object", () => {
  // The current request's own response (res.json / SSE send) is built from
  // this same object BEFORE setMarketScanResult is ever called in index.js.
  // The guard must only skip the cache write, never touch the object the
  // caller is about to serve to its own request.
  const payloadWrapper = {
    payload: { items: [], query: "Hawaiian Airlines Airbus A330 diecast model" },
    route: "/market/search/stream",
    layer: "internal",
  };
  const before = JSON.stringify(payloadWrapper);
  const cache = makeSimulatedCrossRouteCache();
  cache.set("scan:c.mutation_check", payloadWrapper);
  assert.equal(JSON.stringify(payloadWrapper), before, "the wrapper must not be mutated by the write-skip guard");
});

test("incident replay: identity-lock zero-result scan — cache stays clean across repeated writes", () => {
  const cache = makeSimulatedCrossRouteCache();
  const key = "scan:c.identity_locked_zero";
  // Multiple layers can attempt to write for the same scan (internal, then
  // serp, etc.) — every zero-item attempt must be skipped independently.
  cache.set(key, { payload: { items: [] }, route: "/market/search/stream", layer: "internal" });
  cache.set(key, { payload: { items: [] }, route: "/market/search/stream", layer: "serp" });
  assert.equal(cache.store.has(key), false);
  assert.equal(cache.writeLog.length, 2);
  assert.equal(cache.get(key), null, "still a clean miss — nothing to poison a later fallback with");
});
