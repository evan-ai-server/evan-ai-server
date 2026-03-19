// src/barcodeIntelligence.js
// Barcode/UPC Lookup Engine — Feature 63
// Extracts barcode numbers from vision output (visibleText) or explicit input,
// hits UPC databases, returns exact product identity: brand, model, MSRP, specs.
// Transforms thrift scanning: barcode → instant ground-truth product identity.
// Falls back gracefully when barcode is unreadable or product is unknown.

import https from "https";

// ── Barcode pattern matchers ──────────────────────────────────────────────────
// Matches EAN-13 (most retail), UPC-A (US), EAN-8, GTIN-14
const BARCODE_PATTERNS = [
  /\b(\d{13})\b/,   // EAN-13
  /\b(\d{12})\b/,   // UPC-A
  /\b(\d{14})\b/,   // GTIN-14
  /\b(\d{8})\b/,    // EAN-8
];

// ── Category inference from barcode prefix ────────────────────────────────────
// GS1 prefix ranges map to broad product categories
const GS1_CATEGORY_HINTS = {
  "0":  "general_merchandise",
  "3":  "pharma_health",
  "4":  "retail_japan",
  "5":  "general_merchandise",
  "6":  "general_merchandise",
  "7":  "general_merchandise",
  "8":  "general_merchandise",
  "9":  "books_media",
  "97": "books",
  "978": "books_isbn",
  "979": "books_isbn",
};

// ── HTTP fetch helper (no extra deps) ────────────────────────────────────────
function fetchJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    https.get(url, { headers: { "User-Agent": "EvanAI/1.0" } }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── UPC lookup providers (tried in order, first valid result wins) ────────────
async function lookupUPCitemdb(upc) {
  try {
    const data = await fetchJson(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${upc}`,
      4500
    );
    const item = data?.items?.[0];
    if (!item?.title) return null;
    return {
      source:      "upcitemdb",
      upc,
      title:       item.title || null,
      brand:       item.brand || null,
      model:       item.model || null,
      category:    item.category || null,
      description: item.description || null,
      msrp:        finiteOrNull(item.msrp) || finiteOrNull(item.highest_recorded_price),
      lowestPrice: finiteOrNull(item.lowest_recorded_price),
      highestPrice:finiteOrNull(item.highest_recorded_price),
      imageUrl:    item.images?.[0] || null,
      ean:         item.ean || null,
      asin:        item.asin || null,
      dimension:   item.dimension || null,
      weight:      item.weight || null,
      color:       item.color || null,
      size:        item.size || null,
      packageQty:  item.package_quantity || null,
    };
  } catch { return null; }
}

async function lookupOpenFoodFacts(upc) {
  // Only try for food-range barcodes
  try {
    const data = await fetchJson(
      `https://world.openfoodfacts.org/api/v2/product/${upc}.json`,
      4000
    );
    if (data?.status !== 1 || !data?.product?.product_name) return null;
    const p = data.product;
    return {
      source:      "openfoodfacts",
      upc,
      title:       p.product_name || null,
      brand:       p.brands || null,
      model:       null,
      category:    p.categories || null,
      description: p.ingredients_text_en || null,
      msrp:        null,
      imageUrl:    p.image_front_url || null,
    };
  } catch { return null; }
}

// ── Core barcode extraction ───────────────────────────────────────────────────

/**
 * Extract barcode candidates from visible text array.
 */
export function extractBarcodesFromText(visibleTextArray = []) {
  const candidates = new Set();
  const allText = (visibleTextArray || []).join(" ");

  for (const pattern of BARCODE_PATTERNS) {
    const matches = allText.match(new RegExp(pattern.source, "g")) || [];
    for (const m of matches) {
      const digits = m.replace(/\D/g, "");
      if (digits.length >= 8) candidates.add(digits);
    }
  }

  return [...candidates];
}

/**
 * Validate barcode check digit (EAN-13 / UPC-A).
 */
export function validateBarcodeCheckDigit(barcode) {
  const digits = String(barcode).replace(/\D/g, "");
  if (digits.length !== 12 && digits.length !== 13) return false;

  const arr = digits.split("").map(Number);
  const check = arr.pop();
  const sum = arr.reduce((acc, d, i) => acc + (i % 2 === (digits.length === 13 ? 0 : 1) ? d : d * 3), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Look up a barcode across all providers.
 */
export async function lookupBarcode(upc) {
  if (!upc) return null;
  const cleaned = String(upc).replace(/\D/g, "");
  if (cleaned.length < 8) return null;

  // Try primary database first
  let result = await lookupUPCitemdb(cleaned);

  // Fallback to OpenFoodFacts for likely food barcodes
  if (!result && (cleaned.startsWith("0") || cleaned.startsWith("3"))) {
    result = await lookupOpenFoodFacts(cleaned);
  }

  if (!result) return null;

  // Enrich with category hint from prefix
  const prefix3 = cleaned.substring(0, 3);
  const prefix2 = cleaned.substring(0, 2);
  const categoryHint = GS1_CATEGORY_HINTS[prefix3] || GS1_CATEGORY_HINTS[prefix2] || GS1_CATEGORY_HINTS[cleaned[0]] || null;

  return {
    ...result,
    barcodeValid: validateBarcodeCheckDigit(cleaned),
    categoryHint,
  };
}

/**
 * Build resale-oriented market search query from barcode product data.
 */
export function buildBarcodeQuery(product) {
  if (!product) return null;

  const parts = [
    product.brand,
    product.model,
    product.title,
    product.color,
    product.size,
  ].filter(Boolean);

  if (!parts.length) return null;

  // De-duplicate overlapping terms
  const seen = new Set();
  const unique = [];
  for (const part of parts) {
    const words = String(part).toLowerCase().split(/\s+/);
    if (!words.every(w => seen.has(w))) {
      words.forEach(w => seen.add(w));
      unique.push(part);
    }
  }

  return unique.slice(0, 4).join(" ").trim() || null;
}

/**
 * Full barcode intelligence payload builder.
 */
export async function buildBarcodeIntelligencePayload({
  visibleText = [],
  barcode     = null,
  redis       = null,
} = {}) {
  // Collect barcode candidates
  const manualCandidates  = barcode ? [String(barcode).replace(/\D/g, "")] : [];
  const extractedFromText = extractBarcodesFromText(visibleText);
  const allCandidates     = [...new Set([...manualCandidates, ...extractedFromText])];

  if (!allCandidates.length) {
    return { found: false, barcodes: [], product: null, query: null, topSignal: null };
  }

  // Try each candidate, return first successful lookup
  for (const candidate of allCandidates) {
    // Check Redis cache first
    let product = null;
    const cacheKey = `barcode:${candidate}`;

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) product = JSON.parse(cached);
      } catch { /* cache miss */ }
    }

    if (!product) {
      product = await lookupBarcode(candidate);
      if (product && redis) {
        try {
          await redis.set(cacheKey, JSON.stringify(product), "EX", 86400 * 7); // 7 days
        } catch { /* cache write fail — non-fatal */ }
      }
    }

    if (product) {
      const query = buildBarcodeQuery(product);
      return {
        found:      true,
        barcodes:   allCandidates,
        scannedUpc: candidate,
        product,
        query,
        msrp:       product.msrp || null,
        brand:      product.brand || null,
        model:      product.model || null,
        title:      product.title || null,
        topSignal:  product.msrp
          ? `UPC ${candidate}: ${product.brand || ""} ${product.title || ""} — MSRP $${product.msrp}`
          : `UPC ${candidate}: ${product.brand || ""} ${product.title || ""}`.trim(),
      };
    }
  }

  return {
    found:    false,
    barcodes: allCandidates,
    product:  null,
    query:    null,
    topSignal: allCandidates.length
      ? `Barcode detected (${allCandidates[0]}) but no product match found`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
