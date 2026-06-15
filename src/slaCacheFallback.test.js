import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSlaExhausted,
  classifyBudgetCacheKey,
  selectSlaFallbackSource,
  SLA_EXHAUSTED_THRESHOLD_MS,
} from "./slaCacheFallback.js";

// ── isSlaExhausted ─────────────────────────────────────────────────────────
test("isSlaExhausted: the live 730ms case is exhausted", () => {
  assert.equal(isSlaExhausted(730), true);
});

test("isSlaExhausted: boundary + ample budget", () => {
  assert.equal(isSlaExhausted(SLA_EXHAUSTED_THRESHOLD_MS), true); // exactly 800 → exhausted
  assert.equal(isSlaExhausted(801), false);
  assert.equal(isSlaExhausted(2040), false); // the warm-scan budget from earlier logs
  assert.equal(isSlaExhausted(0), true);
  assert.equal(isSlaExhausted(-50), true);
});

test("isSlaExhausted: null / non-numeric never exhausts (no client SLA stamp)", () => {
  assert.equal(isSlaExhausted(null), false);
  assert.equal(isSlaExhausted(undefined), false);
  assert.equal(isSlaExhausted(NaN), false);
  assert.equal(isSlaExhausted("700"), false);
});

test("isSlaExhausted: custom threshold respected", () => {
  assert.equal(isSlaExhausted(900, 1000), true);
  assert.equal(isSlaExhausted(900, 800), false);
});

// ── classifyBudgetCacheKey ─────────────────────────────────────────────────
test("classifyBudgetCacheKey distinguishes payload vs query keys", () => {
  assert.equal(classifyBudgetCacheKey("scan:c.mqenykys.uv9urd"), "payload");
  assert.equal(classifyBudgetCacheKey("img:fb72695993c5"), "payload");
  assert.equal(classifyBudgetCacheKey("q:hawaiian airlines boeing 787 diecast model airplane|u_123"), "query");
  assert.equal(classifyBudgetCacheKey(""), null);
  assert.equal(classifyBudgetCacheKey(null), null);
  assert.equal(classifyBudgetCacheKey("weird"), null);
});

// ── selectSlaFallbackSource ────────────────────────────────────────────────
test("in-memory payload hit (scan/img key) → payload_cache", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: true, inMemoryHitKey: "scan:c.abc" });
  assert.deepEqual(r, { source: "payload_cache", log: "MARKET_SLA_EXHAUSTED_PAYLOAD_CACHE_HIT" });
});

test("in-memory query hit (q: key) → query_cache", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: true, inMemoryHitKey: "q:foo|u" });
  assert.deepEqual(r, { source: "query_cache", log: "MARKET_SLA_EXHAUSTED_QUERY_CACHE_HIT" });
});

test("in-memory hit with unknown key still serves payload_cache (it IS a hit)", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: true, inMemoryHitKey: null });
  assert.equal(r.source, "payload_cache");
});

test("no in-memory, persistent snapshot clean pool meets target → internal_snapshot (the V3.5 fix)", () => {
  // the live Hawaiian 787 disk snapshot had 9 clean items, target is 8
  const r = selectSlaFallbackSource({ inMemoryHit: false, snapshotCleanCount: 9, minCleanTarget: 8 });
  assert.deepEqual(r, { source: "internal_snapshot", log: "MARKET_SLA_EXHAUSTED_INTERNAL_SNAPSHOT_HIT" });
});

test("no in-memory, snapshot clean pool below target → miss (do not serve a thin/dirty pool)", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: false, snapshotCleanCount: 3, minCleanTarget: 8 });
  assert.deepEqual(r, { source: "miss", log: "MARKET_SLA_EXHAUSTED_CACHE_FALLBACK_MISS" });
});

test("no in-memory, no snapshot at all → miss", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: false, snapshotCleanCount: 0, minCleanTarget: 8 });
  assert.equal(r.source, "miss");
});

test("exactly at min target is served (>= boundary)", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: false, snapshotCleanCount: 8, minCleanTarget: 8 });
  assert.equal(r.source, "internal_snapshot");
});

test("in-memory hit always wins over snapshot count", () => {
  const r = selectSlaFallbackSource({ inMemoryHit: true, inMemoryHitKey: "scan:x", snapshotCleanCount: 0, minCleanTarget: 8 });
  assert.equal(r.source, "payload_cache");
});

// ── end-to-end: the live scenario resolves to the snapshot ─────────────────
test("end-to-end — live SLA-exhausted Hawaiian scan resolves to internal_snapshot", () => {
  const remainingMs = 730; // from MARKET_SKIPPED_SLA_EXHAUSTED
  assert.equal(isSlaExhausted(remainingMs), true);
  // in-memory cross-route cache was wiped by the restart → miss; disk snapshot had 9
  const decision = selectSlaFallbackSource({
    inMemoryHit: false,
    snapshotCleanCount: 9,
    minCleanTarget: 8,
  });
  assert.equal(decision.source, "internal_snapshot");
});
