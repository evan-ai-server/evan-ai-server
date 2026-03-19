// src/itemConditionForensics.js
// Damage forensics: maps specific damage types from visible text to precise
// resale impact per category. Generates buyer negotiation and seller disclosure scripts.

// ── Damage signature registry ─────────────────────────────────────────────────
// Each entry: damage keyword patterns → { label, resaleImpactPct, categories, severity }
const DAMAGE_SIGNATURES = [
  // ── Sneaker-specific ──
  { patterns: ["toe box crease", "toebox crease", "heavy crease"],
    label: "Toe box creasing",         resaleImpactPct: { sneakers: 15, default: 10 }, severity: "moderate", categories: ["sneakers"] },
  { patterns: ["yellowing", "yellow sole", "midsole yellow", "oxidation"],
    label: "Sole yellowing / oxidation", resaleImpactPct: { sneakers: 25, default: 15 }, severity: "high", categories: ["sneakers"] },
  { patterns: ["cracking", "sole crack", "outsole crack", "midsole crack"],
    label: "Sole cracking",            resaleImpactPct: { sneakers: 35, apparel: 20, default: 25 }, severity: "high", categories: ["sneakers"] },
  { patterns: ["scuff", "scuffed", "scuff mark", "scuff on toe"],
    label: "Scuff marks",              resaleImpactPct: { sneakers: 12, bag: 15, watch: 10, default: 10 }, severity: "low" },
  { patterns: ["paint chipping", "paint chip", "paint loss", "chipped paint"],
    label: "Paint chipping",           resaleImpactPct: { sneakers: 20, default: 15 }, severity: "moderate", categories: ["sneakers"] },
  { patterns: ["glue separation", "sole separation", "delamination"],
    label: "Sole separation / delamination", resaleImpactPct: { sneakers: 40, default: 30 }, severity: "critical", categories: ["sneakers"] },
  { patterns: ["sole wear", "worn sole", "worn down"],
    label: "Significant sole wear",    resaleImpactPct: { sneakers: 18, default: 12 }, severity: "moderate" },
  { patterns: ["lace hole", "lace hole damage", "torn lace hole"],
    label: "Lace hole damage",         resaleImpactPct: { sneakers: 8, default: 5 }, severity: "low", categories: ["sneakers"] },

  // ── Apparel-specific ──
  { patterns: ["pilling", "fabric pilling", "pills"],
    label: "Fabric pilling",           resaleImpactPct: { apparel: 20, default: 15 }, severity: "moderate", categories: ["apparel"] },
  { patterns: ["fading", "color fade", "sun fading", "washed out"],
    label: "Color fading",             resaleImpactPct: { apparel: 25, default: 20 }, severity: "moderate" },
  { patterns: ["hole", "small hole", "tear", "rip"],
    label: "Hole / tear",              resaleImpactPct: { apparel: 40, bag: 30, default: 35 }, severity: "high" },
  { patterns: ["stain", "stained", "discoloration", "discoloured"],
    label: "Staining / discoloration", resaleImpactPct: { apparel: 30, bag: 25, default: 25 }, severity: "high" },
  { patterns: ["missing button", "button missing"],
    label: "Missing button",           resaleImpactPct: { apparel: 15, default: 10 }, severity: "moderate", categories: ["apparel"] },
  { patterns: ["zipper broken", "broken zipper", "zipper stuck"],
    label: "Broken zipper",            resaleImpactPct: { apparel: 25, bag: 30, default: 25 }, severity: "high" },

  // ── Bag-specific ──
  { patterns: ["corner wear", "corner damage", "worn corners"],
    label: "Corner wear",              resaleImpactPct: { bag: 20, default: 15 }, severity: "moderate", categories: ["bag"] },
  { patterns: ["strap wear", "strap damage", "strap fraying"],
    label: "Strap wear",               resaleImpactPct: { bag: 18, default: 12 }, severity: "moderate", categories: ["bag"] },
  { patterns: ["lining tear", "interior tear", "lining stain"],
    label: "Interior lining damage",   resaleImpactPct: { bag: 25, default: 20 }, severity: "moderate", categories: ["bag"] },
  { patterns: ["tarnished hardware", "tarnish", "hardware tarnish"],
    label: "Hardware tarnishing",      resaleImpactPct: { bag: 15, watch: 10, default: 12 }, severity: "low" },
  { patterns: ["scratched hardware", "scratched clasp"],
    label: "Scratched hardware",       resaleImpactPct: { bag: 10, default: 8 }, severity: "low" },

  // ── Electronics-specific ──
  { patterns: ["cracked screen", "screen crack", "cracked display", "screen damage"],
    label: "Cracked screen",           resaleImpactPct: { electronics: 45, default: 40 }, severity: "critical", categories: ["electronics"] },
  { patterns: ["dent", "dented", "bend", "bent"],
    label: "Dent / structural damage", resaleImpactPct: { electronics: 30, watch: 35, default: 25 }, severity: "high" },
  { patterns: ["battery swollen", "swollen battery", "battery bulge"],
    label: "Swollen battery",          resaleImpactPct: { electronics: 60, default: 50 }, severity: "critical", categories: ["electronics"] },
  { patterns: ["dead pixel", "dead pixels", "screen burn"],
    label: "Dead pixels / screen burn", resaleImpactPct: { electronics: 35, default: 30 }, severity: "high", categories: ["electronics"] },
  { patterns: ["button stuck", "stuck button", "button broken"],
    label: "Broken button",            resaleImpactPct: { electronics: 20, default: 15 }, severity: "moderate" },
  { patterns: ["water damage", "water damaged", "liquid damage"],
    label: "Water damage",             resaleImpactPct: { electronics: 55, watch: 40, default: 50 }, severity: "critical" },

  // ── Watch-specific ──
  { patterns: ["crystal scratch", "scratched crystal", "scratched crystal face"],
    label: "Crystal scratching",       resaleImpactPct: { watch: 20, default: 15 }, severity: "moderate", categories: ["watch"] },
  { patterns: ["case scratch", "scratched case", "case wear"],
    label: "Case scratches",           resaleImpactPct: { watch: 12, default: 10 }, severity: "low", categories: ["watch"] },
  { patterns: ["bracelet stretch", "stretched bracelet", "loose bracelet"],
    label: "Bracelet stretch",         resaleImpactPct: { watch: 15, default: 10 }, severity: "moderate", categories: ["watch"] },
  { patterns: ["crown damage", "damaged crown", "crown missing"],
    label: "Crown damage",             resaleImpactPct: { watch: 25, default: 20 }, severity: "high", categories: ["watch"] },

  // ── Universal ──
  { patterns: ["heavy wear", "heavily worn", "signs of heavy use"],
    label: "Heavy overall wear",       resaleImpactPct: { sneakers: 30, apparel: 35, bag: 28, default: 25 }, severity: "high" },
  { patterns: ["odor", "smell", "musty", "cigarette smell"],
    label: "Odor",                     resaleImpactPct: { default: 30 }, severity: "high" },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Detect damage signatures from visible text and style words.
 */
export function detectDamageSignatures(visibleText = [], styleWords = [], category = "") {
  const allText = [...visibleText, ...styleWords]
    .map(t => String(t).toLowerCase())
    .join(" ");

  const cat        = String(category || "").toLowerCase().replace(/s$/, "");
  const detections = [];

  for (const sig of DAMAGE_SIGNATURES) {
    const matched = sig.patterns.some(p => allText.includes(p));
    if (!matched) continue;

    // Category filter: if categories specified, only trigger for matching
    if (sig.categories && sig.categories.length && !sig.categories.includes(cat)) continue;

    const impact = sig.resaleImpactPct[cat] ?? sig.resaleImpactPct.default ?? 10;

    detections.push({
      label:          sig.label,
      severity:       sig.severity,
      resaleImpactPct:impact,
      matchedPattern: sig.patterns.find(p => allText.includes(p)),
    });
  }

  // Sort by severity and impact
  const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };
  detections.sort((a, b) =>
    (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) ||
    b.resaleImpactPct - a.resaleImpactPct
  );

  return detections;
}

/**
 * Compute total resale impact from all detected damage.
 * Uses diminishing returns: stacked damage doesn't exceed 80% impact.
 */
export function computeTotalDamageImpact(detections = []) {
  if (!detections.length) return { totalImpactPct: 0, adjustedImpactPct: 0, hasCritical: false };

  // Diminishing returns: each additional damage type contributes less
  let accumulated = 0;
  for (const d of detections) {
    const marginal = d.resaleImpactPct * (1 - accumulated / 100);
    accumulated   += marginal;
  }

  const totalImpactPct    = round2(Math.min(80, accumulated));
  const hasCritical       = detections.some(d => d.severity === "critical");

  return {
    totalImpactPct,
    hasCritical,
    damageCount: detections.length,
  };
}

/**
 * Generate a buyer negotiation script based on detected damage.
 */
export function buildBuyerDamageScript(detections = [], currentPrice = null) {
  if (!detections.length) return null;

  const top3       = detections.slice(0, 3);
  const { totalImpactPct } = computeTotalDamageImpact(detections);
  const price      = Number(currentPrice);
  const fairPrice  = Number.isFinite(price) && price > 0
    ? round2(price * (1 - totalImpactPct / 100))
    : null;

  const damageList = top3.map(d => `${d.label} (-${d.resaleImpactPct}%)`).join(", ");

  return {
    script:     `I noticed ${damageList}. Based on these condition issues, a fair price would be $${fairPrice?.toFixed(2) ?? "(calculate from market)"}. Would you consider that?`,
    fairPrice,
    totalDiscountPct: totalImpactPct,
    damageSummary: damageList,
  };
}

/**
 * Generate a seller disclosure script (FTC/platform compliant).
 */
export function buildSellerDisclosureScript(detections = []) {
  if (!detections.length) {
    return { script: "Item is in the condition described. Please review all photos.", detections: [] };
  }

  const lines = detections.map(d =>
    `- ${d.label}: visible in photos, priced accordingly`
  );

  return {
    script: `Condition disclosure:\n${lines.join("\n")}\n\nAll condition issues are reflected in the price and visible in listing photos. Questions welcome before purchase.`,
    detections,
    disclosureCount: detections.length,
  };
}

/**
 * Master condition forensics payload.
 */
export function buildConditionForensicsPayload({
  visibleText  = [],
  styleWords   = [],
  category     = "",
  scannedPrice = null,
  medianMarket = null,
} = {}) {
  const detections   = detectDamageSignatures(visibleText, styleWords, category);
  const impact       = computeTotalDamageImpact(detections);
  const basePrice    = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);

  const fairConditionPrice = basePrice && impact.totalImpactPct > 0
    ? round2(basePrice * (1 - impact.totalImpactPct / 100))
    : null;

  const buyerScript  = buildBuyerDamageScript(detections, finiteOrNull(scannedPrice));
  const sellerScript = buildSellerDisclosureScript(detections);

  return {
    hasDetectedDamage: detections.length > 0,
    detections,
    impact,
    fairConditionPrice,
    buyerScript:       buyerScript  || null,
    sellerScript,
    topSignal: detections.length
      ? `${detections[0].label} detected — est. ${impact.totalImpactPct}% resale impact${fairConditionPrice ? ` ($${fairConditionPrice.toFixed(2)} fair price)` : ""}`
      : null,
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
