#!/usr/bin/env node
// bench/run.js
// =====================================================================
// Verdict regression harness for /market/search.
//
// Hits the running server with a fixture set of scans, asserts the
// canonical buyOrPass.verdict and legacy dealComparator.verdict.verdict
// against expected values, and measures wall-time per case.
//
// Compares the current run against `bench/baseline.json` (if present)
// and fails loud on:
//   - any verdict assertion failure
//   - any case whose verdict differs from baseline (silent drift)
//   - p95 wall-time regression > 25%
//
// Usage:
//   node bench/run.js                              run + compare to baseline
//   node bench/run.js --save                       run + write baseline.json
//   node bench/run.js --server=http://host:3001    custom server URL
//   node bench/run.js --cases=path/to/cases.json   custom fixture set
//   node bench/run.js --api-key=<key>              override x-api-key
//   node bench/run.js --timeout=120000             per-request timeout (ms)
//
// Exit codes:
//   0  all assertions passed, no regressions
//   1  assertion failure, drift, or regression detected
//   2  setup error (server unreachable, bad fixtures, etc.)
// =====================================================================

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Arg parsing ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    save:       false,
    server:     process.env.BENCH_SERVER  || "http://localhost:3001",
    cases:      process.env.BENCH_CASES   || path.join(__dirname, "cases.json"),
    baseline:   process.env.BENCH_BASELINE|| path.join(__dirname, "baseline.json"),
    apiKey:     process.env.BENCH_API_KEY || process.env.API_KEY || "evan-test-local",
    userId:     process.env.BENCH_USER_ID || "bench-runner",
    bypass:     process.env.BENCH_BYPASS_SECRET || "",
    timeout:    Number(process.env.BENCH_TIMEOUT_MS) || 180_000,
    regressPct: Number(process.env.BENCH_REGRESS_PCT) || 25,
    json:       false,
  };

  for (const raw of argv.slice(2)) {
    if (raw === "--save")           { args.save = true; continue; }
    if (raw === "--json")           { args.json = true; continue; }
    if (raw === "--help" || raw === "-h") { args.help = true; continue; }

    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const k = raw.slice(0, eq);
    const v = raw.slice(eq + 1);

    if (k === "--server")     args.server   = v;
    else if (k === "--cases") args.cases    = path.resolve(v);
    else if (k === "--baseline") args.baseline = path.resolve(v);
    else if (k === "--api-key")  args.apiKey   = v;
    else if (k === "--user-id")  args.userId   = v;
    else if (k === "--bypass")   args.bypass   = v;
    else if (k === "--timeout")  args.timeout  = Number(v) || args.timeout;
    else if (k === "--regress-pct") args.regressPct = Number(v) || args.regressPct;
  }

  return args;
}

function printHelp() {
  process.stdout.write([
    "Usage: node bench/run.js [options]",
    "",
    "Options:",
    "  --save                  write current run to baseline.json (skips drift check)",
    "  --json                  print machine-readable JSON instead of markdown",
    "  --server=URL            server base URL (default: http://localhost:3001)",
    "  --cases=PATH            fixture file (default: bench/cases.json)",
    "  --baseline=PATH         baseline file (default: bench/baseline.json)",
    "  --api-key=KEY           x-api-key header value (default: $API_KEY)",
    "  --user-id=ID            userId injected into body (dev auth fallback)",
    "  --timeout=MS            per-request timeout (default: 180000)",
    "  --regress-pct=N         fail if p95 regresses by more than N%% (default: 25)",
    "  -h, --help              show this help",
    "",
  ].join("\n"));
}

// ── Verdict normalization ────────────────────────────────────────────
// Mirror the server's shared/verdict.js mapping so we can speak in the
// canonical alphabet (BUY/HOLD/PASS) and accept fixture aliases.
const CANONICAL_VERDICTS = new Set(["BUY", "HOLD", "PASS"]);

const VERDICT_ALIASES = new Map([
  ["BUY",         "BUY"],
  ["HOLD",        "HOLD"],
  ["PASS",        "PASS"],
  ["STEAL_DEAL",  "BUY"],
  ["STEAL DEAL",  "BUY"],
  ["STEAL",       "BUY"],
  ["BUY_NOW",     "BUY"],
  ["BUY NOW",     "BUY"],
  ["GOOD_DEAL",   "BUY"],
  ["GOOD DEAL",   "BUY"],
  ["FAIR",        "HOLD"],
  ["WATCH",       "HOLD"],
  ["CHECK",       "HOLD"],
  ["SKIP",        "PASS"],
  ["OVERPRICED",  "PASS"],
  ["PRICE TRAP",  "PASS"],
  ["PRICE_TRAP",  "PASS"],
  ["RISKY",       "PASS"],
  ["AVOID",       "PASS"],
]);

function normalizeCanonical(v) {
  if (v == null) return null;
  const key = String(v).trim().toUpperCase().replace(/_/g, " ").replace(/\s+/g, " ");
  // Accept either the bare alias or the spaced form.
  return VERDICT_ALIASES.get(key) ?? VERDICT_ALIASES.get(key.replace(/ /g, "_")) ?? null;
}

const LEGACY_VERDICTS = new Set(["steal", "good_deal", "fair", "overpriced", "price_trap"]);
function normalizeLegacy(v) {
  if (v == null) return null;
  const key = String(v).trim().toLowerCase();
  if (LEGACY_VERDICTS.has(key)) return key;
  // Loose normalization for common variants.
  if (key === "good")          return "good_deal";
  if (key === "high")          return "overpriced";
  if (key === "steal_deal")    return "steal";
  return null;
}

// Adjacent-tier tolerance: BUY adjacent to HOLD, HOLD adjacent to PASS.
// BUY and PASS are NEVER adjacent — that's a hard miss.
const ADJACENT = {
  BUY:  new Set(["BUY", "HOLD"]),
  HOLD: new Set(["BUY", "HOLD", "PASS"]),
  PASS: new Set(["HOLD", "PASS"]),
};

function verdictMatches(expected, actual, tolerance) {
  if (expected == null || actual == null) return false;
  if (tolerance === "exact") return expected === actual;
  return ADJACENT[expected]?.has(actual) ?? false;
}

// ── Response extraction ──────────────────────────────────────────────
function extractCanonicalVerdict(body) {
  const raw = body?.buyOrPass?.verdict ?? null;
  return { raw, canonical: normalizeCanonical(raw) };
}

function extractLegacyVerdict(body) {
  const raw = body?.dealComparator?.verdict?.verdict ?? null;
  return { raw, canonical: normalizeLegacy(raw) };
}

function extractMedianPrice(body) {
  const consensus = body?.consensus || null;
  const m = consensus?.median ?? consensus?.medianPrice ?? null;
  const n = Number(m);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractSampleSize(body) {
  const c = body?.consensus || null;
  const list =
    (typeof c?.listingCount === "number" && c.listingCount) ||
    (Array.isArray(body?.items) ? body.items.length : null) ||
    (Array.isArray(body?.market) ? body.market.length : null) ||
    null;
  return Number.isFinite(list) ? list : null;
}

// ── HTTP ─────────────────────────────────────────────────────────────
async function callMarketSearch({ server, apiKey, userId, bypass, query, scannedPrice, timeout }) {
  const url = `${server.replace(/\/$/, "")}/market/search`;
  const ctrl = new AbortController();
  const tmo  = setTimeout(() => ctrl.abort(), timeout);

  const body = {
    query,
    scannedPrice,
    scanMode: "item",
    // dev auth fallback — server reads req.body.userId when
    // AUTH_ALLOW_DEV_BODY_FALLBACK=true (development only)
    userId,
  };

  const headers = {
    "content-type": "application/json",
    "x-api-key":    apiKey,
    "x-user-id":    userId,
  };
  // Bench bypass — set BENCH_BYPASS_SECRET in dev .env to skip every
  // rate-limit / abuse / quota layer in one shot. Server refuses to honor
  // this in production regardless of value.
  if (bypass) headers["x-bench-bypass"] = bypass;

  const t0 = Date.now();
  let res, parsed = null, errMessage = null;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers,
      body:   JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(tmo);
    return {
      ok:      false,
      status:  0,
      ms:      Date.now() - t0,
      body:    null,
      error:   e?.name === "AbortError" ? `timeout after ${timeout}ms` : String(e?.message || e),
    };
  }
  clearTimeout(tmo);

  const ms     = Date.now() - t0;
  const status = res.status;

  try {
    parsed = await res.json();
  } catch (e) {
    errMessage = `non-JSON response: ${e?.message || e}`;
  }

  return {
    ok:      res.ok && parsed?.ok !== false,
    status,
    ms,
    body:    parsed,
    error:   errMessage || (parsed?.error ? String(parsed.error) : null),
  };
}

// ── Stats ────────────────────────────────────────────────────────────
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function summarize(results) {
  const ms = results.map(r => r.ms).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;
  const totalMs = ms.reduce((a, b) => a + b, 0);

  return {
    total:   results.length,
    passed,
    failed,
    totalMs,
    avgMs:   ms.length ? Math.round(totalMs / ms.length) : 0,
    p50Ms:   percentile(ms, 50),
    p95Ms:   percentile(ms, 95),
    maxMs:   ms.length ? ms[ms.length - 1] : 0,
  };
}

// ── Baseline comparison ──────────────────────────────────────────────
function compareToBaseline(current, baseline, regressPct) {
  const out = {
    drift:        [],   // verdict differs from baseline (silent regression)
    newCases:     [],   // present in current, absent in baseline
    droppedCases: [],   // present in baseline, absent in current
    p95RegressionPct: 0,
    p95Regression: false,
  };

  const baselineByName = new Map(
    (baseline?.cases || []).map(c => [c.name, c])
  );
  const currentByName = new Map(current.cases.map(c => [c.name, c]));

  for (const c of current.cases) {
    const b = baselineByName.get(c.name);
    if (!b) { out.newCases.push(c.name); continue; }
    if (c.gotCanonical !== b.gotCanonical || c.gotLegacy !== b.gotLegacy) {
      out.drift.push({
        name:         c.name,
        canonicalWas: b.gotCanonical,
        canonicalNow: c.gotCanonical,
        legacyWas:    b.gotLegacy,
        legacyNow:    c.gotLegacy,
      });
    }
  }
  for (const name of baselineByName.keys()) {
    if (!currentByName.has(name)) out.droppedCases.push(name);
  }

  const basP95 = Number(baseline?.summary?.p95Ms || 0);
  const curP95 = Number(current.summary.p95Ms || 0);
  if (basP95 > 0) {
    out.p95RegressionPct = +(((curP95 - basP95) / basP95) * 100).toFixed(1);
    out.p95Regression = out.p95RegressionPct > regressPct;
  }
  return out;
}

// ── Reporting ────────────────────────────────────────────────────────
function markdownTable(rows) {
  const header = ["Case", "Query", "Price", "Expected", "Got", "Legacy", "Pass", "ms"];
  const lines = [];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const r of rows) {
    const passCell = r.error ? `ERR(${r.status || "?"})` : (r.pass ? "PASS" : "FAIL");
    lines.push(`| ${[
      r.name,
      r.query,
      r.scannedPrice != null ? `$${r.scannedPrice}` : "",
      r.expectedCanonical,
      r.gotCanonical ?? "(none)",
      r.gotLegacy    ?? "(none)",
      passCell,
      r.ms,
    ].join(" | ")} |`);
  }
  return lines.join("\n");
}

function printHumanReport(current, diff, args) {
  const s = current.summary;
  process.stdout.write("\n");
  process.stdout.write(`Verdict regression bench  —  server: ${args.server}\n`);
  process.stdout.write(`Run at: ${current.runAt}\n`);
  process.stdout.write(`Bypass: ${args.bypass ? "yes (X-Bench-Bypass set)" : "no (set BENCH_BYPASS_SECRET to skip rate limits)"}\n`);
  process.stdout.write("\n");
  process.stdout.write(markdownTable(current.cases));
  process.stdout.write("\n\n");

  process.stdout.write(
    `Summary: ${s.passed}/${s.total} passed, ${s.failed} failed  |  ` +
    `total ${s.totalMs}ms  avg ${s.avgMs}ms  p50 ${s.p50Ms}ms  p95 ${s.p95Ms}ms  max ${s.maxMs}ms\n`
  );

  if (diff) {
    if (diff.newCases.length) {
      process.stdout.write(`New cases (not in baseline): ${diff.newCases.join(", ")}\n`);
    }
    if (diff.droppedCases.length) {
      process.stdout.write(`Cases missing vs baseline:    ${diff.droppedCases.join(", ")}\n`);
    }
    if (diff.drift.length) {
      process.stdout.write("\nVERDICT DRIFT vs baseline:\n");
      for (const d of diff.drift) {
        process.stdout.write(
          `  ! ${d.name}  canonical ${d.canonicalWas} -> ${d.canonicalNow}` +
          `  |  legacy ${d.legacyWas} -> ${d.legacyNow}\n`
        );
      }
    }
    if (Number.isFinite(diff.p95RegressionPct)) {
      const sign = diff.p95RegressionPct >= 0 ? "+" : "";
      const tag  = diff.p95Regression ? "  ! REGRESSION" : "";
      process.stdout.write(`p95 delta vs baseline: ${sign}${diff.p95RegressionPct}%${tag}\n`);
    }
  }
  process.stdout.write("\n");
}

// ── Main ─────────────────────────────────────────────────────────────
async function readJson(file) {
  const buf = await fs.readFile(file, "utf8");
  return JSON.parse(buf);
}

async function writeJson(file, obj) {
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  // 1. Load fixtures.
  let fixtures;
  try {
    fixtures = await readJson(args.cases);
  } catch (e) {
    process.stderr.write(`bench: failed to load cases at ${args.cases}: ${e.message}\n`);
    process.exit(2);
  }
  const cases = Array.isArray(fixtures?.cases) ? fixtures.cases : [];
  if (!cases.length) {
    process.stderr.write(`bench: no cases in ${args.cases}\n`);
    process.exit(2);
  }

  // 2. Reachability check.
  try {
    const ctrl = new AbortController();
    const tmo = setTimeout(() => ctrl.abort(), 5000);
    const h = await fetch(`${args.server.replace(/\/$/, "")}/health`, { signal: ctrl.signal });
    clearTimeout(tmo);
    if (!h.ok && h.status !== 200) {
      process.stderr.write(`bench: server /health returned ${h.status} at ${args.server}\n`);
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`bench: cannot reach ${args.server}/health (${e?.message || e}). Is the server running?\n`);
    process.exit(2);
  }

  // 3. Run cases sequentially (rate-friendly; SerpAPI etc. shouldn't be hammered).
  const results = [];
  for (const c of cases) {
    const tolerance = c.tolerance === "exact" ? "exact" : "loose";
    const expectedCanonical = normalizeCanonical(c.expectedCanonical);
    const expectedLegacy    = normalizeLegacy(c.expectedLegacy);

    const resp = await callMarketSearch({
      server:       args.server,
      apiKey:       args.apiKey,
      userId:       args.userId,
      bypass:       args.bypass,
      query:        c.query,
      scannedPrice: c.scannedPrice,
      timeout:      args.timeout,
    });

    const cv = extractCanonicalVerdict(resp.body);
    const lv = extractLegacyVerdict(resp.body);
    const median = extractMedianPrice(resp.body);
    const sample = extractSampleSize(resp.body);

    const canonicalOk = expectedCanonical
      ? verdictMatches(expectedCanonical, cv.canonical, tolerance)
      : false;
    const legacyOk = expectedLegacy
      ? (tolerance === "exact"
          ? lv.canonical === expectedLegacy
          // Loose legacy: allow same canonical-tier (e.g. steal↔good_deal both map to BUY)
          : normalizeCanonical(lv.canonical) === normalizeCanonical(expectedLegacy))
      : true; // no legacy expectation → don't fail the case
    const pass = resp.ok && canonicalOk && legacyOk;

    results.push({
      name:               c.name,
      query:              c.query,
      scannedPrice:       c.scannedPrice,
      category:           c.category || null,
      tolerance,
      expectedCanonical:  expectedCanonical || c.expectedCanonical || null,
      expectedLegacy:     expectedLegacy    || c.expectedLegacy    || null,
      gotCanonical:       cv.canonical,
      gotCanonicalRaw:    cv.raw,
      gotLegacy:          lv.canonical,
      gotLegacyRaw:       lv.raw,
      medianPrice:        median,
      sampleSize:         sample,
      ms:                 resp.ms,
      status:             resp.status,
      ok:                 resp.ok,
      error:              resp.error || null,
      pass,
    });
  }

  // 4. Build the run record.
  const summary = summarize(results);
  const current = {
    runAt:   new Date().toISOString(),
    server:  args.server,
    cases:   results,
    summary,
  };

  // 5. Save mode short-circuits diff and writes the baseline.
  if (args.save) {
    try {
      await writeJson(args.baseline, current);
    } catch (e) {
      process.stderr.write(`bench: failed to write baseline ${args.baseline}: ${e.message}\n`);
      process.exit(2);
    }
    process.stdout.write(`bench: wrote baseline -> ${args.baseline}\n`);
    if (args.json) process.stdout.write(JSON.stringify(current, null, 2) + "\n");
    else           printHumanReport(current, null, args);
    process.exit(0);
  }

  // 6. Compare against baseline (if present).
  let baseline = null;
  try {
    baseline = await readJson(args.baseline);
  } catch {
    baseline = null;
  }

  const diff = baseline
    ? compareToBaseline(current, baseline, args.regressPct)
    : null;

  if (args.json) {
    process.stdout.write(JSON.stringify({ current, baseline: baseline ? { runAt: baseline.runAt, summary: baseline.summary } : null, diff }, null, 2) + "\n");
  } else {
    printHumanReport(current, diff, args);
    if (!baseline) {
      process.stdout.write("No baseline present. Run `npm run bench:save` to lock the current run.\n\n");
    }
  }

  // 7. Determine exit code.
  let exitCode = 0;
  if (summary.failed > 0) exitCode = 1;
  if (diff && (diff.drift.length > 0 || diff.p95Regression)) exitCode = 1;
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`bench: fatal: ${e?.stack || e?.message || e}\n`);
  process.exit(2);
});
