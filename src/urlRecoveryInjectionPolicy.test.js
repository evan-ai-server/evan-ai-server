import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUrlRecoveryCacheRecord } from "./urlRecoveryInjectionPolicy.js";

// Mirrors the real index.js _isValidMerchantUrl host/scheme policy. The real
// validator (passed in production) additionally rejects google redirects and
// merchant search pages via isGoogleRedirect/_isMerchantSearchPage; those are
// covered by index.js's own tests. Here we exercise host/scheme rejection.
function _isValidMerchantUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!host || host.includes("serpapi.") || /(^|\.)google\./i.test(host) ||
        /(^|\.)googleadservices\./i.test(host) || /(^|\.)doubleclick\.net$/i.test(host)) return false;
  } catch { return false; }
  return true;
}

const CTX = { scanId: "test-scan", query: "hawaiian airlines boeing 787 diecast", isValidMerchantUrl: _isValidMerchantUrl };

function makeItem(overrides = {}) {
  return {
    title: "Hawaiian Airlines Boeing 787 Diecast Model", price: 49.99, totalPrice: 49.99,
    source: "eBay", _productId: "123", clickable: false, urlQuality: "google_unresolved",
    ...overrides,
  };
}

// Full write-time guard metadata (5A.3C.2 shape).
function makeFullRec(overrides = {}) {
  return {
    _productId: "123",
    directUrl: "https://www.ebay.com/itm/123456",
    urlQuality: "merchant_direct",
    urlHost: "www.ebay.com",
    recoveryGuardVersion: 1,
    origTitle: "Hawaiian Airlines Boeing 787 Diecast Model",
    origSource: "eBay",
    origPrice: 49.99,
    recoveredPrice: 49.99,
    guardScore: 0.8,
    recoveredAtMs: Date.now(),
    ...overrides,
  };
}

// ── A. Old-shape record (no guard metadata) rejects ───────────────────────────

test("old-shape cache record without guard metadata does not inject", () => {
  const rec = { _productId: "123", directUrl: "https://www.ebay.com/itm/1", urlQuality: "merchant_direct", urlHost: "www.ebay.com" };
  const result = applyUrlRecoveryCacheRecord(makeItem(), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "insufficient_recovery_identity_evidence");
});

test("record with directUrl but missing origTitle rejects as insufficient evidence", () => {
  const rec = makeFullRec({ origTitle: null });
  const result = applyUrlRecoveryCacheRecord(makeItem(), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "insufficient_recovery_identity_evidence");
});

// ── B. Missing merchant URL validator rejects (fail closed) ───────────────────

test("missing isValidMerchantUrl validator does not inject", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem(), makeFullRec(), { query: "hawaiian 787" });
  assert.equal(result.inject, false);
  assert.equal(result.reason, "missing_merchant_url_validator");
});

// ── C. Full match injects ─────────────────────────────────────────────────────

test("full guard metadata + matching identity + valid URL injects", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem(), makeFullRec(), CTX);
  assert.equal(result.inject, true);
  assert.equal(result.reason, "identity_passed");
  assert.equal(result.item.directUrl, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.link, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.url, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.buyLink, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.clickable, true);
  assert.equal(result.item.urlQuality, "merchant_direct");
  assert.equal(result.item.urlHost, "www.ebay.com");
  assert.notEqual(result.item.isVerifiedListing, true); // sanitizer derives verified, not the helper
});

// ── D. Wrong cached origTitle (aircraft family) rejects ───────────────────────

test("cached origTitle says 777 but current item says 787 rejects", () => {
  const rec = makeFullRec({ origTitle: "Hawaiian Airlines Boeing 777 Diecast" });
  const result = applyUrlRecoveryCacheRecord(makeItem({ title: "Hawaiian Airlines Boeing 787 Diecast" }), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_title_contradiction");
});

test("cached origTitle says 747 but current item says 787 rejects", () => {
  const rec = makeFullRec({ origTitle: "Hawaiian Airlines Boeing 747 Diecast" });
  const result = applyUrlRecoveryCacheRecord(makeItem({ title: "Hawaiian Airlines Boeing 787 Diecast" }), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_title_contradiction");
});

// ── E. Wrong airline rejects ──────────────────────────────────────────────────

test("cached origTitle says ANA but current item says Hawaiian rejects", () => {
  const rec = makeFullRec({ origTitle: "ANA Boeing 787 Diecast" });
  const result = applyUrlRecoveryCacheRecord(makeItem({ title: "Hawaiian Airlines Boeing 787 Diecast" }), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_title_contradiction");
});

test("cached origTitle says United but current item says Hawaiian rejects", () => {
  const rec = makeFullRec({ origTitle: "United Airlines Boeing 787 Diecast" });
  const result = applyUrlRecoveryCacheRecord(makeItem({ title: "Hawaiian Airlines Boeing 787 Diecast" }), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_title_contradiction");
});

// ── F. Wrong manufacturer rejects ─────────────────────────────────────────────

test("cached origTitle says Airbus A380 but current item says Boeing 787 rejects", () => {
  const rec = makeFullRec({ origTitle: "Airbus A380 Diecast", urlHost: "diecaststore.com", directUrl: "https://diecaststore.com/buy/1" });
  const result = applyUrlRecoveryCacheRecord(makeItem({ title: "Boeing 787 Diecast" }), rec, { ...CTX, query: "boeing 787 diecast" });
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_title_contradiction");
});

// ── G. Price drift rejects ────────────────────────────────────────────────────

test("current price far above cached prices rejects as price drift", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem({ price: 500, totalPrice: 500 }), makeFullRec({ origPrice: 49.99, recoveredPrice: 49.99 }), CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_price_drift");
});

test("missing current price fails closed", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem({ price: undefined, totalPrice: undefined }), makeFullRec(), CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "injection_guard_metadata_mismatch");
});

// ── H. Price within tolerance passes ──────────────────────────────────────────

test("current price within percent tolerance of cached price injects", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem({ price: 52, totalPrice: 52 }), makeFullRec({ origPrice: 49.99, recoveredPrice: 49.99 }), CTX);
  assert.equal(result.inject, true);
  assert.equal(result.reason, "identity_passed");
});

// ── I. Google shell still rejects (even with metadata) ────────────────────────

test("Google shell URL rejects even with full metadata", () => {
  const rec = makeFullRec({ directUrl: "https://www.google.com/search?ibp=oshop&q=x&prds=productid:123", urlHost: "www.google.com" });
  const result = applyUrlRecoveryCacheRecord(makeItem(), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "google_shell_url");
});

// ── J. SerpAPI URL still rejects ──────────────────────────────────────────────

test("SerpAPI URL rejects even with full metadata", () => {
  const rec = makeFullRec({ directUrl: "https://serpapi.com/search.json?engine=google_product&product_id=123", urlHost: "serpapi.com" });
  const result = applyUrlRecoveryCacheRecord(makeItem(), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "invalid_merchant_url");
});

// ── K. Already verified item does not re-inject ───────────────────────────────

test("already verified item is not re-injected and is unchanged", () => {
  const item = makeItem({ clickable: true, isVerifiedListing: true, directUrl: "https://www.ebay.com/itm/original" });
  const rec = makeFullRec({ directUrl: "https://www.ebay.com/itm/different" });
  const result = applyUrlRecoveryCacheRecord(item, rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "already_verified");
  assert.equal(result.item.directUrl, "https://www.ebay.com/itm/original");
});

// ── Structural rejects (still apply) ──────────────────────────────────────────

test("no cached record does not inject", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem(), null, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "no_cached_record");
});

test("item without _productId does not inject", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem({ _productId: undefined }), makeFullRec(), CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "no_cached_record");
});

test("cached record without directUrl does not inject", () => {
  const rec = makeFullRec({ directUrl: null });
  const result = applyUrlRecoveryCacheRecord(makeItem(), rec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "missing_direct_url");
});

// ── L. Injected item shape is what the sanitizer needs to derive verified ─────

test("injected item carries merchant_direct + clickable + directUrl for sanitizer", () => {
  const result = applyUrlRecoveryCacheRecord(makeItem(), makeFullRec(), CTX);
  assert.equal(result.inject, true);
  // sanitizeOutboundListingForClient classifies (merchant_direct && clickable !== false && directUrl)
  // → verified_listing. Assert the injected item satisfies all three preconditions.
  assert.equal(result.item.urlQuality, "merchant_direct");
  assert.notEqual(result.item.clickable, false);
  assert.ok(result.item.directUrl);
});
