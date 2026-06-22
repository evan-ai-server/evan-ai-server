// src/perceptualHash.js
// Difference hash (dHash) for fast near-duplicate image detection.
// No CLIP/ONNX — uses sharp to resize to a tiny greyscale grid, then
// compares adjacent pixel intensities to produce a stable 64-bit hash.
// Deterministic: same image bytes → same hash. Similar images (re-encode,
// slight crop/angle) → small Hamming distance.

let _getSharp = null;

export function _injectSharp(fn) { _getSharp = fn; }

async function sharp() {
  if (_getSharp) return _getSharp();
  const mod = await import("sharp");
  return mod.default || mod;
}

/**
 * Compute a 64-bit dHash from a JPEG/PNG buffer.
 * Resizes to 9×8 greyscale, compares each pixel to its right neighbour.
 * Returns a 16-char hex string (64 bits).
 */
export async function computeDHash(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return null;
  try {
    const s = await sharp();
    const raw = await s(buffer, { failOn: "none" })
      .rotate()
      .greyscale()
      .resize({ width: 9, height: 8, fit: "fill" })
      .raw()
      .toBuffer();
    if (!Buffer.isBuffer(raw) || raw.length < 72) return null;
    let hash = 0n;
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const left  = raw[row * 9 + col];
        const right = raw[row * 9 + col + 1];
        if (left > right) {
          hash |= 1n << BigInt(row * 8 + col);
        }
      }
    }
    return hash.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

/**
 * Hamming distance between two 16-char hex dHash strings.
 * Returns the number of differing bits (0–64), or null on bad input.
 */
export function hammingDistance(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return null;
  if (a.length !== 16 || b.length !== 16) return null;
  let va, vb;
  try { va = BigInt("0x" + a); vb = BigInt("0x" + b); }
  catch { return null; }
  let xor = va ^ vb;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}
