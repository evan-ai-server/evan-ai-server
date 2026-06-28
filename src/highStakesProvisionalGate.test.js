// src/highStakesProvisionalGate.test.js
// Phase 5D.1D — Tests for the high-stakes provisional gate (Option B guard).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateHighStakesProvisional } from "./highStakesProvisionalGate.js";

describe("evaluateHighStakesProvisional", () => {
  // ── Specific provisional allowed ──────────────────────────────────────────

  it("Apple Watch Ultra high-confidence → specific provisional", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Ultra", category: "watch",
      confidence: 0.95, brandCertainty: 0.90, mode: "item",
    });
    assert.equal(r.eligible, true, "should be eligible");
    assert.equal(r.specificProvisional, true, "should allow specific provisional");
    assert.equal(r.provisionalQuery, "Apple Watch Ultra");
    assert.equal(r.provisionalCategory, "watch");
    assert.equal(r.reason, "accepted");
  });

  it("Nike Air Jordan 1 Retro high-confidence sneaker → specific provisional", () => {
    const r = evaluateHighStakesProvisional({
      query: "Nike Air Jordan 1 Retro High OG", category: "sneakers",
      confidence: 0.94, brandCertainty: 0.91, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, true);
    assert.equal(r.provisionalQuery, "Nike Air Jordan 1 Retro High OG");
  });

  it("Louis Vuitton Neverfull MM high-confidence → specific provisional", () => {
    const r = evaluateHighStakesProvisional({
      query: "Louis Vuitton Neverfull MM", category: "handbag",
      confidence: 0.93, brandCertainty: 0.88, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, true);
  });

  // ── Category-only provisional (specific rejected) ─────────────────────────

  it("generic smartwatch → category-only provisional", () => {
    const r = evaluateHighStakesProvisional({
      query: "smartwatch", category: "watch",
      confidence: 0.80, brandCertainty: 0.30, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, false);
    assert.equal(r.provisionalQuery, null);
    assert.equal(r.provisionalCategory, "watch");
  });

  it("Rolex Submariner confidence too low → category-only", () => {
    const r = evaluateHighStakesProvisional({
      query: "Rolex Submariner", category: "watch",
      confidence: 0.75, brandCertainty: 0.85, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, false);
    assert.equal(r.reason, "confidence_below_threshold");
  });

  it("Rolex Submariner brand certainty too low → category-only", () => {
    const r = evaluateHighStakesProvisional({
      query: "Rolex Submariner", category: "watch",
      confidence: 0.93, brandCertainty: 0.50, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, false);
    assert.equal(r.reason, "brand_certainty_below_threshold");
  });

  it("single-word brand query → category-only even at high confidence", () => {
    const r = evaluateHighStakesProvisional({
      query: "Rolex", category: "watch",
      confidence: 0.95, brandCertainty: 0.92, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, false);
    assert.equal(r.reason, "generic_query");
  });

  it("missing query → category-only provisional", () => {
    const r = evaluateHighStakesProvisional({
      query: null, category: "watch",
      confidence: 0.93, brandCertainty: 0.90, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, false);
    assert.equal(r.provisionalQuery, null);
    assert.equal(r.provisionalCategory, "watch");
    assert.equal(r.reason, "no_query");
  });

  // ── Ineligible ────────────────────────────────────────────────────────────

  it("missing category → ineligible", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Ultra", category: "",
      confidence: 0.95, brandCertainty: 0.90, mode: "item",
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "no_category");
    assert.equal(r.provisionalCategory, "");
  });

  it("label mode → ineligible (unsupported)", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Ultra", category: "watch",
      confidence: 0.95, brandCertainty: 0.90, mode: "label",
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "unsupported_mode");
  });

  // ── Trust guard: gate never sets trust-lock fields ────────────────────────

  it("provisional gate never adds marketAllowed, affiliateAllowed, or confirmed fields", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Ultra", category: "watch",
      confidence: 0.95, brandCertainty: 0.90, mode: "item",
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "marketAllowed"),     "no marketAllowed");
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "affiliateAllowed"),  "no affiliateAllowed");
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "confirmed"),         "no confirmed");
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "verifiedLanguageAllowed"), "no verifiedLanguageAllowed");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("prop mode is eligible (same as item)", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Ultra", category: "watch",
      confidence: 0.95, brandCertainty: 0.90, mode: "prop",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, true);
  });

  it("exact confidence/brand threshold boundary — 0.92/0.80 → accepted", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Series 9", category: "watch",
      confidence: 0.92, brandCertainty: 0.80, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, true);
  });

  it("just below confidence threshold — 0.919 → category-only", () => {
    const r = evaluateHighStakesProvisional({
      query: "Apple Watch Series 9", category: "watch",
      confidence: 0.919, brandCertainty: 0.90, mode: "item",
    });
    assert.equal(r.eligible, true);
    assert.equal(r.specificProvisional, false);
    assert.equal(r.reason, "confidence_below_threshold");
  });
});
