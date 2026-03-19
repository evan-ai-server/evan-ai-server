// src/crossListingDeduplicator.js
// Cross-listing deduplicator: collapses duplicate and near-duplicate listings
// across platforms into canonical items. Surfaces ghost listings (artificially
// inflated supply), detects same seller posting multiple identical items, and
// produces a clean deduplicated market view for accurate price analysis.

// ── Similarity thresholds ─────────────────────────────────────────────────────
const TITLE_SIMILARITY_THRESHOLD  = 0.72; // Jaccard similarity
const PRICE_SIMILARITY_THRESHOLD  = 0.08; // within 8% = same price tier
const GHOST_LISTING_MIN_COUNT     = 3;    // ≥3 identical unsold = ghost signal

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Compute Jaccard token similarity between two strings.
 */
function jaccardSimilarity(a = "", b = "") {
  const tokensA = new Set(String(a).toLowerCase().split(/\s+/).filter(t => t.length >= 3));
  const tokensB = new Set(String(b).toLowerCase().split(/\s+/).filter(t => t.length >= 3));
  if (!tokensA.size && !tokensB.size) return 1;
  if (!tokensA.size || !tokensB.size) return 0;

  const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
  const union        = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

/**
 * Build a fingerprint for an item — used for exact duplicate detection.
 * Normalizes title + price tier + seller to catch copy-paste relists.
 */
function buildItemFingerprint(item = {}) {
  const title    = String(item?.title || item?.name || "").toLowerCase().replace(/\s+/g, " ").trim();
  const price    = finiteOrNull(item?.totalPrice ?? item?.price);
  const priceTier = price ? Math.round(price / 5) * 5 : 0; // bucket to nearest $5
  const seller   = String(item?.seller || item?.sellerId || "").toLowerCase().trim();
  return `${title}|${priceTier}|${seller}`;
}

/**
 * Group items by fingerprint — exact duplicates share the same fingerprint.
 */
function groupExactDuplicates(items = []) {
  const groups = new Map();
  for (const item of items) {
    const fp = buildItemFingerprint(item);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(item);
  }
  return groups;
}

/**
 * Detect near-duplicate listings using Jaccard title similarity + price proximity.
 * Groups items that are likely the same product listed multiple times.
 */
export function deduplicateListings(items = []) {
  if (!items.length) return { unique: [], duplicateGroups: [], totalRemoved: 0 };

  const clusters  = [];
  const assigned  = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    assigned.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;

      const titleSim = jaccardSimilarity(
        items[i]?.title || items[i]?.name || "",
        items[j]?.title || items[j]?.name || "",
      );

      const priceA = finiteOrNull(items[i]?.totalPrice ?? items[i]?.price);
      const priceB = finiteOrNull(items[j]?.totalPrice ?? items[j]?.price);
      const priceSim = (priceA && priceB)
        ? 1 - Math.abs(priceA - priceB) / Math.max(priceA, priceB)
        : 0.5; // unknown price = neutral

      if (titleSim >= TITLE_SIMILARITY_THRESHOLD && priceSim >= (1 - PRICE_SIMILARITY_THRESHOLD)) {
        cluster.push(j);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  // For each cluster pick the canonical item (lowest price, or first if tied)
  const unique         = [];
  const duplicateGroups = [];

  for (const cluster of clusters) {
    const clusterItems = cluster.map(i => items[i]);
    if (cluster.length === 1) {
      unique.push(clusterItems[0]);
      continue;
    }

    // Sort by price asc, pick cheapest as canonical
    const sorted    = [...clusterItems].sort((a, b) => {
      const pa = finiteOrNull(a?.totalPrice ?? a?.price) ?? Infinity;
      const pb = finiteOrNull(b?.totalPrice ?? b?.price) ?? Infinity;
      return pa - pb;
    });
    const canonical = sorted[0];
    unique.push(canonical);
    duplicateGroups.push({
      canonical,
      duplicates:  sorted.slice(1),
      count:       clusterItems.length,
      titleSample: canonical?.title || canonical?.name || "",
    });
  }

  return {
    unique,
    duplicateGroups,
    totalRemoved: items.length - unique.length,
  };
}

/**
 * Detect ghost listings: ≥N unsold listings clustered near same price.
 * Ghost listings are artificially posted to manipulate perceived market price.
 */
export function detectGhostListings(items = []) {
  // Focus on active (unsold) listings
  const active = items.filter(item => !item?.sold && !item?.isSold);
  if (active.length < GHOST_LISTING_MIN_COUNT) return { detected: false, ghosts: [] };

  // Group by fingerprint
  const exactGroups = groupExactDuplicates(active);
  const ghosts      = [];

  for (const [fp, group] of exactGroups.entries()) {
    if (group.length < GHOST_LISTING_MIN_COUNT) continue;
    const prices = group.map(i => finiteOrNull(i?.totalPrice ?? i?.price)).filter(Boolean);
    if (!prices.length) continue;

    const median     = prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)];
    const seller     = group[0]?.seller || group[0]?.sellerId || "unknown";
    const titleSample = group[0]?.title || group[0]?.name || fp.split("|")[0];

    ghosts.push({
      fingerprint:  fp,
      count:        group.length,
      seller,
      medianPrice:  round2(median),
      titleSample,
      signal:       `${group.length} identical unsold listings at ~$${median?.toFixed(2)} from "${seller}" — possible ghost listing / price manipulation`,
    });
  }

  return {
    detected: ghosts.length > 0,
    ghosts,
    ghostCount: ghosts.length,
    topSignal: ghosts[0]?.signal || null,
  };
}

/**
 * Build a clean deduplicated market view.
 * Returns unique items, removed count, and a recalculated median.
 */
export function buildDeduplicatedMarket(items = []) {
  const { unique, duplicateGroups, totalRemoved } = deduplicateListings(items);

  // Recompute median from clean items
  const prices = unique
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const cleanMedian = prices.length
    ? round2(prices[Math.floor(prices.length / 2)])
    : null;

  const originalPrices = items
    .map(i => finiteOrNull(i?.totalPrice ?? i?.price))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const originalMedian = originalPrices.length
    ? round2(originalPrices[Math.floor(originalPrices.length / 2)])
    : null;

  const medianDrift = (cleanMedian && originalMedian)
    ? round2(cleanMedian - originalMedian)
    : null;

  return {
    uniqueItems:     unique,
    uniqueCount:     unique.length,
    originalCount:   items.length,
    totalRemoved,
    duplicateGroups,
    cleanMedian,
    originalMedian,
    medianDrift,
    medianDriftPct:  (medianDrift && originalMedian)
      ? round2((medianDrift / originalMedian) * 100)
      : null,
    signal: totalRemoved > 0
      ? `Removed ${totalRemoved} duplicate listing${totalRemoved !== 1 ? "s" : ""} — clean market median: $${cleanMedian?.toFixed(2) ?? "n/a"}${medianDrift ? ` (${medianDrift > 0 ? "+" : ""}${medianDrift.toFixed(2)} drift from raw)` : ""}`
      : null,
  };
}

/**
 * Master cross-listing deduplicator payload.
 */
export function buildCrossListingDeduplicatorPayload({
  uiItems  = [],
  category = "",
} = {}) {
  const items   = Array.isArray(uiItems) ? uiItems : [];
  const dedupResult = buildDeduplicatedMarket(items);
  const ghostResult = detectGhostListings(items);

  const topSignal = ghostResult.detected
    ? ghostResult.topSignal
    : dedupResult.signal || null;

  return {
    dedup:     dedupResult,
    ghosts:    ghostResult,
    topSignal,
    category:  category || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
