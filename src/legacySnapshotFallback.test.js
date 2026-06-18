import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldAttemptLegacySnapshot,
  sanitizeLegacySnapshotItems,
  LEGACY_SNAPSHOT_MIN_CLEAN,
} from "./legacySnapshotFallback.js";

// ── shouldAttemptLegacySnapshot ─────────────────────────────────────────────

test("legacy fallback: current-version hit → no attempt", () => {
  const r = shouldAttemptLegacySnapshot({
    serpCooling: true, ebayAvail: false,
    currentVersionHit: true, hasOldSnapshot: true,
  });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "current_version_available");
});

test("legacy fallback: primary source available → no attempt", () => {
  const r = shouldAttemptLegacySnapshot({
    serpCooling: false, ebayAvail: false,
    currentVersionHit: false, hasOldSnapshot: true,
  });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "primary_source_available");
});

test("legacy fallback: eBay available → no attempt (primary ok)", () => {
  const r = shouldAttemptLegacySnapshot({
    serpCooling: true, ebayAvail: true,
    currentVersionHit: false, hasOldSnapshot: true,
  });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "primary_source_available");
});

test("legacy fallback: no old snapshot → no attempt", () => {
  const r = shouldAttemptLegacySnapshot({
    serpCooling: true, ebayAvail: false,
    currentVersionHit: false, hasOldSnapshot: false,
  });
  assert.equal(r.attempt, false);
  assert.equal(r.reason, "no_old_snapshot");
});

test("legacy fallback: all conditions met → attempt", () => {
  const r = shouldAttemptLegacySnapshot({
    serpCooling: true, ebayAvail: false,
    currentVersionHit: false, hasOldSnapshot: true,
  });
  assert.equal(r.attempt, true);
  assert.equal(r.reason, "source_unavailable_legacy_fallback");
});

// ── sanitizeLegacySnapshotItems ─────────────────────────────────────────────

test("legacy sanitize: strips verified/clickable/directUrl", () => {
  const items = sanitizeLegacySnapshotItems([{
    title: "Hawaiian Airlines Boeing 787-9 1:400 Diecast",
    source: "SerpAPI",
    totalPrice: 42.99,
    clickable: true,
    directUrl: "https://example.com/buy",
    isVerifiedListing: true,
    _productId: "12345",
    _serpapiProductApiUrl: "https://serpapi.com/google_product/12345",
    urlQuality: "merchant_direct",
    evidenceQuality: "verified_merchant",
    image: "https://img.example.com/787.jpg",
    rating: 4.5,
    reviews: 12,
  }]);
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.clickable, false);
  assert.equal(it.directUrl, null);
  assert.equal(it.isVerifiedListing, false);
  assert.equal(it._productId, null);
  assert.equal(it._serpapiProductApiUrl, null);
  assert.equal(it.urlQuality, null);
  assert.equal(it.evidenceQuality, "legacy_snapshot_pricing_only");
  assert.equal(it.url, null);
  assert.equal(it.link, null);
  assert.equal(it.buyLink, null);
  assert.equal(it.trustModelScore, 0);
  assert.equal(it.__trustScore, 0);
  // Preserved fields
  assert.equal(it.title, "Hawaiian Airlines Boeing 787-9 1:400 Diecast");
  assert.equal(it.price, 42.99);
  assert.equal(it.image, "https://img.example.com/787.jpg");
});

test("legacy sanitize: filters out items without price", () => {
  const items = sanitizeLegacySnapshotItems([
    { title: "Good Item", totalPrice: 25 },
    { title: "No Price Item", totalPrice: 0 },
    { title: "Null Price Item" },
    { title: null, totalPrice: 10 },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Good Item");
});

test("legacy sanitize: does not unlock affiliate via links", () => {
  const items = sanitizeLegacySnapshotItems([{
    title: "Test Item",
    totalPrice: 30,
    url: "https://affiliate.example.com/track?id=123",
    link: "https://store.example.com/item",
    buyLink: "https://buy.example.com/checkout",
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, null);
  assert.equal(items[0].link, null);
  assert.equal(items[0].buyLink, null);
});

test("LEGACY_SNAPSHOT_MIN_CLEAN is at least 6", () => {
  assert.ok(LEGACY_SNAPSHOT_MIN_CLEAN >= 6);
});

// ── V3.10B.2: SLA-exhausted stream path uses legacy fallback ─────────────────

test("V3.10B.2 — SLA-exhausted legacy decision: serpapi cooling + no ebay + no current version → attempt", () => {
  const r = shouldAttemptLegacySnapshot({
    serpCooling: true, ebayAvail: false,
    currentVersionHit: false, hasOldSnapshot: true,
  });
  assert.equal(r.attempt, true);
  assert.equal(r.reason, "source_unavailable_legacy_fallback");
});

test("V3.10B.2 — SLA-exhausted legacy sanitize: output is pricing-only, no cache pollution fields", () => {
  const items = sanitizeLegacySnapshotItems([
    { title: "Hawaiian Airlines Boeing 787 1:400 Diecast", totalPrice: 55, source: "SerpAPI",
      clickable: true, directUrl: "https://example.com", isVerifiedListing: true,
      _productId: "abc", _serpapiProductApiUrl: "https://serpapi.com/p/abc",
      urlQuality: "merchant_direct", evidenceQuality: "verified_merchant" },
    { title: "Hawaiian Airlines Boeing 787 Gemini Diecast", totalPrice: 62, source: "SerpAPI",
      clickable: true, directUrl: "https://example2.com", isVerifiedListing: true },
  ]);
  assert.equal(items.length, 2);
  for (const it of items) {
    assert.equal(it.clickable, false, "must not be clickable");
    assert.equal(it.directUrl, null, "must strip directUrl");
    assert.equal(it.isVerifiedListing, false, "must not be verified");
    assert.equal(it._productId, null, "must strip _productId");
    assert.equal(it.evidenceQuality, "legacy_snapshot_pricing_only");
  }
});

test("V3.10B.2 — legacy items below LEGACY_SNAPSHOT_MIN_CLEAN are rejected", () => {
  const tooFew = Array.from({ length: LEGACY_SNAPSHOT_MIN_CLEAN - 1 }, (_, i) => ({
    title: `Item ${i}`, totalPrice: 30 + i, source: "SerpAPI",
  }));
  const sanitized = sanitizeLegacySnapshotItems(tooFew);
  assert.equal(sanitized.length, LEGACY_SNAPSHOT_MIN_CLEAN - 1);
  assert.ok(sanitized.length < LEGACY_SNAPSHOT_MIN_CLEAN, "below min clean → caller must reject");
});
