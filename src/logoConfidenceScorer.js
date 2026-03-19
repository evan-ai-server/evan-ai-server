// src/logoConfidenceScorer.js
// Logo Confidence Scorer — Feature 67
// Takes vision output and scores how strong the evidence is for each brand claim.
// Outputs per-brand confidence with explicit evidence breakdown.
// "Nike: 0.94 (Swoosh visible + heel tab text). Jordan: 0.12 (no Jumpman detected)."
// Used to catch low-confidence brand IDs before they pollute the search pipeline.

// ── Evidence types and weights ────────────────────────────────────────────────
const EVIDENCE_WEIGHTS = {
  text_exact:       1.00, // brand name spelled out exactly in visibleText
  text_partial:     0.65, // partial brand name or abbreviation in visibleText
  logo_primary:     0.90, // unmistakable primary logo (Swoosh, LV monogram, Rolex crown)
  logo_secondary:   0.60, // secondary marking (heel tab, interior tag, hardware stamp)
  silhouette:       0.45, // brand-signature silhouette/shape
  colorway:         0.30, // brand-associated color combination
  sku_code:         0.80, // visible SKU that matches brand format
  auth_flag_neg:   -0.40, // authenticity flag that undermines confidence
};

// ── Brand evidence signatures ─────────────────────────────────────────────────
// Each brand has: textMarkers, logoKeywords, silhouetteKeywords, skuPatterns
const BRAND_SIGNATURES = {
  Nike: {
    textMarkers:    ["nike", "just do it", "swoosh"],
    logoKeywords:   ["swoosh", "nike swoosh", "checkmark logo", "curved check"],
    silhouetteKeys: ["air max", "air sole", "waffle sole", "foam sole"],
    skuPattern:     /[A-Z]{2,3}\d{4,5}-\d{3}/,
    minTextLength:  4,
  },
  "Air Jordan": {
    textMarkers:    ["jordan", "jumpman", "air jordan", "flight"],
    logoKeywords:   ["jumpman", "wings logo", "jordan logo", "flight logo"],
    silhouetteKeys: ["high top", "patent leather", "strap", "elephant print"],
    skuPattern:     /\d{6}-\d{3}/,
    minTextLength:  6,
  },
  Adidas: {
    textMarkers:    ["adidas", "three stripes", "trefoil", "originals"],
    logoKeywords:   ["three stripes", "trefoil logo", "adidas stripes", "parallel stripes"],
    silhouetteKeys: ["boost sole", "primeknit", "continental sole"],
    skuPattern:     /[A-Z]{2}\d{4,5}/,
    minTextLength:  5,
  },
  Yeezy: {
    textMarkers:    ["yeezy", "adidas yeezy", "kanye"],
    logoKeywords:   ["primeknit upper", "wavy sole", "boost foam", "runner sole"],
    silhouetteKeys: ["foam runner", "sock fit", "high ankle"],
    skuPattern:     /[A-Z]{2}\d{4}/,
    minTextLength:  5,
  },
  "Louis Vuitton": {
    textMarkers:    ["louis vuitton", "lv", "lvmh", "maison louis vuitton"],
    logoKeywords:   ["lv monogram", "damier pattern", "epi leather", "monogram canvas", "fleur de lis"],
    silhouetteKeys: ["speedy", "neverfull", "keepall", "petite malle"],
    skuPattern:     /[A-Z]{2}\d{4}/,
    minTextLength:  2,
  },
  Chanel: {
    textMarkers:    ["chanel", "cc logo", "paris"],
    logoKeywords:   ["double c", "interlocked c", "cc clasp", "quilted pattern", "chain strap"],
    silhouetteKeys: ["flap bag", "classic flap", "boy bag", "2.55"],
    skuPattern:     /\d{7,10}/,
    minTextLength:  6,
  },
  Gucci: {
    textMarkers:    ["gucci", "gg", "guccio gucci"],
    logoKeywords:   ["double g", "gg pattern", "horsebit", "bamboo handle", "gucci stripe"],
    silhouetteKeys: ["marmont", "dionysus", "jackie", "ophidia"],
    skuPattern:     /\d{6,9}/,
    minTextLength:  5,
  },
  Rolex: {
    textMarkers:    ["rolex", "swiss made", "oyster", "perpetual", "superlative chronometer"],
    logoKeywords:   ["rolex crown", "crown logo", "five point crown", "cyclops lens"],
    silhouetteKeys: ["jubilee bracelet", "oyster bracelet", "fluted bezel", "mercedes hands"],
    skuPattern:     /\d{5,6}[A-Z]{0,4}/,
    minTextLength:  5,
  },
  Supreme: {
    textMarkers:    ["supreme", "new york"],
    logoKeywords:   ["box logo", "futura font", "red box", "white text"],
    silhouetteKeys: ["boxy hoodie", "camp cap", "5 panel"],
    skuPattern:     null,
    minTextLength:  7,
  },
  "Off-White": {
    textMarkers:    ["off-white", "off white", "virgil abloh", "c/o virgil"],
    logoKeywords:   ["industrial belt", "zip tie", "quotation marks", "arrow logo"],
    silhouetteKeys: ["oversized fit", "deconstructed"],
    skuPattern:     null,
    minTextLength:  9,
  },
  Balenciaga: {
    textMarkers:    ["balenciaga", "cristóbal balenciaga"],
    logoKeywords:   ["logo print", "balenciaga text", "block lettering"],
    silhouetteKeys: ["triple s", "track shoe", "city bag", "hourglass"],
    skuPattern:     null,
    minTextLength:  9,
  },
  "Ray-Ban": {
    textMarkers:    ["ray-ban", "rayban", "ray ban", "rb"],
    logoKeywords:   ["rb engraved", "ray-ban temple", "b&l marking"],
    silhouetteKeys: ["wayfarer", "aviator", "clubmaster", "round"],
    skuPattern:     /RB\d{4}/i,
    minTextLength:  6,
  },
  Apple: {
    textMarkers:    ["apple", "iphone", "ipad", "macbook", "airpods", "designed by apple"],
    logoKeywords:   ["apple logo", "bitten apple", "apple symbol"],
    silhouetteKeys: ["aluminum unibody", "lightning port", "usb-c", "magsafe"],
    skuPattern:     /[A-Z]\d{4}[A-Z]{2}\/[A-Z]/,
    minTextLength:  5,
  },
};

// ── Core scoring engine ───────────────────────────────────────────────────────

/**
 * Score a single brand against the vision output.
 */
export function scoreSingleBrand(brandName, visionOutput) {
  const sig = BRAND_SIGNATURES[brandName];
  if (!sig) return { score: 0, evidence: [], reason: "unknown_brand" };

  const visibleText   = (visionOutput?.identity?.visibleText || []).map(t => t.toLowerCase());
  const styleWords    = (visionOutput?.identity?.styleWords  || []).map(t => t.toLowerCase());
  const materials     = (visionOutput?.identity?.materials   || []).map(t => t.toLowerCase());
  const authFlags     = visionOutput?.authenticityFlags || [];
  const allText       = [...visibleText, ...styleWords, ...materials].join(" ");
  const skuFromVision = (visionOutput?.identity?.visibleText || []).join(" ");

  const evidence = [];
  let totalScore = 0;

  // ── Text exact match ───────────────────────────────────────────────────
  for (const marker of sig.textMarkers) {
    if (allText.includes(marker.toLowerCase())) {
      const weight = marker.length >= sig.minTextLength
        ? EVIDENCE_WEIGHTS.text_exact
        : EVIDENCE_WEIGHTS.text_partial;
      evidence.push({ type: "text", marker, weight });
      totalScore += weight;
      break; // one text match is enough
    }
  }

  // ── Logo / visual markers ──────────────────────────────────────────────
  for (const keyword of sig.logoKeywords) {
    if (allText.includes(keyword.toLowerCase())) {
      evidence.push({ type: "logo", keyword, weight: EVIDENCE_WEIGHTS.logo_primary });
      totalScore += EVIDENCE_WEIGHTS.logo_primary;
      break;
    }
  }

  // ── Silhouette cues ────────────────────────────────────────────────────
  let silhouetteHit = false;
  for (const key of sig.silhouetteKeys) {
    if (allText.includes(key.toLowerCase())) {
      silhouetteHit = true;
      evidence.push({ type: "silhouette", key, weight: EVIDENCE_WEIGHTS.silhouette });
      totalScore += EVIDENCE_WEIGHTS.silhouette;
      break;
    }
  }

  // ── SKU code match ─────────────────────────────────────────────────────
  if (sig.skuPattern && sig.skuPattern.test(skuFromVision)) {
    evidence.push({ type: "sku", pattern: sig.skuPattern.source, weight: EVIDENCE_WEIGHTS.sku_code });
    totalScore += EVIDENCE_WEIGHTS.sku_code;
  }

  // ── Brand is claimed by vision model ──────────────────────────────────
  const claimedBrand = (visionOutput?.identity?.brand || "").toLowerCase();
  if (claimedBrand && brandName.toLowerCase().includes(claimedBrand)) {
    evidence.push({ type: "vision_claim", weight: EVIDENCE_WEIGHTS.logo_secondary });
    totalScore += EVIDENCE_WEIGHTS.logo_secondary;
  }

  // ── Auth flag penalty ──────────────────────────────────────────────────
  const hasNegativeFlag = authFlags.some(f => [
    "logo_proportions_off", "font_wrong", "stitching_uneven",
    "monogram_misaligned", "hardware_lightweight"
  ].includes(f));
  if (hasNegativeFlag) {
    evidence.push({ type: "auth_flag_negative", weight: EVIDENCE_WEIGHTS.auth_flag_neg });
    totalScore += EVIDENCE_WEIGHTS.auth_flag_neg;
  }

  // ── Normalize to 0-1 ──────────────────────────────────────────────────
  const maxPossible = EVIDENCE_WEIGHTS.text_exact + EVIDENCE_WEIGHTS.logo_primary + EVIDENCE_WEIGHTS.sku_code;
  const normalized  = Math.min(1.0, Math.max(0, totalScore / maxPossible));

  return {
    brand:    brandName,
    score:    Math.round(normalized * 100) / 100,
    evidence,
    hasTextEvidence:      evidence.some(e => e.type === "text"),
    hasLogoEvidence:      evidence.some(e => e.type === "logo"),
    hasSkuEvidence:       evidence.some(e => e.type === "sku"),
    hasSilhouetteEvidence:evidence.some(e => e.type === "silhouette"),
    flaggedAuthenticity:  hasNegativeFlag,
  };
}

/**
 * Score all known brands and rank by confidence.
 * If a brand is claimed by vision, always score it even if evidence is thin.
 */
export function scoreAllBrands(visionOutput) {
  const claimedBrand = (visionOutput?.identity?.brand || "").trim();
  const brandNames   = Object.keys(BRAND_SIGNATURES);

  // Always include the claimed brand
  const toScore = new Set(brandNames);
  if (claimedBrand) toScore.add(claimedBrand);

  const scores = [...toScore]
    .map(name => scoreSingleBrand(name, visionOutput))
    .filter(s => s.score > 0 || s.brand === claimedBrand)
    .sort((a, b) => b.score - a.score);

  return scores;
}

/**
 * Determine if brand confidence is high enough to trust, or if we should flag for review.
 */
export function assessBrandConfidence(scores = [], visionConfidence = 0.5) {
  if (!scores.length) return { trusted: false, reason: "no_evidence", topBrand: null, topScore: 0 };

  const top     = scores[0];
  const second  = scores[1];

  // Trusted: top brand has strong evidence AND is well ahead of second place
  const gap       = second ? top.score - second.score : top.score;
  const trusted   = top.score >= 0.55 && gap >= 0.15 && top.hasTextEvidence || top.hasLogoEvidence;
  const contested = second && gap < 0.15 && top.score >= 0.4;

  let reason;
  if (trusted)           reason = "strong_evidence";
  else if (contested)    reason = `contested_with_${second.brand}`;
  else if (top.score < 0.3) reason = "weak_evidence";
  else                   reason = "moderate_evidence";

  return {
    trusted,
    contested,
    reason,
    topBrand:  top.brand,
    topScore:  top.score,
    alternatives: scores.slice(1, 3).filter(s => s.score > 0.25),
  };
}

/**
 * Master logo confidence payload builder.
 */
export function buildLogoConfidencePayload(visionOutput = {}) {
  const scores     = scoreAllBrands(visionOutput);
  const assessment = assessBrandConfidence(scores, visionOutput?.confidence);
  const top        = scores[0];

  return {
    logoConfidence: {
      scores:       scores.slice(0, 5),
      assessment,
      topBrand:     assessment.topBrand,
      topScore:     assessment.topScore,
      trusted:      assessment.trusted,
      contested:    assessment.contested || false,
      alternatives: assessment.alternatives,
    },
    topSignal: top
      ? `${top.brand} logo confidence: ${(top.score * 100).toFixed(0)}% (${assessment.reason})`
      : null,
  };
}
