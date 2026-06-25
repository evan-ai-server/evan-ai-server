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
    assert.ok(!result.missingEvidence.includes("book title not readable"));
    assert.ok(!result.missingEvidence.includes("video game title not readable"));
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
  });

  it("queryTermsAllowed and queryTermsBlocked never overlap across all media types", () => {
    const identities = [
      { itemType: "book", model: "Dune", visibleText: ["Dune"] },
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { itemType: "sneakers", category: "sneakers", brand: "Nike", visibleText: ["Nike"] },
      { itemType: "over-ear headphones", category: "electronics", brand: "Sony", visibleText: ["Sony"] },
      { itemType: "analog watch", category: "watch", brand: "Seiko", visibleText: ["Seiko"] },
      { itemType: "denim jacket", category: "apparel", brand: "Levi's", visibleText: ["Levi's"] },
    ];
    for (const id of identities) {
      const result = enrichIdentityWithSchema(id, { overallConfidence: 0.70, attributeCertainty: { brand: 0.55, model: 0.55 } });
      const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
      assert.deepStrictEqual(overlap, [], `overlap found for ${id.itemType}`);
    }
  });
});
