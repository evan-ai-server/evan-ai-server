import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerPHash, findNearPHash, removePHash, clearPHashIndex, getPHashStats } from "./perceptualHashIndex.js";

const GOOD_PAYLOAD = {
  query: "Hawaiian Airlines Boeing 787 diecast model airplane",
  confidence: 0.95,
  visionTier: "query_fast",
  identity: { category: "diecast model", brand: "GeminiJets" },
};

const AIRCRAFT_PAYLOAD = {
  query: "ANA Airbus A380 diecast model airplane",
  confidence: 0.9,
  visionTier: "query_fast",
  identity: { category: "diecast model", brand: "NG Models" },
};

const JUNK_PAYLOAD_NO_QUERY = { query: "", confidence: 0, visionTier: "hard_fail_no_seed" };
const JUNK_PAYLOAD_GENERIC  = { query: "item", confidence: 0.2, visionTier: "rejected_generic" };
const LOW_QUALITY_PAYLOAD   = { query: "thing", confidence: 0.1, visionTier: "low_quality" };

describe("perceptualHashIndex", () => {
  beforeEach(() => clearPHashIndex());

  describe("registerPHash", () => {
    it("registers a good payload", () => {
      const r = registerPHash({ imageHash: "abc123", pHash: "0000000000000001", payload: GOOD_PAYLOAD });
      assert.equal(r.registered, true);
      assert.equal(getPHashStats().registrations, 1);
    });

    it("rejects missing fields", () => {
      assert.equal(registerPHash({ imageHash: null, pHash: "0000000000000001", payload: GOOD_PAYLOAD }).registered, false);
      assert.equal(registerPHash({ imageHash: "a", pHash: null, payload: GOOD_PAYLOAD }).registered, false);
      assert.equal(registerPHash({ imageHash: "a", pHash: "0000000000000001", payload: null }).registered, false);
    });

    it("rejects junk payloads — no query", () => {
      const r = registerPHash({ imageHash: "j1", pHash: "0000000000000001", payload: JUNK_PAYLOAD_NO_QUERY });
      assert.equal(r.registered, false);
      assert.ok(r.reason);
    });

    it("rejects junk payloads — garbage query", () => {
      const r = registerPHash({ imageHash: "j2", pHash: "0000000000000001", payload: JUNK_PAYLOAD_GENERIC });
      assert.equal(r.registered, false);
    });

    it("rejects low_quality tier", () => {
      const r = registerPHash({ imageHash: "j3", pHash: "0000000000000001", payload: LOW_QUALITY_PAYLOAD });
      assert.equal(r.registered, false);
    });

    it("preserves short real identities like ANA A380", () => {
      const r = registerPHash({ imageHash: "ana380", pHash: "0000000000000002", payload: AIRCRAFT_PAYLOAD });
      assert.equal(r.registered, true);
    });
  });

  describe("findNearPHash", () => {
    it("finds exact pHash match (distance 0)", () => {
      registerPHash({ imageHash: "h1", pHash: "abcdef0123456789", payload: GOOD_PAYLOAD });
      const hit = findNearPHash("abcdef0123456789");
      assert.ok(hit);
      assert.equal(hit.hamming, 0);
      assert.equal(hit.payload.query, GOOD_PAYLOAD.query);
    });

    it("finds near match within threshold", () => {
      registerPHash({ imageHash: "h2", pHash: "0000000000000000", payload: GOOD_PAYLOAD });
      // 1-bit difference
      const hit = findNearPHash("0000000000000001", 5);
      assert.ok(hit);
      assert.equal(hit.hamming, 1);
    });

    it("returns null when distance exceeds threshold", () => {
      registerPHash({ imageHash: "h3", pHash: "0000000000000000", payload: GOOD_PAYLOAD });
      // 64-bit difference
      const hit = findNearPHash("ffffffffffffffff", 5);
      assert.equal(hit, null);
    });

    it("returns null on empty index", () => {
      assert.equal(findNearPHash("0000000000000000"), null);
    });

    it("returns closest match when multiple entries exist", () => {
      registerPHash({ imageHash: "close", pHash: "0000000000000001", payload: GOOD_PAYLOAD });
      registerPHash({ imageHash: "far", pHash: "000000000000000f", payload: AIRCRAFT_PAYLOAD });
      const hit = findNearPHash("0000000000000000", 5);
      assert.ok(hit);
      assert.equal(hit.imageHash, "close");
      assert.equal(hit.hamming, 1);
    });

    it("rejects invalid hash input", () => {
      registerPHash({ imageHash: "h4", pHash: "0000000000000000", payload: GOOD_PAYLOAD });
      assert.equal(findNearPHash(null), null);
      assert.equal(findNearPHash("short"), null);
    });
  });

  describe("removePHash", () => {
    it("removes an existing entry", () => {
      registerPHash({ imageHash: "rm1", pHash: "0000000000000000", payload: GOOD_PAYLOAD });
      assert.ok(findNearPHash("0000000000000000"));
      assert.equal(removePHash("rm1"), true);
      assert.equal(findNearPHash("0000000000000000"), null);
    });

    it("returns false for non-existent entry", () => {
      assert.equal(removePHash("nonexistent"), false);
    });
  });

  describe("stats", () => {
    it("tracks hits and misses", () => {
      registerPHash({ imageHash: "s1", pHash: "0000000000000000", payload: GOOD_PAYLOAD });
      findNearPHash("0000000000000000"); // hit
      findNearPHash("ffffffffffffffff"); // miss
      const stats = getPHashStats();
      assert.equal(stats.hits, 1);
      assert.equal(stats.misses, 1);
      assert.equal(stats.registrations, 1);
    });

    it("reports size 0 on cleared/fresh index (5A.4F.4 empty-index guard)", () => {
      assert.equal(getPHashStats().size, 0, "fresh index must be empty");
      registerPHash({ imageHash: "x1", pHash: "0000000000000000", payload: GOOD_PAYLOAD });
      assert.equal(getPHashStats().size, 1, "after register, size must be 1");
      clearPHashIndex();
      assert.equal(getPHashStats().size, 0, "after clear, size must be 0 again");
    });
  });
});
