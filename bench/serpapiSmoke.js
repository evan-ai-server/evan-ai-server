// bench/serpapiSmoke.js
//
// Smoke test for the SerpAPI hardening layer. Runs in two modes:
//
//   node bench/serpapiSmoke.js           — runs deterministic unit checks
//                                          against the hardening module
//                                          (URL extraction, redirect
//                                          rejection, dedupe, cache replay,
//                                          market-evidence gating). No
//                                          network calls.
//
//   node bench/serpapiSmoke.js --live    — additionally runs 5 live SerpAPI
//                                          queries against google_shopping
//                                          and prints per-query timing,
//                                          raw/usable counts, direct-URL
//                                          counts, top URLs, and the cache
//                                          status on a second replay.
//                                          Requires SERPAPI_KEY in env.

import "dotenv/config";
import {
  isGoogleRedirect,
  extractFromGoogleRedirect,
  resolveDirectProductUrl,
  filterAndRankSerpItems,
  computeMarketEvidence,
  SerpCache,
  serpCacheKey,
  buildSerpQuery,
} from "../src/serpapiHardening.js";

const LIVE = process.argv.includes("--live");
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

const SAMPLE_QUERIES = [
  "Nike Dunk Low Panda",
  "Sony WH-1000XM4",
  "Pokemon Charizard 1st edition",
  "Patagonia Synchilla fleece",
  "Lego Star Wars Millennium Falcon 75257",
];

// ─────────────────────────────────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; failures.push({ name, extra }); console.log(`  ✗ ${name}${extra ? `  →  ${extra}` : ""}`); }
}

function header(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Deterministic tests (always run)
// ─────────────────────────────────────────────────────────────────────────

function testGoogleRedirectDetection() {
  header("Google redirect detection");
  ok("rejects google.com/url?q=...",       isGoogleRedirect("https://www.google.com/url?q=https%3A%2F%2Fwww.amazon.com%2Fdp%2FB000123"));
  ok("rejects google.com/search?q=foo",    isGoogleRedirect("https://www.google.com/search?q=foo"));
  ok("rejects google.com/aclk?...",        isGoogleRedirect("https://www.google.com/aclk?sa=l&ai=DChc"));
  ok("rejects google.com/shopping/product",isGoogleRedirect("https://www.google.com/shopping/product/12345/offers"));
  ok("rejects googleadservices",           isGoogleRedirect("https://www.googleadservices.com/pagead/aclk?sa=L"));
  ok("rejects doubleclick",                isGoogleRedirect("https://ad.doubleclick.net/clk?123"));
  ok("accepts amazon.com",                !isGoogleRedirect("https://www.amazon.com/dp/B000123"));
  ok("accepts ebay.com/itm",              !isGoogleRedirect("https://www.ebay.com/itm/123456"));
  ok("accepts stockx.com",                !isGoogleRedirect("https://stockx.com/nike-dunk-low-panda"));
}

function testRedirectExtraction() {
  header("Google redirect → real URL extraction");
  const cases = [
    ["https://www.google.com/url?q=https%3A%2F%2Fwww.amazon.com%2Fdp%2FB000",     "amazon.com"],
    ["https://www.google.com/url?url=https%3A%2F%2Fstockx.com%2Fnike-dunk",       "stockx.com"],
    ["https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fwalmart.com%2Fip%2F123", "walmart.com"],
  ];
  for (const [input, expectHost] of cases) {
    const out = extractFromGoogleRedirect(input);
    const host = out ? new URL(out).hostname : "(none)";
    ok(`extracts ${expectHost} from ${input.slice(0, 60)}...`, host.includes(expectHost), `got ${host}`);
  }
  // Returns "" when no inner destination present
  ok("returns empty for plain google.com/search", extractFromGoogleRedirect("https://www.google.com/search?q=foo") === "");
}

function testResolveDirectProductUrl() {
  header("resolveDirectProductUrl");
  // Direct merchant URL wins immediately.
  const direct = resolveDirectProductUrl({
    link: "https://www.amazon.com/dp/B000",
    google_product_link: "https://www.google.com/shopping/product/123",
  });
  ok("prefers direct amazon over /shopping/product", direct.directUrl?.includes("amazon.com") && direct.source === "direct");

  // Only Google redirect present → extracted.
  const extracted = resolveDirectProductUrl({
    link: "https://www.google.com/url?q=https%3A%2F%2Fwww.ebay.com%2Fitm%2F123",
  });
  ok("extracts ebay from google redirect", extracted.directUrl?.includes("ebay.com") && extracted.source === "extracted");

  // Only pure-redirect google wrappers → rejected (no openable fallback).
  const rejected = resolveDirectProductUrl({
    link: "https://www.google.com/search?q=foo",
    url:  "https://www.google.com/url?q=https%3A%2F%2Fwww.google.com",
  });
  ok("rejects when only pure google redirects",
    rejected.directUrl === null && rejected.source === "rejected");

  // /shopping/product/ is accepted as low-confidence aggregator fallback
  // (browsable page, lists merchant offers — better than null).
  const shopFallback = resolveDirectProductUrl({
    google_product_link: "https://www.google.com/shopping/product/12345",
  });
  ok("accepts /shopping/product as google_product fallback",
    shopFallback.directUrl?.includes("/shopping/product") &&
    shopFallback.source === "google_product" &&
    shopFallback.confidence < 0.6);

  // Missing.
  const missing = resolveDirectProductUrl({});
  ok("missing when no url fields", missing.directUrl === null && missing.source === "missing");
}

function testFilterAndRank() {
  header("filterAndRankSerpItems");
  const query = "Nike Dunk Low Panda";
  const items = [
    { title: "Nike Dunk Low Panda Black White", price: 110, directUrl: "https://stockx.com/nike-dunk-panda" },
    { title: "Nike Dunk Low Panda",             price: 95,  directUrl: "https://www.ebay.com/itm/123" },
    { title: "Nike Dunk Low Panda DUPLICATE",   price: 110, directUrl: "https://stockx.com/nike-dunk-panda" }, // dup
    { title: "Random unrelated AirPods",        price: 200, directUrl: "https://amazon.com/dp/AP" },           // low relevance
    { title: "Nike Dunk Low Panda",             price: null }, // no price
    {                                                 price: 80, directUrl: "https://amazon.com/dp/x" }, // no title
  ];
  const { items: kept, rejected, directUrlCount } = filterAndRankSerpItems(items, query);
  ok("rejects duplicate stockx",         rejected.duplicate >= 1);
  ok("rejects low-relevance AirPods",    rejected.lowRelevance >= 1);
  ok("rejects no-price item",            rejected.noPrice >= 1);
  ok("rejects no-title item",            rejected.noTitle >= 1);
  ok("keeps at least 2 panda listings",  kept.length >= 2);
  ok("directUrlCount > 0",               directUrlCount >= 2);
  ok("cheapest panda is ranked first",   kept[0]?.price === 95);
}

function testMarketEvidence() {
  header("computeMarketEvidence (BUY safety gate)");
  // 0 listings → low
  const e0 = computeMarketEvidence([]);
  ok("0 listings → low",          e0.confidence === "low");

  // 2 listings → low (below min good)
  const e2 = computeMarketEvidence([
    { title: "x", price: 10, directUrl: "https://amazon.com/x" },
    { title: "y", price: 12, directUrl: "https://amazon.com/y" },
  ]);
  ok("2 listings → low",          e2.confidence === "low");

  // 5 listings all indirect → low
  const e5indirect = computeMarketEvidence([
    { title: "x", price: 10 },
    { title: "y", price: 11 },
    { title: "z", price: 12 },
    { title: "a", price: 13 },
    { title: "b", price: 14 },
  ]);
  ok("5 indirect listings → low", e5indirect.confidence === "low");

  // 5 listings all direct, tight prices → high
  const e5good = computeMarketEvidence([
    { title: "Nike Dunk", price: 100, directUrl: "https://x.com/1" },
    { title: "Nike Dunk", price: 105, directUrl: "https://x.com/2" },
    { title: "Nike Dunk", price: 108, directUrl: "https://x.com/3" },
    { title: "Nike Dunk", price: 110, directUrl: "https://x.com/4" },
    { title: "Nike Dunk", price: 112, directUrl: "https://x.com/5" },
  ], "Nike Dunk");
  ok("5 direct tight listings → medium or high", e5good.confidence !== "low");
}

function testCacheReplay() {
  header("SerpCache (fresh / stale / expired)");
  const cache = new SerpCache({ freshTtlMs: 50, staleTtlMs: 150, maxSize: 10 });
  const key = serpCacheKey("smoke-test");
  cache.set(key, { items: [{ title: "x" }], rawCount: 1, directUrlCount: 1 });

  const r1 = cache.get(key);
  ok("immediate hit → fresh", r1.fresh && !r1.stale);

  // Wait for fresh to expire
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    await wait(75);
    const r2 = cache.get(key);
    ok("after fresh TTL → stale", !r2.fresh && r2.stale);

    await wait(100);
    const r3 = cache.get(key);
    ok("after stale TTL → empty", !r3.fresh && !r3.stale && r3.entry === null);
  })();
}

function testBuildSerpQuery() {
  header("buildSerpQuery");
  const q1 = buildSerpQuery({ brand: "Nike", model: "Dunk Low", colorway: "Panda", category: "sneakers", condition: "used" });
  ok("sneaker query well-formed", /nike/i.test(q1) && /dunk/i.test(q1) && /panda/i.test(q1) && /used/i.test(q1) && q1.length <= 80);

  const q2 = buildSerpQuery({ brand: "Sony", model: "WH-1000XM4", category: "electronics", condition: "new" });
  ok("electronics: drops 'new' (noise)", !/\bnew\b/i.test(q2));

  const q3 = buildSerpQuery({ title: "Charizard 1st edition", set: "base", number: "4/102", category: "cards" });
  ok("cards: builds from title+set+number", /charizard/i.test(q3) && /base/i.test(q3));
}

// ─────────────────────────────────────────────────────────────────────────
// Live SerpAPI test (only with --live)
// ─────────────────────────────────────────────────────────────────────────

async function fetchLive(query) {
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    hl: "en",
    gl: "us",
    api_key: SERPAPI_KEY,
  });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Number(process.env.SERPAPI_TIMEOUT_MS || 3000));
  const startedAt = Date.now();
  try {
    const r = await fetch(`https://serpapi.com/search.json?${params.toString()}`, { signal: controller.signal });
    if (!r.ok) return { ok: false, latencyMs: Date.now() - startedAt, status: r.status };
    const data = await r.json();
    const raw = [
      ...(Array.isArray(data.shopping_results)        ? data.shopping_results        : []),
      ...(Array.isArray(data.inline_shopping_results) ? data.inline_shopping_results : []),
    ];
    return { ok: true, latencyMs: Date.now() - startedAt, raw };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, timedOut: err?.name === "AbortError" };
  } finally {
    clearTimeout(t);
  }
}

async function runLive() {
  header(`Live SerpAPI smoke (${SAMPLE_QUERIES.length} queries)`);
  if (!SERPAPI_KEY) {
    console.log("  (skipped — SERPAPI_KEY not set)");
    return;
  }
  const liveCache = new SerpCache({ freshTtlMs: 60_000, staleTtlMs: 300_000, maxSize: 50 });
  const latencies = [];

  for (const q of SAMPLE_QUERIES) {
    const key = serpCacheKey(q, "shopping");

    // Pass 1 — miss
    const pass1 = await fetchLive(q);
    if (!pass1.ok) {
      console.log(`  • ${q.padEnd(40)}  FAILED  status=${pass1.status || (pass1.timedOut ? "timeout" : "error")}`);
      continue;
    }
    latencies.push(pass1.latencyMs);

    const resolved = pass1.raw.map((it) => {
      const r = resolveDirectProductUrl(it);
      return {
        title:      it.title || "",
        price:      Number(it.extracted_price ?? String(it.price || "").replace(/[^0-9.]/g, "")) || null,
        totalPrice: Number(it.extracted_price ?? String(it.price || "").replace(/[^0-9.]/g, "")) || null,
        directUrl:  r.directUrl,
        urlSource:  r.source,
      };
    });
    const { items: usable, directUrlCount } = filterAndRankSerpItems(resolved, q);

    liveCache.set(key, { items: usable, rawCount: pass1.raw.length, directUrlCount });

    console.log(`  • ${q}`);
    console.log(`      pass 1: miss  · ${pass1.latencyMs.toString().padStart(4)}ms  raw=${pass1.raw.length}  usable=${usable.length}  direct=${directUrlCount}`);
    for (const u of usable.slice(0, 3)) {
      const host = u.directUrl ? new URL(u.directUrl).hostname.replace(/^www\./, "") : "(none)";
      console.log(`         ↳ $${(u.price ?? 0).toFixed(2).padStart(7)}  ${host.padEnd(22)}  ${u.title.slice(0, 60)}`);
    }

    // Pass 2 — should be fresh cache hit (< 5ms)
    const passStart = Date.now();
    const cached = liveCache.get(key);
    const passLat = Date.now() - passStart;
    console.log(`      pass 2: ${cached.fresh ? "fresh" : cached.stale ? "stale" : "miss "} · ${passLat.toString().padStart(4)}ms  (cache replay)`);
  }

  if (latencies.length) {
    latencies.sort((a, b) => a - b);
    const avg = Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length);
    const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
    console.log(`\n  Live summary: avg=${avg}ms  p95=${p95}ms  (timeout cap=${process.env.SERPAPI_TIMEOUT_MS || 3000}ms)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`SerpAPI hardening smoke — mode=${LIVE ? "live" : "offline"}`);

  testGoogleRedirectDetection();
  testRedirectExtraction();
  testResolveDirectProductUrl();
  testFilterAndRank();
  testMarketEvidence();
  await testCacheReplay();
  testBuildSerpQuery();

  if (LIVE) await runLive();

  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log(`  ✗ ${f.name}${f.extra ? `  →  ${f.extra}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(2);
});
