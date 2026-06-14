import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";

// Isolate disk persistence to a throwaway temp dir so this test never writes
// into the real storage/scan-similarity store. The module reads STORAGE_DIR at
// load time, so set the env BEFORE the dynamic import below.
process.env.SCAN_SIMILARITY_STORAGE_DIR = path.join(os.tmpdir(), `scan-sim-test-${process.pid}-${Date.now()}`);

let register, findSimilar, remove, getStats, clear;
before(async () => {
  ({ register, findSimilar, remove, getStats, clear } = await import("./scanSimilarity.js"));
});

// Deterministic unit vectors so cosine similarity is exact (1.0 self-match).
const VEC_A = [1, 0, 0, 0];
const VEC_B = [0, 1, 0, 0];
const PAYLOAD_A = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", identity: { category: "diecast model" }, confidence: 0.95 };

afterEach(() => clear());

test("remove() forgets a registered entry so findSimilar misses (the V3.2 self-heal)", () => {
  register("hashA", VEC_A, PAYLOAD_A);
  const hit = findSimilar(VEC_A, 0.92);
  assert.ok(hit, "entry should be found before removal");
  assert.equal(hit.imageHash, "hashA");
  assert.equal(hit.payload.query, PAYLOAD_A.query);

  const existed = remove("hashA");
  assert.equal(existed, true, "remove reports the entry was present");

  const after = findSimilar(VEC_A, 0.92);
  assert.equal(after, null, "entry must be gone after self-heal removal");
});

test("remove() only drops the targeted entry, not siblings", () => {
  register("hashA", VEC_A, PAYLOAD_A);
  register("hashB", VEC_B, { query: "Nike Vaporfly", identity: { category: "sneakers" }, confidence: 0.9 });

  remove("hashA");

  assert.equal(findSimilar(VEC_A, 0.92), null, "removed entry is gone");
  const stillThere = findSimilar(VEC_B, 0.92);
  assert.ok(stillThere, "untouched entry survives");
  assert.equal(stillThere.imageHash, "hashB");
});

test("remove() on a missing/empty hash is a safe no-op", () => {
  assert.equal(remove("does-not-exist"), false);
  assert.equal(remove(""), false);
  assert.equal(remove(null), false);
});

test("removals stat increments on each remove call", () => {
  register("hashA", VEC_A, PAYLOAD_A);
  const before = getStats().removals || 0;
  remove("hashA");
  remove("does-not-exist");
  assert.equal((getStats().removals || 0) - before, 2);
});
