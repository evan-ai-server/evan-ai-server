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

// ── Phase 2B.4 — cache/freshness honesty layer ──────────────────────────────
//
// applyListingFreshness(tierInfo, ctx) → tierInfo, possibly demoted, + the
// real cacheStatus/sourceFreshness/stale fields (Phase 2B.1 shipped these as
// hardcoded placeholders — this is where they become honest).
//
// Only ever DEMOTES verified_listing → older_price_reference; never upgrades
// a tier and never touches tiers that were never verified in the first
// place. A live item — no per-item fetch timestamp and no cache-serve
// signal at all — is always treated as fresh and is never demoted; staleness
// only exists when there is positive evidence the underlying data is old.
//
// ctx:
//   fetchedAt     — per-item provider fetch time (ms epoch). Only eBay Browse
//                   stamps this today (src/ebayBrowseMapper.js). The most
//                   precise signal available, and path-independent: it ages
//                   correctly whether the item was served live (age ~0) or
//                   round-tripped through the internal market snapshot cache
//                   (age = however long ago it was originally fetched).
//   now           — injectable for tests; defaults to Date.now().
//   cacheKind     — retrievalMeta.kind from the internal market snapshot
//                   system (resolveInternalMarketHit): "fresh_snapshot" |
//                   "stale_snapshot". Used only when fetchedAt is unavailable
//                   (the common case for SerpAPI-sourced items, which carry
//                   no per-item timestamp) to know whether this pool came
//                   from that snapshot cache at all. Other cache layers
//                   (route cache, enriched cache, background refresh) are a
//                   different, out-of-scope system for this phase and are
//                   left exactly as before (fresh/unknown, never demoted).
//   snapshotAgeMs — retrievalMeta.snapshotAgeMs, when the caller has it.

export const LISTING_VERIFIED_FRESH_MS  = 15 * 60 * 1000;      // mirrors INTERNAL_MARKET_SNAPSHOT_FRESH_MS
export const LISTING_VERIFIED_RECENT_MS = 60 * 60 * 1000;
export const LISTING_WEAK_FRESH_MS      = 2 * 60 * 60 * 1000;
export const LISTING_WEAK_STALE_MS      = 6 * 60 * 60 * 1000;  // mirrors INTERNAL_MARKET_SNAPSHOT_STALE_MS

export const SNAPSHOT_CACHE_KINDS = new Set(["fresh_snapshot", "stale_snapshot"]);

export function applyListingFreshness(tierInfo = {}, ctx = {}) {
  const base = {
    evidenceTier:      tierInfo?.evidenceTier || "pricing_signal_only",
    evidenceBadge:     tierInfo?.evidenceBadge || "Price signal",
    verified:          tierInfo?.verified === true,
    pricingSignalOnly: tierInfo?.pricingSignalOnly === true,
  };

  const now           = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const fetchedAt     = Number(ctx.fetchedAt);
  const snapshotAgeMs = Number(ctx.snapshotAgeMs);
  const cacheKind     = ctx.cacheKind || null;

  const hasFetchedAt    = Number.isFinite(fetchedAt) && fetchedAt > 0;
  const servedFromCache = SNAPSHOT_CACHE_KINDS.has(cacheKind);

  const ageMs = hasFetchedAt
    ? Math.max(0, now - fetchedAt)
    : (servedFromCache && Number.isFinite(snapshotAgeMs) && snapshotAgeMs >= 0 ? snapshotAgeMs : null);
  const ageKnown = ageMs !== null;

  const cacheStatus = servedFromCache ? "market_snapshot" : null;

  // No per-item timestamp and no cache-serve signal at all: honest "unknown"
  // without claiming a freshness we can't back up. Never demotes — demotion
  // requires positive evidence of a stale cache serve.
  if (!ageKnown && !servedFromCache) {
    return { ...base, cacheStatus: null, sourceFreshness: "unknown", stale: false };
  }

  // model_estimate has no market-observation timestamp to grade either way —
  // never demoted (it was never verified), never upgraded; only the cache
  // label changes.
  if (base.evidenceTier === "model_estimate") {
    return { ...base, cacheStatus, sourceFreshness: "unknown", stale: servedFromCache };
  }

  if (base.evidenceTier === "verified_listing") {
    if (!ageKnown) {
      // servedFromCache is true here (see guard above) but no precise age —
      // "unknown age when served from cache" per policy: demote exactly
      // like the >60min case.
      return {
        evidenceTier: "older_price_reference", evidenceBadge: "Earlier price",
        verified: false, pricingSignalOnly: false,
        cacheStatus, sourceFreshness: "unknown", stale: true,
      };
    }
    if (ageMs <= LISTING_VERIFIED_FRESH_MS)  return { ...base, cacheStatus, sourceFreshness: "fresh",  stale: false };
    if (ageMs <= LISTING_VERIFIED_RECENT_MS) return { ...base, cacheStatus, sourceFreshness: "recent", stale: false };
    return {
      evidenceTier: "older_price_reference", evidenceBadge: "Earlier price",
      verified: false, pricingSignalOnly: false,
      cacheStatus, sourceFreshness: "older", stale: true,
    };
  }

  // marketplace_direct / merchant_direct / pricing_signal_only: never
  // verified in the first place, so nothing to demote — only the freshness
  // label changes.
  if (!ageKnown) return { ...base, cacheStatus, sourceFreshness: "unknown", stale: true };
  if (ageMs <= LISTING_WEAK_FRESH_MS) return { ...base, cacheStatus, sourceFreshness: "fresh",  stale: false };
  if (ageMs <= LISTING_WEAK_STALE_MS) return { ...base, cacheStatus, sourceFreshness: "recent", stale: false };
  return { ...base, cacheStatus, sourceFreshness: "older", stale: true };
}
