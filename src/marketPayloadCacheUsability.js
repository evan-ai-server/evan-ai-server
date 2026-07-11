// Phase C0.1 — shared usability test for the cross-route market payload
// cache (MARKET_SCAN_RESULT_CACHE in index.js; read via getMarketScanResult,
// written via setMarketScanResult).
//
// Incident (2026-07-10 14:22:51-14:23:16 UTC): the stream route's L1
// "internal" cache-first branch built a payload whose items were penalized
// to 0 usable (aircraft identity lock, strongFamilyCount 0) and still wrote
// that 0-item FULL payload into the cross-route cache. Six seconds later the
// legacy fallback (POST /market/search) read that cached entry, treated it
// as a successful terminal hit (PAYLOAD_CACHE_HIT / CACHE_PAYLOAD_RETURNED_
// DIRECT), and served the cached emptiness with serpCallsUsed: 0 instead of
// attempting a fresh provider call — defeating the entire purpose of the
// fallback route.
//
// These pure helpers give the write path (never persist a 0-item full
// payload as a reusable success) and the read path (never replay a legacy
// 0-item entry as a hit) one shared definition of "usable". Pure and
// dependency-free so they can be unit tested without booting index.js
// (index.js binds a network port at import time, so it cannot be required
// from a test file).

/**
 * Count real items on a market response payload — the same `items` array
 * every route (/market/search, /market/search/stream) serves to the client.
 * Deliberately does NOT trust metadata flags like fullPayload/status/ok;
 * those describe how the payload was built, not whether it has content.
 */
export function usableItemCount(payload) {
  if (!payload || typeof payload !== "object") return 0;
  return Array.isArray(payload.items) ? payload.items.length : 0;
}

/** True when a market response payload carries at least one usable item. */
export function hasUsablePayload(payload) {
  return usableItemCount(payload) > 0;
}

/**
 * True when a MARKET_SCAN_RESULT_CACHE entry ({ payload, ts, route, ... })
 * should be treated as a valid, replayable cache hit. Entries with zero
 * items — whether a live poisoned write or a legacy pre-fix write already
 * sitting in memory — must read back as a miss so the caller's fresh-
 * provider path stays eligible.
 */
export function isUsablePayloadCacheEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  return hasUsablePayload(entry.payload);
}
