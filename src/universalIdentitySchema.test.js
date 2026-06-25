import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENCE_LABELS,
  computeConfidenceLabel,
  enrichIdentityWithSchema,
  isHighStakesBrand,
  isBookIdentity,
  isVideoGameIdentity,
  deriveBookAuthor,
  deriveIsbn,
  deriveGamePlatform,
  isHeadphoneIdentity,
  deriveAudioKind,
  deriveHeadphoneFit,
  deriveHeadphoneBackType,
  deriveHeadphoneWireless,
  deriveHeadphoneNoiseCancelling,
  deriveHeadphoneFeatures,
  isWatchIdentity,
  deriveWatchKind,
  deriveWatchDisplayType,
  deriveWatchStyle,
  deriveWatchStrapType,
  deriveWatchFeatures,
  isGarmentOuterwearIdentity,
  deriveGarmentKind,
  deriveOuterwearType,
  deriveSweaterType,
  deriveClosureType,
  deriveGarmentMaterialSignal,
  deriveGarmentFeatures,
  isClothingIdentity,
  deriveClothingKind,
  deriveTopType,
  deriveBottomType,
  deriveDressSkirtType,
  deriveSleeveType,
  deriveCollarType,
  deriveFitSignal,
  deriveClothingPatternSignal,
  deriveClothingMaterialSignal,
  deriveClothingFeatures,
  isHeadwearIdentity,
  deriveHeadwearKind,
  deriveHeadwearType,
  deriveBrimType,
  deriveClosureAdjustType,
  deriveHeadwearMaterialSignal,
  deriveHeadwearFeatures,
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

  it("non-book/game identity has null media fields", () => {
    const result = enrichIdentityWithSchema(baseIdentity, {
      attributeCertainty: { brand: 0.80 },
      overallConfidence: 0.85,
    });
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.author, null);
    assert.strictEqual(result.isbn, null);
    assert.strictEqual(result.platform, null);
    assert.strictEqual(result.edition, null);
    assert.strictEqual(result.region, null);
    assert.strictEqual(result.rating, null);
    assert.strictEqual(result.publisher, null);
    assert.strictEqual(result.developer, null);
  });

  it("empty identity has null media fields", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.author, null);
    assert.strictEqual(result.isbn, null);
    assert.strictEqual(result.platform, null);
  });
});

describe("isBookIdentity", () => {
  it("detects book from itemType", () => {
    assert.strictEqual(isBookIdentity({ itemType: "paperback book" }), true);
  });
  it("detects book from category", () => {
    assert.strictEqual(isBookIdentity({ category: "hardcover" }), true);
  });
  it("detects manga from styleWords", () => {
    assert.strictEqual(isBookIdentity({ styleWords: ["manga", "shonen"] }), true);
  });
  it("does not detect sneakers as book", () => {
    assert.strictEqual(isBookIdentity({ itemType: "sneakers", category: "sneakers" }), false);
  });
  it("does not detect shirt with book in model name", () => {
    assert.strictEqual(isBookIdentity({ itemType: "shirt", model: "Book Club Tee" }), false);
  });
  it("does not detect t-shirt with comic in model name", () => {
    assert.strictEqual(isBookIdentity({ itemType: "t-shirt", model: "Comic Hero" }), false);
  });
  it("returns false for null", () => {
    assert.strictEqual(isBookIdentity(null), false);
  });
});

describe("isVideoGameIdentity", () => {
  it("detects video game from itemType", () => {
    assert.strictEqual(isVideoGameIdentity({ itemType: "video game case" }), true);
  });
  it("detects cartridge from subtype", () => {
    assert.strictEqual(isVideoGameIdentity({ subtype: "game cartridge" }), true);
  });
  it("does not detect game console as video game", () => {
    assert.strictEqual(isVideoGameIdentity({ itemType: "game console", category: "electronics" }), false);
  });
  it("does not detect ink cartridge as video game", () => {
    assert.strictEqual(isVideoGameIdentity({ itemType: "ink cartridge", category: "printer supplies" }), false);
  });
  it("does not detect toner cartridge as video game", () => {
    assert.strictEqual(isVideoGameIdentity({ itemType: "toner cartridge" }), false);
  });
  it("does not detect razor cartridge as video game", () => {
    assert.strictEqual(isVideoGameIdentity({ itemType: "razor cartridge" }), false);
  });
  it("returns false for null", () => {
    assert.strictEqual(isVideoGameIdentity(null), false);
  });
});

describe("deriveBookAuthor", () => {
  it("derives author from byline", () => {
    assert.strictEqual(deriveBookAuthor(["The Great Gatsby", "by F. Scott Fitzgerald"]), "F. Scott Fitzgerald");
  });
  it("derives author from mixed-case by", () => {
    assert.strictEqual(deriveBookAuthor(["by J.K. Rowling"]), "J.K. Rowling");
  });
  it("returns null when no byline", () => {
    assert.strictEqual(deriveBookAuthor(["Harry Potter", "Scholastic"]), null);
  });
  it("returns null for null input", () => {
    assert.strictEqual(deriveBookAuthor(null), null);
  });
});

describe("deriveIsbn", () => {
  it("derives ISBN-13", () => {
    assert.strictEqual(deriveIsbn(["ISBN 978-0-13-468599-1"]), "9780134685991");
  });
  it("derives ISBN-10", () => {
    assert.strictEqual(deriveIsbn(["013468599X"]), "013468599X");
  });
  it("returns null when no ISBN present", () => {
    assert.strictEqual(deriveIsbn(["First Edition", "Copyright 2020"]), null);
  });
  it("returns null for null input", () => {
    assert.strictEqual(deriveIsbn(null), null);
  });
});

describe("deriveGamePlatform", () => {
  it("derives Nintendo Switch", () => {
    assert.strictEqual(deriveGamePlatform(["Nintendo Switch"]), "Nintendo Switch");
  });
  it("derives PS5", () => {
    assert.strictEqual(deriveGamePlatform(["PS5 exclusive"]), "PS5");
  });
  it("derives PlayStation 5 case-insensitive", () => {
    assert.strictEqual(deriveGamePlatform(["playstation 5 edition"]), "PlayStation 5");
  });
  it("returns null when no platform text", () => {
    assert.strictEqual(deriveGamePlatform(["Zelda", "Tears of the Kingdom"]), null);
  });
  it("returns null for null input", () => {
    assert.strictEqual(deriveGamePlatform(null), null);
  });
  it("prefers Nintendo Switch 2 over Nintendo Switch", () => {
    assert.strictEqual(deriveGamePlatform(["Nintendo Switch 2 game"]), "Nintendo Switch 2");
  });
});

describe("enrichIdentityWithSchema — books", () => {
  it("mediaKind is book for book identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", model: "The Great Gatsby", visibleText: ["The Great Gatsby", "by F. Scott Fitzgerald"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, "book");
  });

  it("book title stays in model", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", model: "Dune", visibleText: ["Dune"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.model, "Dune");
  });

  it("author derived from visibleText", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "hardcover", model: "Harry Potter", visibleText: ["Harry Potter", "by J.K. Rowling"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.author, "J.K. Rowling");
  });

  it("isbn derived from visibleText", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "book", model: "Clean Code", visibleText: ["ISBN 978-0-13-468599-1"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.isbn, "9780134685991");
  });

  it("book with no model does not fabricate title", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", visibleText: [] },
      { overallConfidence: 0.40, attributeCertainty: {} }
    );
    assert.strictEqual(result.model, undefined);
    assert.ok(result.missingEvidence.includes("book title not readable"));
  });

  it("book with no author adds missing evidence", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "book", model: "Dune", visibleText: ["Dune"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.ok(result.missingEvidence.includes("author not identified"));
  });

  it("book with no model adds title warning", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", visibleText: [] },
      { overallConfidence: 0.40, attributeCertainty: {} }
    );
    assert.ok(result.identityWarnings.some((w) => /book title/i.test(w)));
  });

  it("book query terms include author when derived and confidence sufficient", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "book", model: "Harry Potter", visibleText: ["Harry Potter", "by J.K. Rowling"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.ok(result.queryTermsAllowed.includes("J.K. Rowling"));
  });

  it("book query terms do not include author when confidence low", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "book", model: "Harry Potter", visibleText: ["Harry Potter", "by J.K. Rowling"] },
      { overallConfidence: 0.20, attributeCertainty: {} }
    );
    assert.ok(!result.queryTermsAllowed.includes("J.K. Rowling"));
  });

  it("book query terms allowed/blocked disjoint", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "book", category: "luxury", brand: "Assouline", model: "Chanel", visibleText: ["by someone"] },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });
});

describe("enrichIdentityWithSchema — video games", () => {
  it("mediaKind is video_game for game identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda TOTK", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, "video_game");
  });

  it("game title stays in model", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda TOTK", visibleText: [] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.model, "Zelda TOTK");
  });

  it("platform derived from visibleText containing Nintendo Switch", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda TOTK", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.platform, "Nintendo Switch");
  });

  it("platform derived from visibleText containing PS5", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "God of War", visibleText: ["PS5"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.platform, "PS5");
  });

  it("platform null when no platform text", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Mario", visibleText: ["Mario"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.platform, null);
  });

  it("no platform does not infer from case color", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Game", colors: ["blue"], visibleText: [] },
      { overallConfidence: 0.50, attributeCertainty: {} }
    );
    assert.strictEqual(result.platform, null);
    assert.ok(result.identityWarnings.some((w) => /platform.*case color/i.test(w)));
  });

  it("game with no model adds missing evidence", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", visibleText: [] },
      { overallConfidence: 0.40, attributeCertainty: {} }
    );
    assert.ok(result.missingEvidence.includes("video game title not readable"));
  });

  it("game with no platform adds missing evidence", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Some Game", visibleText: ["Some Game"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.ok(result.missingEvidence.includes("game platform not identified"));
  });

  it("game query terms include platform when derived and confidence sufficient", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda", visibleText: ["Zelda", "Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.ok(result.queryTermsAllowed.includes("Nintendo Switch"));
  });

  it("game query terms allowed/blocked disjoint", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", category: "luxury", brand: "Nintendo", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });
});

describe("isHeadphoneIdentity", () => {
  it("detects over-ear headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "over-ear headphones", category: "electronics" }), true);
  });
  it("detects on-ear headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "on-ear headphones" }), true);
  });
  it("detects in-ear headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "in-ear headphones" }), true);
  });
  it("detects earbuds", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "earbuds", category: "electronics" }), true);
  });
  it("detects gaming headset", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "gaming headset" }), true);
  });
  it("detects headphones from styleWords", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "audio", styleWords: ["headphones", "wireless"] }), true);
  });
  it("detects circumaural headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ subtype: "circumaural" }), true);
  });
  it("detects supra-aural headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ subtype: "supra-aural" }), true);
  });
  it("detects IEM", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "iem" }), true);
  });
  // False-positive tests
  it("headphone stand is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "headphone stand", category: "accessories" }), false);
  });
  it("headphone case is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "headphone case" }), false);
  });
  it("headphone cable is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "headphone cable" }), false);
  });
  it("wireless charger is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "wireless charger", category: "electronics" }), false);
  });
  it("Bluetooth speaker is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "Bluetooth speaker", category: "electronics" }), false);
  });
  it("noise-cancelling microphone is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "microphone", styleWords: ["noise-cancelling"] }), false);
  });
  it("open-back chair is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "chair", styleWords: ["open-back"] }), false);
  });
  it("Beats shirt is not Beats headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "t-shirt", category: "apparel", brand: "Beats" }), false);
  });
  it("Sony camera is not Sony headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "camera", category: "electronics", brand: "Sony" }), false);
  });
  it("Apple phone is not AirPods Max", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "phone", category: "electronics", brand: "Apple" }), false);
  });
  it("VR headset is not audio headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "headset", styleWords: ["vr"] }), false);
  });
  it("earring is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "earring", category: "jewelry" }), false);
  });
  it("ear muffs is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "ear muffs", category: "winter accessories" }), false);
  });
  it("earplug is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "earplug", category: "safety" }), false);
  });
  it("headphone ear pad replacement is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "headphone ear pads replacement" }), false);
  });
  it("headphone amp is not headphones", () => {
    assert.strictEqual(isHeadphoneIdentity({ itemType: "headphone amplifier" }), false);
  });
  it("returns false for null", () => {
    assert.strictEqual(isHeadphoneIdentity(null), false);
  });
  it("returns false for empty object", () => {
    assert.strictEqual(isHeadphoneIdentity({}), false);
  });
});

describe("deriveAudioKind", () => {
  it("returns headphones for over-ear headphones", () => {
    assert.strictEqual(deriveAudioKind({ itemType: "over-ear headphones" }), "headphones");
  });
  it("returns headphones for gaming headset", () => {
    assert.strictEqual(deriveAudioKind({ itemType: "gaming headset" }), "headphones");
  });
  it("returns earbuds for earbuds", () => {
    assert.strictEqual(deriveAudioKind({ itemType: "earbuds" }), "earbuds");
  });
  it("returns earbuds for in-ear monitors", () => {
    assert.strictEqual(deriveAudioKind({ itemType: "in-ear monitor" }), "earbuds");
  });
  it("returns earbuds for earphones", () => {
    assert.strictEqual(deriveAudioKind({ itemType: "earphones" }), "earbuds");
  });
  it("returns null for non-headphone identity", () => {
    assert.strictEqual(deriveAudioKind({ itemType: "camera", category: "electronics" }), null);
  });
});

describe("deriveHeadphoneFit", () => {
  it("derives over_ear", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "over-ear headphones" }), "over_ear");
  });
  it("derives over_ear from around-ear", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "around-ear headphones" }), "over_ear");
  });
  it("derives over_ear from circumaural", () => {
    assert.strictEqual(deriveHeadphoneFit({ subtype: "circumaural", itemType: "headphones" }), "over_ear");
  });
  it("derives on_ear", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "on-ear headphones" }), "on_ear");
  });
  it("derives on_ear from supra-aural", () => {
    assert.strictEqual(deriveHeadphoneFit({ subtype: "supra-aural", itemType: "headphones" }), "on_ear");
  });
  it("derives in_ear from earbuds", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "earbuds" }), "in_ear");
  });
  it("derives in_ear from in-ear", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "in-ear headphones" }), "in_ear");
  });
  it("derives in_ear from IEM", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "iem" }), "in_ear");
  });
  it("returns null for generic headphones without fit", () => {
    assert.strictEqual(deriveHeadphoneFit({ itemType: "headphones" }), null);
  });
});

describe("deriveHeadphoneBackType", () => {
  it("derives open_back from type-defining fields", () => {
    assert.strictEqual(deriveHeadphoneBackType({ itemType: "open-back headphones" }), "open_back");
  });
  it("derives open_back from visibleText", () => {
    assert.strictEqual(deriveHeadphoneBackType({ itemType: "headphones", visibleText: ["Open Back Design"] }), "open_back");
  });
  it("derives closed_back from type-defining fields", () => {
    assert.strictEqual(deriveHeadphoneBackType({ itemType: "closed-back headphones" }), "closed_back");
  });
  it("derives closed_back from visibleText", () => {
    assert.strictEqual(deriveHeadphoneBackType({ itemType: "headphones", visibleText: ["Closed Back"] }), "closed_back");
  });
  it("returns null when no back type evidence", () => {
    assert.strictEqual(deriveHeadphoneBackType({ itemType: "headphones" }), null);
  });
  it("does not infer back type from brand or model", () => {
    assert.strictEqual(deriveHeadphoneBackType({ itemType: "headphones", brand: "Sennheiser", model: "HD 600" }), null);
  });
});

describe("deriveHeadphoneWireless", () => {
  it("derives true from visibleText Bluetooth", () => {
    assert.strictEqual(deriveHeadphoneWireless({ itemType: "headphones", visibleText: ["Bluetooth 5.0"] }), true);
  });
  it("derives true from visibleText wireless", () => {
    assert.strictEqual(deriveHeadphoneWireless({ itemType: "headphones", visibleText: ["Wireless"] }), true);
  });
  it("derives true from styleWords wireless", () => {
    assert.strictEqual(deriveHeadphoneWireless({ itemType: "headphones", styleWords: ["wireless"] }), true);
  });
  it("derives true from TWS", () => {
    assert.strictEqual(deriveHeadphoneWireless({ itemType: "earbuds", visibleText: ["TWS"] }), true);
  });
  it("returns null when no wireless evidence", () => {
    assert.strictEqual(deriveHeadphoneWireless({ itemType: "headphones", visibleText: [] }), null);
  });
  it("does not infer wireless from brand or model", () => {
    assert.strictEqual(deriveHeadphoneWireless({ itemType: "headphones", brand: "Sony", model: "WH-1000XM5" }), null);
  });
  it("does not return false", () => {
    const result = deriveHeadphoneWireless({ itemType: "headphones" });
    assert.ok(result === null || result === true, "must be null or true, never false");
  });
});

describe("deriveHeadphoneNoiseCancelling", () => {
  it("derives true from visibleText ANC", () => {
    assert.strictEqual(deriveHeadphoneNoiseCancelling({ itemType: "headphones", visibleText: ["ANC"] }), true);
  });
  it("derives true from visibleText noise cancelling", () => {
    assert.strictEqual(deriveHeadphoneNoiseCancelling({ itemType: "headphones", visibleText: ["noise cancelling"] }), true);
  });
  it("derives true from visibleText noise-cancelling", () => {
    assert.strictEqual(deriveHeadphoneNoiseCancelling({ itemType: "headphones", visibleText: ["Active Noise-Cancelling"] }), true);
  });
  it("derives true from styleWords", () => {
    assert.strictEqual(deriveHeadphoneNoiseCancelling({ itemType: "headphones", styleWords: ["noise cancelling"] }), true);
  });
  it("returns null when no ANC evidence", () => {
    assert.strictEqual(deriveHeadphoneNoiseCancelling({ itemType: "headphones", visibleText: [] }), null);
  });
  it("does not infer from premium brand", () => {
    assert.strictEqual(deriveHeadphoneNoiseCancelling({ itemType: "headphones", brand: "Bose", model: "QuietComfort" }), null);
  });
  it("does not return false", () => {
    const result = deriveHeadphoneNoiseCancelling({ itemType: "headphones" });
    assert.ok(result === null || result === true, "must be null or true, never false");
  });
});

describe("deriveHeadphoneFeatures", () => {
  it("includes bluetooth when Bluetooth text present", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", visibleText: ["Bluetooth 5.0"] });
    assert.ok(result.includes("bluetooth"));
  });
  it("includes wireless when wireless text present (no bluetooth)", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", visibleText: ["Wireless"] });
    assert.ok(result.includes("wireless"));
  });
  it("does not include both bluetooth and wireless when bluetooth present", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", visibleText: ["Bluetooth Wireless"] });
    assert.ok(result.includes("bluetooth"));
    assert.ok(!result.includes("wireless"));
  });
  it("includes noise_cancelling when ANC text present", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", visibleText: ["ANC"] });
    assert.ok(result.includes("noise_cancelling"));
  });
  it("includes microphone when mic text present", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", visibleText: ["Built-in Mic"] });
    assert.ok(result.includes("microphone"));
  });
  it("includes foldable when foldable text present", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", styleWords: ["foldable"] });
    assert.ok(result.includes("foldable"));
  });
  it("returns empty array for non-headphone identity", () => {
    assert.deepStrictEqual(deriveHeadphoneFeatures({ itemType: "camera" }), []);
  });
  it("supports wireless + noise-cancelling simultaneously", () => {
    const result = deriveHeadphoneFeatures({ itemType: "headphones", visibleText: ["Bluetooth ANC"], styleWords: ["foldable"] });
    assert.ok(result.includes("bluetooth"));
    assert.ok(result.includes("noise_cancelling"));
    assert.ok(result.includes("foldable"));
  });
});

describe("enrichIdentityWithSchema — headphones", () => {
  it("populates headphone fields for headphone identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics", visibleText: ["Bluetooth", "ANC"] },
      { overallConfidence: 0.70, attributeCertainty: { category: 0.80 } }
    );
    assert.strictEqual(result.audioKind, "headphones");
    assert.strictEqual(result.headphoneFit, "over_ear");
    assert.strictEqual(result.headphoneWireless, true);
    assert.strictEqual(result.headphoneNoiseCancelling, true);
    assert.ok(result.headphoneFeatures.includes("bluetooth"));
    assert.ok(result.headphoneFeatures.includes("noise_cancelling"));
  });

  it("headphone identity has mediaKind === null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics" },
      { overallConfidence: 0.70, attributeCertainty: { category: 0.80 } }
    );
    assert.strictEqual(result.mediaKind, null);
  });

  it("headphoneEvidence includes fit", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones" },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.headphoneEvidence.includes("fit:over_ear"));
  });

  it("headphoneEvidence includes wireless:bluetooth", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "headphones", visibleText: ["Bluetooth"] },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.headphoneEvidence.includes("wireless:bluetooth"));
  });

  it("headphoneEvidence includes noise_cancelling:anc", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "headphones", visibleText: ["ANC mode"] },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.headphoneEvidence.includes("noise_cancelling:anc"));
  });

  it("headphoneEvidence includes back_type:open_back", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "open-back headphones" },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.headphoneEvidence.includes("back_type:open_back"));
  });

  it("non-headphone identity has null headphone fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.audioKind, null);
    assert.strictEqual(result.headphoneFit, null);
    assert.strictEqual(result.headphoneBackType, null);
    assert.strictEqual(result.headphoneWireless, null);
    assert.strictEqual(result.headphoneNoiseCancelling, null);
    assert.deepStrictEqual(result.headphoneFeatures, []);
    assert.deepStrictEqual(result.headphoneEvidence, []);
  });

  it("empty identity has null headphone fields", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.audioKind, null);
    assert.strictEqual(result.headphoneFit, null);
    assert.strictEqual(result.headphoneBackType, null);
    assert.strictEqual(result.headphoneWireless, null);
    assert.strictEqual(result.headphoneNoiseCancelling, null);
    assert.deepStrictEqual(result.headphoneFeatures, []);
    assert.deepStrictEqual(result.headphoneEvidence, []);
  });

  it("does not alter queryTermsAllowed or queryTermsBlocked for headphones", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics", brand: "Sony", visibleText: ["Sony", "Bluetooth"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    // headphone fields should NOT appear in query terms
    assert.ok(!result.queryTermsAllowed.includes("over_ear"));
    assert.ok(!result.queryTermsAllowed.includes("bluetooth"));
    assert.ok(!result.queryTermsBlocked.includes("over_ear"));
  });

  it("queryTermsAllowed and queryTermsBlocked disjoint for headphones", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "headphones", category: "electronics", brand: "Sony", visibleText: ["Sony", "Bluetooth"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });
});

describe("isWatchIdentity", () => {
  // Positive detection
  it("detects analog watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "analog watch", category: "watch" }), true);
  });
  it("detects digital watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "digital watch" }), true);
  });
  it("detects smartwatch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "smartwatch" }), true);
  });
  it("detects smart watch (two words)", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "smart watch" }), true);
  });
  it("detects sports watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "sports watch" }), true);
  });
  it("detects chronograph watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "chronograph watch" }), true);
  });
  it("detects chronograph alone", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "chronograph", category: "accessories" }), true);
  });
  it("detects fitness band", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "fitness band" }), true);
  });
  it("detects fitness tracker", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "fitness tracker" }), true);
  });
  it("detects activity tracker", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "activity tracker" }), true);
  });
  it("detects pocket watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "pocket watch" }), true);
  });
  it("detects kids watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "kids watch" }), true);
  });
  it("detects couple watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "couple watch" }), true);
  });
  it("detects dress watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "dress watch" }), true);
  });
  it("detects dive watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "dive watch" }), true);
  });
  it("detects wristwatch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "wristwatch" }), true);
  });
  it("detects timepiece", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "timepiece" }), true);
  });
  it("detects watch from category", () => {
    assert.strictEqual(isWatchIdentity({ category: "watch" }), true);
  });
  it("detects watches (plural) from category", () => {
    assert.strictEqual(isWatchIdentity({ category: "watches" }), true);
  });
  it("detects from styleWords", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "accessory", styleWords: ["watch", "vintage"] }), true);
  });
  // False-positive tests
  it("watch box is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch box", category: "accessories" }), false);
  });
  it("watch case is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch case" }), false);
  });
  it("watch strap is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch strap" }), false);
  });
  it("watch band is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch band" }), false);
  });
  it("watch charger is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch charger" }), false);
  });
  it("watch stand is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch stand" }), false);
  });
  it("watch winder is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "watch winder" }), false);
  });
  it("Apple phone is not Apple Watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "phone", category: "electronics", brand: "Apple" }), false);
  });
  it("Samsung phone is not smartwatch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "phone", category: "electronics", brand: "Samsung" }), false);
  });
  it("Garmin bike computer is not fitness watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "bike computer", category: "electronics", brand: "Garmin" }), false);
  });
  it("Fitbit scale is not fitness band", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "scale", category: "electronics", brand: "Fitbit" }), false);
  });
  it("Rolex poster is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "poster", brand: "Rolex" }), false);
  });
  it("Omega book is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "book", brand: "Omega" }), false);
  });
  it("Cartier bracelet is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "bracelet", category: "jewelry", brand: "Cartier" }), false);
  });
  it("jewelry box is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "jewelry box", category: "accessories" }), false);
  });
  it("wall clock is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "wall clock" }), false);
  });
  it("clock is not wristwatch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "clock" }), false);
  });
  it("stopwatch is not wristwatch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "stopwatch" }), false);
  });
  it("bracelet with charm is not watch", () => {
    assert.strictEqual(isWatchIdentity({ itemType: "bracelet", styleWords: ["charm"] }), false);
  });
  it("returns false for null", () => {
    assert.strictEqual(isWatchIdentity(null), false);
  });
  it("returns false for empty object", () => {
    assert.strictEqual(isWatchIdentity({}), false);
  });
});

describe("deriveWatchKind", () => {
  it("returns smartwatch from type text", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "smartwatch" }), "smartwatch");
  });
  it("returns smartwatch from smart watch (two words)", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "smart watch" }), "smartwatch");
  });
  it("returns smartwatch from visibleText Apple Watch", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "watch", visibleText: ["Apple Watch Series 9"] }), "smartwatch");
  });
  it("returns smartwatch from visibleText Galaxy Watch", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "watch", visibleText: ["Galaxy Watch"] }), "smartwatch");
  });
  it("returns smartwatch from visibleText Wear OS", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "watch", visibleText: ["Wear OS"] }), "smartwatch");
  });
  it("returns fitness_band", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "fitness band" }), "fitness_band");
  });
  it("returns fitness_band for fitness tracker", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "fitness tracker" }), "fitness_band");
  });
  it("returns fitness_band for activity tracker", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "activity tracker" }), "fitness_band");
  });
  it("returns pocket_watch", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "pocket watch" }), "pocket_watch");
  });
  it("returns watch for generic watch", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "analog watch" }), "watch");
  });
  it("returns watch for wristwatch", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "wristwatch" }), "watch");
  });
  it("returns null for non-watch", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "camera", category: "electronics" }), null);
  });
  it("does not infer smartwatch from brand alone", () => {
    assert.strictEqual(deriveWatchKind({ itemType: "watch", brand: "Apple" }), "watch");
  });
});

describe("deriveWatchDisplayType", () => {
  it("derives analog", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "analog watch" }), "analog");
  });
  it("derives analog from styleWords", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "watch", styleWords: ["analog"] }), "analog");
  });
  it("derives digital", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "digital watch" }), "digital");
  });
  it("derives digital from LCD", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "watch", styleWords: ["lcd"] }), "digital");
  });
  it("derives hybrid", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "watch", styleWords: ["hybrid"] }), "hybrid");
  });
  it("returns null for generic watch", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "watch" }), null);
  });
  it("returns null for non-watch", () => {
    assert.strictEqual(deriveWatchDisplayType({ itemType: "camera" }), null);
  });
});

describe("deriveWatchStyle", () => {
  it("derives sports from sports watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "sports watch" }), "sports");
  });
  it("derives sports from dive watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "dive watch" }), "sports");
  });
  it("derives sports from field watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "field watch" }), "sports");
  });
  it("derives luxury_style from dress watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "dress watch" }), "luxury_style");
  });
  it("derives luxury_style from luxury watch in styleWords", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "watch", styleWords: ["luxury watch"] }), "luxury_style");
  });
  it("derives kids", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "kids watch" }), "kids");
  });
  it("derives kids from children's watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "children's watch" }), "kids");
  });
  it("derives couple", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "couple watch" }), "couple");
  });
  it("derives couple from his and hers", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "watch", styleWords: ["his and hers"] }), "couple");
  });
  it("returns null for generic watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "watch" }), null);
  });
  it("returns null for non-watch", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "camera" }), null);
  });
  it("does not derive luxury from brand", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "watch", brand: "Rolex" }), null);
  });
  it("does not derive luxury from metal strap alone", () => {
    assert.strictEqual(deriveWatchStyle({ itemType: "watch", materials: ["metal"] }), null);
  });
});

describe("deriveWatchStrapType", () => {
  it("derives leather from type text", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", styleWords: ["leather strap"] }), "leather");
  });
  it("derives leather from materials", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", materials: ["leather"] }), "leather");
  });
  it("derives metal from stainless steel bracelet", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", styleWords: ["stainless steel bracelet"] }), "metal");
  });
  it("derives metal from materials", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", materials: ["stainless steel"] }), "metal");
  });
  it("derives rubber from silicone strap", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", styleWords: ["silicone strap"] }), "rubber");
  });
  it("derives rubber from materials", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", materials: ["rubber"] }), "rubber");
  });
  it("derives fabric from nato strap", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", styleWords: ["nato strap"] }), "fabric");
  });
  it("derives fabric from materials nylon", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch", materials: ["nylon"] }), "fabric");
  });
  it("returns null for generic watch", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "watch" }), null);
  });
  it("returns null for non-watch", () => {
    assert.strictEqual(deriveWatchStrapType({ itemType: "camera" }), null);
  });
});

describe("deriveWatchFeatures", () => {
  it("derives chronograph from type text", () => {
    const result = deriveWatchFeatures({ itemType: "chronograph watch" });
    assert.ok(result.includes("chronograph"));
  });
  it("derives chronograph from visibleText subdials", () => {
    const result = deriveWatchFeatures({ itemType: "watch", visibleText: ["subdials"] });
    assert.ok(result.includes("chronograph"));
  });
  it("derives date_window from visibleText", () => {
    const result = deriveWatchFeatures({ itemType: "watch", visibleText: ["date window"] });
    assert.ok(result.includes("date_window"));
  });
  it("derives date_window from day-date", () => {
    const result = deriveWatchFeatures({ itemType: "watch", styleWords: ["day-date"] });
    assert.ok(result.includes("date_window"));
  });
  it("derives rotating_bezel", () => {
    const result = deriveWatchFeatures({ itemType: "watch", styleWords: ["rotating bezel"] });
    assert.ok(result.includes("rotating_bezel"));
  });
  it("derives rotating_bezel from dive bezel", () => {
    const result = deriveWatchFeatures({ itemType: "dive watch", visibleText: ["dive bezel"] });
    assert.ok(result.includes("rotating_bezel"));
  });
  it("derives water_resistant", () => {
    const result = deriveWatchFeatures({ itemType: "watch", visibleText: ["water resistant"] });
    assert.ok(result.includes("water_resistant"));
  });
  it("derives water_resistant from waterproof", () => {
    const result = deriveWatchFeatures({ itemType: "watch", visibleText: ["waterproof"] });
    assert.ok(result.includes("water_resistant"));
  });
  it("supports multiple features", () => {
    const result = deriveWatchFeatures({ itemType: "chronograph watch", styleWords: ["rotating bezel"], visibleText: ["water resistant"] });
    assert.ok(result.includes("chronograph"));
    assert.ok(result.includes("rotating_bezel"));
    assert.ok(result.includes("water_resistant"));
  });
  it("returns empty for generic watch with no features", () => {
    assert.deepStrictEqual(deriveWatchFeatures({ itemType: "watch" }), []);
  });
  it("returns empty for non-watch", () => {
    assert.deepStrictEqual(deriveWatchFeatures({ itemType: "camera" }), []);
  });
  it("does not infer chronograph from brand/model", () => {
    assert.deepStrictEqual(deriveWatchFeatures({ itemType: "watch", brand: "Omega", model: "Speedmaster" }), []);
  });
});

describe("enrichIdentityWithSchema — watches", () => {
  it("populates watch fields for watch identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch", styleWords: ["leather strap", "chronograph"], visibleText: ["water resistant"] },
      { overallConfidence: 0.70, attributeCertainty: { category: 0.80 } }
    );
    assert.strictEqual(result.watchKind, "watch");
    assert.strictEqual(result.watchDisplayType, "analog");
    assert.strictEqual(result.watchStrapType, "leather");
    assert.ok(result.watchFeatures.includes("chronograph"));
    assert.ok(result.watchFeatures.includes("water_resistant"));
  });

  it("watchEvidence includes expected entries", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch", styleWords: ["leather strap"] },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.watchEvidence.includes("kind:watch"));
    assert.ok(result.watchEvidence.includes("display:analog"));
    assert.ok(result.watchEvidence.includes("strap:leather"));
  });

  it("watchEvidence includes style for dress watch", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "dress watch", category: "watch" },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.watchEvidence.includes("style:luxury_style"));
    assert.strictEqual(result.watchLuxurySignal, "possible_luxury_style");
  });

  it("watchLuxurySignal is null for non-luxury-style watches", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "sports watch", category: "watch" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.watchLuxurySignal, null);
  });

  it("watchLuxurySignal does not change luxuryCandidate computation", () => {
    const withDress = enrichIdentityWithSchema(
      { itemType: "dress watch", category: "watch", brand: "Seiko" },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    const withoutDress = enrichIdentityWithSchema(
      { itemType: "watch", category: "watch", brand: "Seiko" },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    assert.strictEqual(withDress.watchLuxurySignal, "possible_luxury_style");
    assert.strictEqual(withoutDress.watchLuxurySignal, null);
    assert.strictEqual(withDress.luxuryCandidate, withoutDress.luxuryCandidate);
    assert.strictEqual(withDress.authenticityClaimAllowed, withoutDress.authenticityClaimAllowed);
    assert.strictEqual(withDress.highStakes, withoutDress.highStakes);
  });

  it("watch identity has mediaKind === null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.mediaKind, null);
  });

  it("watch identity has null headphone fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.audioKind, null);
    assert.strictEqual(result.headphoneFit, null);
    assert.deepStrictEqual(result.headphoneFeatures, []);
  });

  it("smartwatch from visibleText", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "watch", category: "watch", visibleText: ["Apple Watch"] },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.watchKind, "smartwatch");
    assert.ok(result.watchEvidence.includes("kind:smartwatch"));
  });

  it("fitness band enrichment", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "fitness tracker", category: "electronics" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.watchKind, "fitness_band");
  });

  it("non-watch identity has null watch fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.watchKind, null);
    assert.strictEqual(result.watchDisplayType, null);
    assert.strictEqual(result.watchStyle, null);
    assert.strictEqual(result.watchStrapType, null);
    assert.deepStrictEqual(result.watchFeatures, []);
    assert.deepStrictEqual(result.watchEvidence, []);
    assert.strictEqual(result.watchLuxurySignal, null);
  });

  it("empty identity has null watch fields", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.watchKind, null);
    assert.strictEqual(result.watchDisplayType, null);
    assert.strictEqual(result.watchStyle, null);
    assert.strictEqual(result.watchStrapType, null);
    assert.deepStrictEqual(result.watchFeatures, []);
    assert.deepStrictEqual(result.watchEvidence, []);
    assert.strictEqual(result.watchLuxurySignal, null);
  });

  it("does not alter queryTermsAllowed or queryTermsBlocked for watches", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch", brand: "Seiko", visibleText: ["Seiko"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.ok(!result.queryTermsAllowed.includes("analog"));
    assert.ok(!result.queryTermsAllowed.includes("leather"));
    assert.ok(!result.queryTermsBlocked.includes("analog"));
  });

  it("queryTermsAllowed and queryTermsBlocked disjoint for watches", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "watch", category: "watch", brand: "Rolex", visibleText: ["ROLEX"] },
      { overallConfidence: 0.92, attributeCertainty: { brand: 0.90, model: 0.85 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });
});

describe("isGarmentOuterwearIdentity", () => {
  // Positive detection
  it("detects denim jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "denim jacket" }), true); });
  it("detects trucker jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "trucker jacket" }), true); });
  it("detects varsity jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "varsity jacket" }), true); });
  it("detects leather jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "leather jacket" }), true); });
  it("detects bomber jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "bomber jacket" }), true); });
  it("detects flight jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "flight jacket" }), true); });
  it("detects puffer jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "puffer jacket" }), true); });
  it("detects down jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "down jacket" }), true); });
  it("detects windbreaker", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "windbreaker" }), true); });
  it("detects rain jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "rain jacket" }), true); });
  it("detects fleece jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "fleece jacket" }), true); });
  it("detects track jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "track jacket" }), true); });
  it("detects chore jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "chore jacket" }), true); });
  it("detects field jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "field jacket" }), true); });
  it("detects utility jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "utility jacket" }), true); });
  it("detects blazer", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "blazer" }), true); });
  it("detects vest", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "vest" }), true); });
  it("detects gilet", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "gilet" }), true); });
  it("detects trench coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "trench coat" }), true); });
  it("detects overcoat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "overcoat" }), true); });
  it("detects peacoat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "peacoat" }), true); });
  it("detects parka", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "parka" }), true); });
  it("detects wool coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "wool coat" }), true); });
  it("detects sweater", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "sweater" }), true); });
  it("detects cardigan", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "cardigan" }), true); });
  it("detects crewneck sweater", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "crewneck sweater" }), true); });
  it("detects v-neck sweater", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "v-neck sweater" }), true); });
  it("detects turtleneck sweater", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "turtleneck sweater" }), true); });
  it("detects hoodie", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "hoodie" }), true); });
  it("detects sweatshirt", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "sweatshirt" }), true); });
  it("detects zip-up hoodie", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "zip-up hoodie" }), true); });
  it("detects quarter-zip", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "quarter-zip pullover" }), true); });
  it("detects half-zip", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "half-zip sweater" }), true); });
  it("detects from styleWords", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "clothing", styleWords: ["jacket", "casual"] }), true); });
  // False-positive tests
  it("book jacket is not garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "book jacket" }), false); });
  it("dust jacket is not garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "dust jacket" }), false); });
  it("record jacket is not garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "record jacket" }), false); });
  it("life jacket is not apparel jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "life jacket" }), false); });
  it("jacket cover is not garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "jacket cover" }), false); });
  it("coat rack is not coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "coat rack" }), false); });
  it("coat hanger is not coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "coat hanger" }), false); });
  it("coat hook is not coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "coat hook" }), false); });
  it("sweater shaver is not sweater", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "sweater shaver" }), false); });
  it("sweater stone is not sweater", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "sweater stone" }), false); });
  it("zipper pouch is not zip garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "zipper pouch" }), false); });
  it("zipper pull is not zip garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "zipper pull" }), false); });
  it("zip tie is not zip garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "zip tie" }), false); });
  it("Zippo lighter is not zip garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "zippo lighter" }), false); });
  it("zip code is not zip garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "zip code" }), false); });
  it("denim jeans are not denim jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "denim jeans", category: "apparel" }), false); });
  it("leather wallet is not leather jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "leather wallet" }), false); });
  it("leather shoes are not leather jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "leather shoes" }), false); });
  it("varsity patch is not varsity jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "varsity patch" }), false); });
  it("bomber plane is not bomber jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "bomber plane" }), false); });
  it("puffer fish is not puffer jacket", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "puffer fish" }), false); });
  it("trench art is not trench coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "trench art" }), false); });
  it("trench shovel is not trench coat", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "trench shovel" }), false); });
  it("scarf is not garment outerwear", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "scarf" }), false); });
  it("gloves are not garment outerwear", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "gloves" }), false); });
  it("hat is not garment outerwear", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "hat" }), false); });
  it("dress is not outerwear", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "dress" }), false); });
  it("plain shirt is not outerwear", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "shirt" }), false); });
  it("pants are not outerwear", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "pants" }), false); });
  it("pillowcase is not garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "pillowcase" }), false); });
  it("blanket is not garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "blanket" }), false); });
  it("bare mock neck is not enough to detect garment", () => { assert.strictEqual(isGarmentOuterwearIdentity({ itemType: "mock neck shirt" }), false); });
  it("returns false for null", () => { assert.strictEqual(isGarmentOuterwearIdentity(null), false); });
  it("returns false for empty object", () => { assert.strictEqual(isGarmentOuterwearIdentity({}), false); });
});

describe("deriveGarmentKind", () => {
  it("returns hoodie for hoodie", () => { assert.strictEqual(deriveGarmentKind({ itemType: "hoodie" }), "hoodie"); });
  it("returns hoodie for hooded sweatshirt", () => { assert.strictEqual(deriveGarmentKind({ itemType: "hooded sweatshirt" }), "hoodie"); });
  it("returns sweatshirt for sweatshirt", () => { assert.strictEqual(deriveGarmentKind({ itemType: "sweatshirt" }), "sweatshirt"); });
  it("returns sweater for sweater", () => { assert.strictEqual(deriveGarmentKind({ itemType: "sweater" }), "sweater"); });
  it("returns sweater for cardigan", () => { assert.strictEqual(deriveGarmentKind({ itemType: "cardigan" }), "sweater"); });
  it("returns sweater for turtleneck", () => { assert.strictEqual(deriveGarmentKind({ itemType: "turtleneck" }), "sweater"); });
  it("returns sweater for pullover", () => { assert.strictEqual(deriveGarmentKind({ itemType: "pullover" }), "sweater"); });
  it("returns sweater for quarter-zip", () => { assert.strictEqual(deriveGarmentKind({ itemType: "quarter-zip pullover" }), "sweater"); });
  it("returns vest for vest", () => { assert.strictEqual(deriveGarmentKind({ itemType: "vest" }), "vest"); });
  it("returns vest for sweater vest", () => { assert.strictEqual(deriveGarmentKind({ itemType: "sweater vest" }), "vest"); });
  it("returns vest for gilet", () => { assert.strictEqual(deriveGarmentKind({ itemType: "gilet" }), "vest"); });
  it("returns coat for coat", () => { assert.strictEqual(deriveGarmentKind({ itemType: "coat" }), "coat"); });
  it("returns coat for trench coat", () => { assert.strictEqual(deriveGarmentKind({ itemType: "trench coat" }), "coat"); });
  it("returns coat for parka", () => { assert.strictEqual(deriveGarmentKind({ itemType: "parka" }), "coat"); });
  it("returns jacket for jacket", () => { assert.strictEqual(deriveGarmentKind({ itemType: "jacket" }), "jacket"); });
  it("returns jacket for blazer", () => { assert.strictEqual(deriveGarmentKind({ itemType: "blazer" }), "jacket"); });
  it("returns jacket for windbreaker", () => { assert.strictEqual(deriveGarmentKind({ itemType: "windbreaker" }), "jacket"); });
  it("returns null for non-garment", () => { assert.strictEqual(deriveGarmentKind({ itemType: "camera" }), null); });
});

describe("deriveOuterwearType", () => {
  it("derives denim_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "denim jacket" }), "denim_jacket"); });
  it("derives denim_jacket from material", () => { assert.strictEqual(deriveOuterwearType({ itemType: "jacket", materials: ["denim"] }), "denim_jacket"); });
  it("derives trucker_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "trucker jacket" }), "trucker_jacket"); });
  it("derives varsity_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "varsity jacket" }), "varsity_jacket"); });
  it("derives leather_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "leather jacket" }), "leather_jacket"); });
  it("derives leather_jacket from material", () => { assert.strictEqual(deriveOuterwearType({ itemType: "jacket", materials: ["leather"] }), "leather_jacket"); });
  it("derives bomber_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "bomber jacket" }), "bomber_jacket"); });
  it("derives puffer_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "puffer jacket" }), "puffer_jacket"); });
  it("derives down_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "down jacket" }), "down_jacket"); });
  it("derives windbreaker", () => { assert.strictEqual(deriveOuterwearType({ itemType: "windbreaker" }), "windbreaker"); });
  it("derives rain_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "rain jacket" }), "rain_jacket"); });
  it("derives track_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "track jacket" }), "track_jacket"); });
  it("derives fleece_jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "fleece jacket" }), "fleece_jacket"); });
  it("derives fleece_jacket from material", () => { assert.strictEqual(deriveOuterwearType({ itemType: "jacket", materials: ["fleece"] }), "fleece_jacket"); });
  it("derives blazer", () => { assert.strictEqual(deriveOuterwearType({ itemType: "blazer" }), "blazer"); });
  it("derives trench_coat", () => { assert.strictEqual(deriveOuterwearType({ itemType: "trench coat" }), "trench_coat"); });
  it("derives overcoat", () => { assert.strictEqual(deriveOuterwearType({ itemType: "overcoat" }), "overcoat"); });
  it("derives peacoat", () => { assert.strictEqual(deriveOuterwearType({ itemType: "peacoat" }), "peacoat"); });
  it("derives parka", () => { assert.strictEqual(deriveOuterwearType({ itemType: "parka" }), "parka"); });
  it("derives wool_coat", () => { assert.strictEqual(deriveOuterwearType({ itemType: "wool coat" }), "wool_coat"); });
  it("derives wool_coat from material", () => { assert.strictEqual(deriveOuterwearType({ itemType: "coat", materials: ["wool"] }), "wool_coat"); });
  it("derives raincoat", () => { assert.strictEqual(deriveOuterwearType({ itemType: "raincoat" }), "raincoat"); });
  it("returns null for generic jacket", () => { assert.strictEqual(deriveOuterwearType({ itemType: "jacket" }), null); });
  it("returns null for non-garment", () => { assert.strictEqual(deriveOuterwearType({ itemType: "camera" }), null); });
});

describe("deriveSweaterType", () => {
  it("derives cardigan", () => { assert.strictEqual(deriveSweaterType({ itemType: "cardigan" }), "cardigan"); });
  it("derives crewneck", () => { assert.strictEqual(deriveSweaterType({ itemType: "crewneck sweater" }), "crewneck"); });
  it("derives crewneck from crew neck", () => { assert.strictEqual(deriveSweaterType({ itemType: "crew neck sweater" }), "crewneck"); });
  it("derives v_neck", () => { assert.strictEqual(deriveSweaterType({ itemType: "v-neck sweater" }), "v_neck"); });
  it("derives turtleneck", () => { assert.strictEqual(deriveSweaterType({ itemType: "turtleneck sweater" }), "turtleneck"); });
  it("derives turtleneck from mock neck sweater", () => { assert.strictEqual(deriveSweaterType({ itemType: "mock neck sweater" }), "turtleneck"); });
  it("derives turtleneck from mock-neck sweater", () => { assert.strictEqual(deriveSweaterType({ itemType: "mock-neck sweater" }), "turtleneck"); });
  it("derives quarter_zip", () => { assert.strictEqual(deriveSweaterType({ itemType: "quarter-zip sweater" }), "quarter_zip"); });
  it("derives half_zip", () => { assert.strictEqual(deriveSweaterType({ itemType: "half-zip pullover" }), "half_zip"); });
  it("derives cable_knit", () => { assert.strictEqual(deriveSweaterType({ itemType: "cable-knit sweater" }), "cable_knit"); });
  it("derives sweater_vest", () => { assert.strictEqual(deriveSweaterType({ itemType: "sweater vest" }), "sweater_vest"); });
  it("returns null for generic sweater", () => { assert.strictEqual(deriveSweaterType({ itemType: "sweater" }), null); });
  it("returns null for non-garment", () => { assert.strictEqual(deriveSweaterType({ itemType: "camera" }), null); });
});

describe("deriveClosureType", () => {
  it("derives zip from zip-up", () => { assert.strictEqual(deriveClosureType({ itemType: "zip-up hoodie" }), "zip"); });
  it("derives zip from full-zip", () => { assert.strictEqual(deriveClosureType({ itemType: "full-zip jacket" }), "zip"); });
  it("derives zip from quarter-zip", () => { assert.strictEqual(deriveClosureType({ itemType: "quarter-zip sweater" }), "zip"); });
  it("derives button from button front", () => { assert.strictEqual(deriveClosureType({ itemType: "jacket", styleWords: ["button front"] }), "button"); });
  it("derives snap from snap front", () => { assert.strictEqual(deriveClosureType({ itemType: "jacket", styleWords: ["snap front"] }), "snap"); });
  it("derives pullover", () => { assert.strictEqual(deriveClosureType({ itemType: "pullover" }), "pullover"); });
  it("returns null for generic jacket", () => { assert.strictEqual(deriveClosureType({ itemType: "jacket" }), null); });
  it("returns null for non-garment", () => { assert.strictEqual(deriveClosureType({ itemType: "camera" }), null); });
});

describe("deriveGarmentMaterialSignal", () => {
  it("derives denim from type text", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "denim jacket" }), "denim"); });
  it("derives denim from materials", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "jacket", materials: ["denim"] }), "denim"); });
  it("derives leather from type text", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "leather jacket" }), "leather"); });
  it("derives wool from materials", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "coat", materials: ["wool"] }), "wool"); });
  it("derives fleece from type text", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "fleece jacket" }), "fleece"); });
  it("derives knit from type text", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "cable-knit sweater" }), "knit"); });
  it("derives nylon from materials", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "jacket", materials: ["nylon"] }), "nylon"); });
  it("derives down from puffer text", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "puffer jacket" }), "down"); });
  it("derives cotton from materials", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "hoodie", materials: ["cotton"] }), "cotton"); });
  it("returns null for generic jacket", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "jacket" }), null); });
  it("returns null for non-garment", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "camera" }), null); });
  it("does not infer material from brand", () => { assert.strictEqual(deriveGarmentMaterialSignal({ itemType: "jacket", brand: "Levi's" }), null); });
});

describe("deriveGarmentFeatures", () => {
  it("derives ribbed_cuffs", () => { assert.ok(deriveGarmentFeatures({ itemType: "jacket", styleWords: ["ribbed cuffs"] }).includes("ribbed_cuffs")); });
  it("derives chest_pockets", () => { assert.ok(deriveGarmentFeatures({ itemType: "jacket", styleWords: ["chest pockets"] }).includes("chest_pockets")); });
  it("derives quilted", () => { assert.ok(deriveGarmentFeatures({ itemType: "jacket", styleWords: ["quilted"] }).includes("quilted")); });
  it("derives stand_collar", () => { assert.ok(deriveGarmentFeatures({ itemType: "jacket", styleWords: ["stand collar"] }).includes("stand_collar")); });
  it("derives drawstring", () => { assert.ok(deriveGarmentFeatures({ itemType: "hoodie", visibleText: ["drawstring"] }).includes("drawstring")); });
  it("derives hooded", () => { assert.ok(deriveGarmentFeatures({ itemType: "jacket", styleWords: ["hooded"] }).includes("hooded")); });
  it("supports multiple features", () => {
    const result = deriveGarmentFeatures({ itemType: "jacket", styleWords: ["quilted", "hooded", "chest pockets"] });
    assert.ok(result.includes("quilted"));
    assert.ok(result.includes("hooded"));
    assert.ok(result.includes("chest_pockets"));
  });
  it("returns empty for generic jacket", () => { assert.deepStrictEqual(deriveGarmentFeatures({ itemType: "jacket" }), []); });
  it("returns empty for non-garment", () => { assert.deepStrictEqual(deriveGarmentFeatures({ itemType: "camera" }), []); });
});

describe("enrichIdentityWithSchema — garments", () => {
  it("populates garment fields for jacket identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel", styleWords: ["button front", "chest pockets"], materials: ["denim"] },
      { overallConfidence: 0.70, attributeCertainty: { category: 0.80 } }
    );
    assert.strictEqual(result.garmentKind, "jacket");
    assert.strictEqual(result.outerwearType, "denim_jacket");
    assert.strictEqual(result.closureType, "button");
    assert.strictEqual(result.garmentMaterialSignal, "denim");
    assert.ok(result.garmentFeatures.includes("chest_pockets"));
  });

  it("garmentEvidence contains expected entries", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel", materials: ["denim"] },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.garmentEvidence.includes("kind:jacket"));
    assert.ok(result.garmentEvidence.includes("outer:denim_jacket"));
    assert.ok(result.garmentEvidence.includes("material:denim"));
  });

  it("hoodType is hooded for hoodie", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "hoodie", category: "apparel" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.hoodType, "hooded");
    assert.strictEqual(result.garmentKind, "hoodie");
  });

  it("hoodType is hooded from hooded feature", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "jacket", category: "apparel", styleWords: ["hooded"] },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.hoodType, "hooded");
  });

  it("hoodType is null for non-hooded jacket", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "blazer", category: "apparel" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.hoodType, null);
  });

  it("sweater type populated for quarter-zip", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "quarter-zip sweater", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.garmentKind, "sweater");
    assert.strictEqual(result.sweaterType, "quarter_zip");
    assert.strictEqual(result.closureType, "zip");
  });

  it("non-garment identity has null garment fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.garmentKind, null);
    assert.strictEqual(result.outerwearType, null);
    assert.strictEqual(result.sweaterType, null);
    assert.strictEqual(result.closureType, null);
    assert.strictEqual(result.hoodType, null);
    assert.strictEqual(result.garmentMaterialSignal, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
    assert.deepStrictEqual(result.garmentEvidence, []);
  });

  it("empty identity has null garment fields", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.garmentKind, null);
    assert.strictEqual(result.outerwearType, null);
    assert.strictEqual(result.sweaterType, null);
    assert.strictEqual(result.closureType, null);
    assert.strictEqual(result.hoodType, null);
    assert.strictEqual(result.garmentMaterialSignal, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
    assert.deepStrictEqual(result.garmentEvidence, []);
  });

  it("garment fields do not enter queryTermsAllowed", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel", brand: "Levi's", visibleText: ["Levi's"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.ok(!result.queryTermsAllowed.includes("denim_jacket"));
    assert.ok(!result.queryTermsAllowed.includes("jacket"));
    assert.ok(!result.queryTermsBlocked.includes("denim_jacket"));
  });

  it("queryTermsAllowed and queryTermsBlocked disjoint for garment identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "leather jacket", category: "apparel", brand: "Schott", visibleText: ["Schott"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });

  it("watch identity has null garment fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.garmentKind, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
  });

  it("headphone identity has null garment fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.garmentKind, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
  });
});

describe("enrichIdentityWithSchema — regressions", () => {
  it("Rolex weak evidence still blocked (high-stakes regression)", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch", brand: "Rolex", model: "Submariner", visibleText: [] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.72, model: 0.60 } }
    );
    assert.ok(result.queryTermsBlocked.includes("Rolex"));
    assert.ok(!result.queryTermsAllowed.includes("Rolex"));
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.watchKind, "watch");
  });

  it("Rolex confirmed still allowed (high-stakes regression)", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch", brand: "Rolex", model: "Submariner", visibleText: ["ROLEX"] },
      { overallConfidence: 0.92, attributeCertainty: { brand: 0.90, model: 0.85 } }
    );
    assert.ok(result.queryTermsAllowed.includes("Rolex"));
    assert.deepStrictEqual(result.queryTermsBlocked, []);
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.watchKind, "watch");
  });

  it("model aircraft remains non-high-stakes", () => {
    const result = enrichIdentityWithSchema(
      { category: "model airplane", brand: "Gemini Jets" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, false);
    assert.strictEqual(result.mediaKind, null);
  });

  it("ink cartridge enrichment has null mediaKind", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "ink cartridge", category: "printer supplies" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.mediaKind, null);
  });

  it("ink cartridge remains not video game (regression)", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "ink cartridge", category: "printer supplies" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.audioKind, null);
  });

  it("Book Club Tee remains not book (regression)", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Gap", model: "Book Club Tee" },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.audioKind, null);
  });

  it("apparel identity unchanged by media enrichment", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes", model: "ComfortSoft", visibleText: ["Hanes"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.author, null);
    assert.strictEqual(result.isbn, null);
    assert.strictEqual(result.platform, null);
    assert.strictEqual(result.audioKind, null);
    assert.strictEqual(result.headphoneFit, null);
    assert.deepStrictEqual(result.headphoneFeatures, []);
    assert.deepStrictEqual(result.headphoneEvidence, []);
    assert.strictEqual(result.watchKind, null);
    assert.strictEqual(result.watchDisplayType, null);
    assert.deepStrictEqual(result.watchFeatures, []);
    assert.deepStrictEqual(result.watchEvidence, []);
    assert.strictEqual(result.garmentKind, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
    assert.strictEqual(result.headwearKind, null);
    assert.strictEqual(result.headwearType, null);
    assert.strictEqual(result.brimType, null);
    assert.strictEqual(result.closureAdjustType, null);
    assert.strictEqual(result.headwearMaterialSignal, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
    assert.ok(!result.missingEvidence.includes("book title not readable"));
    assert.ok(!result.missingEvidence.includes("video game title not readable"));
  });

  it("apparel t-shirt has clothing enrichment (not garment)", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes", model: "ComfortSoft", visibleText: ["Hanes"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.strictEqual(result.clothingKind, "top");
    assert.strictEqual(result.topType, "t_shirt");
    assert.strictEqual(result.garmentKind, null);
  });

  it("book existing behavior still passes with all taxonomy fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", model: "Dune", visibleText: ["Dune", "by Frank Herbert"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, "book");
    assert.strictEqual(result.author, "Frank Herbert");
    assert.strictEqual(result.audioKind, null);
    assert.deepStrictEqual(result.headphoneFeatures, []);
    assert.strictEqual(result.watchKind, null);
    assert.deepStrictEqual(result.watchFeatures, []);
    assert.strictEqual(result.garmentKind, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
    assert.strictEqual(result.clothingKind, null);
    assert.strictEqual(result.topType, null);
    assert.strictEqual(result.bottomType, null);
    assert.strictEqual(result.dressSkirtType, null);
    assert.strictEqual(result.sleeveType, null);
    assert.strictEqual(result.collarType, null);
    assert.strictEqual(result.fitSignal, null);
    assert.strictEqual(result.patternSignal, null);
    assert.strictEqual(result.clothingMaterialSignal, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
    assert.deepStrictEqual(result.clothingEvidence, []);
    assert.strictEqual(result.headwearKind, null);
    assert.strictEqual(result.headwearType, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
  });

  it("video game existing behavior still passes with all taxonomy fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, "video_game");
    assert.strictEqual(result.platform, "Nintendo Switch");
    assert.strictEqual(result.audioKind, null);
    assert.deepStrictEqual(result.headphoneFeatures, []);
    assert.strictEqual(result.watchKind, null);
    assert.deepStrictEqual(result.watchFeatures, []);
    assert.strictEqual(result.garmentKind, null);
    assert.deepStrictEqual(result.garmentFeatures, []);
    assert.strictEqual(result.clothingKind, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
    assert.deepStrictEqual(result.clothingEvidence, []);
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
  });

  it("queryTermsAllowed and queryTermsBlocked never overlap across all media types", () => {
    const identities = [
      { itemType: "book", model: "Dune", visibleText: ["Dune"] },
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { itemType: "sneakers", category: "sneakers", brand: "Nike", visibleText: ["Nike"] },
      { itemType: "over-ear headphones", category: "electronics", brand: "Sony", visibleText: ["Sony"] },
      { itemType: "analog watch", category: "watch", brand: "Seiko", visibleText: ["Seiko"] },
      { itemType: "denim jacket", category: "apparel", brand: "Levi's", visibleText: ["Levi's"] },
      { itemType: "graphic tee", category: "apparel", brand: "Uniqlo", visibleText: ["Uniqlo"] },
      { itemType: "jeans", category: "apparel", brand: "Levi's", visibleText: ["Levi's"] },
      { itemType: "dress", category: "apparel", brand: "Zara", visibleText: ["Zara"] },
      { itemType: "baseball cap", category: "headwear", brand: "New Era", visibleText: ["New Era"] },
      { itemType: "beanie", category: "headwear", brand: "Carhartt", visibleText: ["Carhartt"] },
    ];
    for (const id of identities) {
      const result = enrichIdentityWithSchema(id, { overallConfidence: 0.70, attributeCertainty: { brand: 0.55, model: 0.55 } });
      const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
      assert.deepStrictEqual(overlap, [], `overlap found for ${id.itemType}`);
    }
  });
});

describe("isClothingIdentity — positive detection", () => {
  it("detects t-shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "t-shirt" }), true); });
  it("detects tee shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "tee shirt" }), true); });
  it("detects graphic tee", () => { assert.strictEqual(isClothingIdentity({ itemType: "graphic tee" }), true); });
  it("detects graphic t-shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "graphic t-shirt" }), true); });
  it("detects polo shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "polo shirt" }), true); });
  it("detects button-down shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "button-down shirt" }), true); });
  it("detects flannel shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "flannel shirt" }), true); });
  it("detects dress shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "dress shirt" }), true); });
  it("detects blouse", () => { assert.strictEqual(isClothingIdentity({ itemType: "blouse" }), true); });
  it("detects tank top", () => { assert.strictEqual(isClothingIdentity({ itemType: "tank top" }), true); });
  it("detects long sleeve shirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "long sleeve shirt" }), true); });
  it("detects crop top", () => { assert.strictEqual(isClothingIdentity({ itemType: "crop top" }), true); });
  it("detects henley", () => { assert.strictEqual(isClothingIdentity({ itemType: "henley" }), true); });
  it("detects jersey", () => { assert.strictEqual(isClothingIdentity({ itemType: "jersey" }), true); });
  it("detects pants", () => { assert.strictEqual(isClothingIdentity({ itemType: "pants" }), true); });
  it("detects jeans", () => { assert.strictEqual(isClothingIdentity({ itemType: "jeans" }), true); });
  it("detects cargo pants", () => { assert.strictEqual(isClothingIdentity({ itemType: "cargo pants" }), true); });
  it("detects dress pants", () => { assert.strictEqual(isClothingIdentity({ itemType: "dress pants" }), true); });
  it("detects trousers", () => { assert.strictEqual(isClothingIdentity({ itemType: "trousers" }), true); });
  it("detects chinos", () => { assert.strictEqual(isClothingIdentity({ itemType: "chinos" }), true); });
  it("detects sweatpants", () => { assert.strictEqual(isClothingIdentity({ itemType: "sweatpants" }), true); });
  it("detects joggers", () => { assert.strictEqual(isClothingIdentity({ itemType: "joggers" }), true); });
  it("detects leggings", () => { assert.strictEqual(isClothingIdentity({ itemType: "leggings" }), true); });
  it("detects shorts", () => { assert.strictEqual(isClothingIdentity({ itemType: "shorts" }), true); });
  it("detects cargo shorts", () => { assert.strictEqual(isClothingIdentity({ itemType: "cargo shorts" }), true); });
  it("detects dress", () => { assert.strictEqual(isClothingIdentity({ itemType: "dress" }), true); });
  it("detects maxi dress", () => { assert.strictEqual(isClothingIdentity({ itemType: "maxi dress" }), true); });
  it("detects midi dress", () => { assert.strictEqual(isClothingIdentity({ itemType: "midi dress" }), true); });
  it("detects mini dress", () => { assert.strictEqual(isClothingIdentity({ itemType: "mini dress" }), true); });
  it("detects sundress", () => { assert.strictEqual(isClothingIdentity({ itemType: "sundress" }), true); });
  it("detects shirt dress", () => { assert.strictEqual(isClothingIdentity({ itemType: "shirt dress" }), true); });
  it("detects skirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "skirt" }), true); });
  it("detects pleated skirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "pleated skirt" }), true); });
  it("detects pencil skirt", () => { assert.strictEqual(isClothingIdentity({ itemType: "pencil skirt" }), true); });
});

describe("isClothingIdentity — false-positive rejection", () => {
  it("graphic poster is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "graphic poster" }), false); });
  it("graphic novel is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "graphic novel" }), false); });
  it("golf tee is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "golf tee" }), false); });
  it("tee time is not clothing", () => { assert.strictEqual(isClothingIdentity({ styleWords: ["tee time"] }), false); });
  it("tee ball is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "tee ball set" }), false); });
  it("polo cologne is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "polo cologne" }), false); });
  it("polo horse is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "polo horse figurine" }), false); });
  it("polo match is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "polo match ticket" }), false); });
  it("water polo is not clothing", () => { assert.strictEqual(isClothingIdentity({ category: "water polo" }), false); });
  it("button battery is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "button battery" }), false); });
  it("button-down folder is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "button down folder" }), false); });
  it("flannel blanket is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "flannel blanket" }), false); });
  it("tank toy is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "tank toy" }), false); });
  it("tank top filter is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "tank top filter" }), false); });
  it("fish tank is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "fish tank" }), false); });
  it("crop tool is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "crop tool" }), false); });
  it("crop field is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "crop field" }), false); });
  it("cargo box is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "cargo box" }), false); });
  it("cargo ship is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "cargo ship" }), false); });
  it("cargo van is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "cargo van" }), false); });
  it("dress shoes is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "dress shoes" }), false); });
  it("dress watch is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "dress watch" }), false); });
  it("dress code is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "dress code guide" }), false); });
  it("window dressing is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "window dressing" }), false); });
  it("pants hanger is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "pants hanger" }), false); });
  it("pants rack is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "pants rack" }), false); });
  it("jean jacket stays garment not clothing bottom", () => { assert.strictEqual(isClothingIdentity({ itemType: "jean jacket" }), false); });
  it("denim jacket stays garment not clothing bottom", () => { assert.strictEqual(isClothingIdentity({ itemType: "denim jacket" }), false); });
  it("short circuit is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "short circuit" }), false); });
  it("shortstop is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "shortstop" }), false); });
  it("skirt steak is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "skirt steak" }), false); });
  it("grass skirt is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "grass skirt" }), false); });
  it("mini fridge is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "mini fridge" }), false); });
  it("mini keyboard is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "mini keyboard" }), false); });
  it("midi keyboard is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "midi keyboard" }), false); });
  it("maxi pad is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "maxi pad" }), false); });
  it("record sleeve is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "record sleeve" }), false); });
  it("sneakers is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "sneakers", category: "sneakers" }), false); });
  it("shoes is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "shoes" }), false); });
  it("boots is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "boots" }), false); });
  it("sandals is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "sandals" }), false); });
  it("hat is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "hat" }), false); });
  it("cap is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "cap" }), false); });
  it("beanie is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "beanie" }), false); });
  it("scarf is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "scarf" }), false); });
  it("gloves is not clothing", () => { assert.strictEqual(isClothingIdentity({ itemType: "gloves" }), false); });
  it("jacket is not clothing (stays 5B.5)", () => { assert.strictEqual(isClothingIdentity({ itemType: "jacket" }), false); });
  it("coat is not clothing (stays 5B.5)", () => { assert.strictEqual(isClothingIdentity({ itemType: "coat" }), false); });
  it("sweater is not clothing (stays 5B.5)", () => { assert.strictEqual(isClothingIdentity({ itemType: "sweater" }), false); });
  it("hoodie is not clothing (stays 5B.5)", () => { assert.strictEqual(isClothingIdentity({ itemType: "hoodie" }), false); });
  it("returns false for null", () => { assert.strictEqual(isClothingIdentity(null), false); });
  it("returns false for empty object", () => { assert.strictEqual(isClothingIdentity({}), false); });
});

describe("deriveClothingKind", () => {
  it("returns top for t-shirt", () => { assert.strictEqual(deriveClothingKind({ itemType: "t-shirt" }), "top"); });
  it("returns top for polo shirt", () => { assert.strictEqual(deriveClothingKind({ itemType: "polo shirt" }), "top"); });
  it("returns top for blouse", () => { assert.strictEqual(deriveClothingKind({ itemType: "blouse" }), "top"); });
  it("returns top for tank top", () => { assert.strictEqual(deriveClothingKind({ itemType: "tank top" }), "top"); });
  it("returns top for dress shirt", () => { assert.strictEqual(deriveClothingKind({ itemType: "dress shirt" }), "top"); });
  it("returns bottom for jeans", () => { assert.strictEqual(deriveClothingKind({ itemType: "jeans" }), "bottom"); });
  it("returns bottom for cargo pants", () => { assert.strictEqual(deriveClothingKind({ itemType: "cargo pants" }), "bottom"); });
  it("returns bottom for shorts", () => { assert.strictEqual(deriveClothingKind({ itemType: "shorts" }), "bottom"); });
  it("returns bottom for pants", () => { assert.strictEqual(deriveClothingKind({ itemType: "pants" }), "bottom"); });
  it("returns bottom for dress pants", () => { assert.strictEqual(deriveClothingKind({ itemType: "dress pants" }), "bottom"); });
  it("returns dress for dress", () => { assert.strictEqual(deriveClothingKind({ itemType: "dress" }), "dress"); });
  it("returns dress for maxi dress", () => { assert.strictEqual(deriveClothingKind({ itemType: "maxi dress" }), "dress"); });
  it("returns skirt for skirt", () => { assert.strictEqual(deriveClothingKind({ itemType: "skirt" }), "skirt"); });
  it("returns skirt for pleated skirt", () => { assert.strictEqual(deriveClothingKind({ itemType: "pleated skirt" }), "skirt"); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveClothingKind({ itemType: "camera" }), null); });
});

describe("deriveTopType", () => {
  it("derives t_shirt", () => { assert.strictEqual(deriveTopType({ itemType: "t-shirt" }), "t_shirt"); });
  it("derives graphic_tee from graphic tee", () => { assert.strictEqual(deriveTopType({ itemType: "graphic tee" }), "graphic_tee"); });
  it("derives graphic_tee from graphic t-shirt", () => { assert.strictEqual(deriveTopType({ itemType: "graphic t-shirt" }), "graphic_tee"); });
  it("derives graphic_tee from printed + t-shirt", () => { assert.strictEqual(deriveTopType({ itemType: "t-shirt", styleWords: ["printed"] }), "graphic_tee"); });
  it("derives polo from polo shirt", () => { assert.strictEqual(deriveTopType({ itemType: "polo shirt" }), "polo"); });
  it("derives button_down from button-down shirt", () => { assert.strictEqual(deriveTopType({ itemType: "button-down shirt" }), "button_down"); });
  it("derives button_down from oxford shirt", () => { assert.strictEqual(deriveTopType({ itemType: "oxford shirt" }), "button_down"); });
  it("derives flannel from flannel shirt", () => { assert.strictEqual(deriveTopType({ itemType: "flannel shirt" }), "flannel"); });
  it("derives dress_shirt from dress shirt", () => { assert.strictEqual(deriveTopType({ itemType: "dress shirt" }), "dress_shirt"); });
  it("derives blouse", () => { assert.strictEqual(deriveTopType({ itemType: "blouse" }), "blouse"); });
  it("derives tank_top from tank top", () => { assert.strictEqual(deriveTopType({ itemType: "tank top" }), "tank_top"); });
  it("derives tank_top from camisole", () => { assert.strictEqual(deriveTopType({ itemType: "camisole" }), "tank_top"); });
  it("derives crop_top", () => { assert.strictEqual(deriveTopType({ itemType: "crop top" }), "crop_top"); });
  it("derives henley", () => { assert.strictEqual(deriveTopType({ itemType: "henley" }), "henley"); });
  it("derives jersey", () => { assert.strictEqual(deriveTopType({ itemType: "jersey" }), "jersey"); });
  it("derives long_sleeve from long sleeve shirt", () => { assert.strictEqual(deriveTopType({ itemType: "long sleeve shirt" }), "long_sleeve"); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveTopType({ itemType: "camera" }), null); });
  it("returns null for jeans (is bottom, not top)", () => { assert.strictEqual(deriveTopType({ itemType: "jeans" }), null); });
});

describe("deriveBottomType", () => {
  it("derives jeans", () => { assert.strictEqual(deriveBottomType({ itemType: "jeans" }), "jeans"); });
  it("derives jeans from skinny jeans", () => { assert.strictEqual(deriveBottomType({ itemType: "skinny jeans" }), "jeans"); });
  it("derives cargo_pants", () => { assert.strictEqual(deriveBottomType({ itemType: "cargo pants" }), "cargo_pants"); });
  it("derives cargo_pants from cargo trousers", () => { assert.strictEqual(deriveBottomType({ itemType: "cargo trousers" }), "cargo_pants"); });
  it("derives dress_pants", () => { assert.strictEqual(deriveBottomType({ itemType: "dress pants" }), "dress_pants"); });
  it("derives dress_pants from slacks", () => { assert.strictEqual(deriveBottomType({ itemType: "slacks" }), "dress_pants"); });
  it("derives chinos", () => { assert.strictEqual(deriveBottomType({ itemType: "chinos" }), "chinos"); });
  it("derives sweatpants", () => { assert.strictEqual(deriveBottomType({ itemType: "sweatpants" }), "sweatpants"); });
  it("derives joggers", () => { assert.strictEqual(deriveBottomType({ itemType: "joggers" }), "joggers"); });
  it("derives leggings", () => { assert.strictEqual(deriveBottomType({ itemType: "leggings" }), "leggings"); });
  it("derives leggings from yoga pants", () => { assert.strictEqual(deriveBottomType({ itemType: "yoga pants" }), "leggings"); });
  it("derives shorts", () => { assert.strictEqual(deriveBottomType({ itemType: "shorts" }), "shorts"); });
  it("derives cargo_shorts", () => { assert.strictEqual(deriveBottomType({ itemType: "cargo shorts" }), "cargo_shorts"); });
  it("derives trousers", () => { assert.strictEqual(deriveBottomType({ itemType: "trousers" }), "trousers"); });
  it("denim jacket does NOT become jeans", () => { assert.strictEqual(deriveBottomType({ itemType: "denim jacket" }), null); });
  it("jean jacket does NOT become jeans", () => { assert.strictEqual(deriveBottomType({ itemType: "jean jacket" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveBottomType({ itemType: "camera" }), null); });
  it("returns null for t-shirt (is top, not bottom)", () => { assert.strictEqual(deriveBottomType({ itemType: "t-shirt" }), null); });
});

describe("deriveDressSkirtType", () => {
  it("derives dress for generic dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "dress" }), "dress"); });
  it("derives maxi_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "maxi dress" }), "maxi_dress"); });
  it("derives midi_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "midi dress" }), "midi_dress"); });
  it("derives mini_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "mini dress" }), "mini_dress"); });
  it("derives sundress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "sundress" }), "sundress"); });
  it("derives shirt_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "shirt dress" }), "shirt_dress"); });
  it("derives sweater_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "sweater dress" }), "sweater_dress"); });
  it("derives cocktail_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "cocktail dress" }), "cocktail_dress"); });
  it("derives wrap_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "wrap dress" }), "wrap_dress"); });
  it("derives bodycon_dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "bodycon dress" }), "bodycon_dress"); });
  it("derives skirt for generic skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "skirt" }), "skirt"); });
  it("derives pleated_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "pleated skirt" }), "pleated_skirt"); });
  it("derives pencil_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "pencil skirt" }), "pencil_skirt"); });
  it("derives denim_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "denim skirt" }), "denim_skirt"); });
  it("derives a_line_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "a-line skirt" }), "a_line_skirt"); });
  it("derives maxi_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "maxi skirt" }), "maxi_skirt"); });
  it("derives midi_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "midi skirt" }), "midi_skirt"); });
  it("derives mini_skirt", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "mini skirt" }), "mini_skirt"); });
  it("dress shirt does NOT become dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "dress shirt" }), null); });
  it("dress pants does NOT become dress", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "dress pants" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "camera" }), null); });
  it("returns null for jeans", () => { assert.strictEqual(deriveDressSkirtType({ itemType: "jeans" }), null); });
});

describe("deriveSleeveType", () => {
  it("derives short_sleeve", () => { assert.strictEqual(deriveSleeveType({ itemType: "short sleeve shirt" }), "short_sleeve"); });
  it("derives short_sleeve from hyphenated", () => { assert.strictEqual(deriveSleeveType({ itemType: "short-sleeve shirt" }), "short_sleeve"); });
  it("derives long_sleeve", () => { assert.strictEqual(deriveSleeveType({ itemType: "long sleeve shirt" }), "long_sleeve"); });
  it("derives sleeveless from sleeveless halter top", () => { assert.strictEqual(deriveSleeveType({ itemType: "halter top", styleWords: ["sleeveless"] }), "sleeveless"); });
  it("derives sleeveless from tank top", () => { assert.strictEqual(deriveSleeveType({ itemType: "tank top" }), "sleeveless"); });
  it("derives sleeveless from camisole", () => { assert.strictEqual(deriveSleeveType({ itemType: "camisole" }), "sleeveless"); });
  it("derives sleeveless from halter", () => { assert.strictEqual(deriveSleeveType({ itemType: "halter top" }), "sleeveless"); });
  it("returns null for generic t-shirt", () => { assert.strictEqual(deriveSleeveType({ itemType: "t-shirt" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveSleeveType({ itemType: "camera" }), null); });
});

describe("deriveCollarType", () => {
  it("derives crewneck", () => { assert.strictEqual(deriveCollarType({ itemType: "t-shirt", styleWords: ["crewneck"] }), "crewneck"); });
  it("derives crewneck from crew neck", () => { assert.strictEqual(deriveCollarType({ itemType: "t-shirt", styleWords: ["crew neck"] }), "crewneck"); });
  it("derives v_neck", () => { assert.strictEqual(deriveCollarType({ itemType: "t-shirt", styleWords: ["v-neck"] }), "v_neck"); });
  it("derives polo_collar from polo shirt", () => { assert.strictEqual(deriveCollarType({ itemType: "polo shirt" }), "polo_collar"); });
  it("derives button_down_collar", () => { assert.strictEqual(deriveCollarType({ itemType: "dress shirt", styleWords: ["button-down collar"] }), "button_down_collar"); });
  it("derives collared", () => { assert.strictEqual(deriveCollarType({ itemType: "dress shirt", styleWords: ["collared"] }), "collared"); });
  it("returns null for generic t-shirt", () => { assert.strictEqual(deriveCollarType({ itemType: "t-shirt" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveCollarType({ itemType: "camera" }), null); });
});

describe("deriveFitSignal", () => {
  it("derives slim", () => { assert.strictEqual(deriveFitSignal({ itemType: "jeans", styleWords: ["slim"] }), "slim"); });
  it("derives relaxed", () => { assert.strictEqual(deriveFitSignal({ itemType: "jeans", styleWords: ["relaxed"] }), "relaxed"); });
  it("derives oversized", () => { assert.strictEqual(deriveFitSignal({ itemType: "t-shirt", styleWords: ["oversized"] }), "oversized"); });
  it("derives wide_leg", () => { assert.strictEqual(deriveFitSignal({ itemType: "pants", styleWords: ["wide-leg"] }), "wide_leg"); });
  it("derives straight_leg", () => { assert.strictEqual(deriveFitSignal({ itemType: "jeans", styleWords: ["straight leg"] }), "straight_leg"); });
  it("derives skinny from skinny jeans", () => { assert.strictEqual(deriveFitSignal({ itemType: "skinny jeans" }), "skinny"); });
  it("returns null for generic jeans", () => { assert.strictEqual(deriveFitSignal({ itemType: "jeans" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveFitSignal({ itemType: "camera" }), null); });
});

describe("deriveClothingPatternSignal", () => {
  it("derives graphic from graphic tee", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "graphic tee" }), "graphic"); });
  it("derives graphic from printed", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "t-shirt", styleWords: ["printed"] }), "graphic"); });
  it("derives striped", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "polo shirt", styleWords: ["striped"] }), "striped"); });
  it("derives plaid", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "flannel shirt", styleWords: ["plaid"] }), "plaid"); });
  it("derives plaid from tartan", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "flannel shirt", styleWords: ["tartan"] }), "plaid"); });
  it("derives floral", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "dress", styleWords: ["floral"] }), "floral"); });
  it("derives solid", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "t-shirt", styleWords: ["solid"] }), "solid"); });
  it("returns null for generic t-shirt", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "t-shirt" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveClothingPatternSignal({ itemType: "camera" }), null); });
});

describe("deriveClothingMaterialSignal", () => {
  it("derives cotton from materials", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "t-shirt", materials: ["cotton"] }), "cotton"); });
  it("derives denim from type text", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "denim jeans" }), "denim"); });
  it("derives linen", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "pants", materials: ["linen"] }), "linen"); });
  it("derives silk", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "blouse", materials: ["silk"] }), "silk"); });
  it("derives polyester", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "jersey", materials: ["polyester"] }), "polyester"); });
  it("derives wool", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "dress pants", materials: ["wool"] }), "wool"); });
  it("derives corduroy", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "pants", styleWords: ["corduroy"] }), "corduroy"); });
  it("returns null for generic t-shirt", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "t-shirt" }), null); });
  it("returns null for non-clothing", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "camera" }), null); });
  it("does not infer material from brand", () => { assert.strictEqual(deriveClothingMaterialSignal({ itemType: "jeans", brand: "Levi's" }), null); });
});

describe("deriveClothingFeatures", () => {
  it("derives front_print from graphic", () => { assert.ok(deriveClothingFeatures({ itemType: "graphic tee" }).includes("front_print")); });
  it("derives cargo_pockets", () => { assert.ok(deriveClothingFeatures({ itemType: "cargo pants", styleWords: ["cargo pockets"] }).includes("cargo_pockets")); });
  it("derives drawstring_waist", () => { assert.ok(deriveClothingFeatures({ itemType: "sweatpants", styleWords: ["drawstring waist"] }).includes("drawstring_waist")); });
  it("derives pleated", () => { assert.ok(deriveClothingFeatures({ itemType: "pleated skirt" }).includes("pleated")); });
  it("derives button_front", () => { assert.ok(deriveClothingFeatures({ itemType: "dress shirt", styleWords: ["button front"] }).includes("button_front")); });
  it("derives elastic_waist", () => { assert.ok(deriveClothingFeatures({ itemType: "pants", styleWords: ["elastic waist"] }).includes("elastic_waist")); });
  it("derives belt_loops", () => { assert.ok(deriveClothingFeatures({ itemType: "jeans", styleWords: ["belt loops"] }).includes("belt_loops")); });
  it("derives five_pocket", () => { assert.ok(deriveClothingFeatures({ itemType: "jeans", styleWords: ["five-pocket"] }).includes("five_pocket")); });
  it("derives embroidered from visibleText", () => { assert.ok(deriveClothingFeatures({ itemType: "polo shirt", visibleText: ["embroidered logo"] }).includes("embroidered")); });
  it("derives logo_print from visibleText", () => { assert.ok(deriveClothingFeatures({ itemType: "t-shirt", visibleText: ["logo print"] }).includes("logo_print")); });
  it("returns empty for generic t-shirt", () => { assert.deepStrictEqual(deriveClothingFeatures({ itemType: "t-shirt" }), []); });
  it("returns empty for non-clothing", () => { assert.deepStrictEqual(deriveClothingFeatures({ itemType: "camera" }), []); });
  it("does not infer logo from brand alone", () => {
    const result = deriveClothingFeatures({ itemType: "polo shirt", brand: "Ralph Lauren" });
    assert.ok(!result.includes("logo_print"));
    assert.ok(!result.includes("embroidered"));
  });
});

describe("enrichIdentityWithSchema — clothing", () => {
  it("populates clothing fields for t-shirt", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "graphic tee", category: "apparel", styleWords: ["printed", "crewneck"], materials: ["cotton"] },
      { overallConfidence: 0.70, attributeCertainty: { category: 0.80 } }
    );
    assert.strictEqual(result.clothingKind, "top");
    assert.strictEqual(result.topType, "graphic_tee");
    assert.strictEqual(result.bottomType, null);
    assert.strictEqual(result.dressSkirtType, null);
    assert.strictEqual(result.collarType, "crewneck");
    assert.strictEqual(result.patternSignal, "graphic");
    assert.strictEqual(result.clothingMaterialSignal, "cotton");
    assert.ok(result.clothingFeatures.includes("front_print"));
  });

  it("populates clothing fields for jeans", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "skinny jeans", category: "apparel", styleWords: ["slim", "five-pocket", "belt loops"], materials: ["denim"] },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, "bottom");
    assert.strictEqual(result.bottomType, "jeans");
    assert.strictEqual(result.topType, null);
    assert.strictEqual(result.fitSignal, "slim");
    assert.strictEqual(result.clothingMaterialSignal, "denim");
    assert.ok(result.clothingFeatures.includes("five_pocket"));
    assert.ok(result.clothingFeatures.includes("belt_loops"));
  });

  it("populates clothing fields for dress", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "maxi dress", category: "apparel", styleWords: ["floral"] },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, "dress");
    assert.strictEqual(result.dressSkirtType, "maxi_dress");
    assert.strictEqual(result.patternSignal, "floral");
  });

  it("populates clothing fields for skirt", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "pleated skirt", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, "skirt");
    assert.strictEqual(result.dressSkirtType, "pleated_skirt");
    assert.ok(result.clothingFeatures.includes("pleated"));
  });

  it("clothingEvidence includes expected entries for graphic tee", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "graphic tee", category: "apparel", styleWords: ["crewneck"], materials: ["cotton"] },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.clothingEvidence.includes("kind:top"));
    assert.ok(result.clothingEvidence.includes("top:graphic_tee"));
    assert.ok(result.clothingEvidence.includes("collar:crewneck"));
    assert.ok(result.clothingEvidence.includes("pattern:graphic"));
    assert.ok(result.clothingEvidence.includes("material:cotton"));
  });

  it("non-clothing identity has null clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "camera", category: "electronics" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, null);
    assert.strictEqual(result.topType, null);
    assert.strictEqual(result.bottomType, null);
    assert.strictEqual(result.dressSkirtType, null);
    assert.strictEqual(result.sleeveType, null);
    assert.strictEqual(result.collarType, null);
    assert.strictEqual(result.fitSignal, null);
    assert.strictEqual(result.patternSignal, null);
    assert.strictEqual(result.clothingMaterialSignal, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
    assert.deepStrictEqual(result.clothingEvidence, []);
  });

  it("empty identity has null clothing fields", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.clothingKind, null);
    assert.strictEqual(result.topType, null);
    assert.strictEqual(result.bottomType, null);
    assert.strictEqual(result.dressSkirtType, null);
    assert.strictEqual(result.sleeveType, null);
    assert.strictEqual(result.collarType, null);
    assert.strictEqual(result.fitSignal, null);
    assert.strictEqual(result.patternSignal, null);
    assert.strictEqual(result.clothingMaterialSignal, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
    assert.deepStrictEqual(result.clothingEvidence, []);
  });

  it("clothing fields do NOT appear in queryTermsAllowed", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "graphic tee", category: "apparel", brand: "Uniqlo", visibleText: ["Uniqlo"], materials: ["cotton"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.ok(!result.queryTermsAllowed.includes("graphic_tee"));
    assert.ok(!result.queryTermsAllowed.includes("top"));
    assert.ok(!result.queryTermsAllowed.includes("t_shirt"));
    assert.ok(!result.queryTermsAllowed.includes("crewneck"));
  });

  it("clothing fields do NOT appear in queryTermsBlocked", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "jeans", category: "apparel", brand: "Levi's", visibleText: ["Levi's"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.ok(!result.queryTermsBlocked.includes("bottom"));
    assert.ok(!result.queryTermsBlocked.includes("jeans"));
    assert.ok(!result.queryTermsBlocked.includes("denim"));
  });

  it("queryTermsAllowed and queryTermsBlocked disjoint for clothing identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "dress", category: "apparel", brand: "Zara", visibleText: ["Zara"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });

  it("watch identity has null clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
    assert.deepStrictEqual(result.clothingEvidence, []);
  });

  it("headphone identity has null clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
  });

  it("garment identity (denim jacket) has null clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.garmentKind, "jacket");
    assert.strictEqual(result.clothingKind, null);
    assert.strictEqual(result.bottomType, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
  });

  it("book enriched identity has null clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", model: "Dune", visibleText: ["Dune"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, "book");
    assert.strictEqual(result.clothingKind, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
    assert.deepStrictEqual(result.clothingEvidence, []);
  });

  it("video game enriched identity has null clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, "video_game");
    assert.strictEqual(result.clothingKind, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
  });
});

describe("enrichIdentityWithSchema — clothing regressions", () => {
  it("dress shirt → clothingKind:top, topType:dress_shirt, not dress", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "dress shirt", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, "top");
    assert.strictEqual(result.topType, "dress_shirt");
    assert.strictEqual(result.dressSkirtType, null);
  });

  it("dress pants → clothingKind:bottom, bottomType:dress_pants, not dress", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "dress pants", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, "bottom");
    assert.strictEqual(result.bottomType, "dress_pants");
    assert.strictEqual(result.dressSkirtType, null);
  });

  it("denim jacket stays 5B.5 garment (garmentKind set) and is NOT 5B.6 bottom", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel", materials: ["denim"] },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.garmentKind, "jacket");
    assert.strictEqual(result.outerwearType, "denim_jacket");
    assert.strictEqual(result.clothingKind, null);
    assert.strictEqual(result.bottomType, null);
  });

  it("t-shirt is 5B.6 top and NOT 5B.5 garment (garmentKind null)", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.clothingKind, "top");
    assert.strictEqual(result.topType, "t_shirt");
    assert.strictEqual(result.garmentKind, null);
  });

  it("model aircraft remains non-high-stakes with clothing fields", () => {
    const result = enrichIdentityWithSchema(
      { category: "model airplane", brand: "Gemini Jets" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, false);
    assert.strictEqual(result.clothingKind, null);
    assert.deepStrictEqual(result.clothingFeatures, []);
  });

  it("high-stakes/luxury behavior unchanged by clothing enrichment", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Gucci", model: "Marmont" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    assert.strictEqual(result.luxuryCandidate, true);
    assert.strictEqual(result.authenticityClaimAllowed, false);
    assert.ok(result.queryTermsBlocked.includes("Gucci"));
    assert.strictEqual(result.clothingKind, null);
    assert.strictEqual(result.headwearKind, null);
  });
});

// === Phase 5B.7 — Headwear taxonomy tests ===

describe("isHeadwearIdentity — positive detection", () => {
  it("detects hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hat" }), true); });
  it("detects headwear via category", () => { assert.strictEqual(isHeadwearIdentity({ category: "headwear" }), true); });
  it("detects baseball cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "baseball cap" }), true); });
  it("detects dad hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "dad hat" }), true); });
  it("detects dad cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "dad cap" }), true); });
  it("detects snapback", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "snapback" }), true); });
  it("detects snapback cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "snapback cap" }), true); });
  it("detects fitted cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "fitted cap" }), true); });
  it("detects fitted hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "fitted hat" }), true); });
  it("detects trucker hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "trucker hat" }), true); });
  it("detects trucker cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "trucker cap" }), true); });
  it("detects bucket hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "bucket hat" }), true); });
  it("detects beanie", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "beanie" }), true); });
  it("detects knit beanie", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "knit beanie" }), true); });
  it("detects knit cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "knit cap" }), true); });
  it("detects knit hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "knit hat" }), true); });
  it("detects skull cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "skull cap" }), true); });
  it("detects visor", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "visor" }), true); });
  it("detects sun hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "sun hat" }), true); });
  it("detects fedora", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "fedora" }), true); });
  it("detects cowboy hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cowboy hat" }), true); });
  it("detects flat cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "flat cap" }), true); });
  it("detects newsboy cap", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "newsboy cap" }), true); });
  it("detects beret", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "beret" }), true); });
  it("detects balaclava", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "balaclava" }), true); });
  it("detects trapper hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "trapper hat" }), true); });
  it("detects earflap hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "earflap hat" }), true); });
  it("detects winter hat", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "winter hat" }), true); });
  it("detects from styleWords", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "accessory", styleWords: ["baseball cap"] }), true); });
  it("returns false for null", () => { assert.strictEqual(isHeadwearIdentity(null), false); });
  it("returns false for empty object", () => { assert.strictEqual(isHeadwearIdentity({}), false); });
});

describe("isHeadwearIdentity — false-positive rejection", () => {
  // Bare cap with non-headwear category
  it("bare cap with electronics category is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cap", category: "electronics" }), false); });
  // Homonym vetoes (UNCONDITIONAL)
  it("bottle cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "bottle cap" }), false); });
  it("lens cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "lens cap" }), false); });
  it("hubcap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hubcap" }), false); });
  it("gas cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "gas cap" }), false); });
  it("radiator cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "radiator cap" }), false); });
  it("valve cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "valve cap" }), false); });
  it("toe cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "toe cap" }), false); });
  it("cap toe is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cap toe shoe" }), false); });
  it("knee cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "knee cap" }), false); });
  it("ice cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "ice cap" }), false); });
  it("end cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "end cap" }), false); });
  it("screw cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "screw cap" }), false); });
  it("pen cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "pen cap" }), false); });
  it("cap gun is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cap gun" }), false); });
  it("cap table is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cap table" }), false); });
  it("cap rate is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cap rate" }), false); });
  it("salary cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "salary cap" }), false); });
  it("market cap is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "market cap" }), false); });
  it("cap sleeve is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cap sleeve dress" }), false); });
  it("hat trick is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hat trick" }), false); });
  // Accessory vetoes
  it("hat rack is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hat rack" }), false); });
  it("hat stand is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hat stand" }), false); });
  it("hat box is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hat box" }), false); });
  // Beanie/bucket/fedora/visor/cowboy homonyms
  it("beanie baby is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "beanie baby" }), false); });
  it("beanie boo is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "beanie boo" }), false); });
  it("bucket alone is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "bucket" }), false); });
  it("bucket list is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "bucket list" }), false); });
  it("bucket seat is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "bucket seat" }), false); });
  it("bucket bag is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "bucket bag" }), false); });
  it("fedora linux is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "fedora linux" }), false); });
  it("sun visor is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "sun visor" }), false); });
  it("car visor is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "car visor" }), false); });
  it("helmet visor is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "helmet visor" }), false); });
  it("cowboy boot is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cowboy boot" }), false); });
  it("cowboy belt is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "cowboy belt" }), false); });
  it("beret pattern is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "beret pattern" }), false); });
  // Excluded-category vetoes
  it("headphones is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "headphones" }), false); });
  it("earmuffs is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "earmuffs" }), false); });
  it("helmet is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "helmet" }), false); });
  it("mask is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "mask" }), false); });
  it("scarf is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "scarf" }), false); });
  it("gloves is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "gloves" }), false); });
  it("shoes is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "shoes" }), false); });
  it("sneakers is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "sneakers" }), false); });
  it("boots is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "boots" }), false); });
  it("sandals is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "sandals" }), false); });
  // Non-headwear clothing items (not in positive regex)
  it("shirt is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "shirt" }), false); });
  it("pants is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "pants" }), false); });
  it("dress is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "dress" }), false); });
  it("skirt is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "skirt" }), false); });
  it("jacket is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "jacket" }), false); });
  it("coat is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "coat" }), false); });
  it("sweater is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "sweater" }), false); });
  it("hoodie is not headwear", () => { assert.strictEqual(isHeadwearIdentity({ itemType: "hoodie" }), false); });
});

describe("deriveHeadwearKind", () => {
  it("returns cap for baseball cap", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "baseball cap" }), "cap"); });
  it("returns cap for snapback", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "snapback" }), "cap"); });
  it("returns cap for fitted cap", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "fitted cap" }), "cap"); });
  it("returns cap for trucker cap", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "trucker cap" }), "cap"); });
  it("returns cap for flat cap", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "flat cap" }), "cap"); });
  it("returns cap for dad hat", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "dad hat" }), "cap"); });
  it("returns beanie for beanie", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "beanie" }), "beanie"); });
  it("returns beanie for knit cap", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "knit cap" }), "beanie"); });
  it("returns beanie for skull cap", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "skull cap" }), "beanie"); });
  it("returns hat for hat", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "hat" }), "hat"); });
  it("returns hat for fedora", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "fedora" }), "hat"); });
  it("returns hat for cowboy hat", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "cowboy hat" }), "hat"); });
  it("returns hat for bucket hat", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "bucket hat" }), "hat"); });
  it("returns hat for beret", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "beret" }), "hat"); });
  it("returns visor for visor", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "visor" }), "visor"); });
  it("returns balaclava for balaclava", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "balaclava" }), "balaclava"); });
  it("returns null for non-headwear", () => { assert.strictEqual(deriveHeadwearKind({ itemType: "camera" }), null); });
});

describe("deriveHeadwearType", () => {
  it("derives snapback", () => { assert.strictEqual(deriveHeadwearType({ itemType: "snapback cap" }), "snapback"); });
  it("derives dad_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "dad hat" }), "dad_hat"); });
  it("derives fitted_cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "fitted cap" }), "fitted_cap"); });
  it("derives trucker_cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "trucker cap" }), "trucker_cap"); });
  it("derives knit_beanie", () => { assert.strictEqual(deriveHeadwearType({ itemType: "knit beanie" }), "knit_beanie"); });
  it("derives skull_cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "skull cap" }), "skull_cap"); });
  it("derives bucket_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "bucket hat" }), "bucket_hat"); });
  it("derives visor", () => { assert.strictEqual(deriveHeadwearType({ itemType: "visor" }), "visor"); });
  it("derives sun_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "sun hat" }), "sun_hat"); });
  it("derives fedora", () => { assert.strictEqual(deriveHeadwearType({ itemType: "fedora" }), "fedora"); });
  it("derives cowboy_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "cowboy hat" }), "cowboy_hat"); });
  it("derives flat_cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "flat cap" }), "flat_cap"); });
  it("derives newsboy_cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "newsboy cap" }), "newsboy_cap"); });
  it("derives beret", () => { assert.strictEqual(deriveHeadwearType({ itemType: "beret" }), "beret"); });
  it("derives balaclava", () => { assert.strictEqual(deriveHeadwearType({ itemType: "balaclava" }), "balaclava"); });
  it("derives trapper_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "trapper hat" }), "trapper_hat"); });
  it("derives earflap_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "earflap hat" }), "earflap_hat"); });
  it("derives winter_hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "winter hat" }), "winter_hat"); });
  it("derives baseball_cap from baseball cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "baseball cap" }), "baseball_cap"); });
  it("derives baseball_cap from ball cap", () => { assert.strictEqual(deriveHeadwearType({ itemType: "ball cap" }), "baseball_cap"); });
  it("derives beanie for bare beanie", () => { assert.strictEqual(deriveHeadwearType({ itemType: "beanie" }), "beanie"); });
  it("returns null for generic hat", () => { assert.strictEqual(deriveHeadwearType({ itemType: "hat" }), null); });
  it("returns null for non-headwear", () => { assert.strictEqual(deriveHeadwearType({ itemType: "camera" }), null); });
});

describe("deriveBrimType", () => {
  it("derives curved_brim from curved brim", () => { assert.strictEqual(deriveBrimType({ itemType: "baseball cap", styleWords: ["curved brim"] }), "curved_brim"); });
  it("derives curved_brim from curved bill", () => { assert.strictEqual(deriveBrimType({ itemType: "baseball cap", styleWords: ["curved bill"] }), "curved_brim"); });
  it("derives flat_brim from flat brim", () => { assert.strictEqual(deriveBrimType({ itemType: "snapback", styleWords: ["flat brim"] }), "flat_brim"); });
  it("derives flat_brim from flat bill", () => { assert.strictEqual(deriveBrimType({ itemType: "snapback", styleWords: ["flat bill"] }), "flat_brim"); });
  it("derives wide_brim from wide brim", () => { assert.strictEqual(deriveBrimType({ itemType: "sun hat", styleWords: ["wide brim"] }), "wide_brim"); });
  it("derives wide_brim from wide-brim", () => { assert.strictEqual(deriveBrimType({ itemType: "sun hat", styleWords: ["wide-brim"] }), "wide_brim"); });
  it("derives no_brim for beanie", () => { assert.strictEqual(deriveBrimType({ itemType: "beanie" }), "no_brim"); });
  it("derives no_brim for knit_beanie", () => { assert.strictEqual(deriveBrimType({ itemType: "knit beanie" }), "no_brim"); });
  it("derives no_brim for skull_cap", () => { assert.strictEqual(deriveBrimType({ itemType: "skull cap" }), "no_brim"); });
  it("derives no_brim for balaclava", () => { assert.strictEqual(deriveBrimType({ itemType: "balaclava" }), "no_brim"); });
  it("returns null for generic hat without brim info", () => { assert.strictEqual(deriveBrimType({ itemType: "hat" }), null); });
  it("returns null for non-headwear", () => { assert.strictEqual(deriveBrimType({ itemType: "camera" }), null); });
});

describe("deriveClosureAdjustType", () => {
  it("derives snapback from snapback", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "snapback" }), "snapback"); });
  it("derives snapback from snap closure", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "baseball cap", styleWords: ["snap closure"] }), "snapback"); });
  it("derives strapback from strapback", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "baseball cap", styleWords: ["strapback"] }), "strapback"); });
  it("derives strapback from buckle back", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "baseball cap", styleWords: ["buckle back"] }), "strapback"); });
  it("derives fitted from fitted cap", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "fitted cap" }), "fitted"); });
  it("derives fitted from fitted hat", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "fitted hat" }), "fitted"); });
  it("derives adjustable from adjustable", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "baseball cap", styleWords: ["adjustable"] }), "adjustable"); });
  it("derives adjustable from velcro back", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "baseball cap", styleWords: ["velcro back"] }), "adjustable"); });
  it("returns null for generic hat", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "hat" }), null); });
  it("returns null for non-headwear", () => { assert.strictEqual(deriveClosureAdjustType({ itemType: "camera" }), null); });
});

describe("deriveHeadwearMaterialSignal", () => {
  it("derives cotton from materials", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "baseball cap", materials: ["cotton"] }), "cotton"); });
  it("derives wool from materials", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "beanie", materials: ["wool"] }), "wool"); });
  it("derives knit from knit beanie", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "knit beanie" }), "knit"); });
  it("derives knit from knit cap", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "knit cap" }), "knit"); });
  it("derives knit from knit hat", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "knit hat" }), "knit"); });
  it("derives knit from explicit knit material", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "beanie", materials: ["knit"] }), "knit"); });
  it("derives mesh from mesh cap", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "mesh cap" }), "mesh"); });
  it("derives mesh from explicit mesh material", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "trucker cap", materials: ["mesh"] }), "mesh"); });
  it("derives felt from felt hat", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "felt hat" }), "felt"); });
  it("derives felt from explicit felt material", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "fedora", materials: ["felt"] }), "felt"); });
  it("derives straw from straw hat", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "straw hat" }), "straw"); });
  it("derives straw from explicit straw material", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "sun hat", materials: ["straw"] }), "straw"); });
  it("derives polyester from materials", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "baseball cap", materials: ["polyester"] }), "polyester"); });
  it("derives acrylic from materials", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "beanie", materials: ["acrylic"] }), "acrylic"); });
  it("returns null for generic hat", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "hat" }), null); });
  it("returns null for non-headwear", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "camera" }), null); });
  it("does not infer material from brand", () => { assert.strictEqual(deriveHeadwearMaterialSignal({ itemType: "baseball cap", brand: "New Era" }), null); });
});

describe("deriveHeadwearFeatures", () => {
  it("derives embroidered from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "baseball cap", styleWords: ["embroidered"] }).includes("embroidered")); });
  it("derives embroidered from visibleText", () => { assert.ok(deriveHeadwearFeatures({ itemType: "baseball cap", visibleText: ["embroidered logo"] }).includes("embroidered")); });
  it("derives patch from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "trucker hat", styleWords: ["patch"] }).includes("patch")); });
  it("derives logo_print from visibleText", () => { assert.ok(deriveHeadwearFeatures({ itemType: "baseball cap", visibleText: ["logo print"] }).includes("logo_print")); });
  it("derives mesh_back from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "trucker hat", styleWords: ["mesh back"] }).includes("mesh_back")); });
  it("derives folded_cuff from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "beanie", styleWords: ["folded cuff"] }).includes("folded_cuff")); });
  it("derives folded_cuff from cuffed beanie", () => { assert.ok(deriveHeadwearFeatures({ itemType: "beanie", styleWords: ["cuffed beanie"] }).includes("folded_cuff")); });
  it("derives pom_pom from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "beanie", styleWords: ["pom pom"] }).includes("pom_pom")); });
  it("derives pom_pom from pom-pom", () => { assert.ok(deriveHeadwearFeatures({ itemType: "beanie", styleWords: ["pom-pom"] }).includes("pom_pom")); });
  it("derives adjustable_back", () => { assert.ok(deriveHeadwearFeatures({ itemType: "baseball cap", styleWords: ["adjustable back"] }).includes("adjustable_back")); });
  it("derives snap_closure", () => { assert.ok(deriveHeadwearFeatures({ itemType: "snapback", styleWords: ["snap closure"] }).includes("snap_closure")); });
  it("derives curved_bill from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "baseball cap", styleWords: ["curved bill"] }).includes("curved_bill")); });
  it("derives flat_bill from styleWords", () => { assert.ok(deriveHeadwearFeatures({ itemType: "snapback", styleWords: ["flat bill"] }).includes("flat_bill")); });
  it("supports multiple features", () => {
    const result = deriveHeadwearFeatures({ itemType: "beanie", styleWords: ["folded cuff", "pom pom"], visibleText: ["embroidered logo"] });
    assert.ok(result.includes("embroidered"));
    assert.ok(result.includes("folded_cuff"));
    assert.ok(result.includes("pom_pom"));
  });
  it("returns empty for generic hat", () => { assert.deepStrictEqual(deriveHeadwearFeatures({ itemType: "hat" }), []); });
  it("returns empty for non-headwear", () => { assert.deepStrictEqual(deriveHeadwearFeatures({ itemType: "camera" }), []); });
  it("does not infer logo/embroidered/patch from brand alone", () => {
    const result = deriveHeadwearFeatures({ itemType: "baseball cap", brand: "New Era" });
    assert.ok(!result.includes("embroidered"));
    assert.ok(!result.includes("patch"));
    assert.ok(!result.includes("logo_print"));
  });
});

describe("enrichIdentityWithSchema — headwear", () => {
  it("populates headwear fields for baseball cap", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "baseball cap", category: "headwear", styleWords: ["curved brim"], materials: ["cotton"] },
      { overallConfidence: 0.70, attributeCertainty: { category: 0.80 } }
    );
    assert.strictEqual(result.headwearKind, "cap");
    assert.strictEqual(result.headwearType, "baseball_cap");
    assert.strictEqual(result.brimType, "curved_brim");
    assert.strictEqual(result.headwearMaterialSignal, "cotton");
  });

  it("populates headwear fields for snapback", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "snapback", category: "headwear", styleWords: ["flat brim"] },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, "cap");
    assert.strictEqual(result.headwearType, "snapback");
    assert.strictEqual(result.closureAdjustType, "snapback");
    assert.strictEqual(result.brimType, "flat_brim");
  });

  it("populates headwear fields for knit beanie", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "knit beanie", category: "headwear" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, "beanie");
    assert.strictEqual(result.headwearType, "knit_beanie");
    assert.strictEqual(result.brimType, "no_brim");
    assert.strictEqual(result.headwearMaterialSignal, "knit");
  });

  it("populates headwear fields for bucket hat", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "bucket hat", category: "headwear" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, "hat");
    assert.strictEqual(result.headwearType, "bucket_hat");
  });

  it("populates headwear fields for fitted cap", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "fitted cap", category: "headwear" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.closureAdjustType, "fitted");
  });

  it("headwearEvidence includes expected entries", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "snapback", category: "headwear", styleWords: ["flat brim", "embroidered"] },
      { overallConfidence: 0.50 }
    );
    assert.ok(result.headwearEvidence.includes("kind:cap"));
    assert.ok(result.headwearEvidence.includes("type:snapback"));
    assert.ok(result.headwearEvidence.includes("brim:flat_brim"));
    assert.ok(result.headwearEvidence.includes("closure:snapback"));
    assert.ok(result.headwearEvidence.includes("feature:embroidered"));
  });

  it("headwear identity has mediaKind === null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "baseball cap", category: "headwear" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.mediaKind, null);
  });

  it("non-headwear identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.strictEqual(result.headwearType, null);
    assert.strictEqual(result.brimType, null);
    assert.strictEqual(result.closureAdjustType, null);
    assert.strictEqual(result.headwearMaterialSignal, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
  });

  it("empty identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema({}, {});
    assert.strictEqual(result.headwearKind, null);
    assert.strictEqual(result.headwearType, null);
    assert.strictEqual(result.brimType, null);
    assert.strictEqual(result.closureAdjustType, null);
    assert.strictEqual(result.headwearMaterialSignal, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
  });

  it("headwear fields do NOT appear in queryTermsAllowed", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "baseball cap", category: "headwear", brand: "New Era", visibleText: ["New Era"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.ok(!result.queryTermsAllowed.includes("cap"));
    assert.ok(!result.queryTermsAllowed.includes("baseball_cap"));
    assert.ok(!result.queryTermsAllowed.includes("curved_brim"));
  });

  it("headwear fields do NOT appear in queryTermsBlocked", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "baseball cap", category: "headwear", brand: "New Era", visibleText: ["New Era"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.ok(!result.queryTermsBlocked.includes("cap"));
    assert.ok(!result.queryTermsBlocked.includes("baseball_cap"));
  });

  it("queryTermsAllowed and queryTermsBlocked disjoint for headwear identity", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "baseball cap", category: "headwear", brand: "New Era", visibleText: ["New Era"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.55 } }
    );
    const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
    assert.deepStrictEqual(overlap, []);
  });
});

describe("enrichIdentityWithSchema — headwear cross-type", () => {
  it("baseball cap → garmentKind:null, clothingKind:null, headwearKind:cap", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "baseball cap", category: "headwear" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, "cap");
    assert.strictEqual(result.garmentKind, null);
    assert.strictEqual(result.clothingKind, null);
  });

  it("t-shirt → headwearKind:null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
  });

  it("denim jacket → headwearKind:null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
  });

  it("analog watch → headwearKind:null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });

  it("over-ear headphones → headwearKind:null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });

  it("book → headwearKind:null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", model: "Dune", visibleText: ["Dune"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.headwearKind, null);
  });

  it("video game → headwearKind:null", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.headwearKind, null);
  });
});

describe("enrichIdentityWithSchema — headwear regressions", () => {
  it("model aircraft remains non-high-stakes with headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { category: "model airplane", brand: "Gemini Jets" },
      { overallConfidence: 0.50 }
    );
    assert.strictEqual(result.highStakes, false);
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });

  it("high-stakes/luxury behavior unchanged by headwear enrichment", () => {
    const result = enrichIdentityWithSchema(
      { category: "luxury", brand: "Gucci", model: "Marmont" },
      { overallConfidence: 0.40, attributeCertainty: { brand: 0.30 } }
    );
    assert.strictEqual(result.luxuryCandidate, true);
    assert.strictEqual(result.authenticityClaimAllowed, false);
    assert.ok(result.queryTermsBlocked.includes("Gucci"));
    assert.strictEqual(result.headwearKind, null);
  });

  it("headwear identity does not have headwearLuxurySignal field", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "fedora", category: "headwear" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearLuxurySignal, undefined);
  });

  it("watch identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "analog watch", category: "watch" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
  });

  it("headphone identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "over-ear headphones", category: "electronics" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });

  it("garment identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "denim jacket", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });

  it("clothing identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel" },
      { overallConfidence: 0.70 }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });

  it("book enriched identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "paperback book", model: "Dune", visibleText: ["Dune"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
    assert.deepStrictEqual(result.headwearEvidence, []);
  });

  it("video game enriched identity has null headwear fields", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { overallConfidence: 0.70, attributeCertainty: { model: 0.60 } }
    );
    assert.strictEqual(result.headwearKind, null);
    assert.deepStrictEqual(result.headwearFeatures, []);
  });
});
