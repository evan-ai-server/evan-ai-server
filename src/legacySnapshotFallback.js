// src/legacySnapshotFallback.js
// Phase V3.10B — pure decision helpers for serving old-version internal market
// snapshots as a pricing-only fallback when live sources are unavailable.
//
// Normal reads reject snapshots whose _snapshotVersion != current (e.g. v6
// after the v7 bump). This is correct for fresh requests: the old shape is
// missing URL recovery fields. But when SerpAPI is 429/cooling AND eBay is
// unavailable, the version-mismatch rejection means the app returns blank
// even though a perfectly usable pricing pool exists on disk.
//
// These helpers model the fallback decision. The caller (readInternalMarketSnapshot)
// does the I/O; these functions are pure and dependency-free for testing.

/**
 * Should we attempt to read a legacy (version-mismatched) snapshot?
 *
 * Only when ALL of:
 *   1. Primary sources are unavailable (serpCooling + no eBay)
 *   2. The current-version read produced nothing (currentVersionHit is false)
 *   3. An old-version snapshot exists on disk/redis (hasOldSnapshot is true)
 *
 * @returns {{ attempt: boolean, reason: string }}
 */
export function shouldAttemptLegacySnapshot({
  serpCooling = false,
  ebayAvail = false,
  currentVersionHit = false,
  hasOldSnapshot = false,
  slaExhausted = false,
} = {}) {
  if (currentVersionHit) return { attempt: false, reason: "current_version_available" };
  if (!hasOldSnapshot) return { attempt: false, reason: "no_old_snapshot" };
  if (slaExhausted) return { attempt: true, reason: "sla_exhausted_legacy_fallback" };
  const primaryUnavail = serpCooling && !ebayAvail;
  if (!primaryUnavail) return { attempt: false, reason: "primary_source_available" };
  return { attempt: true, reason: "source_unavailable_legacy_fallback" };
}

/**
 * Classify a legacy snapshot's items for safe serving. Returns only the items
 * that pass identity filters, with all trust/verification fields stripped to
 * pricing-only. Items are never marked verified, clickable, or directUrl.
 *
 * @param {Array} items - raw items from the old snapshot
 * @returns {Array} sanitized pricing-only items
 */
export function sanitizeLegacySnapshotItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it?.title && (Number(it?.totalPrice ?? it?.price) > 0))
    .map((it) => ({
      title:      it.title || null,
      source:     it.source || null,
      price:      Number(it.totalPrice ?? it.price) || null,
      totalPrice: Number(it.totalPrice ?? it.price) || null,
      url:        null,
      link:       null,
      buyLink:    null,
      image:      it.image || null,
      rating:     typeof it.rating === "number" ? it.rating : null,
      reviews:    typeof it.reviews === "number" ? it.reviews : null,
      dealScore:      Number(it.dealScore || 0),
      flipScore:      Number(it.flipScore || 0),
      sellerScore:    Number(it.sellerScore || 0),
      trustModelScore: 0,
      __trustScore:    0,
      authRisk:        0,
      visualScore:     0,
      linkVerified:    false,
      sold:            it.sold === true,
      status:          it.status || null,
      // Explicitly strip verification/click fields
      clickable:        false,
      directUrl:        null,
      isVerifiedListing: false,
      _productId:       null,
      _serpapiProductApiUrl: null,
      urlQuality:       null,
      evidenceQuality:  "legacy_snapshot_pricing_only",
    }));
}

/**
 * Minimum clean pool size to serve a legacy snapshot. Intentionally higher
 * than the normal MIN_CLEAN_RESULTS_TARGET — legacy data is stale, so we
 * only serve it when there's a meaningful pool.
 */
export const LEGACY_SNAPSHOT_MIN_CLEAN = 6;
