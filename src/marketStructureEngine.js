// src/marketStructureEngine.js
// Phase 4F: additive, display-only market structure layer.
// Pure function — no I/O, never throws, never mutates inputs.

const VERSION = 1;

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function medianOfSorted(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n % 2 === 1) return sorted[Math.floor(n / 2)];
  return (sorted[Math.floor(n / 2) - 1] + sorted[Math.floor(n / 2)]) / 2;
}

// Normalize source for diversity counting: "eBay - sellername" → "ebay"
function normalizeSource(src) {
  if (!src || typeof src !== "string") return "unknown";
  const s = src.toLowerCase().trim().split(/[\s/-]/)[0];
  return s || "unknown";
}

// Local aircraft/diecast tier hint — no import from index.js to avoid circular deps
function aircraftTierHint(title, source) {
  const combined = ((title || "") + " " + (source || "")).toLowerCase();
  if (/geminijets|gemini jets|herpa|ng models|phoenix|jc wings|aviation400|inflight|hogan|dragon wings|aeroclassics/.test(combined)) {
    return "premium_model";
  }
  if (/daron|toy airplane|single plane|playset/.test((title || "").toLowerCase())) {
    return "generic_toy";
  }
  if (/shirt|poster|sticker|patch|pin|keychain/.test((title || "").toLowerCase())) {
    return "merch";
  }
  return "unknown_model";
}

function isAircraftCtx(ctx) {
  const cat = (ctx?.category || "").toLowerCase();
  const q = (ctx?.query || "").toLowerCase();
  return (
    cat.includes("aircraft") || cat.includes("diecast") || cat.includes("aviation") ||
    q.includes("aircraft") || q.includes("diecast") || q.includes("boeing") ||
    q.includes("airbus") || q.includes("airlines") || q.includes("airline")
  );
}

function getUsablePrice(item) {
  if (typeof item?.totalPrice === "number" && item.totalPrice > 0) return item.totalPrice;
  if (typeof item?.price === "number" && item.price > 0) return item.price;
  return null;
}

function assignLabel(clusterCount, idx) {
  if (clusterCount === 1) return "market band";
  if (clusterCount === 2) return idx === 0 ? "low band" : "premium band";
  return idx === 0 ? "low band" : idx === 1 ? "mid band" : "premium band";
}

function buildClusterObject(entries, label, isAircraft) {
  const prices = entries.map(e => e.price).sort((a, b) => a - b);
  const n = prices.length;
  const minPrice = prices[0];
  const maxPrice = prices[n - 1];
  const clusterMedian = medianOfSorted(prices);

  const srcSet = new Set(entries.map(e => normalizeSource(e.source)));
  const sourceCount = srcSet.size;

  const verifiedCount = entries.filter(e => e.isVerifiedListing === true).length;

  // Up to 3 representative titles: copy only, shortest sensible first or first by price
  const byPrice = [...entries].sort((a, b) => a.price - b.price);
  const representativeTitles = byPrice
    .slice(0, 5)
    .map(e => (e.title || "").trim())
    .filter(Boolean)
    .sort((a, b) => a.length - b.length)
    .slice(0, 3);

  // tierHint only relevant for aircraft/diecast context
  let tierHint = null;
  if (isAircraft) {
    const counts = {};
    for (const e of entries) {
      const h = aircraftTierHint(e.title, e.source);
      counts[h] = (counts[h] || 0) + 1;
    }
    tierHint = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown_model";
  }

  // Transparent confidence scoring
  const base = n + sourceCount * 0.5 + verifiedCount * 1.5;
  const score = round4(clamp(base / 8, 0, 1));
  const confidenceLabel = score >= 0.75 ? "strong" : score >= 0.45 ? "moderate" : "weak";

  return {
    label,
    minPrice,
    maxPrice,
    median: clusterMedian,
    count: n,
    sourceCount,
    representativeTitles,
    verifiedCount,
    tierHint,
    confidence: { score, label: confidenceLabel },
  };
}

function buildMarketStory({ scannedPricePosition, clusterCount, thinMarket, unresolvedUrlRisk, spreadRisk, dominantCluster }) {
  // A: Clear value pocket — scanned price below the dominant band
  if (
    scannedPricePosition === "below" &&
    dominantCluster &&
    (dominantCluster.confidence?.label === "moderate" || dominantCluster.confidence?.label === "strong") &&
    !spreadRisk
  ) {
    const lo = dominantCluster.minPrice != null ? `$${Math.round(dominantCluster.minPrice)}` : null;
    const hi = dominantCluster.maxPrice != null ? `$${Math.round(dominantCluster.maxPrice)}` : null;
    const range = lo && hi ? `${lo}–${hi}` : "the market band";
    return `Comparable listings cluster around ${range}, and the scanned price sits below that band. Treat this as promising, but still check condition and exact match.`;
  }

  // D: Above market — scanned price exceeds the dominant band (cautionary, no profit framing)
  if (scannedPricePosition === "above") {
    return "Most comparable listings cluster below the scanned price, so this looks above the dominant market band unless condition or rarity justifies it.";
  }

  // B: Premium vs budget split — market has distinct price tiers
  if (clusterCount >= 2 && !thinMarket) {
    return "This market splits into lower and higher price bands, so the exact brand, scale, condition, or variant matters. Compare against the dominant band before trusting a single median.";
  }

  // C: Thin / uncertain — limited or unresolvable evidence
  if (thinMarket || unresolvedUrlRisk) {
    return "Market evidence is limited, with few independent comps. Treat the price signal as directional, not definitive.";
  }

  // E: No structure (fallback)
  return "The available comps do not form a strong market structure yet, so conclusions should stay cautious.";
}

function _safeEmpty(ctx) {
  const sp = typeof ctx?.scannedPrice === "number" && ctx.scannedPrice > 0 ? ctx.scannedPrice : null;
  return {
    version: VERSION,
    clusterCount: 0,
    clusters: [],
    dominantCluster: null,
    scannedPrice: sp,
    scannedPricePosition: "unknown",
    scannedPriceVsDominantPct: null,
    outlierCount: 0,
    sourceDiversityScore: 0,
    thinMarket: true,
    spreadRisk: false,
    unresolvedUrlRisk: true,
    premiumTierDetected: false,
    genericToyContamination: (ctx?.identityRejections?.rejectedGenericToyCount ?? 0) > 0,
    marketStory: "Market evidence is limited, with few independent comps. Treat the price signal as directional, not definitive.",
  };
}

function _analyzeMarketStructure(items, ctx) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  const isAircraft = isAircraftCtx(ctx);

  // Normalize entries — copy only, never mutate originals
  const entries = [];
  for (const item of safeItems) {
    const price = getUsablePrice(item);
    if (price === null) continue;
    entries.push({
      price,
      title: typeof item.title === "string" ? item.title : "",
      source: typeof item.source === "string" ? item.source : (typeof item.store === "string" ? item.store : ""),
      isVerifiedListing: item.isVerifiedListing === true,
      urlQuality: item.urlQuality || null,
    });
  }

  const usableCount = entries.length;
  const scannedPrice = typeof ctx?.scannedPrice === "number" && ctx.scannedPrice > 0 ? ctx.scannedPrice : null;
  const genericToyContamination = (ctx?.identityRejections?.rejectedGenericToyCount ?? 0) > 0;

  if (usableCount === 0) {
    return { ..._safeEmpty(ctx), scannedPrice, genericToyContamination };
  }

  // Sort ascending by price
  const sorted = [...entries].sort((a, b) => a.price - b.price);
  const sortedPrices = sorted.map(e => e.price);

  // ── Cluster algorithm ─────────────────────────────────────────────────────
  let clusterGroups;

  if (usableCount < 4) {
    clusterGroups = [sorted];
  } else {
    const allPricesSorted = [...sortedPrices].sort((a, b) => a - b);
    const globalMedian = medianOfSorted(allPricesSorted);
    const globalRange = sortedPrices[sortedPrices.length - 1] - sortedPrices[0];

    const splitCandidates = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i].price;
      const next = sorted[i + 1].price;
      const absoluteGap = next - curr;
      const relativeGap = curr > 0 ? next / curr : Infinity;
      const normalizedGap = globalMedian > 0 ? absoluteGap / globalMedian : 0;

      const condA = relativeGap >= 1.5 && absoluteGap >= 0.25 * globalMedian;
      const condB = normalizedGap >= 0.4 && usableCount >= 5;

      if (condA || condB) {
        const splitScore = normalizedGap + Math.max(0, relativeGap - 1);
        splitCandidates.push({ afterIdx: i, splitScore });
      }
    }

    // Keep top 2 split candidates by splitScore, then restore original order
    let finalSplits = splitCandidates;
    if (splitCandidates.length > 2) {
      finalSplits = [...splitCandidates]
        .sort((a, b) => b.splitScore - a.splitScore)
        .slice(0, 2)
        .sort((a, b) => a.afterIdx - b.afterIdx);
    }

    if (finalSplits.length === 0) {
      clusterGroups = [sorted];
    } else {
      clusterGroups = [];
      let start = 0;
      for (const split of finalSplits) {
        clusterGroups.push(sorted.slice(start, split.afterIdx + 1));
        start = split.afterIdx + 1;
      }
      clusterGroups.push(sorted.slice(start));
    }

    // Cap at 3 clusters: merge smallest adjacent pair until at most 3
    while (clusterGroups.length > 3) {
      let minPairSize = Infinity;
      let mergeIdx = 0;
      for (let i = 0; i < clusterGroups.length - 1; i++) {
        const pairSize = clusterGroups[i].length + clusterGroups[i + 1].length;
        if (pairSize < minPairSize) { minPairSize = pairSize; mergeIdx = i; }
      }
      clusterGroups[mergeIdx] = [...clusterGroups[mergeIdx], ...clusterGroups[mergeIdx + 1]];
      clusterGroups.splice(mergeIdx + 1, 1);
    }
  }

  const clusterCount = clusterGroups.length;

  // Build cluster objects
  const clusters = clusterGroups.map((group, idx) =>
    buildClusterObject(group, assignLabel(clusterCount, idx), isAircraft)
  );

  // ── Dominant cluster ──────────────────────────────────────────────────────
  const globalMedianAll = medianOfSorted([...sortedPrices].sort((a, b) => a - b));

  let dominantCluster = null;
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    if (!dominantCluster) { dominantCluster = { ...c, index: i }; continue; }
    if (c.count > dominantCluster.count) { dominantCluster = { ...c, index: i }; continue; }
    if (c.count === dominantCluster.count) {
      if (c.sourceCount > dominantCluster.sourceCount) { dominantCluster = { ...c, index: i }; continue; }
      if (c.sourceCount === dominantCluster.sourceCount && globalMedianAll != null) {
        const cDist = Math.abs(c.median - globalMedianAll);
        const dDist = Math.abs(dominantCluster.median - globalMedianAll);
        if (cDist < dDist) { dominantCluster = { ...c, index: i }; }
      }
    }
  }

  const dominantSummary = dominantCluster ? {
    index: dominantCluster.index,
    label: dominantCluster.label,
    median: dominantCluster.median,
    count: dominantCluster.count,
    sourceCount: dominantCluster.sourceCount,
  } : null;

  // ── Scanned price position ────────────────────────────────────────────────
  let scannedPricePosition = "unknown";
  let scannedPriceVsDominantPct = null;

  if (scannedPrice !== null && dominantSummary !== null) {
    const domCluster = clusters[dominantSummary.index];
    if (scannedPrice < domCluster.minPrice) {
      scannedPricePosition = "below";
    } else if (scannedPrice > domCluster.maxPrice) {
      scannedPricePosition = "above";
    } else {
      scannedPricePosition = "within";
    }
    if (domCluster.median && domCluster.median > 0) {
      scannedPriceVsDominantPct = round4((scannedPrice - domCluster.median) / domCluster.median);
    }
  }

  // ── Risk flags ────────────────────────────────────────────────────────────
  const distinctSources = new Set(entries.map(e => normalizeSource(e.source))).size;
  const thinMarket = usableCount < 3 || distinctSources < 2;
  const sourceDiversityScore = usableCount > 0 ? round4(distinctSources / usableCount) : 0;

  const totalVerifiedCount = clusters.reduce((sum, c) => sum + c.verifiedCount, 0);
  const unresolvedUrlRisk = totalVerifiedCount === 0;

  const dominantFraction = dominantSummary ? dominantSummary.count / usableCount : 1;
  const globalRange = sortedPrices[sortedPrices.length - 1] - sortedPrices[0];
  const spreadRisk =
    (clusterCount > 1 && dominantFraction < 0.6) ||
    (globalMedianAll != null && globalMedianAll > 0 && globalRange / globalMedianAll > 1.5);

  const premiumTierDetected = clusters.some(c => c.tierHint === "premium_model");

  // Outliers: clusters with count===1 whose median is far from dominant
  const outlierCount = dominantSummary
    ? clusters.filter((c, i) => {
        if (i === dominantSummary.index) return false;
        if (c.count !== 1) return false;
        if (!dominantSummary.median || dominantSummary.median === 0) return true;
        return Math.abs(c.median - dominantSummary.median) / dominantSummary.median >= 1.0;
      }).length
    : 0;

  // ── Market story ──────────────────────────────────────────────────────────
  const dominantClusterForStory = dominantSummary ? clusters[dominantSummary.index] : null;
  const marketStory = buildMarketStory({
    scannedPricePosition,
    clusterCount,
    thinMarket,
    unresolvedUrlRisk,
    spreadRisk,
    dominantCluster: dominantClusterForStory,
  });

  return {
    version: VERSION,
    clusterCount,
    clusters,
    dominantCluster: dominantSummary,
    scannedPrice,
    scannedPricePosition,
    scannedPriceVsDominantPct,
    outlierCount,
    sourceDiversityScore,
    thinMarket,
    spreadRisk,
    unresolvedUrlRisk,
    premiumTierDetected,
    genericToyContamination,
    marketStory,
  };
}

// Public export — always safe, never throws, never mutates inputs
export function analyzeMarketStructure(items, ctx = {}) {
  try {
    return _analyzeMarketStructure(items, ctx);
  } catch {
    return _safeEmpty(ctx);
  }
}
