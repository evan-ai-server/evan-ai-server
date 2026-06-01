// src/confidenceCalibration.js
// Phase 4A.1 — Real-time evidence-based confidence calibration.
//
// Separate from src/confidenceCalibrationEngine.js (historical/outcome calibration).
// This module runs synchronously at payload-build time and answers:
//   - What kind of evidence do we actually have?
//   - How much should Evan trust the market result?
//   - How strongly is Evan allowed to speak?
//
// Pure synchronous function: no I/O, no side effects, no network.

// ── Evidence tier ordering ────────────────────────────────────────────────────
// Confidence ceiling by evidence tier
const TIER_CONFIDENCE_CAP = {
  verified_strong:       0.95,
  verified_moderate:     0.85,
  verified_thin:         0.70,
  pricing_signal_strong: 0.72,
  pricing_signal_only:   0.62,
  thin_pricing_signal:   0.50,
  estimate_only:         0.40,
  no_evidence:           0.15,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function isAircraftCategory(category, query) {
  const c = String(category || "").toLowerCase();
  const q = String(query    || "").toLowerCase();
  return (
    c.includes("aircraft") || c.includes("airplane") ||
    c.includes("model airplane") || c.includes("diecast") ||
    c.includes("model plane") ||
    q.includes("airline") || q.includes("boeing") ||
    q.includes("airbus") || q.includes("diecast model")
  );
}

function isCategoryHighStakes(category) {
  const c = String(category || "").toLowerCase();
  return (
    c.includes("eyewear") || c.includes("glass") || c.includes("sunglass") ||
    c.includes("jewelry") || c.includes("ring") || c.includes("bracelet") ||
    c.includes("necklace") || c.includes("watch") || c.includes("bag") ||
    c.includes("purse") || c.includes("handbag") || c.includes("electronic") ||
    c.includes("phone") || c.includes("laptop") || c.includes("tablet") ||
    c.includes("aircraft") || c.includes("airplane") || c.includes("diecast") ||
    c.includes("model plane") || c.includes("model airplane")
  );
}

// ── Risk computation ──────────────────────────────────────────────────────────

function computeSpreadRisk(marketEvidence) {
  const pct = Number(marketEvidence?.priceSpreadPct ?? 0);
  if (pct >= 80) return 1.00;
  if (pct >= 50) return 0.65;
  if (pct >= 30) return 0.35;
  return 0.10;
}

function computeUrlTrustRisk(verifiedListingCount) {
  if (verifiedListingCount >= 5) return 0.00;
  if (verifiedListingCount >= 3) return 0.25;
  if (verifiedListingCount >= 1) return 0.50;
  return 1.00;
}

function computeThinMarketRisk(cleanCompCount) {
  if (cleanCompCount === 0) return 1.00;
  if (cleanCompCount <  3) return 0.85;
  if (cleanCompCount <  5) return 0.60;
  if (cleanCompCount <  8) return 0.30;
  return 0.00;
}

function computeIdentityRisk({ rejectionRatio, identityQuality }) {
  let risk = 0;
  if      (rejectionRatio > 0.40) risk += 0.50;
  else if (rejectionRatio > 0.30) risk += 0.35;
  else if (rejectionRatio > 0.15) risk += 0.20;

  if      (identityQuality < 0.25) risk += 0.40;
  else if (identityQuality < 0.40) risk += 0.20;
  else if (identityQuality < 0.55) risk += 0.10;

  return clamp01(risk);
}

function computeCategoryRisk(category, identityQuality) {
  if (!isCategoryHighStakes(category)) return 0.0;
  if (identityQuality < 0.35) return 0.70;
  if (identityQuality < 0.55) return 0.40;
  return 0.15;
}

// ── Evidence tier classification ──────────────────────────────────────────────

function classifyEvidenceTier({
  verifiedListingCount,
  pricingSignalCount,
  oracleEstimateCount,
  cleanCompCount,
  spreadRisk,
  identityRisk,
}) {
  if (verifiedListingCount >= 5 && cleanCompCount >= 4 && spreadRisk <= 0.35) {
    return "verified_strong";
  }
  if (verifiedListingCount >= 2 && cleanCompCount >= 3) {
    return "verified_moderate";
  }
  if (verifiedListingCount === 1) {
    return "verified_thin";
  }
  // verifiedListingCount === 0
  if (pricingSignalCount >= 8 && cleanCompCount >= 4 && spreadRisk <= 0.5 && identityRisk <= 0.5) {
    return "pricing_signal_strong";
  }
  if (pricingSignalCount >= 4) {
    return "pricing_signal_only";
  }
  // estimate_only checked BEFORE thin_pricing_signal so oracle-only scans
  // aren't misclassified when cleanCompCount > 0 but signals = 0.
  if (oracleEstimateCount > 0 && pricingSignalCount === 0) {
    return "estimate_only";
  }
  if (pricingSignalCount > 0 || cleanCompCount > 0) {
    return "thin_pricing_signal";
  }
  return "no_evidence";
}

// ── Cap reasons ───────────────────────────────────────────────────────────────

function buildCapReasons({
  verifiedListingCount,
  cleanCompCount,
  spreadRisk,
  rejectionRatio,
  identitySummary,
  sourceDiversity,
  oracleEstimateCount,
  visionConfidence,
  identityQuality,
  scannedPrice,
  consensus,
  evidenceTier,
  category,
  query,
}) {
  const reasons = [];
  const isAircraft = isAircraftCategory(category, query);

  if (verifiedListingCount === 0)      reasons.push("no_verified_listings");
  if (cleanCompCount < 5)              reasons.push("thin_market");
  if (spreadRisk > 0.5)                reasons.push("wide_spread");
  if (rejectionRatio > 0.25)           reasons.push("identity_lock_high_rejection_ratio");

  if (isAircraft) {
    const compCt   = identitySummary?.rejectedCompetitorCount    ?? 0;
    const familyCt = identitySummary?.rejectedModelMismatchCount ?? 0;
    const toyCt    = identitySummary?.rejectedGenericToyCount    ?? 0;
    if (compCt   > 0) reasons.push("aircraft_competitor_match");
    if (familyCt > 0) reasons.push("aircraft_family_mismatch");
    if (toyCt    > 0) reasons.push("aircraft_generic_toy_contamination");
    if (compCt   > 0) reasons.push("competitor_brand_present");
  } else {
    const compCt = identitySummary?.rejectedCompetitorCount ?? 0;
    if (compCt > 0) reasons.push("competitor_brand_present");
  }

  if (sourceDiversity <= 1 && cleanCompCount < 6) reasons.push("single_source");
  if (evidenceTier === "estimate_only")            reasons.push("oracle_only");
  if (visionConfidence < 0.40)                    reasons.push("vision_confidence_low");
  if (identityQuality  < 0.25)                    reasons.push("identity_quality_low");

  // Scanned price clearly above pricing-signal cluster
  const typicalHigh = Number(consensus?.typicalHigh ?? consensus?.median ?? 0);
  if (
    verifiedListingCount === 0 &&
    scannedPrice != null &&
    Number.isFinite(scannedPrice) &&
    typicalHigh > 0 &&
    scannedPrice > typicalHigh * 1.15
  ) {
    reasons.push("pricing_signal_against_high_scan_price");
  }

  return [...new Set(reasons)];
}

// ── Verdict strength ──────────────────────────────────────────────────────────

function computeVerdictStrengthCap({
  evidenceTier,
  cleanCompCount,
  spreadRisk,
  identityRisk,
  marketEvidenceConfidence,
}) {
  if (evidenceTier === "verified_strong" || evidenceTier === "verified_moderate") {
    if (
      cleanCompCount >= 4 &&
      spreadRisk <= 0.35 &&
      identityRisk <= 0.5 &&
      marketEvidenceConfidence === "high"
    ) return "strong";
    return "moderate";
  }
  if (evidenceTier === "verified_thin" || evidenceTier === "pricing_signal_strong") {
    return "moderate";
  }
  if (evidenceTier === "pricing_signal_only") {
    if (spreadRisk > 0.5 || identityRisk > 0.65) return "evidence_limited";
    return "soft";
  }
  return "evidence_limited";
}

// ── Market confidence (authoritative) ────────────────────────────────────────

function computeMarketConf({ evidenceTier, consensus, marketEvidence }) {
  const rawMktConf  = Number(consensus?.marketConfidence ?? 0);
  const TIER_DAMP = {
    verified_strong:       1.00,
    verified_moderate:     0.90,
    verified_thin:         0.75,
    pricing_signal_strong: 0.75,
    pricing_signal_only:   0.65,
    thin_pricing_signal:   0.50,
    estimate_only:         0.40,
    no_evidence:           0.15,
  };
  const MEVIDENCE_DAMP = { high: 1.0, medium: 0.85, low: 0.65 };
  const tierDamp  = TIER_DAMP[evidenceTier]                            ?? 0.40;
  const evidDamp  = MEVIDENCE_DAMP[marketEvidence?.confidence ?? "low"] ?? 0.65;
  return round2(clamp01(rawMktConf * tierDamp * evidDamp));
}

// ── Evidence confidence ───────────────────────────────────────────────────────

function computeEvidenceConf({
  verifiedListingCount,
  pricingSignalCount,
  cleanCompCount,
  spreadRisk,
  identityRisk,
  urlTrustRisk,
}) {
  let score = 0;
  score += Math.min(verifiedListingCount / 5, 1) * 0.50;
  score += Math.min(pricingSignalCount / 10, 1)  * 0.25;
  score += Math.min(cleanCompCount / 8, 1)        * 0.25;
  score -= spreadRisk   * 0.15;
  score -= identityRisk * 0.10;
  score -= urlTrustRisk * 0.10;
  return round2(clamp01(score));
}

// ── Source diversity ──────────────────────────────────────────────────────────

function computeSourceDiversity(items) {
  if (!Array.isArray(items)) return 0;
  const groups = new Set(
    items
      .map(x => String(x?.source || "").toLowerCase().split(/[\s\-/]/)[0])
      .filter(Boolean)
  );
  return groups.size;
}

function computeMarketMathEligibleCount(items) {
  if (!Array.isArray(items)) return 0;
  return items.filter(x => {
    const p = Number(x?.totalPrice ?? x?.price);
    return Number.isFinite(p) && p > 0;
  }).length;
}

// ── Explanation text ──────────────────────────────────────────────────────────

function buildExplanationForUI(evidenceTier) {
  const MAP = {
    verified_strong:       "Strong verified market — multiple direct listings confirmed.",
    verified_moderate:     "Moderate verified evidence — some direct listings confirmed.",
    verified_thin:         "Thin verified evidence — only one direct listing found.",
    pricing_signal_strong: "Strong pricing signal — no verified listings, but many clean comps with tight spread.",
    pricing_signal_only:   "Pricing signal only — no verified direct listings. Treat resale estimates as signals.",
    thin_pricing_signal:   "Limited market evidence — few comps found. Evan can't confirm the price range.",
    estimate_only:         "AI estimate only — no live market listings found.",
    no_evidence:           "No market evidence found — insufficient data for a confident call.",
  };
  return MAP[evidenceTier] || MAP.no_evidence;
}

function buildExplanationForLogs(
  evidenceTier, verifiedListingCount, pricingSignalCount, cleanCompCount, capApplied, capReasons
) {
  return (
    `evidenceTier=${evidenceTier} verified=${verifiedListingCount}` +
    ` signals=${pricingSignalCount} comps=${cleanCompCount}` +
    ` capApplied=${capApplied} reasons=[${capReasons.join(",")}]`
  );
}

// ── Main exported function ────────────────────────────────────────────────────

export function calibrateEvidenceConfidence({
  visionConfidence  = 0.5,
  visualConfidence  = 0,
  brandCertainty    = 0,
  identityQuality   = 0,
  items             = [],
  marketEvidence    = null,
  consensus         = null,
  identitySummary   = null,   // optional — null triggers fallback approximation
  urlSummary        = null,   // CLEAN summary from uiItems (post-identity-lock)
  rawUrlSummary     = null,   // RAW summary from _rawSourceItems (pre-filter; used only for rejection ratio approx)
  scannedPrice      = null,
  category          = null,
  cacheKind         = null,
  query             = "",
  scanId            = null,   // eslint-disable-line no-unused-vars — reserved for future use
} = {}) {

  const uiItemArray = Array.isArray(items) ? items : [];

  // ── 1. Evidence counts ─────────────────────────────────────────────────────
  // urlSummary = CLEAN post-identity-lock counts (from uiItems).
  // rawUrlSummary = pre-filter counts (used only for rejection ratio approximation).
  // items = uiItems (post-filter) — authoritative for cleanCompCount.
  // Evidence quality must come from the clean pool only, never raw source items.
  const verifiedListingCount   = Number(urlSummary?.verifiedListings ??
    uiItemArray.filter(i => i?.isVerifiedListing === true).length);
  const pricingSignalCount     = Number(urlSummary?.pricingOnly ??
    uiItemArray.filter(i => i?.evidenceQuality === "pricing_signal" || i?.clickable === false).length);
  const oracleEstimateCount    = Number(urlSummary?.oracleEstimates ??
    uiItemArray.filter(i => i?.evidenceQuality === "oracle_estimate").length);
  const cleanCompCount          = uiItemArray.length;
  const marketMathEligibleCount = computeMarketMathEligibleCount(uiItemArray);
  const sourceDiversity         = computeSourceDiversity(uiItemArray);

  // Rejection counts — from identitySummary if provided, else approximate
  const rejectedCompetitorCount     = Number(identitySummary?.rejectedCompetitorCount     ?? 0);
  const rejectedFamilyCount         = Number(identitySummary?.rejectedModelMismatchCount  ?? 0);
  const rejectedModelMismatchCount  = Number(identitySummary?.rejectedModelMismatchCount  ?? 0);
  const rejectedMissingAirlineCount = Number(identitySummary?.rejectedMissingAirlineCount ?? 0);
  const rejectedGenericToyCount     = Number(identitySummary?.rejectedGenericToyCount     ?? 0);

  let totalRejectedCount;
  if (identitySummary !== null) {
    totalRejectedCount =
      rejectedCompetitorCount +
      rejectedModelMismatchCount +
      rejectedMissingAirlineCount +
      rejectedGenericToyCount;
  } else {
    // Approximate: difference between raw pre-filter pool and clean post-filter pool.
    // Must use rawUrlSummary.total (pre-lock), not urlSummary.total (clean = same as cleanCompCount).
    // TODO Phase 4A.2+: plumb exact per-reason rejection counts from filterRelevantListings /
    // applyAircraftFamilyLock / applySneakerIdentityLock / applyJordanIdentityLock return values.
    const rawTotal = Number(rawUrlSummary?.total ?? 0);
    totalRejectedCount = Math.max(0, rawTotal - cleanCompCount);
  }

  const rejectionRatio = (totalRejectedCount + cleanCompCount) > 0
    ? round2(totalRejectedCount / (totalRejectedCount + cleanCompCount))
    : 0;

  // ── 2. Risk scores ─────────────────────────────────────────────────────────
  const iq           = clamp01(Number(identityQuality));
  const vc           = clamp01(Number(visionConfidence));
  const spreadRisk   = computeSpreadRisk(marketEvidence);
  const urlTrustRisk = computeUrlTrustRisk(verifiedListingCount);
  const thinMktRisk  = computeThinMarketRisk(cleanCompCount);
  const identityRisk = computeIdentityRisk({ rejectionRatio, identityQuality: iq });
  const categoryRisk = computeCategoryRisk(category, iq);

  // ── 3. Evidence tier ───────────────────────────────────────────────────────
  const evidenceTier = classifyEvidenceTier({
    verifiedListingCount,
    pricingSignalCount,
    oracleEstimateCount,
    cleanCompCount,
    spreadRisk,
    identityRisk,
  });

  // ── 4. Confidence cap ──────────────────────────────────────────────────────
  const confidenceCap        = TIER_CONFIDENCE_CAP[evidenceTier] ?? 0.40;
  const calibratedConfidence = round2(Math.min(vc, confidenceCap));
  const capApplied           = vc > confidenceCap;

  // ── 5. Cap reasons ─────────────────────────────────────────────────────────
  const capReasons = buildCapReasons({
    verifiedListingCount,
    cleanCompCount,
    spreadRisk,
    rejectionRatio,
    identitySummary,
    sourceDiversity,
    oracleEstimateCount,
    visionConfidence:   vc,
    identityQuality:    iq,
    scannedPrice:       Number.isFinite(Number(scannedPrice)) ? Number(scannedPrice) : null,
    consensus,
    evidenceTier,
    category,
    query,
  });

  // ── 6. Verdict strength cap ───────────────────────────────────────────────
  const verdictStrengthCap = computeVerdictStrengthCap({
    evidenceTier,
    cleanCompCount,
    spreadRisk,
    identityRisk,
    marketEvidenceConfidence: marketEvidence?.confidence ?? "low",
  });

  // ── 7. Language gates ──────────────────────────────────────────────────────
  const canShowVerifiedLanguage      = verifiedListingCount >= 1 && marketEvidence?.confidence !== "low";
  const canShowStrongLanguage        = verdictStrengthCap === "strong";
  const canShowMedianAsAuthoritative = cleanCompCount >= 4 && spreadRisk <= 0.5;

  // ── 8. Derived confidence signals ─────────────────────────────────────────
  const marketConfidence   = computeMarketConf({ evidenceTier, consensus, marketEvidence });
  const evidenceConfidence = computeEvidenceConf({
    verifiedListingCount, pricingSignalCount, cleanCompCount,
    spreadRisk, identityRisk, urlTrustRisk,
  });

  // ── 9. Explanations ────────────────────────────────────────────────────────
  const explanationForUI   = buildExplanationForUI(evidenceTier);
  const explanationForLogs = buildExplanationForLogs(
    evidenceTier, verifiedListingCount, pricingSignalCount, cleanCompCount, capApplied, capReasons
  );

  return {
    inputs: {
      visionConfidence:  round2(vc),
      visualConfidence:  round2(clamp01(Number(visualConfidence))),
      brandCertainty:    round2(clamp01(Number(brandCertainty))),
      identityQuality:   round2(iq),
      category:          category  || null,
      scannedPrice:      Number.isFinite(Number(scannedPrice)) ? Number(scannedPrice) : null,
      cacheKind:         cacheKind || null,
    },
    evidence: {
      verifiedListingCount,
      pricingSignalCount,
      oracleEstimateCount,
      cleanCompCount,
      marketMathEligibleCount,
      rejectedCompetitorCount,
      rejectedFamilyCount,
      rejectedModelMismatchCount,
      rejectedMissingAirlineCount,
      rejectedGenericToyCount,
      totalRejectedCount,
      rejectionRatio,
      sourceDiversity,
    },
    risks: {
      spreadRisk:     round2(spreadRisk),
      identityRisk:   round2(identityRisk),
      urlTrustRisk:   round2(urlTrustRisk),
      thinMarketRisk: round2(thinMktRisk),
      categoryRisk:   round2(categoryRisk),
    },
    evidenceTier,
    marketConfidence,
    evidenceConfidence,
    calibratedConfidence,
    confidenceCap,
    capApplied,
    capReasons,
    verdictStrengthCap,
    canShowStrongLanguage,
    canShowVerifiedLanguage,
    canShowMedianAsAuthoritative,
    explanationForLogs,
    explanationForUI,
  };
}

// ── Startup self-test ─────────────────────────────────────────────────────────

export function runConfidenceCalibrationSelfTest() {
  const cases = [
    {
      label:  "verified_strong",
      input:  {
        visionConfidence: 0.9,
        identityQuality:  0.8,
        items: Array(5).fill(null).map(() => ({
          isVerifiedListing: true, evidenceQuality: "verified_listing",
          clickable: true, directUrl: "https://ebay.com/item/1",
          price: 60, totalPrice: 60, source: "ebay-a",
        })),
        urlSummary:    { verifiedListings: 5, pricingOnly: 0, oracleEstimates: 0, total: 5 },
        marketEvidence:{ confidence: "high", priceSpreadPct: 15, directUrlCount: 5 },
        consensus:     { marketConfidence: 0.80, listingCount: 5 },
      },
      expect: { evidenceTier: "verified_strong", capApplied: false, calibratedConfidence: 0.9 },
    },
    {
      label:  "verified_moderate",
      input:  {
        visionConfidence: 0.9,
        identityQuality:  0.7,
        items: [
          { isVerifiedListing: true,  evidenceQuality: "verified_listing", clickable: true,  directUrl: "https://ebay.com/item/2", price: 55, source: "ebay-a" },
          { isVerifiedListing: true,  evidenceQuality: "verified_listing", clickable: true,  directUrl: "https://ebay.com/item/3", price: 60, source: "ebay-b" },
          { isVerifiedListing: true,  evidenceQuality: "verified_listing", clickable: true,  directUrl: "https://ebay.com/item/4", price: 65, source: "ebay-c" },
          { isVerifiedListing: false, evidenceQuality: "pricing_signal",   clickable: false, price: 58, source: "amazon-a" },
          { isVerifiedListing: false, evidenceQuality: "pricing_signal",   clickable: false, price: 62, source: "amazon-b" },
        ],
        urlSummary:    { verifiedListings: 3, pricingOnly: 2, oracleEstimates: 0, total: 5 },
        marketEvidence:{ confidence: "medium", priceSpreadPct: 25, directUrlCount: 3 },
        consensus:     { marketConfidence: 0.70 },
      },
      expect: { evidenceTier: "verified_moderate", capApplied: true, calibratedConfidence: 0.85 },
    },
    {
      label:  "verified_thin",
      input:  {
        visionConfidence: 0.9,
        identityQuality:  0.6,
        items: [
          { isVerifiedListing: true,  evidenceQuality: "verified_listing", clickable: true,  directUrl: "https://ebay.com/item/5", price: 60, source: "ebay-a" },
          { isVerifiedListing: false, evidenceQuality: "pricing_signal",   clickable: false, price: 65, source: "amazon-a" },
          { isVerifiedListing: false, evidenceQuality: "pricing_signal",   clickable: false, price: 70, source: "amazon-b" },
          { isVerifiedListing: false, evidenceQuality: "pricing_signal",   clickable: false, price: 63, source: "amazon-c" },
        ],
        urlSummary:    { verifiedListings: 1, pricingOnly: 3, oracleEstimates: 0, total: 4 },
        marketEvidence:{ confidence: "medium", priceSpreadPct: 30, directUrlCount: 1 },
        consensus:     { marketConfidence: 0.60 },
      },
      expect: { evidenceTier: "verified_thin", capApplied: true, calibratedConfidence: 0.70 },
    },
    {
      // Hawaiian Airlines Boeing 787 diecast: 0 verified, 13 clean signals, wide spread.
      // urlSummary uses CLEAN post-filter counts; rawUrlSummary carries the raw total for
      // rejection ratio approximation (unused here since identitySummary is provided).
      label:  "pricing_signal_only_hawaiian_787",
      input:  {
        visionConfidence: 0.9,
        brandCertainty:   0.8,
        identityQuality:  0.55,
        items: Array(13).fill(null).map(() => ({
          isVerifiedListing: false, evidenceQuality: "pricing_signal",
          clickable: false, price: 65, source: "ebay",
        })),
        urlSummary:    { verifiedListings: 0, pricingOnly: 13, oracleEstimates: 0, total: 13 },
        rawUrlSummary: { total: 37 },  // raw pre-filter pool size
        marketEvidence:{ confidence: "low", priceSpreadPct: 80, directUrlCount: 0 },
        consensus:     { marketConfidence: 0.25, typicalHigh: 95 },
        scannedPrice:  165.99,
        identitySummary: {
          rejectedCompetitorCount:     2,
          rejectedModelMismatchCount:  1,
          rejectedMissingAirlineCount: 8,
          rejectedGenericToyCount:     3,
        },
        category: "model airplane",
        query:    "hawaiian airlines boeing 787 diecast model airplane",
      },
      expect: {
        evidenceTier:           "pricing_signal_only",
        capApplied:             true,
        canShowVerifiedLanguage: false,
        canShowStrongLanguage:   false,
      },
    },
    {
      label:  "thin_pricing_signal",
      input:  {
        visionConfidence: 0.75,
        identityQuality:  0.45,
        items: Array(3).fill(null).map(() => ({
          isVerifiedListing: false, evidenceQuality: "pricing_signal",
          clickable: false, price: 20, source: "ebay",
        })),
        urlSummary:    { verifiedListings: 0, pricingOnly: 2, oracleEstimates: 0, total: 2 },
        marketEvidence:{ confidence: "low", priceSpreadPct: 40, directUrlCount: 0 },
        consensus:     { marketConfidence: 0.30 },
      },
      expect: { evidenceTier: "thin_pricing_signal", confidenceCap: 0.50, verdictStrengthCap: "evidence_limited" },
    },
    {
      label:  "estimate_only",
      input:  {
        visionConfidence: 0.70,
        identityQuality:  0.50,
        items: Array(2).fill(null).map(() => ({
          isVerifiedListing: false, evidenceQuality: "oracle_estimate",
          clickable: false, price: 80, source: "oracle",
        })),
        urlSummary:    { verifiedListings: 0, pricingOnly: 0, oracleEstimates: 2, total: 2 },
        marketEvidence:{ confidence: "low", priceSpreadPct: 0, directUrlCount: 0 },
        consensus:     { marketConfidence: 0.0 },
      },
      expect: { evidenceTier: "estimate_only", confidenceCap: 0.40, verdictStrengthCap: "evidence_limited" },
    },
    {
      label:  "no_evidence",
      input:  {
        visionConfidence: 0.8,
        identityQuality:  0.6,
        items:         [],
        urlSummary:    { verifiedListings: 0, pricingOnly: 0, oracleEstimates: 0, total: 0 },
        marketEvidence:{ confidence: "low", priceSpreadPct: 0, directUrlCount: 0 },
        consensus:     { marketConfidence: 0 },
      },
      expect: { evidenceTier: "no_evidence", confidenceCap: 0.15, verdictStrengthCap: "evidence_limited", calibratedConfidence: 0.15 },
    },
    {
      // pricing_signal_strong requires >= 8 clean signals, >= 4 comps, tight spread, low identity risk.
      // urlSummary reflects the CLEAN pool (8 items = 8 pricing signals).
      label:  "pricing_signal_strong",
      input:  {
        visionConfidence: 0.85,
        identityQuality:  0.75,
        items: Array(8).fill(null).map((_, i) => ({
          isVerifiedListing: false, evidenceQuality: "pricing_signal",
          clickable: false, price: 100 + i, source: `store-${i}`,
        })),
        urlSummary:    { verifiedListings: 0, pricingOnly: 8, oracleEstimates: 0, total: 8 },
        marketEvidence:{ confidence: "medium", priceSpreadPct: 20, directUrlCount: 0 },
        consensus:     { marketConfidence: 0.75 },
      },
      expect: { evidenceTier: "pricing_signal_strong", capApplied: true, verdictStrengthCap: "moderate" },
    },
  ];

  let passed = 0;
  const failures = [];

  for (const tc of cases) {
    try {
      const result = calibrateEvidenceConfidence(tc.input);
      let ok = true;
      const mismatches = [];

      for (const [k, expected] of Object.entries(tc.expect)) {
        const actual = result[k];
        if (actual !== expected) {
          ok = false;
          mismatches.push({ field: k, expected, actual });
        }
      }

      if (ok) {
        passed++;
      } else {
        failures.push({ label: tc.label, mismatches });
        console.warn("CONFIDENCE_CALIBRATION_SELFTEST_FAIL", { label: tc.label, mismatches });
      }
    } catch (err) {
      failures.push({ label: tc.label, error: err?.message || String(err) });
      console.warn("CONFIDENCE_CALIBRATION_SELFTEST_FAIL", { label: tc.label, error: err?.message || String(err) });
    }
  }

  if (failures.length === 0) {
    console.log("CONFIDENCE_CALIBRATION_SELFTEST_PASS", { passed, total: cases.length });
  } else {
    console.warn("CONFIDENCE_CALIBRATION_SELFTEST_FAIL", { passed, total: cases.length, failures: failures.map(f => f.label) });
  }
  return { passed, total: cases.length, failures };
}
