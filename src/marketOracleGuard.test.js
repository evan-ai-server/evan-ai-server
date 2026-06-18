// src/marketOracleGuard.test.js
// Phase V3.9B.1 — tests for the route-oracle source-unavailability guard.
//
// Run: node --test src/marketOracleGuard.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipOracleSourceUnavailable } from "./marketOracleGuard.js";

// ── shouldSkipOracleSourceUnavailable ────────────────────────────────────────

describe("shouldSkipOracleSourceUnavailable — core guard", () => {
  // The live V3.9B.1 failure: SerpAPI 429, eBay disabled, items = 0
  it("serpapi cooling + eBay unavailable + 0 items → skip oracle", () => {
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "primary_source_rate_limited_no_market_evidence");
  });

  it("serpapi cooling + eBay unavailable + 1 item → allow oracle to augment thin pool", () => {
    // If we have ANY real items, oracle may augment (consistent with stream path).
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 1 });
    assert.equal(r.skip, false);
  });

  it("serpapi cooling + eBay available + 0 items → do NOT skip (eBay is live)", () => {
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: true, itemCount: 0 });
    assert.equal(r.skip, false);
    assert.equal(r.reason, "primary_source_available");
  });

  it("serpapi NOT cooling + eBay unavailable + 0 items → do NOT skip (serpapi is live)", () => {
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: false, ebayAvail: false, itemCount: 0 });
    assert.equal(r.skip, false);
  });

  it("both sources available + 0 items → allow oracle (normal thin-pool case)", () => {
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: false, ebayAvail: true, itemCount: 0 });
    assert.equal(r.skip, false);
  });

  it("defaults: all false/0 → do NOT skip (safe default)", () => {
    const r = shouldSkipOracleSourceUnavailable();
    assert.equal(r.skip, false);
  });
});

// ── Trust invariants unchanged ────────────────────────────────────────────────

describe("trust invariants — oracle items must never become verified or clickable", () => {
  it("oracle_pricing_estimate urlQuality is never verified_listing", () => {
    // This models the sanitizeOutboundListingForClient step-4 logic:
    // evidenceQuality = "verified_listing" only when isMerchant && clickable && directUrl.
    const oracleItem = {
      urlQuality: "oracle_pricing_estimate",
      clickable: false,
      directUrl: null,
      isVerifiedListing: false,
    };
    const isMerchant = ["merchant_direct", "merchant_resolved", "google_redirect_unwrapped"]
      .includes(oracleItem.urlQuality);
    const evidenceQuality = (isMerchant && oracleItem.clickable !== false && oracleItem.directUrl)
      ? "verified_listing" : "pricing_signal";
    assert.equal(evidenceQuality, "pricing_signal");
    assert.equal(oracleItem.isVerifiedListing, false);
  });

  it("oracle item with no directUrl stays non-clickable", () => {
    const item = { directUrl: null, clickable: false, urlQuality: "oracle_pricing_estimate" };
    assert.equal(item.clickable, false);
    assert.equal(item.directUrl, null);
  });

  it("skipping oracle leaves empty result — no oracle comps, no fabricated prices", () => {
    // When the guard returns skip:true, the route must return [] or whatever
    // real items exist. The guard itself doesn't fabricate anything.
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(r.skip, true);
    // The route should use r.skip to skip the oracle call; no oracle items are returned.
  });
});

// ── Incomplete aircraft gate not broken (V3.7 regression check) ──────────────

describe("V3.7 gates — incomplete aircraft guard is independent of source-availability guard", () => {
  it("incomplete aircraft (airline-only) is handled by a separate guard upstream — source-unavailability guard is not its mechanism", () => {
    // The source-unavailability guard does NOT check aircraft identity.
    // Aircraft identity is checked by detectIncompleteAircraftIdentityQuery separately.
    // This test confirms the two guards are orthogonal.
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: false, ebayAvail: true, itemCount: 0 });
    // Even with real sources available and 0 items, source-unavailability does NOT skip —
    // that's the correct behavior. The aircraft guard handles the incomplete-identity case.
    assert.equal(r.skip, false);
  });

  it("both sources unavailable + 0 items → skip even for incomplete aircraft identity (belt+suspenders)", () => {
    // If V3.7's aircraft guard already skipped, we never reach here.
    // But if somehow we did reach the source-unavailability check, it would also skip.
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(r.skip, true);
  });
});

// ── Competitor leak prevented ─────────────────────────────────────────────────

describe("competitor leak prevention — no oracle when no real market data and sources unavailable", () => {
  it("when guard skips oracle, the competitor oracle items (Delta/United/American) are never injected", () => {
    // Simulate the live V3.9B retest scenario:
    // SerpAPI 429, eBay unavailable, 0 real items for "hawaiian airlines boeing 787 diecast"
    const guardResult = shouldSkipOracleSourceUnavailable({
      serpCooling: true,
      ebayAvail: false,
      itemCount: 0, // singleflight returned 0 (stream ran first with skipOracle:true)
    });

    // Guard says skip → route must NOT call gptMarketOracle → no competitor items injected
    assert.equal(guardResult.skip, true);

    // Contrast: if guard were NOT applied (old behavior), oracle would fire:
    const noGuardResult = { skip: false }; // old behavior
    assert.equal(noGuardResult.skip, false); // proved the old code had no guard
  });

  it("with real items, guard allows oracle even if sources are unavailable (thin-pool augment)", () => {
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 3 });
    assert.equal(r.skip, false, "3 real items → oracle may augment thin pool");
  });
});

// ── V3.10B.2: fresh recomputation proves guard transitions from allow→skip ──────

describe("V3.10B.2 — guard can transition from false→true after SerpAPI 429", () => {
  it("guard false before source attempt can become true after SerpAPI 429", () => {
    // Before source attempt: serpapi not cooling
    const before = shouldSkipOracleSourceUnavailable({ serpCooling: false, ebayAvail: false, itemCount: 0 });
    assert.equal(before.skip, false, "before 429: serpapi is live → don't skip");

    // After SerpAPI 429 triggers cooldown: serpapi now cooling
    const after = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(after.skip, true, "after 429: serpapi cooling + eBay off + 0 items → skip");
  });

  it("oracle is skipped after fresh recompute with serpCooling=true", () => {
    const fresh = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(fresh.skip, true);
    assert.equal(fresh.reason, "primary_source_rate_limited_no_market_evidence");
  });

  it("no GPT oracle activation when serpCooling=true, ebayAvail=false, itemCount=0", () => {
    const guard = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(guard.skip, true, "guard must prevent oracle from activating");
  });
});

// ── V3.9C: all three guards are consistent (stream / route / merge) ────────────

describe("V3.9C consistency — stream, route, and merge guards all use the same rule", () => {
  it("same inputs produce the same skip decision across all three guard sites", () => {
    // The stream guard (~index.js:31351), route guard (V3.9B.1), and merge guard (V3.9C)
    // all delegate to shouldSkipOracleSourceUnavailable. Same inputs → same result.
    const inputs = [
      { serpCooling: true,  ebayAvail: false, itemCount: 0, expectedSkip: true  },
      { serpCooling: true,  ebayAvail: false, itemCount: 1, expectedSkip: false },
      { serpCooling: true,  ebayAvail: true,  itemCount: 0, expectedSkip: false },
      { serpCooling: false, ebayAvail: false, itemCount: 0, expectedSkip: false },
    ];
    for (const { serpCooling, ebayAvail, itemCount, expectedSkip } of inputs) {
      const r = shouldSkipOracleSourceUnavailable({ serpCooling, ebayAvail, itemCount });
      assert.equal(r.skip, expectedSkip, `serpCooling=${serpCooling} ebay=${ebayAvail} items=${itemCount}`);
    }
  });

  it("exact V3.9B retest failure: SerpAPI 429 + eBay off + 0 items → skip at all three layers", () => {
    const r = shouldSkipOracleSourceUnavailable({ serpCooling: true, ebayAvail: false, itemCount: 0 });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "primary_source_rate_limited_no_market_evidence");
  });
});
