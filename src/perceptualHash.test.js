import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { computeDHash, hammingDistance, _injectSharp } from "./perceptualHash.js";

// Stub sharp: produce deterministic 9×8 greyscale raw from a Buffer whose
// first byte seeds the gradient. This avoids a real sharp dependency in tests.
function makeStubSharp(offset = 0) {
  return async () => {
    return (buf, _opts) => {
      const seed = (buf[0] || 0) + offset;
      return {
        rotate() { return this; },
        greyscale() { return this; },
        resize() { return this; },
        raw() { return this; },
        async toBuffer() {
          const raw = Buffer.alloc(72);
          for (let i = 0; i < 72; i++) raw[i] = (seed + i * 3) % 256;
          return raw;
        },
      };
    };
  };
}

describe("perceptualHash", () => {
  describe("hammingDistance", () => {
    it("returns 0 for identical hashes", () => {
      assert.equal(hammingDistance("0000000000000000", "0000000000000000"), 0);
      assert.equal(hammingDistance("ffffffffffffffff", "ffffffffffffffff"), 0);
      assert.equal(hammingDistance("abcdef0123456789", "abcdef0123456789"), 0);
    });

    it("returns correct distance for 1-bit difference", () => {
      assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
    });

    it("returns correct distance for known values", () => {
      // 0x0f = 00001111, 0x00 = 00000000 → 4 bits differ
      assert.equal(hammingDistance("000000000000000f", "0000000000000000"), 4);
    });

    it("returns 64 for completely opposite hashes", () => {
      assert.equal(hammingDistance("0000000000000000", "ffffffffffffffff"), 64);
    });

    it("returns null for bad input", () => {
      assert.equal(hammingDistance(null, "0000000000000000"), null);
      assert.equal(hammingDistance("short", "0000000000000000"), null);
      assert.equal(hammingDistance("0000000000000000", "zzzzzzzzzzzzzzzz"), null);
    });
  });

  describe("computeDHash with stub sharp", () => {
    before(() => {
      _injectSharp(makeStubSharp(0));
    });

    it("returns a 16-char hex string for a valid buffer", async () => {
      const hash = await computeDHash(Buffer.alloc(1000, 42));
      assert.ok(hash);
      assert.equal(hash.length, 16);
      assert.ok(/^[0-9a-f]{16}$/.test(hash));
    });

    it("returns same hash for same buffer", async () => {
      const buf = Buffer.alloc(1000, 77);
      const h1 = await computeDHash(buf);
      const h2 = await computeDHash(buf);
      assert.equal(h1, h2);
    });

    it("returns different hash for different buffer seed", async () => {
      const h1 = await computeDHash(Buffer.alloc(1000, 10));
      const h2 = await computeDHash(Buffer.alloc(1000, 200));
      assert.notEqual(h1, h2);
    });

    it("returns null for tiny buffer", async () => {
      assert.equal(await computeDHash(Buffer.alloc(10)), null);
    });

    it("returns null for non-buffer", async () => {
      assert.equal(await computeDHash(null), null);
      assert.equal(await computeDHash("not a buffer"), null);
    });
  });

  describe("similar buffers have small hamming distance", () => {
    it("identical seed → distance 0", async () => {
      _injectSharp(makeStubSharp(0));
      const buf = Buffer.alloc(1000, 42);
      const h1 = await computeDHash(buf);
      const h2 = await computeDHash(buf);
      assert.equal(hammingDistance(h1, h2), 0);
    });
  });
});
