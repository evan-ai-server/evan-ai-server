import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeQueryAgainstBlocked } from "./querySanitizer.js";
import { enrichIdentityWithSchema } from "./universalIdentitySchema.js";

describe("sanitizeQueryAgainstBlocked", () => {
  it("removes blocked brand from high-stakes handbag query", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Gucci black leather handbag",
      ["Gucci handbag used", "black leather Gucci bag"],
      ["Gucci"]
    );
    assert.strictEqual(result.sanitizedQuery, "black leather handbag");
    assert.strictEqual(result.wouldChange, true);
    assert.ok(result.removedTerms.includes("Gucci"));
    assert.strictEqual(result.noopReason, null);
  });

  it("removes blocked brand from luxury watch query", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Rolex Submariner watch black dial",
      ["Rolex Submariner used"],
      ["Rolex", "Submariner"]
    );
    assert.strictEqual(result.sanitizedQuery, "watch black dial");
    assert.ok(result.removedTerms.includes("Rolex"));
    assert.ok(result.removedTerms.includes("Submariner"));
    assert.strictEqual(result.wouldChange, true);
  });

  it("removes blocked model when present", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Louis Vuitton Neverfull tote bag",
      [],
      ["Louis Vuitton", "Neverfull"]
    );
    assert.strictEqual(result.sanitizedQuery, "tote bag");
    assert.ok(result.removedTerms.includes("Louis Vuitton"));
    assert.ok(result.removedTerms.includes("Neverfull"));
  });

  it("does not remove generic terms not in blocked list", () => {
    const result = sanitizeQueryAgainstBlocked(
      "black leather handbag vintage",
      [],
      ["Gucci"]
    );
    assert.strictEqual(result.sanitizedQuery, "black leather handbag vintage");
    assert.strictEqual(result.wouldChange, false);
    assert.deepStrictEqual(result.removedTerms, []);
  });

  it("does not remove substring matches — Coach vs coaching", () => {
    const result = sanitizeQueryAgainstBlocked(
      "coaching bag drills equipment",
      [],
      ["Coach"]
    );
    assert.strictEqual(result.sanitizedQuery, "coaching bag drills equipment");
    assert.strictEqual(result.wouldChange, false);
    assert.deepStrictEqual(result.removedTerms, []);
  });

  it("case-insensitive phrase removal", () => {
    const result = sanitizeQueryAgainstBlocked(
      "GUCCI marmont black bag",
      [],
      ["Gucci", "Marmont"]
    );
    assert.strictEqual(result.sanitizedQuery, "black bag");
    assert.strictEqual(result.wouldChange, true);
  });

  it("punctuation-safe removal", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Gucci, black leather bag",
      [],
      ["Gucci"]
    );
    assert.ok(!result.sanitizedQuery.includes("Gucci"));
    assert.strictEqual(result.wouldChange, true);
  });

  it("preserves remaining word order", () => {
    const result = sanitizeQueryAgainstBlocked(
      "red Prada nylon tote large",
      [],
      ["Prada"]
    );
    assert.strictEqual(result.sanitizedQuery, "red nylon tote large");
  });

  it("collapses whitespace after removal", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Gucci   Marmont   handbag   black",
      [],
      ["Gucci", "Marmont"]
    );
    assert.strictEqual(result.sanitizedQuery, "handbag black");
    assert.ok(!result.sanitizedQuery.includes("  "));
  });

  it("empty blocked list returns no-op", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Nike Air Max 90",
      ["Nike shoes used"],
      []
    );
    assert.strictEqual(result.sanitizedQuery, "Nike Air Max 90");
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(result.noopReason, "blocked_terms_empty");
  });

  it("null query returns no-op", () => {
    const result = sanitizeQueryAgainstBlocked(null, [], ["Gucci"]);
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(result.noopReason, "query_empty");
  });

  it("empty string query returns no-op", () => {
    const result = sanitizeQueryAgainstBlocked("", [], ["Gucci"]);
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(result.noopReason, "query_empty");
  });

  it("sanitized query too short falls back to original", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Gucci bag",
      [],
      ["Gucci"]
    );
    assert.strictEqual(result.sanitizedQuery, "Gucci bag");
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(result.noopReason, "sanitized_query_too_short");
  });

  it("no throw on invalid inputs — undefined everything", () => {
    const result = sanitizeQueryAgainstBlocked(undefined, undefined, undefined);
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(typeof result.noopReason, "string");
  });

  it("no throw on invalid blocked terms array containing non-strings", () => {
    const result = sanitizeQueryAgainstBlocked(
      "safe query here today",
      [],
      [null, 42, undefined, "missing"]
    );
    assert.strictEqual(typeof result.sanitizedQuery, "string");
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(result.noopReason, null);
  });

  it("does not mutate input variants array", () => {
    const variants = ["Gucci bag used", "leather Gucci tote"];
    const original = [...variants];
    sanitizeQueryAgainstBlocked("Gucci black bag", variants, ["Gucci"]);
    assert.deepStrictEqual(variants, original);
  });

  it("sanitizedVariants remove blocked terms independently", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Chanel flap bag black quilted",
      ["Chanel bag used", "Chanel flap pre-owned"],
      ["Chanel"]
    );
    assert.strictEqual(result.sanitizedQuery, "flap bag black quilted");
    assert.strictEqual(result.sanitizedVariants[0], "bag used");
    assert.strictEqual(result.sanitizedVariants[1], "flap pre-owned");
    assert.strictEqual(result.wouldChange, true);
  });

  it("removedTerms includes actually removed terms only", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Hermes Birkin bag orange leather",
      [],
      ["Hermes", "Birkin", "Fendi"]
    );
    assert.ok(result.removedTerms.includes("Hermes"));
    assert.ok(result.removedTerms.includes("Birkin"));
    assert.ok(!result.removedTerms.includes("Fendi"));
  });

  it("wouldChange false when blocked terms absent from query and variants", () => {
    const result = sanitizeQueryAgainstBlocked(
      "black leather tote bag vintage",
      ["brown crossbody bag"],
      ["Gucci", "Prada"]
    );
    assert.strictEqual(result.wouldChange, false);
    assert.strictEqual(result.noopReason, null);
    assert.deepStrictEqual(result.removedTerms, []);
  });

  it("function never adds a term — output tokens subset of input", () => {
    const query = "Gucci Marmont handbag black leather";
    const inputTokens = new Set(query.toLowerCase().split(/\s+/));
    const result = sanitizeQueryAgainstBlocked(query, [], ["Gucci", "Marmont"]);
    const outputTokens = result.sanitizedQuery.toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of outputTokens) {
      assert.ok(inputTokens.has(t), `unexpected token: ${t}`);
    }
  });

  it("queryTermsAllowed is not involved — only blocked terms used", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Nike Air Jordan 1 sneaker",
      [],
      ["Nike"]
    );
    assert.strictEqual(result.sanitizedQuery, "Air Jordan 1 sneaker");
    assert.ok(!result.sanitizedQuery.includes("Nike"));
  });

  it("multi-word blocked term removed as whole phrase", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Louis Vuitton monogram canvas tote",
      [],
      ["Louis Vuitton"]
    );
    assert.strictEqual(result.sanitizedQuery, "monogram canvas tote");
    assert.ok(result.removedTerms.includes("Louis Vuitton"));
  });

  it("blocked term at end of query removed cleanly", () => {
    const result = sanitizeQueryAgainstBlocked(
      "black leather handbag Gucci",
      [],
      ["Gucci"]
    );
    assert.strictEqual(result.sanitizedQuery, "black leather handbag");
  });

  it("blocked term at start of query removed cleanly", () => {
    const result = sanitizeQueryAgainstBlocked(
      "Prada nylon backpack black",
      [],
      ["Prada"]
    );
    assert.strictEqual(result.sanitizedQuery, "nylon backpack black");
  });
});

describe("schema invariant — queryTermsAllowed ∩ queryTermsBlocked = ∅", () => {
  it("high-stakes weak evidence: allowed and blocked do not overlap", () => {
    const result = enrichIdentityWithSchema(
      { brand: "Gucci", model: "Marmont", category: "luxury", itemType: "handbag" },
      { overallConfidence: 0.25, attributeCertainty: { brand: 0.3 } }
    );
    const allowedSet = new Set(result.queryTermsAllowed);
    for (const blocked of result.queryTermsBlocked) {
      assert.ok(!allowedSet.has(blocked), `${blocked} in both allowed and blocked`);
    }
  });

  it("non-high-stakes confirmed: no blocked terms at all", () => {
    const result = enrichIdentityWithSchema(
      { brand: "Samsonite", category: "luggage", itemType: "suitcase" },
      { overallConfidence: 0.90, attributeCertainty: { brand: 0.9 } }
    );
    assert.deepStrictEqual(result.queryTermsBlocked, []);
  });
});
