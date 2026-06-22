// src/perceptualHashIndex.js
// In-memory near-duplicate index keyed by dHash.
// Cheap candidate retrieval — NOT identity truth. Every hit must pass
// safety gates (identity locks, category checks) before being served.

import { hammingDistance } from "./perceptualHash.js";
import { getSimilarityPayloadJunkReason } from "./scanSimilarity.js";

const MAX_ENTRIES = Number(process.env.VISION_PHASH_MAX_ENTRIES || 500);
const DEFAULT_HAMMING_THRESHOLD = Number(process.env.VISION_PHASH_HAMMING_THRESHOLD || 5);
const ENTRY_TTL_MS = Number(process.env.VISION_PHASH_TTL_MS || 24 * 60 * 60 * 1000);

const _index = new Map(); // imageHash → { pHash, payload, ts }

let _stats = { hits: 0, misses: 0, registrations: 0, skipped: 0 };

function _isExpired(entry) {
  return entry.ts + ENTRY_TTL_MS < Date.now();
}

function _evictOldest(over = 0) {
  if (over <= 0) return;
  const sorted = [..._index.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < over; i++) _index.delete(sorted[i][0]);
}

/**
 * Register a successful scan's dHash + payload.
 * Rejects junk payloads using the same guard as scanSimilarity.
 * Returns { registered, reason }.
 */
export function registerPHash({ imageHash, pHash, payload }) {
  if (!imageHash || !pHash || !payload) {
    _stats.skipped++;
    return { registered: false, reason: "missing_fields" };
  }
  const junkReason = getSimilarityPayloadJunkReason(payload);
  if (junkReason) {
    _stats.skipped++;
    return { registered: false, reason: junkReason };
  }
  const ts = Date.now();
  _index.set(imageHash, { pHash, payload, ts });
  _stats.registrations++;
  if (_index.size > MAX_ENTRIES) _evictOldest(_index.size - MAX_ENTRIES);
  return { registered: true, reason: "ok" };
}

/**
 * Find the best near-duplicate by Hamming distance.
 * Returns null on miss or { imageHash, payload, hamming, pHash } on hit.
 */
export function findNearPHash(queryHash, threshold = DEFAULT_HAMMING_THRESHOLD) {
  if (typeof queryHash !== "string" || queryHash.length !== 16) return null;
  let best = null;
  for (const [hash, entry] of _index) {
    if (_isExpired(entry)) {
      _index.delete(hash);
      continue;
    }
    const dist = hammingDistance(queryHash, entry.pHash);
    if (dist === null) continue;
    if (dist <= threshold && (best === null || dist < best.hamming)) {
      best = { imageHash: hash, payload: entry.payload, hamming: dist, pHash: entry.pHash };
    }
  }
  if (best) _stats.hits++;
  else _stats.misses++;
  return best;
}

/**
 * Remove an entry by imageHash (self-heal on contradiction).
 */
export function removePHash(imageHash) {
  return _index.delete(imageHash);
}

export function clearPHashIndex() {
  _index.clear();
  _stats = { hits: 0, misses: 0, registrations: 0, skipped: 0 };
}

export function getPHashStats() {
  return {
    ..._stats,
    size: _index.size,
    maxEntries: MAX_ENTRIES,
    threshold: DEFAULT_HAMMING_THRESHOLD,
    ttlMs: ENTRY_TTL_MS,
  };
}
