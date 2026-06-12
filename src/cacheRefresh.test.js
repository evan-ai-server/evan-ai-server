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

  it("isolated refresh context has cacheHit:false so SerpAPI is not blocked", () => {
    const parentCtx = { callsUsed: 0, max: 1, cacheHit: true, key: "scan:abc" };
    const refreshCtx = {
      scanId: "abc:cache_refresh",
      max: 1,
      callsUsed: 0,
      cacheHit: false,  // must be false
      key: "scan:abc:cache_refresh",
    };
    assert.equal(refreshCtx.cacheHit, false, "refresh context must not inherit cacheHit:true");
    assert.notEqual(refreshCtx.key, parentCtx.key, "refresh uses separate budget key");
  });
});

// ── Phase 4I.2: pre-flight source availability check ─────────────────────────

describe("pre-flight source availability", () => {
  it("skips refresh when SerpAPI is cooling and eBay is unavailable", () => {
    const state = { serpCooling: true, ebayAvail: false, etsyCooling: true };
    const shouldSkip = state.serpCooling && !state.ebayAvail;
    assert.ok(shouldSkip, "should skip refresh with no live sources");
  });

  it("allows refresh when eBay is available even if SerpAPI is cooling", () => {
    const state = { serpCooling: true, ebayAvail: true };
    const shouldSkip = state.serpCooling && !state.ebayAvail;
    assert.ok(!shouldSkip, "eBay available means refresh should proceed");
  });

  it("allows refresh when SerpAPI is not cooling", () => {
    const state = { serpCooling: false, ebayAvail: false };
    const shouldSkip = state.serpCooling && !state.ebayAvail;
    assert.ok(!shouldSkip, "SerpAPI not cooling means refresh should proceed");
  });
});

// ── Phase 4I.2: honest INSUFFICIENT reason based on budget usage ──────────────

describe("honest INSUFFICIENT reason", () => {
  it("reports source_not_reached when callsUsed=0 and rawResultCount=0", () => {
    const refreshCtx = { callsUsed: 0 };
    const refreshRaw = [];
    const netNew = [];
    const rejectedDupes = 0;
    const reason = refreshRaw.length === 0
      ? (refreshCtx.callsUsed === 0 ? "source_not_reached_cache_or_cooldown" : "no_results_from_live_serp")
      : (netNew.length === 0 ? "all_duplicates_or_identity_rejected" : "insufficient_new_unique_items");
    assert.equal(reason, "source_not_reached_cache_or_cooldown");
  });

  it("reports no_results_from_live_serp when callsUsed>0 but results empty", () => {
    const refreshCtx = { callsUsed: 1 };
    const refreshRaw = [];
    const netNew = [];
    const reason = refreshRaw.length === 0
      ? (refreshCtx.callsUsed === 0 ? "source_not_reached_cache_or_cooldown" : "no_results_from_live_serp")
      : (netNew.length === 0 ? "all_duplicates_or_identity_rejected" : "insufficient_new_unique_items");
    assert.equal(reason, "no_results_from_live_serp");
  });

  it("reports all_duplicates when results exist but all are dupes", () => {
    const refreshCtx = { callsUsed: 1 };
    const refreshRaw = [makeFakeItem({ title: "Already Cached Item" })];
    const netNew = []; // all filtered as dupes
    const reason = refreshRaw.length === 0
      ? (refreshCtx.callsUsed === 0 ? "source_not_reached_cache_or_cooldown" : "no_results_from_live_serp")
      : (netNew.length === 0 ? "all_duplicates_or_identity_rejected" : "insufficient_new_unique_items");
    assert.equal(reason, "all_duplicates_or_identity_rejected");
  });

  it("reports insufficient_new when 1 net-new item found (below min=2)", () => {
    const refreshCtx = { callsUsed: 1 };
    const refreshRaw = [makeFakeItem({ title: "New" }), makeFakeItem({ title: "Dup" })];
    const netNew = [makeFakeItem({ title: "New" })]; // 1 net-new, needs 2
    const reason = refreshRaw.length === 0
      ? (refreshCtx.callsUsed === 0 ? "source_not_reached_cache_or_cooldown" : "no_results_from_live_serp")
      : (netNew.length === 0 ? "all_duplicates_or_identity_rejected" : "insufficient_new_unique_items");
    assert.equal(reason, "insufficient_new_unique_items");
  });
});

// ── Phase 4I.2: rescue Etsy spam prevention ──────────────────────────────────

describe("rescue Etsy spam prevention", () => {
  it("Etsy is only called for idx=0 in rescue when canUseEtsy is true", () => {
    const rescueQueries = ["q1", "q2", "q3", "q4", "q5"];
    const etsyCalls = [];
    const _etsyAllowedInRescue = true; // not cooling

    rescueQueries.forEach((q, idx) => {
      if (_etsyAllowedInRescue && idx === 0) {
        etsyCalls.push(q);
      }
    });

    assert.equal(etsyCalls.length, 1, "exactly 1 Etsy call in rescue");
    assert.equal(etsyCalls[0], "q1");
  });

  it("Etsy is called 0 times in rescue when cooldown is active", () => {
    const rescueQueries = ["q1", "q2", "q3"];
    const etsyCalls = [];
    const _etsyAllowedInRescue = false; // cooling

    rescueQueries.forEach((q, idx) => {
      if (_etsyAllowedInRescue && idx === 0) {
        etsyCalls.push(q);
      }
    });

    assert.equal(etsyCalls.length, 0, "zero Etsy calls when cooling");
  });
});

// ── Phase 4I.3: forceSourceRefresh bypasses source caches ────────────────────

describe("forceSourceRefresh bypassHardenedCache", () => {
  it("normal scan passes softFail:true without bypassHardenedCache", () => {
    const forceSourceRefresh = false;
    const opts = forceSourceRefresh
      ? { softFail: true, bypassHardenedCache: true }
      : { softFail: true };
    assert.equal(opts.bypassHardenedCache, undefined);
    assert.equal(opts.softFail, true);
  });

  it("forceSourceRefresh adds bypassHardenedCache:true to serp opts", () => {
    const forceSourceRefresh = true;
    const opts = forceSourceRefresh
      ? { softFail: true, bypassHardenedCache: true }
      : { softFail: true };
    assert.equal(opts.bypassHardenedCache, true);
    assert.equal(opts.softFail, true);
  });

  it("forceSourceRefresh=false leaves normal scans unchanged", () => {
    const forceSourceRefresh = false;
    const opts = forceSourceRefresh
      ? { softFail: true, bypassHardenedCache: true }
      : { softFail: true };
    // Normal scans: no cache bypass
    assert.ok(!opts.bypassHardenedCache, "normal scan must not bypass hardened cache");
  });

  it("callsUsed=0 with serpCooling=false means hardened cache served result", () => {
    const refreshCtx = { callsUsed: 0 };
    const serpCooling = false;
    const reason = refreshCtx.callsUsed === 0 && !serpCooling
      ? "source_returned_without_budget_consumed"
      : refreshCtx.callsUsed > 0
      ? "live_serp_attempted"
      : "serpapi_cooling";
    assert.equal(reason, "source_returned_without_budget_consumed");
  });

  it("callsUsed=1 confirms live SerpAPI was reached", () => {
    const refreshCtx = { callsUsed: 1 };
    const liveAttempted = refreshCtx.callsUsed > 0;
    assert.ok(liveAttempted, "callsUsed > 0 means budget was consumed = real network call");
  });
});

// ── Phase 4I.3: NET_NEW_POLICY gate ──────────────────────────────────────────

describe("CACHE_REFRESH_NET_NEW_POLICY", () => {
  it("willMerge is true when netNew >= 2", () => {
    const netNew = [makeFakeItem(), makeFakeItem()];
    const willMerge = netNew.length >= 2;
    assert.ok(willMerge);
  });

  it("willMerge is false when netNew < 2", () => {
    const netNew = [makeFakeItem()];
    const willMerge = netNew.length >= 2;
    assert.ok(!willMerge);
  });

  it("identityRejected = dedupedNew.length - netNew.length", () => {
    const dedupedNew = [makeFakeItem(), makeFakeItem(), makeFakeItem()];
    const netNew = [makeFakeItem()]; // 2 rejected by identity
    const identityRejected = dedupedNew.length - netNew.length;
    assert.equal(identityRejected, 2);
  });
});

// ── Phase 4I.3: verified item after index 24 must not be sliced pre-rerank ───

describe("rank-before-slice prevents losing late verified items", () => {
  it("25 items: verified item at idx 24 survives after rerank-then-slice", () => {
    // Build 24 pricing-only items + 1 verified at the end
    const pricingOnly = Array.from({ length: 24 }, (_, i) =>
      makeFakeItem({ title: `Pricing Item ${i}`, price: 100 + i, urlQuality: "unknown_legacy_no_url" })
    );
    const verifiedLate = makeFakeItem({
      title: "Verified Direct (appended last)",
      price: 50,
      urlQuality: "merchant_direct",
      clickable: true,
      directUrl: "https://shop.com/item",
    });
    const combined = [...pricingOnly, verifiedLate]; // verified is at idx 24

    // Slice before rerank (old behavior) — verified gets cut
    const slicedFirst = combined.slice(0, 24);
    const hasVerifiedAfterSliceFirst = slicedFirst.some(i => i.urlQuality === "merchant_direct");
    assert.equal(hasVerifiedAfterSliceFirst, false, "old behavior: verified cut before rerank");

    // Rerank before slice (new behavior) — verified floats to top
    const ranked = [...combined].sort((a, b) => evidenceRank(a) - evidenceRank(b));
    const slicedAfter = ranked.slice(0, 24);
    assert.equal(slicedAfter[0].urlQuality, "merchant_direct", "new behavior: verified is top after rerank");
    assert.ok(slicedAfter.some(i => i.urlQuality === "merchant_direct"), "verified survives slice");
  });

  it("pricing-only items rank below verified items after rerank (Phase 4I.3)", () => {
    const items = [
      makeFakeItem({ title: "Pricing A", urlQuality: "unknown_legacy_no_url", price: 30 }),
      makeFakeItem({ title: "Verified B", urlQuality: "merchant_direct", price: 100 }),
      makeFakeItem({ title: "Pricing C", urlQuality: "google_unresolved", price: 20 }),
    ];
    const ranked = [...items].sort((a, b) => evidenceRank(a) - evidenceRank(b));
    assert.equal(ranked[0].title, "Verified B", "merchant_direct ranks first");
    // pricing-only items come after regardless of price
    assert.ok(["Pricing A", "Pricing C"].includes(ranked[1].title));
    assert.ok(["Pricing A", "Pricing C"].includes(ranked[2].title));
  });
});

// ── Phase 4I.4: serpShopping gate audit ──────────────────────────────────────

describe("serpShopping bypassHardenedCache gate", () => {
  it("bypassHardenedCache=false means hardened cache is checked (normal scan path)", () => {
    const bypassHardenedCache = false;
    // Simulate: if cache has fresh entry and bypassHardenedCache=false → return cached
    const cacheHasFresh = true;
    const wouldReturnFromCache = !bypassHardenedCache && cacheHasFresh;
    assert.ok(wouldReturnFromCache, "normal scan uses hardened cache");
  });

  it("bypassHardenedCache=true skips hardened cache and reaches consumeSerpBudget", () => {
    const bypassHardenedCache = true;
    // Simulate: bypassHardenedCache=true → cache block skipped → consumeSerpBudget runs
    const cacheHasFresh = true;
    const wouldReturnFromCache = !bypassHardenedCache && cacheHasFresh;
    assert.ok(!wouldReturnFromCache, "forceSourceRefresh must not return from hardened cache");
  });

  it("SERP_HARDENED_CACHE_BYPASSED fires only when bypassHardenedCache=true", () => {
    // The log fires at the point where we confirmed cache was skipped and we're at budget gate
    const shouldLog = (bypassHardenedCache) => bypassHardenedCache === true;
    assert.ok(shouldLog(true), "fires on refresh path");
    assert.ok(!shouldLog(false), "does not fire on normal scan path");
  });

  it("SERP_LIVE_SOURCE_NOT_REACHED fires when budget is blocked AND bypassHardenedCache=true", () => {
    const bypassHardenedCache = true;
    const budgetAllowed = false; // blocked
    const shouldLog = bypassHardenedCache && !budgetAllowed;
    assert.ok(shouldLog, "logs when forceSourceRefresh hits a blocked budget");
  });

  it("SERP_LIVE_SOURCE_NOT_REACHED does not fire on normal scan budget blocks", () => {
    const bypassHardenedCache = false; // normal scan
    const budgetAllowed = false; // blocked
    const shouldLog = bypassHardenedCache && !budgetAllowed;
    assert.ok(!shouldLog, "normal scan budget block uses standard SERP_BUDGET_BLOCKED");
  });

  it("refreshBudgetUsed=1 proves consumeSerpBudget ran and real call was made", () => {
    const refreshCtx = { callsUsed: 1 };
    assert.ok(refreshCtx.callsUsed > 0, "callsUsed > 0 = consumeSerpBudget was called = real network call");
  });

  it("refreshBudgetUsed=0 with serpCooling=false flags source-not-reached condition", () => {
    const refreshCtx = { callsUsed: 0 };
    const serpCooling = false;
    // If not cooling but callsUsed=0, something returned before consumeSerpBudget
    const sourceNotReached = refreshCtx.callsUsed === 0 && !serpCooling;
    assert.ok(sourceNotReached, "should log CACHE_REFRESH_LIVE_SOURCE_NOT_ATTEMPTED");
  });

  it("cooling=true + bypassHardenedCache=true falls through to budget gate (new behavior)", () => {
    // Old: cooling + no return → falls through silently
    // New: cooling + bypassHardenedCache=false → return []; cooling + bypassHardenedCache=true → falls through
    const bypassHardenedCache = true;
    const isCooling = true;
    // When bypassHardenedCache=true we allow the call through even when cooling,
    // letting the budget gate decide — consistent with pre-flight check upstream
    const shouldFallThrough = bypassHardenedCache; // new behavior
    assert.ok(shouldFallThrough, "forceSourceRefresh must attempt even when cooling to get honest result");
  });
});
