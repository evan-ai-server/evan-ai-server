// src/listingQualityScorer.js
// Listing quality scorer: rates a listing 0-100 for completeness, photo
// quality, price accuracy, and seller credibility. Generates actionable
// improvement suggestions for sellers and trust signals for buyers.
// "This listing scores 34/100 — missing measurements, single photo, vague
// description, no price justification."

// ── Quality dimension weights ─────────────────────────────────────────────────
const QUALITY_DIMENSIONS = {
  description:   { weight: 25, label: "Description" },
  photos:        { weight: 20, label: "Photos" },
  pricing:       { weight: 20, label: "Pricing Accuracy" },
  seller:        { weight: 20, label: "Seller Credibility" },
  itemDetails:   { weight: 15, label: "Item Details" },
};

// ── Category-specific required fields ─────────────────────────────────────────
const REQUIRED_FIELDS_BY_CATEGORY = {
  sneakers: ["size", "colorway", "condition", "box"],
  bag:      ["color", "material", "measurements", "hardware", "authenticity"],
  watch:    ["reference", "movement", "dial", "bracelet", "box_papers"],
  electronics: ["storage", "carrier", "condition", "imei_status", "accessories"],
  apparel:  ["size", "measurements", "material", "condition"],
  eyewear:  ["frame_size", "lens_type", "condition", "case"],
  default:  ["condition", "size"],
};

// ── Description quality indicators ────────────────────────────────────────────
const DESCRIPTION_KEYWORDS = {
  positive: [
    "measurements", "dimensions", "purchased", "retail", "comes with",
    "included", "original", "authentic", "worn", "used", "condition",
    "minor", "no flaws", "clean", "shipping from",
  ],
  negative: [
    "see photos", "self explanatory", "as is", "no description",
    "check pictures", "look at photos",
  ],
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Score the description quality (0-100).
 */
function scoreDescription(description = "", title = "", category = "") {
  const desc  = String(description || "").toLowerCase();
  const full  = `${desc} ${String(title || "").toLowerCase()}`;
  const issues = [];
  let score  = 100;

  if (desc.length === 0) {
    return { score: 0, issues: ["No description provided — this is a major red flag for buyers"] };
  }
  if (desc.length < 30) {
    score -= 40;
    issues.push("Description is too short (under 30 characters)");
  } else if (desc.length < 100) {
    score -= 20;
    issues.push("Description is brief — add more detail about condition and history");
  }

  // Negative phrase penalties
  for (const neg of DESCRIPTION_KEYWORDS.negative) {
    if (desc.includes(neg)) {
      score -= 15;
      issues.push(`Vague phrase detected: "${neg}"`);
    }
  }

  // Positive phrase bonuses
  const positiveMatches = DESCRIPTION_KEYWORDS.positive.filter(p => full.includes(p)).length;
  if (positiveMatches < 2) {
    score -= 15;
    issues.push("Missing key descriptors (condition, measurements, history)");
  }

  // Category-specific required fields
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const required = REQUIRED_FIELDS_BY_CATEGORY[cat] || REQUIRED_FIELDS_BY_CATEGORY.default;
  const missing  = required.filter(f => !full.includes(f.replace("_", " ")));
  if (missing.length > 0) {
    score -= Math.min(30, missing.length * 8);
    issues.push(`Missing expected details: ${missing.slice(0, 3).join(", ")}`);
  }

  return { score: Math.max(0, score), issues };
}

/**
 * Score photo quality (0-100) based on available signals.
 */
function scorePhotos({
  photoCount       = 0,
  hasMultiAngle    = false,
  stockPhotoOnly   = false,
  hasDefectPhoto   = false,
  lightingQuality  = null, // "good", "acceptable", "poor", null
} = {}) {
  const issues = [];
  let score = 100;

  if (stockPhotoOnly) {
    return { score: 10, issues: ["Stock/internet photos only — buyer cannot verify actual item"] };
  }
  if (photoCount === 0) {
    return { score: 0, issues: ["No photos provided"] };
  }
  if (photoCount < 3) {
    score -= 35;
    issues.push(`Only ${photoCount} photo(s) — buyers need at least 5-8 for confidence`);
  } else if (photoCount < 6) {
    score -= 15;
    issues.push("Add more photos: close-ups, sole/bottom, label/tag");
  }
  if (!hasMultiAngle) {
    score -= 20;
    issues.push("Missing multi-angle coverage (front, side, back, detail)");
  }
  if (!hasDefectPhoto && photoCount > 0) {
    score -= 10;
    issues.push("No close-up of any defects or wear — buyers will wonder what's hidden");
  }
  if (lightingQuality === "poor") {
    score -= 20;
    issues.push("Poor lighting — item details are hard to evaluate");
  } else if (lightingQuality === "acceptable") {
    score -= 5;
  }

  return { score: Math.max(0, score), issues };
}

/**
 * Score pricing accuracy (0-100).
 */
function scorePricing(listPrice = null, medianMarket = null, dealVerdict = null) {
  const issues = [];
  let score = 100;

  if (!finiteOrNull(listPrice)) {
    return { score: 0, issues: ["No price set"] };
  }
  if (!finiteOrNull(medianMarket)) {
    return { score: 70, issues: [] }; // no market data to compare
  }

  const deviation = (listPrice - medianMarket) / medianMarket;
  const absPct    = Math.abs(deviation) * 100;

  if (deviation > 0.40) {
    score -= 50;
    issues.push(`Price is ${absPct.toFixed(0)}% above market — very unlikely to sell`);
  } else if (deviation > 0.20) {
    score -= 25;
    issues.push(`Price is ${absPct.toFixed(0)}% above market — consider reducing to sell faster`);
  } else if (deviation > 0.10) {
    score -= 10;
    issues.push(`Price is ${absPct.toFixed(0)}% above market — slight premium`);
  } else if (deviation < -0.35) {
    score -= 20;
    issues.push(`Price is ${absPct.toFixed(0)}% below market — may attract counterfeit concerns`);
  }

  return { score: Math.max(0, score), issues };
}

/**
 * Score seller credibility (0-100).
 */
function scoreSeller({
  feedbackCount   = null,
  feedbackPct     = null,
  isPowerSeller   = false,
  isTopRated      = false,
  accountAgeDays  = null,
} = {}) {
  const issues = [];
  let score = 60; // start at 60, earn the rest

  const count = finiteOrNull(feedbackCount) || 0;
  const pct   = feedbackPct != null ? Number(feedbackPct) : null;
  const age   = finiteOrNull(accountAgeDays);

  if (isTopRated)      { score += 30; }
  else if (isPowerSeller) { score += 20; }
  else if (count >= 100)  { score += 15; }
  else if (count >= 25)   { score += 8; }
  else if (count < 5)     { score -= 25; issues.push("New seller — very little feedback history"); }

  if (pct !== null) {
    if (pct >= 99.5)       score += 10;
    else if (pct >= 98)    score += 5;
    else if (pct < 95)     { score -= 20; issues.push(`Below 95% positive feedback (${pct?.toFixed(1)}%)`); }
    else if (pct < 90)     { score -= 40; issues.push(`Below 90% positive feedback — serious concern`); }
  }

  if (age !== null && age < 30) {
    score -= 15;
    issues.push("Account less than 30 days old");
  }

  return { score: Math.max(0, Math.min(100, score)), issues };
}

/**
 * Score item detail completeness (0-100).
 */
function scoreItemDetails(identity = {}, category = "") {
  const issues  = [];
  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const required = REQUIRED_FIELDS_BY_CATEGORY[cat] || REQUIRED_FIELDS_BY_CATEGORY.default;

  const provided = Object.entries(identity)
    .filter(([, v]) => v && String(v).trim().length > 0)
    .map(([k]) => k.toLowerCase());

  const missing = required.filter(f =>
    !provided.some(p => p.includes(f.replace("_", "")) || f.replace("_", "").includes(p))
  );

  const score = Math.max(0, 100 - missing.length * Math.floor(90 / required.length));
  if (missing.length > 0) {
    issues.push(`Missing: ${missing.slice(0, 4).join(", ")}`);
  }

  return { score, issues };
}

/**
 * Compute overall listing quality score and suggestions.
 */
export function scoreListingQuality({
  title            = "",
  description      = "",
  category         = "",
  listPrice        = null,
  medianMarket     = null,
  dealVerdict      = null,
  photoCount       = 0,
  hasMultiAngle    = false,
  stockPhotoOnly   = false,
  hasDefectPhoto   = false,
  lightingQuality  = null,
  feedbackCount    = null,
  feedbackPct      = null,
  isPowerSeller    = false,
  isTopRated       = false,
  accountAgeDays   = null,
  identity         = {},
} = {}) {
  const descScore    = scoreDescription(description, title, category);
  const photoScore   = scorePhotos({ photoCount, hasMultiAngle, stockPhotoOnly, hasDefectPhoto, lightingQuality });
  const pricingScore = scorePricing(finiteOrNull(listPrice), finiteOrNull(medianMarket), dealVerdict);
  const sellerScore  = scoreSeller({ feedbackCount, feedbackPct, isPowerSeller, isTopRated, accountAgeDays });
  const detailScore  = scoreItemDetails(identity, category);

  const weighted = round2(
    descScore.score    * (QUALITY_DIMENSIONS.description.weight  / 100) +
    photoScore.score   * (QUALITY_DIMENSIONS.photos.weight       / 100) +
    pricingScore.score * (QUALITY_DIMENSIONS.pricing.weight      / 100) +
    sellerScore.score  * (QUALITY_DIMENSIONS.seller.weight       / 100) +
    detailScore.score  * (QUALITY_DIMENSIONS.itemDetails.weight  / 100)
  );

  const tier = weighted >= 85 ? "excellent"
             : weighted >= 70 ? "good"
             : weighted >= 50 ? "average"
             : weighted >= 30 ? "poor"
             : "very_poor";

  const allIssues = [
    ...descScore.issues.map(i => ({ area: "Description",  issue: i })),
    ...photoScore.issues.map(i => ({ area: "Photos",      issue: i })),
    ...pricingScore.issues.map(i => ({ area: "Pricing",   issue: i })),
    ...sellerScore.issues.map(i => ({ area: "Seller",     issue: i })),
    ...detailScore.issues.map(i => ({ area: "Item Details", issue: i })),
  ];

  return {
    totalScore: weighted,
    tier,
    dimensions: {
      description: { score: descScore.score,   weight: QUALITY_DIMENSIONS.description.weight },
      photos:      { score: photoScore.score,  weight: QUALITY_DIMENSIONS.photos.weight },
      pricing:     { score: pricingScore.score,weight: QUALITY_DIMENSIONS.pricing.weight },
      seller:      { score: sellerScore.score, weight: QUALITY_DIMENSIONS.seller.weight },
      itemDetails: { score: detailScore.score, weight: QUALITY_DIMENSIONS.itemDetails.weight },
    },
    issues:      allIssues,
    issueCount:  allIssues.length,
    topSignal:   allIssues.length
      ? `Listing scores ${weighted}/100 (${tier}) — ${allIssues[0].area}: ${allIssues[0].issue}`
      : `Listing scores ${weighted}/100 — ${tier} quality`,
  };
}

/**
 * Master listing quality scorer payload.
 */
export function buildListingQualityScorerPayload({
  title            = "",
  description      = "",
  category         = "",
  scannedPrice     = null,
  medianMarket     = null,
  dealVerdict      = null,
  photoCount       = 0,
  hasMultiAngle    = false,
  stockPhotoOnly   = false,
  hasDefectPhoto   = false,
  lightingQuality  = null,
  sellerProfile    = {},
  identity         = {},
} = {}) {
  const result = scoreListingQuality({
    title,
    description,
    category,
    listPrice:       finiteOrNull(scannedPrice),
    medianMarket:    finiteOrNull(medianMarket),
    dealVerdict,
    photoCount,
    hasMultiAngle,
    stockPhotoOnly,
    hasDefectPhoto,
    lightingQuality,
    feedbackCount:   sellerProfile?.feedbackCount  ?? null,
    feedbackPct:     sellerProfile?.feedbackPct    ?? null,
    isPowerSeller:   sellerProfile?.isPowerSeller  || false,
    isTopRated:      sellerProfile?.isTopRated     || false,
    accountAgeDays:  sellerProfile?.accountAgeDays ?? null,
    identity,
  });

  return {
    quality:   result,
    topSignal: result.topSignal,
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
