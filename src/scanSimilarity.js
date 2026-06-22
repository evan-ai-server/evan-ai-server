// src/scanSimilarity.js
// In-memory perceptual-similarity index for scan early-return.
//
// The vision call is the largest single latency cost in a cold scan (5–12s).
// The existing exact-byte cache (sha256 of the JPEG) only hits when the user
// uploads the identical file twice. Most repeat scans of the same item
// produce different bytes (camera shutter, angle, lighting) and miss that
// cache, paying full vision cost again.
//
// This module indexes recent successful scans by their CLIP embedding and
// returns a hit when a new scan's embedding is cosine-similar above
// SIMILARITY_THRESHOLD. Per-instance, in-memory, bounded — survives within
// a process but not across restarts. Good enough for hot-path replay and
// burst-scan use cases; longer-term storage lives in the existing on-disk
// scan_embedding store.

import fs from "fs/promises";
import path from "path";
import { cosineSimilarity } from "../intelligence/vision/embeddingSearch.js";
import { isGarbageQuery } from "./queryGuards.js";

const MAX_ENTRIES          = Number(process.env.SCAN_SIMILARITY_MAX_ENTRIES || 500);
const SIMILARITY_THRESHOLD = Number(process.env.SCAN_SIMILARITY_THRESHOLD || 0.92);
const ENTRY_TTL_MS         = Number(process.env.SCAN_SIMILARITY_TTL_MS || 24 * 60 * 60 * 1000);
const STORAGE_DIR          = path.resolve(process.env.SCAN_SIMILARITY_STORAGE_DIR || "storage/scan-similarity");
// Bump when the payload shape (vision query/identity/variants) changes
// incompatibly. Old persisted entries are skipped at load + lookup time
// instead of being replayed and re-injecting stale vision queries (which
// is how fabricated tokens like "round" survived prior fixes).
const PAYLOAD_VERSION      = String(process.env.SCAN_SIMILARITY_PAYLOAD_VERSION || "v3");

const _index = new Map(); // imageHash → { vector, payload, ts }

let _stats = { hits: 0, misses: 0, registrations: 0, removals: 0, loaded: 0, registerSkipped: 0 };

const JUNK_TIERS = new Set(["hard_fail_no_seed", "rejected_generic", "low_quality"]);

export function getSimilarityPayloadJunkReason(payload) {
  const query = String(payload?.query ?? "").trim();
  if (!query) return "missing_query";
  if (isGarbageQuery(query)) return "garbage_query";
  const tier = String(payload?.visionTier || payload?.cacheSource || payload?.source || "").toLowerCase();
  if (JUNK_TIERS.has(tier)) return "low_quality_tier";
  return null;
}

let _dirReady = null;
async function _ensureDir() {
  if (!_dirReady) _dirReady = fs.mkdir(STORAGE_DIR, { recursive: true }).catch(() => {});
  return _dirReady;
}

function _entryPath(imageHash) {
  return path.join(STORAGE_DIR, `${imageHash}.json`);
}

async function _persistEntry(imageHash, vector, payload, ts) {
  try {
    await _ensureDir();
    await fs.writeFile(
      _entryPath(imageHash),
      JSON.stringify({ imageHash, vector, payload, ts }),
      "utf8"
    );
  } catch { /* persistence is best-effort */ }
}

function _evictOldest(over = 0) {
  if (over <= 0) return;
  const sorted = [..._index.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < over; i++) _index.delete(sorted[i][0]);
}

function _isExpired(entry) {
  return entry.ts + ENTRY_TTL_MS < Date.now();
}

/**
 * Register a successful scan's embedding alongside the payload to return on a
 * future similarity hit. payload should be the trimmed identity-bearing fields
 * the caller wants to reuse (query, variants, confidence, identity, etc.).
 * Also persists to disk fire-and-forget so the cache survives restarts.
 */
export function register(imageHash, vector, payload) {
  if (!imageHash || !Array.isArray(vector) || !vector.length || !payload) return;
  const junkReason = getSimilarityPayloadJunkReason(payload);
  if (junkReason) {
    _stats.registerSkipped++;
    console.log("VISION_SIMILARITY_REGISTER_SKIPPED", {
      imageHashPrefix: String(imageHash).slice(0, 8),
      reason: junkReason,
      query: payload?.query ?? null,
      visionTier: payload?.visionTier || payload?.cacheSource || payload?.source || null,
    });
    return;
  }
  const ts = Date.now();
  const stampedPayload = { ...payload, _payloadVersion: PAYLOAD_VERSION };
  _index.set(imageHash, { vector, payload: stampedPayload, ts, version: PAYLOAD_VERSION });
  _stats.registrations++;
  _persistEntry(imageHash, vector, stampedPayload, ts).catch(() => {});
  if (_index.size > MAX_ENTRIES) _evictOldest(_index.size - MAX_ENTRIES);
}

/**
 * Load most-recent persisted entries into memory at boot. Skips expired
 * entries (older than ENTRY_TTL_MS) and caps at maxEntries to avoid
 * exhausting memory after long-running deployments.
 */
export async function loadFromDisk(maxEntries = MAX_ENTRIES) {
  try {
    await _ensureDir();
    const files = await fs.readdir(STORAGE_DIR).catch(() => []);
    const candidates = [];
    const now = Date.now();
    let ttlExpired = 0;
    let junkPruned = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(STORAGE_DIR, file), "utf8");
        const data = JSON.parse(raw);
        if (!data?.imageHash || !Array.isArray(data?.vector) || !data?.payload) continue;
        if ((data.ts || 0) + ENTRY_TTL_MS < now) {
          ttlExpired++;
          fs.unlink(path.join(STORAGE_DIR, file)).catch(() => {});
          continue;
        }
        const junkReason = getSimilarityPayloadJunkReason(data.payload);
        if (junkReason) {
          junkPruned++;
          fs.unlink(path.join(STORAGE_DIR, file)).catch(() => {});
          continue;
        }
        candidates.push(data);
      } catch { /* skip corrupt entries */ }
    }
    const versionMatches = candidates.filter((c) => c?.payload?._payloadVersion === PAYLOAD_VERSION);
    const versionSkipped = candidates.length - versionMatches.length;
    versionMatches.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const slice = versionMatches.slice(0, maxEntries);
    for (const entry of slice) {
      _index.set(entry.imageHash, {
        vector:  entry.vector,
        payload: entry.payload,
        ts:      entry.ts,
        version: PAYLOAD_VERSION,
      });
    }
    _stats.loaded = slice.length;
    const pruned = ttlExpired + junkPruned;
    if (pruned > 0) {
      console.log("VISION_SIMILARITY_DISK_PRUNED", {
        ttlExpired, junkPruned, pruned, scanned: files.length,
      });
    }
    return {
      loaded: slice.length,
      scanned: files.length,
      ttlExpired,
      junkPruned,
      pruned,
      versionSkipped,
      capDropped: versionMatches.length - slice.length,
    };
  } catch (e) {
    return { loaded: 0, scanned: 0, error: e?.message || String(e) };
  }
}

/**
 * Look up the most-similar registered scan. Returns null on miss or when the
 * best match is below threshold.
 */
export function findSimilar(vector, threshold = SIMILARITY_THRESHOLD) {
  if (!Array.isArray(vector) || !vector.length) return null;

  let best = null;
  for (const [hash, entry] of _index) {
    if (_isExpired(entry)) {
      _index.delete(hash);
      continue;
    }
    // Belt-and-suspenders against stale entries that snuck past loadFromDisk.
    if (entry?.payload?._payloadVersion !== PAYLOAD_VERSION) {
      _index.delete(hash);
      continue;
    }
    const sim = cosineSimilarity(vector, entry.vector);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { imageHash: hash, similarity: sim, payload: entry.payload };
    }
  }

  if (best) _stats.hits++;
  else      _stats.misses++;

  return best;
}

/**
 * Remove a single entry by imageHash from BOTH memory and disk. Used by the V3.2
 * self-heal: when an OpenAI background verify contradicts the cached seed an entry
 * produced, that entry is forgotten so it stops serving a wrong provisional seed —
 * and the disk delete makes the removal durable across restarts (otherwise
 * loadFromDisk would replay it at boot). Disk unlink is best-effort/fire-and-forget.
 * Returns true if the entry was present in memory.
 */
export function remove(imageHash) {
  if (!imageHash) return false;
  const existed = _index.delete(imageHash);
  _stats.removals = (_stats.removals || 0) + 1;
  fs.unlink(_entryPath(imageHash)).catch(() => {});
  return existed;
}

export function getStats() {
  const total = _stats.hits + _stats.misses;
  return {
    ..._stats,
    size:           _index.size,
    maxEntries:     MAX_ENTRIES,
    threshold:      SIMILARITY_THRESHOLD,
    ttlMs:          ENTRY_TTL_MS,
    hitRate:        total > 0 ? _stats.hits / total : null,
  };
}

export function clear() {
  _index.clear();
  _stats = { hits: 0, misses: 0, registrations: 0, removals: 0, registerSkipped: 0 };
}

// Phase V3.10B: iterate all valid (non-expired, version-matched) entries.
// Yields { imageHash, payload } for each. Used by aircraft family recovery
// to find prior complete identities without needing a vector.
export function* entries() {
  for (const [hash, entry] of _index) {
    if (_isExpired(entry)) continue;
    if (entry?.payload?._payloadVersion !== PAYLOAD_VERSION) continue;
    yield { imageHash: hash, payload: entry.payload };
  }
}
