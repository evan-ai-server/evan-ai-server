# Evan AI — End-to-End Signal Flow

## Scan → Decision → Outcome Tracking

---

### 1. SCAN INPUT (client → POST /vision/analyze)

```
Body: {
  imageBase64: string,       // base64 photo from camera
  scannedPrice: number|null, // price user entered
  cheapestAltPrice: number|null,
  userId: string|null,
  category: string|null,     // optional override
}
```

### 2. VISION PIPELINE (3-pass GPT-4o consensus)

```
Pass 1: ItemIdentificationAgent → { brand, model, category, condition, colors, visibleText }
Pass 2: RefinementAgent         → confirm/deny brand+model, add specificQuery
Pass 3: ConsensusAgent          → merge passes, output visionIdentity + attributeCertainty

→ identityQuality (0–1) = computeIdentityQuality(visionIdentity, attributeCertainty)
   Weighted: brand(30%) + model(20%) + category(15%) + visibleText(15%) + attrRichness(10%) + exactQuery(5%)
   Penalties: -0.06 if brand claimed with no visible text; -0.08 if both brand+model low certainty
```

### 3. MARKET QUERY (eBay + Facebook + SERP)

```
→ buildQuery(visionIdentity) → activeQuery
→ searchEbay(activeQuery) + searchFacebook(activeQuery) → raw items
→ mergeCheapestSources(items) → uiItems (sorted, deduped)
→ buildPriceStats(uiItems) → { median, p10, p25, p75, p90, count, variance, priceQualityScore }
```

### 4. MARKET DEPTH GATE (src/marketDepthGate.js)

```
classifyMarketDepth(priceStats.count):
  < 5  → INSUFFICIENT   → forces "INSUFFICIENT DATA" signal, no further scoring
  5–14 → THIN           → caps signal at "GOOD DEAL"
  15–19 → DEVELOPING    → caps "STRONG BUY" if liquidityScore < 55
  20+  → ADEQUATE/DEEP  → no cap

applyMarketDepthGate({ signal, compsCount, liquidityScore }) → { signal, capped, capReason }
```

### 5. LIQUIDITY SCORE (src/liquidityEngine.js)

```
computeLiquidityScore({ category, marketItems, visionCondition, priceMedian, graphData })
→ base (by category) + conditionMod + priceMod + listingCountMod + velocityMod
→ { liquidityScore: 0–100, tier: hot/liquid/moderate/slow/illiquid }

Depth gate uses this:
  liquidityScore < 20 → max signal = FAIR
  liquidityScore < 40 → max signal = GOOD DEAL
  liquidityScore >= 40 → normal depth gate applies
```

### 6. TRUST SCORE (index.js: computeTrustScore)

```
trustScore = identityQuality(30%) + confidenceV2(25%) + priceQualityScore(25%) + min(count/8,1)(20%)
Penalties: -0.25 isOracleOnly, -0.20 hasConflict, -0.10 identityQuality<0.25

trustScore < 0.30 → RISKY (catastrophic)
trustScore < 0.45 → FAIR (cap — no positive verdict)
trustScore >= 0.55 → STRONG BUY eligible
```

### 7. BUY SIGNAL PRODUCTION (index.js: buildBuySignal → assembleProfitIntel)

```
Hard override gates (in order):
  1. trustScore < 0.30            → RISKY
  2. count < 3 || !median         → INSUFFICIENT DATA
  3. confidenceV2 < 0.40          → RISKY
  4. identityQuality < 0.25       → RISKY
  5. hasConflict                  → RISKY
  6. isOracleOnly                 → RISKY
  7. priceVariance/median > 0.60  → RISKY
  8. trustScore < 0.45            → FAIR (cap)
  [depth gate after buildBuySignal, before outcome bias]

STRONG BUY gate (ALL must pass):
  confidenceV2 >= 0.60
  count >= 4 (plus depth gate: count >= 20 for STRONG BUY after gate)
  dealStrength >= 0.25
  priceQualityScore >= 0.50
  resaleScore >= 70
  demandScore >= 50
  identityQuality >= 0.45
  trustScore >= 0.55
  liquidityScore >= 40 (via depth gate)
```

### 8. OUTCOME BIAS ADJUSTMENT (src/outcomeLearning.js)

```
applyOutcomeBiasesToDecision({ buySignal, category, categoryPrior, userHitRate })
  If user has >3 outcomes in category and losses > wins → downgrade GOOD DEAL to FAIR
  If user has >5 outcomes, wins/total >= 0.70, userHitRate >= 72 → upgrade FAIR to GOOD DEAL
  Global hitRate < 30% → cap GOOD DEAL to FAIR
```

### 9. NET PROFIT CALCULATION (src/profitCalculatorEngine.js)

```
computePlatformProfit({ buyPrice, sellPrice, platform, category })
→ sellingFee = sell * platform.selling
→ paymentFee = sell * platform.payment + platform.fixed
→ shipCost   = SHIPPING_ESTIMATES[category].standard
→ grossProfit = sell - buy - totalFees - netShipping
→ netProfit   = grossProfit (- tax if includeTax)
→ roi         = netProfit / buy * 100

comparePlatformProfits({ buyPrice, sellPrice, platforms }) → best platform recommendation
```

### 10. FINAL OUTPUT (assembleProfitIntel return)

```json
{
  "buySignal": "STRONG BUY",
  "signalRaw": "STRONG BUY",          // before depth/bias caps (if capped, differs)
  "signalCapped": false,
  "depthTier": "ADEQUATE",
  "depthCount": 34,
  "trustScore": 0.78,
  "identityQuality": 0.72,
  "confidenceV2": 0.81,
  "dealStrength": 0.31,
  "demandScore": 67,
  "resaleScore": 74,
  "priceStats": { "median": 145.00, "p10": 89.00, "p90": 210.00, "count": 34 },
  "agentAction": "BUY_NOW",
  "agentUrgency": "SOON",
  "timingSignal": "BUY_NOW",
  "reasoning": "Typical range: $89.00–$210.00. Best listing at $98.00 — 32% below median $145.00.",
  "warnings": []
}
```

---

### 11. OUTCOME TRACKING (client → POST /scan/buy-outcome)

```
After user buys/sells:
Body: {
  userId, scanId, didBuy, buyPrice, didSell, sellPrice, category,
  buySignal, dealStrength, priceStats, brand, model
}

→ recordBuyOutcome(redis, scanId, { didBuy, buyPrice, ... })      [scan-level record]
→ recordOutcomeLearning(redis, userId, { category, didBuy, ... }) [category priors]
→ recordSignalOutcome(redis, userId, { signal, isWin, ... })      [accuracy engine]
→ if !didBuy && buySignal: detectMissedOpportunity() → storeMissedOpportunity()
```

### 12. ACCURACY CALIBRATION (workers/accuracyCalibrationWorker.js)

```
Nightly job: enqueueGlobalCalibrationSweep()
  → computeAccuracyProfile(redis, userId) for each active user
  → Apply bias correction: estimatedHiddenLosses = (scans - reported) * 0.65
  → biasedWinRate = wins / (wins + losses + estimatedHiddenLosses) * 100
  → Write accuracy_snapshots to Postgres
  → Write signal_calibration_global to Postgres

Alert if STRONG BUY corrected win rate < 70% (model drift indicator)
```

### 13. WATCHLIST PRICE MONITORING (workers/scanReplayWorker.js)

```
Triggered by: /watch/refresh/enqueue
  → enqueueScanReplay() per active watchlist item
  → Re-query market for current price
  → Compare currentPrice vs targetPrice/addedPrice
  → If targetHit or drop >= 10%: write alert to watchlist_alerts:{userId} ZSET
  → Alert surfaced in next daily feed build (dailyFeed.js ALERT section)
```

---

## File/Module Map

```
evan-ai-server/
├── index.js                        Main server (23k lines) — all routes, vision pipeline
├── src/
│   ├── accuracyEngine.js           NEW: bias-corrected accuracy tracking
│   ├── marketDepthGate.js          NEW: signal cap by comps count + liquidity
│   ├── liquidityEngine.js          Resale liquidity score 0–100
│   ├── marketDepthAnalyzer.js      Price walls, bid-ask spread, supply/demand
│   ├── profitCalculatorEngine.js   Net profit after platform fees + shipping
│   ├── outcomeLearning.js          Category-level outcome priors + affinity
│   ├── missedOpportunities.js      Missed deal detection + storage
│   ├── personalAgent.js            Decision engine (BUY_NOW/NEGOTIATE/SKIP...)
│   ├── timingIntel.js              Timing signal prediction
│   ├── discoveryEngine.js          Proactive deal discovery
│   ├── dailyFeed.js                Daily opportunity feed builder
│   └── [70+ other engines]         Condition, authenticity, resale, flip, etc.
├── workers/
│   ├── accuracyCalibrationWorker.js  Nightly bias-correction sweep
│   └── scanReplayWorker.js           Price drift detection + watchlist alerts
├── db/
│   └── schema.sql                  Postgres tables: outcomes, accuracy, portfolio, watchlist
└── docs/
    └── e2e-flow.md                 This file
```

## New API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/accuracy/score/:userId` | Bias-corrected accuracy profile |
| POST | `/api/accuracy/record-scan` | Record signal shown to user |
| POST | `/api/accuracy/record-outcome` | Record buy/sell outcome |
| GET | `/api/accuracy/global` | Cross-user calibration (ops) |
| GET | `/api/market-depth` | Depth context for a query |

## Existing Outcome Routes (unchanged)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/scan/buy-outcome` | Record full buy+sell outcome |
| GET | `/scan/buy-outcome/:scanId` | Retrieve scan outcome |
| POST | `/scan/pass` | Record deliberate pass |
| GET | `/user/category-stats` | Per-category scan/buy/sell counts |
| GET | `/api/pl/flips/:userId` | P&L ledger |
