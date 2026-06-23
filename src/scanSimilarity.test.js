import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import fs from "fs";
import path from "path";

const TEST_STORAGE = path.join(os.tmpdir(), `scan-sim-test-${process.pid}-${Date.now()}`);
process.env.SCAN_SIMILARITY_STORAGE_DIR = TEST_STORAGE;

let register, findSimilar, remove, getStats, clear, loadFromDisk, getSimilarityPayloadJunkReason;
before(async () => {
  ({ register, findSimilar, remove, getStats, clear, loadFromDisk, getSimilarityPayloadJunkReason } = await import("./scanSimilarity.js"));
});

// Deterministic unit vectors so cosine similarity is exact (1.0 self-match).
const VEC_A = [1, 0, 0, 0];
const VEC_B = [0, 1, 0, 0];
const PAYLOAD_A = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", identity: { category: "diecast model" }, confidence: 0.95 };

afterEach(() => {
  clear();
  // Flush any fire-and-forget disk writes from register() so no stale files
  // leak into subsequent loadFromDisk tests that re-import the module.
  try {
    const files = fs.readdirSync(TEST_STORAGE).filter((f) => f.endsWith(".json"));
    for (const f of files) fs.unlinkSync(path.join(TEST_STORAGE, f));
  } catch { /* dir may not exist yet */ }
});

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
  register("hashB", VEC_B, { query: "Nike Vaporfly Next% running shoe", identity: { category: "sneakers" }, confidence: 0.9 });

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

// ── Phase 5A.4E: junk classifier ──────────────────────────────────────

test("getSimilarityPayloadJunkReason returns null for valid payload", () => {
  assert.equal(getSimilarityPayloadJunkReason(PAYLOAD_A), null);
});

test("getSimilarityPayloadJunkReason rejects missing query", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: null }), "missing_query");
  assert.equal(getSimilarityPayloadJunkReason({ query: "" }), "missing_query");
  assert.equal(getSimilarityPayloadJunkReason({}), "missing_query");
});

test("getSimilarityPayloadJunkReason rejects whitespace-only query", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "   " }), "missing_query");
});

test("getSimilarityPayloadJunkReason rejects exact-token garbage query", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "item" }), "garbage_query");
  assert.equal(getSimilarityPayloadJunkReason({ query: "product" }), "garbage_query");
  assert.equal(getSimilarityPayloadJunkReason({ query: "unknown" }), "garbage_query");
});

test("getSimilarityPayloadJunkReason rejects generic phrase via rejected_generic tier", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "item for sale", visionTier: "rejected_generic" }), "low_quality_tier");
});

test("getSimilarityPayloadJunkReason preserves short real identities", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "AirPods Max" }), null);
  assert.equal(getSimilarityPayloadJunkReason({ query: "Rolex Submariner" }), null);
  assert.equal(getSimilarityPayloadJunkReason({ query: "ANA A380" }), null);
  assert.equal(getSimilarityPayloadJunkReason({ query: "iPhone 14" }), null);
  assert.equal(getSimilarityPayloadJunkReason({ query: "Leica M6" }), null);
});

test("getSimilarityPayloadJunkReason rejects hard_fail_no_seed tier", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "Hawaiian Airlines Boeing 787 diecast", visionTier: "hard_fail_no_seed" }), "low_quality_tier");
});

test("getSimilarityPayloadJunkReason rejects rejected_generic tier", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "Hawaiian Airlines Boeing 787 diecast", visionTier: "rejected_generic" }), "low_quality_tier");
});

test("getSimilarityPayloadJunkReason rejects low_quality tier", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "Hawaiian Airlines Boeing 787 diecast", visionTier: "low_quality" }), "low_quality_tier");
});

test("getSimilarityPayloadJunkReason accepts high-stakes real-identity payload", () => {
  assert.equal(getSimilarityPayloadJunkReason({ query: "Nike Air Jordan 1 Low OG", identity: { category: "sneakers" }, visionTier: "query_fast" }), null);
});

// ── Phase 5A.4E: register guard ───────────────────────────────────────

test("register rejects null query payload — no memory entry, stat incremented", () => {
  const before = getStats().registerSkipped;
  register("junk1", VEC_A, { query: null, identity: { category: "diecast model" }, confidence: 0 });
  assert.equal(findSimilar(VEC_A, 0.5), null);
  assert.equal(getStats().registerSkipped, before + 1);
});

test("register rejects whitespace query payload", () => {
  register("junk2", VEC_A, { query: "   ", identity: { category: "diecast model" } });
  assert.equal(findSimilar(VEC_A, 0.5), null);
});

test("register rejects garbage query payload", () => {
  register("junk3", VEC_A, { query: "item", identity: { category: "diecast model" } });
  assert.equal(findSimilar(VEC_A, 0.5), null);
});

test("register preserves short real identities", () => {
  register("short1", VEC_A, { query: "ANA A380", identity: { category: "diecast model" } });
  const hit = findSimilar(VEC_A, 0.5);
  assert.ok(hit);
  assert.equal(hit.imageHash, "short1");
  assert.equal(hit.payload.query, "ANA A380");
});

test("register rejects hard_fail_no_seed tier", () => {
  register("junk4", VEC_A, { query: "Hawaiian Airlines Boeing 787 diecast", visionTier: "hard_fail_no_seed" });
  assert.equal(findSimilar(VEC_A, 0.5), null);
});

test("register rejects rejected_generic tier", () => {
  register("junk5", VEC_A, { query: "Hawaiian Airlines Boeing 787 diecast", visionTier: "rejected_generic" });
  assert.equal(findSimilar(VEC_A, 0.5), null);
});

test("register rejects low_quality tier", () => {
  register("junk6", VEC_A, { query: "Hawaiian Airlines Boeing 787 diecast", visionTier: "low_quality" });
  assert.equal(findSimilar(VEC_A, 0.5), null);
});

test("register still accepts valid safe-category entry", () => {
  register("good1", VEC_A, PAYLOAD_A);
  const hit = findSimilar(VEC_A, 0.5);
  assert.ok(hit);
  assert.equal(hit.imageHash, "good1");
});

test("register still accepts valid high-stakes real-identity entry", () => {
  register("good2", VEC_B, { query: "Nike Air Jordan 1 Low OG", identity: { category: "sneakers" }, confidence: 0.9 });
  const hit = findSimilar(VEC_B, 0.5);
  assert.ok(hit);
  assert.equal(hit.imageHash, "good2");
});

test("register does not write junk to disk", async () => {
  register("diskjunk1", VEC_A, { query: null, visionTier: "hard_fail_no_seed" });
  await new Promise((r) => setTimeout(r, 50));
  const diskFile = path.join(TEST_STORAGE, "diskjunk1.json");
  assert.equal(fs.existsSync(diskFile), false);
});

// ── Phase 5A.4E: loadFromDisk prune + honest counters ─────────────────

test("loadFromDisk prunes TTL-expired files and returns honest counters", async () => {
  const dir = path.join(os.tmpdir(), `scan-sim-prune-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const expired = { imageHash: "exp1", vector: [1, 0], payload: { query: "Hawaiian Airlines Boeing 787 diecast", _payloadVersion: "v3" }, ts: Date.now() - 25 * 60 * 60 * 1000 };
  const live = { imageHash: "live1", vector: [0, 1], payload: { query: "ANA Airbus A380 diecast model", identity: { category: "diecast model" }, _payloadVersion: "v3" }, ts: Date.now() };
  fs.writeFileSync(path.join(dir, "exp1.json"), JSON.stringify(expired));
  fs.writeFileSync(path.join(dir, "live1.json"), JSON.stringify(live));

  const origDir = process.env.SCAN_SIMILARITY_STORAGE_DIR;
  process.env.SCAN_SIMILARITY_STORAGE_DIR = dir;
  const mod = await import(`./scanSimilarity.js?prune-ttl-${Date.now()}`);
  const result = await mod.loadFromDisk(500);
  process.env.SCAN_SIMILARITY_STORAGE_DIR = origDir;

  assert.equal(result.ttlExpired, 1);
  assert.equal(result.loaded, 1);
  // loadFromDisk unlinks are fire-and-forget — allow them to settle under load
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(path.join(dir, "exp1.json")), false, "expired file should be unlinked");
  assert.equal(fs.existsSync(path.join(dir, "live1.json")), true, "live file should remain");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadFromDisk prunes junk-query files and returns junkPruned", async () => {
  const dir = path.join(os.tmpdir(), `scan-sim-prune-junk-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const junk = { imageHash: "junk1", vector: [1, 0], payload: { query: null, visionTier: "hard_fail_no_seed", _payloadVersion: "v3" }, ts: Date.now() };
  const good = { imageHash: "good1", vector: [0, 1], payload: { query: "ANA Airbus A380 diecast model", identity: { category: "diecast model" }, _payloadVersion: "v3" }, ts: Date.now() };
  fs.writeFileSync(path.join(dir, "junk1.json"), JSON.stringify(junk));
  fs.writeFileSync(path.join(dir, "good1.json"), JSON.stringify(good));

  const origDir = process.env.SCAN_SIMILARITY_STORAGE_DIR;
  process.env.SCAN_SIMILARITY_STORAGE_DIR = dir;
  const mod = await import(`./scanSimilarity.js?prune-junk-${Date.now()}`);
  const result = await mod.loadFromDisk(500);
  process.env.SCAN_SIMILARITY_STORAGE_DIR = origDir;

  assert.equal(result.junkPruned, 1);
  assert.equal(result.loaded, 1);
  assert.equal(result.pruned, 1);
  // loadFromDisk unlinks are fire-and-forget — allow them to settle under load
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(path.join(dir, "junk1.json")), false, "junk file should be unlinked");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadFromDisk returns capDropped when entries exceed max", async () => {
  const dir = path.join(os.tmpdir(), `scan-sim-cap-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) {
    const entry = { imageHash: `cap${i}`, vector: [i, 1], payload: { query: `Hawaiian Airlines Boeing 787 model ${i}`, _payloadVersion: "v3" }, ts: Date.now() - i * 1000 };
    fs.writeFileSync(path.join(dir, `cap${i}.json`), JSON.stringify(entry));
  }

  const origDir = process.env.SCAN_SIMILARITY_STORAGE_DIR;
  process.env.SCAN_SIMILARITY_STORAGE_DIR = dir;
  const mod = await import(`./scanSimilarity.js?cap-${Date.now()}`);
  const result = await mod.loadFromDisk(3);
  process.env.SCAN_SIMILARITY_STORAGE_DIR = origDir;

  assert.equal(result.loaded, 3);
  assert.equal(result.capDropped, 2);
  assert.equal(result.ttlExpired, 0);
  assert.equal(result.junkPruned, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
