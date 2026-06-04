// src/affiliateGate.test.js
// node --test src/affiliateGate.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAffiliateEligibility,
  evaluateAffiliateEligibilityForPayload,
} from "./affiliateGate.js";

const WEAK = new Set(["RISKY", "INSUFFICIENT DATA", "OVERPRICED"]);

// A fully-eligible base case: genuine BUY on verified-strong evidence.
function eligibleInput(overrides = {}) {
  return {
    signal: "STRONG BUY",
    trustScore: 0.8,
    minTrust: 0.45,
    weakSignals: WEAK,
    verdict: "BUY",
    evidenceTier: "verified_strong",
    verdictStrengthCap: "strong",
    verifiedListingCount: 4,
    canShowStrongLanguage: true,
    ...overrides,
  };
}

test("fully-eligible BUY on verified-strong evidence attaches", () => {
  const r = evaluateAffiliateEligibility(eligibleInput());
  assert.equal(r.eligible, true);
  assert.equal(r.reason, null);
});

test("HOLD blocks affiliate (verdict_not_buy)", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ verdict: "HOLD" }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "verdict_not_buy");
});

test("PASS blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ verdict: "PASS" }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "verdict_not_buy");
});

test("pricing_signal_only evidence tier blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ evidenceTier: "pricing_signal_only" }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "weak_evidence_tier");
});

test("evidence_limited verdict strength cap blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ verdictStrengthCap: "evidence_limited" }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "evidence_limited");
});

test("zero verified listings blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ verifiedListingCount: 0 }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "no_verified_listings");
});

test("canShowStrongLanguage=false blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ canShowStrongLanguage: false }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "cannot_show_strong");
});

test("trust below threshold blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ trustScore: 0.3 }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "trust_below_threshold");
});

test("weak signal blocks affiliate", () => {
  const r = evaluateAffiliateEligibility(eligibleInput({ signal: "RISKY" }));
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "weak_signal");
});

// ── Regression: the live Hawaiian 787 case that wrongly attached GOOD DEAL ─────
test("HOLD + pricing_signal_only + evidence_limited + verified=0 (the live bug) blocks", () => {
  const payload = {
    buyOrPass: { verdict: "HOLD" },
    confidenceCalibration: {
      evidenceTier: "pricing_signal_only",
      verdictStrengthCap: "evidence_limited",
      canShowStrongLanguage: false,
      evidence: { verifiedListingCount: 0 },
    },
  };
  const r = evaluateAffiliateEligibilityForPayload(payload, {
    signal: "GOOD DEAL", trustScore: 0.66, minTrust: 0.45, weakSignals: WEAK,
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "verdict_not_buy");
});

test("payload wrapper allows a verified BUY", () => {
  const payload = {
    buyOrPass: { verdict: "BUY" },
    confidenceCalibration: {
      evidenceTier: "verified_strong",
      verdictStrengthCap: "strong",
      canShowStrongLanguage: true,
      evidence: { verifiedListingCount: 3 },
    },
  };
  const r = evaluateAffiliateEligibilityForPayload(payload, {
    signal: "STRONG BUY", trustScore: 0.7, minTrust: 0.45, weakSignals: WEAK,
  });
  assert.equal(r.eligible, true);
});
