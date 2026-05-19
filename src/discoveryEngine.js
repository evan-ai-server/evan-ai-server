// src/discoveryEngine.js
// Deal Discovery Engine — proactive opportunity scanning across user interest graph.
// Builds query universes from user history, ranks opportunities, stores snapshots.
// Feeds: /feed/discovery, /feed/daily, background discovery_refresh job.

// ── Redis key schema ──────────────────────────────────────────────────────────
// discovery:snapshot:{userId}           STRING  — latest discovery snapshot JSON
// discovery:queue:{userId}              ZSET    — queued query fingerprints scored by priority
// discovery:hit:{userId}:{fp}           STRING  — cached opportunity for fingerprint fp
// discovery:seen:{userId}               SET     — fingerprints already surfaced to user

const SNAPSHOT_TTL      = 6  * 3600;   // 6 hours
const OPPORTUNITY_TTL   = 24 * 3600;   // 24 hours
const SEEN_TTL          = 30 * 86400;  // 30 days — dedup window
const MAX_SEEN          = 2000;
const MAX_QUEUE         = 100;

const KEY_SNAPSHOT = (uid) => `discovery:snapshot:${uid}`;
const KEY_QUEUE    = (uid) => `discovery:queue:${uid}`;
const KEY_HIT      = (uid, fp) => `discovery:hit:${uid}:${fp}`;
const KEY_SEEN     = (uid)     => `discovery:seen:${uid}`;

// ── Query Universe ────────────────────────────────────────────────────────────

/**
 * Build the set of search queries to run for a user's discovery session.
 * Sources: watchlist fingerprints, portfolio categories, scan history categories,
 * and category affinity from outcomeLearning.
 */
export function buildDiscoveryQueryUniverse({
  watchlistItems    = [],
  portfolioItems    = [],
  categoryStats     = [],
  categoryAffinities = [],
  savedScans        = [],
  maxQueries        = 30,
}) {
  const queries = new Map(); // query → { score, source, category, fp }

  // Source 1: Watchlist items — highest priority (user explicitly watching)
  for (const item of watchlistItems) {
    if (!item?.fingerprint) continue;
    const q = buildQueryFromFingerprint(item);
    if (q) queries.set(q, {
      score:    10,
      source:   "watchlist",
      category: item.category || "",
      fp:       item.fingerprint,
      brand:    item.brand || "",
      model:    item.model || "",
    });
  }

  // Source 2: Portfolio HOLDING/LISTED items (need comps)
  for (const item of portfolioItems) {
    if (!["HOLDING", "LISTED"].includes(item?.lifecycleStatus)) continue;
    const q = buildQueryFromFingerprint(item);
    if (q) {
      const existing = queries.get(q);
      queries.set(q, {
        score:    existing ? existing.score + 5 : 7,
        source:   existing ? existing.source : "portfolio",
        category: item.category || "",
        fp:       item.fingerprint || buildFp(item),
        brand:    item.brand || item.identity?.brand || "",
        model:    item.model || item.identity?.model || "",
      });
    }
  }

  // Source 3: Top affinity categories (from outcome learning)
  const affinityCategories = categoryAffinities
    .filter((a) => a.affinityScore >= 0.5)
    .slice(0, 5)
    .map((a) => a.category);

  // Source 4: Category stats — categories user buys/scans often
  const activeCats = categoryStats
    .filter((s) => (s.buyCount || 0) + (s.scanCount || 0) >= 3)
    .sort((a, b) => ((b.profitCents || 0) - (a.profitCents || 0)))
    .slice(0, 5)
    .map((s) => s.category);

  const targetCategories = [...new Set([...affinityCategories, ...activeCats])];

  // Source 5: Generic high-value category queries from active user categories
  const CAT_DISCOVERY_QUERIES = {
    sneakers:     ["Nike Jordan 1 retro", "Adidas Yeezy boost", "New Balance 550"],
    watches:      ["Casio G-Shock vintage", "Seiko automatic diver", "Citizen Eco-Drive"],
    electronics:  ["PS5 console bundle", "Nintendo Switch OLED", "iPad Air used"],
    bags:         ["Coach leather bag", "Kate Spade crossbody", "Tumi backpack"],
    clothing:     ["Supreme hoodie", "Carhartt WIP jacket", "vintage Levi 501"],
    eyewear:      ["Ray-Ban Wayfarer", "Oakley Frogskins vintage", "Moscot glasses"],
    cameras:      ["Sony A7 mirrorless", "Fujifilm X100", "Canon AE-1 film"],
    vintage:      ["vintage Levi 501 denim", "vintage Band tee", "vintage windbreaker"],
    jewelry:      ["gold chain 14k", "sterling silver bracelet", "vintage pendant"],
    collectibles: ["Pokemon card lot", "Funko Pop rare", "vintage baseball card"],
  };

  for (const cat of targetCategories) {
    const catQueries = CAT_DISCOVERY_QUERIES[cat] || CAT_DISCOVERY_QUERIES[cat?.toLowerCase()] || [];
    for (const q of catQueries) {
      if (!queries.has(q)) {
        queries.set(q, {
          score:    4,
          source:   "category_affinity",
          category: cat,
          fp:       null,
          brand:    "",
          model:    "",
        });
      }
    }
  }

  // Source 6: Recent saved scans — rescan for price movement
  const recentScans = savedScans
    .filter((s) => s.finalQuery || s.query)
    .slice(0, 10);

  for (const scan of recentScans) {
    const q = scan.finalQuery || scan.query;
    if (q && !queries.has(q)) {
      queries.set(q, {
        score:    3,
        source:   "scan_history",
        category: scan.visionIdentity?.category || scan.category || "",
        fp:       null,
        brand:    scan.visionIdentity?.brand || "",
        model:    scan.visionIdentity?.model || "",
      });
    }
  }

  // Sort by score descending and cap
  return [...queries.entries()]
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, maxQueries)
    .map(([query, meta]) => ({ query, ...meta }));
}

/**
 * Score a single discovery opportunity.
 * Returns 0–100 composite score for ranking.
 */
export function scoreDiscoveryOpportunity({
  buySignal       = null,
  dealStrength    = 0,
  demandScore     = 0,
  resaleScore     = 0,
  confidenceV2    = 0,
  priceStats      = null,
  isWatched       = false,
  isOwned         = false,
  source          = "category_affinity",
}) {
  if (!priceStats) return 0;

  let score = 0;

  // Buy signal tiers
  const signalScore = {
    "STRONG BUY": 40,
    "GOOD DEAL":  30,
    "FAIR":       10,
    "OVERPRICED": 0,
    "RISKY":      0,
    "INSUFFICIENT DATA": 0,
  }[buySignal] ?? 0;
  score += signalScore;

  // Deal strength component (0–25)
  score += Math.max(0, Math.min(25, dealStrength * 80));

  // Demand component (0–15)
  score += Math.max(0, Math.min(15, (demandScore / 100) * 15));

  // Confidence component (0–10)
  score += Math.max(0, Math.min(10, (confidenceV2 - 0.4) / 0.6 * 10));

  // Source bonus
  if (isWatched) score += 8;
  if (source === "portfolio") score += 4;

  return Math.min(100, Math.round(score));
}

/**
 * Build a single discovery opportunity card from market result data.
 */
export function buildDiscoveryOpportunity({
  query,
  source     = "category_affinity",
  category   = "",
  brand      = "",
  model      = "",
  fp         = null,
  items      = [],
  profitIntel = null,
  isWatched  = false,
  isOwned    = false,
}) {
  if (!profitIntel || !Array.isArray(items) || items.length === 0) return null;

  const { buySignal, dealStrength, demandScore, resaleScore, priceStats, reasoning,
          primaryAction, confidenceV2, expectedProfit } = profitIntel;

  if (!priceStats?.median) return null;

  // Only surface actionable deals
  if (["INSUFFICIENT DATA", "OVERPRICED"].includes(buySignal) && !isWatched) return null;

  const oppScore = scoreDiscoveryOpportunity({
    buySignal, dealStrength, demandScore, resaleScore, confidenceV2, priceStats,
    isWatched, isOwned, source,
  });

  if (oppScore < 15 && !isWatched) return null;

  const bestItem = items.reduce((best, it) => {
    if (!best) return it;
    const bp = extractPrice(it);
    const cp = extractPrice(best);
    return (bp !== null && cp !== null && bp < cp) ? it : best;
  }, null);

  return {
    discoveryId:    `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    query,
    source,
    category,
    brand,
    model,
    fingerprint:    fp || buildFpFromParts(brand, model, category),
    buySignal,
    primaryAction:  primaryAction || "WATCH",
    opportunityScore: oppScore,
    dealStrength:   round2(dealStrength || 0),
    demandScore:    Math.round(demandScore || 0),
    resaleScore:    Math.round(resaleScore || 0),
    confidenceV2:   round2(confidenceV2 || 0),
    priceStats:     { median: priceStats.median, low: priceStats.low, high: priceStats.high },
    expectedProfit: expectedProfit || null,
    reasoning:      reasoning || null,
    listingCount:   items.length,
    bestListing:    bestItem ? summarizeListing(bestItem) : null,
    isWatched,
    isOwned,
    discoveredAt:   Date.now(),
  };
}

/**
 * Rank discovery opportunities by score, dedup by fingerprint.
 */
export function rankDiscoveryFeed(opportunities = [], limit = 20) {
  const seen = new Set();
  return opportunities
    .filter(Boolean)
    .filter((o) => {
      const key = o.fingerprint || o.query;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
    .slice(0, limit);
}

// ── Snapshot Storage ──────────────────────────────────────────────────────────

export async function storeDiscoverySnapshot(redis, userId, opportunities = []) {
  if (!redis || !userId) return null;
  const snapshot = {
    userId,
    opportunities: rankDiscoveryFeed(opportunities, 30),
    generatedAt:   Date.now(),
    count:         opportunities.length,
  };
  await redis.set(KEY_SNAPSHOT(userId), JSON.stringify(snapshot), "EX", SNAPSHOT_TTL);

  // Store individual hits by fingerprint for fast lookup
  const pipeline = redis.pipeline();
  for (const opp of snapshot.opportunities) {
    if (!opp?.fingerprint) continue;
    pipeline.set(KEY_HIT(userId, opp.fingerprint), JSON.stringify(opp), "EX", OPPORTUNITY_TTL);
    pipeline.sadd(KEY_SEEN(userId), opp.fingerprint);
  }
  pipeline.zremrangebyrank(KEY_SEEN(userId), 0, -(MAX_SEEN + 1));
  pipeline.expire(KEY_SEEN(userId), SEEN_TTL);
  await pipeline.exec();

  return snapshot;
}

export async function getDiscoverySnapshot(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(KEY_SNAPSHOT(userId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function getSeenFingerprints(redis, userId) {
  if (!redis || !userId) return new Set();
  try {
    const members = await redis.smembers(KEY_SEEN(userId));
    return new Set(members);
  } catch {
    return new Set();
  }
}

// ── Queue Management ──────────────────────────────────────────────────────────

/**
 * Enqueue query universe into Redis for async processing.
 */
export async function enqueueDiscoveryScans(redis, userId, queryUniverse = []) {
  if (!redis || !userId || !queryUniverse.length) return 0;
  const pipeline = redis.pipeline();
  const now = Date.now();
  for (const item of queryUniverse) {
    const fp = item.fp || buildFpFromParts(item.brand, item.model, item.category);
    pipeline.zadd(KEY_QUEUE(userId), item.score || 1, JSON.stringify({ ...item, fp }));
  }
  pipeline.zremrangebyrank(KEY_QUEUE(userId), 0, -(MAX_QUEUE + 1));
  pipeline.expire(KEY_QUEUE(userId), 3600); // 1h TTL on queue
  await pipeline.exec();
  return queryUniverse.length;
}

export async function dequeueDiscoveryBatch(redis, userId, batchSize = 5) {
  if (!redis || !userId) return [];
  try {
    // Pop highest-scored items
    const raw = await redis.zrevrange(KEY_QUEUE(userId), 0, batchSize - 1);
    if (!raw?.length) return [];
    const items = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    await redis.zrem(KEY_QUEUE(userId), ...raw);
    return items;
  } catch {
    return [];
  }
}

// ── Background refresh job ────────────────────────────────────────────────────

/**
 * Run discovery refresh for a single user.
 * Called by the discovery_refresh queue job.
 * Pulls from queue, fetches market data via provided fetchFn, stores snapshot.
 */
export async function runDiscoveryRefreshJob(redis, userId, {
  fetchMarketItems,   // async (query) => items[]
  assembleProfitIntel,
  watchedFingerprints = new Set(),
  ownedFingerprints   = new Set(),
  batchSize           = 8,
} = {}) {
  if (!redis || !userId || typeof fetchMarketItems !== "function") return null;

  const batch = await dequeueDiscoveryBatch(redis, userId, batchSize);
  if (!batch.length) return { processed: 0, opportunities: [] };

  const opportunities = [];

  for (const queryItem of batch) {
    try {
      const items = await fetchMarketItems(queryItem.query);
      if (!Array.isArray(items) || items.length === 0) continue;

      const profitIntel = assembleProfitIntel({
        items,
        scannedPrice:       null,
        visionConfidence:   0.5,
        confidenceV2:       0.5,
        resultConsensus:    null,
        refinementWarnings: [],
        prediction:         null,
        category:           queryItem.category || null,
        crossCheck:         null,
        isOracleOnly:       false,
      });

      const opp = buildDiscoveryOpportunity({
        query:      queryItem.query,
        source:     queryItem.source || "category_affinity",
        category:   queryItem.category || "",
        brand:      queryItem.brand || "",
        model:      queryItem.model || "",
        fp:         queryItem.fp || null,
        items,
        profitIntel,
        isWatched:  watchedFingerprints.has(queryItem.fp),
        isOwned:    ownedFingerprints.has(queryItem.fp),
      });

      if (opp) opportunities.push(opp);
    } catch {
      // per-query failure is non-fatal
    }
  }

  if (opportunities.length > 0) {
    await storeDiscoverySnapshot(redis, userId, opportunities);
  }

  return { processed: batch.length, opportunities };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildQueryFromFingerprint(item) {
  const brand    = String(item?.brand || item?.identity?.brand || "").trim();
  const model    = String(item?.model || item?.identity?.model || "").trim();
  const category = String(item?.category || item?.identity?.category || "").trim();
  const parts    = [brand, model].filter(Boolean);
  return parts.length >= 1 ? parts.join(" ") : (category || null);
}

function buildFp(item) {
  return buildFpFromParts(
    item?.brand || item?.identity?.brand || "",
    item?.model || item?.identity?.model || "",
    item?.category || item?.identity?.category || "",
  );
}

function buildFpFromParts(brand = "", model = "", category = "") {
  return [brand, model, category]
    .map((s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "_"))
    .filter(Boolean)
    .join(":") || "unknown";
}

function extractPrice(item) {
  const p = item?.price ?? item?.currentPrice ?? item?.extractedPrice;
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function summarizeListing(item) {
  return {
    title:  String(item?.title || item?.name || "").slice(0, 120),
    price:  extractPrice(item),
    source: item?.source || item?.marketplace || item?.platform || "",
    url:    item?.url || item?.link || null,
  };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
