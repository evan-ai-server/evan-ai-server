import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runBootWarmup } from "./visionBootWarmup.js";

describe("runBootWarmup", () => {
  it("calls warmPromptCache and logs results", async () => {
    let called = false;
    const result = await runBootWarmup({
      warmPromptCache: () => { called = true; },
    });
    assert.equal(called, true);
    assert.equal(typeof result.totalWarmMs, "number");
    assert.ok(result.totalWarmMs >= 0);
    assert.equal(typeof result.promptCacheFireMs, "number");
  });

  it("reports promptCacheFired in DONE log", async () => {
    let fired = false;
    const result = await runBootWarmup({
      warmPromptCache: () => { fired = true; },
    });
    assert.equal(fired, true);
    assert.equal(typeof result.promptCacheFireMs, "number");
    assert.ok(!result.errors.some((e) => e.startsWith("promptCache:")));
  });

  it("captures warmPromptCache error without throwing", async () => {
    const result = await runBootWarmup({
      warmPromptCache: () => { throw new Error("test_error"); },
    });
    assert.equal(typeof result.totalWarmMs, "number");
    assert.ok(result.errors.some((e) => e.includes("test_error")));
  });

  it("returns sharpWarmMs as a number", async () => {
    const result = await runBootWarmup({
      warmPromptCache: () => {},
    });
    assert.equal(typeof result.sharpWarmMs, "number");
    assert.ok(result.sharpWarmMs >= 0);
  });

  it("skips embedder warmup by default", async () => {
    const result = await runBootWarmup({
      warmPromptCache: () => {},
    });
    assert.equal(result.embedderSkipped, true);
    assert.equal(result.embedderWarmMs, null);
    assert.ok(!result.errors.some((e) => e.startsWith("embedder:")));
  });

  it("runs embedder warmup when explicitly enabled", async () => {
    let called = false;
    const result = await runBootWarmup({
      warmPromptCache: () => {},
      warmEmbedder: true,
      embedderFn: async () => { called = true; return { ok: true, ms: 1 }; },
    });
    assert.equal(called, true);
    assert.equal(result.embedderSkipped, false);
    assert.equal(typeof result.embedderWarmMs, "number");
  });

  it("default is production-safe: no ONNX load without opt-in", async () => {
    const result = await runBootWarmup({
      warmPromptCache: () => {},
    });
    assert.equal(result.embedderSkipped, true);
    assert.equal(result.embedderWarmMs, null);
    assert.equal(typeof result.sharpWarmMs, "number");
    assert.equal(typeof result.promptCacheFireMs, "number");
  });
});
