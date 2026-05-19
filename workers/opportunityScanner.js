// workers/opportunityScanner.js
// Continuous Opportunity Scanner — finds deals WITHOUT user input.
//
// Runs on a schedule per active user, querying markets for:
//   1. Fresh listings (<6h old) priced below market median — sellers don't know value
//   2. Miscategorized items — specific brand/model listed in generic category
//   3. Cross-platform arbitrage — same item cheaper on one platform vs another
//   4. Auction ending soon with current bid below market
//   5. Items matching user's price sweet spot + winning category pattern
//
// Feeds into: discoveryEngine snapshot → daily feed → urgency triggers
//
// Queue name: "opportunity-scan"
// Job types:
//   "scan-user"       — full scan cycle for one user (enqueued nightly per active user)
//   "scan-query"      — single query scan (enqueued by scan-user, runs in parallel)

import { Worker, Queue } from "bullmq";
import {
  buildDiscoveryQueryUniverse,
  buildDiscoveryOpportunity,
  storeDiscoverySnapshot,
  getSeenFingerprints,
} from "../src/discoveryEngine.js";
import { addUrgencyTrigger, updateCategoryHeat } from "../src/addictionEngine.js";
import { buildArbitrageSummary } from "../src/arbitrageEngine.js";
import { analyzeVelocityForItem, recordPriceDropEvent } from "../src/dealVelocityEngine.js";
import { getWatchlistPriceHistory, recordWatchlistPriceObservation } from "../src/watchlistIntelligence.js";

const QUEUE_NAME  = "opportunity-scan";
const CONCURRENCY = 8;

// Minimum spread below median to qualify as a "fresh underpriced" listing
const FRESH_UNDERPRICED_THRESHOLD = 0.15;  // 15% below median
const FRESH_LISTING_MAX_AGE_H     = 6;      // listed within 6 hours

let _queue = null;

export function getOpportunityScanQueue(redisConnection) {
  if (!_queue) _queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  return _queue;
}

/**
 * Enqueue a full user scan cycle.
 * Called nightly per active user from the cron.
 */
export async function enqueueUserScanCycle(redisConnection, userId, opts = {}) {
  const q = getOpportunityScanQueue(redisConnection);
  await q.add("scan-user", { userId, ...opts }, {
    jobId:    `scan-user-${userId}-${new Date().toISOString().slice(0, 10)}`,
    attempts: 2,
    removeOnComplete: { count: 10 },
    removeOnFail:     { count: 5 },
  });
}

// ── Main worker ───────────────────────────────────────────────────────────────

export function startOpportunityScanWorker({
  redisConnection,
  redis,
  assembleProfitIntel,
  fetchMarketItems,      // async (query, opts?) → items[]
  getUserContext,        // async (userId) → { watchlistItems, portfolioItems, categoryStats, categoryAffinities, savedScans }
}) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === "scan-user") {
        await runUserScanCycle({ job, redis, assembleProfitIntel, fetchMarketItems, getUserContext });
      } else if (job.name === "scan-query") {
        await runSingleQueryScan({ job, redis, assembleProfitIntel, fetchMarketItems });
      }
    },
    { connection: redisConnection, concurrency: CONCURRENCY },
  );

  worker.on("completed", (job) => {
    if (job.data?.userId) console.log(`[OpportunityScanner] ✓ ${job.name} userId=${job.data.userId}`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[OpportunityScanner] ✗ ${job?.id}: ${err.message}`);
  });

  return worker;
}

// ── User scan cycle ───────────────────────────────────────────────────────────

async function runUserScanCycle({ job, redis, assembleProfitIntel, fetchMarketItems, getUserContext }) {
  const { userId } = job.data;
  if (!userId) return;

  // Load user context
  const ctx = await getUserContext(userId).catch(() => null);
  if (!ctx) return;

  // Build query universe from user's interests
  const queryUniverse = buildDiscoveryQueryUniverse({
    watchlistItems:    ctx.watchlistItems    || [],
    portfolioItems:    ctx.portfolioItems    || [],
    categoryStats:     ctx.categoryStats     || [],
    categoryAffinities: ctx.categoryAffinities || [],
    savedScans:        ctx.savedScans        || [],
    maxQueries:        20,
  });

  if (!queryUniverse.length) return;

  const seenFps  = await getSeenFingerprints(redis, userId);
  const opportunities = [];
  const categoryHeatMap = new Map();

  // Process queries in parallel batches of 4
  for (let i = 0; i < queryUniverse.length; i += 4) {
    const batch = queryUniverse.slice(i, i + 4);
    const results = await Promise.allSettled(
      batch.map((queryItem) => processSingleQuery({
        queryItem, userId, seenFps, assembleProfitIntel, fetchMarketItems, redis,
      })),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const { opp, heat } = result.value;
        if (opp) opportunities.push(opp);
        if (heat) {
          const cat = heat.category;
          const existing = categoryHeatMap.get(cat) || { score: 0, count: 0 };
          categoryHeatMap.set(cat, {
            category:    cat,
            score:       Math.max(existing.score, heat.score),
            newListings: (existing.newListings || 0) + (heat.newListings || 0),
          });
        }
      }
    }
  }

  // Store discovery snapshot
  if (opportunities.length > 0) {
    await storeDiscoverySnapshot(redis, userId, opportunities);
  }

  // Update category heat for all categories scanned
  for (const [, heat] of categoryHeatMap) {
    await updateCategoryHeat(redis, heat.category, {
      newListingsPerHour: heat.newListings || 0,
      demandScore:        60, // default — would be enriched by real demand data
      topOpportunityScore: opportunities
        .filter((o) => o.category === heat.category)
        .reduce((max, o) => Math.max(max, o.opportunityScore || 0), 0),
    }).catch(() => {});
  }

  // Add urgency triggers for top opportunities
  const topOpps = opportunities
    .filter((o) => o.opportunityScore >= 70)
    .slice(0, 3);

  for (const opp of topOpps) {
    await addUrgencyTrigger(redis, userId, {
      type:         "DEMAND_SPIKE",
      title:        buildUrgencyTitle(opp),
      body:         opp.reasoning || null,
      urgencyScore: Math.min(95, opp.opportunityScore + 10),
      actionData:   { query: opp.query, category: opp.category },
      ttlMs:        24 * 3600 * 1000,
    }).catch(() => {});
  }
}

// ── Single query processor ────────────────────────────────────────────────────

async function processSingleQuery({
  queryItem, userId, seenFps, assembleProfitIntel, fetchMarketItems, redis,
}) {
  const { query, category, brand, model, fp, source } = queryItem;

  // Fetch live listings
  const items = await fetchMarketItems(query, { limit: 40 }).catch(() => []);
  if (!items?.length) return null;

  // Detect fresh underpriced listings (the most valuable signal)
  const freshUnderpriced = detectFreshUnderpricedListings(items);

  // Build profit intel
  const profitIntel = assembleProfitIntel({
    items,
    scannedPrice:       null,
    visionConfidence:   0.60,
    confidenceV2:       0.60,
    resultConsensus:    null,
    refinementWarnings: [],
    prediction:         null,
    category:           category || null,
    crossCheck:         null,
    isOracleOnly:       false,
    liquidityScoreVal:  0,
  });

  if (!profitIntel) return null;

  // Skip if fingerprint already seen
  const itemFp = fp || buildFpFromParts(brand, model, category);
  if (seenFps.has(itemFp)) return null;

  const opp = buildDiscoveryOpportunity({
    query,
    source:    source || "scanner",
    category:  category || "",
    brand:     brand  || "",
    model:     model  || "",
    fp:        itemFp,
    items,
    profitIntel,
    isWatched: false,
    isOwned:   false,
  });

  // Boost opportunity score if fresh underpriced listings found
  if (opp && freshUnderpriced.length > 0) {
    opp.opportunityScore = Math.min(100, opp.opportunityScore + 15);
    opp.freshListingCount = freshUnderpriced.length;
    opp.bestFreshListing  = freshUnderpriced[0];
    // Escalate signal if fresh listing is deeply underpriced
    if (freshUnderpriced[0]?.discountPct >= 25 && opp.buySignal === "GOOD DEAL") {
      opp.scannerEscalation = "Fresh listing significantly underpriced — may be STRONG BUY";
    }
  }

  // ── Phase 8: Arbitrage detection ────────────────────────────────────────────
  // Only attempt if identity is known (brand + model must be present)
  if (opp && (brand || queryItem.brand) && (model || queryItem.model)) {
    const identity = { brand: brand || queryItem.brand, model: model || queryItem.model, category: category || queryItem.category };
    const arbSummary = buildArbitrageSummary(items, identity, {
      identityConf: 0.75, // scanner uses category-derived queries — moderate confidence
      condition:    "",
    });
    if (arbSummary) {
      opp.arbitrage = arbSummary;
      opp.opportunityScore = Math.min(100, opp.opportunityScore + 10);
    }
  }

  // ── Phase 8: Deal velocity detection ────────────────────────────────────────
  if (opp && fp) {
    try {
      // Record price observations for the cheapest item found
      const cheapestItem = items.reduce((best, it) => {
        const p = extractPrice(it); const bp = extractPrice(best);
        return (p !== null && (bp === null || p < bp)) ? it : best;
      }, items[0]);
      const cheapestPrice = cheapestItem ? extractPrice(cheapestItem) : null;

      if (cheapestPrice) {
        const priceHistory = await getWatchlistPriceHistory(redis, fp);
        if (priceHistory.length > 0) {
          const prevPrice = priceHistory[0]?.price;
          if (prevPrice && cheapestPrice < prevPrice) {
            await recordPriceDropEvent(redis, fp, prevPrice, cheapestPrice,
              cheapestItem?.source || cheapestItem?.marketplace || "scanner").catch(() => {});
          }
        }
        await recordWatchlistPriceObservation(redis, fp, cheapestPrice, "scanner").catch(() => {});

        if (opp.buySignal && profitIntel?.priceStats?.median) {
          const velocityAlert = await analyzeVelocityForItem(redis, userId, {
            fingerprint:  fp,
            items,
            priceHistory,
            buySignal:    opp.buySignal,
            marketMedian: profitIntel.priceStats.median,
          }).catch(() => null);
          if (velocityAlert) {
            opp.velocityAlert = velocityAlert;
            // Boost score for rapid drops with confirmed deal signal
            if (velocityAlert.priority === "HIGH") {
              opp.opportunityScore = Math.min(100, opp.opportunityScore + 12);
            }
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Category heat signal
  const newListingsInLastHour = items.filter((it) => isRecentListing(it, 1)).length;
  const heat = {
    category:    category || "unknown",
    score:       Math.min(100, newListingsInLastHour * 10 + (opp?.opportunityScore || 0) * 0.3),
    newListings: newListingsInLastHour,
  };

  return { opp, heat };
}

async function runSingleQueryScan({ job, redis, assembleProfitIntel, fetchMarketItems }) {
  const { userId, query, category, brand, model, fp, source } = job.data;
  if (!userId || !query) return;

  // Simplified single-query execution — used for on-demand triggers
  const items = await fetchMarketItems(query, { limit: 20 }).catch(() => []);
  if (!items?.length) return;

  const profitIntel = assembleProfitIntel({
    items, scannedPrice: null, visionConfidence: 0.60, confidenceV2: 0.60,
    resultConsensus: null, refinementWarnings: [], prediction: null,
    category: category || null, crossCheck: null, isOracleOnly: false, liquidityScoreVal: 0,
  });

  if (!profitIntel?.buySignal || ["INSUFFICIENT DATA", "RISKY"].includes(profitIntel.buySignal)) return;

  const opp = buildDiscoveryOpportunity({
    query, source: source || "on_demand", category: category || "",
    brand: brand || "", model: model || "", fp: fp || null,
    items, profitIntel, isWatched: false, isOwned: false,
  });

  if (!opp) return;

  // Store as urgency trigger if strong signal
  if (opp.opportunityScore >= 65) {
    await addUrgencyTrigger(redis, userId, {
      type:         "DEMAND_SPIKE",
      title:        buildUrgencyTitle(opp),
      body:         opp.reasoning || null,
      urgencyScore: opp.opportunityScore,
      actionData:   { query, category },
      ttlMs:        12 * 3600 * 1000,
    }).catch(() => {});
  }
}

// ── Fresh listing detection ───────────────────────────────────────────────────

/**
 * Find listings that are:
 * - Recently listed (< 6h based on listing metadata)
 * - Priced meaningfully below the median of all listings
 */
function detectFreshUnderpricedListings(items = []) {
  if (items.length < 5) return [];

  const prices = items
    .map((it) => extractPrice(it))
    .filter((p) => p !== null)
    .sort((a, b) => a - b);

  const median = prices[Math.floor(prices.length / 2)];
  if (!median || median <= 0) return [];

  return items
    .filter((it) => {
      const price = extractPrice(it);
      if (!price) return false;
      const discountPct = ((median - price) / median);
      const isFresh     = isRecentListing(it, FRESH_LISTING_MAX_AGE_H);
      return discountPct >= FRESH_UNDERPRICED_THRESHOLD && isFresh;
    })
    .map((it) => ({
      title:       String(it.title || "").slice(0, 120),
      price:       extractPrice(it),
      discountPct: Math.round(((median - extractPrice(it)) / median) * 100),
      url:         it.url || it.link || null,
      source:      it.source || it.marketplace || "",
      listedAt:    it.listedAt || it.listingDate || null,
    }))
    .sort((a, b) => b.discountPct - a.discountPct)
    .slice(0, 3);
}

function isRecentListing(item, maxAgeHours = 6) {
  const listedAt = item?.listedAt || item?.listingDate || item?.date;
  if (!listedAt) return false; // can't determine age
  const ts  = typeof listedAt === "number" ? listedAt : Date.parse(listedAt);
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) <= maxAgeHours * 3600 * 1000;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUrgencyTitle(opp) {
  const parts = [opp.brand, opp.model].filter(Boolean).join(" ") || opp.query || "New opportunity";
  const signal = opp.buySignal === "STRONG BUY" ? "STRONG BUY" : "GOOD DEAL";
  const score  = opp.opportunityScore;
  return `${signal}: ${parts} (score ${score})`;
}

function buildFpFromParts(brand = "", model = "", category = "") {
  return [brand, model, category]
    .map((s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "_"))
    .filter(Boolean)
    .join(":") || "unknown";
}

function extractPrice(item) {
  const p = item?.price ?? item?.totalPrice ?? item?.currentPrice ?? item?.extractedPrice;
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? n : null;
}
