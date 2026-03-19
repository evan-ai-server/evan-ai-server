// src/dnaMatchEngine.js
// Attribute-level DNA matching: compares two items on silhouette, material,
// color, sole, closure, and function — produces a DNA Match Score (0-100).
// Powers: "This $350 Jordan 1 has a 94% DNA match to this $65 Puma Court."

// ── Attribute taxonomy ────────────────────────────────────────────────────────

// Silhouette families — items in the same family score high
const SILHOUETTE_FAMILIES = {
  court_low:       ["air force 1", "puma clyde", "puma court", "vans old skool", "vans sk8-lo", "converse chuck low", "adidas stan smith", "adidas campus"],
  court_high:      ["air jordan 1", "converse chuck high", "vans sk8-hi", "puma clyde hi", "new balance 574 hi"],
  chunky_runner:   ["new balance 990", "new balance 2002r", "new balance 1906r", "new balance 550", "asics gel-lyte", "saucony jazz", "adidas ozweego", "salehe bembury"],
  slim_runner:     ["nike pegasus", "adidas ultraboost", "on cloudstratus", "hoka clifton", "asics gel-nimbus", "brooks ghost"],
  performance_trail:["hoka speedgoat", "salomon speedcross", "adidas terrex", "nike wildhorse"],
  retro_runner:    ["new balance 574", "asics gel-lyte iii", "saucony shadow", "puma rs-x", "reebok classic"],
  skate_shoe:      ["vans old skool", "vans era", "dc shoes", "emerica", "etnies", "converse cons"],
  sport_high:      ["air jordan 4", "air jordan 3", "nike dunk high", "adidas forum hi"],
  // Eyewear
  aviator:         ["ray-ban aviator", "knockaround aviator", "goodr aviator"],
  wayfarer:        ["ray-ban wayfarer", "knockaround fort knocks", "goodr"],
  sport_wrap:      ["oakley radar", "oakley flak", "knockaround sprinter", "goodr og"],
  // Bags
  structured_tote: ["louis vuitton neverfull", "coach tote", "cuyana tote", "longchamp"],
  belt_bag:        ["gucci belt bag", "coach belt bag", "lululemon everywhere belt"],
  bucket_bag:      ["louis vuitton bucket", "coach bucket", "madewell bucket"],
  // Outerwear
  down_puffer:     ["canada goose", "moncler", "north face nuptse", "columbia puffer"],
  shell_jacket:    ["arc'teryx", "patagonia torrentshell", "outdoor research"],
  // Watches
  dive_watch:      ["rolex submariner", "omega seamaster", "seiko skx", "citizen promaster", "tudor black bay"],
  dress_watch:     ["rolex datejust", "omega constellation", "tag heuer carrera", "hamilton jazzmaster", "tissot le locle"],
};

// Material similarity map
const MATERIAL_SIMILARITY = {
  leather:        ["leather", "genuine leather", "full-grain", "top-grain", "nappa"],
  synthetic:      ["synthetic", "vegan leather", "pleather", "pu leather", "faux leather"],
  canvas:         ["canvas", "cotton canvas", "waxed canvas"],
  mesh:           ["mesh", "knit", "flyknit", "primeknit", "engineered mesh"],
  suede:          ["suede", "nubuck"],
  rubber:         ["rubber", "vulcanized rubber"],
  nylon:          ["nylon", "cordura", "ballistic nylon"],
  down:           ["down", "goose down", "duck down", "800 fill", "600 fill"],
  wool:           ["wool", "merino", "cashmere"],
};

// Color proximity groups
const COLOR_GROUPS = {
  white:   ["white", "cream", "off-white", "ivory", "ecru", "sail"],
  black:   ["black", "jet black", "onyx", "obsidian"],
  grey:    ["grey", "gray", "charcoal", "ash", "silver"],
  navy:    ["navy", "dark blue", "midnight", "indigo"],
  brown:   ["brown", "tan", "camel", "cognac", "tobacco", "chocolate"],
  green:   ["green", "olive", "forest", "sage", "khaki"],
  red:     ["red", "burgundy", "crimson", "maroon", "wine"],
  neutral: ["beige", "sand", "stone", "taupe", "natural"],
};

// ── Attribute extraction ──────────────────────────────────────────────────────

function extractSilhouetteFamily(brand, model) {
  const key = `${brand} ${model}`.toLowerCase();
  for (const [family, members] of Object.entries(SILHOUETTE_FAMILIES)) {
    if (members.some(m => key.includes(m) || m.split(" ").every(t => t.length >= 3 && key.includes(t)))) {
      return family;
    }
  }
  return null;
}

function extractMaterialFamily(materialStr) {
  const m = String(materialStr || "").toLowerCase();
  for (const [family, variants] of Object.entries(MATERIAL_SIMILARITY)) {
    if (variants.some(v => m.includes(v))) return family;
  }
  return null;
}

function extractColorGroup(colorStr) {
  const c = String(colorStr || "").toLowerCase();
  for (const [group, variants] of Object.entries(COLOR_GROUPS)) {
    if (variants.some(v => c.includes(v))) return group;
  }
  return null;
}

// ── DNA scoring ───────────────────────────────────────────────────────────────

const ATTRIBUTE_WEIGHTS = {
  silhouette: 0.35,  // most important — does it look the same?
  material:   0.20,  // same feel/material family
  color:      0.20,  // same colorway cluster
  category:   0.15,  // same product category
  function:   0.10,  // same use case
};

/**
 * Compute DNA match score (0-100) between two item identities.
 */
export function computeDNAMatchScore(itemA = {}, itemB = {}) {
  let score = 0;
  let totalW = 0;

  const add = (weight, match) => {
    score  += match * weight;
    totalW += weight;
  };

  // Silhouette match
  const sfA = extractSilhouetteFamily(itemA?.brand || "", itemA?.model || "");
  const sfB = extractSilhouetteFamily(itemB?.brand || "", itemB?.model || "");
  if (sfA && sfB) {
    add(ATTRIBUTE_WEIGHTS.silhouette, sfA === sfB ? 1.0 : 0.0);
  } else {
    // Partial: brand+model token overlap
    const tokensA = `${itemA?.brand || ""} ${itemA?.model || ""}`.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    const tokensB = `${itemB?.brand || ""} ${itemB?.model || ""}`.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    const overlap  = tokensA.filter(t => tokensB.includes(t)).length;
    const maxLen   = Math.max(tokensA.length, tokensB.length, 1);
    add(ATTRIBUTE_WEIGHTS.silhouette, overlap / maxLen);
  }

  // Material match
  const matA = extractMaterialFamily(itemA?.material || itemA?.materials || "");
  const matB = extractMaterialFamily(itemB?.material || itemB?.materials || "");
  if (matA && matB) {
    add(ATTRIBUTE_WEIGHTS.material, matA === matB ? 1.0 : 0.3);
  } else {
    add(ATTRIBUTE_WEIGHTS.material, 0.5); // unknown — neutral
  }

  // Color match
  const colA = extractColorGroup(itemA?.color || itemA?.colorway || "");
  const colB = extractColorGroup(itemB?.color || itemB?.colorway || "");
  if (colA && colB) {
    add(ATTRIBUTE_WEIGHTS.color, colA === colB ? 1.0 : 0.1);
  } else {
    add(ATTRIBUTE_WEIGHTS.color, 0.5);
  }

  // Category match
  const catA = String(itemA?.category || "").toLowerCase().replace(/s$/, "");
  const catB = String(itemB?.category || "").toLowerCase().replace(/s$/, "");
  if (catA && catB) {
    add(ATTRIBUTE_WEIGHTS.category, catA === catB ? 1.0 : 0.0);
  }

  // Function/use-case match (inferred from category+silhouette)
  // Same silhouette family = same function
  if (sfA && sfB) {
    add(ATTRIBUTE_WEIGHTS.function, sfA === sfB ? 1.0 : 0.2);
  }

  const raw = totalW > 0 ? score / totalW : 0;
  return Math.round(clamp01(raw) * 100);
}

/**
 * Given a primary item and a list of candidate substitutes,
 * score and rank each by DNA match + price savings.
 */
export function rankDNASubstitutes(primaryItem = {}, candidates = [], primaryPrice = null) {
  const primary   = finiteOrNull(primaryPrice);

  const scored = candidates
    .map(candidate => {
      const dnaScore   = computeDNAMatchScore(primaryItem, candidate);
      const candPrice  = finiteOrNull(candidate?.totalPrice ?? candidate?.price ?? candidate?.priceNum);
      const savings    = primary && candPrice ? round2(primary - candPrice) : null;
      const savingsPct = primary && candPrice && primary > 0
        ? round2(((primary - candPrice) / primary) * 100)
        : null;

      // Combined score: DNA match weighted with savings signal
      const savingsBonus = savingsPct !== null && savingsPct > 0
        ? Math.min(0.20, savingsPct / 500) // up to +20 pts for 100% savings
        : 0;

      return {
        candidate,
        dnaScore,
        combinedScore: Math.min(100, dnaScore + Math.round(savingsBonus * 100)),
        candPrice,
        savings,
        savingsPct,
        label: dnaScore >= 90 ? "Near-identical"
             : dnaScore >= 75 ? "Very similar look"
             : dnaScore >= 60 ? "Similar silhouette"
             : dnaScore >= 40 ? "Same category"
             : "Different",
      };
    })
    .filter(r => r.dnaScore >= 40) // filter out low matches
    .sort((a, b) => b.combinedScore - a.combinedScore);

  const best = scored[0] || null;

  return {
    matches: scored.slice(0, 5),
    bestMatch: best || null,
    topSignal: best && best.savings !== null && best.savings > 0
      ? `${best.label} match (${best.dnaScore}/100 DNA) found at $${best.candPrice?.toFixed(2)} — save $${best.savings.toFixed(2)} (${best.savingsPct?.toFixed(0)}%)`
      : best
      ? `Best DNA match: ${best.dnaScore}/100 — ${best.label}`
      : null,
  };
}

/**
 * Build the full DNA substitute intel payload.
 */
export function buildDNAMatchPayload({
  primaryItem    = {},
  primaryPrice   = null,
  candidates     = [], // from uiItems or a known substitute list
  scannedPrice   = null,
} = {}) {
  const effectivePrice = finiteOrNull(primaryPrice) || finiteOrNull(scannedPrice);
  const ranked         = rankDNASubstitutes(primaryItem, candidates, effectivePrice);

  const silhouetteFamily = extractSilhouetteFamily(
    primaryItem?.brand || "",
    primaryItem?.model || ""
  );

  return {
    silhouetteFamily:  silhouetteFamily || null,
    primaryDNA: {
      silhouette: silhouetteFamily,
      material:   extractMaterialFamily(primaryItem?.material || ""),
      color:      extractColorGroup(primaryItem?.color || primaryItem?.colorway || ""),
      category:   String(primaryItem?.category || "").toLowerCase().replace(/s$/, "") || null,
    },
    ...ranked,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
