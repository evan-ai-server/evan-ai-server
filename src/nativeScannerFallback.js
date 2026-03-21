// src/nativeScannerFallback.js
// Non-LLM native scanner fallback.
// When GPT-4.1 vision is weak, broad, or uncertain, this system
// uses heuristic rules, visible text analysis, color/material cues,
// and category pattern matching to produce a usable identity + query.
// This is what makes Evan AI win even when the AI is wrong.

// ── Text extraction helpers ───────────────────────────────────────────────────
function norm(s) {
  return String(s || "").toLowerCase().trim();
}

function cleanTokens(s) {
  return norm(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 1);
}

// ── Known brand name registry (from visible text OCR) ────────────────────────
const BRAND_REGISTRY = [
  // Sneakers
  { name: "Nike", tokens: ["nike", "swoosh", "air", "just do it"], category: "sneakers" },
  { name: "Adidas", tokens: ["adidas", "three stripes", "trefoil", "boost"], category: "sneakers" },
  { name: "Jordan", tokens: ["jordan", "jumpman", "air jordan"], category: "sneakers" },
  { name: "New Balance", tokens: ["new balance", "nb", "574", "990", "2002r", "550"], category: "sneakers" },
  { name: "Vans", tokens: ["vans", "off the wall", "waffle"], category: "sneakers" },
  { name: "Converse", tokens: ["converse", "chuck taylor", "all star", "chuck 70"], category: "sneakers" },
  { name: "Yeezy", tokens: ["yeezy", "kanye", "350", "700", "500"], category: "sneakers" },
  { name: "Puma", tokens: ["puma", "puma cat"], category: "sneakers" },
  // Eyewear
  { name: "Ray-Ban", tokens: ["ray-ban", "rayban", "rb", "wayfarer", "clubmaster", "aviator rb"], category: "eyewear" },
  { name: "Oakley", tokens: ["oakley", "prizm", "unobtainium"], category: "eyewear" },
  { name: "Gucci", tokens: ["gucci", "gg"], category: "eyewear" },
  // Tech
  { name: "Apple", tokens: ["apple", "iphone", "ipad", "macbook", "airpods", "designed by apple"], category: "electronics" },
  { name: "Samsung", tokens: ["samsung", "galaxy", "ssd"], category: "electronics" },
  { name: "Sony", tokens: ["sony", "wh-1000", "wf-1000"], category: "audio" },
  { name: "Bose", tokens: ["bose", "quietcomfort", "soundlink"], category: "audio" },
  // Streetwear
  { name: "Supreme", tokens: ["supreme", "box logo", "bogo"], category: "streetwear" },
  { name: "The North Face", tokens: ["north face", "tnf", "nuptse", "fleece north"], category: "outerwear" },
  { name: "Patagonia", tokens: ["patagonia", "torrentshell", "synchilla", "better sweater"], category: "outerwear" },
  { name: "Canada Goose", tokens: ["canada goose", "expedition parka"], category: "outerwear" },
  // Bags
  { name: "Louis Vuitton", tokens: ["louis vuitton", "lv", "neverfull", "speedy", "monogram lv"], category: "bags" },
  { name: "Gucci", tokens: ["gucci", "gg marmont", "dionysus"], category: "bags" },
  { name: "Coach", tokens: ["coach", "coach new york"], category: "bags" },
  // Watches
  { name: "Rolex", tokens: ["rolex", "submariner", "datejust", "day-date", "oyster"], category: "watches" },
  { name: "Seiko", tokens: ["seiko", "skx", "srpd", "prospex", "presage"], category: "watches" },
  { name: "Casio", tokens: ["casio", "g-shock", "gw-m", "f91w", "ae-1200"], category: "watches" },
];

// ── Color vocabulary ──────────────────────────────────────────────────────────
const COLOR_TERMS = [
  "black", "white", "red", "blue", "green", "yellow", "orange", "purple",
  "pink", "brown", "grey", "gray", "silver", "gold", "cream", "beige",
  "navy", "olive", "tan", "khaki", "teal", "maroon", "burgundy", "coral",
  "mint", "lavender", "cobalt", "forest", "charcoal", "ivory", "nude",
  "multicolor", "colorblock", "tie-dye", "camo", "camouflage",
];

// ── Material vocabulary ───────────────────────────────────────────────────────
const MATERIAL_TERMS = [
  "leather", "suede", "canvas", "mesh", "knit", "woven", "nylon", "polyester",
  "cotton", "denim", "velvet", "satin", "silk", "wool", "fleece", "down",
  "rubber", "plastic", "metal", "stainless", "titanium", "aluminum", "carbon",
  "acetate", "tortoise", "crystal",
];

// ── Shape/style vocabulary ────────────────────────────────────────────────────
const SHAPE_TERMS = {
  eyewear: ["wayfarer", "aviator", "round", "oval", "square", "rectangle", "cat-eye", "shield", "wraparound", "oversized", "rimless", "semi-rimless"],
  sneakers: ["low top", "high top", "mid top", "slip on", "platform", "chunky", "runner", "court", "skate", "trail"],
  bags: ["tote", "shoulder", "crossbody", "backpack", "clutch", "satchel", "hobo", "bucket", "mini", "oversized"],
};

// ── Extract colors from text array ───────────────────────────────────────────
export function extractColorsFromText(texts = []) {
  const combined = texts.map(norm).join(" ");
  return COLOR_TERMS.filter(c => combined.includes(c)).slice(0, 4);
}

// ── Extract materials from text array ────────────────────────────────────────
export function extractMaterialsFromText(texts = []) {
  const combined = texts.map(norm).join(" ");
  return MATERIAL_TERMS.filter(m => combined.includes(m)).slice(0, 3);
}

// ── Detect brand from visible text ───────────────────────────────────────────
export function detectBrandFromVisibleText(visibleText = []) {
  const combined = visibleText.map(norm).join(" ");
  const tokens = cleanTokens(combined);

  for (const entry of BRAND_REGISTRY) {
    for (const token of entry.tokens) {
      if (combined.includes(token)) {
        return { name: entry.name, category: entry.category, confidence: 0.85, matchedOn: token };
      }
    }
  }

  return null;
}

// ── Detect category from visual cues ─────────────────────────────────────────
export function detectCategoryFromCues({ colors = [], materials = [], styleWords = [], visibleText = [] }) {
  const combined = [...colors, ...materials, ...styleWords, ...visibleText].map(norm).join(" ");

  // Eyewear cues
  if (/lens|frame|temple|bridge|nose pad|uv|polarized|sunglass|glass/.test(combined)) return "eyewear";
  // Sneaker cues
  if (/sole|lace|toe box|heel tab|midsole|outsole|sneaker|shoe|kick/.test(combined)) return "sneakers";
  // Watch cues
  if (/dial|crown|bezel|bracelet|strap|case|movement|crystal|lug|chronograph/.test(combined)) return "watches";
  // Bag cues
  if (/strap|zipper|lining|pocket|handle|clasp|buckle|bag|tote|purse/.test(combined)) return "bags";
  // Audio cues
  if (/driver|anc|noise cancel|wireless|bluetooth|earbud|headphone|speaker/.test(combined)) return "audio";
  // Tech cues
  if (/usb|charging|battery|screen|display|port|keyboard|touchpad/.test(combined)) return "electronics";

  return null;
}

// ── Build fallback query from heuristics ─────────────────────────────────────
export function buildFallbackQuery({ identity = {}, visibleText = [] }) {
  const brand = identity?.brand || null;
  const model = identity?.model || null;
  const category = identity?.category || null;
  const itemType = identity?.itemType || null;
  const colors = extractColorsFromText([
    ...(identity?.colors || []),
    ...visibleText,
  ]);
  const materials = extractMaterialsFromText([
    ...(identity?.materials || []),
    ...visibleText,
  ]);

  // 1. Best case: brand + model
  if (brand && model) return `${brand} ${model}`.trim();

  // 2. Brand + category/itemType
  if (brand && (category || itemType)) return `${brand} ${category || itemType}`.trim();

  // 3. Brand + color
  if (brand && colors.length) return `${brand} ${colors[0]}`.trim();

  // 4. Brand alone (+ detected from visible text)
  const detectedBrand = detectBrandFromVisibleText(visibleText);
  if (detectedBrand && (category || itemType)) return `${detectedBrand.name} ${category || itemType}`.trim();
  if (detectedBrand) return detectedBrand.name;

  // 5. Color + material + category
  if (colors.length && materials.length && (category || itemType)) {
    return `${colors[0]} ${materials[0]} ${category || itemType}`.trim();
  }

  // 6. Color + category
  if (colors.length && (category || itemType)) return `${colors[0]} ${category || itemType}`.trim();

  // 7. Category alone
  if (category || itemType) return (category || itemType).trim();

  return null;
}

// ── Main export: run full native scanner on vision output ─────────────────────
export function runNativeScannerFallback({
  identity = {},
  visibleText = [],
  visionQuery = null,
  visionConfidence = 0.5,
}) {
  // If vision is already confident and specific, don't override
  if (visionConfidence > 0.75 && visionQuery && visionQuery.split(" ").length >= 3) {
    return {
      usedFallback: false,
      query: visionQuery,
      confidence: visionConfidence,
      identity,
    };
  }

  // Extract signals from all available text
  const allText = [
    ...(identity?.visibleText || []),
    ...(identity?.styleWords || []),
    ...visibleText,
  ];

  const extractedColors = extractColorsFromText(allText);
  const extractedMaterials = extractMaterialsFromText(allText);
  const detectedBrand = detectBrandFromVisibleText(allText);
  const detectedCategory = detectCategoryFromCues({
    colors: extractedColors,
    materials: extractedMaterials,
    styleWords: identity?.styleWords || [],
    visibleText: allText,
  });

  // Build enriched identity
  const enrichedIdentity = {
    ...identity,
    colors: [...new Set([...(identity?.colors || []), ...extractedColors])].slice(0, 4),
    materials: [...new Set([...(identity?.materials || []), ...extractedMaterials])].slice(0, 3),
    brand: identity?.brand || detectedBrand?.name || null,
    category: identity?.category || detectedCategory || null,
  };

  const fallbackQuery = buildFallbackQuery({
    identity: enrichedIdentity,
    visibleText: allText,
  });

  // Determine if fallback is genuinely better
  const fallbackIsBetter =
    fallbackQuery &&
    fallbackQuery.split(" ").length >= (visionQuery ? visionQuery.split(" ").length : 0) &&
    (visionConfidence < 0.5 || !visionQuery);

  const finalQuery = fallbackIsBetter ? fallbackQuery : (visionQuery || fallbackQuery);
  const finalConfidence = detectedBrand
    ? Math.max(visionConfidence, 0.6)
    : visionConfidence;

  return {
    usedFallback: fallbackIsBetter,
    query: finalQuery,
    confidence: Math.min(finalConfidence, 0.85), // native scanner caps at 0.85
    identity: enrichedIdentity,
    detectedBrand: detectedBrand?.name || null,
    detectedCategory,
    extractedColors,
    extractedMaterials,
  };
}
