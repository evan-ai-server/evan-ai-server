# Evan AI — Server

A camera-scan buy-or-pass tool for resellers. Point your phone at an item,
get a verdict in ~2 seconds: estimated resale price, demand level, profit
margin after fees, and a clean `BUY` / `HOLD` / `PASS` call.

This repo is the Node.js / Express backend. The React Native client lives
in a separate repo.

```
Founder:    Evan Byon (16, solo)
Started:    December 2025
Status:     Private beta. Pre-revenue. Closed-loop pipeline operational.
Stack:      Node.js · Express · OpenAI · Redis · Sharp · Playwright
```

## What's inside

**Vision pipeline (`runVisionConsensus`)** — three OpenAI passes in parallel
(gpt-4.1 master, gpt-4.1-mini fast, visual_shape consensus). The master
pass is cancelled mid-flight via `AbortController` when the visual pass
clears a confidence threshold, saving ~$0.015/scan and ~3s of wall time
without losing accuracy. Per-pass cost telemetry, tier classification, and
rolling-percentile observability are all live.

**Verdict engine (`src/buyOrPassEngine.js`, `src/dealComparator.js`)** —
six weighted signals (price, flip-score, demand, risk, authenticity,
condition) collapse into a three-state verdict. Evidence-gated: refuses to
return a confident call when comp count is zero. Condition-aware bracket
math — a "Used – Acceptable" scan stops competing against a basket of "New
Sealed" comps via tier bucketing with adjacent-tier fallback.

**Outcome learning (`src/outcomeLearning.js`)** — Redis-backed per-user
per-category track record. `computeBracketAdjustmentFromPrior` translates
win/loss history into a signed bracket-median shift (-15% to +15%, sample-
dampened) so the verdict gets stricter for categories the user loses on
and looser for ones they win on. Activates the moment users feed outcomes.

**Marketplace fan-out (`fetchEbayListings`, `fetchEbaySoldComps`, …)** —
parallel queries to eBay Browse, eBay marketplace_insights (sold prices,
scope-gated), Walmart, BestBuy, Etsy public, with GPT Market Oracle as a
fallback when sources are rate-limited. Per-source health tracking +
cooldowns so a single failing source doesn't take down the lane.

**Bench + smoke harness (`bench/`)** — 12 locked verdict fixtures, p95
regression guard, drift detection. Synthetic-image smoke test asserts
10 instrumentation checkpoints end-to-end. CI gate before any verdict-
touching change ships.

## Scale

```
Source lines (JS, ex-node_modules):  117,949
Main file (index.js):                 34,913
Files in src/:                            220
Commits:                                   68
Days from first commit to now:            123
```

Built solo while in high school and on the cross-country / track teams.

## Status

Pre-launch. Internal scans working end-to-end. eBay developer account is
mid-approval (Browse API). Etsy declined (category decision). Looking for
~20 active resellers for a private beta — scans + outcome feedback. Reach
out via the contact email in my GitHub profile.

## Why this is hard

The bar for a useful reseller verdict isn't "find a similar item." It's
"compare the right scan against the right basket of comps, weight the
trustworthy sources higher, account for condition, account for the user's
own track record, and do it before the user moves on." Every layer in
this repo exists because a naive version of that got something wrong on
a real scan.
