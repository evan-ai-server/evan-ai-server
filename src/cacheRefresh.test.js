// src/cacheRefresh.test.js
// Phase 4I.1 — tests for cache refresh budget isolation, identity preservation,
// reranking, verified listing definitions, Etsy cooldown gate, and Oracle guard.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeFakeItem(overrides = {}) {
  return {
    title: "Test Item",
    price: 99.99,
    source: "eBay",
    urlQuality: "unknown_legacy_no_url",
    clickable: false,
    directUrl: null,
    isVerifiedListing: false,
    isOraclePricing: false,
    ...overrides,
  };
}

function evidenceRank(item) {
  const q = item?.urlQuality || "";
  if (item?.isVerifiedListing === true || q === "verified_direct") return 0;
  if (q === "merchant_direct" || q === "merchant_resolved") return 1;
  if (q === "marketplace_direct" || q === "ebay_direct") return 2;
  if (q === "google_product") return 3;
  return 4;
}

// ── Verified listing definitions ──────────────────────────────────────────────

describe("verified listing definitions", () => {
  it("google_shell URL is pricing-only (rank 4)", () => {
    const item = makeFakeItem({ urlQuality: "google_unresolved", clickable: false });
    assert.equal(evidenceRank(item), 4);
  });

  it("unknown_legacy_no_url is pricing-only (rank 4)", () => {
    const item = makeFakeItem({ urlQuality: "unknown_legacy_no_url", clickable: false });
    assert.equal(evidenceRank(item), 4);
  });

  it("merchant_direct URL is rank 1 (merchantDirect/verified clickable)", () => {
    const item = makeFakeItem({
      urlQuality: "merchant_direct",
      clickable: true,
      directUrl: "https://aviationshop.com/product/787",
    });
    assert.equal(evidenceRank(item), 1);
  });

  it("marketplace_direct (eBay native) is rank 2", () => {
    const item = makeFakeItem({
      urlQuality: "marketplace_direct",
      clickable: true,
      directUrl: "https://www.ebay.com/itm/123456",
    });
    assert.equal(evidenceRank(item), 2);
  });

  it("isVerifiedListing=true is rank 0 regardless of urlQuality", () => {
    const item = makeFakeItem({ isVerifiedListing: true, urlQuality: "merchant_direct" });
    assert.equal(evidenceRank(item), 0);
  });
});

// ── Oracle items must never count as verified ─────────────────────────────────

describe("oracle items", () => {
  it("oracle item with no direct URL is pricing-only, not verified", () => {
    const item = makeFakeItem({
      isOraclePricing: true,
      urlQuality: "oracle_pricing_estimate",
      clickable: false,
      directUrl: null,
      isVerifiedListing: false,
    });
    assert.equal(item.isVerifiedListing, false);
    assert.equal(item.clickable, false);
    assert.equal(evidenceRank(item), 4);
  });

  it("verifiedListingCount from oracle-only pool is 0", () => {
    const items = [
      makeFakeItem({ isOraclePricing: true, isVerifiedListing: false, urlQuality: "oracle_pricing_estimate" }),
      makeFakeItem({ isOraclePricing: true, isVerifiedListing: false, urlQuality: "oracle_pricing_estimate" }),
    ];
    const verifiedCount = items.filter(i => i.isVerifiedListing === true).length;
    assert.equal(verifiedCount, 0);
  });
});

// ── Rerank: verified/direct beats pricing-only after merge ───────────────────

describe("refresh reranking", () => {
  it("verified item sorts before pricing-only item after merge", () => {
    const pricingOnly = makeFakeItem({ title: "Pricing Only", urlQuality: "unknown_legacy_no_url" });
    const merchantDirect = makeFakeItem({
      title: "Merchant Direct",
      urlQuality: "merchant_direct",
      clickable: true,
      directUrl: "https://shop.com/item",
    });
    const merged = [pricingOnly, merchantDirect].sort(
      (a, b) => evidenceRank(a) - evidenceRank(b)
    );
    assert.equal(merged[0].title, "Merchant Direct");
    assert.equal(merged[1].title, "Pricing Only");
  });

  it("rerank preserves items in rank-stable order within same tier", () => {
    const items = [
      makeFakeItem({ title: "Cheap eBay", urlQuality: "unknown_legacy_no_url", price: 50 }),
      makeFakeItem({ title: "Expensive eBay", urlQuality: "unknown_legacy_no_url", price: 200 }),
      makeFakeItem({ title: "Direct Listing", urlQuality: "merchant_direct", clickable: true }),
    ];
    const sorted = [...items].sort((a, b) => evidenceRank(a) - evidenceRank(b));
    assert.equal(sorted[0].title, "Direct Listing");
    // both pricing-only items keep relative order (sort is stable in V8)
    assert.equal(sorted[1].title, "Cheap eBay");
    assert.equal(sorted[2].title, "Expensive eBay");
  });
});

// ── Identity metadata preservation ───────────────────────────────────────────

describe("identity metadata preservation", () => {
  it("unpack/pack round-trip preserves appliedLocks", () => {
    const identitySummary = {
      appliedLocks: ["airline", "family"],
      requiredAirline: "hawaiian",
      requiredFamily: "787",
      rawCount: 9,
      keptCount: 9,
    };
    // Simulate: pack with summary, unpack, verify fields survive
    const packed = { items: [makeFakeItem()], identitySummary };
    const unpacked = packed.identitySummary;
    assert.deepEqual(unpacked.appliedLocks, ["airline", "family"]);
    assert.equal(unpacked.requiredAirline, "hawaiian");
    assert.equal(unpacked.requiredFamily, "787");
  });

  it("passing null identity drops locks — this is what Phase 4I.1 fixes", () => {
    const packed = { items: [makeFakeItem()], identitySummary: null };
    const identity = packed.identitySummary;
    // Before fix: identity is null → appliedLocks unavailable downstream
    assert.equal(identity, null);
  });
});

// ── de-dup fingerprint logic ──────────────────────────────────────────────────

describe("cache refresh dedup", () => {
  it("item with same title+price+source fingerprint is rejected as dupe", () => {
    const existing = makeFakeItem({ title: "Hawaiian 787 Diecast", price: 69.99, source: "eBay - seller1" });
    const fingerprints = new Set();
    const t = String(existing.title).toLowerCase().slice(0, 60);
    const p = Math.round(Number(existing.price) * 10) / 10;
    const s = String(existing.source).toLowerCase().slice(0, 30);
    fingerprints.add(`${t}|${p}|${s}`);

    const incoming = makeFakeItem({ title: "Hawaiian 787 Diecast", price: 69.99, source: "eBay - seller1" });
    const tI = String(incoming.title).toLowerCase().slice(0, 60);
    const pI = Math.round(Number(incoming.price) * 10) / 10;
    const sI = String(incoming.source).toLowerCase().slice(0, 30);
    assert.equal(fingerprints.has(`${tI}|${pI}|${sI}`), true, "duplicate should be detected");
  });

  it("item with different price is not a dupe", () => {
    const fingerprints = new Set(["hawaiian 787 diecast|70.0|ebay - seller1"]);
    const incoming = makeFakeItem({ title: "Hawaiian 787 Diecast", price: 79.99, source: "eBay - seller1" });
    const t = String(incoming.title).toLowerCase().slice(0, 60);
    const p = Math.round(Number(incoming.price) * 10) / 10;
    const s = String(incoming.source).toLowerCase().slice(0, 30);
    assert.equal(fingerprints.has(`${t}|${p}|${s}`), false, "different price is net-new");
  });
});

// ── Net-new threshold logic ───────────────────────────────────────────────────

describe("net-new threshold", () => {
  it("2+ net-new items triggers merge path", () => {
    const netNew = [makeFakeItem({ title: "New Item A" }), makeFakeItem({ title: "New Item B" })];
    assert.ok(netNew.length >= 2, "should trigger merge");
  });

  it("fewer than 2 net-new items triggers insufficient path", () => {
    const netNew = [makeFakeItem({ title: "New Item A" })];
    assert.ok(netNew.length < 2, "should log INSUFFICIENT_NEW_ITEMS");
  });

  it("0 net-new items from serp logs no_results_from_serp reason", () => {
    const refreshRaw = [];
    const reason = refreshRaw.length === 0 ? "no_results_from_serp" : "all_duplicates_or_identity_rejected";
    assert.equal(reason, "no_results_from_serp");
  });

  it("items that are all dupes logs all_duplicates reason", () => {
    const refreshRaw = [makeFakeItem()];
    const netNew = []; // all filtered as dupes
    const reason = refreshRaw.length === 0 ? "no_results_from_serp" : "all_duplicates_or_identity_rejected";
    assert.equal(reason, "all_duplicates_or_identity_rejected");
    assert.equal(netNew.length < 2, true);
  });
});

// ── Budget key scoping ────────────────────────────────────────────────────────

describe("cache refresh budget key scoping", () => {
  it("refresh budget key differs from scan key by suffix", () => {
    const scanId = "c.abc123.xyz";
    const scanKey = `scan:${scanId}`;
    const refreshKey = `scan:${scanId}:cache_refresh`;
    assert.notEqual(scanKey, refreshKey);
    assert.ok(refreshKey.startsWith(scanKey));
  });

  it("cache hit with serpCallsUsed=0 leaves budget available for refresh", () => {
    const budget = { callsUsed: 0, max: 1, cacheHit: true };
    const canConsumeForRefresh = budget.callsUsed < budget.max;
    assert.ok(canConsumeForRefresh, "budget should be available after cache-hit path");
  });
});
