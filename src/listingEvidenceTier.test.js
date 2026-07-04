import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveListingEvidenceTier } from "./listingEvidenceTier.js";

test("verified_listing evidenceQuality maps to verified_listing tier", () => {
  const result = deriveListingEvidenceTier({ evidenceQuality: "verified_listing" });
  assert.deepEqual(result, {
    evidenceTier: "verified_listing",
    evidenceBadge: "Verified",
    verified: true,
    pricingSignalOnly: false,
  });
});

test("oracle_estimate evidenceQuality maps to model_estimate tier", () => {
  const result = deriveListingEvidenceTier({ evidenceQuality: "oracle_estimate" });
  assert.deepEqual(result, {
    evidenceTier: "model_estimate",
    evidenceBadge: "AI estimate",
    verified: false,
    pricingSignalOnly: false,
  });
});

test("pricing_signal evidenceQuality maps to pricing_signal_only tier", () => {
  const result = deriveListingEvidenceTier({ evidenceQuality: "pricing_signal" });
  assert.deepEqual(result, {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
});

test("legacy_unknown and other/unrecognized evidenceQuality default to pricing_signal_only", () => {
  const legacy = deriveListingEvidenceTier({ evidenceQuality: "legacy_unknown" });
  const bogus  = deriveListingEvidenceTier({ evidenceQuality: "some_future_value" });
  for (const result of [legacy, bogus]) {
    assert.deepEqual(result, {
      evidenceTier: "pricing_signal_only",
      evidenceBadge: "Price signal",
      verified: false,
      pricingSignalOnly: true,
    });
  }
});

test("missing/empty item defaults to pricing_signal_only without throwing", () => {
  assert.deepEqual(deriveListingEvidenceTier(), {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
  assert.deepEqual(deriveListingEvidenceTier({}), {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
  assert.deepEqual(deriveListingEvidenceTier(null), {
    evidenceTier: "pricing_signal_only",
    evidenceBadge: "Price signal",
    verified: false,
    pricingSignalOnly: true,
  });
});
