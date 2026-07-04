import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveListingEvidenceTier, applyListingFreshness } from "./listingEvidenceTier.js";

// ── Phase 2B.3 required scenarios ───────────────────────────────────────────

test("eBay Browse item (provider+itemId+canonicalUrl+finite price) → verified_listing", () => {
  const result = deriveListingEvidenceTier({
    provider: "ebay_browse",
    itemId: "v1|123456789012|0",
    legacyItemId: "123456789012",
    canonicalUrl: "https://www.ebay.com/itm/123456789012",
    directUrl: "https://www.ebay.com/itm/123456789012",
    clickable: true,
    urlQuality: "merchant_direct",
    price: 79.99,
    totalPrice: 79.99,
  });
  assert.deepEqual(result, {
    evidenceTier: "verified_listing",
    evidenceBadge: "Verified",
    verified: true,
    pricingSignalOnly: false,
  });
});

test("SerpAPI merchant direct URL with finite price, no API proof → merchant_direct", () => {
  const result = deriveListingEvidenceTier({
    source: "some-store.com",
    directUrl: "https://www.some-store.com/product/abc123",
    clickable: true,
    urlQuality: "merchant_direct",
    price: 49.99,
    totalPrice: 49.99,
  });
  assert.deepEqual(result, {
    evidenceTier: "merchant_direct",
    evidenceBadge: "Store price",
    verified: false,
    pricingSignalOnly: false,
  });
});

test("SerpAPI result resolving to an eBay item URL without ebay_browse provider/itemId proof → marketplace_direct", () => {
  const result = deriveListingEvidenceTier({
    source: "google shopping",
    directUrl: "https://www.ebay.com/itm/987654321098",
    clickable: true,
    urlQuality: "merchant_direct",
    price: 74.99,
    totalPrice: 74.99,
  });
  assert.deepEqual(result, {
    evidenceTier: "marketplace_direct",
    evidenceBadge: "Marketplace listing",
    verified: false,
    pricingSignalOnly: false,
  });
});

test("Etsy item URL without API proof also → marketplace_direct (peer marketplace host)", () => {
  const result = deriveListingEvidenceTier({
    source: "etsy",
    directUrl: "https://www.etsy.com/listing/1234567890/example",
    clickable: true,
    urlQuality: "merchant_direct",
    price: 22.5,
    totalPrice: 22.5,
  });
  assert.equal(result.evidenceTier, "marketplace_direct");
  assert.equal(result.verified, false);
});

test("Google wrapper / no direct URL → pricing_signal_only", () => {
  const result = deriveListingEvidenceTier({
    source: "google shopping",
    directUrl: null,
    clickable: false,
    urlQuality: "google_unresolved",
    price: 59.99,
    totalPrice: 59.99,
  });
  assert.deepEqual(result, {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
});

test("oracle_pricing_estimate urlQuality → model_estimate", () => {
  const result = deriveListingEvidenceTier({
    source: "eBay - fake_oracle_seller",
    directUrl: null,
    clickable: false,
    urlQuality: "oracle_pricing_estimate",
    price: 79.99,
    totalPrice: 79.99,
  });
  assert.deepEqual(result, {
    evidenceTier: "model_estimate",
    evidenceBadge: "AI estimate",
    verified: false,
    pricingSignalOnly: false,
  });
});

// ── Additional edge coverage ────────────────────────────────────────────────

test("eBay Browse item missing itemId/legacyItemId (incomplete proof) → marketplace_direct, not verified", () => {
  const result = deriveListingEvidenceTier({
    provider: "ebay_browse",
    canonicalUrl: "https://www.ebay.com/itm/123456789012",
    directUrl: "https://www.ebay.com/itm/123456789012",
    clickable: true,
    urlQuality: "merchant_direct",
    price: 79.99,
  });
  assert.equal(result.evidenceTier, "marketplace_direct");
  assert.equal(result.verified, false);
});

test("eBay Browse item with itemId but no finite price → marketplace_direct, not verified", () => {
  const result = deriveListingEvidenceTier({
    provider: "ebay_browse",
    itemId: "v1|123456789012|0",
    canonicalUrl: "https://www.ebay.com/itm/123456789012",
    directUrl: "https://www.ebay.com/itm/123456789012",
    clickable: true,
    urlQuality: "merchant_direct",
    price: null,
    totalPrice: null,
  });
  assert.equal(result.evidenceTier, "marketplace_direct");
  assert.equal(result.verified, false);
});

test("eBay Browse-shaped item but clickable:false → pricing_signal_only (clickability required even with proof)", () => {
  const result = deriveListingEvidenceTier({
    provider: "ebay_browse",
    itemId: "v1|123456789012|0",
    canonicalUrl: "https://www.ebay.com/itm/123456789012",
    directUrl: "https://www.ebay.com/itm/123456789012",
    clickable: false,
    urlQuality: "merchant_direct",
    price: 79.99,
  });
  assert.deepEqual(result, {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
});

test("non-ebay_browse provider string (e.g. plain 'ebay' source) never reaches verified_listing", () => {
  const result = deriveListingEvidenceTier({
    provider: "ebay",
    itemId: "123456789012",
    directUrl: "https://www.ebay.com/itm/123456789012",
    clickable: true,
    urlQuality: "merchant_direct",
    price: 79.99,
  });
  assert.equal(result.evidenceTier, "marketplace_direct");
  assert.equal(result.verified, false);
});

test("missing/empty item defaults to pricing_signal_only without throwing", () => {
  assert.deepEqual(deriveListingEvidenceTier(), {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
  assert.deepEqual(deriveListingEvidenceTier({}), {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
  assert.deepEqual(deriveListingEvidenceTier(null), {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
});

// ── Phase 2B.4 — applyListingFreshness ──────────────────────────────────────

const VERIFIED_TIER = deriveListingEvidenceTier({
  provider: "ebay_browse",
  itemId: "v1|123456789012|0",
  legacyItemId: "123456789012",
  canonicalUrl: "https://www.ebay.com/itm/123456789012",
  directUrl: "https://www.ebay.com/itm/123456789012",
  clickable: true,
  urlQuality: "merchant_direct",
  price: 79.99,
  totalPrice: 79.99,
});

test("live eBay Browse fetch (fetchedAt ~ now) stays verified_listing, fresh", () => {
  const now = Date.now();
  const result = applyListingFreshness(VERIFIED_TIER, { fetchedAt: now - 1000, now });
  assert.deepEqual(result, {
    evidenceTier: "verified_listing", evidenceBadge: "Verified",
    verified: true, pricingSignalOnly: false,
    cacheStatus: null, sourceFreshness: "fresh", stale: false,
  });
});

test("verified_listing with no fetchedAt and no cache signal at all (live, unknown-shape) stays verified, not demoted", () => {
  const result = applyListingFreshness(VERIFIED_TIER, {});
  assert.equal(result.evidenceTier, "verified_listing");
  assert.equal(result.verified, true);
  assert.equal(result.stale, false);
});

test("verified_listing snapshot round-trip within 15min stays verified_listing, fresh", () => {
  const now = Date.now();
  const result = applyListingFreshness(VERIFIED_TIER, { fetchedAt: now - 5 * 60 * 1000, now });
  assert.equal(result.evidenceTier, "verified_listing");
  assert.equal(result.verified, true);
  assert.equal(result.sourceFreshness, "fresh");
  assert.equal(result.stale, false);
});

test("verified_listing snapshot round-trip at 45min → still verified_listing, sourceFreshness recent", () => {
  const now = Date.now();
  const result = applyListingFreshness(VERIFIED_TIER, { fetchedAt: now - 45 * 60 * 1000, now });
  assert.equal(result.evidenceTier, "verified_listing");
  assert.equal(result.verified, true);
  assert.equal(result.sourceFreshness, "recent");
  assert.equal(result.stale, false);
});

test("verified_listing snapshot round-trip beyond 60min → demoted to older_price_reference, verified:false", () => {
  const now = Date.now();
  const result = applyListingFreshness(VERIFIED_TIER, { fetchedAt: now - 3 * 60 * 60 * 1000, now });
  assert.deepEqual(result, {
    evidenceTier: "older_price_reference", evidenceBadge: "Earlier price",
    verified: false, pricingSignalOnly: false,
    cacheStatus: null, sourceFreshness: "older", stale: true,
  });
});

test("verified_listing served from stale_snapshot with no precise age → demoted, sourceFreshness unknown", () => {
  const result = applyListingFreshness(VERIFIED_TIER, { cacheKind: "stale_snapshot" });
  assert.equal(result.evidenceTier, "older_price_reference");
  assert.equal(result.verified, false);
  assert.equal(result.sourceFreshness, "unknown");
  assert.equal(result.stale, true);
  assert.equal(result.cacheStatus, "market_snapshot");
});

test("verified_listing served from fresh_snapshot with precise snapshotAgeMs within 15min stays verified", () => {
  const result = applyListingFreshness(VERIFIED_TIER, { cacheKind: "fresh_snapshot", snapshotAgeMs: 5 * 60 * 1000 });
  assert.equal(result.evidenceTier, "verified_listing");
  assert.equal(result.verified, true);
  assert.equal(result.sourceFreshness, "fresh");
  assert.equal(result.cacheStatus, "market_snapshot");
});

const MERCHANT_TIER = deriveListingEvidenceTier({
  directUrl: "https://www.some-store.com/product/abc123",
  clickable: true, urlQuality: "merchant_direct", price: 49.99,
});

test("merchant_direct (never verified) live with no cache signal → unchanged, fresh label unknown, not stale", () => {
  const result = applyListingFreshness(MERCHANT_TIER, {});
  assert.equal(result.evidenceTier, "merchant_direct");
  assert.equal(result.verified, false);
  assert.equal(result.sourceFreshness, "unknown");
  assert.equal(result.stale, false);
  assert.equal(result.cacheStatus, null);
});

test("merchant_direct served from stale_snapshot within 2hr → tier unchanged, fresh", () => {
  const result = applyListingFreshness(MERCHANT_TIER, { cacheKind: "stale_snapshot", snapshotAgeMs: 30 * 60 * 1000 });
  assert.equal(result.evidenceTier, "merchant_direct");
  assert.equal(result.sourceFreshness, "fresh");
  assert.equal(result.stale, false);
});

test("merchant_direct served from stale_snapshot beyond 6hr → tier unchanged, marked older/stale", () => {
  const result = applyListingFreshness(MERCHANT_TIER, { cacheKind: "stale_snapshot", snapshotAgeMs: 7 * 60 * 60 * 1000 });
  assert.equal(result.evidenceTier, "merchant_direct");
  assert.equal(result.verified, false);
  assert.equal(result.sourceFreshness, "older");
  assert.equal(result.stale, true);
});

const MODEL_ESTIMATE_TIER = deriveListingEvidenceTier({ urlQuality: "oracle_pricing_estimate" });

test("model_estimate stays weak (never verified) regardless of freshness — live", () => {
  const result = applyListingFreshness(MODEL_ESTIMATE_TIER, {});
  assert.equal(result.evidenceTier, "model_estimate");
  assert.equal(result.verified, false);
  assert.equal(result.stale, false);
});

test("model_estimate stays weak (never verified) regardless of freshness — cache-served", () => {
  const result = applyListingFreshness(MODEL_ESTIMATE_TIER, { cacheKind: "stale_snapshot" });
  assert.equal(result.evidenceTier, "model_estimate");
  assert.equal(result.verified, false);
  assert.equal(result.stale, true);
});

test("internal_seed cacheKind (a different, out-of-scope cache system) is not treated as a snapshot cache serve", () => {
  // Guards against snapshotAgeMs (present on resolveInternalMarketHit's
  // return regardless of branch) being misread as "this pool is stale"
  // when the items actually came from the internal_seed branch instead.
  const result = applyListingFreshness(VERIFIED_TIER, { cacheKind: "internal_seed", snapshotAgeMs: 7 * 60 * 60 * 1000 });
  assert.equal(result.evidenceTier, "verified_listing");
  assert.equal(result.verified, true);
  assert.equal(result.cacheStatus, null);
});
