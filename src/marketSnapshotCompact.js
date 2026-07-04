// src/marketSnapshotCompact.js
// Phase V3.9B — extracted from index.js so compactMarketSnapshotItem is
// directly testable and its field contract is locked by tests.
//
// This module is PURE and dependency-free. It may be imported by index.js
// and by unit tests without booting the server.

function _round2(v) { return Math.round(v * 100) / 100; }
function _finitePrice(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? _round2(v) : null;
}

// The set of urlQuality values produced by resolveListingDirectUrl /
// sanitizeOutboundListingForClient that indicate a URL is already a safe,
// non-Google merchant link. Only these survive the snapshot write as directUrl.
// Never expand this list without confirming the URL class is safe to store.
const TRUSTED_URL_QUALITIES = new Set([
  "merchant_direct",
  "merchant_resolved",
  "google_redirect_unwrapped",
]);

/**
 * compactMarketSnapshotItem(it) → compact snapshot record
 *
 * The write shape for internal market snapshots. Stored in Redis and on disk;
 * re-served on SLA-exhausted / cache-hit paths. Must remain small (24 items
 * per snapshot, O(1) fields per item).
 *
 * V3.9B adds three non-user-facing recovery fields that were previously
 * dropped, causing every re-served item to log
 * RECOVERY_CANDIDATE_MISSING_REASON reason:'no_product_ids':
 *   _productId            — SerpAPI Shopping product_id; key for google_product recovery
 *   _serpapiProductApiUrl — pre-formed google_product API URL from SerpAPI
 *   urlQuality            — URL evidence classification; survives the sanitizer cycle
 *
 * Trust contract (unchanged from V3.9A):
 *   directUrl is only stored when the item was ALREADY trusted (clickable AND
 *   a TRUSTED_URL_QUALITY). Pricing-only items remain directUrl:null.
 *   isVerifiedListing is only true when legitimately set upstream.
 *   A product ID alone never makes an item clickable or verified.
 */
export function compactMarketSnapshotItem(it = {}) {
  const price = _finitePrice(it?.totalPrice ?? it?.price);

  const _isTrustedUrl =
    it?.clickable === true && TRUSTED_URL_QUALITIES.has(it?.urlQuality);
  const _directUrl = _isTrustedUrl ? (it?.directUrl || null) : null;

  return {
    title:      it?.title  || null,
    source:     it?.source || null,
    price,
    totalPrice: price,
    // url/link/buyLink are already null for non-clickable items (normalizeItem
    // sets them to null when clickable:false). Preserved as-is for clickable items.
    url:     it?.url     || it?.buyLink || it?.link    || null,
    link:    it?.link    || it?.url     || it?.buyLink || null,
    buyLink: it?.buyLink || it?.url     || it?.link    || null,
    image:   it?.image   || null,
    rating:  typeof it?.rating  === "number" ? it.rating  : null,
    reviews: typeof it?.reviews === "number" ? it.reviews : null,
    dealScore:   Number(it?.dealScore   || 0),
    flipScore:   Number(it?.flipScore   || 0),
    sellerScore: Number(it?.sellerScore || 0),
    trust: Number(it?.trust ?? it?.trustModelScore ?? it?.__trustScore ?? 0) || 0,
    authRisk:    Number(it?.authRisk    || 0),
    visualScore: Number(
      it?.visualScore ?? it?.__imageScore ?? it?.__visualBoost ?? 0
    ) || 0,
    linkVerified: it?.linkVerified !== false,
    sold:   it?.sold   === true,
    status: it?.status || null,

    // ── V3.9B: URL recovery metadata (non-user-facing) ───────────────────
    // Never included in the client payload (buildMarketSearchResponsePayload
    // strips unknown fields before sending). Only used server-side for the
    // google_product recovery path (_scheduleAsyncUrlRecovery / upgradeToVerifiedListings).
    _productId:            it?._productId            || null,
    _serpapiProductApiUrl: it?._serpapiProductApiUrl || null,
    urlQuality:            it?.urlQuality            || null,
    evidenceQuality:       it?.evidenceQuality       || null,
    clickable:             it?.clickable === true,
    directUrl:             _directUrl,
    isVerifiedListing:     it?.isVerifiedListing === true,

    // ── Phase 2B.4: direct-listing API proof + evidence/freshness fields ──
    // Additive only. Harmless if stale: sanitizeOutboundListingForClient
    // always recomputes evidenceTier/verified/cacheStatus/sourceFreshness/
    // stale fresh at serve time (via deriveListingEvidenceTier +
    // applyListingFreshness) — these are never trusted as-is, only used as
    // the fetchedAt/proof INPUT to that recomputation. Only the small,
    // already-sanitized shape extractEbayBrowseEvidenceFields() produces —
    // never a raw provider payload, auth header, or unbounded object.
    provider:     typeof it?.provider    === "string" ? it.provider    : null,
    marketplace:  typeof it?.marketplace === "string" ? it.marketplace : null,
    itemId:       typeof it?.itemId       === "string" ? it.itemId       : null,
    legacyItemId: typeof it?.legacyItemId === "string" ? it.legacyItemId : null,
    canonicalUrl: typeof it?.canonicalUrl === "string" ? it.canonicalUrl : null,
    affiliateUrl: typeof it?.affiliateUrl === "string" ? it.affiliateUrl : null,
    seller: it?.seller && typeof it.seller === "object"
      ? {
          username:           it.seller.username || null,
          feedbackPercentage: Number.isFinite(Number(it.seller.feedbackPercentage)) ? Number(it.seller.feedbackPercentage) : null,
          feedbackScore:      Number.isFinite(Number(it.seller.feedbackScore))      ? Number(it.seller.feedbackScore)      : null,
        }
      : null,
    conditionId:  (typeof it?.conditionId === "string" || typeof it?.conditionId === "number") ? it.conditionId : null,
    availability: typeof it?.availability === "string" ? it.availability : null,
    buyingOptions: Array.isArray(it?.buyingOptions)
      ? it.buyingOptions.filter((x) => typeof x === "string").slice(0, 6)
      : null,
    itemLocation: it?.itemLocation && typeof it.itemLocation === "object"
      ? { country: it.itemLocation.country || null, postalCode: it.itemLocation.postalCode || null }
      : null,
    fetchedAt: Number.isFinite(Number(it?.fetchedAt)) ? Number(it.fetchedAt) : null,
    evidenceTier:  typeof it?.evidenceTier  === "string" ? it.evidenceTier  : null,
    evidenceBadge: typeof it?.evidenceBadge === "string" ? it.evidenceBadge : null,
    verified:          it?.verified === true,
    pricingSignalOnly: it?.pricingSignalOnly === true,
  };
}
