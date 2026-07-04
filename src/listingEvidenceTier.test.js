import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveListingEvidenceTier } from "./listingEvidenceTier.js";

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
