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

describe("enrichIdentityWithSchema — regressions", () => {
  it("Rolex weak evidence still blocked (high-stakes regression)", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch", brand: "Rolex", model: "Submariner", visibleText: [] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.72, model: 0.60 } }
    );
    assert.ok(result.queryTermsBlocked.includes("Rolex"));
    assert.ok(!result.queryTermsAllowed.includes("Rolex"));
    assert.strictEqual(result.mediaKind, null);
  });

  it("Rolex confirmed still allowed (high-stakes regression)", () => {
    const result = enrichIdentityWithSchema(
      { category: "watch", brand: "Rolex", model: "Submariner", visibleText: ["ROLEX"] },
      { overallConfidence: 0.92, attributeCertainty: { brand: 0.90, model: 0.85 } }
    );
    assert.ok(result.queryTermsAllowed.includes("Rolex"));
    assert.deepStrictEqual(result.queryTermsBlocked, []);
    assert.strictEqual(result.mediaKind, null);
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

  it("apparel identity unchanged by media enrichment", () => {
    const result = enrichIdentityWithSchema(
      { itemType: "t-shirt", category: "apparel", brand: "Hanes", model: "ComfortSoft", visibleText: ["Hanes"] },
      { overallConfidence: 0.70, attributeCertainty: { brand: 0.60 } }
    );
    assert.strictEqual(result.mediaKind, null);
    assert.strictEqual(result.author, null);
    assert.strictEqual(result.isbn, null);
    assert.strictEqual(result.platform, null);
    assert.ok(!result.missingEvidence.includes("book title not readable"));
    assert.ok(!result.missingEvidence.includes("video game title not readable"));
  });

  it("queryTermsAllowed and queryTermsBlocked never overlap across all media types", () => {
    const identities = [
      { itemType: "book", model: "Dune", visibleText: ["Dune"] },
      { itemType: "video game case", model: "Zelda", visibleText: ["Nintendo Switch"] },
      { itemType: "sneakers", category: "sneakers", brand: "Nike", visibleText: ["Nike"] },
    ];
    for (const id of identities) {
      const result = enrichIdentityWithSchema(id, { overallConfidence: 0.70, attributeCertainty: { brand: 0.55, model: 0.55 } });
      const overlap = result.queryTermsAllowed.filter((t) => result.queryTermsBlocked.includes(t));
      assert.deepStrictEqual(overlap, [], `overlap found for ${id.itemType}`);
    }
  });
});
