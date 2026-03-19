// src/lotBundleDetector.js
// Feature 77 — Lot / Bundle Detector
// Detects "lot of 3", "bundle of 5", "set of 2" style listings.
// Computes per-unit price and flags underpriced lots vs single-unit comps.
// "3 pairs for $180 = $60 each vs $85 single. Buy the lot."

// ── Lot/bundle keyword patterns ───────────────────────────────────────────────
const LOT_PATTERNS = [
  // Explicit quantity patterns
  { regex: /\blot\s+of\s+(\d+)\b/i,          extract: "number" },
  { regex: /\bbundle\s+of\s+(\d+)\b/i,        extract: "number" },
  { regex: /\bset\s+of\s+(\d+)\b/i,           extract: "number" },
  { regex: /\bpack\s+of\s+(\d+)\b/i,          extract: "number" },
  { regex: /\b(\d+)\s*[-\s]?pack\b/i,         extract: "number" },
  { regex: /\b(\d+)\s*[-\s]?piece\s+set\b/i,  extract: "number" },
  { regex: /\bpair\s+of\s+(\d+)\b/i,          extract: "number" },
  { regex: /\b(\d+)\s+pairs?\b/i,             extract: "number" },
  { regex: /\b(\d+)\s+items?\b/i,             extract: "number" },
  { regex: /\b(\d+)\s+pieces?\b/i,            extract: "number" },
  { regex: /\b(\d+)\s+units?\b/i,             extract: "number" },
  { regex: /\b(\d+)x\s/i,                     extract: "number" },
  // Word-number patterns
  { regex: /\btwo\s+(?:pairs?|items?|pieces?)\b/i,   extract: "word", count: 2 },
  { regex: /\bthree\s+(?:pairs?|items?|pieces?)\b/i, extract: "word", count: 3 },
  { regex: /\bfour\s+(?:pairs?|items?|pieces?)\b/i,  extract: "word", count: 4 },
  { regex: /\bfive\s+(?:pairs?|items?|pieces?)\b/i,  extract: "word", count: 5 },
  // Generic lot signals (unknown quantity)
  { regex: /\blot\b/i,                         extract: "generic" },
  { regex: /\bbundle\b/i,                      extract: "generic" },
  { regex: /\bbulk\b/i,                        extract: "generic" },
  { regex: /\bmixed\s+lot\b/i,                 extract: "generic" },
  { regex: /\bjob\s+lot\b/i,                   extract: "generic" },
];

// ── Category-aware per-unit heuristics ────────────────────────────────────────
// When quantity is unknown (generic lot), estimate based on category typical lot sizes
const CATEGORY_LOT_ESTIMATES = {
  sneakers:    3,    // "sneaker lot" typically 3-5 pairs
  shoes:       3,
  clothing:    5,    // "clothing lot" typically 5-10 items
  apparel:     5,
  accessories: 4,
  jewelry:     6,
  cards:       10,   // trading card lots
  books:       5,
  toys:        4,
  electronics: 2,
  default:     3,
};

// ── Core detector ─────────────────────────────────────────────────────────────

/**
 * Detect if a listing is a lot/bundle and extract quantity.
 * Returns: { isLot, quantity, confidence, lotType, patternMatched }
 */
export function detectLotBundle(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();

  for (const pattern of LOT_PATTERNS) {
    const match = text.match(pattern.regex);
    if (!match) continue;

    if (pattern.extract === "number") {
      const qty = parseInt(match[1], 10);
      if (!Number.isFinite(qty) || qty < 2 || qty > 200) continue;
      return {
        isLot:          true,
        quantity:       qty,
        confidence:     qty >= 2 && qty <= 50 ? "high" : "low",
        lotType:        classifyLotType(text),
        patternMatched: pattern.regex.toString(),
      };
    }

    if (pattern.extract === "word") {
      return {
        isLot:          true,
        quantity:       pattern.count,
        confidence:     "high",
        lotType:        classifyLotType(text),
        patternMatched: pattern.regex.toString(),
      };
    }

    if (pattern.extract === "generic") {
      return {
        isLot:          true,
        quantity:       null, // unknown
        confidence:     "low",
        lotType:        classifyLotType(text),
        patternMatched: pattern.regex.toString(),
      };
    }
  }

  return { isLot: false, quantity: null, confidence: null, lotType: null, patternMatched: null };
}

function classifyLotType(text) {
  if (/bundle/.test(text)) return "bundle";
  if (/set\s+of|matching\s+set|complete\s+set/.test(text)) return "set";
  if (/bulk/.test(text)) return "bulk";
  if (/mixed/.test(text)) return "mixed_lot";
  return "lot";
}

// ── Per-unit price computation ────────────────────────────────────────────────

/**
 * Compute per-unit price for a lot listing.
 */
export function computePerUnitPrice(totalPrice, quantity) {
  const price = Number(totalPrice);
  const qty   = Number(quantity);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 1) return null;
  return round2(price / qty);
}

/**
 * Estimate quantity for a generic lot based on category and price.
 * Uses category default lot sizes and market price context.
 */
export function estimateLotQuantity(category, totalPrice, singleUnitMedian, serpAiEstimate = null) {
  // If we have a single-unit comp price, divide to estimate quantity
  if (singleUnitMedian && Number.isFinite(Number(totalPrice)) && Number.isFinite(Number(singleUnitMedian))) {
    const priceRatio = Number(totalPrice) / Number(singleUnitMedian);
    // Round to nearest integer between 2-20
    const estimated = Math.round(priceRatio);
    if (estimated >= 2 && estimated <= 20) {
      return { quantity: estimated, method: "price_ratio" };
    }
  }

  const cat = String(category || "").toLowerCase().replace(/s$/, "");
  const defaultQty = CATEGORY_LOT_ESTIMATES[cat] ?? CATEGORY_LOT_ESTIMATES.default;
  return { quantity: defaultQty, method: "category_default" };
}

// ── Lot analysis ──────────────────────────────────────────────────────────────

/**
 * Full lot analysis: detect, compute per-unit, compare vs single-unit comps.
 */
export function analyzeLotListing(item, { singleUnitMedian = null, category = null } = {}) {
  const title = item?.title || "";
  const description = item?.description || "";
  const totalPrice = Number(item?.totalPrice ?? item?.price ?? item?.salePrice ?? 0);

  const detection = detectLotBundle(title, description);

  if (!detection.isLot) {
    return { isLot: false, detection, perUnitPrice: null, lotValue: null };
  }

  // Resolve quantity
  let resolvedQty = detection.quantity;
  let qtyMethod = "detected";
  if (!resolvedQty && singleUnitMedian) {
    const est = estimateLotQuantity(category, totalPrice, singleUnitMedian);
    resolvedQty = est.quantity;
    qtyMethod = est.method;
  } else if (!resolvedQty) {
    const est = estimateLotQuantity(category, totalPrice, null);
    resolvedQty = est.quantity;
    qtyMethod = est.method;
  }

  const perUnitPrice = totalPrice > 0 && resolvedQty ? computePerUnitPrice(totalPrice, resolvedQty) : null;

  // Compare to single-unit comp
  let lotValue = null;
  if (perUnitPrice && singleUnitMedian) {
    const savingsPct = round2(((singleUnitMedian - perUnitPrice) / singleUnitMedian) * 100);
    const isCheaper = perUnitPrice < singleUnitMedian;
    lotValue = {
      singleUnitMedian: round2(Number(singleUnitMedian)),
      perUnitPrice,
      savingsPct,
      isCheaper,
      totalSavings: resolvedQty ? round2((singleUnitMedian - perUnitPrice) * resolvedQty) : null,
      signal: isCheaper
        ? `Lot deal: $${perUnitPrice}/unit vs $${singleUnitMedian} single (${savingsPct}% cheaper)`
        : `Lot: $${perUnitPrice}/unit vs $${singleUnitMedian} single (no unit savings)`,
    };
  }

  return {
    isLot:        true,
    detection,
    resolvedQty,
    qtyMethod,
    totalPrice:   round2(totalPrice),
    perUnitPrice,
    lotValue,
  };
}

// ── Batch: analyze multiple listings for lot detection ────────────────────────

/**
 * Scan a list of market items and flag lot/bundle listings.
 * Returns enriched items with lot analysis + a summary.
 */
export function analyzeBatchForLots(items = [], { singleUnitMedian = null, category = null } = {}) {
  if (!Array.isArray(items) || !items.length) return buildEmptyBatchResult();

  let lotCount = 0;
  let dealLotCount = 0;
  const enriched = items.map(item => {
    const analysis = analyzeLotListing(item, { singleUnitMedian, category });
    if (analysis.isLot) {
      lotCount++;
      if (analysis.lotValue?.isCheaper) dealLotCount++;
    }
    return { ...item, lotAnalysis: analysis };
  });

  const lotItems = enriched.filter(i => i.lotAnalysis?.isLot);
  const dealLots = lotItems.filter(i => i.lotAnalysis?.lotValue?.isCheaper);

  // Best deal lot
  const bestDeal = dealLots.sort((a, b) =>
    (b.lotAnalysis.lotValue?.savingsPct ?? 0) - (a.lotAnalysis.lotValue?.savingsPct ?? 0)
  )[0] ?? null;

  const topSignal = buildTopSignal(lotCount, dealLotCount, bestDeal, items.length);

  return {
    enrichedItems: enriched,
    totalItems:    items.length,
    lotCount,
    dealLotCount,
    lotPct:        items.length ? round2((lotCount / items.length) * 100) : 0,
    bestDeal:      bestDeal ? {
      title:        bestDeal.title,
      totalPrice:   bestDeal.lotAnalysis.totalPrice,
      perUnitPrice: bestDeal.lotAnalysis.perUnitPrice,
      resolvedQty:  bestDeal.lotAnalysis.resolvedQty,
      savingsPct:   bestDeal.lotAnalysis.lotValue?.savingsPct,
      signal:       bestDeal.lotAnalysis.lotValue?.signal,
    } : null,
    topSignal,
  };
}

function buildTopSignal(lotCount, dealLotCount, bestDeal, totalItems) {
  if (!lotCount) return null;
  const parts = [];
  if (lotCount > 0) parts.push(`${lotCount} lot listing${lotCount > 1 ? "s" : ""} detected`);
  if (bestDeal?.lotAnalysis?.lotValue?.signal) parts.push(bestDeal.lotAnalysis.lotValue.signal);
  return parts.join(". ");
}

function buildEmptyBatchResult() {
  return { enrichedItems: [], totalItems: 0, lotCount: 0, dealLotCount: 0, lotPct: 0, bestDeal: null, topSignal: null };
}

// ── Master payload builder ────────────────────────────────────────────────────

export function buildLotBundlePayload(items = [], { singleUnitMedian = null, category = null } = {}) {
  const result = analyzeBatchForLots(items, { singleUnitMedian, category });
  return {
    lotBundle:  result,
    topSignal:  result.topSignal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
