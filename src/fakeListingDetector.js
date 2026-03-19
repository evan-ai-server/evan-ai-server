// src/fakeListingDetector.js
// Fake / scam listing detector: scores a listing 0-100 for counterfeit/fraud risk
// using price floor violations, seller profile red flags, description anomaly
// patterns, image quality signals, and known scam phrase signatures.
// "7 counterfeit indicators detected — extremely high fake risk."

// ── Scam phrase registry ──────────────────────────────────────────────────────
const SCAM_PHRASES = [
  "100% authentic guaranteed",
  "comes with certificate of authenticity",
  "aaa quality",
  "1:1 replica",
  "best quality",
  "same as original",
  "factory price",
  "wholesale",
  "dhl free shipping",
  "from china",
  "from hong kong",
  "no return",
  "as is no refund",
  "paypal friends",
  "venmo only",
  "zelle only",
  "cash app only",
  "wire transfer",
  "western union",
  "gift card payment",
  "too busy to ship",
  "only serious buyers",
  "don't waste my time",
  "price is final no offers",
  "must sell today",
  "moving out sale",
  "item located abroad",
  "will ship from overseas",
  "dhgate",
  "taobao",
  "aliexpress",
];

// ── Suspicious price floors by category (% of typical retail) ────────────────
const SUSPICION_PRICE_FLOOR_PCT = {
  sneakers:    0.25, // below 25% of typical market = suspicious
  bag:         0.20,
  watch:       0.20,
  electronics: 0.30,
  apparel:     0.15,
  eyewear:     0.20,
  default:     0.25,
};

// ── Indicator weights ─────────────────────────────────────────────────────────
const INDICATOR_WEIGHTS = {
  price_too_low:          30,
  scam_phrase_detected:   20,
  new_seller_luxury:      20,
  no_returns:             10,
  stock_photo_only:       10,
  vague_description:      10,
  payment_method_risk:    15,
  description_empty:      12,
  mismatched_category:    10,
  multiple_same_listing:   8,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Detect scam phrases in listing description/title.
 */
function detectScamPhrases(text = "") {
  const lower = String(text).toLowerCase();
  return SCAM_PHRASES.filter(p => lower.includes(p));
}

/**
 * Score a single listing for fake/fraud risk.
 * Returns 0-100 risk score + indicators list.
 */
export function scoreFakeListingRisk({
  title            = "",
  description      = "",
  price            = null,
  medianMarket     = null,
  category         = "",
  sellerFeedback   = null,   // total feedback count
  sellerIsNew      = false,
  noReturns        = false,
  stockPhotoOnly   = false,
  paymentMethod    = "",     // e.g. "paypal_ff", "zelle", "ebay"
  hasMultipleSame  = false,
  visionConfidence = null,
} = {}) {
  const cat       = String(category || "").toLowerCase().replace(/s$/, "");
  const fullText  = `${title} ${description}`.toLowerCase();
  const indicators = [];
  let rawScore = 0;

  // ── Price too low ───────────────────────────────────────────────────────────
  const listPrice  = finiteOrNull(price);
  const marketMed  = finiteOrNull(medianMarket);
  if (listPrice && marketMed) {
    const floorPct = SUSPICION_PRICE_FLOOR_PCT[cat] ?? SUSPICION_PRICE_FLOOR_PCT.default;
    if (listPrice < marketMed * floorPct) {
      const discount = Math.round((1 - listPrice / marketMed) * 100);
      indicators.push({
        key:      "price_too_low",
        label:    `Price ${discount}% below market — far below authentic floor`,
        severity: "critical",
        weight:   INDICATOR_WEIGHTS.price_too_low,
      });
      rawScore += INDICATOR_WEIGHTS.price_too_low;
    }
  }

  // ── Scam phrases ────────────────────────────────────────────────────────────
  const scamFound = detectScamPhrases(fullText);
  if (scamFound.length > 0) {
    const w = Math.min(INDICATOR_WEIGHTS.scam_phrase_detected * scamFound.length, 40);
    indicators.push({
      key:      "scam_phrase_detected",
      label:    `Scam phrase(s) detected: "${scamFound.slice(0, 3).join('", "')}"`,
      severity: scamFound.length >= 2 ? "critical" : "high",
      weight:   w,
      matches:  scamFound,
    });
    rawScore += w;
  }

  // ── New seller + luxury item ────────────────────────────────────────────────
  const isLuxuryCat = ["bag", "watch", "eyewear"].includes(cat);
  const isNewSeller = sellerIsNew || (finiteOrNull(sellerFeedback) !== null && sellerFeedback < 10);
  if (isNewSeller && isLuxuryCat) {
    indicators.push({
      key:      "new_seller_luxury",
      label:    `New/unverified seller listing a ${cat} — high-risk combination`,
      severity: "high",
      weight:   INDICATOR_WEIGHTS.new_seller_luxury,
    });
    rawScore += INDICATOR_WEIGHTS.new_seller_luxury;
  } else if (isNewSeller) {
    indicators.push({
      key:      "new_seller",
      label:    `Seller has fewer than 10 feedback — unverified`,
      severity: "moderate",
      weight:   8,
    });
    rawScore += 8;
  }

  // ── No returns ──────────────────────────────────────────────────────────────
  if (noReturns || fullText.includes("no return") || fullText.includes("all sales final")) {
    indicators.push({
      key:      "no_returns",
      label:    "No returns accepted — common in counterfeit listings",
      severity: "moderate",
      weight:   INDICATOR_WEIGHTS.no_returns,
    });
    rawScore += INDICATOR_WEIGHTS.no_returns;
  }

  // ── Stock photo only ────────────────────────────────────────────────────────
  if (stockPhotoOnly) {
    indicators.push({
      key:      "stock_photo_only",
      label:    "Stock/internet photos only — seller may not have the item",
      severity: "high",
      weight:   INDICATOR_WEIGHTS.stock_photo_only,
    });
    rawScore += INDICATOR_WEIGHTS.stock_photo_only;
  }

  // ── Description empty or vague ──────────────────────────────────────────────
  const descLen = String(description || "").trim().length;
  if (descLen === 0) {
    indicators.push({
      key:      "description_empty",
      label:    "No description provided",
      severity: "moderate",
      weight:   INDICATOR_WEIGHTS.description_empty,
    });
    rawScore += INDICATOR_WEIGHTS.description_empty;
  } else if (descLen < 30) {
    indicators.push({
      key:      "vague_description",
      label:    "Description is extremely short / vague",
      severity: "low",
      weight:   INDICATOR_WEIGHTS.vague_description,
    });
    rawScore += INDICATOR_WEIGHTS.vague_description;
  }

  // ── Risky payment method ────────────────────────────────────────────────────
  const riskyPayments = ["paypal_ff", "zelle", "venmo", "cash_app", "wire", "western_union", "gift_card"];
  const pm = String(paymentMethod || "").toLowerCase().replace(/\s+/g, "_");
  if (riskyPayments.some(r => pm.includes(r.replace("_", "")) || fullText.includes(r.replace("_", " ")))) {
    indicators.push({
      key:      "payment_method_risk",
      label:    "Risky payment method — no buyer protection",
      severity: "high",
      weight:   INDICATOR_WEIGHTS.payment_method_risk,
    });
    rawScore += INDICATOR_WEIGHTS.payment_method_risk;
  }

  // ── Multiple same listing ───────────────────────────────────────────────────
  if (hasMultipleSame) {
    indicators.push({
      key:      "multiple_same_listing",
      label:    "Seller has multiple identical listings — ghost/bulk fake pattern",
      severity: "moderate",
      weight:   INDICATOR_WEIGHTS.multiple_same_listing,
    });
    rawScore += INDICATOR_WEIGHTS.multiple_same_listing;
  }

  // ── Low vision confidence on known-fake-targeted brand ─────────────────────
  const vc = finiteOrNull(visionConfidence);
  if (vc !== null && vc < 0.55 && isLuxuryCat) {
    indicators.push({
      key:      "vision_uncertainty",
      label:    "AI vision confidence is low — item may not match description",
      severity: "moderate",
      weight:   8,
    });
    rawScore += 8;
  }

  // ── Normalize to 0-100 ──────────────────────────────────────────────────────
  const riskScore = Math.min(100, Math.round(rawScore));
  const tier      = riskScore >= 70 ? "extreme"
                  : riskScore >= 45 ? "high"
                  : riskScore >= 25 ? "moderate"
                  : riskScore >= 10 ? "low"
                  : "clean";

  const SEVERITY_ORDER = { critical: 4, high: 3, moderate: 2, low: 1 };
  indicators.sort((a, b) => (SEVERITY_ORDER[b.severity] || 0) - (SEVERITY_ORDER[a.severity] || 0));

  return {
    riskScore,
    tier,
    indicatorCount: indicators.length,
    indicators,
    isSuspect:      riskScore >= 25,
    isLikelyFake:   riskScore >= 45,
    topSignal: indicators.length
      ? `${indicators.length} fraud indicator${indicators.length !== 1 ? "s" : ""} — ${tier} fake risk (score ${riskScore}/100): ${indicators[0].label}`
      : `No fraud indicators detected (score ${riskScore}/100)`,
  };
}

/**
 * Score all market items and flag suspicious ones.
 */
export function scanMarketForFakes(uiItems = [], medianMarket = null, category = "") {
  const flagged = [];
  for (const item of uiItems) {
    const result = scoreFakeListingRisk({
      title:       item?.title || item?.name || "",
      description: item?.description || "",
      price:       item?.totalPrice ?? item?.price,
      medianMarket,
      category,
      sellerFeedback: item?.sellerFeedback ?? item?.feedbackCount ?? null,
      sellerIsNew:    item?.sellerIsNew    || false,
      noReturns:      item?.noReturns      || false,
      stockPhotoOnly: item?.stockPhotoOnly || false,
    });
    if (result.isSuspect) {
      flagged.push({ item, fakeScore: result });
    }
  }
  flagged.sort((a, b) => b.fakeScore.riskScore - a.fakeScore.riskScore);
  return flagged;
}

/**
 * Master fake listing detector payload.
 */
export function buildFakeListingDetectorPayload({
  title            = "",
  description      = "",
  scannedPrice     = null,
  medianMarket     = null,
  category         = "",
  sellerFeedback   = null,
  sellerIsNew      = false,
  noReturns        = false,
  stockPhotoOnly   = false,
  paymentMethod    = "",
  visionConfidence = null,
  uiItems          = [],
} = {}) {
  const listingScore = scoreFakeListingRisk({
    title, description,
    price:           finiteOrNull(scannedPrice),
    medianMarket:    finiteOrNull(medianMarket),
    category,
    sellerFeedback, sellerIsNew, noReturns,
    stockPhotoOnly, paymentMethod, visionConfidence,
  });

  const marketFakes = scanMarketForFakes(
    uiItems,
    finiteOrNull(medianMarket),
    category,
  );

  return {
    listing:           listingScore,
    marketSuspects:    marketFakes,
    suspectCount:      marketFakes.length,
    topSignal:         listingScore.topSignal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
