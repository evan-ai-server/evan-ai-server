import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(process.env.RETRIEVAL_ROOT || "./storage/retrieval");
const LISTINGS_DIR = path.join(ROOT, "listings");
const SNAPSHOTS_DIR = path.join(ROOT, "snapshots");
const VECTORS_DIR = path.join(ROOT, "vectors");
const META_DIR = path.join(ROOT, "meta");

const INDEX_FILE = path.join(META_DIR, "search-index.json");
const GRAPH_FILE = path.join(META_DIR, "product-graph.json");

const LISTINGS = new Map();
const SEARCH_INDEX = new Map();
const GRAPH = new Map();
const VECTORS = new Map();

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

function titleTokens(s = "") {
  return normalizeTitleKey(s)
    .split(" ")
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !STOP.has(x));
}

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (!a.length || a.length !== b.length) return 0;

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
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

function listingIdFor(item = {}) {
  return sha(
    [
      String(item?.link || item?.url || item?.buyLink || ""),
      String(item?.title || ""),
      String(item?.source || ""),
      String(finitePrice(item?.totalPrice ?? item?.price) ?? "na"),
    ].join("|")
  ).slice(0, 24);
}

function vectorIdFor({ imageHash = "", query = "" } = {}) {
  return sha(`${String(imageHash || "")}|${normalizeQuery(query)}`).slice(0, 24);
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

function sanitizeListing(item = {}, query = "") {
  const totalPrice = finitePrice(item?.totalPrice ?? item?.price);
  const price = finitePrice(item?.price);
  const shipping = finitePrice(item?.shipping);

  return {
    id: listingIdFor(item),
    query: normalizeQuery(query),
    title: item?.title || null,
    source: item?.source || null,
    link: item?.link || item?.url || item?.buyLink || null,
    url: item?.url || item?.buyLink || item?.link || null,
    buyLink: item?.buyLink || item?.url || item?.link || null,
    image: item?.image || null,
    price,
    shipping,
    totalPrice,
    rating:
      Number.isFinite(Number(item?.rating)) ? Number(item.rating) : null,
    reviews:
      Number.isFinite(Number(item?.reviews)) ? Number(item.reviews) : null,
    sold: item?.sold === true,
    status: item?.status || null,
    dealScore:
      Number.isFinite(Number(item?.dealScore)) ? Number(item.dealScore) : 0,
    flipScore:
      Number.isFinite(Number(item?.flipScore)) ? Number(item.flipScore) : 0,
    trustModelScore:
      Number.isFinite(Number(item?.trustModelScore))
        ? Number(item.trustModelScore)
        : 0,
    sellerScore:
      Number.isFinite(Number(item?.sellerScore)) ? Number(item.sellerScore) : 0,
    authRisk:
      Number.isFinite(Number(item?.authRisk)) ? Number(item.authRisk) : 0,
    __relevance:
      Number.isFinite(Number(item?.__relevance)) ? Number(item.__relevance) : 0,
    updatedAt: Date.now(),
  };
}

function indexListing(doc = {}) {
  const tokens = uniqueStrings(
    [
      ...titleTokens(doc?.title || ""),
      ...titleTokens(doc?.query || ""),
      ...titleTokens(doc?.source || ""),
    ],
    32
  );

  for (const token of tokens) {
    if (!SEARCH_INDEX.has(token)) {
      SEARCH_INDEX.set(token, new Set());
    }
    SEARCH_INDEX.get(token).add(doc.id);
  }
}

async function persistSearchIndex() {
  const out = {};

  for (const [token, ids] of SEARCH_INDEX.entries()) {
    out[token] = Array.from(ids).slice(-600);
  }

  await writeJson(INDEX_FILE, out);
}

async function persistGraph() {
  const out = Object.fromEntries(GRAPH.entries());
  await writeJson(GRAPH_FILE, out);
}

async function loadListings() {
  const files = await fs.readdir(LISTINGS_DIR).catch(() => []);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const doc = await readJson(path.join(LISTINGS_DIR, file), null);
    if (doc?.id) {
      LISTINGS.set(doc.id, doc);
    }
  }
}

async function loadVectors() {
  const files = await fs.readdir(VECTORS_DIR).catch(() => []);

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const doc = await readJson(path.join(VECTORS_DIR, file), null);
    if (doc?.id && Array.isArray(doc?.vector) && doc.vector.length) {
      VECTORS.set(doc.id, doc);
    }
  }
}

async function loadIndex() {
  const raw = await readJson(INDEX_FILE, null);

  if (raw && typeof raw === "object") {
    for (const [token, ids] of Object.entries(raw)) {
      SEARCH_INDEX.set(token, new Set(Array.isArray(ids) ? ids : []));
    }
    return;
  }

  for (const doc of LISTINGS.values()) {
    indexListing(doc);
  }

  await persistSearchIndex();
}

async function loadGraph() {
  const raw = await readJson(GRAPH_FILE, {});

  for (const [key, value] of Object.entries(raw || {})) {
    if (value && typeof value === "object") {
      GRAPH.set(key, value);
    }
  }
}

export async function initializeRetrievalCore() {
  if (INITIALIZED) return getRetrievalStats();
  if (INIT_PROMISE) return INIT_PROMISE;

  INIT_PROMISE = (async () => {
    await Promise.all([
      ensureDir(ROOT),
      ensureDir(LISTINGS_DIR),
      ensureDir(SNAPSHOTS_DIR),
      ensureDir(VECTORS_DIR),
      ensureDir(META_DIR),
    ]);

    await loadListings();
    await loadVectors();
    await loadIndex();
    await loadGraph();

    INITIALIZED = true;
    return getRetrievalStats();
  })().finally(() => {
    INIT_PROMISE = null;
  });

  return INIT_PROMISE;
}

async function ensureReady() {
  if (!INITIALIZED) {
    await initializeRetrievalCore();
  }
}

function snapshotPathForQuery(query = "") {
  return path.join(
    SNAPSHOTS_DIR,
    `${sha(normalizeQuery(query)).slice(0, 24)}.json`
  );
}

export function getRetrievalStats() {
  return {
    root: ROOT,
    listings: LISTINGS.size,
    tokens: SEARCH_INDEX.size,
    vectors: VECTORS.size,
    graphNodes: GRAPH.size,
  };
}

export async function upsertQuerySnapshot(query, items = [], meta = {}) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const docs = [];

  for (const item of (Array.isArray(items) ? items : []).slice(0, 60)) {
    if (!item?.title) continue;

    const doc = sanitizeListing(item, q);
    LISTINGS.set(doc.id, doc);
    indexListing(doc);
    docs.push(doc);

    await writeJson(path.join(LISTINGS_DIR, `${doc.id}.json`), doc);
  }

  if (docs.length) {
    await persistSearchIndex();
  }

  const prices = docs
    .map((doc) => doc.totalPrice ?? doc.price)
    .filter((n) => typeof n === "number" && Number.isFinite(n));

  const avg = prices.length
    ? round2(prices.reduce((a, b) => a + b, 0) / prices.length)
    : null;

  const low = prices.length ? round2(Math.min(...prices)) : null;
  const high = prices.length ? round2(Math.max(...prices)) : null;

  const snapshot = {
    query: q,
    itemIds: docs.map((doc) => doc.id),
    items: docs,
    meta: {
      count: docs.length,
      avg,
      low,
      high,
      brand: meta?.identity?.brand || null,
      category: meta?.identity?.category || null,
      updatedAt: Date.now(),
    },
  };

  await writeJson(snapshotPathForQuery(q), snapshot);
  return snapshot;
}

export async function getQuerySnapshot(query) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  return await readJson(snapshotPathForQuery(q), null);
}

export async function searchRetrievalIndex(query, limit = 60) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return [];

  const tokens = titleTokens(q);
  if (!tokens.length) return [];

  const scores = new Map();

  for (const token of tokens) {
    const ids = SEARCH_INDEX.get(token);
    if (!ids) continue;

    for (const id of ids) {
      scores.set(id, (scores.get(id) || 0) + 6);
    }
  }

  const qNorm = normalizeTitleKey(q);
  const out = [];

  for (const [id, base] of scores.entries()) {
    const doc = LISTINGS.get(id);
    if (!doc?.title) continue;

    let score = base;

    const titleNorm = normalizeTitleKey(doc.title || "");
    const docQueryNorm = normalizeTitleKey(doc.query || "");

    if (titleNorm.includes(qNorm)) score += 20;
    if (docQueryNorm.includes(qNorm)) score += 10;
    if (isMarketplaceSource(doc.source)) score += 4;

    const ageHours = Math.max(
      0,
      (Date.now() - Number(doc.updatedAt || 0)) / 3600000
    );
    score += Math.max(0, 6 - ageHours / 12);

    if (doc.totalPrice != null || doc.price != null) {
      score += 1;
    }

    out.push({
      ...doc,
      __retrievalScore: round2(score),
    });
  }

  return out
    .sort(
      (a, b) =>
        Number(b.__retrievalScore || 0) - Number(a.__retrievalScore || 0)
    )
    .slice(0, Math.max(1, Number(limit || 60)));
}

export async function upsertCanonicalProduct(query, items = [], meta = {}) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  const existing = GRAPH.get(q) || {
    canonicalQuery: q,
    listingIds: [],
    relatedQueries: [],
    sources: [],
    low: null,
    high: null,
    avg: null,
    brand: meta?.identity?.brand || null,
    category: meta?.identity?.category || null,
    updatedAt: 0,
  };

  const docs = [];

  for (const item of (Array.isArray(items) ? items : []).slice(0, 60)) {
    if (!item?.title) continue;

    const doc = sanitizeListing(item, q);
    LISTINGS.set(doc.id, doc);
    indexListing(doc);
    docs.push(doc);

    await writeJson(path.join(LISTINGS_DIR, `${doc.id}.json`), doc);
  }

  const prices = docs
    .map((doc) => doc.totalPrice ?? doc.price)
    .filter((n) => typeof n === "number" && Number.isFinite(n));

  const avg = prices.length
    ? round2(prices.reduce((a, b) => a + b, 0) / prices.length)
    : existing.avg;

  const low = prices.length ? round2(Math.min(...prices)) : existing.low;
  const high = prices.length ? round2(Math.max(...prices)) : existing.high;

  const node = {
    ...existing,
    listingIds: uniqueStrings(
      [...existing.listingIds, ...docs.map((doc) => doc.id)],
      400
    ),
    relatedQueries: uniqueStrings(
      [
        ...existing.relatedQueries,
        q,
        ...docs.map((doc) => doc.query).filter(Boolean),
      ],
      80
    ),
    sources: uniqueStrings(
      [
        ...existing.sources,
        ...docs.map((doc) => String(doc.source || "").toLowerCase()).filter(Boolean),
      ],
      60
    ),
    low,
    high,
    avg,
    brand: existing.brand || meta?.identity?.brand || null,
    category: existing.category || meta?.identity?.category || null,
    updatedAt: Date.now(),
  };

  GRAPH.set(q, node);

  await persistSearchIndex();
  await persistGraph();

  return node;
}

export async function upsertScanVector({
  imageHash,
  query,
  vector,
  metadata = {},
}) {
  await ensureReady();

  if (!Array.isArray(vector) || !vector.length) return null;

  const id = vectorIdFor({ imageHash, query });

  const record = {
    id,
    kind: "scan",
    imageHash: imageHash || null,
    query: normalizeQuery(query),
    vector: vector.map((n) => Number(n) || 0),
    dims: vector.length,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    updatedAt: Date.now(),
  };

  VECTORS.set(id, record);
  await writeJson(path.join(VECTORS_DIR, `${id}.json`), record);

  return {
    ...record,
    vector: undefined,
  };
}

export async function searchNearestStoredVectors(vector, limit = 8) {
  await ensureReady();

  if (!Array.isArray(vector) || !vector.length) return [];

  const out = [];

  for (const record of VECTORS.values()) {
    const score = cosineSimilarity(vector, record.vector);
    if (!(score > 0)) continue;

    out.push({
      id: record.id,
      query: record.query,
      imageHash: record.imageHash,
      kind: record.kind,
      score: round2(score),
      metadata: record.metadata || null,
      updatedAt: record.updatedAt,
    });
  }

  return out
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, Math.max(1, Number(limit || 8)));
}
