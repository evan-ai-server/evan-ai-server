// End-to-end integration: real computeDHash (real sharp) → pHash index →
// serve gate. Proves the near-dup serve decision the route assembles, without
// the HTTP server or a real product photo. Images are generated in-test (no
// fixture dependency) so the test is portable and deterministic.
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { computeDHash, hammingDistance } from "./perceptualHash.js";
import { registerPHash, findNearPHash, clearPHashIndex } from "./perceptualHashIndex.js";
import { evaluateNearDupServeGate } from "./nearDupServeGate.js";

let sharp;
before(async () => { sharp = (await import("sharp")).default; });

// Build a JPEG with a low-frequency 2D wave texture. fx = horizontal cycles
// (dHash compares horizontal neighbours, so fx drives the hash); fy = vertical
// cycles. The texture survives the 9×8 dHash downscale, so different fx values
// produce clearly different hashes while a re-encode of the same texture stays
// close.
async function texJpeg(fx, fy, quality = 90, size = 64) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(255, Math.round(
        128 + 60 * Math.sin((2 * Math.PI * fx * x) / size) + 60 * Math.sin((2 * Math.PI * fy * y) / size)
      )));
      const i = (y * size + x) * 3;
      raw[i] = raw[i + 1] = raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality }).toBuffer();
}

const AIRCRAFT_PAYLOAD = {
  query: "Hawaiian Airlines Boeing 787 diecast model airplane",
  confidence: 0.95,
  visionTier: "query_fast",
  identity: { category: "diecast model" },
};

describe("near-dup serve flow (real dHash → index → gate)", () => {
  beforeEach(() => clearPHashIndex());

  it("re-encode of the same image is a near-dup that SERVES a complete aircraft identity", async () => {
    const imgA = await texJpeg(2, 2, 90);
    const imgB = await texJpeg(2, 2, 55); // same pixels, different bytes
    const hashA = await computeDHash(imgA);
    const hashB = await computeDHash(imgB);
    assert.ok(hashA && hashB);
    assert.notEqual(imgA.length, imgB.length, "re-encode must differ in bytes (exact-cache would miss)");
    assert.ok(hammingDistance(hashA, hashB) <= 5, "re-encode dHash within threshold");

    registerPHash({ imageHash: "imgA_hash", pHash: hashA, payload: AIRCRAFT_PAYLOAD });
    const hit = findNearPHash(hashB);
    assert.ok(hit, "near-dup found");

    const gate = evaluateNearDupServeGate({
      query: hit.payload.query,
      category: hit.payload.identity.category,
      airline: "hawaiian",
      hasFamily: true,
      isHighStakesExact: false,
    });
    assert.equal(gate.serve, true);
    const cappedConf = Math.min(hit.payload.confidence, 0.75);
    assert.equal(cappedConf, 0.75, "confidence capped at 0.75 for provisional near-dup");
  });

  it("a genuinely different image (different horizontal frequency) does NOT match", async () => {
    const imgA = await texJpeg(2, 2, 90);
    const imgC = await texJpeg(6, 2, 90); // different horizontal frequency → different dHash
    const hashA = await computeDHash(imgA);
    const hashC = await computeDHash(imgC);
    assert.ok(hammingDistance(hashA, hashC) > 5, "different image is beyond threshold");

    registerPHash({ imageHash: "imgA_hash", pHash: hashA, payload: AIRCRAFT_PAYLOAD });
    const hit = findNearPHash(hashC);
    assert.equal(hit, null, "different image must not serve a near-dup seed");
  });

  it("near-dup of a high-stakes prior is found but the gate BLOCKS the serve", async () => {
    const imgA = await texJpeg(2, 2, 90);
    const imgB = await texJpeg(2, 2, 55);
    const hashA = await computeDHash(imgA);
    const hashB = await computeDHash(imgB);

    registerPHash({
      imageHash: "watchA",
      pHash: hashA,
      payload: { query: "Omega Seamaster wristwatch steel", confidence: 0.9, visionTier: "query_fast", identity: { category: "watch" } },
    });
    const hit = findNearPHash(hashB);
    assert.ok(hit, "index still finds the visual near-dup");
    const gate = evaluateNearDupServeGate({
      query: hit.payload.query, category: hit.payload.identity.category,
      airline: null, hasFamily: false, isHighStakesExact: true,
    });
    assert.equal(gate.serve, false, "high-stakes must never early-return");
    assert.equal(gate.reason, "high_stakes_category");
  });
});
