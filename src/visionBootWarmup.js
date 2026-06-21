// Phase 5A.4B: warm local/runtime resources at boot so first real scan
// does not pay avoidable cold-start costs (sharp import, CLIP model load).

export async function warmSharp(timeout = 5000) {
  const t0 = Date.now();
  try {
    const sharp = (await Promise.race([
      import("sharp").then((m) => m.default),
      new Promise((_, rej) => setTimeout(() => rej(new Error("sharp_warmup_timeout")), timeout)),
    ]));
    const tiny = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=",
      "base64"
    );
    await sharp(tiny).resize(1, 1).jpeg().toBuffer();
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e?.message || String(e) };
  }
}

export async function warmEmbedder(timeout = 15000) {
  const t0 = Date.now();
  try {
    const { computeImageEmbedding } = await import("../intelligence/vision/embeddingSearch.js");
    const tiny = Buffer.from(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=",
      "base64"
    );
    await Promise.race([
      computeImageEmbedding(tiny),
      new Promise((_, rej) => setTimeout(() => rej(new Error("embedder_warmup_timeout")), timeout)),
    ]);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e?.message || String(e) };
  }
}

export async function runBootWarmup({ warmPromptCache }) {
  const t0 = Date.now();
  console.log("VISION_BOOT_WARMUP_STARTED", { startedAt: t0 });

  const results = { sharpWarmMs: null, embedderWarmMs: null, promptCacheFireMs: null, errors: [] };

  const [sharpResult, embedderResult] = await Promise.allSettled([
    warmSharp(),
    warmEmbedder(),
  ]);

  if (sharpResult.status === "fulfilled") {
    results.sharpWarmMs = sharpResult.value.ms;
    if (!sharpResult.value.ok) results.errors.push(`sharp: ${sharpResult.value.error}`);
  } else {
    results.errors.push(`sharp: ${sharpResult.reason?.message || "unknown"}`);
  }

  if (embedderResult.status === "fulfilled") {
    results.embedderWarmMs = embedderResult.value.ms;
    if (!embedderResult.value.ok) results.errors.push(`embedder: ${embedderResult.value.error}`);
  } else {
    results.errors.push(`embedder: ${embedderResult.reason?.message || "unknown"}`);
  }

  const pcT0 = Date.now();
  try {
    warmPromptCache();
    results.promptCacheFireMs = Date.now() - pcT0;
  } catch (e) {
    results.promptCacheFireMs = Date.now() - pcT0;
    results.errors.push(`promptCache: ${e?.message || "unknown"}`);
  }

  const totalWarmMs = Date.now() - t0;

  if (results.errors.length) {
    console.log("VISION_BOOT_WARMUP_FAILED", {
      totalWarmMs,
      sharpWarmMs: results.sharpWarmMs,
      embedderWarmMs: results.embedderWarmMs,
      promptCacheFireMs: results.promptCacheFireMs,
      errors: results.errors,
    });
  }

  console.log("VISION_BOOT_WARMUP_DONE", {
    totalWarmMs,
    sharpWarmMs: results.sharpWarmMs,
    embedderWarmMs: results.embedderWarmMs,
    promptCacheFireMs: results.promptCacheFireMs,
    promptCacheFired: results.promptCacheFireMs != null && !results.errors.some((e) => e.startsWith("promptCache:")),
    errorCount: results.errors.length,
  });

  return { totalWarmMs, ...results };
}
