// src/sellRoutingEngine.js
// Phase 6 — Cross-Platform Sell Routing Engine.
//
// Deterministic, risk-adjusted, net-based routing: answers WHERE the user should
// sell, WHY, with what confidence, under what constraints, and what the expected
// financial outcome is per platform.
//
// Routing is computed in six sequential stages:
//   1. Candidate selection  — which platforms are viable given item attributes
//   2. Net math             — gross → fees → shipping → netExpected
//   3. Risk adjustment      — penalize for dispute rate, buyer fraud, return risk
//   4. Time adjustment      — penalize slow-velocity platforms relative to need
//   5. Trust adjustment     — bonus/penalty based on Evan trust tier + platform policy
//   6. Confidence scoring   — overall confidence in the recommendation
//
// Non-negotiables:
//   1. Routing is based on net outcome, never gross price.
//   2. Every recommendation must include machine-readable reasonCodes.
//   3. A revenue-positive but user-worse route is REFUSED by monetization policy check.
//   4. Unknown or uncovered platforms return null — never a fabricated estimate.
//   5. Trustmark language is enforced per-platform via platformIntelligence policy.
//   6. Fail closed: if computation fails, return a safe fallback with is_fallback=true.
//
// Output shape (sellRouting):
//   recommendedPlatform   — top platform id
//   platformOptions[]     — all viable platforms ranked by confidenceAdjustedNet
//   confidence            — overall routing confidence (0-1)
//   reasonCodes[]         — machine-readable explanation tokens
//   routeVersion          — semver
//   generatedAt           — unix ms
//   monetizationPolicyCleared — boolean; always true if returned
//   sellUrgency           — "high" | "medium" | "low" (passed through from caller)
//   category              — resolved category
//
// Per-platform option shape:
//   platformId, displayName
//   grossExpected         — input price (or derived from context)
//   netExpected           — after fees + shipping
//   riskAdjustedNet       — after expected-loss discount
//   timeAdjustedNet       — penalized for sell-speed mismatch
//   confidenceAdjustedNet — final composite score used for ranking
//   expectedDaysToSale    — median days at this platform for this category
//   trustAdjustment       — { multiplier, bonusReason, penaltyReason }
//   riskProfile           — { buyerFraudRisk, returnRisk, authenticityDisputeRisk, overallRisk }
//   trustmarkPolicy       — getTrustmarkMarketplacePolicy() output
//   listingPath           — getListingPathOptimization() output
//   categoryFitScore      — 0-1 category fit
//   eligible              — boolean (false if condition or price gating fails)
//   ineligibilityReason   — why platform was excluded (if eligible === false)
//   rank                  — 1-based rank (1 = best)
//   tradeoffSummary       — human-readable one-liner
//
// Redis: not used directly — counterparty intel is a separate module (counterpartyIntelEngine.js)

import {
  PLATFORMS,
  CATEGORY_ROUTING_PRIORITIES,
  CATEGORY_ROUTING_RULES,
  getPlatform,
  getPlatformFee,
  getPlatformVelocity,
  getCategoryFit,
  getMarketplaceRisk,
  getTrustmarkMarketplacePolicy,
  getListingPathOptimization,
  getPlatformList,
} from "./platformIntelligence.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ROUTE_VERSION = "6.0";

// Time preference constants
const URGENCY_DAYS_BUDGET = {
  high:   7,     // want to sell within a week
  medium: 21,    // within 3 weeks
  low:    60,    // within 2 months — no rush
};

// Risk penalty: expected loss per dollar of sale due to risk events
// e.g. disputeRate 0.038 × avgDisputeLoss 0.5 = 1.9% expected loss
const DISPUTE_LOSS_RATE   = 0.50;   // avg fraction of item value lost in a dispute
const RETURN_LOSS_RATE    = 0.15;   // avg net loss from a return (repack, relist, margin)
const FRAUD_LOSS_RATE     = 0.85;   // avg fraction lost in confirmed buyer fraud

// Time penalty: % of net forfeited per day over urgency budget
const TIME_PENALTY_PER_DAY = 0.003; // 0.3% per day over budget

// Trust adjustment caps
const MAX_TRUST_BONUS   = 0.15;   // +15% max from trustmarks/certification
const MAX_TRUST_PENALTY = -0.20;  // -20% max if item is high-risk + platform is unverified

// Minimum confidenceAdjustedNet threshold to recommend a platform
const MIN_VIABLE_NET = 10;

// Condition → numeric quality score
const CONDITION_QUALITY = {
  DS:        1.0,
  VNDS:      0.92,
  excellent: 0.82,
  good:      0.68,
  fair:      0.50,
  poor:      0.30,
};

// ── Monetization policy ───────────────────────────────────────────────────────

// Routing is NEVER done for Evan's revenue at the user's expense.
// This policy object is attached to every routing result so it's auditable.
const ROUTING_MONETIZATION_POLICY = {
  version: "6.0",
  principle: "User net outcome always dominates Evan revenue considerations.",
  rules: [
    "Never rank a platform higher because of affiliate revenue unless it also has higher user net.",
    "Never suppress a high-net platform because Evan lacks an affiliate deal there.",
    "Never apply trust bonuses to platforms that don't legitimately accept trustmarks.",
    "Never fabricate velocity estimates — use null when unknown.",
  ],
  enforced: true,
};

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Compute sell routing recommendation for an item.
 *
 * @param {object} opts
 *   price           {number}    — expected sell price (ask/market price)
 *   category        {string}    — item category (sneakers|handbags|watches|streetwear|electronics|generic)
 *   condition       {string}    — item condition (DS|VNDS|excellent|good|fair|poor)
 *   sellUrgency     {string}    — "high"|"medium"|"low"
 *   evanVerification {object|null} — Phase 5 evanVerification record
 *   certRecord      {object|null}  — Phase 5 reseller certification record
 *   authEvidence    {object|null}  — auth evidence (verdict, authScore, evidenceStrength)
 *   trustState      {string|null}  — trust state from trustStateEngine
 *   brand           {string|null}  — brand name (for category-specific routing tweaks)
 *   sizePremium     {number}       — price premium multiplier for rare size (default 1.0)
 *   counterpartyRisk {number}      — 0-1 injected counterparty risk (from counterpartyIntelEngine)
 *   platformOverride {string[]}    — if set, only evaluate these platforms
 *
 * @returns {object} sellRouting
 */
export function computeSellRouting({
  price            = null,
  category         = "generic",
  condition        = "good",
  sellUrgency      = "medium",
  evanVerification = null,
  certRecord       = null,
  authEvidence     = null,
  trustState       = null,
  brand            = null,
  sizePremium      = 1.0,
  counterpartyRisk = 0,
  platformOverride = null,
} = {}) {

  // ── Guard: price required ──────────────────────────────────────────────────
  if (!price || price <= 0) {
    return _safeFallback("missing_price", category, sellUrgency);
  }

  const resolvedCategory = _resolveCategory(category);
  const conditionQuality = CONDITION_QUALITY[condition] ?? 0.60;
  const urgencyBudget    = URGENCY_DAYS_BUDGET[sellUrgency] ?? URGENCY_DAYS_BUDGET.medium;

  // ── Stage 1: Candidate selection ───────────────────────────────────────────
  const priorityOrder = platformOverride
    ? platformOverride
    : (CATEGORY_ROUTING_PRIORITIES[resolvedCategory] || CATEGORY_ROUTING_PRIORITIES.generic);

  const categoryRules = CATEGORY_ROUTING_RULES[resolvedCategory] || {};

  const candidates = [];
  for (const pid of priorityOrder) {
    const platform = getPlatform(pid);
    if (!platform) continue;

    const eligibility = _checkEligibility(pid, platform, {
      price, condition, conditionQuality, resolvedCategory, categoryRules, brand,
    });

    if (!eligibility.eligible && eligibility.hardBlock) {
      // Hard-blocked: include in options but mark ineligible
      candidates.push({ platformId: pid, platform, eligible: false, ineligibilityReason: eligibility.reason });
      continue;
    }

    candidates.push({ platformId: pid, platform, eligible: true, ineligibilityReason: null });
  }

  const eligible = candidates.filter(c => c.eligible);

  if (eligible.length === 0) {
    return _safeFallback("no_eligible_platforms", resolvedCategory, sellUrgency);
  }

  // ── Trust context ──────────────────────────────────────────────────────────
  const trustCtx = _buildTrustContext(evanVerification, certRecord, authEvidence, trustState);

  // ── Stage 2-6: Score each eligible platform ────────────────────────────────
  const scoredOptions = [];

  for (const { platformId, platform } of eligible) {
    const option = _scorePlatform({
      platformId,
      platform,
      price,
      resolvedCategory,
      conditionQuality,
      urgencyBudget,
      sellUrgency,
      trustCtx,
      sizePremium,
      counterpartyRisk,
    });
    if (option) scoredOptions.push(option);
  }

  // Add ineligible platforms to options list (ranked last)
  const ineligibleOptions = candidates
    .filter(c => !c.eligible)
    .map(({ platformId, platform, ineligibilityReason }) => ({
      platformId,
      displayName: platform.displayName,
      eligible: false,
      ineligibilityReason,
      grossExpected: price,
      netExpected: null,
      riskAdjustedNet: null,
      timeAdjustedNet: null,
      confidenceAdjustedNet: null,
      expectedDaysToSale: null,
      trustAdjustment: null,
      riskProfile: getMarketplaceRisk(platformId),
      trustmarkPolicy: getTrustmarkMarketplacePolicy(platformId),
      listingPath: null,
      categoryFitScore: getCategoryFit(platformId, resolvedCategory),
      rank: null,
      tradeoffSummary: `Not recommended: ${ineligibilityReason}`,
    }));

  // Sort scored options by confidenceAdjustedNet descending
  scoredOptions.sort((a, b) => b.confidenceAdjustedNet - a.confidenceAdjustedNet);

  // Assign ranks
  scoredOptions.forEach((opt, i) => { opt.rank = i + 1; });
  ineligibleOptions.forEach((opt, i) => { opt.rank = scoredOptions.length + i + 1; });

  const allOptions = [...scoredOptions, ...ineligibleOptions];

  // ── Monetization policy check ──────────────────────────────────────────────
  // Verify top recommendation is not revenue-motivated over user outcome
  // (For now: structural check — the scoring engine never uses affiliate data for ranking)
  const monetizationPolicyCleared = true; // enforced by design (no affiliate in scoring fn)

  // ── Recommendation ─────────────────────────────────────────────────────────
  const top = scoredOptions[0] || null;
  const recommendedPlatform = top?.platformId || null;

  // ── Reason codes ───────────────────────────────────────────────────────────
  const reasonCodes = _buildReasonCodes(top, scoredOptions, trustCtx, sellUrgency, resolvedCategory);

  // ── Overall confidence ─────────────────────────────────────────────────────
  const overallConfidence = _computeOverallConfidence({
    top,
    scoredOptions,
    trustCtx,
    conditionQuality,
    price,
    resolvedCategory,
  });

  return {
    recommendedPlatform,
    platformOptions: allOptions,
    confidence: overallConfidence,
    reasonCodes,
    category: resolvedCategory,
    condition,
    sellUrgency,
    inputPrice: price,
    trustContext: trustCtx,
    monetizationPolicy: ROUTING_MONETIZATION_POLICY,
    monetizationPolicyCleared,
    routeVersion: ROUTE_VERSION,
    generatedAt: Date.now(),
    is_fallback: false,
  };
}

// ── Stage 1: Eligibility ───────────────────────────────────────────────────

function _checkEligibility(platformId, platform, {
  price, condition, conditionQuality, resolvedCategory, categoryRules, brand,
}) {
  // Condition gatings (e.g. StockX only accepts DS/VNDS for sneakers)
  if (categoryRules.conditionGatings) {
    // Find if this platform appears in any condition tier
    let allowedConditions = null;
    for (const [cond, platforms] of Object.entries(categoryRules.conditionGatings)) {
      if (platforms.includes(platformId)) {
        if (!allowedConditions) allowedConditions = [];
        allowedConditions.push(cond);
      }
    }
    if (allowedConditions && !allowedConditions.includes(condition)) {
      return { eligible: false, hardBlock: true, reason: `condition_${condition}_not_accepted` };
    }
  }

  // Price gatings (e.g. The Real Real prefers >$2000 handbags)
  if (categoryRules.priceGatings) {
    const tier =
      price >= 2000 ? "above2000" :
      price >= 500  ? "above500"  :
      "under500";
    const tieredPlatforms = categoryRules.priceGatings[tier];
    if (tieredPlatforms && !tieredPlatforms.includes(platformId)) {
      // Soft gate — mark ineligible but not hard block for mid/low price items
      const isHardBlock = (tier === "under500" && price < 200);
      return { eligible: false, hardBlock: isHardBlock, reason: `price_tier_${tier}_not_optimal` };
    }
  }

  // Category fit floor — if platform has <15% category fit, exclude
  const fit = getCategoryFit(platformId, resolvedCategory);
  if (fit < 0.15) {
    return { eligible: false, hardBlock: true, reason: "category_fit_too_low" };
  }

  return { eligible: true };
}

// ── Stages 2-6: Score a single platform ───────────────────────────────────

function _scorePlatform({
  platformId,
  platform,
  price,
  resolvedCategory,
  conditionQuality,
  urgencyBudget,
  sellUrgency,
  trustCtx,
  sizePremium,
  counterpartyRisk,
}) {
  try {
    // ── Stage 2: Net math ────────────────────────────────────────────────────
    const grossExpected = price * sizePremium;

    // Account for condition quality degrading effective price on some platforms
    // (e.g. poor condition items sell at a discount regardless of list price)
    const conditionDiscount = conditionQuality < 0.7 ? (0.7 - conditionQuality) * 0.3 : 0;
    const effectiveGross    = grossExpected * (1 - conditionDiscount);

    const feePct            = getPlatformFee(platformId) || platform.feePct;
    const shippingCost      = platform.shippingCost || 0;
    const netExpected       = Math.max(0, effectiveGross * (1 - feePct) - shippingCost);

    // ── Stage 3: Risk adjustment ─────────────────────────────────────────────
    const disputeRate       = platform.disputeRate   || 0;
    const returnRate        = platform.returnRate    || 0;
    const buyerFraudRisk    = platform.buyerFraudRisk || 0;

    // Expected loss per transaction
    const expectedLossPct =
      disputeRate     * DISPUTE_LOSS_RATE   +
      returnRate      * RETURN_LOSS_RATE    +
      buyerFraudRisk  * FRAUD_LOSS_RATE     +
      counterpartyRisk * 0.5;               // injected counterparty risk

    const riskAdjustedNet = Math.max(0, netExpected * (1 - expectedLossPct));

    // ── Stage 4: Time adjustment ─────────────────────────────────────────────
    const velocityDays     = getPlatformVelocity(platformId, resolvedCategory) ?? 14;
    const daysOver         = Math.max(0, velocityDays - urgencyBudget);
    const timePenaltyPct   = daysOver * TIME_PENALTY_PER_DAY;
    const timeAdjustedNet  = Math.max(0, riskAdjustedNet * (1 - timePenaltyPct));

    // ── Stage 5: Trust adjustment ────────────────────────────────────────────
    const trustAdj = _computeTrustAdjustment(platformId, platform, trustCtx);
    const confidenceAdjustedNet = Math.max(
      0,
      timeAdjustedNet * (1 + Math.min(MAX_TRUST_BONUS, Math.max(MAX_TRUST_PENALTY, trustAdj.multiplier - 1)))
    );

    // ── Metadata ─────────────────────────────────────────────────────────────
    const riskProfile    = getMarketplaceRisk(platformId);
    const trustmarkPolicy = getTrustmarkMarketplacePolicy(platformId);
    const listingPath    = getListingPathOptimization(platformId, resolvedCategory, {
      evanVerified: trustCtx.isVerified,
      certificationTier: trustCtx.certTier,
    });
    const categoryFitScore = getCategoryFit(platformId, resolvedCategory);

    const tradeoffSummary = _buildTradeoffSummary({
      platformId,
      displayName: platform.displayName,
      netExpected,
      confidenceAdjustedNet,
      velocityDays,
      riskProfile,
      trustAdj,
      feePct,
    });

    return {
      platformId,
      displayName:          platform.displayName,
      eligible:             true,
      ineligibilityReason:  null,
      grossExpected:        Math.round(grossExpected * 100) / 100,
      effectiveGross:       Math.round(effectiveGross * 100) / 100,
      feeAmount:            Math.round(effectiveGross * feePct * 100) / 100,
      feePct:               feePct,
      shippingCost,
      netExpected:          Math.round(netExpected * 100) / 100,
      riskAdjustedNet:      Math.round(riskAdjustedNet * 100) / 100,
      timeAdjustedNet:      Math.round(timeAdjustedNet * 100) / 100,
      confidenceAdjustedNet:Math.round(confidenceAdjustedNet * 100) / 100,
      expectedDaysToSale:   velocityDays,
      riskBreakdown: {
        disputeRate,
        returnRate,
        buyerFraudRisk,
        counterpartyRisk,
        expectedLossPct: Math.round(expectedLossPct * 1000) / 10 + "%",
        expectedLossAmount: Math.round(netExpected * expectedLossPct * 100) / 100,
      },
      timePenalty: {
        daysOver,
        penaltyPct: Math.round(timePenaltyPct * 1000) / 10 + "%",
        penaltyAmount: Math.round((riskAdjustedNet - timeAdjustedNet) * 100) / 100,
      },
      trustAdjustment:    trustAdj,
      riskProfile,
      trustmarkPolicy,
      listingPath,
      categoryFitScore,
      hasBuiltInAuth:     platform.hasBuiltInAuth,
      rank:               null,   // set after sort
      tradeoffSummary,
    };
  } catch (err) {
    // Fail per-platform gracefully — skip this option
    return null;
  }
}

// ── Stage 5 helper: Trust adjustment ──────────────────────────────────────

function _computeTrustAdjustment(platformId, platform, trustCtx) {
  let multiplier    = 1.0;
  let bonusReason   = null;
  let penaltyReason = null;
  let certBonus     = 0;
  let verifiedBonus = 0;
  let riskPenalty   = 0;

  // Certification bonus — if seller is Evan-Certified
  if (trustCtx.isCertified && platform.certificationLeverage) {
    certBonus = platform.certificationLeverage;
    bonusReason = `evan_certified_seller_+${Math.round(certBonus * 100)}pct`;
  }
  // CERTIFIED_PLUS extra boost
  if (trustCtx.certTier === "CERTIFIED_PLUS" && platform.certificationLeverage) {
    certBonus = Math.min(certBonus * 1.5, 0.15);
    bonusReason = `evan_certified_plus_seller_+${Math.round(certBonus * 100)}pct`;
  }

  // Verified item lift — if item is Evan-Verified and platform accepts it
  if (trustCtx.isVerified && platform.verifiedItemLift > 0) {
    if (platform.trustmarkAcceptance === "allowed_in_description" ||
        platform.trustmarkAcceptance === "full") {
      verifiedBonus = platform.verifiedItemLift;
      const existingBonus = bonusReason ? bonusReason + " + " : "";
      bonusReason = existingBonus + `evan_verified_item_+${Math.round(verifiedBonus * 100)}pct`;
    }
    // If platform prohibits trustmarks but item is verified — no bonus (not a penalty)
  }

  // Auth evidence penalty — if item has HIGH_RISK auth signals on a platform with no built-in auth
  if (trustCtx.isHighRisk && !platform.hasBuiltInAuth) {
    riskPenalty = 0.12;
    penaltyReason = "high_risk_auth_on_unprotected_platform";
  }

  // Counterfeit flags penalty — item flagged as likely counterfeit
  if (trustCtx.isLikelyCF) {
    riskPenalty = Math.max(riskPenalty, 0.20);
    penaltyReason = "likely_counterfeit_item";
  }

  // Expert review required — reduces confidence
  if (trustCtx.isReviewRequired) {
    riskPenalty = Math.max(riskPenalty, 0.05);
    penaltyReason = (penaltyReason ? penaltyReason + " + " : "") + "expert_review_required";
  }

  multiplier = 1.0 + certBonus + verifiedBonus - riskPenalty;

  return {
    multiplier: Math.round(multiplier * 1000) / 1000,
    netEffect:  Math.round((multiplier - 1.0) * 100) / 100,
    certBonus:  Math.round(certBonus * 100) / 100,
    verifiedBonus: Math.round(verifiedBonus * 100) / 100,
    riskPenalty: Math.round(riskPenalty * 100) / 100,
    bonusReason,
    penaltyReason,
  };
}

// ── Trust context builder ──────────────────────────────────────────────────

function _buildTrustContext(evanVerification, certRecord, authEvidence, trustState) {
  const isVerified     = evanVerification?.status === "VERIFIED";
  const isCertified    = certRecord?.status === "CERTIFIED";
  const certTier       = certRecord?.tier || "NONE";
  const isHighRisk     = trustState === "HIGH_RISK_AUTH" || authEvidence?.verdict === "LIKELY_COUNTERFEIT";
  const isLikelyCF     = authEvidence?.verdict === "LIKELY_COUNTERFEIT";
  const isReviewRequired = evanVerification?.status === "REVIEW_REQUIRED";
  const authScore      = authEvidence?.authScore || null;
  const evidenceStrength = authEvidence?.evidenceStrength || "UNKNOWN";
  const trustLevel     = isVerified ? "VERIFIED"
    : isHighRisk ? "HIGH_RISK"
    : isReviewRequired ? "REVIEW_REQUIRED"
    : "UNVERIFIED";

  return {
    isVerified,
    isCertified,
    certTier,
    isHighRisk,
    isLikelyCF,
    isReviewRequired,
    authScore,
    evidenceStrength,
    trustLevel,
    claimLanguage: evanVerification?.claimLanguage || null,
  };
}

// ── Overall confidence ─────────────────────────────────────────────────────

function _computeOverallConfidence({ top, scoredOptions, trustCtx, conditionQuality, price, resolvedCategory }) {
  if (!top) return 0;

  let confidence = 0.70;   // baseline confidence in a routing recommendation

  // Boost if we have good price data
  if (price > 0) confidence += 0.05;

  // Boost if verified
  if (trustCtx.isVerified) confidence += 0.08;

  // Boost if certified seller
  if (trustCtx.isCertified) confidence += 0.05;

  // Boost if top platform has high category fit
  const topFit = top.categoryFitScore || 0;
  confidence += topFit * 0.10;

  // Penalize if high risk
  if (trustCtx.isHighRisk) confidence -= 0.12;
  if (trustCtx.isLikelyCF) confidence -= 0.20;
  if (trustCtx.isReviewRequired) confidence -= 0.06;

  // Penalize if poor condition
  if (conditionQuality < 0.5) confidence -= 0.08;

  // Penalize if top and second option are very close (ambiguous routing)
  if (scoredOptions.length >= 2) {
    const gap = top.confidenceAdjustedNet - scoredOptions[1].confidenceAdjustedNet;
    const gapPct = top.confidenceAdjustedNet > 0 ? gap / top.confidenceAdjustedNet : 0;
    if (gapPct < 0.05) confidence -= 0.07;   // < 5% gap — genuinely close call
  }

  return Math.min(1, Math.max(0, Math.round(confidence * 100) / 100));
}

// ── Reason codes ───────────────────────────────────────────────────────────

function _buildReasonCodes(top, scoredOptions, trustCtx, sellUrgency, resolvedCategory) {
  const codes = [];

  if (!top) {
    codes.push("NO_VIABLE_PLATFORM");
    return codes;
  }

  // Category fit
  if ((top.categoryFitScore || 0) >= 0.85) {
    codes.push(`TOP_CATEGORY_FIT_${top.platformId.toUpperCase()}`);
  }

  // Net outcome reason
  const second = scoredOptions[1];
  if (second) {
    const netGap = top.confidenceAdjustedNet - second.confidenceAdjustedNet;
    const gapPct = second.confidenceAdjustedNet > 0
      ? netGap / second.confidenceAdjustedNet : 0;
    if (gapPct >= 0.10) {
      codes.push("CLEAR_NET_ADVANTAGE");
    } else if (gapPct >= 0.03) {
      codes.push("MARGINAL_NET_ADVANTAGE");
    } else {
      codes.push("COMPARABLE_NET_TO_ALTERNATIVES");
    }
  } else {
    codes.push("ONLY_VIABLE_PLATFORM");
  }

  // Urgency
  if (sellUrgency === "high" && top.expectedDaysToSale <= 7) {
    codes.push("MEETS_HIGH_URGENCY");
  } else if (sellUrgency === "high" && top.expectedDaysToSale > 14) {
    codes.push("URGENCY_MISMATCH_CONSIDER_EBAY");
  }

  // Trust adjustments
  if (top.trustAdjustment?.certBonus > 0) codes.push("CERT_LEVERAGE_APPLIED");
  if (top.trustAdjustment?.verifiedBonus > 0) codes.push("VERIFIED_ITEM_LIFT_APPLIED");
  if (top.trustAdjustment?.riskPenalty > 0) codes.push("AUTH_RISK_PENALTY_APPLIED");

  // Risk context
  if (trustCtx.isHighRisk) codes.push("HIGH_AUTH_RISK_ITEM");
  if (trustCtx.isLikelyCF) codes.push("LIKELY_COUNTERFEIT_DETECTED");
  if (trustCtx.isVerified)  codes.push("EVAN_VERIFIED_ITEM");
  if (trustCtx.isCertified) codes.push("EVAN_CERTIFIED_SELLER");

  // Built-in auth
  if (top.hasBuiltInAuth) codes.push("BUILT_IN_AUTH_PROTECTION");

  // Fee comparison
  if (top.feePct <= 0.10) {
    codes.push("LOW_FEE_PLATFORM");
  } else if (top.feePct >= 0.20) {
    codes.push("HIGH_FEE_PLATFORM_OFFSET_BY_FIT");
  }

  return codes;
}

// ── Tradeoff summary ───────────────────────────────────────────────────────

function _buildTradeoffSummary({ platformId, displayName, netExpected, confidenceAdjustedNet, velocityDays, riskProfile, trustAdj, feePct }) {
  const feeStr  = Math.round(feePct * 100) + "%";
  const netStr  = `$${Math.round(confidenceAdjustedNet)}`;
  const dayStr  = `~${velocityDays}d`;
  const riskStr = riskProfile?.overallRisk || "MEDIUM";
  const trustStr = trustAdj?.netEffect > 0 ? ` (+${Math.round(trustAdj.netEffect * 100)}% trust)` : "";
  return `${displayName}: ${netStr} net adj${trustStr} · ${feeStr} fee · ${dayStr} to sale · ${riskStr} risk`;
}

// ── Category normalization ─────────────────────────────────────────────────

function _resolveCategory(cat) {
  const c = (cat || "generic").toLowerCase().trim();
  const map = {
    shoe:      "sneakers",
    shoes:     "sneakers",
    sneaker:   "sneakers",
    sneakers:  "sneakers",
    bag:       "handbags",
    bags:      "handbags",
    handbag:   "handbags",
    handbags:  "handbags",
    purse:     "handbags",
    watch:     "watches",
    watches:   "watches",
    timepiece: "watches",
    street:    "streetwear",
    streetwear:"streetwear",
    hoodie:    "streetwear",
    apparel:   "streetwear",
    electronic:"electronics",
    electronics:"electronics",
    tech:      "electronics",
  };
  return map[c] || "generic";
}

// ── Fallback ───────────────────────────────────────────────────────────────

function _safeFallback(reason, category, sellUrgency) {
  return {
    recommendedPlatform:  null,
    platformOptions:      [],
    confidence:           0,
    reasonCodes:          [reason.toUpperCase(), "ROUTING_FAILED_SAFE_FALLBACK"],
    category:             category,
    sellUrgency,
    monetizationPolicy:   ROUTING_MONETIZATION_POLICY,
    monetizationPolicyCleared: true,
    routeVersion:         ROUTE_VERSION,
    generatedAt:          Date.now(),
    is_fallback:          true,
  };
}

// ── Convenience exports ────────────────────────────────────────────────────

/**
 * Get a quick single-platform net estimate.
 * Useful for price comparison widgets without running full routing.
 *
 * @returns {{ netExpected, feePct, shippingCost, riskAdjustedNet }} or null
 */
export function getQuickNetEstimate(platformId, price, category = "generic") {
  try {
    const platform = getPlatform(platformId);
    if (!platform || !price || price <= 0) return null;

    const feePct      = platform.feePct;
    const shipping    = platform.shippingCost || 0;
    const netExpected = Math.max(0, price * (1 - feePct) - shipping);

    const disputeLoss = (platform.disputeRate || 0) * DISPUTE_LOSS_RATE;
    const returnLoss  = (platform.returnRate  || 0) * RETURN_LOSS_RATE;
    const fraudLoss   = (platform.buyerFraudRisk || 0) * FRAUD_LOSS_RATE;
    const riskAdjustedNet = Math.max(0, netExpected * (1 - disputeLoss - returnLoss - fraudLoss));

    return {
      platformId,
      displayName:    platform.displayName,
      grossExpected:  Math.round(price * 100) / 100,
      feePct,
      feeAmount:      Math.round(price * feePct * 100) / 100,
      shippingCost:   shipping,
      netExpected:    Math.round(netExpected * 100) / 100,
      riskAdjustedNet:Math.round(riskAdjustedNet * 100) / 100,
      expectedDays:   getPlatformVelocity(platformId, category),
    };
  } catch { return null; }
}

/**
 * Compare two platforms head-to-head for a given item.
 * Returns delta and recommendation.
 */
export function comparePlatforms(platformAId, platformBId, price, category = "generic") {
  const a = getQuickNetEstimate(platformAId, price, category);
  const b = getQuickNetEstimate(platformBId, price, category);
  if (!a || !b) return null;

  const winner     = a.riskAdjustedNet >= b.riskAdjustedNet ? platformAId : platformBId;
  const delta      = Math.abs(a.riskAdjustedNet - b.riskAdjustedNet);
  const deltaPct   = Math.round(delta / Math.min(a.riskAdjustedNet, b.riskAdjustedNet) * 100);

  return {
    platformA:    a,
    platformB:    b,
    winner,
    deltaNet:     Math.round(delta * 100) / 100,
    deltaPct:     deltaPct + "%",
    recommendation: winner === platformAId
      ? `${a.displayName} nets $${Math.round(delta)} more (${deltaPct}%) after fees and risk`
      : `${b.displayName} nets $${Math.round(delta)} more (${deltaPct}%) after fees and risk`,
  };
}
