// src/visionCategoryPolicy.test.js
// Tests for vision-path category policy.
//
// Run: node --test src/visionCategoryPolicy.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBrandUsefulCategory,
  isTrueHighStakesVisionCategory,
  getVisionCategoryPolicy,
} from "./visionCategoryPolicy.js";

// ── isTrueHighStakesVisionCategory ───────────────────────────────────────────

describe("isTrueHighStakesVisionCategory", () => {
  // True high-stakes: always require master consensus.
  it("luxury is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("luxury"), true);
  });
  it("handbag is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("handbag"), true);
  });
  it("sneakers is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("sneakers"), true);
  });
  it("sneaker (singular) is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("sneaker"), true);
  });
  it("watch is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("watch"), true);
  });
  it("watches is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("watches"), true);
  });
  it("jewelry is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("jewelry"), true);
  });
  it("electronics is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("electronics"), true);
  });
  it("trading_card is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("trading_card"), true);
  });
  it("trading_cards is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("trading_cards"), true);
  });
  it("coin is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("coin"), true);
  });
  it("sports_card is true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("sports_card"), true);
  });

  // Brand-useful collectibles: NOT true high-stakes → fast lane OK.
  it("collectible is NOT true high-stakes (brand-useful)", () => {
    assert.equal(isTrueHighStakesVisionCategory("collectible"), false);
  });
  it("collectibles is NOT true high-stakes (brand-useful)", () => {
    assert.equal(isTrueHighStakesVisionCategory("collectibles"), false);
  });
  it("diecast model is NOT true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("diecast model"), false);
  });
  it("airplane model is NOT true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("airplane model"), false);
  });
  it("toy is NOT true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("toy"), false);
  });
  it("book is NOT true high-stakes", () => {
    assert.equal(isTrueHighStakesVisionCategory("book"), false);
  });
  it("empty string returns false", () => {
    assert.equal(isTrueHighStakesVisionCategory(""), false);
  });
  it("null returns false", () => {
    assert.equal(isTrueHighStakesVisionCategory(null), false);
  });
});

// ── isBrandUsefulCategory ─────────────────────────────────────────────────────

describe("isBrandUsefulCategory", () => {
  it("collectible is brand-useful", () => {
    assert.equal(isBrandUsefulCategory("collectible"), true);
  });
  it("collectibles is brand-useful", () => {
    assert.equal(isBrandUsefulCategory("collectibles"), true);
  });
  it("diecast is brand-useful", () => {
    assert.equal(isBrandUsefulCategory("diecast"), true);
  });
  it("diecast model is brand-useful", () => {
    assert.equal(isBrandUsefulCategory("diecast model"), true);
  });
  it("airplane model is brand-useful (contains 'model')", () => {
    assert.equal(isBrandUsefulCategory("airplane model"), true);
  });
  it("toy airplane is brand-useful (contains 'toy')", () => {
    assert.equal(isBrandUsefulCategory("toy airplane"), true);
  });
  it("book is brand-useful", () => {
    assert.equal(isBrandUsefulCategory("book"), true);
  });

  // NOT brand-useful
  it("luxury is NOT brand-useful", () => {
    assert.equal(isBrandUsefulCategory("luxury"), false);
  });
  it("sneakers is NOT brand-useful", () => {
    assert.equal(isBrandUsefulCategory("sneakers"), false);
  });
  it("watches is NOT brand-useful", () => {
    assert.equal(isBrandUsefulCategory("watches"), false);
  });
  it("electronics is NOT brand-useful", () => {
    assert.equal(isBrandUsefulCategory("electronics"), false);
  });
});

// ── getVisionCategoryPolicy ───────────────────────────────────────────────────

describe("getVisionCategoryPolicy", () => {
  it("collectible: not true-high-stakes, brand-useful, brandUsefulCollectible=true", () => {
    const p = getVisionCategoryPolicy("collectible");
    assert.equal(p.trueHighStakes, false);
    assert.equal(p.brandUseful, true);
    assert.equal(p.brandUsefulCollectible, true);
    assert.equal(p.reason, "brand_is_identity_fast_lane_ok");
  });

  it("collectibles: not true-high-stakes, brand-useful, brandUsefulCollectible=true", () => {
    const p = getVisionCategoryPolicy("collectibles");
    assert.equal(p.trueHighStakes, false);
    assert.equal(p.brandUsefulCollectible, true);
  });

  it("diecast model: not true-high-stakes, brand-useful, brandUsefulCollectible=true", () => {
    const p = getVisionCategoryPolicy("diecast model");
    assert.equal(p.trueHighStakes, false);
    assert.equal(p.brandUseful, true);
    assert.equal(p.brandUsefulCollectible, true);
  });

  it("airplane model: not true-high-stakes, brand-useful", () => {
    const p = getVisionCategoryPolicy("airplane model");
    assert.equal(p.trueHighStakes, false);
    assert.equal(p.brandUseful, true);
  });

  it("sneakers: true-high-stakes, not brand-useful, not brandUsefulCollectible", () => {
    const p = getVisionCategoryPolicy("sneakers");
    assert.equal(p.trueHighStakes, true);
    assert.equal(p.brandUseful, false);
    assert.equal(p.brandUsefulCollectible, false);
    assert.equal(p.reason, "auth_sensitive_requires_master");
  });

  it("luxury: true-high-stakes", () => {
    const p = getVisionCategoryPolicy("luxury");
    assert.equal(p.trueHighStakes, true);
    assert.equal(p.brandUsefulCollectible, false);
  });

  it("watches: true-high-stakes", () => {
    const p = getVisionCategoryPolicy("watches");
    assert.equal(p.trueHighStakes, true);
  });

  it("trading_cards: true-high-stakes", () => {
    assert.equal(getVisionCategoryPolicy("trading_cards").trueHighStakes, true);
  });

  it("electronics: true-high-stakes", () => {
    assert.equal(getVisionCategoryPolicy("electronics").trueHighStakes, true);
  });

  it("empty string: not true-high-stakes, not brand-useful", () => {
    const p = getVisionCategoryPolicy("");
    assert.equal(p.trueHighStakes, false);
    assert.equal(p.brandUseful, false);
    assert.equal(p.brandUsefulCollectible, false);
  });

  it("normalizes uppercase and trims whitespace", () => {
    const p = getVisionCategoryPolicy("  Collectible  ");
    assert.equal(p.category, "collectible");
    assert.equal(p.brandUsefulCollectible, true);
  });
});

// ── Integration-style: verify the fast-lane decision for key scan types ──────

describe("fast-lane eligibility (integration)", () => {
  // These tests directly verify the key property: if trueHighStakes=false,
  // the query_fast gate can accept the result (the other gate is brandGateFails,
  // which is about brandCertainty, not category).

  it("Hawaiian Airlines Boeing 787 diecast category is fast-lane eligible", () => {
    // Model might return: "collectible", "diecast model", "airplane model", "collectibles"
    const candidates = ["collectible", "collectibles", "diecast model", "airplane model", "aircraft model", "die cast model"];
    for (const cat of candidates) {
      assert.equal(
        isTrueHighStakesVisionCategory(cat),
        false,
        `"${cat}" should NOT be true-high-stakes (diecast aircraft)`
      );
    }
  });

  it("ANA Airbus A380 diecast category is fast-lane eligible", () => {
    const candidates = ["collectible", "diecast", "model airplane", "airplane model"];
    for (const cat of candidates) {
      assert.equal(isTrueHighStakesVisionCategory(cat), false,
        `"${cat}" should NOT be true-high-stakes`);
    }
  });

  it("luxury handbag (Hermès, LV) is NOT fast-lane eligible", () => {
    assert.equal(isTrueHighStakesVisionCategory("luxury"), true);
    assert.equal(isTrueHighStakesVisionCategory("handbag"), true);
    assert.equal(isTrueHighStakesVisionCategory("handbags"), true);
  });

  it("Jordan 1 / Vaporfly (sneakers) are NOT fast-lane eligible", () => {
    assert.equal(isTrueHighStakesVisionCategory("sneakers"), true);
    assert.equal(isTrueHighStakesVisionCategory("sneaker"), true);
  });

  it("graded trading card is NOT fast-lane eligible", () => {
    assert.equal(isTrueHighStakesVisionCategory("trading_card"), true);
    assert.equal(isTrueHighStakesVisionCategory("sports_card"), true);
  });

  it("Rolex / AP watch is NOT fast-lane eligible", () => {
    assert.equal(isTrueHighStakesVisionCategory("watch"), true);
    assert.equal(isTrueHighStakesVisionCategory("watches"), true);
  });

  it("iPhone / electronics is NOT fast-lane eligible", () => {
    assert.equal(isTrueHighStakesVisionCategory("electronics"), true);
  });
});
