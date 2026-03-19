// src/sellerProfileIntelligence.js
// Seller trust analyzer: feedback score, account age signals, listing quality,
// red flag detection, and trust tier recommendation.

// ── Feedback score trust curve ────────────────────────────────────────────────
// Maps feedback percentage ranges to trust contribution
function feedbackToTrust(feedbackPct) {
  if (feedbackPct === null) return 0.50; // unknown
  if (feedbackPct >= 99.5)  return 0.95;
  if (feedbackPct >= 98.0)  return 0.80;
  if (feedbackPct >= 95.0)  return 0.60;
  if (feedbackPct >= 90.0)  return 0.40;
  if (feedbackPct >= 80.0)  return 0.20;
  return 0.05;
}

// ── Review count trust curve ─────────────────────────────────────────────────
function reviewCountToTrust(count) {
  if (count === null) return 0.50;
  if (count >= 1000)  return 0.90;
  if (count >= 500)   return 0.80;
  if (count >= 100)   return 0.65;
  if (count >= 50)    return 0.55;
  if (count >= 20)    return 0.45;
  if (count >= 5)     return 0.35;
  return 0.15; // very new account
}

// ── Luxury brand price floors for red flag detection ─────────────────────────
const LUXURY_BRANDS = new Set([
  "rolex", "patek", "ap", "chanel", "hermes", "louis vuitton", "gucci",
  "prada", "dior", "moncler", "canada goose", "off-white", "fear of god",
  "supreme box logo", "jordan", "yeezy",
]);

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Classify seller type from available signals.
 */
export function classifySellerType({
  feedbackCount   = null,
  feedbackPct     = null,
  isPowerSeller   = false,
  isTopRated      = false,
  storeExists     = false,
  username        = "",
} = {}) {
  const count = finiteOrNull(feedbackCount) ?? 0;

  if (isPowerSeller || isTopRated || storeExists || count >= 500) {
    return { type: "power_seller",   label: "Power Seller",   baselineTrust: 0.80 };
  }
  if (count >= 50) {
    return { type: "established",    label: "Established Seller", baselineTrust: 0.65 };
  }
  if (count >= 10) {
    return { type: "casual",         label: "Casual Seller",  baselineTrust: 0.50 };
  }
  if (count >= 1) {
    return { type: "new_with_sales", label: "New Seller",     baselineTrust: 0.35 };
  }
  return     { type: "brand_new",    label: "Brand New Account", baselineTrust: 0.15 };
}

/**
 * Detect red flags from seller + item context.
 */
export function detectSellerRedFlags({
  feedbackCount    = null,
  feedbackPct      = null,
  noReturns        = false,
  onlyStockPhotos  = false,
  descriptionEmpty = false,
  priceWayBelow    = false, // price well below auth market value
  brandName        = "",
  listingPrice     = null,
  brandPriceFloor  = null,
  accountAgeDays   = null,
} = {}) {
  const flags = [];
  const count  = finiteOrNull(feedbackCount) ?? 0;
  const brand  = String(brandName || "").toLowerCase();
  const isLuxury = [...LUXURY_BRANDS].some(b => brand.includes(b));

  // New account selling luxury/premium item
  if (count < 10 && isLuxury) {
    flags.push({
      key:      "new_account_luxury",
      severity: "critical",
      label:    "New account selling luxury/premium item",
      detail:   "High-value items from brand-new accounts are a major counterfeit signal",
    });
  }

  // No returns policy on a high-value item
  if (noReturns && isLuxury) {
    flags.push({
      key:      "no_returns_luxury",
      severity: "high",
      label:    "No returns policy on luxury item",
      detail:   "Legitimate luxury resellers almost always accept returns",
    });
  }

  // Price well below brand price floor
  const price = finiteOrNull(listingPrice);
  const floor = finiteOrNull(brandPriceFloor);
  if (price && floor && price < floor * 0.70) {
    flags.push({
      key:      "price_below_floor",
      severity: "critical",
      label:    `Price ($${price.toFixed(2)}) is far below authentic price floor ($${floor.toFixed(2)})`,
      detail:   "Prices this low on premium items are almost always counterfeit",
    });
  }

  // Only stock photos
  if (onlyStockPhotos) {
    flags.push({
      key:      "stock_photos_only",
      severity: "high",
      label:    "Only stock/manufacturer photos — no actual item photos",
      detail:   "Request real photos before buying. Stock-only = can't verify condition or authenticity.",
    });
  }

  // Empty or minimal description
  if (descriptionEmpty) {
    flags.push({
      key:      "no_description",
      severity: "moderate",
      label:    "No item description provided",
      detail:   "Quality sellers provide detailed descriptions. Missing = lower confidence.",
    });
  }

  // Very low feedback score
  if (feedbackPct !== null && feedbackPct < 90) {
    flags.push({
      key:      "low_feedback",
      severity: feedbackPct < 80 ? "critical" : "high",
      label:    `Low feedback score: ${feedbackPct.toFixed(1)}%`,
      detail:   "Feedback below 90% indicates a problematic selling history",
    });
  }

  // New account (any item)
  if (count < 5 && accountAgeDays !== null && accountAgeDays < 90) {
    flags.push({
      key:      "very_new_account",
      severity: isLuxury ? "critical" : "moderate",
      label:    `Account is ${accountAgeDays} days old with ${count} feedback`,
      detail:   "Very new accounts have no track record",
    });
  }

  return flags;
}

/**
 * Compute a composite seller trust score from all signals.
 */
export function computeSellerTrustScore({
  feedbackCount    = null,
  feedbackPct      = null,
  isPowerSeller    = false,
  isTopRated       = false,
  storeExists      = false,
  noReturns        = false,
  onlyStockPhotos  = false,
  descriptionEmpty = false,
  brandName        = "",
  listingPrice     = null,
  brandPriceFloor  = null,
  accountAgeDays   = null,
  username         = "",
} = {}) {
  const sellerType = classifySellerType({ feedbackCount, feedbackPct, isPowerSeller, isTopRated, storeExists, username });
  const redFlags   = detectSellerRedFlags({ feedbackCount, feedbackPct, noReturns, onlyStockPhotos, descriptionEmpty, brandName, listingPrice, brandPriceFloor, accountAgeDays });

  // Base trust from seller type
  let trust = sellerType.baselineTrust;

  // Adjust from feedback signals
  const fbTrust    = feedbackToTrust(feedbackPct);
  const cntTrust   = reviewCountToTrust(finiteOrNull(feedbackCount));
  trust = trust * 0.40 + fbTrust * 0.35 + cntTrust * 0.25;

  // Bonuses
  if (isPowerSeller || isTopRated) trust = Math.min(1, trust + 0.10);
  if (storeExists)                 trust = Math.min(1, trust + 0.05);

  // Penalties from red flags
  for (const flag of redFlags) {
    const penalty = flag.severity === "critical" ? 0.30
                  : flag.severity === "high"     ? 0.15
                  : 0.07;
    trust = Math.max(0, trust - penalty);
  }

  trust = round2(trust);

  const tier = trust >= 0.75 ? "trusted"
             : trust >= 0.55 ? "acceptable"
             : trust >= 0.35 ? "caution"
             : "avoid";

  const TIER_ADVICE = {
    trusted:    "High-trust seller — safe to proceed",
    acceptable: "Acceptable seller — standard due diligence applies",
    caution:    "Proceed carefully — verify item authenticity and request photos",
    avoid:      "Avoid this seller — multiple risk signals present",
  };

  return {
    trustScore:  trust,
    tier,
    advice:      TIER_ADVICE[tier],
    sellerType,
    redFlags,
    criticalFlags: redFlags.filter(f => f.severity === "critical"),
    signal: redFlags.length
      ? `${redFlags[0].label}`
      : TIER_ADVICE[tier],
  };
}

/**
 * Master seller profile intelligence payload.
 * Designed to work with whatever subset of signals is available.
 */
export function buildSellerProfilePayload(sellerData = {}) {
  const result = computeSellerTrustScore(sellerData);
  return {
    trustScore:    result.trustScore,
    tier:          result.tier,
    advice:        result.advice,
    sellerType:    result.sellerType,
    redFlags:      result.redFlags,
    criticalFlags: result.criticalFlags,
    topSignal:     result.signal,
    shouldProceed: result.tier === "trusted" || result.tier === "acceptable",
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
