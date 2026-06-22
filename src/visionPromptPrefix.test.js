import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildItemDynamicContext, assembleUltraLeanVisionPrompt } from "./visionPromptPrefix.js";

describe("buildItemDynamicContext", () => {
  it("returns empty string for empty propContext", () => {
    assert.equal(buildItemDynamicContext(""), "");
    assert.equal(buildItemDynamicContext(null), "");
    assert.equal(buildItemDynamicContext(undefined), "");
  });

  it("returns PRICE SIGNAL for luxury bracket", () => {
    const ctx = buildItemDynamicContext("price:luxury|listed:500|alt:300");
    assert.ok(ctx.includes("PRICE SIGNAL:"));
    assert.ok(ctx.includes("$500"));
    assert.ok(ctx.includes("$300"));
    assert.ok(ctx.includes("HIGH-VALUE ITEM"));
  });

  it("returns PRICE SIGNAL for premium bracket", () => {
    const ctx = buildItemDynamicContext("price:premium|listed:200|alt:150");
    assert.ok(ctx.includes("PRICE SIGNAL:"));
    assert.ok(ctx.includes("PREMIUM BRACKET"));
  });

  it("returns PRICE SIGNAL for mid bracket", () => {
    const ctx = buildItemDynamicContext("price:mid|listed:80|alt:60");
    assert.ok(ctx.includes("MID BRACKET"));
  });

  it("returns PRICE SIGNAL for entry bracket", () => {
    const ctx = buildItemDynamicContext("price:entry|listed:15|alt:10");
    assert.ok(ctx.includes("ENTRY BRACKET"));
  });

  it("returns USER HINT when hint present", () => {
    const ctx = buildItemDynamicContext("hint:Nike Air Force 1");
    assert.ok(ctx.includes("USER HINT:"));
    assert.ok(ctx.includes("Nike Air Force 1"));
  });

  it("returns SIZE HINT when size present", () => {
    const ctx = buildItemDynamicContext("size:10");
    assert.ok(ctx.includes("SIZE HINT:"));
    assert.ok(ctx.includes("10"));
  });

  it("returns all three signals when all present", () => {
    const ctx = buildItemDynamicContext("price:luxury|listed:500|alt:300|hint:Rolex Submariner|size:41mm");
    assert.ok(ctx.includes("PRICE SIGNAL:"));
    assert.ok(ctx.includes("USER HINT:"));
    assert.ok(ctx.includes("SIZE HINT:"));
  });

  it("uses fallback prices when listed/alt missing", () => {
    const ctx = buildItemDynamicContext("price:luxury");
    assert.ok(ctx.includes("high value"));
    assert.ok(ctx.includes("comparable"));
  });

  it("is deterministic for same input", () => {
    const a = buildItemDynamicContext("price:luxury|listed:500|alt:300|hint:watch|size:42mm");
    const b = buildItemDynamicContext("price:luxury|listed:500|alt:300|hint:watch|size:42mm");
    assert.equal(a, b);
  });
});

describe("assembleUltraLeanVisionPrompt", () => {
  const staticHeader = "MODE: STANDARD ITEM. Identify exact product when supported by evidence.";

  it("shares identical prefix for different dynamic contexts", () => {
    const noContext = assembleUltraLeanVisionPrompt(staticHeader, "");
    const withPrice = assembleUltraLeanVisionPrompt(staticHeader, buildItemDynamicContext("price:luxury|listed:500|alt:300"));
    const withHint = assembleUltraLeanVisionPrompt(staticHeader, buildItemDynamicContext("hint:Nike shoes|size:10"));

    const prefix = noContext;
    assert.ok(withPrice.startsWith(prefix), "luxury prompt must share full static prefix");
    assert.ok(withHint.startsWith(prefix), "hint prompt must share full static prefix");
  });

  it("dynamic context appears after static body", () => {
    const prompt = assembleUltraLeanVisionPrompt(staticHeader, buildItemDynamicContext("price:luxury|listed:500|alt:300"));
    const keepShortIdx = prompt.indexOf("Keep response short.");
    const priceIdx = prompt.indexOf("PRICE SIGNAL:");
    assert.ok(keepShortIdx > 0);
    assert.ok(priceIdx > keepShortIdx, "PRICE SIGNAL must come after 'Keep response short.'");
  });

  it("contains required instruction keywords", () => {
    const prompt = assembleUltraLeanVisionPrompt(staticHeader, "");
    assert.ok(prompt.includes("category"));
    assert.ok(prompt.includes("brand"));
    assert.ok(prompt.includes("confidence"));
    assert.ok(prompt.includes("query"));
    assert.ok(prompt.includes("variants"));
    assert.ok(prompt.includes("brandCertainty"));
  });

  it("contains aircraft special case instructions", () => {
    const prompt = assembleUltraLeanVisionPrompt(staticHeader, "");
    assert.ok(prompt.includes("model airplane"));
    assert.ok(prompt.includes("airline livery"));
    assert.ok(prompt.includes("aircraft family"));
    assert.ok(prompt.includes("787"));
    assert.ok(prompt.includes("GeminiJets"));
  });

  it("contains rules for brand caution", () => {
    const prompt = assembleUltraLeanVisionPrompt(staticHeader, "");
    assert.ok(prompt.includes("Never guess brand from shape alone"));
  });

  it("does not contain base64 or image data", () => {
    const prompt = assembleUltraLeanVisionPrompt(staticHeader, buildItemDynamicContext("price:luxury|listed:500|alt:300|hint:test|size:M"));
    assert.ok(!prompt.includes("base64"));
    assert.ok(!prompt.includes("data:image"));
  });

  it("is deterministic for same input", () => {
    const a = assembleUltraLeanVisionPrompt(staticHeader, "\n\nDYNAMIC");
    const b = assembleUltraLeanVisionPrompt(staticHeader, "\n\nDYNAMIC");
    assert.equal(a, b);
  });

  it("static prefix is long relative to dynamic suffix", () => {
    const noContext = assembleUltraLeanVisionPrompt(staticHeader, "");
    const withAll = assembleUltraLeanVisionPrompt(staticHeader, buildItemDynamicContext("price:luxury|listed:999|alt:800|hint:Rolex|size:42mm"));
    const dynamicLen = withAll.length - noContext.length;
    assert.ok(noContext.length > dynamicLen * 3, `static prefix (${noContext.length}) should be much larger than dynamic suffix (${dynamicLen})`);
  });
});

// Phase 5A.4C.1 drift guard. modeHeader() lives in index.js, which boots the server
// on import, so it cannot be imported here. Instead we keep a GOLDEN reference of its
// item-path signal output (a verbatim mirror of index.js modeHeader lines ~16663-16689)
// and assert buildItemDynamicContext stays semantically identical to it. Per the DRIFT
// CONTRACT comments in both files: if modeHeader's signal wording changes, update this
// golden reference AND buildItemDynamicContext together — this test will fail until the
// suffix helper matches, catching accidental divergence between the two prompt paths.
function goldenModeHeaderItemSignals(propContext) {
  const priceBracketMatch = (propContext || "").match(/price:(luxury|premium|mid|entry)/);
  const listedMatch = (propContext || "").match(/listed:([\d.]+)/);
  const altMatch = (propContext || "").match(/alt:([\d.]+)/);
  const hintMatch  = (propContext || "").match(/hint:([^|]+)/);
  const sizeMatch  = (propContext || "").match(/size:([^|]+)/);
  const priceBracketLabel = priceBracketMatch?.[1] || null;
  const listedPrice = listedMatch?.[1] ? `$${listedMatch[1]}` : null;
  const altPrice = altMatch?.[1] ? `$${altMatch[1]}` : null;

  let priceSignal = "";
  if (priceBracketLabel === "luxury") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "high value"}, cheapest alternative ${altPrice || "comparable"}. HIGH-VALUE ITEM — prioritize luxury brand extraction (LV, Gucci, Chanel, Hermès, Rolex, AP, Patek, Prada, Balenciaga, etc). These brands have authentication tells — look harder.`;
  } else if (priceBracketLabel === "premium") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "mid-high"}, cheapest alternative ${altPrice || "comparable"}. PREMIUM BRACKET — check for Nike/Jordan/Adidas/New Balance limited releases, designer streetwear, mid-tier watches, electronics with storage variants.`;
  } else if (priceBracketLabel === "mid") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "mid-range"}, cheapest alternative ${altPrice || "comparable"}. MID BRACKET — branded sportswear, contemporary fashion, used electronics. Condition matters for this price.`;
  } else if (priceBracketLabel === "entry") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "low"}, cheapest alternative ${altPrice || "comparable"}. ENTRY BRACKET — common brands, mass market, or significantly worn. Be honest about condition.`;
  }

  const itemHintSignal = hintMatch?.[1]
    ? `\nUSER HINT: The user says this is "${hintMatch[1].trim()}". Use this as a strong search-query anchor — confirm visually if consistent, then build the query around it.`
    : "";
  const sizeHintSignal = sizeMatch?.[1]
    ? `\nSIZE HINT: The user specified size/variant "${sizeMatch[1].trim()}". Include this in the search query when relevant (e.g. "Nike Air Force 1 Size 10", "Medium Blue").`
    : "";
  return `${priceSignal}${itemHintSignal}${sizeHintSignal}`;
}

describe("drift guard: buildItemDynamicContext mirrors modeHeader item path", () => {
  const matrix = [
    "",
    "price:luxury|listed:500|alt:300",
    "price:premium|listed:200|alt:150",
    "price:mid|listed:80|alt:60",
    "price:entry|listed:15|alt:10",
    "price:luxury",
    "price:premium",
    "price:mid",
    "price:entry",
    "hint:Nike Air Force 1",
    "size:10",
    "price:luxury|listed:500|alt:300|hint:Rolex Submariner|size:41mm",
    "hint:Hawaiian 787|size:1:400",
    "listed:500|alt:300",
    "garbage:value",
    "price:unknownbracket",
  ];

  for (const ctx of matrix) {
    it(`content equals modeHeader signals for: ${JSON.stringify(ctx)}`, () => {
      // buildItemDynamicContext appends a leading blank-line separator before the
      // (newline-prefixed) signals; modeHeader appends the raw signals at the front.
      // Same content, different placement — so strip the one extra separator newline.
      const golden = goldenModeHeaderItemSignals(ctx);
      const expected = golden === "" ? "" : "\n" + golden;
      assert.equal(buildItemDynamicContext(ctx), expected);
    });
  }

  it("emits nothing when no recognized signals are present", () => {
    assert.equal(buildItemDynamicContext("garbage:value"), "");
    assert.equal(buildItemDynamicContext("listed:500|alt:300"), "");
    assert.equal(buildItemDynamicContext(""), "");
  });
});
