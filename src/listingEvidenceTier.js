// src/listingEvidenceTier.js
// Phase 2B.1 — pure per-listing evidence tier derivation.
//
// Additive only: mirrors today's evidenceQuality → isVerifiedListing semantics
// exactly (see sanitizeOutboundListingForClient in index.js). Does not change
// what counts as verified — that is Phase 2B.3. This module exists so later
// phases (eBay direct-listing provider, freshness labels, frontend badges)
// have a stable per-item evidenceTier/evidenceBadge shape to build on instead
// of re-deriving trust logic ad hoc in each place that needs it.

/**
 * deriveListingEvidenceTier(item) → { evidenceTier, evidenceBadge, verified, pricingSignalOnly }
 *
 * Reads only item.evidenceQuality (already computed by
 * sanitizeOutboundListingForClient). Never reads/writes URLs, prices, or any
 * other field, and never changes evidenceQuality itself.
 */
export function deriveListingEvidenceTier(item = {}) {
  const evidenceQuality = item?.evidenceQuality || null;

  if (evidenceQuality === "verified_listing") {
    return {
      evidenceTier: "verified_listing",
      evidenceBadge: "Verified",
      verified: true,
      pricingSignalOnly: false,
    };
  }

  if (evidenceQuality === "oracle_estimate") {
    return {
      evidenceTier: "model_estimate",
      evidenceBadge: "AI estimate",
      verified: false,
      pricingSignalOnly: false,
    };
  }

  // "pricing_signal", "legacy_unknown", missing, or anything else — all
  // treated as pricing-signal-only, matching isPricingEvidenceOnly today.
  return {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  };
}
