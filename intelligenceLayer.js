import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(
  process.env.INTELLIGENCE_ROOT || "./storage/intelligence"
);

const PRICE_DIR = path.join(ROOT, "price-history");
const SOLD_DIR = path.join(ROOT, "sold-comps");
const META_DIR = path.join(ROOT, "meta");

const WATCH_FILE = path.join(META_DIR, "watch-queries.json");
const CRAWLER_FILE = path.join(META_DIR, "crawler-state.json");

const PRICE_HISTORY = new Map();
const SOLD_COMPS = new Map();
const WATCH_MAP = new Map();
const CRAWLER_MAP = new Map();

let INITIALIZED = false;
let INIT_PROMISE = null;

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "new",
  "used",
  "vintage",
  "retro",
  "style",
  "rare",
  "sale",
  "best",
  "price",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
]);

function sha(input = "") {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function finitePrice(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? round2(v) : null;
}

function clamp(n, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(n) || 0));
}

function normalizeQuery(q = "") {
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeTitleKey(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(s = "") {
  return normalizeTitleKey(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !STOP.has(x));
}

function uniqueStrings(list = [], max = 200) {
  const seen = new Set();
  const out = [];

  for (const raw of Array.isArray(list) ? list : []) {
    const v = String(raw ?? "").trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= max) break;
  }

  return out;
}

function median(values = []) {
  const arr = (Array.isArray(values) ? values : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!arr.length) return null;

  const mid = Math.floor(arr.length / 2);
  return arr.length % 2
    ? round2(arr[mid])
    : round2((arr[mid - 1] + arr[mid]) / 2);
}

function average(values = []) {
  const arr = (Array.isArray(values) ? values : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));

  if (!arr.length) return null;
  return round2(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function queryHash(query = "") {
  return sha(normalizeQuery(query)).slice(0, 24);
}

function priceFileForQuery(query = "") {
  return path.join(PRICE_DIR, `${queryHash(query)}.json`);
}

function soldFileForQuery(query = "") {
  return path.join(SOLD_DIR, `${queryHash(query)}.json`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function isMarketplaceSource(src = "") {
  const s = String(src || "").toLowerCase();

  return (
    s.includes("ebay") ||
    s.includes("etsy") ||
    s.includes("mercari") ||
    s.includes("poshmark") ||
    s.includes("depop") ||
    s.includes("grailed") ||
    s.includes("facebook") ||
    s.includes("marketplace") ||
    s.includes("vinted") ||
    s.includes("whatnot")
  );
}

async function loadMetaFileIntoMap(filePath, targetMap) {
  const raw = await readJson(filePath, {});
  for (const [key, value] of Object.entries(raw || {})) {
    if (value && typeof value === "object") {
      targetMap.set(key, value);
    }
  }
}

async function persistMapToFile(filePath, sourceMap) {
  const out = Object.fromEntries(sourceMap.entries());
  await writeJson(filePath, out);
}

async function loadPriceHistory(query = "") {
  const q = normalizeQuery(query);
  if (!q) return [];
  if (PRICE_HISTORY.has(q)) return PRICE_HISTORY.get(q);

  const rows = await readJson(priceFileForQuery(q), []);
  const list = Array.isArray(rows) ? rows : [];
  PRICE_HISTORY.set(q, list);
  return list;
}

async function loadSoldComps(query = "") {
  const q = normalizeQuery(query);
  if (!q) return [];
  if (SOLD_COMPS.has(q)) return SOLD_COMPS.get(q);

  const rows = await readJson(soldFileForQuery(q), []);
  const list = Array.isArray(rows) ? rows : [];
  SOLD_COMPS.set(q, list);
  return list;
}

async function persistPriceHistory(query = "", rows = []) {
  const q = normalizeQuery(query);
  if (!q) return;
  PRICE_HISTORY.set(q, rows);
  await writeJson(priceFileForQuery(q), rows);
}

async function persistSoldComps(query = "", rows = []) {
  const q = normalizeQuery(query);
  if (!q) return;
  SOLD_COMPS.set(q, rows);
  await writeJson(soldFileForQuery(q), rows);
}

export async function initializeIntelligenceLayer() {
  if (INITIALIZED) return getIntelligenceStats();
  if (INIT_PROMISE) return INIT_PROMISE;

  INIT_PROMISE = (async () => {
    await Promise.all([
      ensureDir(ROOT),
      ensureDir(PRICE_DIR),
      ensureDir(SOLD_DIR),
      ensureDir(META_DIR),
    ]);

    await Promise.all([
      loadMetaFileIntoMap(WATCH_FILE, WATCH_MAP),
      loadMetaFileIntoMap(CRAWLER_FILE, CRAWLER_MAP),
    ]);

    INITIALIZED = true;
    return getIntelligenceStats();
  })().finally(() => {
    INIT_PROMISE = null;
  });

  return INIT_PROMISE;
}

async function ensureReady() {
  if (!INITIALIZED) {
    await initializeIntelligenceLayer();
  }
}

export function getIntelligenceStats() {
  return {
    root: ROOT,
    cachedPriceHistories: PRICE_HISTORY.size,
    cachedSoldCompSets: SOLD_COMPS.size,
    watchQueries: WATCH_MAP.size,
    crawlerQueries: CRAWLER_MAP.size,
  };
}

export async function recordPriceHistory(query, items = [], meta = {}) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const docs = (Array.isArray(items) ? items : [])
    .map((item) => ({
      title: item?.title || null,
      source: item?.source || null,
      price: finitePrice(item?.totalPrice ?? item?.price),
    }))
    .filter((row) => row.title && row.price != null)
    .sort((a, b) => Number(a.price) - Number(b.price));

  if (!docs.length) {
    return await getPriceHistorySummary(q);
  }

  const prices = docs.map((row) => row.price).filter((n) => n != null);
  const sources = new Set(
    docs.map((row) => String(row.source || "").toLowerCase()).filter(Boolean)
  );

  const point = {
    ts: Date.now(),
    count: docs.length,
    low: prices[0] ?? null,
    median: median(prices),
    avg: average(prices),
    high: prices[prices.length - 1] ?? null,
    sourceDiversity: sources.size,
    cheapestTitle: docs[0]?.title || null,
    cheapestSource: docs[0]?.source || null,
    category: meta?.identity?.category || null,
    brand: meta?.identity?.brand || null,
  };

  const history = await loadPriceHistory(q);
  history.push(point);

  while (history.length > 480) {
    history.shift();
  }

  await persistPriceHistory(q, history);
  return point;
}

export async function getPriceHistorySummary(query) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const history = await loadPriceHistory(q);
  if (!history.length) return null;

  const now = Date.now();
  const recent = history.filter((row) => now - Number(row.ts || 0) <= 30 * 24 * 60 * 60 * 1000);
  const rows = recent.length ? recent : history;

  const lows = rows.map((row) => row.low).filter((n) => n != null);
  const meds = rows.map((row) => row.median).filter((n) => n != null);
  const avgs = rows.map((row) => row.avg).filter((n) => n != null);
  const highs = rows.map((row) => row.high).filter((n) => n != null);

  const latest = history[history.length - 1] || null;

  return {
    query: q,
    points: history.length,
    windowPoints: rows.length,
    rollingLow: lows.length ? round2(Math.min(...lows)) : null,
    rollingMedian: median(meds),
    rollingAvg: average(avgs),
    rollingHigh: highs.length ? round2(Math.max(...highs)) : null,
    latest,
    firstSeenAt: Number(history[0]?.ts || 0) || null,
    lastSeenAt: Number(latest?.ts || 0) || null,
  };
}

export async function getPriceHistoryChartPoints(query, limit = 90) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return [];

  const history = await loadPriceHistory(q);
  if (!history.length) return [];

  return history
    .filter((row) => row?.ts && (row.median != null || row.low != null))
    .slice(-limit)
    .map((row) => ({
      ts:     Number(row.ts),
      date:   new Date(Number(row.ts)).toISOString().slice(0, 10),
      low:    row.low    ?? null,
      median: row.median ?? null,
      high:   row.high   ?? null,
    }));
}

export async function recordSoldCompHistory(query, items = [], meta = {}) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const soldRows = (Array.isArray(items) ? items : [])
    .filter(
      (item) =>
        item?.sold === true ||
        String(item?.status || "").toLowerCase() === "sold"
    )
    .map((item) => ({
      id: sha(
        [
          q,
          String(item?.link || item?.url || item?.buyLink || ""),
          String(item?.title || ""),
          String(finitePrice(item?.totalPrice ?? item?.price) ?? "na"),
        ].join("|")
      ).slice(0, 24),
      title: item?.title || null,
      source: item?.source || null,
      price: finitePrice(item?.totalPrice ?? item?.price),
      ts: Date.now(),
      category: meta?.identity?.category || null,
      brand: meta?.identity?.brand || null,
    }))
    .filter((row) => row.title && row.price != null);

  if (!soldRows.length) {
    return await getSoldCompSummary(q);
  }

  const existing = await loadSoldComps(q);
  const byId = new Map();

  for (const row of existing) {
    if (row?.id) byId.set(row.id, row);
  }

  for (const row of soldRows) {
    byId.set(row.id, row);
  }

  const merged = [...byId.values()]
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-600);

  await persistSoldComps(q, merged);
  return await getSoldCompSummary(q);
}

export async function getSoldCompSummary(query) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const rows = await loadSoldComps(q);
  if (!rows.length) return null;

  const prices = rows.map((row) => row.price).filter((n) => n != null);
  const latest = rows[rows.length - 1] || null;

  return {
    query: q,
    count: rows.length,
    low: prices.length ? round2(Math.min(...prices)) : null,
    median: median(prices),
    avg: average(prices),
    high: prices.length ? round2(Math.max(...prices)) : null,
    latest,
    firstSeenAt: Number(rows[0]?.ts || 0) || null,
    lastSeenAt: Number(latest?.ts || 0) || null,
  };
}

export function buildWatchSignals(query = "") {
  const q = normalizeQuery(query);
  if (!q) {
    return {
      query: null,
      watchers: 0,
      checkCount: 0,
      recentDropCount: 0,
      lastBestPrice: null,
      hotScore: 0,
      lastSeenAt: null,
    };
  }

  const node = WATCH_MAP.get(q);
  if (!node) {
    return {
      query: q,
      watchers: 0,
      checkCount: 0,
      recentDropCount: 0,
      lastBestPrice: null,
      hotScore: 0,
      lastSeenAt: null,
    };
  }

  const watchers = Array.isArray(node.recentUsers) ? node.recentUsers.length : 0;
  const checkCount = Number(node.checkCount || 0);
  const recentDropCount = Number(node.recentDropCount || 0);
  const lastSeenAt = Number(node.lastSeenAt || 0) || null;

  const recencyBonus =
    lastSeenAt == null
      ? 0
      : Math.max(0, 12 - (Date.now() - lastSeenAt) / (60 * 60 * 1000));

  const hotScore = round2(
    watchers * 14 +
      recentDropCount * 12 +
      Math.min(checkCount, 120) * 0.35 +
      recencyBonus
  );

  return {
    query: q,
    watchers,
    checkCount,
    recentDropCount,
    lastBestPrice: finitePrice(node.lastBestPrice),
    hotScore,
    lastSeenAt,
  };
}

export async function recordWatchHeartbeat({
  userId = null,
  query,
  bestPrice = null,
  state = null,
  consensus = null,
} = {}) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const existing = WATCH_MAP.get(q) || {
    query: q,
    recentUsers: [],
    checkCount: 0,
    recentDropCount: 0,
    lastBestPrice: null,
    lastSeenAt: 0,
    lastConsensusScore: null,
  };

  const next = {
    ...existing,
    recentUsers: userId
      ? uniqueStrings([...(existing.recentUsers || []), String(userId)], 240)
      : existing.recentUsers || [],
    checkCount: Number(existing.checkCount || 0) + 1,
    recentDropCount:
      Number(existing.recentDropCount || 0) +
      ((state?.lastDelta?.priceDropped || state?.priceDropped) ? 1 : 0),
    lastBestPrice: finitePrice(bestPrice) ?? existing.lastBestPrice ?? null,
    lastSeenAt: Date.now(),
    lastConsensusScore:
      Number.isFinite(Number(consensus?.consensusScore))
        ? Number(consensus.consensusScore)
        : existing.lastConsensusScore ?? null,
  };

  WATCH_MAP.set(q, next);
  await persistMapToFile(WATCH_FILE, WATCH_MAP);

  return buildWatchSignals(q);
}

export async function recordCrawlerRefresh(query, items = [], meta = {}) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const bestPrice = finitePrice(items?.[0]?.totalPrice ?? items?.[0]?.price);
  const watchSignals = buildWatchSignals(q);

  const existing = CRAWLER_MAP.get(q) || {
    query: q,
    refreshCount: 0,
    lastRefreshAt: 0,
    lastResultCount: 0,
    bestPrice: null,
    lastReason: null,
  };

  const next = {
    ...existing,
    refreshCount: Number(existing.refreshCount || 0) + 1,
    lastRefreshAt: Date.now(),
    lastResultCount: Array.isArray(items) ? items.length : 0,
    bestPrice: bestPrice ?? existing.bestPrice ?? null,
    lastReason: meta?.reason || null,
    watchHotScore: watchSignals.hotScore || 0,
  };

  CRAWLER_MAP.set(q, next);
  await persistMapToFile(CRAWLER_FILE, CRAWLER_MAP);

  return next;
}

export function getCrawlerQueueCandidates(limit = 6) {
  const queries = new Set([
    ...WATCH_MAP.keys(),
    ...CRAWLER_MAP.keys(),
  ]);

  const now = Date.now();
  const out = [];

  for (const q of queries) {
    const watch = buildWatchSignals(q);
    const crawl = CRAWLER_MAP.get(q) || null;

    const lastRefreshAt = Number(crawl?.lastRefreshAt || 0);
    const staleMinutes =
      lastRefreshAt > 0 ? (now - lastRefreshAt) / 60000 : 9999;

    const staleScore = Math.min(staleMinutes / 8, 18);
    const resultCountScore = Math.min(Number(crawl?.lastResultCount || 0), 24) * 0.3;

    const score = round2(
      Number(watch.hotScore || 0) +
        staleScore +
        resultCountScore +
        (crawl?.bestPrice ? 2 : 0)
    );

    out.push({
      query: q,
      score,
      watchers: watch.watchers || 0,
      hotScore: watch.hotScore || 0,
      lastRefreshAt: lastRefreshAt || null,
      staleMinutes: round2(staleMinutes),
      lastResultCount: Number(crawl?.lastResultCount || 0),
    });
  }

  return out
    .filter((row) => Number(row.score || 0) >= 3)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, Math.max(1, Number(limit || 6)));
}

export async function rerankWithIntelligence(
  query,
  items = [],
  { scannedPrice = null, visionConfidence = 0.5 } = {}
) {
  await ensureReady();

  const q = normalizeQuery(query);
  const list = Array.isArray(items) ? items.filter(Boolean) : [];

  if (!q || !list.length) {
    return {
      items: list,
      meta: {
        priceHistory: await getPriceHistorySummary(q),
        soldComp: await getSoldCompSummary(q),
        watchSignals: buildWatchSignals(q),
      },
    };
  }

  const [priceHistory, soldComp] = await Promise.all([
    getPriceHistorySummary(q),
    getSoldCompSummary(q),
  ]);

  const watchSignals = buildWatchSignals(q);

  const historyMedian =
    Number(priceHistory?.rollingMedian) ||
    Number(priceHistory?.latest?.median) ||
    null;

  const soldMedian =
    Number(soldComp?.median) || null;

  const visionBoost = clamp(visionConfidence, 0, 1);

  const scored = list.map((item) => {
    const price = finitePrice(item?.totalPrice ?? item?.price);
    const marketplaceBoost = isMarketplaceSource(item?.source) ? 0.08 : -0.02;

    const dealScore = Number(item?.dealScore || 0);
    const flipScore = Number(item?.flipScore || 0);
    const trustScore = Number(item?.trustModelScore ?? item?.__trustScore ?? 0);
    const sellerScore = Number(item?.sellerScore || 0);
    const authRisk = Number(item?.authRisk || 0);
    const relevance = Number(item?.__relevance || 0);
    const imageScore = Number(item?.__imageScore ?? item?.visualScore ?? 0);

    const historyEdge =
      historyMedian && price
        ? clamp((historyMedian - price) / Math.max(historyMedian, 1), -0.7, 0.7)
        : 0;

    const soldEdge =
      soldMedian && price
        ? clamp((soldMedian - price) / Math.max(soldMedian, 1), -0.7, 0.7)
        : 0;

    const watchBoost = Math.min(Number(watchSignals.hotScore || 0) / 100, 1) * 0.06;
    const watchDepthBoost = Math.min(Number(watchSignals.checkCount || 0) / 40, 1) * 0.04;

    const score =
      dealScore * 0.22 +
      flipScore * 0.18 +
      trustScore * 0.14 +
      sellerScore * 0.10 +
      relevance * 0.10 +
      imageScore * 0.08 -
      authRisk * 0.16 +
      historyEdge * 0.12 +
      soldEdge * 0.14 +
      marketplaceBoost +
      watchBoost +
      watchDepthBoost +
      visionBoost * 0.02;

    return {
      ...item,
      intelRankScore: round2(score),
      intelHistoryDeltaPct:
        historyMedian && price
          ? round2(((historyMedian - price) / Math.max(historyMedian, 1)) * 100)
          : null,
      intelSoldDeltaPct:
        soldMedian && price
          ? round2(((soldMedian - price) / Math.max(soldMedian, 1)) * 100)
          : null,
      intelHistoricalMedian: historyMedian ? round2(historyMedian) : null,
      intelSoldMedian: soldMedian ? round2(soldMedian) : null,
    };
  });

  scored.sort((a, b) => {
    const aScore = Number(a?.intelRankScore || 0);
    const bScore = Number(b?.intelRankScore || 0);

    if (Math.abs(bScore - aScore) > 0.02) {
      return bScore - aScore;
    }

    const aPrice = Number(a?.totalPrice ?? a?.price ?? Infinity);
    const bPrice = Number(b?.totalPrice ?? b?.price ?? Infinity);

    if (aPrice !== bPrice) {
      return aPrice - bPrice;
    }

    return Number(b?.__relevance || 0) - Number(a?.__relevance || 0);
  });

  return {
    items: scored,
    meta: {
      scannedPrice: finitePrice(scannedPrice),
      priceHistory,
      soldComp,
      watchSignals,
    },
  };
}
