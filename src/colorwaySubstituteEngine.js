// src/colorwaySubstituteEngine.js
// Color palette DNA: extracts the actual color story from an item and finds
// items with the same palette at a fraction of the price.
// "Same red/white/black story, 91% color match, $270 cheaper."

// ── Color palette registry ────────────────────────────────────────────────────
// Named palettes: { primary, secondary, accent }
const NAMED_PALETTES = {
  // Sneaker classics
  "chicago":           { primary: "red",    secondary: "white",  accent: "black",  label: "Chicago OG" },
  "bred":              { primary: "black",  secondary: "red",    accent: "white",  label: "Bred" },
  "royal":             { primary: "blue",   secondary: "white",  accent: "black",  label: "Royal Blue" },
  "shadow":            { primary: "grey",   secondary: "black",  accent: "white",  label: "Shadow Grey" },
  "university blue":   { primary: "blue",   secondary: "white",  accent: null,     label: "University Blue" },
  "panda":             { primary: "white",  secondary: "black",  accent: null,     label: "Panda" },
  "syracuse":          { primary: "orange", secondary: "white",  accent: null,     label: "Syracuse Orange" },
  "michigan":          { primary: "yellow", secondary: "navy",   accent: null,     label: "Michigan" },
  "mocha":             { primary: "brown",  secondary: "white",  accent: "tan",    label: "Mocha" },
  "travis scott":      { primary: "brown",  secondary: "black",  accent: "orange", label: "Travis Scott" },
  "unc":               { primary: "blue",   secondary: "white",  accent: null,     label: "UNC Blue" },
  "zebra":             { primary: "white",  secondary: "black",  accent: null,     label: "Zebra" },
  "cream":             { primary: "cream",  secondary: "white",  accent: null,     label: "Cream/Triple White" },
  "triple black":      { primary: "black",  secondary: "black",  accent: "black",  label: "Triple Black" },
  "triple white":      { primary: "white",  secondary: "white",  accent: "white",  label: "Triple White" },
  "volt":              { primary: "yellow", secondary: "black",  accent: null,     label: "Volt/Neon Yellow" },
  "infrared":          { primary: "black",  secondary: "red",    accent: "white",  label: "Infrared" },
  "sea salt":          { primary: "cream",  secondary: "grey",   accent: "tan",    label: "Sea Salt Neutral" },
  "steel blue":        { primary: "blue",   secondary: "grey",   accent: "white",  label: "Steel Blue" },
  "olive":             { primary: "olive",  secondary: "brown",  accent: null,     label: "Olive/Earth Tone" },
};

// Palette similarity: color groups that match well with each other
const COLOR_PROXIMITY = {
  white:  ["white", "cream", "ivory", "off-white", "sail"],
  black:  ["black", "obsidian", "onyx"],
  grey:   ["grey", "gray", "charcoal", "ash", "silver", "shadow"],
  red:    ["red", "crimson", "scarlet", "varsity red"],
  blue:   ["blue", "royal", "navy", "university blue", "unc"],
  brown:  ["brown", "tan", "mocha", "caramel", "cognac", "tobacco"],
  green:  ["green", "olive", "forest", "sage", "khaki"],
  yellow: ["yellow", "volt", "gold", "lemon", "canary", "michigan"],
  orange: ["orange", "syracuse", "burnt orange"],
  cream:  ["cream", "sea salt", "natural", "beige", "sand"],
};

// Palette-to-budget-alternatives: same color story, different brand
const PALETTE_ALTERNATIVES = {
  "chicago": [
    { brand: "puma",          model: "Clyde Court",      query: "puma clyde court red white",      priceEst: [60, 90] },
    { brand: "vans",          model: "Old Skool OTW",    query: "vans old skool red white black",  priceEst: [55, 75] },
    { brand: "converse",      model: "Chuck 70 Hi",      query: "converse chuck 70 red white",     priceEst: [65, 85] },
  ],
  "bred": [
    { brand: "puma",          model: "RS-X",             query: "puma rs-x black red",             priceEst: [65, 90] },
    { brand: "new balance",   model: "9060",             query: "new balance 9060 black red",      priceEst: [100, 130] },
    { brand: "reebok",        model: "Classic Leather",  query: "reebok classic black red",        priceEst: [55, 75] },
  ],
  "panda": [
    { brand: "vans",          model: "Old Skool",        query: "vans old skool white black",      priceEst: [55, 70] },
    { brand: "converse",      model: "Chuck Taylor Low", query: "converse chuck taylor white black",priceEst: [45, 65] },
    { brand: "adidas",        model: "Stan Smith",       query: "adidas stan smith white black",   priceEst: [60, 85] },
  ],
  "royal": [
    { brand: "vans",          model: "Authentic",        query: "vans authentic royal blue white", priceEst: [45, 65] },
    { brand: "new balance",   model: "327",              query: "new balance 327 blue white",      priceEst: [80, 100] },
    { brand: "asics",         model: "Gel-Lyte III",     query: "asics gel-lyte iii blue white",   priceEst: [70, 95] },
  ],
  "university blue": [
    { brand: "new balance",   model: "327",              query: "new balance 327 light blue",      priceEst: [80, 100] },
    { brand: "asics",         model: "Gel-1130",         query: "asics gel 1130 light blue white", priceEst: [70, 90] },
    { brand: "vans",          model: "Authentic",        query: "vans authentic powder blue",      priceEst: [45, 60] },
  ],
  "shadow": [
    { brand: "new balance",   model: "990v3",            query: "new balance 990v3 grey",          priceEst: [160, 185] },
    { brand: "asics",         model: "Gel-Lyte V",       query: "asics gel-lyte v grey",           priceEst: [75, 100] },
    { brand: "saucony",       model: "Jazz Original",    query: "saucony jazz grey silver",        priceEst: [60, 80] },
  ],
  "triple white": [
    { brand: "vans",          model: "Slip-On",          query: "vans slip-on all white",          priceEst: [45, 60] },
    { brand: "converse",      model: "Chuck Taylor Low", query: "converse chuck low white",        priceEst: [50, 65] },
    { brand: "adidas",        model: "Stan Smith",       query: "adidas stan smith triple white",  priceEst: [60, 80] },
  ],
  "olive": [
    { brand: "new balance",   model: "574",              query: "new balance 574 olive green",     priceEst: [70, 90] },
    { brand: "vans",          model: "Old Skool",        query: "vans old skool olive",            priceEst: [55, 70] },
    { brand: "saucony",       model: "Grid 9000",        query: "saucony grid 9000 olive",         priceEst: [80, 100] },
  ],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Extract the color palette from an item identity.
 */
export function extractColorPalette(identity = {}) {
  const colorStr  = String(identity?.color || identity?.colorway || identity?.model || "").toLowerCase();

  // Check named palettes first
  for (const [key, palette] of Object.entries(NAMED_PALETTES)) {
    if (colorStr.includes(key)) {
      return { matched: true, paletteKey: key, ...palette };
    }
  }

  // Fallback: extract raw color tokens
  const allColors = Object.values(COLOR_PROXIMITY).flat();
  const found     = allColors.filter(c => colorStr.includes(c));
  if (found.length >= 2) {
    return {
      matched:   false,
      paletteKey: null,
      primary:   found[0],
      secondary: found[1],
      accent:    found[2] || null,
      label:     `${found[0]}/${found[1]}`,
    };
  }
  if (found.length === 1) {
    return { matched: false, paletteKey: null, primary: found[0], secondary: null, accent: null, label: found[0] };
  }

  return { matched: false, paletteKey: null, primary: null, secondary: null, accent: null, label: null };
}

/**
 * Compute color palette similarity score between two palettes (0–100).
 */
export function colorPaletteSimilarity(paletteA = {}, paletteB = {}) {
  const normalize = (c) => {
    if (!c) return null;
    const cl = String(c).toLowerCase();
    for (const [group, variants] of Object.entries(COLOR_PROXIMITY)) {
      if (variants.some(v => cl.includes(v))) return group;
    }
    return cl;
  };

  const pA = normalize(paletteA.primary);
  const sA = normalize(paletteA.secondary);
  const aA = normalize(paletteA.accent);
  const pB = normalize(paletteB.primary);
  const sB = normalize(paletteB.secondary);
  const aB = normalize(paletteB.accent);

  let score  = 0;
  let totalW = 0;

  const check = (a, b, weight) => {
    totalW += weight;
    if (a && b && a === b) score += weight;
    else if (a && b)        score += weight * 0.10;
  };

  check(pA, pB, 0.50);
  check(sA, sB, 0.30);
  check(aA, aB, 0.20);

  return Math.round((totalW > 0 ? score / totalW : 0) * 100);
}

/**
 * Find palette-matching cheaper alternatives.
 */
export function findColorwaySubstitutes(identity = {}, scannedPrice = null) {
  const palette  = extractColorPalette(identity);
  if (!palette.paletteKey) return null;

  const alts = PALETTE_ALTERNATIVES[palette.paletteKey];
  if (!alts || !alts.length) return null;

  const scanned = finiteOrNull(scannedPrice);

  const results = alts.map(alt => {
    const midEst   = round2((alt.priceEst[0] + alt.priceEst[1]) / 2);
    const savings  = scanned ? round2(scanned - midEst) : null;
    const savPct   = scanned ? round2((savings / scanned) * 100) : null;
    return {
      ...alt,
      estimatedPrice: midEst,
      savings,
      savingsPct: savPct,
      colorMatchScore: 92, // same palette = very high match
    };
  }).sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0));

  const best = results[0];

  return {
    found:       true,
    paletteKey:  palette.paletteKey,
    paletteLabel:palette.label,
    alternatives: results,
    bestAlt:     best,
    topSignal:   best && best.savings !== null && best.savings > 0
      ? `Same ${palette.label} color story → ${best.brand} ${best.model} at ~$${best.estimatedPrice} saves ~$${best.savings.toFixed(0)} (${best.savingsPct?.toFixed(0)}%)`
      : `Same ${palette.label} palette available: ${best?.brand} ${best?.model} at ~$${best?.estimatedPrice}`,
  };
}

/**
 * Master colorway substitute payload.
 */
export function buildColorwaySubstitutePayload({
  identity     = {},
  scannedPrice = null,
  uiItems      = [],
} = {}) {
  const palette     = extractColorPalette(identity);
  const substitutes = findColorwaySubstitutes(identity, scannedPrice);

  // Also score uiItems for palette similarity
  const itemPaletteScores = uiItems
    .map(item => {
      const itemPalette = extractColorPalette({
        color:    item?.color || "",
        colorway: item?.colorway || item?.title || "",
      });
      const sim = colorPaletteSimilarity(palette, itemPalette);
      return { item, sim };
    })
    .filter(r => r.sim >= 70)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 5);

  return {
    palette,
    substitutes:         substitutes       || null,
    similarColorItems:   itemPaletteScores,
    topSignal:           substitutes?.topSignal || null,
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
