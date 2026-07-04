import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEbayBrowseEvidenceFields } from "./ebayBrowseMapper.js";

// Canned eBay Browse API ItemSummary — shape per eBay Buy Browse API docs.
const CANNED_ITEM = {
  itemId: "v1|123456789012|0",
  legacyItemId: "123456789012",
  title: "Hawaiian Airlines Boeing 787-9 1:400 Diecast",
  itemWebUrl: "https://www.ebay.com/itm/123456789012",
  itemAffiliateWebUrl: "https://www.ebay.com/itm/123456789012?epn=abc123",
  price: { value: "79.99", currency: "USD" },
  shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
  condition: "Pre-owned",
  conditionId: "3000",
  buyingOptions: ["FIXED_PRICE"],
  estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
  itemLocation: { country: "US", postalCode: "941**" },
  seller: {
    username: "resell_pro",
    feedbackPercentage: "99.6",
    feedbackScore: 4120,
  },
  image: { imageUrl: "https://i.ebayimg.com/thumb.jpg" },
};

test("maps itemId, legacyItemId, canonicalUrl (prefers itemWebUrl)", () => {
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM);
  assert.equal(result.itemId, "v1|123456789012|0");
  assert.equal(result.legacyItemId, "123456789012");
  assert.equal(result.canonicalUrl, "https://www.ebay.com/itm/123456789012");
});

test("canonicalUrl derives from legacyItemId when itemWebUrl is missing", () => {
  const it = { ...CANNED_ITEM, itemWebUrl: undefined };
  const result = extractEbayBrowseEvidenceFields(it);
  assert.equal(result.canonicalUrl, "https://www.ebay.com/itm/123456789012");
});

test("canonicalUrl is null when both itemWebUrl and legacyItemId are missing", () => {
  const it = { ...CANNED_ITEM, itemWebUrl: undefined, legacyItemId: undefined };
  const result = extractEbayBrowseEvidenceFields(it);
  assert.equal(result.canonicalUrl, null);
});

test("maps seller sub-fields with numeric coercion", () => {
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM);
  assert.deepEqual(result.seller, {
    username: "resell_pro",
    feedbackPercentage: 99.6,
    feedbackScore: 4120,
  });
});

test("seller is null when absent on the raw item", () => {
  const it = { ...CANNED_ITEM, seller: undefined };
  const result = extractEbayBrowseEvidenceFields(it);
  assert.equal(result.seller, null);
});

test("maps availability, conditionId, buyingOptions, itemLocation", () => {
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM);
  assert.equal(result.availability, "IN_STOCK");
  assert.equal(result.conditionId, "3000");
  assert.deepEqual(result.buyingOptions, ["FIXED_PRICE"]);
  assert.deepEqual(result.itemLocation, { country: "US", postalCode: "941**" });
});

test("availability is null when estimatedAvailabilities is absent (summary-level responses often omit it)", () => {
  const it = { ...CANNED_ITEM, estimatedAvailabilities: undefined };
  const result = extractEbayBrowseEvidenceFields(it);
  assert.equal(result.availability, null);
});

test("affiliateUrl reads itemAffiliateWebUrl, separate from canonicalUrl", () => {
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM);
  assert.equal(result.affiliateUrl, "https://www.ebay.com/itm/123456789012?epn=abc123");
  assert.equal(result.canonicalUrl, "https://www.ebay.com/itm/123456789012");
});

test("provider and marketplace are fixed constants", () => {
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM);
  assert.equal(result.provider, "ebay_browse");
  assert.equal(result.marketplace, "ebay");
});

test("fetchedAt is controllable via the now option for deterministic tests", () => {
  const fixedNow = 1700000000000;
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM, { now: fixedNow });
  assert.equal(result.fetchedAt, fixedNow);
});

test("fetchedAt defaults to the real current time when now is omitted", () => {
  const before = Date.now();
  const result = extractEbayBrowseEvidenceFields(CANNED_ITEM);
  const after = Date.now();
  assert.ok(result.fetchedAt >= before && result.fetchedAt <= after);
});

test("missing/empty item does not throw and returns safe defaults", () => {
  const result = extractEbayBrowseEvidenceFields();
  assert.equal(result.itemId, null);
  assert.equal(result.legacyItemId, null);
  assert.equal(result.canonicalUrl, null);
  assert.equal(result.affiliateUrl, null);
  assert.equal(result.seller, null);
  assert.equal(result.conditionId, null);
  assert.equal(result.availability, null);
  assert.equal(result.buyingOptions, null);
  assert.equal(result.itemLocation, null);
  assert.equal(result.provider, "ebay_browse");
  assert.equal(result.marketplace, "ebay");
});
