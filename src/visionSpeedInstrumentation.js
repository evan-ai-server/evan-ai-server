// Phase 5A.4A: vision speed instrumentation helpers.

export function classifyVisionPath(shaped, visionTimings) {
  if (!shaped) return "unknown";
  const tier = shaped.visionTier || shaped.cacheSource;
  if (tier === "exact" || shaped.cacheSource === "exact") return "exact_cache";
  if (tier === "similarity_cache" || shaped.cacheSource === "similarity" || shaped.cacheSource === "similarity_cache") return "similarity_seed";
  if (tier === "query_fast") return "query_fast";
  if (tier === "low_quality") return "low_quality";
  if (tier === "hard_fail_no_seed" || tier === "rejected_generic") return "fallback";
  if (visionTimings?.raceWinner === "consensus") return "master";
  if (tier === "consensus") return "master";
  if (tier === "query_fast_refined") return "query_fast";
  return "unknown";
}

export function classifyMissReason({
  totalMs,
  uploadMs,
  embedMs,
  downscaleMs,
  queryFastMs,
  cachedInputTokens,
  inputTokens,
  visionTier,
  raceWinner,
  isHighStakes,
}) {
  if (typeof totalMs === "number" && totalMs <= 1200) return null;

  if (visionTier === "hard_fail_no_seed" || visionTier === "rejected_generic") return "no_fast_seed";
  if (raceWinner === "hard_deadline") return "no_fast_seed";

  if (isHighStakes) return "high_stakes_strict";

  if (queryFastMs == null && visionTier !== "query_fast") return "query_fast_rejected";

  if (typeof cachedInputTokens === "number" && typeof inputTokens === "number" &&
      inputTokens > 0 && cachedInputTokens === 0) return "cold_prompt_cache";

  if (typeof embedMs === "number" && embedMs > 500) return "cold_embed";
  if (typeof downscaleMs === "number" && downscaleMs > 400) return "cold_sharp";

  if (typeof queryFastMs === "number" && queryFastMs > 800) return "model_floor";

  return "unknown";
}

export function buildCriticalPathTimingV2({
  rid, totalMs, uploadMs, preConsensusMs, consensusMs, postConsensusMs,
  exactCacheMs, embedMs, embedTimedOut, downscaleMs, sourceBudgetMs,
  queryFastMs, visualShapeMs, masterStarted, masterCriticalPath,
  firstResponder, promptCached, cachedInputTokens, under1200,
  preSteps,
}) {
  return {
    rid,
    totalMs,
    uploadMs:           uploadMs ?? null,
    preConsensusMs:     preConsensusMs ?? null,
    consensusMs:        consensusMs ?? null,
    postConsensusMs:    postConsensusMs ?? null,
    exactCacheMs:       exactCacheMs ?? null,
    embedMs:            embedMs ?? (preSteps?.embed ?? null),
    embedTimedOut:      embedTimedOut ?? false,
    downscaleMs:        downscaleMs ?? null,
    sourceBudgetMs:     sourceBudgetMs ?? (preSteps?.sourceBudget ?? null),
    queryFastMs:        queryFastMs ?? null,
    visualShapeMs:      visualShapeMs ?? null,
    masterStarted:      masterStarted ?? false,
    masterCriticalPath: masterCriticalPath ?? false,
    firstResponder:     firstResponder ?? null,
    promptCached:       promptCached ?? null,
    cachedInputTokens:  cachedInputTokens ?? null,
    under1200:          under1200 ?? null,
  };
}
