import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyVisionPath, classifyMissReason, buildCriticalPathTimingV2 } from "./visionSpeedInstrumentation.js";

describe("classifyVisionPath", () => {
  it("returns exact_cache for exact cache hit", () => {
    assert.equal(classifyVisionPath({ cacheSource: "exact" }, {}), "exact_cache");
  });
  it("returns similarity_seed for similarity cache", () => {
    assert.equal(classifyVisionPath({ visionTier: "similarity_cache" }, {}), "similarity_seed");
    assert.equal(classifyVisionPath({ cacheSource: "similarity" }, {}), "similarity_seed");
  });
  it("returns query_fast for query_fast tier", () => {
    assert.equal(classifyVisionPath({ visionTier: "query_fast" }, {}), "query_fast");
  });
  it("returns query_fast for query_fast_refined tier", () => {
    assert.equal(classifyVisionPath({ visionTier: "query_fast_refined" }, {}), "query_fast");
  });
  it("returns master for consensus tier", () => {
    assert.equal(classifyVisionPath({ visionTier: "consensus" }, {}), "master");
  });
  it("returns master when raceWinner is consensus", () => {
    assert.equal(classifyVisionPath({ visionTier: "other" }, { raceWinner: "consensus" }), "master");
  });
  it("returns fallback for hard_fail_no_seed", () => {
    assert.equal(classifyVisionPath({ visionTier: "hard_fail_no_seed" }, {}), "fallback");
  });
  it("returns fallback for rejected_generic", () => {
    assert.equal(classifyVisionPath({ visionTier: "rejected_generic" }, {}), "fallback");
  });
  it("returns low_quality", () => {
    assert.equal(classifyVisionPath({ visionTier: "low_quality" }, {}), "low_quality");
  });
  it("returns unknown for null", () => {
    assert.equal(classifyVisionPath(null, {}), "unknown");
  });
  it("returns unknown for unrecognized tier", () => {
    assert.equal(classifyVisionPath({ visionTier: "something_else" }, {}), "unknown");
  });
});

describe("classifyMissReason", () => {
  it("returns null when under 1200ms", () => {
    assert.equal(classifyMissReason({ totalMs: 800 }), null);
  });
  it("returns no_fast_seed for hard_fail_no_seed", () => {
    assert.equal(classifyMissReason({ totalMs: 2000, visionTier: "hard_fail_no_seed" }), "no_fast_seed");
  });
  it("returns no_fast_seed for hard_deadline raceWinner", () => {
    assert.equal(classifyMissReason({ totalMs: 2000, raceWinner: "hard_deadline" }), "no_fast_seed");
  });
  it("returns high_stakes_strict when high stakes", () => {
    assert.equal(classifyMissReason({ totalMs: 2000, isHighStakes: true }), "high_stakes_strict");
  });
  it("returns query_fast_rejected when queryFastMs is null", () => {
    assert.equal(classifyMissReason({ totalMs: 2000, queryFastMs: null, visionTier: "consensus" }), "query_fast_rejected");
  });
  it("returns cold_prompt_cache when cachedInputTokens is 0", () => {
    assert.equal(classifyMissReason({
      totalMs: 2000, queryFastMs: 1500, visionTier: "query_fast",
      cachedInputTokens: 0, inputTokens: 1000,
    }), "cold_prompt_cache");
  });
  it("returns cold_embed for slow embed", () => {
    assert.equal(classifyMissReason({
      totalMs: 2000, queryFastMs: 1500, visionTier: "query_fast",
      cachedInputTokens: 500, inputTokens: 1000, embedMs: 600,
    }), "cold_embed");
  });
  it("returns cold_sharp for slow downscale", () => {
    assert.equal(classifyMissReason({
      totalMs: 2000, queryFastMs: 1500, visionTier: "query_fast",
      cachedInputTokens: 500, inputTokens: 1000, downscaleMs: 500,
    }), "cold_sharp");
  });
  it("returns model_floor when queryFastMs is high", () => {
    assert.equal(classifyMissReason({
      totalMs: 2000, queryFastMs: 1500, visionTier: "query_fast",
      cachedInputTokens: 500, inputTokens: 1000,
    }), "model_floor");
  });
  it("returns unknown as fallback", () => {
    assert.equal(classifyMissReason({
      totalMs: 2000, queryFastMs: 500, visionTier: "query_fast",
      cachedInputTokens: 500, inputTokens: 1000,
    }), "unknown");
  });
});

describe("buildCriticalPathTimingV2", () => {
  it("returns all fields with defaults", () => {
    const result = buildCriticalPathTimingV2({ rid: "r1", totalMs: 2000 });
    assert.equal(result.rid, "r1");
    assert.equal(result.totalMs, 2000);
    assert.equal(result.uploadMs, null);
    assert.equal(result.masterStarted, false);
    assert.equal(result.masterCriticalPath, false);
    assert.equal(result.under1200, null);
    assert.equal(result.embedTimedOut, false);
  });
  it("passes through provided values", () => {
    const result = buildCriticalPathTimingV2({
      rid: "r2", totalMs: 900, uploadMs: 50, preConsensusMs: 100,
      consensusMs: 700, postConsensusMs: 50, embedMs: 30,
      queryFastMs: 600, masterStarted: true, under1200: true,
    });
    assert.equal(result.uploadMs, 50);
    assert.equal(result.preConsensusMs, 100);
    assert.equal(result.consensusMs, 700);
    assert.equal(result.queryFastMs, 600);
    assert.equal(result.masterStarted, true);
    assert.equal(result.under1200, true);
  });
  it("reads embedMs from preSteps fallback", () => {
    const result = buildCriticalPathTimingV2({
      rid: "r3", totalMs: 1000, preSteps: { embed: 42, sourceBudget: 5 },
    });
    assert.equal(result.embedMs, 42);
    assert.equal(result.sourceBudgetMs, 5);
  });
});
