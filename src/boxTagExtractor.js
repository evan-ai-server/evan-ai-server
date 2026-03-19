// src/boxTagExtractor.js
// Box Tag / Label Extractor — Feature 65
// Dedicated structured extraction for product box labels, hang tags,
// and care labels. Extracts: brand, model, colorway name, style/SKU code,
// size, MSRP, colorway code, materials, country of origin.
// Feeds directly into query building and price target anchoring.
// "Style 555088-061 → Air Jordan 1 Retro High OG Black Toe → exact comps."

// ── SKU/Style code patterns per category ─────────────────────────────────────
const SKU_PATTERNS = {
  // Nike/Jordan: CT8012-101 or 555088-061
  nike:         /\b([A-Z]{1,3}\d{4,6}[-–]\d{3})\b/gi,
  // Adidas: H04954 or GW2868
  adidas:       /\b([A-Z]{2}\d{4,5})\b/g,
  // New Balance: M990GL6
  new_balance:  /\b([A-Z]\d{3,4}[A-Z]{2,4}\d?)\b/g,
  // Rolex reference: 126610LN
  rolex:        /\b(\d{5,6}[A-Z]{0,4})\b/g,
  // Generic style code
  generic:      /\b(style|sku|item|ref|no\.?|#)\s*:?\s*([A-Z0-9\-]{5,16})\b/gi,
};

// ── Colorway patterns ────────────────────────────────────────────────────────
const COLORWAY_LABEL_PATTERNS = [
  /colorway[:\s]+([A-Za-z0-9\/\- ]+)/i,
  /color[:\s]+([A-Za-z0-9\/\- ]+)/i,
  /\b([A-Za-z]+\/[A-Za-z]+\/[A-Za-z]+)\b/, // e.g. Black/White/Red
  /\b([A-Za-z]+-[A-Za-z]+)\b/,             // e.g. Bred, Chicago-OG
];

// ── Size patterns ─────────────────────────────────────────────────────────────
const SIZE_PATTERNS = [
  /\bsize[:\s]+(\d{1,2}\.?\d{0,1})\b/i,
  /\bUS\s*(\d{1,2}\.?\d?)\b/i,
  /\bEU\s*(\d{2,3})\b/i,
  /\bUK\s*(\d{1,2}\.?\d?)\b/i,
  /\b(\d{1,2}\.5)\b/,    // half sizes like 10.5
  /\b(XXS|XS|S|M|L|XL|XXL|3XL)\b/i,
];

// ── MSRP / price on tag ───────────────────────────────────────────────────────
const PRICE_PATTERNS = [
  /MSRP[:\s]+\$?([\d,]+\.?\d*)/i,
  /retail[:\s]+\$?([\d,]+\.?\d*)/i,
  /price[:\s]+\$?([\d,]+\.?\d*)/i,
  /\$\s*([\d,]+\.?\d{2})\b/,
];

// ── Country of origin ─────────────────────────────────────────────────────────
const ORIGIN_PATTERNS = [
  /made in ([A-Za-z ]+)/i,
  /manufactured in ([A-Za-z ]+)/i,
  /country of origin[:\s]+([A-Za-z ]+)/i,
];

// ── Core extraction from text array ──────────────────────────────────────────

/**
 * Extract structured data from an array of visible text strings.
 * This is run on the visibleText[] output from the box_tag vision pass.
 */
export function extractBoxTagData(visibleTextArray = [], knownBrand = null) {
  const allText = (visibleTextArray || []).join(" ");
  const brand   = (knownBrand || "").toLowerCase();

  // ── SKU/Style code extraction ───────────────────────────────────────────
  let styleCode = null;

  // Brand-specific first
  if (brand.includes("nike") || brand.includes("jordan") || brand.includes("air")) {
    const m = allText.match(SKU_PATTERNS.nike);
    if (m) styleCode = m[0].toUpperCase();
  } else if (brand.includes("adidas") || brand.includes("yeezy")) {
    const m = allText.match(SKU_PATTERNS.adidas);
    if (m) styleCode = m[0].toUpperCase();
  } else if (brand.includes("new balance")) {
    const m = allText.match(SKU_PATTERNS.new_balance);
    if (m) styleCode = m[0].toUpperCase();
  }

  // Generic fallback
  if (!styleCode) {
    const genericMatch = SKU_PATTERNS.generic.exec(allText);
    SKU_PATTERNS.generic.lastIndex = 0;
    if (genericMatch) styleCode = genericMatch[2]?.toUpperCase() || null;
  }

  // ── Colorway ───────────────────────────────────────────────────────────
  let colorway = null;
  for (const pattern of COLORWAY_LABEL_PATTERNS) {
    const m = allText.match(pattern);
    if (m) {
      colorway = m[1]?.trim() || null;
      if (colorway && colorway.length > 2) break;
    }
  }

  // ── Size ──────────────────────────────────────────────────────────────
  let size = null;
  for (const pattern of SIZE_PATTERNS) {
    const m = allText.match(pattern);
    if (m) {
      size = m[1]?.trim() || null;
      if (size) break;
    }
  }

  // ── MSRP ──────────────────────────────────────────────────────────────
  let msrp = null;
  for (const pattern of PRICE_PATTERNS) {
    const m = allText.match(pattern);
    if (m) {
      const parsed = parseFloat(m[1]?.replace(/,/g, ""));
      if (Number.isFinite(parsed) && parsed > 0) {
        msrp = parsed;
        break;
      }
    }
  }

  // ── Country of origin ────────────────────────────────────────────────
  let countryOfOrigin = null;
  for (const pattern of ORIGIN_PATTERNS) {
    const m = allText.match(pattern);
    if (m) {
      countryOfOrigin = m[1]?.trim().replace(/[^A-Za-z ]/g, "").trim() || null;
      if (countryOfOrigin) break;
    }
  }

  // ── Materials from care label ────────────────────────────────────────
  const materialKeywords = ["cotton", "polyester", "nylon", "leather", "suede", "canvas",
    "rubber", "wool", "silk", "linen", "mesh", "foam", "synthetic", "genuine leather",
    "full grain", "patent leather", "satin", "velvet", "denim", "fleece", "gore-tex",
    "primeknit", "flyknit", "boost", "air max", "lunarlon"];
  const foundMaterials = materialKeywords.filter(m => allText.toLowerCase().includes(m));

  // ── Authenticity cues from label ──────────────────────────────────────
  const authCues = [];
  if (/made in (usa|italy|france|japan|spain|england)/i.test(allText)) authCues.push("premium_origin");
  if (/genuine leather|real leather|full grain/i.test(allText)) authCues.push("genuine_leather_claim");
  if (/hand(made|crafted|stitched)/i.test(allText)) authCues.push("handmade_claim");

  return {
    styleCode:       styleCode || null,
    colorway:        colorway || null,
    size:            size || null,
    msrp:            msrp || null,
    countryOfOrigin: countryOfOrigin || null,
    materials:       foundMaterials,
    authCues,
    rawText:         allText.substring(0, 500),
  };
}

/**
 * Build an enhanced search query incorporating box tag data.
 * This is more precise than vision-only queries.
 */
export function buildBoxTagEnhancedQuery(baseQuery, boxData, identity = {}) {
  if (!boxData) return baseQuery;

  const parts = [];

  // Add brand if not already in base query
  const brandLower = (identity.brand || "").toLowerCase();
  const baseLower  = (baseQuery || "").toLowerCase();
  if (brandLower && !baseLower.includes(brandLower)) parts.push(identity.brand);

  // Add model
  if (identity.model && !baseLower.includes(identity.model.toLowerCase())) parts.push(identity.model);

  // Add colorway name if extracted
  if (boxData.colorway && !baseLower.includes(boxData.colorway.toLowerCase())) {
    parts.push(boxData.colorway);
  }

  // Add style code for exact matching
  if (boxData.styleCode) parts.push(boxData.styleCode);

  const enhanced = [baseQuery, ...parts].filter(Boolean).join(" ").trim();
  return enhanced || baseQuery;
}

/**
 * Master payload builder.
 */
export function buildBoxTagPayload({ visibleText = [], identity = {}, query = null } = {}) {
  const extracted = extractBoxTagData(visibleText, identity?.brand);
  const enhancedQuery = buildBoxTagEnhancedQuery(query, extracted, identity);

  const hasData = !!(extracted.styleCode || extracted.colorway || extracted.size || extracted.msrp);

  return {
    boxTag:        extracted,
    enhancedQuery: hasData ? enhancedQuery : null,
    hasBoxData:    hasData,
    topSignal: hasData
      ? [
          extracted.styleCode ? `SKU: ${extracted.styleCode}` : null,
          extracted.colorway  ? `Colorway: ${extracted.colorway}` : null,
          extracted.size      ? `Size: ${extracted.size}` : null,
          extracted.msrp      ? `MSRP: $${extracted.msrp}` : null,
        ].filter(Boolean).join(" · ")
      : null,
  };
}
