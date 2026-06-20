import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUrlRecoveryCacheRecord } from "./urlRecoveryInjectionPolicy.js";

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

// ── A. ProductId alone — no cached record ─────────────────────────────────────

test("productId alone without cached record does not inject", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false, urlQuality: "google_unresolved" };
  const result = applyUrlRecoveryCacheRecord(item, null, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "no_cached_record");
  assert.equal(result.item.clickable, false);
  assert.equal(result.item.isVerifiedListing, undefined);
});

// ── B. Missing direct URL ─────────────────────────────────────────────────────

test("cached record without directUrl does not inject", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: null, urlHost: null, urlQuality: "merchant_direct" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "missing_direct_url");
});

// ── C. Google shell URL ───────────────────────────────────────────────────────

test("cached Google Shopping shell URL does not inject", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://www.google.com/search?ibp=oshop&q=hawaiian+787&prds=productid:123", urlHost: "www.google.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "google_shell_url");
});

// ── D. Google search URL ──────────────────────────────────────────────────────

test("cached Google search URL does not inject", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://www.google.com/search?q=hawaiian+airlines+787", urlHost: "www.google.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "google_shell_url");
});

// ── E. SerpAPI URL ────────────────────────────────────────────────────────────

test("cached SerpAPI URL does not inject", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://serpapi.com/search.json?engine=google_product&product_id=123", urlHost: "serpapi.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "invalid_merchant_url");
});

// ── F. Valid merchant + identity pass ──────────────────────────────────────────

test("valid merchant URL with matching identity injects successfully", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast Model", price: 49.99, source: "eBay", _productId: "123", clickable: false, urlQuality: "google_unresolved" };
  const cachedRec = { _productId: "123", directUrl: "https://www.ebay.com/itm/123456", urlHost: "www.ebay.com", urlQuality: "merchant_direct" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, true);
  assert.equal(result.reason, "identity_passed");
  assert.equal(result.item.directUrl, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.clickable, true);
  assert.equal(result.item.urlQuality, "merchant_direct");
  assert.equal(result.item.link, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.url, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.buyLink, "https://www.ebay.com/itm/123456");
  assert.equal(result.item.urlHost, "www.ebay.com");
});

// ── G. Wrong aircraft family ──────────────────────────────────────────────────

test("rejects when item title says 787 but recovered host says 777", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://777models.com/buy/123", urlHost: "777models.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_host");
});

test("rejects when item title says 787 but recovered host says 747", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://747diecast.com/buy/123", urlHost: "747diecast.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_host");
});

// ── H. Wrong manufacturer ─────────────────────────────────────────────────────

test("rejects when item title says Boeing 787 but recovered host says a380", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://a380models.com/buy/123", urlHost: "a380models.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_host");
});

// ── I. Wrong airline ──────────────────────────────────────────────────────────

test("rejects when item title says Hawaiian but recovered host says ana", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://ana-models.com/buy/123", urlHost: "ana-models.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_host");
});

test("rejects when item title says Hawaiian but recovered host says jal", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://jal-shop.com/buy/123", urlHost: "jal-shop.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_host");
});

test("rejects when query says Hawaiian but recovered host says united", () => {
  const item = { title: "Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://united-models.com/buy/123", urlHost: "united-models.com" };
  const ctx = { ...CTX, query: "hawaiian airlines boeing 787 diecast" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, ctx);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_query");
});

// ── J. Insufficient cached identity evidence ──────────────────────────────────

test("allows injection when host has no identity contradiction signals", () => {
  const item = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://diecaststore.com/buy/123", urlHost: "diecaststore.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, true);
  assert.equal(result.reason, "identity_passed");
});

// ── K. Already verified item ──────────────────────────────────────────────────

test("already verified item is not re-injected", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: true, isVerifiedListing: true, directUrl: "https://www.ebay.com/itm/original" };
  const cachedRec = { _productId: "123", directUrl: "https://www.ebay.com/itm/different", urlHost: "www.ebay.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "already_verified");
  assert.equal(result.item.directUrl, "https://www.ebay.com/itm/original");
});

// ── L. No _productId ──────────────────────────────────────────────────────────

test("item without _productId does not inject even with cached record", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://www.ebay.com/itm/123", urlHost: "www.ebay.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, CTX);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "no_cached_record");
});

// ── M. No isValidMerchantUrl in context ───────────────────────────────────────

test("skips merchant URL validation when isValidMerchantUrl not provided", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://www.ebay.com/itm/123", urlHost: "www.ebay.com" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, { scanId: "t", query: "hawaiian 787" });
  assert.equal(result.inject, true);
  assert.equal(result.reason, "identity_passed");
});

// ── N. Query-level identity contradiction ─────────────────────────────────────

test("rejects when query has identity signal contradicted by host even if item title is generic", () => {
  const item = { title: "Model Airplane", price: 49.99, source: "eBay", _productId: "123", clickable: false };
  const cachedRec = { _productId: "123", directUrl: "https://777models.com/buy/123", urlHost: "777models.com" };
  const ctx = { ...CTX, query: "hawaiian airlines boeing 787 diecast" };
  const result = applyUrlRecoveryCacheRecord(item, cachedRec, ctx);
  assert.equal(result.inject, false);
  assert.equal(result.reason, "identity_contradiction_query");
});
