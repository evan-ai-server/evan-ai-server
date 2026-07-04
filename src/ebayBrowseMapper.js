// src/ebayBrowseMapper.js
// Phase 2B.2 — pure field-capture helper for the eBay Browse provider.
//
// Extracted from searchEbayBrowse (index.js) so the new direct-listing
// evidence fields (itemId, seller, availability, canonicalUrl, ...) are
// unit-testable against a canned eBay Browse ItemSummary without live
// credentials or a network call. Does NOT touch title/price/shipping/link/
// condition/source — those stay exactly as searchEbayBrowse's existing
// normalizeItem(...) call already produces them; this module only adds the
// fields that were previously dropped.

/**
 * canonicalUrl rule: prefer the plain (non-affiliate) itemWebUrl; if that's
 * missing but legacyItemId is present, derive the standard eBay item URL.
 */
function deriveEbayCanonicalUrl(it = {}) {
  if (it?.itemWebUrl) return it.itemWebUrl;
  if (it?.legacyItemId) return `https://www.ebay.com/itm/${it.legacyItemId}`;
  return null;
}

/**
 * extractEbayBrowseEvidenceFields(it, opts) → additive evidence fields only.
 *
 * `it` is a raw eBay Browse API ItemSummary. `now` is injectable for tests;
 * production callers omit it and get the real current time.
 */
export function extractEbayBrowseEvidenceFields(it = {}, { now = Date.now() } = {}) {
  const seller = it?.seller
    ? {
        username: it.seller.username || null,
        feedbackPercentage: Number.isFinite(Number(it.seller.feedbackPercentage))
          ? Number(it.seller.feedbackPercentage)
          : null,
        feedbackScore: Number.isFinite(Number(it.seller.feedbackScore))
          ? Number(it.seller.feedbackScore)
          : null,
      }
    : null;

  const itemLocation = it?.itemLocation
    ? {
        country: it.itemLocation.country || null,
        postalCode: it.itemLocation.postalCode || null,
      }
    : null;

  return {
    provider: "ebay_browse",
    marketplace: "ebay",
    itemId: it?.itemId || null,
    legacyItemId: it?.legacyItemId || null,
    canonicalUrl: deriveEbayCanonicalUrl(it),
    affiliateUrl: it?.itemAffiliateWebUrl || null,
    seller,
    conditionId: it?.conditionId || null,
    availability: it?.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus || null,
    buyingOptions: Array.isArray(it?.buyingOptions) ? it.buyingOptions : null,
    itemLocation,
    fetchedAt: now,
  };
}
