// src/confidenceFirewall.js
// Agreement-based confidence arbitration.
// When GPT-4.1 vision is uncertain, this system downgrades confidence,
// rejects hallucinated brands/models, and gates specificity to evidence level.
// "Don't lie confidently. Lie honestly."

// ── Known-hallucination brand patterns ───────────────────────────────────────
// Brands GPT commonly hallucinates onto generic items
const FRAGILE_BRANDS = new Set([
  "supreme", "gucci", "louis vuitton", "chanel", "hermes", "prada", "balenciaga",
  "off-white", "fear of god", "palace", "stone island", "rolex", "patek philippe",
  "ap", "audemars piguet", "richard mille", "hublot",
]);

const CONFIDENT_BRANDS = new Set([
  "nike", "adidas", "new balance", "vans", "converse", "reebok", "puma",
  "apple", "samsung", "sony", "nintendo", "microsoft",
  "north face", "patagonia", "columbia", "carhartt",
  "ray-ban", "oakley", "casio", "seiko", "citizen", "timex",
]);

function norm(s) {
  return String(s || "").toLowerCase().trim();
}

function titleTokens(s) {
  return norm(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
}

function titleOverlap(a, b) {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter(t => tb.has(t)).length;
  return shared / Math.max(ta.size, tb.size);
}

// ── Price sanity check ────────────────────────────────────────────────────────
function isPriceSane(prices = [], identity = {}) {
  if (!prices.length) return true; // can't assess without prices
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const brand = norm(identity?.brand || "");

  // If brand is luxury but prices are all <$100, something is wrong
  if (FRAGILE_BRANDS.has(brand) && median < 80) return false;
  // If brand is budget but prices are all >$500, something is wrong
  if (CONFIDENT_BRANDS.has(brand) && median > 500 && !/pro|max|ultra/.test(norm(identity?.model || ""))) return false;

  return true;
}

// ── Category agreement check ──────────────────────────────────────────────────
function categoryAgreement(resultTitles = [], identityCategory = "") {
  if (!identityCategory || !resultTitles.length) return 1.0;
  const cat = norm(identityCategory);
  const CATEGORY_KEYWORDS = {
    sneakers:   ["shoe", "sneaker", "jordan", "nike", "adidas", "yeezy", "vans", "air"],
    eyewear:    ["sunglass", "glass", "frames", "lens", "wayfarer", "aviator"],
    outerwear:  ["jacket", "coat", "parka", "hoodie", "vest", "puffer"],
    bags:       ["bag", "tote", "purse", "backpack", "wallet", "clutch"],
    watches:    ["watch", "timepiece", "chrono", "rolex", "seiko"],
    audio:      ["headphone", "earbud", "speaker", "airpod", "bose", "sony"],
    phones:     ["iphone", "phone", "samsung", "galaxy", "pixel"],
    gaming:     ["playstation", "xbox", "nintendo", "switch", "console"],
  };

  const keywords = CATEGORY_KEYWORDS[cat] || [];
  if (!keywords.length) return 1.0;

  const matching = resultTitles.filter(title =>
    keywords.some(kw => norm(title).includes(kw))
  ).length;

  return resultTitles.length > 0 ? matching / resultTitles.length : 1.0;
}

// ── Brand agreement check across results ─────────────────────────────────────
function brandAgreement(resultTitles = [], identityBrand = "") {
  if (!identityBrand || !resultTitles.length) return 1.0;
  const brand = norm(identityBrand);
  const matching = resultTitles.filter(t => norm(t).includes(brand)).length;
  return matching / resultTitles.length;
}

// ── Core: run confidence firewall ─────────────────────────────────────────────
export function runConfidenceFirewall({
  identity = {},
  resultTitles = [],
  resultPrices = [],
  visionConfidence = 0.5,
  attributeCertainty = {},
}) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");
  const category = norm(identity?.category || "");

  const flags = [];
  let adjustedConfidence = Number(visionConfidence) || 0.5;
  let brandConfidence = Number(attributeCertainty?.brand || 0.5);
  let modelConfidence = Number(attributeCertainty?.model || 0.5);

  // ── Flag 1: Fragile brand with low attributeCertainty ─────────────────────
  if (brand && FRAGILE_BRANDS.has(brand) && brandConfidence < 0.7) {
    flags.push("fragile_brand_low_confidence");
    adjustedConfidence *= 0.7;
    brandConfidence *= 0.6;
  }

  // ── Flag 2: Brand not appearing in any results ─────────────────────────────
  if (brand && resultTitles.length >= 3) {
    const bAgree = brandAgreement(resultTitles, brand);
    if (bAgree < 0.1) {
      flags.push("brand_not_found_in_results");
      adjustedConfidence *= 0.65;
      brandConfidence *= 0.4;
    } else if (bAgree < 0.3) {
      flags.push("brand_low_result_agreement");
      adjustedConfidence *= 0.85;
    }
  }

  // ── Flag 3: Category mismatch in results ──────────────────────────────────
  if (category && resultTitles.length >= 3) {
    const catAgree = categoryAgreement(resultTitles, category);
    if (catAgree < 0.2) {
      flags.push("category_mismatch_in_results");
      adjustedConfidence *= 0.6;
    }
  }

  // ── Flag 4: Price insanity ─────────────────────────────────────────────────
  if (resultPrices.length >= 3 && !isPriceSane(resultPrices, identity)) {
    flags.push("price_distribution_mismatch");
    adjustedConfidence *= 0.7;
    if (brand && FRAGILE_BRANDS.has(brand)) brandConfidence *= 0.3;
  }

  // ── Flag 5: Model hallucination (model not in any result title) ────────────
  if (model && resultTitles.length >= 3) {
    const modelTokens = titleTokens(model);
    const modelFound = resultTitles.some(title =>
      modelTokens.filter(t => t.length > 3).some(t => norm(title).includes(t))
    );
    if (!modelFound && modelConfidence < 0.7) {
      flags.push("model_not_found_in_results");
      adjustedConfidence *= 0.75;
      modelConfidence *= 0.5;
    }
  }

  // ── Flag 6: Too few results for claimed specificity ────────────────────────
  if (resultTitles.length < 3 && (brand || model)) {
    flags.push("insufficient_results_for_specificity");
    adjustedConfidence *= 0.8;
  }

  // ── Boost: High brand+model certainty with good result agreement ──────────
  if (brandConfidence > 0.85 && modelConfidence > 0.8 && !flags.some(f => f.includes("brand"))) {
    adjustedConfidence = Math.min(adjustedConfidence * 1.1, 0.98);
  }

  const clampedConfidence = Math.max(0, Math.min(1, adjustedConfidence));

  // Specificity level: what level of claims can we make confidently
  let specificityLevel = "full"; // brand + model confident
  if (flags.includes("fragile_brand_low_confidence") || brandConfidence < 0.4) specificityLevel = "category_only";
  else if (flags.includes("brand_not_found_in_results") || brandConfidence < 0.6) specificityLevel = "brand_uncertain";
  else if (flags.includes("model_not_found_in_results") || modelConfidence < 0.5) specificityLevel = "brand_only";

  return {
    adjustedConfidence: clampedConfidence,
    adjustedBrandConfidence: Math.max(0, Math.min(1, brandConfidence)),
    adjustedModelConfidence: Math.max(0, Math.min(1, modelConfidence)),
    specificityLevel,
    flags,
    isTrustedIdentity: flags.length === 0 && clampedConfidence > 0.7,
    shouldDowngradeSpecificity: specificityLevel !== "full",
    warningMessage: flags.length > 0 ? `Identity confidence reduced: ${flags.slice(0, 2).join(", ")}` : null,
  };
}

// ── Sanitize identity based on firewall result ────────────────────────────────
export function sanitizeIdentityWithFirewall(identity = {}, firewallResult = {}) {
  const { specificityLevel, adjustedBrandConfidence, adjustedModelConfidence } = firewallResult;

  if (specificityLevel === "category_only") {
    return {
      ...identity,
      brand: null,
      model: null,
      exactQuery: null,
      _firewallDowngraded: true,
    };
  }

  if (specificityLevel === "brand_only") {
    return {
      ...identity,
      model: null,
      _firewallDowngraded: true,
    };
  }

  if (specificityLevel === "brand_uncertain") {
    return {
      ...identity,
      _brandUncertain: true,
      _firewallDowngraded: adjustedBrandConfidence < 0.5,
    };
  }

  return { ...identity, _firewallDowngraded: false };
}
