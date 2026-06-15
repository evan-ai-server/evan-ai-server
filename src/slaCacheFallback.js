// Phase V3.5 — pure decision helpers for the market SLA-exhausted cache fallback.
//
// Background: when vision is slow (cold prompt cache, slow first scan after a
// restart), /market/search/stream can start with <=800ms of SLA budget left. The
// V3.3 guard correctly refused to spend any paid SerpAPI/eBay/Etsy call in that
// window — but it returned an EMPTY pool and only checked the in-memory cross-route
// cache (MARKET_SCAN_RESULT_CACHE), which is wiped on restart and keyed on a NEW
// scanId. It never consulted the PERSISTENT internal market snapshot (redis/disk),
// even when a clean, version-matching pool for the exact query existed there.
//
// V3.5 expands the exhausted-budget fallback to also serve that persistent snapshot
// (zero paid calls) before giving up. These helpers are the pure decision core so it
// can be unit-tested without the stream handler's I/O.

export const SLA_EXHAUSTED_THRESHOLD_MS = 800;

/** True when the remaining scan-SLA budget is at/under the exhausted threshold. */
export function isSlaExhausted(remainingMs, thresholdMs = SLA_EXHAUSTED_THRESHOLD_MS) {
  return (
    remainingMs !== null &&
    typeof remainingMs === "number" &&
    Number.isFinite(remainingMs) &&
    remainingMs <= thresholdMs
  );
}

/**
 * Classify which cross-route budget key matched, so the right HIT log fires.
 *   scan:… / img:…  → a full payload cached for THIS scan ("payload")
 *   q:…             → a query+user payload ("query")
 * Returns null for an unrecognized / missing key.
 */
export function classifyBudgetCacheKey(hitKey) {
  const k = String(hitKey || "");
  if (k.startsWith("scan:") || k.startsWith("img:")) return "payload";
  if (k.startsWith("q:")) return "query";
  return null;
}

/**
 * Decide the zero-cost source to serve when the SLA is exhausted. Pure: the caller
 * does the I/O (budget-cache lookup, snapshot read, clean-pool count) and passes the
 * results in. Order of preference: in-memory payload/query cache → persistent internal
 * snapshot (only if its clean pool meets the min target) → miss (serve empty).
 *
 * @returns {{ source: "payload_cache"|"query_cache"|"internal_snapshot"|"miss", log: string }}
 */
export function selectSlaFallbackSource({
  inMemoryHit = false,
  inMemoryHitKey = null,
  snapshotCleanCount = 0,
  minCleanTarget = 8,
} = {}) {
  if (inMemoryHit) {
    const kind = classifyBudgetCacheKey(inMemoryHitKey);
    return kind === "query"
      ? { source: "query_cache", log: "MARKET_SLA_EXHAUSTED_QUERY_CACHE_HIT" }
      : { source: "payload_cache", log: "MARKET_SLA_EXHAUSTED_PAYLOAD_CACHE_HIT" };
  }
  if (minCleanTarget > 0 && snapshotCleanCount >= minCleanTarget) {
    return { source: "internal_snapshot", log: "MARKET_SLA_EXHAUSTED_INTERNAL_SNAPSHOT_HIT" };
  }
  return { source: "miss", log: "MARKET_SLA_EXHAUSTED_CACHE_FALLBACK_MISS" };
}
