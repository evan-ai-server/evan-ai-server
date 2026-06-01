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

test("Hawaiian 787 style: 0 verified, 37 signals, wide spread, high rejection → pricing_signal_only, evidence_limited", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence:  0.9,
    brandCertainty:    0.8,
    identityQuality:   0.55,
    items:             Array(13).fill(null).map(() => ({
      isVerifiedListing: false, evidenceQuality: "pricing_signal",
      clickable: false, price: 65, source: "ebay",
    })),
    urlSummary:        { verifiedListings: 0, pricingOnly: 37, oracleEstimates: 0, total: 37 },
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
  assert.equal(result.evidence.pricingSignalCount, 37);
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

test("identitySummary=null falls back to urlSummary.total approximation", () => {
  const result = calibrateEvidenceConfidence({
    visionConfidence: 0.8,
    identityQuality:  0.5,
    items:            makePricingSignalItems(10),
    urlSummary:       { verifiedListings: 0, pricingOnly: 20, oracleEstimates: 0, total: 30 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 30, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.4 },
    identitySummary:  null,
  });

  // totalRejectedCount ≈ 30 - 10 = 20; rejectionRatio = 20/30 ≈ 0.67
  assert.ok(result.evidence.totalRejectedCount >= 0, "totalRejectedCount should be non-negative");
  assert.ok(result.evidence.rejectionRatio > 0, "rejectionRatio should be positive with null identitySummary");
  assert.ok(result.capReasons.includes("no_verified_listings"));
});

test("canShowMedianAsAuthoritative only with enough clean comps and tight spread", () => {
  const tightResult = calibrateEvidenceConfidence({
    visionConfidence: 0.7,
    items:            makePricingSignalItems(5),
    urlSummary:       { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:   { confidence: "medium", priceSpreadPct: 20, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.65 },
  });
  assert.equal(tightResult.canShowMedianAsAuthoritative, true, "tight spread + enough comps");

  const wideResult = calibrateEvidenceConfidence({
    visionConfidence: 0.7,
    items:            makePricingSignalItems(5),
    urlSummary:       { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
    marketEvidence:   { confidence: "low", priceSpreadPct: 80, directUrlCount: 0 },
    consensus:        { marketConfidence: 0.20 },
  });
  assert.equal(wideResult.canShowMedianAsAuthoritative, false, "wide spread blocks median authority");
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
