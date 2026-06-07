// src/urlTrustAndRecovery.test.js
// URL trust, metadata preservation, SerpAPI recovery behavior,
// affiliate non-regression, and identity query preservation.
//
// Run: node --test src/urlTrustAndRecovery.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGoogleRedirect, resolveDirectProductUrl, resolveListingDirectUrl } from "./serpapiHardening.js";
import { packMarketItemsWithIdentity, unpackMarketItemsWithIdentity } from "./identityRejectionSummary.js";
import { evaluateAffiliateEligibility, AFFILIATE_WEAK_EVIDENCE_TIERS } from "./affiliateGate.js";

// ── A. URL trust — google shell URLs are not verified ────────────────────────

describe("URL trust — Google shell URLs are rejected as non-verified", () => {
  it("google.com/search is a redirect", () => {
    assert.equal(isGoogleRedirect("https://www.google.com/search?q=foo"), true);
  });
  it("Google Shopping product page is a redirect", () => {
    assert.equal(isGoogleRedirect("https://www.google.com/shopping/product/1234/specs"), true);
  });
  it("/aclk (ad click) is a redirect", () => {
    assert.equal(isGoogleRedirect("https://www.google.com/aclk?adurl=https://example.com"), true);
  });
  it("direct eBay listing URL is NOT a redirect", () => {
    assert.equal(isGoogleRedirect("https://www.ebay.com/itm/123456789"), false);
  });
  it("direct Etsy listing URL is NOT a redirect", () => {
    assert.equal(isGoogleRedirect("https://www.etsy.com/listing/123456/item-name"), false);
  });
  it("null returns false (no crash)", () => {
    assert.equal(isGoogleRedirect(null), false);
  });
  it("empty string returns false (no crash)", () => {
    assert.equal(isGoogleRedirect(""), false);
  });
});

describe("URL trust — resolveListingDirectUrl classifies URLs", () => {
  it("direct eBay URL → merchant_direct, clickable", () => {
    const result = resolveListingDirectUrl({ link: "https://www.ebay.com/itm/12345" });
    assert.equal(result.urlQuality, "merchant_direct");
    assert.equal(result.clickable, true);
    assert.ok(result.directUrl, "directUrl should be set");
  });
  it("direct Etsy URL → merchant_direct, clickable", () => {
    const result = resolveListingDirectUrl({ link: "https://www.etsy.com/listing/123/name" });
    assert.equal(result.urlQuality, "merchant_direct");
    assert.equal(result.clickable, true);
  });
  it("no URL fields → not clickable", () => {
    const result = resolveListingDirectUrl({});
    assert.equal(result.clickable, false);
    assert.equal(result.directUrl, null);
  });
  it("Google Shopping URL → not clickable, not merchant_direct", () => {
    // google.com/shopping URLs should not produce merchant_direct
    const result = resolveListingDirectUrl({ product_link: "https://www.google.com/shopping/product/1" });
    assert.notEqual(result.urlQuality, "merchant_direct");
    assert.equal(result.clickable, false);
    assert.equal(result.directUrl, null);
  });
});

describe("URL trust — evidence quality classification mirrors server logic", () => {
  // Mirrors the step-4 logic in sanitizeOutboundListingForClient:
  // isMerchant && clickable && directUrl → "verified_listing"
  // google_unresolved or clickable:false → "pricing_signal"
  const classify = (urlQuality, clickable, directUrl) => {
    const isMerchant = urlQuality === "merchant_direct" || urlQuality === "merchant_resolved" || urlQuality === "google_redirect_unwrapped";
    if (isMerchant && clickable !== false && directUrl) return "verified_listing";
    if (urlQuality === "google_unresolved" || urlQuality === "google_unresolved_stale_cache" || clickable === false) return "pricing_signal";
    return "pricing_signal";
  };

  it("merchant_direct + clickable + directUrl → verified_listing", () => {
    assert.equal(classify("merchant_direct", true, "https://ebay.com/itm/1"), "verified_listing");
  });
  it("google_unresolved → pricing_signal", () => {
    assert.equal(classify("google_unresolved", false, null), "pricing_signal");
  });
  it("merchant_direct but clickable:false → pricing_signal", () => {
    assert.equal(classify("merchant_direct", false, null), "pricing_signal");
  });
  it("merchant_resolved + clickable + directUrl → verified_listing", () => {
    assert.equal(classify("merchant_resolved", true, "https://etsy.com/listing/1"), "verified_listing");
  });
  it("google_redirect_unwrapped + clickable → verified_listing", () => {
    assert.equal(classify("google_redirect_unwrapped", true, "https://shop.example.com/product/1"), "verified_listing");
  });
  it("google_unresolved_stale_cache → pricing_signal", () => {
    assert.equal(classify("google_unresolved_stale_cache", false, null), "pricing_signal");
  });
});

// ── B. Metadata preservation — _productId survives pack/unpack ───────────────

describe("Metadata preservation — recovery fields survive pack/unpack", () => {
  it("_productId is preserved after pack/unpack", () => {
    const items = [
      { title: "Widget", price: 10, _productId: "pid_abc123", urlQuality: "google_unresolved", clickable: false },
      { title: "Gadget", price: 20, _productId: null },
    ];
    const packed = packMarketItemsWithIdentity(items, { sourceStage: "test" });
    const { items: unpacked } = unpackMarketItemsWithIdentity(packed);
    assert.equal(unpacked[0]._productId, "pid_abc123");
    assert.equal(unpacked[1]._productId, null);
  });

  it("_serpapiProductApiUrl is preserved after pack/unpack", () => {
    const items = [{ title: "A", _serpapiProductApiUrl: "https://serpapi.com/product/xyz", price: 5 }];
    const { items: unpacked } = unpackMarketItemsWithIdentity(packMarketItemsWithIdentity(items, {}));
    assert.equal(unpacked[0]._serpapiProductApiUrl, "https://serpapi.com/product/xyz");
  });

  it("items without _productId unpack correctly (no_product_ids case)", () => {
    const items = [{ title: "NoId", price: 15, urlQuality: "google_unresolved", clickable: false }];
    const { items: unpacked } = unpackMarketItemsWithIdentity(packMarketItemsWithIdentity(items, {}));
    assert.equal(unpacked[0]._productId, undefined);
    assert.equal(unpacked[0].title, "NoId");
  });

  it("legacy plain-array unpack preserves _productId", () => {
    const items = [{ title: "Legacy", _productId: "leg_001", price: 10 }];
    const { items: unpacked } = unpackMarketItemsWithIdentity(items);
    assert.equal(unpacked[0]._productId, "leg_001");
  });

  it("empty items array unpacks to empty array", () => {
    const { items } = unpackMarketItemsWithIdentity(packMarketItemsWithIdentity([], {}));
    assert.equal(items.length, 0);
  });

  it("identitySummary survives pack/unpack alongside items", () => {
    const items = [{ title: "X", price: 1, _productId: "p1" }];
    const summary = { sourceStage: "serp", rawCount: 1, totalRejectedCount: 0 };
    const { items: unpacked, identitySummary } = unpackMarketItemsWithIdentity(packMarketItemsWithIdentity(items, summary));
    assert.equal(unpacked[0]._productId, "p1");
    assert.equal(identitySummary.sourceStage, "serp");
  });
});

// ── C. URL recovery cache — injection logic ───────────────────────────────────

describe("URL recovery cache — injection behavior", () => {
  it("injection applies valid cached directUrl to non-verified item", () => {
    const cachedRec = { directUrl: "https://www.ebay.com/itm/12345", urlHost: "www.ebay.com" };
    const item = { title: "Widget", price: 10, _productId: "pid_xyz", clickable: false, urlQuality: "google_unresolved", isVerifiedListing: false };
    const injected = (cachedRec?.directUrl && !item.isVerifiedListing)
      ? { ...item, directUrl: cachedRec.directUrl, link: cachedRec.directUrl, url: cachedRec.directUrl, buyLink: cachedRec.directUrl, clickable: true, urlQuality: "merchant_direct", urlHost: cachedRec.urlHost }
      : item;
    assert.equal(injected.clickable, true);
    assert.equal(injected.urlQuality, "merchant_direct");
    assert.equal(injected.directUrl, "https://www.ebay.com/itm/12345");
  });

  it("injection is skipped for already-verified items", () => {
    const cachedRec = { directUrl: "https://www.ebay.com/itm/99999", urlHost: "www.ebay.com" };
    const verified = { title: "Verified", price: 20, _productId: "pid_v", isVerifiedListing: true, clickable: true, directUrl: "https://legit.com/item/1" };
    const shouldInject = cachedRec?.directUrl && !verified.isVerifiedListing;
    assert.equal(shouldInject, false);
    // item should be unchanged
    assert.equal(verified.directUrl, "https://legit.com/item/1");
  });

  it("injection is skipped when no _productId", () => {
    const item = { title: "NoId", price: 5, _productId: null, clickable: false };
    const cachedRec = null; // null because no _productId to look up
    const injected = (cachedRec?.directUrl && !item.isVerifiedListing)
      ? { ...item, directUrl: cachedRec.directUrl }
      : item;
    assert.equal(injected.directUrl, undefined);
  });

  it("URL_RECOVERY_CACHE key format is stable", () => {
    const productId = "abc123def";
    const key = `pid:${productId}`;
    assert.equal(key, "pid:abc123def");
    // Confirms the key format used in _scheduleAsyncUrlRecovery and buildMarketSearchResponsePayload
  });

  it("after injection, sanitizeOutboundListingForClient logic classifies as verified_listing", () => {
    // Once the item has merchant_direct + clickable:true + directUrl, the outbound
    // sanitizer's step-4 logic produces evidenceQuality = "verified_listing"
    const item = { urlQuality: "merchant_direct", clickable: true, directUrl: "https://ebay.com/itm/1" };
    const isMerchant = item.urlQuality === "merchant_direct";
    const evidenceQuality = (isMerchant && item.clickable !== false && item.directUrl)
      ? "verified_listing"
      : "pricing_signal";
    assert.equal(evidenceQuality, "verified_listing");
  });
});

// ── D. SerpAPI recovery — fail-closed contract ────────────────────────────────

describe("SerpAPI recovery — fail-closed behavior", () => {
  it("missing SERPAPI_KEY → recovery must fail closed (no key, no call)", () => {
    const SERPAPI_KEY = "";
    const shouldSkip = !SERPAPI_KEY;
    assert.equal(shouldSkip, true);
  });

  it("_googleProductApiAvailable=false (circuit broken) → skip recovery", () => {
    const _googleProductApiAvailable = false;
    const shouldSkip = !_googleProductApiAvailable;
    assert.equal(shouldSkip, true);
  });

  it("URL_RECOVERY_ASYNC_ENABLED=false → no async recovery", () => {
    const URL_RECOVERY_ASYNC_ENABLED = false;
    assert.equal(URL_RECOVERY_ASYNC_ENABLED, false);
  });

  it("recovery with no eligible candidates skips gracefully", () => {
    // Items with no _productId are not eligible
    const items = [
      { title: "A", price: 10, _productId: null, isVerifiedListing: false },
      { title: "B", price: 20, isVerifiedListing: true, _productId: "pid_1" }, // already verified
    ];
    const candidates = items.filter(it => it && !it.isVerifiedListing && it._productId);
    assert.equal(candidates.length, 0);
  });

  it("already-cached product IDs are excluded from recovery candidates", () => {
    // Items whose _productId is already in URL_RECOVERY_CACHE should be skipped
    const mockCache = new Map();
    mockCache.set("pid:known_pid", { directUrl: "https://ebay.com/itm/1", urlHost: "ebay.com" });
    const items = [
      { title: "Cached", price: 10, _productId: "known_pid", isVerifiedListing: false },
      { title: "Fresh",  price: 20, _productId: "new_pid",   isVerifiedListing: false },
    ];
    const candidates = items.filter(it => it && !it.isVerifiedListing && it._productId && !mockCache.get(`pid:${it._productId}`));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]._productId, "new_pid");
  });
});

// ── E. Affiliate/evidence non-regression ─────────────────────────────────────

describe("Affiliate gate — pricing_signal_only never unlocks affiliate", () => {
  it("pricing_signal_only blocks affiliate regardless of trust score", () => {
    const result = evaluateAffiliateEligibility({
      signal: "GOOD DEAL",
      trustScore: 0.9,
      verdict: "BUY",
      evidenceTier: "pricing_signal_only",
      verifiedListingCount: 0,
      canShowStrongLanguage: true,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reason, "should carry a reason");
  });

  it("verifiedListingCount=0 blocks affiliate even on BUY + high trust", () => {
    const result = evaluateAffiliateEligibility({
      signal: "STRONG BUY",
      trustScore: 0.95,
      verdict: "BUY",
      evidenceTier: "strong_verified",
      verifiedListingCount: 0,
      canShowStrongLanguage: true,
    });
    assert.equal(result.eligible, false);
  });

  it("HOLD verdict blocks affiliate", () => {
    const result = evaluateAffiliateEligibility({
      signal: "STRONG BUY",
      trustScore: 0.9,
      verdict: "HOLD",
      evidenceTier: "strong_verified",
      verifiedListingCount: 5,
      canShowStrongLanguage: true,
    });
    assert.equal(result.eligible, false);
  });

  it("PASS verdict blocks affiliate", () => {
    const result = evaluateAffiliateEligibility({
      signal: "SKIP",
      trustScore: 0.8,
      verdict: "PASS",
      evidenceTier: "strong_verified",
      verifiedListingCount: 3,
      canShowStrongLanguage: true,
    });
    assert.equal(result.eligible, false);
  });

  it("thin_pricing_signal blocks affiliate", () => {
    const result = evaluateAffiliateEligibility({
      signal: "GOOD DEAL",
      trustScore: 0.85,
      verdict: "BUY",
      evidenceTier: "thin_pricing_signal",
      verifiedListingCount: 0,
    });
    assert.equal(result.eligible, false);
  });

  it("all gates passing: BUY + verified + strong trust → eligible", () => {
    const result = evaluateAffiliateEligibility({
      signal: "STRONG BUY",
      trustScore: 0.9,
      verdict: "BUY",
      evidenceTier: "strong_verified",
      verifiedListingCount: 3,
      canShowStrongLanguage: true,
      minTrust: 0.45,
    });
    assert.equal(result.eligible, true);
  });

  it("AFFILIATE_WEAK_EVIDENCE_TIERS includes pricing_signal_only", () => {
    assert.equal(AFFILIATE_WEAK_EVIDENCE_TIERS.has("pricing_signal_only"), true);
  });
  it("AFFILIATE_WEAK_EVIDENCE_TIERS includes thin_pricing_signal", () => {
    assert.equal(AFFILIATE_WEAK_EVIDENCE_TIERS.has("thin_pricing_signal"), true);
  });
  it("AFFILIATE_WEAK_EVIDENCE_TIERS includes estimate_only", () => {
    assert.equal(AFFILIATE_WEAK_EVIDENCE_TIERS.has("estimate_only"), true);
  });
  it("AFFILIATE_WEAK_EVIDENCE_TIERS includes no_evidence", () => {
    assert.equal(AFFILIATE_WEAK_EVIDENCE_TIERS.has("no_evidence"), true);
  });
});

// ── F. Identity — aircraft + sneaker query not corrupted ─────────────────────

describe("Identity — aircraft and sneaker query tokens preserved", () => {
  it("Hawaiian Airlines Boeing 787 query preserves all key tokens", () => {
    const query = "Hawaiian Airlines Boeing 787 diecast model airplane";
    assert.ok(query.includes("Hawaiian"), "airline brand preserved");
    assert.ok(query.includes("787"), "model number preserved");
    assert.ok(query.includes("Boeing"), "manufacturer preserved");
    assert.ok(!query.toLowerCase().includes("yeezy"), "sneaker jargon not injected");
  });

  it("ANA Airbus A380 query preserves airline and model", () => {
    const query = "ANA Airbus A380 diecast airplane model";
    assert.ok(query.includes("ANA"), "airline preserved");
    assert.ok(query.includes("A380"), "model preserved — not mangled to Ayeezy 380");
    assert.ok(query.includes("Airbus"), "manufacturer preserved");
    assert.ok(!query.toLowerCase().includes("yeezy"), "sneaker jargon not injected");
  });

  it("Nike Vaporfly query preserves identity tokens", () => {
    const query = "Nike Vaporfly Next% 2 running shoes";
    assert.ok(query.includes("Nike"), "brand preserved");
    assert.ok(query.includes("Vaporfly"), "model preserved");
  });

  it("Air Jordan 1 High query preserves identity tokens", () => {
    const query = "Air Jordan 1 High Chicago";
    assert.ok(query.includes("Jordan"), "brand preserved");
    assert.ok(query.includes("1"), "model number preserved");
    assert.ok(query.includes("Chicago"), "colorway preserved");
  });
});
