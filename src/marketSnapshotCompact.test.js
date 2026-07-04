// src/marketSnapshotCompact.test.js
// Phase V3.9B — direct tests for compactMarketSnapshotItem.
//
// Run: node --test src/marketSnapshotCompact.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactMarketSnapshotItem } from "./marketSnapshotCompact.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Fresh SerpAPI google_shopping item: google product_link blocked by sanitizer
// → not clickable; carries _productId from product_id field; urlQuality set.
const freshGoogleUnresolved = {
  title: "Hawaiian Airlines 1:400 Boeing 787-9 Diecast", source: "eBay", price: 69.99,
  totalPrice: 69.99, url: null, link: null, buyLink: null, directUrl: null,
  clickable: false, urlQuality: "google_unresolved",
  _productId: "pid_787_abc", _serpapiProductApiUrl: "https://serpapi.com/search.json?engine=google_product&product_id=pid_787_abc",
  isVerifiedListing: false, evidenceQuality: "pricing_signal",
};

// Genuine merchant-direct item (e.g. from Etsy or unwrapped google redirect).
const merchantDirect = {
  title: "GeminiJets 787-9 Hawaiian Dreamliner", source: "Airspotters.com",
  price: 76.01, totalPrice: 76.01,
  url: "https://www.ebay.com/itm/123456789",
  link: "https://www.ebay.com/itm/123456789",
  buyLink: "https://www.ebay.com/itm/123456789",
  directUrl: "https://www.ebay.com/itm/123456789",
  clickable: true, urlQuality: "merchant_direct",
  _productId: "pid_gj", isVerifiedListing: true, evidenceQuality: "verified_listing",
};

// GPT-oracle estimate: no URL, no productId, must never become verified.
const oracleEstimate = {
  title: "Hawaiian 787 (estimate)", source: "eBay", price: 80, totalPrice: 80,
  url: null, link: null, buyLink: null, directUrl: null,
  clickable: false, urlQuality: "oracle_pricing_estimate",
  _productId: null, isVerifiedListing: false, evidenceQuality: "oracle_estimate",
};

// Legacy snapshot item AFTER previous compaction: no _productId, no urlQuality,
// no directUrl — represents the pre-V3.9B shape that was being re-written.
const legacyPreV39B = {
  title: "Herpa Boeing 787-9 Hawaiian Airlines 1:200", source: "eBay",
  price: 70.87, totalPrice: 70.87,
  url: null, link: null, buyLink: null,
  // Missing fields — as stored before V3.9B:
  // _productId: absent, urlQuality: absent, directUrl: absent
};

// ── V3.9B core: recovery metadata is preserved ───────────────────────────────

describe("compactMarketSnapshotItem — V3.9B recovery fields preserved", () => {
  it("_productId is preserved through compaction", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    assert.equal(c._productId, "pid_787_abc");
  });

  it("_serpapiProductApiUrl is preserved through compaction", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    assert.equal(c._serpapiProductApiUrl, "https://serpapi.com/search.json?engine=google_product&product_id=pid_787_abc");
  });

  it("urlQuality is preserved through compaction", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    assert.equal(c.urlQuality, "google_unresolved");
  });

  it("evidenceQuality is preserved through compaction", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    assert.equal(c.evidenceQuality, "pricing_signal");
  });

  it("clickable:false is preserved (pricing-only item stays non-clickable)", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    assert.equal(c.clickable, false);
  });

  it("after compaction, item is a recovery candidate (has _productId, not clickable)", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    // mirrors classifyRecoveryCandidate logic from urlEvidenceAudit.js
    const candidate = c.clickable !== true && c.isVerifiedListing !== true && c._productId != null;
    assert.equal(candidate, true);
  });
});

// ── Trust invariants unchanged ────────────────────────────────────────────────

describe("compactMarketSnapshotItem — trust invariants unchanged by V3.9B", () => {
  it("pricing-only stays pricing-only: no directUrl for google_unresolved items", () => {
    const c = compactMarketSnapshotItem(freshGoogleUnresolved);
    assert.equal(c.directUrl, null);
    assert.equal(c.clickable, false);
    assert.equal(c.isVerifiedListing, false);
  });

  it("oracle estimate stays non-verified: isVerifiedListing:false, directUrl:null", () => {
    const c = compactMarketSnapshotItem(oracleEstimate);
    assert.equal(c.isVerifiedListing, false);
    assert.equal(c.directUrl, null);
    assert.equal(c.clickable, false);
  });

  it("a product ID alone does NOT make an item clickable", () => {
    const item = { title: "X", price: 50, _productId: "pid_test", clickable: false, urlQuality: "google_unresolved" };
    const c = compactMarketSnapshotItem(item);
    assert.equal(c._productId, "pid_test");
    assert.equal(c.clickable, false);
    assert.equal(c.directUrl, null);
    assert.equal(c.isVerifiedListing, false);
  });

  it("a product ID alone does NOT make an item verified", () => {
    const item = { _productId: "p1", urlQuality: "google_unresolved", clickable: false, isVerifiedListing: false };
    const c = compactMarketSnapshotItem(item);
    assert.equal(c.isVerifiedListing, false);
  });

  it("legacy item with no URL evidence stays non-clickable and non-verified", () => {
    const c = compactMarketSnapshotItem(legacyPreV39B);
    assert.equal(c._productId, null);
    assert.equal(c.urlQuality, null);
    assert.equal(c.directUrl, null);
    assert.equal(c.clickable, false);
    assert.equal(c.isVerifiedListing, false);
  });
});

// ── Merchant-direct items: trusted URL survives ───────────────────────────────

describe("compactMarketSnapshotItem — merchant-direct URL is preserved when trusted", () => {
  it("merchant_direct + clickable:true → directUrl preserved", () => {
    const c = compactMarketSnapshotItem(merchantDirect);
    assert.equal(c.directUrl, "https://www.ebay.com/itm/123456789");
    assert.equal(c.clickable, true);
    assert.equal(c.isVerifiedListing, true);
    assert.equal(c.urlQuality, "merchant_direct");
  });

  it("merchant_resolved + clickable:true → directUrl preserved", () => {
    const c = compactMarketSnapshotItem({
      title: "X", price: 50, directUrl: "https://etsy.com/listing/1",
      clickable: true, urlQuality: "merchant_resolved", isVerifiedListing: true,
    });
    assert.equal(c.directUrl, "https://etsy.com/listing/1");
  });

  it("google_redirect_unwrapped + clickable:true → directUrl preserved", () => {
    const c = compactMarketSnapshotItem({
      title: "Y", price: 60, directUrl: "https://shop.example.com/product/1",
      clickable: true, urlQuality: "google_redirect_unwrapped", isVerifiedListing: true,
    });
    assert.equal(c.directUrl, "https://shop.example.com/product/1");
  });

  it("merchant_direct + clickable:false (edge) → directUrl is NOT preserved", () => {
    // If something marked merchant_direct but NOT clickable, don't store the URL.
    const c = compactMarketSnapshotItem({
      title: "Z", price: 70, directUrl: "https://ebay.com/itm/99",
      clickable: false, urlQuality: "merchant_direct",
    });
    assert.equal(c.directUrl, null);
  });

  it("unknown/legacy urlQuality + clickable:true → directUrl NOT preserved (not a known-safe class)", () => {
    const c = compactMarketSnapshotItem({
      title: "W", price: 80, directUrl: "https://example.com/product",
      clickable: true, urlQuality: "unknown_legacy_has_url",
    });
    assert.equal(c.directUrl, null);
  });
});

// ── Existing fields still work ────────────────────────────────────────────────

describe("compactMarketSnapshotItem — existing non-URL fields unaffected by V3.9B", () => {
  it("price is preserved and rounded", () => {
    const c = compactMarketSnapshotItem({ price: 69.999, totalPrice: 69.999 });
    assert.equal(c.price, 70.0);
    assert.equal(c.totalPrice, 70.0);
  });

  it("null price stays null", () => {
    assert.equal(compactMarketSnapshotItem({}).price, null);
  });

  it("image, rating, reviews preserved", () => {
    const c = compactMarketSnapshotItem({ image: "https://img.com/x.jpg", rating: 4.5, reviews: 12 });
    assert.equal(c.image, "https://img.com/x.jpg");
    assert.equal(c.rating, 4.5);
    assert.equal(c.reviews, 12);
  });

  it("sold:true preserved", () => {
    assert.equal(compactMarketSnapshotItem({ sold: true }).sold, true);
  });

  it("trust scores preserved", () => {
    const c = compactMarketSnapshotItem({ trust: 0.7, dealScore: 3, flipScore: 2, sellerScore: 1 });
    assert.equal(c.trust, 0.7);
    assert.equal(c.dealScore, 3);
    assert.equal(c.flipScore, 2);
  });

  it("empty input returns stable shape (no crash, no undefined fields)", () => {
    const c = compactMarketSnapshotItem();
    assert.equal(c.title, null);
    assert.equal(c._productId, null);
    assert.equal(c.urlQuality, null);
    assert.equal(c.isVerifiedListing, false);
    assert.equal(c.clickable, false);
  });
});

// ── Phase 2B.4: direct-listing API proof fields are preserved ────────────────

const ebayBrowseItem = {
  title: "Hawaiian Airlines Boeing 787-9 1:400 Diecast", source: "eBay", price: 79.99, totalPrice: 79.99,
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

describe("compactMarketSnapshotItem — Phase 2B.4 API proof fields preserved", () => {
  it("provider/marketplace/itemId/legacyItemId/canonicalUrl/affiliateUrl are preserved", () => {
    const c = compactMarketSnapshotItem(ebayBrowseItem);
    assert.equal(c.provider, "ebay_browse");
    assert.equal(c.marketplace, "ebay");
    assert.equal(c.itemId, "v1|123456789012|0");
    assert.equal(c.legacyItemId, "123456789012");
    assert.equal(c.canonicalUrl, "https://www.ebay.com/itm/123456789012");
    assert.equal(c.affiliateUrl, "https://www.ebay.com/itm/123456789012?campid=affiliate123");
  });

  it("seller sub-fields are preserved and re-sanitized to the known shape only", () => {
    const c = compactMarketSnapshotItem(ebayBrowseItem);
    assert.deepEqual(c.seller, { username: "diecastplanes", feedbackPercentage: 99.5, feedbackScore: 4200 });
  });

  it("conditionId/availability/buyingOptions/itemLocation are preserved", () => {
    const c = compactMarketSnapshotItem(ebayBrowseItem);
    assert.equal(c.conditionId, "1000");
    assert.equal(c.availability, "IN_STOCK");
    assert.deepEqual(c.buyingOptions, ["FIXED_PRICE"]);
    assert.deepEqual(c.itemLocation, { country: "US", postalCode: "941**" });
  });

  it("fetchedAt is preserved as a number", () => {
    const c = compactMarketSnapshotItem(ebayBrowseItem);
    assert.equal(c.fetchedAt, 1750000000000);
  });

  it("evidenceTier/evidenceBadge/verified/pricingSignalOnly are preserved", () => {
    const c = compactMarketSnapshotItem(ebayBrowseItem);
    assert.equal(c.evidenceTier, "verified_listing");
    assert.equal(c.evidenceBadge, "Verified");
    assert.equal(c.verified, true);
    assert.equal(c.pricingSignalOnly, false);
  });

  it("a giant/oversized seller object is rebuilt to only the known-safe sub-fields, never stored raw", () => {
    const c = compactMarketSnapshotItem({
      ...ebayBrowseItem,
      seller: { username: "x", feedbackPercentage: 100, feedbackScore: 1, rawAuthToken: "should-never-be-stored", registrationDate: "2001-01-01", hugeBlob: "y".repeat(10000) },
    });
    assert.deepEqual(Object.keys(c.seller).sort(), ["feedbackPercentage", "feedbackScore", "username"]);
  });

  it("SerpAPI-sourced item (no proof fields) compacts to all-null proof fields, no crash", () => {
    const c = compactMarketSnapshotItem(merchantDirect);
    assert.equal(c.provider, null);
    assert.equal(c.itemId, null);
    assert.equal(c.canonicalUrl, null);
    assert.equal(c.seller, null);
    assert.equal(c.buyingOptions, null);
    assert.equal(c.itemLocation, null);
    assert.equal(c.fetchedAt, null);
  });

  it("empty input returns null proof fields, no crash", () => {
    const c = compactMarketSnapshotItem();
    assert.equal(c.provider, null);
    assert.equal(c.itemId, null);
    assert.equal(c.seller, null);
    assert.equal(c.verified, false);
    assert.equal(c.pricingSignalOnly, false);
  });
});
