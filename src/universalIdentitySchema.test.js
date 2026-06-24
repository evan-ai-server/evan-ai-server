import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENCE_LABELS,
  computeConfidenceLabel,
  enrichIdentityWithSchema,
  isHighStakesBrand,
} from "./universalIdentitySchema.js";

describe("CONFIDENCE_LABELS", () => {
  it("exports exactly five labels in order", () => {
    assert.deepStrictEqual(CONFIDENCE_LABELS, [
      "confirmed",
      "likely",
      "possible",
      "unknown",
      "insufficient_evidence",
    ]);
  });
});

describe("isHighStakesBrand", () => {
  it("returns true for Rolex", () => {
    assert.strictEqual(isHighStakesBrand("Rolex"), true);
  });
  it("returns true for Chanel", () => {
    assert.strictEqual(isHighStakesBrand("Chanel"), true);
  });
  it("returns true for Louis Vuitton", () => {
    assert.strictEqual(isHighStakesBrand("Louis Vuitton"), true);
  });
  it("returns false for Hanes", () => {
    assert.strictEqual(isHighStakesBrand("Hanes"), false);
  });
  it("returns false for null", () => {
    assert.strictEqual(isHighStakesBrand(null), false);
  });
  it("returns false for empty string", () => {
    assert.strictEqual(isHighStakesBrand(""), false);
  });
  it("returns false for undefined", () => {
    assert.strictEqual(isHighStakesBrand(undefined), false);
  });
});

describe("computeConfidenceLabel", () => {
  it("returns confirmed for strong evidence", () => {
    assert.strictEqual(
      computeConfidenceLabel({
        confidence: 0.92,
        attributeCertainty: { brand: 0.90 },
        visibleText: ["Nike"],
        brand: "Nike",
      }),
      "confirmed"
    );
  });

  it("returns likely for decent evidence", () => {
    assert.strictEqual(
      computeConfidenceLabel({
        confidence: 0.70,
        attributeCertainty: { brand: 0.55 },
        brand: "Sony",
      }),
      "likely"
    );
  });

  it("returns possible for partial evidence", () => {
    assert.strictEqual(
      computeConfidenceLabel({
        confidence: 0.45,
        attributeCertainty: { brand: 0.35 },
      }),
      "possible"
    );
  });

  it("returns unknown for weak evidence above floor", () => {
    assert.strictEqual(
      computeConfidenceLabel({
        confidence: 0.20,
        attributeCertainty: { brand: 0.10 },
      }),
      "unknown"
    );
  });

  it("returns insufficient_evidence for very low confidence", () => {
    assert.strictEqual(
      computeConfidenceLabel({ confidence: 0.05 }),
      "insufficient_evidence"
    );
  });

  it("returns insufficient_evidence for zero input", () => {
    assert.strictEqual(computeConfidenceLabel(), "insufficient_evidence");
  });

  it("high-stakes confirmed requires visible text and brand", () => {
    assert.strictEqual(
      computeConfidenceLabel({
        confidence: 0.92,
        attributeCertainty: { brand: 0.85 },
        visibleText: ["ROLEX"],
        highStakes: true,
        brand: "Rolex",
      }),
      "confirmed"
    );
  });

  it("high-stakes without text caps at likely even with high brand cert", () => {
    const label = computeConfidenceLabel({
      confidence: 0.92,
      attributeCertainty: { brand: 0.85 },
      visibleText: [],
      highStakes: true,
      brand: "Rolex",
    });
    assert.notStrictEqual(label, "confirmed");
    assert.strictEqual(label, "likely");
  });

  it("high-stakes returns unknown for low confidence", () => {
    assert.strictEqual(
      computeConfidenceLabel({
        confidence: 0.25,
        attributeCertainty: { brand: 0.15 },
        highStakes: true,
      }),
      "unknown"
    );
  });

  it("negative authenticity flags prevent confirmed for high-stakes", () => {
    assert.notStrictEqual(
      computeConfidenceLabel({
        confidence: 0.92,
        attributeCertainty: { brand: 0.90 },
        visibleText: ["Gucci"],
        authenticityFlags: ["logo_proportions_off"],
        highStakes: true,
        brand: "Gucci",
      }),
      "confirmed"
    );
  });
});

describe("enrichIdentityWithSchema", () => {
  const baseIdentity = {
    itemType: "sneakers",
    category: "sneakers",
    brand: "Nike",
    model: "Air Force 1",
    colors: ["white"],
    materials: ["leather"],
    patterns: [],
    styleWords: ["low top"],
    visibleText: ["Nike", "Air Force 1"],
    condition: "good",
    sizeHint: "10",
    imageHash: "abc123",
    exactQuery: "Nike Air Force 1 white leather",
    searchQueries: ["Nike Air Force 1 white", "Nike AF1"],
    substituteCandidates: [],
    marketSegment: "premium",
  };

  it("preserves all existing fields", () => {
    const result = enrichIdentityWithSchema(baseIdentity, {
      attributeCertainty: { brand: 0.80 },
      overallConfidence: 0.85,
    });
    assert.strictEqual(result.itemType, "sneakers");
    assert.strictEqual(result.category, "sneakers");
    assert.strictEqual(result.brand, "Nike");
    assert.strictEqual(result.model, "Air Force 1");
    assert.deepStrictEqual(result.colors, ["white"]);
    assert.deepStrictEqual(result.materials, ["leather"]);
    assert.strictEqual(result.condition, "good");
    assert.strictEqual(result.sizeHint, "10");
    assert.strictEqual(result.imageHash, "abc123");
    assert.strictEqual(result.exactQuery, "Nike Air Force 1 white leather");
    assert.deepStrictEqual(result.searchQueries, ["Nike Air Force 1 white", "Nike AF1"]);
    assert.strictEqual(result.marketSegment, "premium");
  });

  it("does not mutate input", () => {
    const copy = { ...baseIdentity };
    enrichIdentityWithSchema(copy, {
      attributeCertainty: { brand: 0.80 },
      overallConfidence: 0.85,
    });
    assert.deepStrictEqual(copy, baseIdentity);
  });

  it("returns safe defaults for empty identity", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.subtype, null);
    assert.strictEqual(result.series, null);
    assert.strictEqual(result.genderTarget, null);
    assert.deepStrictEqual(result.distinguishingFeatures, []);
    assert.ok(Array.isArray(result.missingEvidence));
    assert.strictEqual(result.evidenceSource, null);
    assert.strictEqual(result.confidenceLabel, "insufficient_evidence");
    assert.strictEqual(result.highStakes, false);
    assert.strictEqual(result.luxuryCandidate, false);
    assert.strictEqual(result.authenticityClaimAllowed, false);
    assert.deepStrictEqual(result.queryTermsAllowed, []);
    assert.deepStrictEqual(result.queryTermsBlocked, []);
    assert.deepStrictEqual(result.identityWarnings, []);
    assert.strictEqual(result.conditionNotes, null);
    assert.strictEqual(result.broadQuery, null);
    assert.strictEqual(result.categoryFallbackQuery, null);
    assert.strictEqual(result.visualDescriptorQuery, null);
  });

  it("returns safe defaults for null identity", () => {
    const result = enrichIdentityWithSchema(null, {});
    assert.strictEqual(result.confidenceLabel, "insufficient_evidence");
    assert.strictEqual(result.highStakes, false);
  });

  it("passes through conditionNotes", () => {
    const result = enrichIdentityWithSchema(
      { conditionNotes: "minor scuff on toe" },
      {}
    );
    assert.strictEqual(result.conditionNotes, "minor scuff on toe");
  });

  it("passes through broadQuery", () => {
    const result = enrichIdentityWithSchema(
      { broadQuery: "white sneakers" },
      {}
    );
    assert.strictEqual(result.broadQuery, "white sneakers");
  });

  it("passes through categoryFallbackQuery", () => {
    const result = enrichIdentityWithSchema(
      { categoryFallbackQuery: "athletic shoes" },
      {}
    );
    assert.strictEqual(result.categoryFallbackQuery, "athletic shoes");
  });

  it("passes through visualDescriptorQuery", () => {
    const result = enrichIdentityWithSchema(
      { visualDescriptorQuery: "white leather low top sneaker" },
      {}
    );
    assert.strictEqual(result.visualDescriptorQuery, "white leather low top sneaker");
  });

  it("highStakes true for luxury", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, true);
  });

  it("highStakes true for sneakers", () => {
    const result = enrichIdentityWithSchema(
      { category: "sneakers" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, true);
  });

  it("highStakes true for watches", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, true);
  });

  it("highStakes false for collectible (preserves visionCategoryPolicy)", () => {
    const result = enrichIdentityWithSchema(
      { category: "collectible" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, false);
  });

  it("highStakes false for model aircraft", () => {
    const result = enrichIdentityWithSchema(
      { category: "model airplane" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, false);
  });

  it("highStakes false for apparel", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, false);
  });

  it("luxuryCandidate true for weak luxury/premium evidence", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Gucci", marketSegment: "luxury" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    assert.strictEqual(result.luxuryCandidate, true);
  });

  it("luxuryCandidate false for budget non-luxury", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", brand: "Hanes", marketSegment: "budget" },
      { overallConfidence: 0.45, attributeCertainty: { brand: 0.35 } }
    );
    assert.strictEqual(result.luxuryCandidate, false);
  });

  it("luxuryCandidate true for luxury brand with weak evidence even in non-high-stakes category", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", brand: "Gucci", marketSegment: "luxury" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.25 } }
    );
    assert.strictEqual(result.luxuryCandidate, true);
  });

  it("authenticityClaimAllowed false for high-stakes possible", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Chanel" },
      { overallConfidence: 0.45, attributeCertainty: { brand: 0.35 } }
    );
    assert.strictEqual(result.authenticityClaimAllowed, false);
  });

  it("authenticityClaimAllowed true for high-stakes confirmed with strong evidence", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Chanel", visibleText: ["CHANEL"] },
      { overallConfidence: 0.92, attributeCertainty: { brand: 0.90 } }
    );
    assert.strictEqual(result.confidenceLabel, "confirmed");
    assert.strictEqual(result.authenticityClaimAllowed, true);
  });

  it("authenticityClaimAllowed true for non-high-stakes likely", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", brand: "Gap" },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    assert.strictEqual(result.confidenceLabel, "likely");
    assert.strictEqual(result.authenticityClaimAllowed, true);
  });

  it("queryTermsBlocked includes luxury brand when high-stakes and weak", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Gucci", model: "Marmont" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    assert.ok(result.queryTermsBlocked.includes("Gucci"));
  });

  it("queryTermsBlocked empty when claim is allowed", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", brand: "Nike", visibleText: ["Nike"] },
      { overallConfidence: 0.85, attributeCertainty: { brand: 0.80 } }
    );
    assert.deepStrictEqual(result.queryTermsBlocked, []);
  });

  it("trust invariant: high-stakes logo-only brand NOT in queryTermsAllowed when blocked", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch", brand: "Rolex", model: "Submariner", visibleText: [] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.72, model: 0.60 } }
    );
    assert.strictEqual(result.confidenceLabel, "likely");
    assert.strictEqual(result.authenticityClaimAllowed, false);
    assert.ok(result.queryTermsBlocked.includes("Rolex"));
    assert.ok(!result.queryTermsAllowed.includes("Rolex"));
    assert.ok(!result.queryTermsAllowed.includes("Submariner"));
    const overlap = result.queryTermsAllowed.filter((t) =>
      result.queryTermsBlocked.includes(t)
    );
    assert.deepStrictEqual(overlap, []);
  });

  it("trust invariant: high-stakes confirmed still allows brand in queryTermsAllowed", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch", brand: "Rolex", model: "Submariner", visibleText: ["ROLEX"] },
      { overallConfidence: 0.92, attributeCertainty: { brand: 0.90, model: 0.85 } }
    );
    assert.strictEqual(result.confidenceLabel, "confirmed");
    assert.strictEqual(result.authenticityClaimAllowed, true);
    assert.ok(result.queryTermsAllowed.includes("Rolex"));
    assert.deepStrictEqual(result.queryTermsBlocked, []);
  });

  it("trust invariant: non-high-stakes likely still allows brand in queryTermsAllowed", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", brand: "Gap" },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    assert.strictEqual(result.confidenceLabel, "likely");
    assert.ok(result.queryTermsAllowed.includes("Gap"));
  });

  it("trust invariant: queryTermsAllowed and queryTermsBlocked never overlap (high-stakes weak)", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Gucci", model: "Marmont" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    assert.ok(
      result.queryTermsAllowed.every((t) => !result.queryTermsBlocked.includes(t)),
      "queryTermsAllowed must not contain any term from queryTermsBlocked"
    );
  });

  it("identityWarnings generated for weak luxury brand claim", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Prada" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    assert.ok(result.identityWarnings.length > 0);
    assert.ok(
      result.identityWarnings.some((w) => /luxury|high-stakes/i.test(w))
    );
  });

  it("missingEvidence includes brand and text gaps", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel" },
      { overallConfidence: 0.20 }
    );
    assert.ok(result.missingEvidence.includes("brand not identified"));
    assert.ok(result.missingEvidence.includes("model/title not identified"));
    assert.ok(result.missingEvidence.includes("no readable text detected"));
  });

  it("missingEvidence excludes brand when brand present", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", brand: "Nike" },
      { overallConfidence: 0.30 }
    );
    assert.ok(!result.missingEvidence.includes("brand not identified"));
  });

  it("evidenceSource is visible_text when visibleText exists", () => {
    const result = enrichIdentityWithSchema(
      { visibleText: ["Sony", "WH-1000XM5"] },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.evidenceSource, "visible_text");
  });

  it("evidenceSource is logo_or_mark when no text but brand present", () => {
    const result = enrichIdentityWithSchema(
      { brand: "Nike", visibleText: [] },
      { overallConfidence: 0.50, attributeCertainty: { brand: 0.50 } }
    );
    assert.strictEqual(result.evidenceSource, "logo_or_mark");
  });

  it("evidenceSource is inferred when only category present", () => {
    const result = enrichIdentityWithSchema(
      { category: "apparel", visibleText: [] },
      { overallConfidence: 0.20 }
    );
    assert.strictEqual(result.evidenceSource, "inferred");
  });

  it("evidenceSource is null when nothing identifiable", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.evidenceSource, null);
  });

  it("backward compatibility: enriched identity includes all standard fields", () => {
    const result = enrichIdentityWithSchema(baseIdentity, {
      attributeCertainty: { brand: 0.80 },
      overallConfidence: 0.80,
    });
    for (const key of Object.keys(baseIdentity)) {
      assert.ok(
        key in result,
        `expected key "${key}" in enriched identity`
      );
    }
  });
});
