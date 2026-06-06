// src/marketStructureEngine.test.js
// node --test src/marketStructureEngine.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMarketStructure } from "./marketStructureEngine.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeItem(price, overrides = {}) {
  return { price, title: overrides.title || `Item at $${price}`, source: overrides.source || "ebay", ...overrides };
}

function makeItems(prices, overrides = {}) {
  return prices.map((p, i) => makeItem(p, { title: `Item ${i} $${p}`, ...overrides }));
}

function deepCopy(val) {
  return JSON.parse(JSON.stringify(val));
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("1. aircraft diecast two clusters", () => {
  const items = [
    { price: 30, title: "Generic model A380", source: "ebay", isVerifiedListing: false },
    { price: 31, title: "Generic model 787", source: "amazon", isVerifiedListing: false },
    { price: 66, title: "Gemini Jets A380", source: "geminijets.com", isVerifiedListing: false },
    { price: 70, title: "Herpa 787 Model", source: "herpa", isVerifiedListing: false },
    { price: 77, title: "NG Models 787", source: "ngmodels", isVerifiedListing: false },
    { price: 90, title: "JC Wings A380", source: "jcwings", isVerifiedListing: false },
  ];
  const ctx = { category: "aircraft_diecast", query: "boeing 787 diecast" };

  const result = analyzeMarketStructure(items, ctx);

  assert.equal(result.clusterCount, 2, `expected 2 clusters, got ${result.clusterCount}`);
  assert.ok(result.clusters.length === 2, "should have 2 cluster objects");

  const lowBand = result.clusters[0];
  const premiumBand = result.clusters[1];
  assert.equal(lowBand.label, "low band");
  assert.equal(premiumBand.label, "premium band");

  // Low band: [30, 31] → median 30.5
  assert.ok(Math.abs(lowBand.median - 30.5) < 1, `low band median should be ~30.5, got ${lowBand.median}`);
  // Premium band: [66, 70, 77, 90] → median (70+77)/2=73.5
  assert.ok(premiumBand.median >= 65 && premiumBand.median <= 85, `premium band median should be ~73.5, got ${premiumBand.median}`);

  assert.ok(result.dominantCluster !== null, "dominantCluster should exist");
  assert.equal(result.dominantCluster.label, "premium band", "dominant should be the larger cluster");

  // No verdict-like fields
  assert.ok(!("verdict" in result), "result must not contain verdict field");
  assert.ok(!("buySignal" in result), "result must not contain buySignal field");
  assert.ok(!("signal" in result), "result must not contain signal field");
});

test("2. generic toy contamination from ctx only", () => {
  // Clean premium items — no toy items in the pool
  const items = [
    { price: 65, title: "Gemini Jets 777", source: "geminijets.com", isVerifiedListing: false },
    { price: 70, title: "Herpa 787", source: "herpa", isVerifiedListing: false },
    { price: 72, title: "NG Models A380", source: "ngmodels", isVerifiedListing: false },
    { price: 75, title: "JC Wings 747", source: "jcwings", isVerifiedListing: false },
  ];
  const ctx = {
    category: "aircraft_diecast",
    identityRejections: { rejectedGenericToyCount: 3 },
  };

  const result = analyzeMarketStructure(items, ctx);

  assert.equal(result.genericToyContamination, true, "genericToyContamination should be true from ctx");
  // Clusters should only contain the 4 clean items
  const totalInClusters = result.clusters.reduce((sum, c) => sum + c.count, 0);
  assert.equal(totalInClusters, 4, "clusters should contain only the 4 clean items, not fake toy rows");
});

test("3. google_unresolved listings are not verified", () => {
  const items = [
    { price: 50, title: "Item A", source: "google_shopping", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 55, title: "Item B", source: "google_shopping", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 60, title: "Item C", source: "google", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 65, title: "Item D", source: "google", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 70, title: "Item E", source: "amazon", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 75, title: "Item F", source: "amazon", isVerifiedListing: false, urlQuality: "google_unresolved" },
  ];

  const result = analyzeMarketStructure(items, {});

  // Every cluster must have verifiedCount = 0
  for (const cluster of result.clusters) {
    assert.equal(cluster.verifiedCount, 0, `cluster "${cluster.label}" should have verifiedCount=0`);
  }

  assert.equal(result.unresolvedUrlRisk, true, "unresolvedUrlRisk should be true when no verified listings");
  assert.ok(!result.marketStory.includes("verified"), `marketStory must not contain "verified" when unresolvedUrlRisk=true, got: "${result.marketStory}"`);
});

test("4. extreme outlier is isolated and dominant median is not 900", () => {
  const items = [
    { price: 30, title: "Item A", source: "ebay" },
    { price: 31, title: "Item B", source: "amazon" },
    { price: 33, title: "Item C", source: "etsy" },
    { price: 70, title: "Item D", source: "ebay" },
    { price: 72, title: "Item E", source: "amazon" },
    { price: 900, title: "Item F (outlier)", source: "rare_dealer" },
  ];

  const result = analyzeMarketStructure(items, {});

  // 900 should be isolated in its own cluster OR counted as outlier
  const has900InTinyCluster = result.clusters.some(c => c.count === 1 && c.maxPrice >= 900);
  const outlierCounted = result.outlierCount >= 1;
  assert.ok(has900InTinyCluster || outlierCounted, "extreme outlier (900) should be isolated or counted as outlier");

  assert.ok(result.dominantCluster !== null, "dominantCluster should exist");
  assert.ok(result.dominantCluster.median < 500, `dominant median should not be 900, got ${result.dominantCluster.median}`);

  // Story should be cautionary (no positive framing)
  const story = result.marketStory.toLowerCase();
  assert.ok(
    !story.includes("buy") && !story.includes("pass") && !story.includes("hold") &&
    !story.includes("skip") && !story.includes("avoid") && !story.includes("profit"),
    `marketStory must not contain verdict/profit words, got: "${result.marketStory}"`
  );
});

test("5. thin market with two listings", () => {
  const items = [
    { price: 20, title: "Item A", source: "ebay" },
    { price: 25, title: "Item B", source: "ebay" },
  ];

  const result = analyzeMarketStructure(items, {});

  assert.equal(result.thinMarket, true, "thinMarket should be true for 2 listings");
  assert.equal(result.clusterCount, 1, "should produce a single cluster for thin market");
  assert.ok(result.clusters.length === 1, "clusters array should have 1 entry");
});

test("6. single-source dominance — low sourceDiversityScore", () => {
  const items = [
    { price: 50, title: "eBay item 1", source: "eBay - seller_a", isVerifiedListing: false },
    { price: 52, title: "eBay item 2", source: "eBay - seller_b", isVerifiedListing: false },
    { price: 54, title: "eBay item 3", source: "eBay - seller_c", isVerifiedListing: false },
    { price: 56, title: "eBay item 4", source: "eBay - seller_d", isVerifiedListing: false },
    { price: 58, title: "eBay item 5", source: "eBay - seller_e", isVerifiedListing: false },
    { price: 60, title: "eBay item 6", source: "eBay - seller_f", isVerifiedListing: false },
    { price: 62, title: "Other item", source: "amazon", isVerifiedListing: false },
  ];

  const result = analyzeMarketStructure(items, {});

  // 6 of 7 normalize to "ebay", 1 normalizes to "amazon" → 2 distinct sources
  assert.ok(result.sourceDiversityScore <= 0.35, `sourceDiversityScore should be low (≤ 0.35), got ${result.sourceDiversityScore}`);
  // No verified listings → unresolvedUrlRisk=true → no "verified" claim
  assert.equal(result.unresolvedUrlRisk, true, "unresolvedUrlRisk should be true (no verified listings)");
  assert.ok(!result.marketStory.includes("verified"), "marketStory must not claim verified market");
});

test("7. immutability — input items and titles unchanged after call", () => {
  const items = [
    { price: 30, title: "ANA Boeing 787 Diecast Model Airplane", source: "geminijets" },
    { price: 35, title: "Hawaiian Airlines Airbus A380 Scale 1:400", source: "herpa" },
    { price: 65, title: "Japan Airlines Boeing 787 Premium Diecast", source: "ngmodels" },
    { price: 70, title: "Cathay Pacific Airbus A380 Model", source: "jcwings" },
  ];

  const before = deepCopy(items);

  analyzeMarketStructure(items, { category: "aircraft_diecast", query: "boeing 787 diecast" });

  const after = deepCopy(items);

  assert.deepEqual(after, before, "original items must not be mutated");

  // Aircraft codes must be intact
  assert.ok(items[0].title.includes("787"), "Boeing 787 title token must survive");
  assert.ok(items[1].title.includes("A380"), "Airbus A380 title token must survive");
  assert.ok(items[2].title.includes("787"), "Second 787 title must survive");
  assert.ok(items[3].title.includes("A380"), "Second A380 title must survive");
});

test("8. scanned price above dominant band — cautionary story, no profit wording", () => {
  const items = [
    { price: 60, title: "Item A", source: "ebay", isVerifiedListing: false },
    { price: 65, title: "Item B", source: "amazon", isVerifiedListing: false },
    { price: 70, title: "Item C", source: "etsy", isVerifiedListing: false },
    { price: 75, title: "Item D", source: "ebay", isVerifiedListing: false },
    { price: 80, title: "Item E", source: "amazon", isVerifiedListing: false },
  ];
  const ctx = { scannedPrice: 165.99 };

  const result = analyzeMarketStructure(items, ctx);

  assert.equal(result.scannedPricePosition, "above", `expected "above", got "${result.scannedPricePosition}"`);
  assert.ok(typeof result.scannedPriceVsDominantPct === "number" && result.scannedPriceVsDominantPct > 0,
    `scannedPriceVsDominantPct should be positive, got ${result.scannedPriceVsDominantPct}`);

  const story = result.marketStory.toLowerCase();
  assert.ok(!story.includes("profit"), `marketStory must not mention profit, got: "${result.marketStory}"`);
  assert.ok(
    !story.includes("buy") && !story.includes("pass") && !story.includes("hold") &&
    !story.includes("skip") && !story.includes("avoid"),
    `marketStory must not contain verdict words, got: "${result.marketStory}"`
  );
  // Story must be cautionary about the above-market price
  assert.ok(result.marketStory.toLowerCase().includes("above") || result.marketStory.toLowerCase().includes("cluster"),
    `marketStory should be cautionary about above-market price, got: "${result.marketStory}"`);
});

test("9. empty input — safe defaults, no throw", () => {
  const result = analyzeMarketStructure([], {});

  assert.equal(result.clusterCount, 0, "clusterCount should be 0");
  assert.deepEqual(result.clusters, [], "clusters should be empty array");
  assert.equal(result.dominantCluster, null, "dominantCluster should be null");
  assert.equal(result.thinMarket, true, "thinMarket should be true");
  assert.ok(typeof result.marketStory === "string" && result.marketStory.length > 0, "marketStory should be a non-empty string");

  // Also test null/undefined inputs — should not throw
  const r2 = analyzeMarketStructure(null, null);
  assert.equal(r2.clusterCount, 0);
  const r3 = analyzeMarketStructure(undefined, undefined);
  assert.equal(r3.clusterCount, 0);
});

test("10. missing calibration/trust ctx — safe defaults, no throw", () => {
  const items = [
    { price: 40, title: "Item", source: "ebay" },
    { price: 45, title: "Item 2", source: "amazon" },
  ];

  // No calibration, no trust — should not throw
  const r1 = analyzeMarketStructure(items, {});
  assert.ok(r1, "should return a result with empty ctx");
  assert.equal(typeof r1.clusterCount, "number");

  const r2 = analyzeMarketStructure(items, { calibration: null, identityRejections: null });
  assert.ok(r2, "should handle null calibration/identityRejections");

  // version field must be present
  assert.equal(r1.version, 1, "version should be 1");
  assert.equal(r2.version, 1, "version should be 1");

  // None of the required fields should be missing
  for (const field of ["clusterCount", "clusters", "dominantCluster", "scannedPricePosition", "thinMarket", "unresolvedUrlRisk", "spreadRisk", "marketStory"]) {
    assert.ok(field in r1, `field "${field}" must be present`);
  }
});

// ── P1-2: marketStory "promising" must not fire when caution flags are set ────

test("11. below-band + genericToyContamination → cautionary variant, not 'promising'", () => {
  // Scanned price well below a clear market band, but toys were rejected from the pool.
  // A cheap price most likely means a generic toy, not a discount premium model.
  const items = [
    { price: 65, title: "Gemini Jets 787", source: "geminijets", isVerifiedListing: false },
    { price: 70, title: "Herpa 787",       source: "herpa",      isVerifiedListing: false },
    { price: 72, title: "NG Models 787",   source: "ngmodels",   isVerifiedListing: false },
    { price: 75, title: "JC Wings 787",    source: "jcwings",    isVerifiedListing: false },
    { price: 80, title: "Aeroclassics",    source: "aeroclassics", isVerifiedListing: false },
  ];
  const ctx = {
    scannedPrice: 14.99,
    category: "aircraft_diecast",
    identityRejections: { rejectedGenericToyCount: 4 },
  };
  const r = analyzeMarketStructure(items, ctx);

  assert.equal(r.scannedPricePosition, "below", "scanned price should be below the band");
  assert.equal(r.genericToyContamination, true, "genericToyContamination should be true");
  assert.ok(!r.marketStory.includes("promising"), `must not say "promising" when toys were rejected: "${r.marketStory}"`);
  assert.ok(r.marketStory.toLowerCase().includes("verify") || r.marketStory.toLowerCase().includes("brand") || r.marketStory.toLowerCase().includes("variant"),
    `cautionary variant must mention verification/brand/variant: "${r.marketStory}"`);
});

test("12. below-band + premiumTierDetected → cautionary variant, not 'promising'", () => {
  // Scanned price far below a premium-model band. The cluster tier shows premium
  // brands (Gemini/Herpa) dominate the market — a $15 price is a different product.
  const items = [
    { price: 68, title: "Gemini Jets Hawaiian Airlines 787", source: "geminijets", isVerifiedListing: false },
    { price: 75, title: "Herpa Hawaiian 787 1:200",          source: "herpa",      isVerifiedListing: false },
    { price: 90, title: "NG Models 787 Hawaiian",            source: "ngmodels",   isVerifiedListing: false },
    { price: 95, title: "JC Wings Hawaiian 787",             source: "jcwings",    isVerifiedListing: false },
  ];
  const ctx = { scannedPrice: 12.00, category: "aircraft_diecast" };

  const r = analyzeMarketStructure(items, ctx);

  assert.equal(r.scannedPricePosition, "below", "scanned price should be below the band");
  assert.equal(r.premiumTierDetected, true, "premiumTierDetected should be true");
  assert.ok(!r.marketStory.includes("promising"), `must not say "promising" when premium tier detected: "${r.marketStory}"`);
  assert.ok(r.marketStory.toLowerCase().includes("verify") || r.marketStory.toLowerCase().includes("brand") || r.marketStory.toLowerCase().includes("variant"),
    `cautionary variant must mention verification/brand/variant: "${r.marketStory}"`);
});

test("13. below-band with no caution flags → standard 'promising' story is fine", () => {
  // Clean pool: at least one verified listing so unresolvedUrlRisk=false,
  // multiple sources so thinMarket=false, no toy/premium contamination.
  // Only when all caution flags are clear is "promising" appropriate.
  const items = [
    { price: 80, title: "Nike Air Max 1", source: "stockx",  isVerifiedListing: true  }, // verified
    { price: 85, title: "Nike Air Max 1", source: "goat",    isVerifiedListing: false },
    { price: 90, title: "Nike Air Max 1", source: "ebay",    isVerifiedListing: false },
    { price: 95, title: "Nike Air Max 1", source: "amazon",  isVerifiedListing: false },
  ];
  const ctx = { scannedPrice: 55, category: "sneakers" };

  const r = analyzeMarketStructure(items, ctx);

  assert.equal(r.scannedPricePosition, "below", "scanned price should be below the band");
  assert.equal(r.genericToyContamination, false, "no toy contamination");
  assert.equal(r.premiumTierDetected, false, "no premium tier");
  assert.equal(r.unresolvedUrlRisk, false, "one verified comp → unresolvedUrlRisk should be false");
  assert.equal(r.thinMarket, false, "4 items, 4 sources — not thin");
  assert.ok(r.marketStory.includes("promising"), `standard below-band with clean evidence should say "promising": "${r.marketStory}"`);
});

test("14. below-band + unresolvedUrlRisk (all unresolved URLs) → evidence-quality warning, not 'promising'", () => {
  // Scanned price below the band, but every comp is a google_unresolved URL.
  // unresolvedUrlRisk=true means zero verified comps — "promising" overstates certainty.
  const items = [
    { price: 170, title: "AirPods Pro 2 used", source: "google_shopping", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 185, title: "AirPods Pro 2",      source: "google_shopping", isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 200, title: "AirPods Pro 2 good", source: "ebay",            isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 220, title: "AirPods Pro 2",      source: "amazon",          isVerifiedListing: false, urlQuality: "google_unresolved" },
    { price: 255, title: "AirPods Pro 2 box",  source: "walmart",         isVerifiedListing: false, urlQuality: "google_unresolved" },
  ];
  const ctx = { scannedPrice: 90 };

  const r = analyzeMarketStructure(items, ctx);

  assert.equal(r.scannedPricePosition, "below", "scanned price below the $170–$255 band");
  assert.equal(r.unresolvedUrlRisk, true, "zero verified comps → unresolvedUrlRisk true");
  assert.equal(r.genericToyContamination, false, "no toy contamination");
  assert.equal(r.premiumTierDetected, false, "no premium tier in this context");
  assert.ok(!r.marketStory.includes("promising"), `must not say "promising" with zero verified comps: "${r.marketStory}"`);
  const storyLower = r.marketStory.toLowerCase();
  assert.ok(
    storyLower.includes("signal") || storyLower.includes("directional") || storyLower.includes("confirmed"),
    `story must convey evidence uncertainty: "${r.marketStory}"`
  );
});
