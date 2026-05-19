# Verdict regression bench

A thin, framework-free harness that hits the live `/market/search`
endpoint with a locked fixture set, asserts the verdict each case
produces, and fails loudly if a later change silently moves a verdict
or regresses p95 wall-time.

This is the gate that protects the verdict surface — `buyOrPass.verdict`
and `dealComparator.verdict.verdict`. If a refactor breaks scoring, the
bench notices before the change ships.

## Quick start

```bash
# 1. Server must already be running (separate shell):
npm start

# 2. Run the bench (compares against committed baseline):
npm run bench

# 3. After an intentional verdict change, re-lock the baseline:
npm run bench:save
```

Exit code is `0` if all assertions pass and nothing has drifted vs
baseline, `1` if a verdict differs or p95 regresses by >25%, `2` if
the runner can't reach the server / read the fixtures.

## Bypass header

Firing 12 scans in 2 seconds trips every rate-limit, abuse-tracker, and
per-min quota layer the server has. The bench skips all of them with a
single header.

```bash
# .env (auto-loaded by both server and runner):
BENCH_BYPASS_SECRET=<long random string, >=16 chars>
```

The runner sends `X-Bench-Bypass: <secret>` on every request. The server
honors it only when:

1. `NODE_ENV !== "production"`, AND
2. `BENCH_BYPASS_SECRET` is set and ≥16 chars, AND
3. The inbound header matches via constant-time compare.

In production the header is silently ignored regardless of value — set
`NODE_ENV=production` and the bypass cannot be enabled.

Header-bypassed layers: `globalApiLimiter`, `writeApiLimiter`,
`visionLimiter`, `abuseTrackerMiddleware`, `phase1abuseGuard`,
`phase5EdgeAbuseGuard`, and the in-route per-min scan rate limit.

The banner line `Bypass: yes (X-Bench-Bypass set)` confirms the bench is
sending it. If you see `Bypass: no` followed by p95 ballooning, your
`.env` is missing `BENCH_BYPASS_SECRET`.

Generate one fresh:

```bash
openssl rand -hex 24 | xargs -I {} echo "BENCH_BYPASS_SECRET={}" >> .env
```

## Files

- `cases.json` — ~12 hand-tuned fixture cases across categories
  (watches, footwear, apparel, electronics, kitchen). Each case carries
  `query`, `scannedPrice`, `expectedCanonical`, `expectedLegacy`, and a
  `tolerance` (`"exact"` or `"loose"`).
- `run.js` — the runner (ESM, plain Node `fetch`, no test framework).
- `baseline.json` — committed snapshot of the last "good" run. Used as
  the reference for drift detection. Re-generate with `npm run bench:save`.

## What it asserts per case

For each case, the runner POSTs to `/market/search` with
`{ query, scannedPrice, scanMode: "item", userId }` and extracts:

| Field on response                       | What it represents             |
|-----------------------------------------|--------------------------------|
| `buyOrPass.verdict`                     | canonical: `BUY`/`HOLD`/`PASS` |
| `dealComparator.verdict.verdict`        | legacy: `steal`/`good_deal`/`fair`/`overpriced`/`price_trap` |
| `consensus.median` (or `medianPrice`)   | median market price            |
| `consensus.listingCount`                | comp count (sample size)       |

It then checks `expectedCanonical` against `buyOrPass.verdict` using
the `tolerance` setting and `expectedLegacy` against
`dealComparator.verdict.verdict`. Wall-time is captured per case
(`Date.now()` before/after the `fetch`).

### A note on verdict names

The task spec uses the names `STEAL_DEAL`, `BUY_NOW`, `FAIR`, `HOLD`,
`SKIP`. The server's actual canonical contract (see `shared/verdict.js`)
is `BUY`, `HOLD`, `PASS`. The runner accepts both forms via an alias
map (`STEAL_DEAL` → `BUY`, `SKIP` → `PASS`, `FAIR` → `HOLD`, etc.) and
normalizes everything to the contract names before comparison. The
fixtures in `cases.json` are written in the canonical alphabet for
clarity.

The legacy `dealComparator` surface keeps its five-tier vocabulary
(`steal`/`good_deal`/`fair`/`overpriced`/`price_trap`); fixtures can
opt out of legacy assertion by omitting `expectedLegacy`.

### Tolerance

- `"exact"` — the canonical verdict must match exactly.
- `"loose"` — adjacent tiers are allowed (`BUY↔HOLD` or `HOLD↔PASS`).
  Never `BUY↔PASS` — a steal becoming a skip is always a hard failure.

For legacy verdicts, loose mode allows any legacy value that maps to
the same canonical tier (so `steal` and `good_deal` are interchangeable
under loose, both being `BUY`).

## Baseline comparison

When `baseline.json` exists and `--save` is NOT passed, the runner:

1. Reports any case whose `gotCanonical` or `gotLegacy` differs from
   the baseline — **drift**, exit 1.
2. Reports any case present in the baseline but missing from the
   current run, or new cases not yet in the baseline (informational).
3. Computes `(currentP95 - baselineP95) / baselineP95 * 100` and fails
   if it exceeds 25% (override with `--regress-pct=N`).

## CLI flags

```
--save                 write current run to baseline.json
--json                 print machine-readable JSON instead of markdown
--server=URL           default: http://localhost:3001
--cases=PATH           default: bench/cases.json
--baseline=PATH        default: bench/baseline.json
--api-key=KEY          default: $API_KEY env (then "evan-test-local")
--user-id=ID           default: "bench-runner" (used by dev auth fallback)
--timeout=MS           per-request timeout (default: 180000)
--regress-pct=N        p95 regression threshold % (default: 25)
```

## Auth in dev

The server's `/market/*` routes accept either:

- a valid bearer JWT (production path), OR
- the configured `x-api-key` header (matches `API_KEY` env), OR
- `userId` in the body when `AUTH_ALLOW_DEV_BODY_FALLBACK=true` (dev only).

The bench sends both `x-api-key` and `userId` so it works under either
path. In a production-shaped env you'd need a real JWT (out of scope
for the dev bench).

## Output

```
| Case | Query | Price | Expected | Got | Legacy | Pass | ms |
|---|---|---|---|---|---|---|---|
| rolex_submariner_steal | rolex submariner 16610 | $5500 | BUY | BUY | steal | PASS | 4231 |
| airpods_pro_2_fair | airpods pro 2nd gen | $199 | HOLD | HOLD | fair | PASS | 1893 |
...
Summary: 12/12 passed, 0 failed  |  total 38420ms  avg 3201ms  p50 2870ms  p95 5102ms  max 6010ms
p95 delta vs baseline: +3.1%
```

## Adding a fixture

1. Append a case to `cases.json` with a unique `name`.
2. Choose realistic `scannedPrice` and an `expectedCanonical` informed
   by what the current bench actually returns (run once without
   `--save` first to see).
3. Use `tolerance: "loose"` unless you're sure the verdict is stable.
4. Run `npm run bench:save` to lock the new state into the baseline.
