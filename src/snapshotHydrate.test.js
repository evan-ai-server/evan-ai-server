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

test("stale snapshot note no longer blames snapshot write", () => {
  assert.ok(
    !INDEX_SRC.includes("recovery fields absent here were dropped at snapshot write"),
    "old misleading note must be updated"
  );
});
