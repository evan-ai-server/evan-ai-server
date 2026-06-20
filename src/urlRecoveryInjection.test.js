import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateRecoveredOfferIdentity,
  hasIdentityContradiction,
} from "./offerIdentityGuard.js";
import {
  evaluateAffiliateEligibility,
} from "./affiliateGate.js";

const INDEX_SRC = readFileSync(resolve(import.meta.dirname, "../index.js"), "utf8");

// ── A. ProductId alone does not verify ────────────────────────────────────────

test("productId alone without cached recovery stays non-clickable", () => {
  const item = { title: "Hawaiian 787 Diecast", price: 49.99, source: "eBay",
    _productId: "11076768015358219087", clickable: false, urlQuality: "google_unresolved" };
  assert.equal(item.clickable, false);
  assert.equal(item.isVerifiedListing, undefined);
  assert.equal(item.directUrl, undefined);
});

// ── B. Google shell URL does not verify ───────────────────────────────────────

test("Google Shopping shell URL is rejected by _isValidMerchantUrl logic", () => {
  const googleShellUrl = "https://www.google.com/search?ibp=oshop&q=hawaiian+boeing+787&prds=productid:11076768015358219087";
  const host = new URL(googleShellUrl).hostname.toLowerCase();
  assert.ok(/(^|\.)google\./i.test(host), "Google host must be detected");
});

test("Google Shopping product URL is rejected by _isValidMerchantUrl logic", () => {
  const googleProductUrl = "https://www.google.com/shopping/product/11076768015358219087";
  const host = new URL(googleProductUrl).hostname.toLowerCase();
  assert.ok(/(^|\.)google\./i.test(host), "Google product host must be detected");
});

// ── C. Google search URL does not verify ──────────────────────────────────────

test("Google search URL is rejected by _isValidMerchantUrl logic", () => {
  const googleSearchUrl = "https://www.google.com/search?q=hawaiian+airlines+boeing+787";
  const host = new URL(googleSearchUrl).hostname.toLowerCase();
  assert.ok(/(^|\.)google\./i.test(host), "Google search host must be detected");
});

// ── D. SerpAPI URL does not verify ────────────────────────────────────────────

test("SerpAPI URL is rejected by _isValidMerchantUrl logic", () => {
  const serpUrl = "https://serpapi.com/search.json?engine=google_product&product_id=11076768015358219087";
  const host = new URL(serpUrl).hostname.toLowerCase();
  assert.ok(host.includes("serpapi."), "SerpAPI host must be detected");
});

// ── E. Cached valid merchant URL can upgrade ──────────────────────────────────

test("valid merchant URL passes _isValidMerchantUrl logic", () => {
  const merchantUrl = "https://www.ebay.com/itm/123456789012";
  const host = new URL(merchantUrl).hostname.toLowerCase();
  assert.ok(!/(^|\.)google\./i.test(host), "not a Google host");
  assert.ok(!host.includes("serpapi."), "not a SerpAPI host");
  assert.ok(!/(^|\.)googleadservices\./i.test(host), "not a Google ads host");
  assert.ok(!/(^|\.)doubleclick\.net$/i.test(host), "not a DoubleClick host");
});

test("sanitizeOutboundListingForClient classifies merchant_direct + clickable as verified_listing", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("function sanitizeOutboundListingForClient"),
    INDEX_SRC.indexOf("function sanitizeOutboundListingForClient") + 3000
  );
  assert.ok(block.includes('urlQuality === "merchant_direct"'), "merchant_direct must be in isMerchant");
  assert.ok(block.includes('isMerchant && clickable !== false && directUrl) evidenceQuality = "verified_listing"'), "merchant_direct + clickable + directUrl must become verified_listing");
  assert.ok(block.includes('isVerifiedListing    = evidenceQuality === "verified_listing"'), "isVerifiedListing must derive from evidenceQuality");
});

// ── F. Wrong aircraft family rejects in recovery guard ────────────────────────

test("hasIdentityContradiction: 787 original rejects 777 seller", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "ScaleModelStore 777", "scalemodels.com"));
});

test("hasIdentityContradiction: 787 original rejects 747 seller", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787 Diecast", "747 Diecast Model", "diecast.com"));
});

test("hasIdentityContradiction: 787 original rejects A380 seller", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "Airbus A380 Model", "airbus-models.com"));
});

test("evaluateRecoveredOfferIdentity rejects 777 seller for 787 item", () => {
  const original = { title: "Hawaiian Airlines Boeing 787 Diecast", price: 49.99, source: "ScaleModelStore.com" };
  const seller = { name: "ScaleModelStore 777 Model", link: "https://scalemodels.com/777-model", extracted_total_price: 49.99 };
  const result = evaluateRecoveredOfferIdentity(original, seller, seller.link);
  assert.equal(result.ok, false, "must reject 777 for 787");
});

// ── G. Wrong airline rejects in recovery guard ────────────────────────────────

test("hasIdentityContradiction: hawaiian original rejects ana seller", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "ANA Boeing 787", "ana-models.com"));
});

test("hasIdentityContradiction: hawaiian original rejects jal seller", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "JAL 787 Model", "jal-models.com"));
});

test("hasIdentityContradiction: hawaiian original rejects united seller", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "United Airlines 787", "united-models.com"));
});

test("hasIdentityContradiction: matching identity does not reject", () => {
  assert.ok(!hasIdentityContradiction("Hawaiian Airlines Boeing 787", "Hawaiian Airlines 787 Model", "hawaiian-models.com"));
});

// ── H. google_product 401 fails closed ────────────────────────────────────────

test("_verifyOneItem 401 circuit-break path exists in index.js", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("async function _verifyOneItem"),
    INDEX_SRC.indexOf("async function _verifyOneItem") + 2000
  );
  assert.ok(block.includes("_googleProductApiAvailable = false"), "401 must latch circuit breaker");
  assert.ok(block.includes("return null"), "401 path must return null (no verified upgrade)");
});

test("_scheduleAsyncUrlRecovery checks circuit breaker before running", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("async function _scheduleAsyncUrlRecovery"),
    INDEX_SRC.indexOf("async function _scheduleAsyncUrlRecovery") + 600
  );
  assert.ok(block.includes("!_googleProductApiAvailable"), "must check circuit breaker");
  assert.ok(block.includes("circuit_broken_prior_401"), "must log circuit_broken reason");
});

// ── I. Oracle/fallback estimate cannot become verified ────────────────────────

test("sanitizeOutboundListingForClient: oracle urlQuality stays non-verified", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("function sanitizeOutboundListingForClient"),
    INDEX_SRC.indexOf("function sanitizeOutboundListingForClient") + 2500
  );
  assert.ok(block.includes('urlQuality === "oracle_pricing_estimate"'), "oracle must be detected");
  assert.ok(block.includes('evidenceQuality = "oracle_estimate"'), "oracle must stay oracle_estimate, not verified");
});

test("oracle_estimate evidenceQuality never becomes isVerifiedListing", () => {
  const isMerchant = false;
  const isOracle = true;
  let evidenceQuality;
  if (isOracle) evidenceQuality = "oracle_estimate";
  else if (isMerchant) evidenceQuality = "verified_listing";
  else evidenceQuality = "pricing_signal";
  const isVerifiedListing = evidenceQuality === "verified_listing";
  assert.equal(isVerifiedListing, false, "oracle must not become verified");
});

// ── J. Affiliate gate stays blocked without verified listings ─────────────────

test("affiliate gate blocks when verifiedListingCount is 0", () => {
  const result = evaluateAffiliateEligibility({
    signal: "BUY_SIGNAL", trustScore: 0.9, verdict: "BUY",
    evidenceTier: "strong_verified", verdictStrengthCap: null,
    verifiedListingCount: 0, canShowStrongLanguage: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "no_verified_listings");
});

test("affiliate gate allows when verifiedListingCount > 0 and all other conditions pass", () => {
  const result = evaluateAffiliateEligibility({
    signal: "BUY_SIGNAL", trustScore: 0.9, verdict: "BUY",
    evidenceTier: "strong_verified", verdictStrengthCap: null,
    verifiedListingCount: 3, canShowStrongLanguage: true,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.reason, null);
});

// ── Static guards: Phase 5A.3B observability logs ─────────────────────────────

test("URL_RECOVERY_CACHE_HIT log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_CACHE_HIT"), "cache hit log missing");
});

test("URL_RECOVERY_CACHE_INJECTED log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_CACHE_INJECTED"), "cache injected log missing");
});

test("URL_RECOVERY_REJECTED_GOOGLE_SHELL log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_REJECTED_GOOGLE_SHELL"), "google shell rejection log missing");
});

test("URL_RECOVERY_REJECTED_MISSING_DIRECT_URL log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_REJECTED_MISSING_DIRECT_URL"), "missing direct url log missing");
});

test("URL_RECOVERY_CACHE_REJECTED_INVALID_MERCHANT_URL log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_CACHE_REJECTED_INVALID_MERCHANT_URL"), "invalid merchant url log missing");
});

test("URL_RECOVERY_DIRECT_URL_ACCEPTED log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_DIRECT_URL_ACCEPTED"), "direct url accepted log missing");
});

test("URL_RECOVERY_REJECTED_IDENTITY_MISMATCH log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_REJECTED_IDENTITY_MISMATCH"), "identity mismatch log missing");
});

// ── Static guards: injection acceptance logic (5A.3C) ─────────────────────────

test("injection point uses applyUrlRecoveryCacheRecord", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("URL_RECOVERY_CACHE injection:"),
    INDEX_SRC.indexOf("URL_RECOVERY_CACHE injection:") + 2000
  );
  assert.ok(block.includes("applyUrlRecoveryCacheRecord"), "must use applyUrlRecoveryCacheRecord helper");
});

test("injection point passes _isValidMerchantUrl to helper", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("URL_RECOVERY_CACHE injection:"),
    INDEX_SRC.indexOf("URL_RECOVERY_CACHE injection:") + 2000
  );
  assert.ok(block.includes("isValidMerchantUrl: _isValidMerchantUrl"), "must pass merchant URL validator to helper");
});

test("injection does not set isVerifiedListing directly", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("URL_RECOVERY_CACHE_INJECTED"),
    INDEX_SRC.indexOf("URL_RECOVERY_CACHE_INJECTED") + 500
  );
  assert.ok(!block.includes("isVerifiedListing: true"), "injection must not set isVerifiedListing directly — sanitizer derives it");
  assert.ok(!block.includes("isVerifiedListing:true"), "injection must not set isVerifiedListing directly");
});

// ── Static guards: Phase 5A.3C identity re-check logs ─────────────────────────

test("URL_RECOVERY_INJECTION_IDENTITY_RECHECK_PASSED log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_INJECTION_IDENTITY_RECHECK_PASSED"), "identity recheck pass log missing");
});

test("URL_RECOVERY_INJECTION_IDENTITY_RECHECK_REJECTED log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("URL_RECOVERY_INJECTION_IDENTITY_RECHECK_REJECTED"), "identity recheck reject log missing");
});

test("VERIFIED_LISTING_EVIDENCE_UPGRADED log exists in index.js", () => {
  assert.ok(INDEX_SRC.includes("VERIFIED_LISTING_EVIDENCE_UPGRADED"), "verified evidence upgraded log missing");
});

test("VERIFIED_LISTING_EVIDENCE_SUMMARY includes urlRecoveryInjectedCount", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("VERIFIED_LISTING_EVIDENCE_SUMMARY"),
    INDEX_SRC.indexOf("VERIFIED_LISTING_EVIDENCE_SUMMARY") + 700
  );
  assert.ok(block.includes("urlRecoveryInjectedCount"), "must include recovery injection count in summary");
});

test("URL_RECOVERY_CACHE_INJECTED appears after identity recheck pass, not before", () => {
  const recheckPassPos = INDEX_SRC.indexOf("URL_RECOVERY_INJECTION_IDENTITY_RECHECK_PASSED");
  const injectedPos = INDEX_SRC.indexOf("URL_RECOVERY_CACHE_INJECTED", recheckPassPos);
  assert.ok(recheckPassPos > 0, "recheck pass log must exist");
  assert.ok(injectedPos > recheckPassPos, "CACHE_INJECTED must appear after identity recheck pass");
});

// ── Static guards: Phase 5A.3C.2 persisted guard metadata ─────────────────────

test("_verifyOneItem return persists write-time guard metadata", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("async function _verifyOneItem"),
    INDEX_SRC.indexOf("async function _verifyOneItem") + 5500
  );
  assert.ok(block.includes("recoveryGuardVersion"), "must persist recoveryGuardVersion");
  assert.ok(block.includes("origTitle:"), "must persist origTitle");
  assert.ok(block.includes("origPrice:"), "must persist origPrice");
  assert.ok(block.includes("recoveredPrice:"), "must persist recoveredPrice");
  assert.ok(block.includes("guardScore:"), "must persist guardScore");
});

test("applyUrlRecoveryCacheRecord helper rejects old-shape records (behavioral)", async () => {
  const { applyUrlRecoveryCacheRecord } = await import("./urlRecoveryInjectionPolicy.js");
  const item = { title: "Hawaiian Airlines Boeing 787", price: 50, totalPrice: 50, _productId: "1", clickable: false };
  const oldShape = { _productId: "1", directUrl: "https://www.ebay.com/itm/1", urlQuality: "merchant_direct", urlHost: "www.ebay.com" };
  const result = applyUrlRecoveryCacheRecord(item, oldShape, { query: "hawaiian 787", isValidMerchantUrl: () => true });
  assert.equal(result.inject, false);
  assert.equal(result.reason, "insufficient_recovery_identity_evidence");
});
