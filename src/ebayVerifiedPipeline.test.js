import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveListingDirectUrl } from "./serpapiHardening.js";

// Mirrors the isVerifiedListing classification in sanitizeOutboundListingForClient
// (index.js ~24574-24581) without importing index.js (side effects / env deps).
function classifyEvidence(resolved) {
  const { urlQuality, clickable, directUrl } = resolved;
  const isMerchant = urlQuality === "merchant_direct"
    || urlQuality === "merchant_resolved"
    || urlQuality === "google_redirect_unwrapped";
  return (isMerchant && clickable !== false && directUrl)
    ? "verified_listing"
    : "pricing_signal";
}

test("real eBay item URL → merchant_direct → verified_listing", () => {
  const r = resolveListingDirectUrl({ link: "https://www.ebay.com/itm/123456789012" });
  assert.equal(r.urlQuality, "merchant_direct", "urlQuality");
  assert.equal(r.clickable, true, "clickable");
  assert.ok(r.directUrl, "directUrl must be set");
  assert.match(r.directUrl, /ebay\.com\/itm\//, "directUrl is eBay item page");
  assert.equal(classifyEvidence(r), "verified_listing", "classifies as verified_listing");
});

test("null-URL oracle-shaped item → not verified", () => {
  const r = resolveListingDirectUrl({ link: null });
  assert.equal(r.clickable, false, "clickable");
  assert.equal(r.directUrl, null, "directUrl");
  assert.notEqual(classifyEvidence(r), "verified_listing", "must not classify as verified_listing");
});

test("Google Shopping product wrapper URL → google_unresolved → not verified", () => {
  const r = resolveListingDirectUrl({ link: "https://www.google.com/shopping/product/1234567890" });
  assert.equal(r.clickable, false, "clickable");
  assert.equal(r.directUrl, null, "directUrl");
  assert.notEqual(classifyEvidence(r), "verified_listing", "Google wrapper must not classify as verified_listing");
});

test("real Etsy listing URL → merchant_direct → verified_listing", () => {
  const r = resolveListingDirectUrl({ link: "https://www.etsy.com/listing/1234567890/hawaiian-airlines-diecast" });
  assert.equal(r.urlQuality, "merchant_direct", "urlQuality");
  assert.equal(r.clickable, true, "clickable");
  assert.equal(classifyEvidence(r), "verified_listing", "classifies as verified_listing");
});

test("merchant_direct URL survives — directUrl is not a Google host", () => {
  const r = resolveListingDirectUrl({ link: "https://www.ebay.com/itm/987654321098" });
  assert.ok(r.directUrl, "directUrl must be set");
  assert.doesNotMatch(r.directUrl, /google\.|serpapi\./, "directUrl must not be Google or SerpAPI");
});
