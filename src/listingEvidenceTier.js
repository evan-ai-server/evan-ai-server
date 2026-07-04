// src/listingEvidenceTier.js
// Phase 2B.1 — pure per-listing evidence tier derivation.
// Phase 2B.3 — strict "verified" semantics: only a true API-backed
// marketplace record can reach verified_listing. A well-shaped direct/
// merchant URL alone (SerpAPI or otherwise) is no longer enough.
//
// deriveListingEvidenceTier(item) → { evidenceTier, evidenceBadge, verified, pricingSignalOnly }
//
// Tiers (most to least trusted):
//   verified_listing    — API-backed marketplace record: allowlisted provider
//                         (today: eBay Browse) + itemId/legacyItemId proof +
//                         canonicalUrl/directUrl + clickable + finite price.
//   marketplace_direct  — clickable direct URL to a known peer marketplace
//                         item page (eBay/Etsy) without API-backed proof
//                         (e.g. a SerpAPI result that happens to resolve to
//                         an eBay/Etsy item page).
//   merchant_direct      — clickable direct URL to any other real
//                         merchant/product page.
//   model_estimate        — oracle/model price estimate; never a real listing.
//   pricing_signal_only   — price/title only; no trustworthy clickable
//                         direct URL (Google wrapper, missing URL, legacy).
//
// Reads item.provider/itemId/legacyItemId/canonicalUrl/directUrl/clickable/
// urlQuality/price/totalPrice. Never mutates the item and never touches URL
// fields themselves — sanitizeOutboundListingForClient (index.js) is the only
// place directUrl/clickable/urlQuality get decided.

// Providers whose direct-listing items carry real API-backed item-record
// proof (itemId/legacyItemId stamped by a dedicated mapper — see
// src/ebayBrowseMapper.js — not guessed from a URL shape). Etsy/Walmart/Best
// Buy searches currently reuse the generic normalizeItem() URL path with no
// equivalent per-item proof fields, so they are intentionally NOT allowlisted
// here yet. Add a provider only once a mapper analogous to ebayBrowseMapper.js
// stamps real item-record fields for it.
const VERIFIED_API_PROVIDERS = new Set(["ebay_browse"]);

// Known peer marketplaces (many independent sellers list items). A direct URL
// to one of these without API-backed proof is more trustworthy than an
// arbitrary merchant page, but still not a verified item record.
const KNOWN_PEER_MARKETPLACE_HOSTS = [/(^|\.)ebay\./i, /(^|\.)etsy\./i];

function _hostnameOf(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function _isKnownPeerMarketplaceHost(host) {
  return !!host && KNOWN_PEER_MARKETPLACE_HOSTS.some((re) => re.test(host));
}

export function deriveListingEvidenceTier(item = {}) {
  const it = item && typeof item === "object" ? item : {};

  // E. model_estimate — oracle/model price estimate, never a real listing.
  if (it.urlQuality === "oracle_pricing_estimate") {
    return { evidenceTier: "model_estimate", evidenceBadge: "AI estimate", verified: false, pricingSignalOnly: false };
  }

  const clickable = it.clickable !== false;
  const directUrl = it.directUrl || null;
  const hasClickableDirectUrl = clickable && !!directUrl;

  if (hasClickableDirectUrl) {
    const priceCandidate = it.totalPrice ?? it.price;
    // priceCandidate == null also catches undefined; guards against
    // Number(null) === 0 (finite) miscounting a genuinely missing price
    // (normalizeItem sets totalPrice/price to null, not undefined, when absent).
    const hasFinitePrice = priceCandidate != null && Number.isFinite(Number(priceCandidate));
    const provider = String(it.provider || "").toLowerCase().trim();
    const hasApiProof =
      VERIFIED_API_PROVIDERS.has(provider) &&
      !!(it.itemId || it.legacyItemId) &&
      !!(it.canonicalUrl || directUrl) &&
      hasFinitePrice;

    // A. verified_listing — true API-backed marketplace record only.
    if (hasApiProof) {
      return { evidenceTier: "verified_listing", evidenceBadge: "Verified", verified: true, pricingSignalOnly: false };
    }

    // B. marketplace_direct — known peer marketplace item page, no API proof.
    if (_isKnownPeerMarketplaceHost(_hostnameOf(directUrl))) {
      return { evidenceTier: "marketplace_direct", evidenceBadge: "Marketplace listing", verified: false, pricingSignalOnly: false };
    }

    // C. merchant_direct — any other real clickable merchant/product page.
    return { evidenceTier: "merchant_direct", evidenceBadge: "Store price", verified: false, pricingSignalOnly: false };
  }

  // D. pricing_signal_only — price/title only, no trustworthy clickable URL.
  return { evidenceTier: "pricing_signal_only", evidenceBadge: "Price signal", verified: false, pricingSignalOnly: true };
}
