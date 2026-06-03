// src/confidenceCalibration.test.js
// node --test src/confidenceCalibration.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrateEvidenceConfidence } from "./confidenceCalibration.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeVerifiedItems(count) {
  return Array(count).fill(null).map((_, i) => ({
    isVerifiedListing: true,
    evidenceQuality:   "verified_listing",
    clickable:         true,
    directUrl:         `https://ebay.com/item/${i}`,
    price:             55 + i * 5,
    totalPrice:        55 + i * 5,
    source:            `ebay-${i}`,
  }));
}

function makePricingSignalItems(count) {
  return Array(count).fill(null).map((_, i) => ({
    isVerifiedListing: false,
    evidenceQuality:   "pricing_signal",
    clickable:         false,
    price:             60 + i,
    totalPrice:        60 + i,
    source:            `store-${i}`,
  }));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test("verified_strong: 5+ verified listings, tight spread → tier and no cap", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    identityQuality:   0.8,
    items:             makeVerifiedItems(5),
    urlSummary:        { verifiedListings: 5, pricingOnly: 0, oracleEstimates: 0, total: 5 },
    marketEvidence:    { confidence: "high", priceSpreadPct: 15, directUrlCount: 5 },
    consensus:         { marketConfidence: 0.80, listingCount: 5 },
  });

  assert.equal(result.evidenceTier, "verified_strong");
  assert.equal(result.capApplied, false);
  assert.equal(result.calibratedConfidence, 0.9);
  assert.equal(result.confidenceCap, 0.95);
  assert.equal(result.canShowVerifiedLanguage, true);
  assert.equal(result.verdictStrengthCap, "strong");
  assert.equal(result.canShowStrongLanguage, true);
});

test("verified_moderate: 2–4 verified listings → cap at 0.85", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    identityQuality:   0.7,
    items:             [
      ...makeVerifiedItems(3),
      ...makePricingSignalItems(2),
    ],
    urlSummary:        { verifiedListings: 3, pricingOnly: 2, oracleEstimates: 0, total: 5 },
    marketEvidence:    { confidence: "medium", priceSpreadPct: 25, directUrlCount: 3 },
    consensus:         { marketConfidence: 0.70 },
  });

  assert.equal(result.evidenceTier, "verified_moderate");
  assert.equal(result.capApplied, true);
  assert.equal(result.calibratedConfidence, 0.85);
  assert.equal(result.confidenceCap, 0.85);
  assert.equal(result.canShowVerifiedLanguage, true);
  assert(result.verdictStrengthCap === "strong" || result.verdictStrengthCap === "moderate");
});

test("verified_thin: exactly 1 verified listing → cap at 0.70", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    identityQuality:   0.6,
    items:             [
      ...makeVerifiedItems(1),
      ...makePricingSignalItems(3),
    ],
    urlSummary:        { verifiedListings: 1, pricingOnly: 4, oracleEstimates: 0, total: 5 },
    marketEvidence:    { confidence: "medium", priceSpreadPct: 30, directUrlCount: 1 },
    consensus:         { marketConfidence: 0.60 },
  });

  assert.equal(result.evidenceTier, "verified_thin");
  assert.equal(result.capApplied, true);
  assert.equal(result.calibratedConfidence, 0.70);
  assert.equal(result.confidenceCap, 0.70);
});

test("pricing_signal_strong: 8+ signals, 4+ comps, tight spread → 0.72 cap, moderate strength", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.85,
    identityQuality:   0.75,
    items:             makePricingSignalItems(6),
    urlSummary:        { verifiedListings: 0, pricingOnly: 10, oracleEstimates: 0, total: 10 },
    marketEvidence:    { confidence: "medium", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:         { marketConfidence: 0.75 },
  });

  assert.equal(result.evidenceTier, "pricing_signal_strong");
  assert.equal(result.capApplied, true);
  assert.equal(result.calibratedConfidence, 0.72);
  assert.equal(result.verdictStrengthCap, "moderate");
  assert.equal(result.canShowVerifiedLanguage, false);
  assert.ok(result.capReasons.includes("no_verified_listings"));
});

test("pricing_signal_only: 4+ signals, no verified, wide spread → 0.62 cap, evidence_limited", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    identityQuality:   0.6,
    items:             makePricingSignalItems(8),
    urlSummary:        { verifiedListings: 0, pricingOnly: 15, oracleEstimates: 0, total: 15 },
    marketEvidence:    { confidence: "low", priceSpreadPct: 70, directUrlCount: 0 },
    consensus:         { marketConfidence: 0.30 },
  });

  assert.equal(result.evidenceTier, "pricing_signal_only");
  assert.equal(result.capApplied, true);
  assert.equal(result.calibratedConfidence, 0.62);
  assert.equal(result.verdictStrengthCap, "evidence_limited");
  assert.equal(result.canShowVerifiedLanguage, false);
  assert.equal(result.canShowStrongLanguage, false);
});

test("thin_pricing_signal: < 4 pricing signals → 0.50 cap, evidence_limited", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.75,
    identityQuality:   0.45,
    items:             makePricingSignalItems(2),
    urlSummary:        { verifiedListings: 0, pricingOnly: 2, oracleEstimates: 0, total: 2 },
    marketEvidence:    { confidence: "low", priceSpreadPct: 40, directUrlCount: 0 },
    consensus:         { marketConfidence: 0.30 },
  });

  assert.equal(result.evidenceTier, "thin_pricing_signal");
  assert.equal(result.calibratedConfidence, 0.50);
  assert.equal(result.confidenceCap, 0.50);
  assert.equal(result.verdictStrengthCap, "evidence_limited");
});

test("estimate_only: oracle estimates, no verified, no signals → 0.40 cap", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.70,
    identityQuality:   0.50,
    items:             Array(2).fill(null).map((_, i) => ({
      isVerifiedListing: false, evidenceQuality: "oracle_estimate",
      clickable: false, price: 80, source: `oracle-${i}`,
    })),
    urlSummary:        { verifiedListings: 0, pricingOnly: 0, oracleEstimates: 2, total: 2 },
    marketEvidence:    { confidence: "low", priceSpreadPct: 0, directUrlCount: 0 },
    consensus:         { marketConfidence: 0.0 },
  });

  assert.equal(result.evidenceTier, "estimate_only");
  assert.equal(result.confidenceCap, 0.40);
  assert.equal(result.verdictStrengthCap, "evidence_limited");
  assert.ok(result.capReasons.includes("oracle_only"));
});

test("no_evidence: empty items → 0.15 cap, calibratedConfidence = 0.15", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.8,
    identityQuality:   0.6,
    items:             [],
    urlSummary:        { verifiedListings: 0, pricingOnly: 0, oracleEstimates: 0, total: 0 },
    marketEvidence:    { confidence: "low", priceSpreadPct: 0, directUrlCount: 0 },
    consensus:         { marketConfidence: 0 },
  });

  assert.equal(result.evidenceTier, "no_evidence");
  assert.equal(result.confidenceCap, 0.15);
  assert.equal(result.calibratedConfidence, 0.15);
  assert.equal(result.verdictStrengthCap, "evidence_limited");
});

test("Hawaiian 787 style: 0 verified, 13 clean signals (not raw 37), wide spread → pricing_signal_only, evidence_limited", () => {
  // urlSummary = CLEAN counts from 13 post-filter items; rawUrlSummary carries raw total 37.
  // identitySummary provides exact rejection counts so rawUrlSummary not used for ratio.
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    brandCertainty:    0.8,
    identityQuality:   0.55,
    items:             Array(13).fill(null).map(() => ({
      isVerifiedListing: false, evidenceQuality: "pricing_signal",
      clickable: false, price: 65, source: "ebay",
    })),
    urlSummary:        { verifiedListings: 0, pricingOnly: 13, oracleEstimates: 0, total: 13 },
    rawUrlSummary:     { total: 37 },
    marketEvidence:    { confidence: "low", priceSpreadPct: 80, directUrlCount: 0 },
    consensus:         { marketConfidence: 0.25, typicalHigh: 95 },
    scannedPrice:      165.99,
    identitySummary:   {
      rejectedCompetitorCount:     2,
      rejectedModelMismatchCount:  1,
      rejectedMissingAirlineCount: 8,
      rejectedGenericToyCount:     3,
    },
    category:  "model airplane",
    query:     "hawaiian airlines boeing 787 diecast model airplane",
  });

  assert.equal(result.evidenceTier, "pricing_signal_only", "tier should be pricing_signal_only");
  assert.equal(result.capApplied, true, "cap should be applied");
  assert.equal(result.calibratedConfidence, 0.62, "vision 0.9 capped to 0.62");
  assert.equal(result.canShowVerifiedLanguage, false, "no verified language");
  assert.equal(result.canShowStrongLanguage, false, "no strong language");
  assert.equal(result.verdictStrengthCap, "evidence_limited", "evidence limited");
  assert.ok(result.capReasons.includes("no_verified_listings"), "no_verified_listings reason");
  assert.ok(result.capReasons.includes("wide_spread"), "wide_spread reason");
  assert.ok(result.capReasons.includes("identity_lock_high_rejection_ratio"), "high rejection ratio reason");
  assert.ok(result.capReasons.includes("pricing_signal_against_high_scan_price"), "scan price above market reason");
  assert.equal(result.evidence.verifiedListingCount, 0);
  assert.equal(result.evidence.pricingSignalCount, 13, "uses clean count (13), not raw (37)");
  assert.equal(result.evidence.cleanCompCount, 13);
  assert.equal(result.evidence.rejectedCompetitorCount, 2);
  assert.equal(result.evidence.rejectedGenericToyCount, 3);
});

test("caps visionConfidence of 0.0 correctly at tier cap", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.0,
    items:             [],
    urlSummary:        { verifiedListings: 0, pricingOnly: 0, oracleEstimates: 0, total: 0 },
    marketEvidence:    { confidence: "low" },
    consensus:         {},
  });
  assert.equal(result.calibratedConfidence, 0.0);
  assert.equal(result.capApplied, false); // 0.0 not > 0.15
});

test("identitySummary=null uses rawUrlSummary.total for rejection approximation", () => {
  // urlSummary = CLEAN (10 items); rawUrlSummary.total = 30 (raw pre-filter).
  // With identitySummary=null: totalRejectedCount = max(0, 30-10) = 20; rejectionRatio ≈ 0.67.
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.8,
    identityQuality:  0.5,
    items:            makePricingSignalItems(10),
    urlSummary:       { verifiedListings: 0, pricingOnly: 10, oracleEstimates: 0, total: 10 },
    rawUrlSummary:    { total: 30 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 30, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.4 },
    identitySummary:  null,
  });

  // totalRejectedCount = max(0, rawTotal=30 - cleanCompCount=10) = 20
  // rejectionRatio = 20 / (20+10) ≈ 0.67
  assert.equal(result.evidence.pricingSignalCount, 10, "uses clean pricingOnly=10, not raw");
  assert.equal(result.evidence.cleanCompCount, 10);
  assert.ok(result.evidence.totalRejectedCount > 0, "rejection count derived from raw vs clean");
  assert.ok(result.evidence.rejectionRatio > 0.5, "high rejection ratio from raw=30 clean=10");
  assert.ok(result.capReasons.includes("no_verified_listings"));
  assert.ok(result.capReasons.includes("identity_lock_high_rejection_ratio"), "high rejection flagged");
});

test("canShowMedianAsAuthoritative only with enough clean comps and tight spread", () => {
  const tightResult = calibrateEvidenceConfidence({
    visionConfidence: 0.7,
    items:            makePricingSignalItems(5),
    urlSummary:       { verifiedListings: 0, pricingOnly: 5, oracleEstimates: 0, total: 5 },
    marketEvidence:   { confidence: "medium", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.65 },
  });
  assert.equal(tightResult.canShowMedianAsAuthoritative, true, "tight spread + enough comps");

  const wideResult = calibrateEvidenceConfidence({
    visionConfidence: 0.7,
    items:            makePricingSignalItems(5),
    urlSummary:       { verifiedListings: 0, pricingOnly: 5, oracleEstimates: 0, total: 5 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 80, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.20 },
  });
  assert.equal(wideResult.canShowMedianAsAuthoritative, false, "wide spread blocks median authority");
});

// ── Clean-vs-raw contamination guard tests ────────────────────────────────────

test("raw verified listings from wrong-airline items do NOT inflate verifiedListingCount", () => {
  // Scenario: 3 raw verified items were wrong-airline (ANA 787, JAL 787) and filtered out.
  // Clean uiItems: 0 verified, 11 pricing-signal only.
  // urlSummary = CLEAN (0 verified); rawUrlSummary.total = 14 (3 filtered verified + 11 clean).
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items:            makePricingSignalItems(11),
    urlSummary:       { verifiedListings: 0, pricingOnly: 11, oracleEstimates: 0, total: 11 },
    rawUrlSummary:    { total: 14 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 40, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.45 },
    identitySummary:  null,
  });

  assert.equal(result.evidence.verifiedListingCount, 0, "no verified in clean pool");
  assert.equal(result.canShowVerifiedLanguage, false, "clean pool has 0 verified");
  assert.ok(result.capReasons.includes("no_verified_listings"), "no_verified_listings flagged");
  assert.notEqual(result.evidenceTier, "verified_moderate", "must not be verified_moderate");
  assert.notEqual(result.evidenceTier, "verified_strong",   "must not be verified_strong");
});

test("raw pricing signal count (40) does NOT inflate pricingSignalCount beyond clean count (11)", () => {
  // Scenario: raw pool had 40 items (many irrelevant aircraft/toys/wrong-airline).
  // After identity filtering, only 11 clean Hawaiian-787 comps remain.
  // pricingSignalCount must come from clean 11, not raw 40.
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.9,
    identityQuality:  0.6,
    items:            makePricingSignalItems(11),
    urlSummary:       { verifiedListings: 0, pricingOnly: 11, oracleEstimates: 0, total: 11 },
    rawUrlSummary:    { total: 40 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 55, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.30 },
    identitySummary:  null,
  });

  assert.equal(result.evidence.pricingSignalCount, 11, "clean pricingSignals=11, not raw=40");
  assert.equal(result.evidence.cleanCompCount, 11);
  // 40 - 11 = 29 rejected; rejectionRatio = 29/40 ≈ 0.725 → high
  assert.ok(result.evidence.rejectionRatio > 0.5, "high rejection from large raw pool");
  assert.ok(result.capReasons.includes("identity_lock_high_rejection_ratio"), "high rejection flagged");
  // With 11 clean signals, tier should be pricing_signal_only (11>=4 but spread >0.5 blocks strong)
  assert.equal(result.evidenceTier, "pricing_signal_only");
});

// ── Phase 4B: URL evidence upgrade safety tests ───────────────────────────────

test("4B: Google search ibp=oshop URL remains pricing_signal — cannot be verified", () => {
  // Case 1: google.com/search?ibp=oshop is not a direct merchant URL.
  // calibration must see 0 verified even though items exist.
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.9,
    items:            makePricingSignalItems(11),  // all google_unresolved
    urlSummary:       { verifiedListings: 0, pricingOnly: 11, oracleEstimates: 0, total: 11 },
    rawUrlSummary:    { total: 40 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 50, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.25 },
  });

  assert.equal(result.evidence.verifiedListingCount, 0, "ibp=oshop must not count as verified");
  assert.equal(result.canShowVerifiedLanguage, false, "no verified language for google-unresolved items");
  assert.ok(result.capReasons.includes("no_verified_listings"), "no_verified_listings reason must fire");
  assert.notEqual(result.evidenceTier, "verified_strong",    "must not be verified_strong");
  assert.notEqual(result.evidenceTier, "verified_moderate",  "must not be verified_moderate");
});

test("4B: Direct merchant product URL becomes verified_listing tier", () => {
  // Case 2: clean merchant direct URL → verified_listing evidenceQuality.
  // Simulate post-recovery state: item now has clickable=true, isVerifiedListing=true.
  const verifiedItems = [
    { isVerifiedListing: true, evidenceQuality: "verified_listing", clickable: true,
      directUrl: "https://www.ebay.com/itm/387654321", price: 65, source: "ebay" },
    ...makePricingSignalItems(4),
  ];
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.9,
    items:            verifiedItems,
    urlSummary:       { verifiedListings: 1, pricingOnly: 4, oracleEstimates: 0, total: 5 },
    rawUrlSummary:    { total: 40 },
    marketEvidence:   { confidence: "medium", priceSpreadPct: 25, directUrlCount: 1 },
    consensus:        { marketConfidence: 0.65 },
  });

  assert.equal(result.evidence.verifiedListingCount, 1, "recovered verified listing should count");
  assert.equal(result.evidenceTier, "verified_thin", "1 verified → verified_thin");
  assert.equal(result.canShowVerifiedLanguage, true, "verified language allowed with 1 verified listing");
});

test("4B: Google redirect that unwraps safely to eBay becomes verified evidence", () => {
  // Case 3: aclk?adurl=ebay.com/itm/ is already handled by extractFromGoogleRedirect.
  // After resolution: item has clickable=true, directUrl=ebay.com/itm/..., urlQuality=google_redirect_unwrapped.
  const unwrappedItem = {
    isVerifiedListing: true, evidenceQuality: "verified_listing",
    clickable: true, directUrl: "https://www.ebay.com/itm/123456789",
    urlQuality: "google_redirect_unwrapped", price: 70, source: "ebay-seller",
  };
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    items:            [unwrappedItem, ...makePricingSignalItems(5)],
    urlSummary:       { verifiedListings: 1, pricingOnly: 5, oracleEstimates: 0, total: 6 },
    rawUrlSummary:    { total: 40 },
    marketEvidence:   { confidence: "medium", priceSpreadPct: 20, directUrlCount: 1 },
    consensus:        { marketConfidence: 0.70 },
  });

  assert.equal(result.evidence.verifiedListingCount, 1, "unwrapped redirect counts as verified");
  assert.equal(result.evidenceTier, "verified_thin");
  assert.equal(result.canShowVerifiedLanguage, true);
});

test("4B: Google redirect that unwraps to Google homepage stays pricing_signal", () => {
  // Case 4: redirect that resolves to google.com should never be verified.
  // This simulates a google.com/url?q=google.com case — rejected by isGoogleHost.
  // calibration receives it with clickable=false, no directUrl.
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    items:            makePricingSignalItems(5),  // all clickable=false
    urlSummary:       { verifiedListings: 0, pricingOnly: 5, oracleEstimates: 0, total: 5 },
    rawUrlSummary:    { total: 10 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 40, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.30 },
  });

  assert.equal(result.evidence.verifiedListingCount, 0, "google-resolving redirect must not be verified");
  assert.equal(result.canShowVerifiedLanguage, false);
});

test("4B: Blocked or tracking URL remains pricing_signal", () => {
  // Case 5: items with blocked directUrls have clickable=false after sanitizeOutboundListingForClient.
  // Simulate: all items are non-clickable.
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.8,
    items:            makePricingSignalItems(8),
    urlSummary:       { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    rawUrlSummary:    { total: 8 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 35, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.40 },
  });

  assert.equal(result.evidence.verifiedListingCount, 0);
  assert.ok(result.capReasons.includes("no_verified_listings"));
});

test("4B: Wrong-identity items filtered before calibration — verified count stays clean", () => {
  // Case 6: raw pool had wrong-airline verified items (ANA 787 with ebay.com/itm/ URLs).
  // After identity lock, only clean Hawaiian 787 items remain (all pricing_signal).
  // urlSummary (clean) has verifiedListings=0; rawUrlSummary.total=15 (3 verified rejected + 12 clean).
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.9,
    identityQuality:  0.6,
    items:            makePricingSignalItems(12),   // 0 verified (wrong-airline filtered out)
    urlSummary:       { verifiedListings: 0, pricingOnly: 12, oracleEstimates: 0, total: 12 },
    rawUrlSummary:    { total: 15 },  // 3 filtered verified items in raw pool
    marketEvidence:   { confidence: "low", priceSpreadPct: 45, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.35 },
  });

  assert.equal(result.evidence.verifiedListingCount, 0, "filtered verified items must NOT count");
  assert.equal(result.canShowVerifiedLanguage, false, "no verified language after filtering");
  assert.ok(result.evidence.rejectionRatio > 0, "rejection ratio should reflect filtered items");
});

test("4B: Hawaiian 787 style — 0 verified stays 0 when no free recovery possible", () => {
  // Case 7: raw=40, clean=11, all ibp=oshop (no free extraction).
  // No URL_VERIFICATION_ENABLED → verifiedListings=0.
  // evidenceTier=pricing_signal_only, evidenceLimited, canShowVerifiedLanguage=false.
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.9,
    identityQuality:  0.55,
    items:            makePricingSignalItems(11),
    urlSummary:       { verifiedListings: 0, pricingOnly: 11, oracleEstimates: 0, total: 11 },
    rawUrlSummary:    { total: 40 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 80, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.25, typicalHigh: 95 },
    scannedPrice:     165.99,
    identitySummary:  {
      rejectedCompetitorCount:     2,
      rejectedModelMismatchCount:  1,
      rejectedMissingAirlineCount: 8,
      rejectedGenericToyCount:     3,
    },
    category: "model airplane",
    query:    "hawaiian airlines boeing 787 diecast model airplane",
  });

  assert.equal(result.evidence.verifiedListingCount, 0, "Hawaiian 787: 0 verified is correct honest result");
  assert.equal(result.evidence.pricingSignalCount, 11, "11 clean signals used");
  assert.equal(result.evidenceTier, "pricing_signal_only", "pricing_signal_only is correct");
  assert.equal(result.verdictStrengthCap, "evidence_limited", "evidence_limited for 0 verified");
  assert.equal(result.canShowVerifiedLanguage, false, "no verified language");
  assert.equal(result.canShowStrongLanguage, false, "no strong language");
  assert.ok(result.capReasons.includes("no_verified_listings"));
  assert.ok(result.capReasons.includes("wide_spread"));
  assert.ok(result.capReasons.includes("pricing_signal_against_high_scan_price"));
});

test("4B: If 2 verified listings recovered — tier improves to verified_moderate", () => {
  // Case 8: Phase 4B opt-in recovery succeeded for 2 items.
  // urlSummary now shows verifiedListings=2 from clean uiItems.
  // calibration should see verified_moderate, canShowVerifiedLanguage=true.
  const recovered = [
    { isVerifiedListing: true, evidenceQuality: "verified_listing", clickable: true,
      directUrl: "https://www.ebay.com/itm/111111111111", urlQuality: "merchant_direct",
      price: 68, source: "ebay-seller-a" },
    { isVerifiedListing: true, evidenceQuality: "verified_listing", clickable: true,
      directUrl: "https://www.ebay.com/itm/222222222222", urlQuality: "merchant_direct",
      price: 72, source: "ebay-seller-b" },
    { isVerifiedListing: true, evidenceQuality: "verified_listing", clickable: true,
      directUrl: "https://www.ebay.com/itm/333333333333", urlQuality: "merchant_direct",
      price: 75, source: "ebay-seller-c" },
    ...makePricingSignalItems(8),
  ];
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.9,
    identityQuality:  0.7,
    items:            recovered,
    urlSummary:       { verifiedListings: 3, pricingOnly: 8, oracleEstimates: 0, total: 11 },
    rawUrlSummary:    { total: 40 },
    marketEvidence:   { confidence: "medium", priceSpreadPct: 20, directUrlCount: 3 },
    consensus:        { marketConfidence: 0.65 },
  });

  assert.equal(result.evidence.verifiedListingCount, 3, "3 verified from recovery");
  assert.equal(result.evidenceTier, "verified_moderate", "tier improves to verified_moderate");
  assert.equal(result.canShowVerifiedLanguage, true, "verified language allowed");
  assert.equal(result.capApplied, true, "cap still applied since 0.9 > 0.85");
  assert.equal(result.confidenceCap, 0.85, "cap is 0.85 for verified_moderate");
});

// ── Phase 4B.2: exact identitySummary beats fallback approximation ────────────

test("exact identitySummary.totalRejectedCount=14 beats approx rawTotal-cleanComp=29", () => {
  const items = Array(11).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 65, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 11, oracleEstimates: 0, total: 11 },
    rawUrlSummary: { total: 40 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 30, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.40 },
    // Exact counts from Phase 4B.2 plumbing
    identitySummary: {
      rawCount:                    40,
      keptCount:                   11,
      rejectedCompetitorCount:     2,
      rejectedModelMismatchCount:  1,
      rejectedMissingAirlineCount: 8,
      rejectedGenericToyCount:     3,
      rejectedFamilyCount:         0,
      rejectedManufacturerCount:   0,
      rejectedMerchCount:          0,
      rejectedSneakerWrongLineCount: 0,
      rejectedSneakerWrongGenerationCount: 0,
      rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0,
      rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0,
      rejectedJordanWrongThemeCount: 0,
      rejectedJordanNonJordanCount: 0,
      rejectedOtherIdentityCount:  0,
      totalRejectedCount:          14,
      rejectionRatio:              0.56,  // 14/(14+11)
      appliedLocks:                ["airline", "aircraft_model_tier"],
      relaxed:                     false,
    },
  });
  // Calibration must use totalRejectedCount=14, not approx 40-11=29
  assert.equal(result.evidence.totalRejectedCount, 14, "exact totalRejectedCount=14 from identitySummary");
  assert.ok(result.evidence.rejectionRatio <= 0.57, `rejectionRatio should be ~0.56, got ${result.evidence.rejectionRatio}`);
  assert.ok(result.evidence.rejectionRatio >= 0.55, `rejectionRatio should be ~0.56, got ${result.evidence.rejectionRatio}`);
});

test("missing identitySummary falls back to rawUrlSummary approximation", () => {
  const items = Array(11).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 65, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 11, oracleEstimates: 0, total: 11 },
    rawUrlSummary: { total: 40 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 30, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.40 },
    identitySummary: null,  // explicit null → fallback
  });
  // With null identitySummary: approx = 40 - 11 = 29
  assert.equal(result.evidence.totalRejectedCount, 29, "fallback approx: 40-11=29");
});

test("rejectedCompetitorCount > 0 adds aircraft_competitor_match cap reason for aircraft category", () => {
  const items = Array(8).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 70, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 30, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.40 },
    category:      "model airplane",
    query:         "hawaiian airlines boeing 787 diecast",
    identitySummary: {
      ...{ rawCount: 20, keptCount: 8, totalRejectedCount: 2, rejectionRatio: 0.2,
           appliedLocks: ["airline"], relaxed: false,
           rejectedFamilyCount: 0, rejectedManufacturerCount: 0,
           rejectedModelMismatchCount: 0, rejectedMissingAirlineCount: 0,
           rejectedGenericToyCount: 0, rejectedMerchCount: 0,
           rejectedSneakerWrongLineCount: 0, rejectedSneakerWrongGenerationCount: 0,
           rejectedSneakerVariantCount: 0,
           rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
           rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 0,
           rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0 },
      rejectedCompetitorCount: 2,
    },
  });
  assert.ok(result.capReasons.includes("aircraft_competitor_match"), "aircraft_competitor_match should be in capReasons");
  assert.ok(result.capReasons.includes("competitor_brand_present"), "competitor_brand_present should also be in capReasons");
});

test("rejectedFamilyCount > 0 adds aircraft_family_mismatch cap reason", () => {
  const items = Array(6).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 70, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 6, oracleEstimates: 0, total: 6 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.40 },
    category:      "model airplane",
    query:         "boeing 787 diecast model",
    identitySummary: {
      rawCount: 10, keptCount: 6, totalRejectedCount: 1, rejectionRatio: 0.143,
      appliedLocks: ["aircraft_family"], relaxed: false,
      rejectedCompetitorCount: 0, rejectedFamilyCount: 1,
      rejectedManufacturerCount: 0, rejectedModelMismatchCount: 1,
      rejectedMissingAirlineCount: 0, rejectedGenericToyCount: 0,
      rejectedMerchCount: 0, rejectedSneakerWrongLineCount: 0,
      rejectedSneakerWrongGenerationCount: 0, rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 0,
      rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0,
    },
  });
  assert.ok(result.capReasons.includes("aircraft_family_mismatch"), "aircraft_family_mismatch should be in capReasons");
});

test("rejectedModelMismatchCount > 0 adds aircraft_model_mismatch (not aircraft_family_mismatch)", () => {
  const items = Array(6).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 70, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 6, oracleEstimates: 0, total: 6 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.40 },
    category:      "model airplane",
    query:         "hawaiian airlines boeing 787 diecast model",
    identitySummary: {
      rawCount: 10, keptCount: 6, totalRejectedCount: 1, rejectionRatio: 0.143,
      appliedLocks: ["aircraft_model_tier"], relaxed: false,
      rejectedCompetitorCount: 0, rejectedFamilyCount: 0,
      rejectedManufacturerCount: 0, rejectedModelMismatchCount: 1,
      rejectedMissingAirlineCount: 0, rejectedGenericToyCount: 0,
      rejectedMerchCount: 0, rejectedSneakerWrongLineCount: 0,
      rejectedSneakerWrongGenerationCount: 0, rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 0,
      rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0,
    },
  });
  assert.ok(result.capReasons.includes("aircraft_model_mismatch"), "aircraft_model_mismatch when rejectedModelMismatchCount>0");
  assert.ok(!result.capReasons.includes("aircraft_family_mismatch"), "no aircraft_family_mismatch when rejectedFamilyCount=0");
});

test("rejectedGenericToyCount > 0 adds aircraft_generic_toy_contamination", () => {
  const items = Array(6).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 70, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 6, oracleEstimates: 0, total: 6 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.40 },
    category:      "model airplane",
    query:         "hawaiian airlines boeing 787 diecast model",
    identitySummary: {
      rawCount: 12, keptCount: 6, totalRejectedCount: 3, rejectionRatio: 0.333,
      appliedLocks: ["aircraft_model_tier"], relaxed: false,
      rejectedCompetitorCount: 0, rejectedFamilyCount: 0,
      rejectedManufacturerCount: 0, rejectedModelMismatchCount: 0,
      rejectedMissingAirlineCount: 0, rejectedGenericToyCount: 3,
      rejectedMerchCount: 0, rejectedSneakerWrongLineCount: 0,
      rejectedSneakerWrongGenerationCount: 0, rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 0,
      rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0,
    },
  });
  assert.ok(result.capReasons.includes("aircraft_generic_toy_contamination"), "toy contamination reason present");
  assert.ok(!result.capReasons.includes("aircraft_family_mismatch"), "toy should NOT create a family_mismatch reason");
});

test("sneaker wrong generation does not create aircraft_family_mismatch reason", () => {
  const items = Array(6).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 220, source: "stockx",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.7,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 6, oracleEstimates: 0, total: 6 },
    marketEvidence:{ confidence: "medium", priceSpreadPct: 15, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.60 },
    category:      "sneakers",
    query:         "nike zoomx vaporfly next% 2",
    identitySummary: {
      rawCount: 10, keptCount: 6, totalRejectedCount: 4, rejectionRatio: 0.4,
      appliedLocks: ["sneaker_identity"], relaxed: false,
      rejectedCompetitorCount: 0, rejectedFamilyCount: 0,
      rejectedManufacturerCount: 0, rejectedModelMismatchCount: 0,
      rejectedMissingAirlineCount: 0, rejectedGenericToyCount: 0,
      rejectedMerchCount: 0, rejectedSneakerWrongLineCount: 2,
      rejectedSneakerWrongGenerationCount: 2, rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 0,
      rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0,
    },
  });
  // Sneaker gen rejections count toward totalRejectedCount and rejectionRatio but NOT aircraft reasons
  assert.equal(result.evidence.totalRejectedCount, 4);
  assert.ok(!result.capReasons.includes("aircraft_family_mismatch"), "sneaker gen != aircraft_family_mismatch");
  assert.ok(!result.capReasons.includes("aircraft_generic_toy_contamination"), "sneaker gen != toy contamination");
  assert.ok(!result.capReasons.includes("aircraft_competitor_match"), "sneaker gen != aircraft competitor");
});

test("Jordan wrong theme counts toward rejectionRatio but not aircraft-specific reasons", () => {
  const items = Array(5).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 180, source: "stockx",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.7,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 5, oracleEstimates: 0, total: 5 },
    marketEvidence:{ confidence: "medium", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.55 },
    category:      "sneakers",
    query:         "air jordan 1 low og year of the rabbit",
    identitySummary: {
      rawCount: 12, keptCount: 5, totalRejectedCount: 3, rejectionRatio: 0.375,
      appliedLocks: ["jordan_identity"], relaxed: false,
      rejectedCompetitorCount: 0, rejectedFamilyCount: 0,
      rejectedManufacturerCount: 0, rejectedModelMismatchCount: 0,
      rejectedMissingAirlineCount: 0, rejectedGenericToyCount: 0,
      rejectedMerchCount: 0, rejectedSneakerWrongLineCount: 1,
      rejectedSneakerWrongGenerationCount: 0, rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 2,
      rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0,
    },
  });
  assert.equal(result.evidence.totalRejectedCount, 3, "Jordan theme rejections in totalRejectedCount");
  assert.ok(!result.capReasons.includes("aircraft_competitor_match"), "Jordan theme != aircraft competitor");
  assert.ok(!result.capReasons.includes("aircraft_family_mismatch"), "Jordan theme != aircraft family mismatch");
});

test("identitySummary.totalRejectedCount=0 with cleanCompCount>0 does not add identity_lock_high_rejection_ratio", () => {
  const items = Array(8).fill(null).map(() => ({
    isVerifiedListing: false, evidenceQuality: "pricing_signal",
    clickable: false, price: 70, source: "ebay",
  }));
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.7,
    items,
    urlSummary:    { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:{ confidence: "medium", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.60 },
    identitySummary: {
      rawCount: 8, keptCount: 8, totalRejectedCount: 0, rejectionRatio: 0,
      appliedLocks: [], relaxed: false,
      rejectedCompetitorCount: 0, rejectedFamilyCount: 0,
      rejectedManufacturerCount: 0, rejectedModelMismatchCount: 0,
      rejectedMissingAirlineCount: 0, rejectedGenericToyCount: 0,
      rejectedMerchCount: 0, rejectedSneakerWrongLineCount: 0,
      rejectedSneakerWrongGenerationCount: 0, rejectedSneakerVariantCount: 0,
      rejectedJordanWrongModelCount: 0, rejectedJordanWrongCutCount: 0,
      rejectedJordanWrongSublineCount: 0, rejectedJordanWrongThemeCount: 0,
      rejectedJordanNonJordanCount: 0, rejectedOtherIdentityCount: 0,
    },
  });
  assert.ok(!result.capReasons.includes("identity_lock_high_rejection_ratio"),
    "zero rejections should not add identity_lock_high_rejection_ratio");
});

// ── Phase 4B.2.1: early retrieval identity summary calibration tests ──────────

test("exact early identity summary with totalRejectedCount 14 produces identity_lock_high_rejection_ratio", () => {
  // Simulates the merged summary from retrieval stage for Hawaiian 787 scan.
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    identityQuality:   0.55,
    items: Array(8).fill(null).map(() => ({
      isVerifiedListing: false, evidenceQuality: "pricing_signal",
      clickable: false, price: 65, source: "ebay",
    })),
    urlSummary:    { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 80, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.25, typicalHigh: 95 },
    scannedPrice:  165.99,
    identitySummary: {
      rawCount:                    36,
      keptCount:                    8,
      totalRejectedCount:          14,
      rejectionRatio:              Math.round((14 / 22) * 1000) / 1000,
      rejectedCompetitorCount:      1,
      rejectedModelMismatchCount:   0,
      rejectedMissingAirlineCount: 10,
      rejectedGenericToyCount:      3,
      appliedLocks: ["airline"],
    },
    category: "model airplane",
    query:    "hawaiian airlines boeing 787 diecast model airplane",
  });
  assert.ok(result.capReasons.includes("identity_lock_high_rejection_ratio"),
    "rejectionRatio ~0.636 > 0.25 must produce identity_lock_high_rejection_ratio");
  assert.equal(result.evidenceTier, "pricing_signal_only");
  assert.equal(result.canShowVerifiedLanguage, false);
  assert.equal(result.evidence.verifiedListingCount, 0);
  assert.equal(result.evidence.totalRejectedCount, 14);
});

test("competitor count on aircraft query produces aircraft_competitor_match and competitor_brand_present", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.6,
    items: Array(8).fill(null).map(() => ({
      isVerifiedListing: false, evidenceQuality: "pricing_signal",
      clickable: false, price: 70, source: "ebay",
    })),
    urlSummary:    { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 40, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.3 },
    identitySummary: {
      rawCount: 20, keptCount: 8, totalRejectedCount: 5,
      rejectionRatio: Math.round((5 / 13) * 1000) / 1000,
      rejectedCompetitorCount: 1,
      appliedLocks: ["airline"],
    },
    category: "model airplane",
    query: "hawaiian airlines boeing 787 diecast",
  });
  assert.ok(result.capReasons.includes("aircraft_competitor_match"),
    "rejectedCompetitorCount>0 on aircraft query must produce aircraft_competitor_match");
  assert.ok(result.capReasons.includes("competitor_brand_present"),
    "rejectedCompetitorCount>0 on aircraft query must produce competitor_brand_present");
});

test("generic toy count on aircraft query produces aircraft_generic_toy_contamination", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.85,
    identityQuality:  0.65,
    items: Array(8).fill(null).map(() => ({
      isVerifiedListing: false, evidenceQuality: "pricing_signal",
      clickable: false, price: 60, source: "ebay",
    })),
    urlSummary:    { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:{ confidence: "low", priceSpreadPct: 30, directUrlCount: 0 },
    consensus:     { marketConfidence: 0.3 },
    identitySummary: {
      rawCount: 15, keptCount: 8, totalRejectedCount: 3,
      rejectionRatio: Math.round((3 / 11) * 1000) / 1000,
      rejectedGenericToyCount: 3,
      appliedLocks: ["airline"],
    },
    category: "model airplane",
    query: "hawaiian airlines boeing 787 diecast",
  });
  assert.ok(result.capReasons.includes("aircraft_generic_toy_contamination"),
    "rejectedGenericToyCount>0 on aircraft query must produce aircraft_generic_toy_contamination");
  assert.equal(result.evidence.verifiedListingCount, 0);
  assert.equal(result.evidence.pricingSignalCount, 8);
});

test("returns correct shape with all required fields", () => {
  const result = calibrateEvidenceConfidence({});
  const topLevel = [
    "inputs", "evidence", "risks",
    "evidenceTier", "marketConfidence", "evidenceConfidence",
    "calibratedConfidence", "confidenceCap", "capApplied",
    "capReasons", "verdictStrengthCap",
    "canShowStrongLanguage", "canShowVerifiedLanguage", "canShowMedianAsAuthoritative",
    "explanationForLogs", "explanationForUI",
  ];
  for (const field of topLevel) {
    assert.ok(field in result, `missing top-level field: ${field}`);
  }
  const evidenceFields = [
    "verifiedListingCount", "pricingSignalCount", "oracleEstimateCount",
    "cleanCompCount", "marketMathEligibleCount",
    "rejectedCompetitorCount", "rejectedFamilyCount", "rejectedModelMismatchCount",
    "rejectedMissingAirlineCount", "rejectedGenericToyCount",
    "totalRejectedCount", "rejectionRatio", "sourceDiversity",
  ];
  for (const field of evidenceFields) {
    assert.ok(field in result.evidence, `missing evidence field: ${field}`);
  }
  const riskFields = ["spreadRisk", "identityRisk", "urlTrustRisk", "thinMarketRisk", "categoryRisk"];
  for (const field of riskFields) {
    assert.ok(field in result.risks, `missing risk field: ${field}`);
  }
});
