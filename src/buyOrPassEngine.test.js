// src/buyOrPassEngine.test.js
// node --test src/buyOrPassEngine.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBuyOrPass } from "./buyOrPassEngine.js";

// ── bundle helpers ────────────────────────────────────────────────────────────

// Minimum bundle to clear the empty-evidence guard (listingCount > 0)
function baseBundle(overrides = {}) {
  return {
    consensus: { listingCount: 8, median: 200 },
    scannedPrice: 150,
    ...overrides,
  };
}

// Calibration block for pricing_signal_only (unverified, evidence_limited)
function weakCalibration() {
  return {
    evidenceTier:          "pricing_signal_only",
    verdictStrengthCap:    "evidence_limited",
    canShowVerifiedLanguage: false,
    canShowStrongLanguage:   false,
    capReasons:            [],
    evidence: {
      verifiedListingCount: 0,
      pricingSignalCount:   10,
      cleanCompCount:       10,
    },
  };
}

// Calibration block for verified_strong (real comps, strong evidence)
function strongCalibration() {
  return {
    evidenceTier:          "verified_strong",
    verdictStrengthCap:    "strong",
    canShowVerifiedLanguage: true,
    canShowStrongLanguage:   true,
    capReasons:            [],
    evidence: {
      verifiedListingCount: 6,
      pricingSignalCount:   0,
      cleanCompCount:       6,
    },
  };
}

const SOLD_WORDS = ["recent sales", "sold comps", "sale history", "recent comps", "sold"];

function hasSoldLanguage(result) {
  const fields = [
    ...(result.supportingSignals || []),
    ...(result.riskFlags || []),
    result.oneLineReason || "",
    result.topSignal || "",
  ];
  return fields.some(f => SOLD_WORDS.some(w => f.toLowerCase().includes(w)));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("pricing_signal_only + verifiedListingCount=0: no sold/recent-sales language", () => {
  const result = computeBuyOrPass(baseBundle({
    flipScore:   { flipScore: { score: 60 } }, // triggers "Margin holds on recent sales" branch
    riskScore:   { tier: "safe" },             // triggers "Clean recent sale history" branch
    calibration: weakCalibration(),
    priceProjection: { projection: { verdict: "WAIT" } }, // triggers "Recent comps trending down"
    dealComparator: { verdict: "high" },       // triggers "Above market on recent comps"
  }));

  assert.ok(!hasSoldLanguage(result),
    `no sold/recent-sales language allowed on unverified evidence.\n` +
    `supportingSignals: ${JSON.stringify(result.supportingSignals)}\n` +
    `riskFlags: ${JSON.stringify(result.riskFlags)}\n` +
    `oneLineReason: ${JSON.stringify(result.oneLineReason)}`
  );

  // Replacement copy must reference pricing signal / direct comps / evidence limitation
  const allCopy = [
    ...result.supportingSignals,
    ...result.riskFlags,
    result.oneLineReason || "",
  ].join(" ").toLowerCase();

  assert.ok(
    allCopy.includes("signal") || allCopy.includes("direct comps") || allCopy.includes("verify") || allCopy.includes("not verified"),
    `replacement copy should reference pricing signal or verification: "${allCopy}"`
  );
});

test("evidence_limited + canShowVerifiedLanguage=false: no sold language in any field", () => {
  const result = computeBuyOrPass(baseBundle({
    flipScore:   { flipScore: { score: 75 } }, // triggers "Strong margin on recent sales" (score >= 72)
    riskScore:   { tier: "safe" },
    calibration: weakCalibration(),
  }));

  // Check every consumer-visible field
  for (const sig of result.supportingSignals) {
    assert.ok(!SOLD_WORDS.some(w => sig.toLowerCase().includes(w)),
      `supportingSignal must not contain sold language: "${sig}"`);
  }
  for (const flag of result.riskFlags) {
    assert.ok(!SOLD_WORDS.some(w => flag.toLowerCase().includes(w)),
      `riskFlag must not contain sold language: "${flag}"`);
  }
  assert.ok(!SOLD_WORDS.some(w => (result.oneLineReason || "").toLowerCase().includes(w)),
    `oneLineReason must not contain sold language: "${result.oneLineReason}"`);
  assert.ok(!SOLD_WORDS.some(w => (result.topSignal || "").toLowerCase().includes(w)),
    `topSignal must not contain sold language: "${result.topSignal}"`);
});

test("thin margin (flip<38) on pricing_signal_only: riskFlag uses signal language, not 'recent sales'", () => {
  const result = computeBuyOrPass(baseBundle({
    flipScore:   { flipScore: { score: 30 } }, // triggers thin margin path
    calibration: weakCalibration(),
  }));

  const thinFlag = result.riskFlags.find(f => f.toLowerCase().includes("margin") || f.toLowerCase().includes("thin"));
  // If the flag exists, it must not say "recent sales"
  if (thinFlag) {
    assert.ok(!thinFlag.toLowerCase().includes("recent sales"),
      `thin-margin riskFlag must not say "recent sales": "${thinFlag}"`);
    assert.ok(!thinFlag.toLowerCase().includes("sold"),
      `thin-margin riskFlag must not say "sold": "${thinFlag}"`);
  }
});

test("priceProjection WAIT on pricing_signal_only: riskFlag uses signal language, not 'recent comps'", () => {
  const result = computeBuyOrPass(baseBundle({
    priceProjection: { projection: { verdict: "WAIT" } },
    calibration:     weakCalibration(),
  }));

  const waitFlag = result.riskFlags.find(f => f.toLowerCase().includes("trending") || f.toLowerCase().includes("signal"));
  if (waitFlag) {
    assert.ok(!waitFlag.toLowerCase().includes("recent comps"),
      `WAIT riskFlag must not say "recent comps": "${waitFlag}"`);
  }
});

test("verified_strong + verifiedListingCount>0 + canShowVerifiedLanguage=true: sales language allowed", () => {
  // With real verified comps the engine may emit "recent sales" phrasing.
  // We don't force it to — we just confirm the gate doesn't suppress it.
  const result = computeBuyOrPass(baseBundle({
    flipScore:   { flipScore: { score: 60 } }, // score 55–71 → "Margin holds" branch
    riskScore:   { tier: "safe" },
    calibration: strongCalibration(),
  }));

  // The gate is open — "Margin holds on recent sales" and "Clean recent sale history"
  // are both allowed. Check at least one fired (confirming the gate opened).
  const allCopy = [...result.supportingSignals, ...result.riskFlags].join(" ");
  assert.ok(
    allCopy.includes("recent sales") || allCopy.includes("sale history") || allCopy.includes("recent comps"),
    `with verified evidence, sales language should be permitted: "${allCopy}"`
  );
});

test("HOLD verdict with pricing_signal_only: verdict stays HOLD, no sales-proof language", () => {
  const result = computeBuyOrPass(baseBundle({
    flipScore:   { flipScore: { score: 60 } },
    calibration: weakCalibration(),
    // score will land in HOLD range (40-64) with neutral inputs
  }));

  assert.equal(result.verdict, "HOLD", `verdict should be HOLD, got ${result.verdict}`);
  assert.ok(!hasSoldLanguage(result),
    `HOLD + pricing_signal_only must not have sold language:\n` +
    `signals: ${JSON.stringify(result.supportingSignals)}\n` +
    `flags: ${JSON.stringify(result.riskFlags)}`
  );
});

test("PASS verdict with pricing_signal_only: verdict stays PASS, no sales-proof language", () => {
  // Force PASS via risk_avoid hard disqualifier
  const result = computeBuyOrPass(baseBundle({
    riskScore:   { tier: "avoid" },
    flipScore:   { flipScore: { score: 60 } },
    calibration: weakCalibration(),
  }));

  assert.equal(result.verdict, "PASS", `verdict should be PASS, got ${result.verdict}`);
  assert.ok(!hasSoldLanguage(result),
    `PASS + pricing_signal_only must not have sold language:\n` +
    `signals: ${JSON.stringify(result.supportingSignals)}\n` +
    `flags: ${JSON.stringify(result.riskFlags)}`
  );
});

test("no calibration object: defaults to no verified evidence (safe fallback)", () => {
  // When calibration is absent, _hasVerifiedEvidence=false → conservative copy
  const result = computeBuyOrPass(baseBundle({
    flipScore: { flipScore: { score: 60 } },
    riskScore: { tier: "safe" },
    // calibration deliberately omitted
  }));

  assert.ok(!hasSoldLanguage(result),
    `missing calibration should default to conservative (no sold language):\n` +
    `signals: ${JSON.stringify(result.supportingSignals)}\n` +
    `flags: ${JSON.stringify(result.riskFlags)}`
  );
});

test("verdict field is never mutated by the copy gate", () => {
  // Confirm the gate touches only copy, not the verdict or confidence
  const withWeak   = computeBuyOrPass(baseBundle({ flipScore: { flipScore: { score: 60 } }, calibration: weakCalibration() }));
  const withStrong = computeBuyOrPass(baseBundle({ flipScore: { flipScore: { score: 60 } }, calibration: strongCalibration() }));

  // Same numeric score → same verdict regardless of calibration tier
  assert.equal(withWeak.verdict,   withStrong.verdict,   "verdict must not differ between weak/strong calibration with same score");
  assert.equal(withWeak.confidence, withStrong.confidence, "confidence must not differ between weak/strong calibration with same score");
});
