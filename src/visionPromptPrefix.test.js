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
