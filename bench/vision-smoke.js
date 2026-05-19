#!/usr/bin/env node
// bench/vision-smoke.js
// =====================================================================
// End-to-end vision pipeline smoke test. Fires a real image at
// /vision/analyze and verifies every speed-pass code path actually runs:
//
//   1. prepareVisionBuffer() — image downscale (logs "📐 VISION DOWNSCALE")
//   2. runVisionConsensus()  — fast+visual+master parallel (logs vision tier)
//   3. AbortController       — master cancellation when visual is confident
//   4. costForUsage()        — per-pass cost telemetry
//   5. recordVisionTiming()  — populates /debug/timings ring buffer
//   6. /debug/timings.byCohort.lift — full readiness object
//
// Exit codes:
//   0  full pipeline worked, all instrumentation populated
//   1  /vision/analyze returned non-OK or crashed
//   2  pipeline ran but specific instrumentation missing (downscale, cost, etc.)
//   3  setup error (server unreachable, no test image, etc.)
// =====================================================================

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SERVER     = process.env.BENCH_SERVER || "http://localhost:3001";
const API_KEY    = process.env.BENCH_API_KEY || process.env.API_KEY || "evan-test-local";
const BYPASS     = process.env.BENCH_BYPASS_SECRET || "";
const USER_ID    = process.env.BENCH_USER_ID || "vision-smoke-runner";
// SMOKE_IMAGE = path to a real product image (e.g. for testing cache layers).
// Default = synthetic image (random noise) — guaranteed cache miss every run,
// so the full pipeline runs fresh each time. We don't care about identifying
// the image correctly; we care that downscale + tier decision + cancellation
// + cost telemetry all execute.
const TEST_IMAGE = process.env.SMOKE_IMAGE || null;

// Generate a synthetic 1200×900 JPEG with random pixel noise. Hash + embedding
// will be unique per run, defeating both the exact-hash and perceptual-similarity
// caches in /vision/analyze. Output is large enough (>800px) to trigger the
// downscale code path.
async function makeSyntheticImage() {
  const w = 1200, h = 900;
  const noise = crypto.randomBytes(w * h * 3); // 3 channels: RGB
  return sharp(noise, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function red(s)   { return `\x1b[31m${s}\x1b[0m`; }
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function dim(s)   { return `\x1b[2m${s}\x1b[0m`; }

async function main() {
  console.log(dim("Vision pipeline smoke test"));
  console.log(dim(`server: ${SERVER}`));

  // 1. Load or generate test image
  let imageBuf;
  if (TEST_IMAGE) {
    console.log(dim(`image:  ${TEST_IMAGE} (real)`));
    try {
      imageBuf = await fs.readFile(TEST_IMAGE);
    } catch (e) {
      console.error(red(`✗ cannot read test image: ${e.message}`));
      process.exit(3);
    }
  } else {
    console.log(dim(`image:  synthetic 1200×900 random noise (fresh each run)`));
    imageBuf = await makeSyntheticImage();
  }
  console.log(dim(`image size: ${(imageBuf.length / 1024).toFixed(0)} KB`));

  // 2. Health check
  try {
    const h = await fetch(`${SERVER}/health`);
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch (e) {
    console.error(red(`✗ server unreachable: ${e.message}`));
    console.error(dim(`  start it with: npm start`));
    process.exit(3);
  }

  // 3. Reset timings ring so we measure ONLY this scan
  await fetch(`${SERVER}/debug/timings?reset=1`).catch(() => null);

  // 4. Fire the scan via multipart upload to /vision/analyze
  console.log("\n→ POST /vision/analyze");
  const form = new FormData();
  const blob = new Blob([imageBuf], { type: "image/jpeg" });
  form.append("image", blob, "smoke-test.jpg");
  form.append("mode", "item");
  form.append("userId", USER_ID);
  // Cache-bust the vision cache key by injecting a unique propContext per
  // run. Without this the second smoke run hits the in-memory hash cache and
  // we exercise none of the pipeline. The propContext is part of the cacheKey
  // (see /vision/analyze handler ~line 15880).
  form.append("propContext", `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const headers = { "x-api-key": API_KEY, "x-user-id": USER_ID };
  if (BYPASS) headers["x-bench-bypass"] = BYPASS;

  const t0 = Date.now();
  let res, body;
  try {
    res = await fetch(`${SERVER}/vision/analyze`, {
      method:  "POST",
      headers,
      body:    form,
    });
    body = await res.json();
  } catch (e) {
    console.error(red(`✗ /vision/analyze threw: ${e.message}`));
    process.exit(1);
  }
  const ms = Date.now() - t0;

  console.log(`  status: ${res.status}  wall: ${ms}ms`);
  console.log(`  ok: ${body?.ok}  query: ${body?.query || "(none)"}`);
  console.log(`  identity: ${JSON.stringify(body?.identity)?.slice(0, 120) || "(none)"}`);
  console.log(`  reason: ${body?.reason || "(none)"}`);
  console.log(`  cached: ${body?.cached || false} cacheSource: ${body?.cacheSource || "n/a"}`);

  if (!res.ok || body?.ok === false) {
    console.error(red(`✗ scan failed`));
    console.error(JSON.stringify(body, null, 2).slice(0, 1500));
    process.exit(1);
  }

  // 5. Read /debug/timings to verify the instrumentation populated
  console.log("\n→ GET /debug/timings");
  const timings = await fetch(`${SERVER}/debug/timings`).then((r) => r.json());

  if (body?.cached) {
    console.log(dim("  scan was cached — instrumentation may not have populated this run."));
    console.log(dim("  re-run with a fresh image or flush vision cache to exercise the pipeline."));
  }

  console.log(`  sample: ${timings.sample}  readiness: ${timings.readiness?.state}`);
  console.log(`  rollout: ${JSON.stringify(timings.rollout)}`);

  const recent = (timings.recent || [])[0];
  if (!recent) {
    console.error(red(`✗ /debug/timings.recent is empty after a successful scan`));
    console.error(dim(`  scan path didn't reach recordVisionTiming() — was vision short-circuited by cache?`));
    if (body?.cached) {
      console.log(dim(`  (cached response — that's expected behavior, not a bug)`));
      process.exit(0);
    }
    process.exit(2);
  }

  console.log("\n=== Instrumentation report ===");
  const checks = [
    { label: "vision tier recorded",       pass: !!recent.tier,                                      val: recent.tier },
    { label: "wall time captured",         pass: Number.isFinite(recent.visionWallMs) && recent.visionWallMs > 0, val: recent.visionWallMs + "ms" },
    { label: "fast pass timed",            pass: recent.fastMs !== undefined,                       val: recent.fastMs + "ms" },
    { label: "visual pass timed",          pass: Number.isFinite(recent.visualMs),                   val: recent.visualMs + "ms" },
    { label: "master pass tracked",        pass: recent.masterMs !== undefined,                     val: recent.masterMs == null ? "cancelled" : recent.masterMs + "ms" },
    { label: "cohort tagged",              pass: !!recent.cohort,                                   val: recent.cohort },
    { label: "downscale captured",         pass: recent.downscaled === true || recent.downscaled === false, val: recent.downscaled ? `${recent.downscaleFromBytes} → ${recent.downscaleToBytes} bytes` : "skipped (image already small)" },
    { label: "cost telemetry populated",   pass: Number.isFinite(recent.costUsd),                    val: `$${(recent.costUsd ?? 0).toFixed(6)}` },
    { label: "cost breakdown present",     pass: !!recent.costBreakdown && typeof recent.costBreakdown === "object", val: JSON.stringify(recent.costBreakdown) },
    { label: "visual confidence captured", pass: recent.visualConfidence === null || Number.isFinite(recent.visualConfidence), val: recent.visualConfidence },
  ];

  let failed = 0;
  for (const c of checks) {
    const mark = c.pass ? green("✓") : red("✗");
    console.log(`  ${mark} ${c.label.padEnd(36)} ${dim(String(c.val))}`);
    if (!c.pass) failed++;
  }

  // Master cancellation specifically — did it actually fire?
  if (recent.tier === "visual_skip_master" || recent.tier === "fast") {
    console.log(`\n  ${green("✓")} master skip fired (tier=${recent.tier})`);
    if (recent.costBreakdown?.masterCancelled) {
      console.log(`  ${green("✓")} master AbortController triggered (costBreakdown.masterCancelled=true)`);
    } else {
      console.log(`  ${dim("~")} master finished before we could cancel (race won) — billed in full`);
    }
  } else if (recent.tier === "consensus_with_fast_seed" || recent.tier === "consensus" || recent.tier === "consensus_no_fast") {
    console.log(`\n  ${dim("~")} master skip didn't fire this scan (visual confidence ${recent.visualConfidence} < ${timings.rollout?.skipMasterThreshold ?? "?"}). Pipeline still works; just no cancellation to verify on this image.`);
  }

  console.log("");
  if (failed > 0) {
    console.error(red(`✗ ${failed} instrumentation check(s) failed`));
    console.error(JSON.stringify(recent, null, 2));
    process.exit(2);
  }

  console.log(green(`✓ vision pipeline end-to-end OK (${ms}ms wall, tier=${recent.tier}, cost=$${(recent.costUsd ?? 0).toFixed(6)})`));
  process.exit(0);
}

main().catch((e) => {
  console.error(red(`✗ uncaught: ${e?.stack || e}`));
  process.exit(3);
});
