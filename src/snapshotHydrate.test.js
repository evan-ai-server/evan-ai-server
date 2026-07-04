import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compactMarketSnapshotItem } from "./marketSnapshotCompact.js";

const INDEX_SRC = readFileSync(resolve(import.meta.dirname, "../index.js"), "utf8");

// Extract hydrateMarketSnapshotItem body from index.js for functional testing.
// The function is not exported, so we eval it in isolation.
const HYDRATE_MATCH = INDEX_SRC.match(/function hydrateMarketSnapshotItem\(it = \{\}\) \{[\s\S]*?^}/m);
if (!HYDRATE_MATCH) throw new Error("Could not extract hydrateMarketSnapshotItem from index.js");

const finitePrice = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null; };
const hydrate = new Function("finitePrice", `return (${HYDRATE_MATCH[0]})`)(finitePrice);

// ── Round-trip: compact → hydrate preserves recovery fields ─────────────────

test("hydrate preserves _productId from compact snapshot item", () => {
  const compact = compactMarketSnapshotItem({
    title: "Hawaiian 787 Diecast",
    price: 49.99,
    source: "eBay",
    _productId: "11076768015358219087",
    _serpapiProductApiUrl: "https://serpapi.com/search.json?engine=google_product&product_id=11076768015358219087",
    urlQuality: "google_unresolved",
    clickable: false,
  });
  const h = hydrate(compact);
  assert.equal(h._productId, "11076768015358219087");
  assert.equal(h._serpapiProductApiUrl, "https://serpapi.com/search.json?engine=google_product&product_id=11076768015358219087");
  assert.equal(h.urlQuality, "google_unresolved");
});

test("hydrate preserves evidenceQuality from compact", () => {
  const compact = compactMarketSnapshotItem({
    title: "Test Item",
    price: 25,
    source: "Amazon",
    evidenceQuality: "pricing_signal",
    _productId: "123",
  });
  const h = hydrate(compact);
  assert.equal(h.evidenceQuality, "pricing_signal");
});

// ── Trust contract: pricing-only stays pricing-only ─────────────────────────

test("google_unresolved item hydrates as pricing-only", () => {
  const compact = compactMarketSnapshotItem({
    title: "Boeing 787 Hawaiian Airlines",
    price: 59.99,
    source: "ScaleModelStore.com",
    _productId: "11076768015358219087",
    _serpapiProductApiUrl: "https://serpapi.com/search.json?engine=google_product&product_id=11076768015358219087",
    urlQuality: "google_unresolved",
    clickable: false,
    directUrl: null,
    isVerifiedListing: false,
  });
  const h = hydrate(compact);
  assert.equal(h.clickable, false);
  assert.equal(h.directUrl, null);
  assert.equal(h.isVerifiedListing, false);
  assert.equal(h._productId, "11076768015358219087");
  assert.equal(h.urlQuality, "google_unresolved");
});

test("productId alone does NOT create clickable or verified", () => {
  const h = hydrate({
    title: "Test",
    price: 10,
    _productId: "999",
    clickable: false,
  });
  assert.equal(h.clickable, false);
  assert.equal(h.directUrl, null);
  assert.equal(h.isVerifiedListing, false);
  assert.equal(h._productId, "999");
});

// ── Trusted clickable items preserve directUrl ──────────────────────────────

test("clickable item with directUrl preserves all trust fields", () => {
  const compact = compactMarketSnapshotItem({
    title: "Trusted Merchant Item",
    price: 39.99,
    source: "eBay",
    clickable: true,
    directUrl: "https://www.ebay.com/itm/123456",
    urlQuality: "merchant_direct",
    isVerifiedListing: true,
    _productId: "456",
  });
  const h = hydrate(compact);
  assert.equal(h.clickable, true);
  assert.equal(h.directUrl, "https://www.ebay.com/itm/123456");
  assert.equal(h.isVerifiedListing, true);
  assert.equal(h.urlQuality, "merchant_direct");
  assert.equal(h._productId, "456");
});

test("non-clickable item with directUrl in storage gets directUrl nulled", () => {
  const h = hydrate({
    title: "Sneaky Item",
    price: 20,
    clickable: false,
    directUrl: "https://example.com/buy",
    _productId: "789",
  });
  assert.equal(h.clickable, false);
  assert.equal(h.directUrl, null);
});

// ── Null/missing fields pass through safely ─────────────────────────────────

test("hydrate with no recovery fields returns nulls", () => {
  const h = hydrate({ title: "Legacy Item", price: 15, source: "eBay" });
  assert.equal(h._productId, null);
  assert.equal(h._serpapiProductApiUrl, null);
  assert.equal(h.urlQuality, null);
  assert.equal(h.evidenceQuality, null);
  assert.equal(h.clickable, false);
  assert.equal(h.directUrl, null);
  assert.equal(h.isVerifiedListing, false);
});

// ── Phase 2B.4: direct-listing API proof fields survive compact → hydrate ──

const ebayBrowseCompactInput = {
  title: "Hawaiian Airlines Boeing 787-9 1:400 Diecast", price: 79.99, totalPrice: 79.99,
  directUrl: "https://www.ebay.com/itm/123456789012", clickable: true, urlQuality: "merchant_direct",
  provider: "ebay_browse", marketplace: "ebay",
  itemId: "v1|123456789012|0", legacyItemId: "123456789012",
  canonicalUrl: "https://www.ebay.com/itm/123456789012",
  affiliateUrl: "https://www.ebay.com/itm/123456789012?campid=affiliate123",
  seller: { username: "diecastplanes", feedbackPercentage: 99.5, feedbackScore: 4200 },
  conditionId: "1000", availability: "IN_STOCK", buyingOptions: ["FIXED_PRICE"],
  itemLocation: { country: "US", postalCode: "941**" },
  fetchedAt: 1750000000000,
  evidenceTier: "verified_listing", evidenceBadge: "Verified", verified: true, pricingSignalOnly: false,
  isVerifiedListing: true, evidenceQuality: "verified_listing",
};

test("hydrate round-trips provider/itemId/legacyItemId/canonicalUrl/affiliateUrl", () => {
  const compact = compactMarketSnapshotItem(ebayBrowseCompactInput);
  const h = hydrate(compact);
  assert.equal(h.provider, "ebay_browse");
  assert.equal(h.marketplace, "ebay");
  assert.equal(h.itemId, "v1|123456789012|0");
  assert.equal(h.legacyItemId, "123456789012");
  assert.equal(h.canonicalUrl, "https://www.ebay.com/itm/123456789012");
  assert.equal(h.affiliateUrl, "https://www.ebay.com/itm/123456789012?campid=affiliate123");
});

test("hydrate round-trips seller/conditionId/availability/buyingOptions/itemLocation", () => {
  const compact = compactMarketSnapshotItem(ebayBrowseCompactInput);
  const h = hydrate(compact);
  assert.deepEqual(h.seller, { username: "diecastplanes", feedbackPercentage: 99.5, feedbackScore: 4200 });
  assert.equal(h.conditionId, "1000");
  assert.equal(h.availability, "IN_STOCK");
  assert.deepEqual(h.buyingOptions, ["FIXED_PRICE"]);
  assert.deepEqual(h.itemLocation, { country: "US", postalCode: "941**" });
});

test("hydrate round-trips fetchedAt as a number (the key freshness signal for Phase 2B.4)", () => {
  const compact = compactMarketSnapshotItem(ebayBrowseCompactInput);
  const h = hydrate(compact);
  assert.equal(h.fetchedAt, 1750000000000);
});

test("hydrate round-trips evidenceTier/evidenceBadge/verified/pricingSignalOnly (recomputed fresh downstream by sanitizeOutboundListingForClient, but preserved through the snapshot itself)", () => {
  const compact = compactMarketSnapshotItem(ebayBrowseCompactInput);
  const h = hydrate(compact);
  assert.equal(h.evidenceTier, "verified_listing");
  assert.equal(h.evidenceBadge, "Verified");
  assert.equal(h.verified, true);
  assert.equal(h.pricingSignalOnly, false);
});

test("hydrate with no Phase 2B.4 proof fields returns nulls, no crash (SerpAPI-sourced / pre-2B.4 snapshot)", () => {
  const h = hydrate({ title: "Legacy Item", price: 15, source: "eBay" });
  assert.equal(h.provider, null);
  assert.equal(h.itemId, null);
  assert.equal(h.legacyItemId, null);
  assert.equal(h.canonicalUrl, null);
  assert.equal(h.affiliateUrl, null);
  assert.equal(h.seller, null);
  assert.equal(h.buyingOptions, null);
  assert.equal(h.itemLocation, null);
  assert.equal(h.fetchedAt, null);
  assert.equal(h.verified, false);
  assert.equal(h.pricingSignalOnly, false);
});

// ── Static guards on index.js ───────────────────────────────────────────────

test("hydrateMarketSnapshotItem body includes _productId", () => {
  const fnBody = HYDRATE_MATCH[0];
  assert.ok(fnBody.includes("_productId"), "hydrate must preserve _productId");
});

test("hydrateMarketSnapshotItem body includes _serpapiProductApiUrl", () => {
  const fnBody = HYDRATE_MATCH[0];
  assert.ok(fnBody.includes("_serpapiProductApiUrl"), "hydrate must preserve _serpapiProductApiUrl");
});

test("hydrateMarketSnapshotItem body includes urlQuality", () => {
  const fnBody = HYDRATE_MATCH[0];
  assert.ok(fnBody.includes("urlQuality"), "hydrate must preserve urlQuality");
});

test("hydrateMarketSnapshotItem body includes isVerifiedListing", () => {
  const fnBody = HYDRATE_MATCH[0];
  assert.ok(fnBody.includes("isVerifiedListing"), "hydrate must preserve isVerifiedListing");
});

test("hydrateMarketSnapshotItem body includes Phase 2B.4 proof fields (provider/itemId/canonicalUrl/fetchedAt)", () => {
  const fnBody = HYDRATE_MATCH[0];
  assert.ok(fnBody.includes("provider"), "hydrate must preserve provider");
  assert.ok(fnBody.includes("itemId"), "hydrate must preserve itemId");
  assert.ok(fnBody.includes("canonicalUrl"), "hydrate must preserve canonicalUrl");
  assert.ok(fnBody.includes("fetchedAt"), "hydrate must preserve fetchedAt");
});

test("stale snapshot note no longer blames snapshot write", () => {
  assert.ok(
    !INDEX_SRC.includes("recovery fields absent here were dropped at snapshot write"),
    "old misleading note must be updated"
  );
});
