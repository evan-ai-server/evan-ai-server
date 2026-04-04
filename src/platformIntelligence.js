// src/platformIntelligence.js
// Phase 6 — Platform Intelligence Models.
//
// Single source of truth for all platform-specific intelligence:
//   - Fee structures (taker rate, payment processing)
//   - Velocity models (median days to sale by category)
//   - Risk profiles (dispute rate, return rate, buyer fraud risk)
//   - Trust/auth integration (built-in auth, trustmark acceptance policy)
//   - Category fit scores (how well does this platform serve this category)
//   - Listing complexity (effort required per platform)
//   - Buyer quality scores (likelihood of legitimate transaction)
//
// Trustmark Marketplace Policy:
//   For each platform, defines exactly what Evan trust language is permitted.
//   This governs what the listing path optimizer may or may not claim.
//   Non-negotiable: no trustmark displayed in a context where it is not permitted.
//
// Used by: sellRoutingEngine.js, listingAssistEngine.js, dataProductEngine.js
// No Redis dependency — pure in-process intelligence.

// ── Platform catalog ──────────────────────────────────────────────────────────

export const PLATFORMS = {
  stockx: {
    id:           "stockx",
    displayName:  "StockX",
    url:          "https://stockx.com/sell",
    // Fee: seller fee + 3% payment processing = effective ~9.5%
    feePct:       0.095,
    shippingCost: 0,          // shipping label provided by platform
    payoutDays:   5,          // business days after verification passes
    // Risk profile
    disputeRate:  0.015,      // ~1.5% of transactions result in dispute/rejection
    returnRate:   0.005,      // very low — auth rejection not a "return"
    buyerFraudRisk: 0.008,    // authenticated marketplace, very low buyer fraud
    sellerBurden: "LOW",      // just ship in — platform handles authentication
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "LOW",
    // Authentication
    hasBuiltInAuth: true,
    authIntegration: "mandatory",  // every item authenticated before payout
    authCost:     0,
    // Trust / trustmark
    trustmarkAcceptance: "condition_note_only", // can note verification in seller notes
    certificationClaimAllowed: false,           // platform doesn't display 3rd party certs
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: false,
    requiredDisclaimer: null,
    prohibitedLanguage: ["Evan-Verified", "guaranteed", "certified"],
    // Category fit (0-1 — how suited this platform is for this category)
    categoryFit: {
      sneakers:    0.98,
      apparel:     0.72,
      electronics: 0.45,
      streetwear:  0.80,
      handbags:    0.30,
      watches:     0.20,
      generic:     0.10,
    },
    // Velocity: median days to sale at competitive price
    velocityDays: {
      sneakers:    7,
      apparel:     14,
      electronics: 21,
      streetwear:  12,
      default:     14,
    },
    listingComplexity: "LOW",
    localPickup: false,
    buyerQuality: 0.90,
    priceTransparency: "HIGH", // market-set pricing, no haggle
    certificationLeverage: 0.08,   // +8% effective net if Evan-Certified seller
    verifiedItemLift: 0,           // no price lift from external trustmark
    notes: "Mandatory authentication; no-haggle market price; DS/VNDS focus",
  },

  goat: {
    id:           "goat",
    displayName:  "GOAT",
    url:          "https://www.goat.com/sell",
    feePct:       0.095,
    shippingCost: 0,
    payoutDays:   5,
    disputeRate:  0.015,
    returnRate:   0.005,
    buyerFraudRisk: 0.008,
    sellerBurden: "LOW",
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: true,
    authIntegration: "mandatory",
    authCost: 0,
    trustmarkAcceptance: "internal_only",
    certificationClaimAllowed: false,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: false,
    requiredDisclaimer: null,
    prohibitedLanguage: ["Evan-Verified", "guaranteed"],
    categoryFit: {
      sneakers:    0.97,
      apparel:     0.65,
      streetwear:  0.75,
      handbags:    0.25,
      generic:     0.05,
    },
    velocityDays: {
      sneakers:    10,
      apparel:     18,
      streetwear:  14,
      default:     18,
    },
    listingComplexity: "LOW",
    localPickup: false,
    buyerQuality: 0.90,
    priceTransparency: "HIGH",
    certificationLeverage: 0.06,
    verifiedItemLift: 0,
    notes: "Largest sneaker buyer pool; used condition accepted; GOAT Clean service",
  },

  ebay: {
    id:           "ebay",
    displayName:  "eBay",
    url:          "https://ebay.com/sell",
    feePct:       0.1275,     // 12.75% FVF blended (varies 5-15% by category)
    shippingCost: 10,         // seller-handled shipping estimate
    payoutDays:   3,
    disputeRate:  0.038,      // higher — buyers can open Item Not As Described
    returnRate:   0.042,      // 30-day returns common on eBay
    buyerFraudRisk: 0.030,    // INR claims, chargeback risk
    sellerBurden: "MEDIUM",   // listing effort required
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "MEDIUM",  // policy changes affect sellers
    hasBuiltInAuth: false,
    authIntegration: "optional",   // eBay Authenticity Guarantee program (opt-in)
    authCost: 0,                   // free if enrolled, handled by platform
    trustmarkAcceptance: "allowed_in_description",
    certificationClaimAllowed: true,
    guaranteeClaimAllowed: false,  // guarantee language requires disclaimer
    externalTrustLinkAllowed: true,
    requiredDisclaimer: "Authentication assessment provided by Evan AI. Independent verification recommended for high-value items.",
    prohibitedLanguage: ["guaranteed refund", "guaranteed authentic — no returns"],
    categoryFit: {
      sneakers:    0.80,
      handbags:    0.72,
      watches:     0.85,
      electronics: 0.90,
      streetwear:  0.65,
      generic:     0.88,
      vintage:     0.92,
    },
    velocityDays: {
      sneakers:    5,
      handbags:    10,
      watches:     8,
      electronics: 4,
      generic:     6,
      vintage:     12,
      default:     7,
    },
    listingComplexity: "MEDIUM",
    localPickup: true,
    buyerQuality: 0.72,
    priceTransparency: "MEDIUM",  // negotiation possible via Best Offer
    certificationLeverage: 0.12,
    verifiedItemLift: 0.07,       // Evan-Verified in description adds ~7% to price ceiling
    notes: "Widest audience; highest ceiling for rare sizes; dispute risk is highest here",
  },

  poshmark: {
    id:           "poshmark",
    displayName:  "Poshmark",
    url:          "https://poshmark.com/sell",
    feePct:       0.20,       // flat 20% on all sales
    shippingCost: 0,          // prepaid label provided ($7.67 flat, covered by fee)
    payoutDays:   3,
    disputeRate:  0.020,
    returnRate:   0.025,
    buyerFraudRisk: 0.015,
    sellerBurden: "MEDIUM",
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: true,     // Posh Protect authentication for items $500+
    authIntegration: "auto_high_value",
    authCost: 0,
    trustmarkAcceptance: "allowed_in_description",
    certificationClaimAllowed: true,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: true,
    requiredDisclaimer: "Authentication provided by Evan AI. Posh Protect also applies for items $500+.",
    prohibitedLanguage: [],
    categoryFit: {
      handbags:    0.82,
      sneakers:    0.55,
      apparel:     0.88,
      streetwear:  0.68,
      watches:     0.35,
      generic:     0.45,
    },
    velocityDays: {
      handbags:    14,
      sneakers:    21,
      apparel:     10,
      streetwear:  14,
      default:     18,
    },
    listingComplexity: "MEDIUM",
    localPickup: false,
    buyerQuality: 0.72,
    priceTransparency: "LOW",    // offer-based, negotiation heavy
    certificationLeverage: 0.10,
    verifiedItemLift: 0.06,
    notes: "High fee but prepaid label; social selling; Posh Protect reduces dispute risk",
  },

  mercari: {
    id:           "mercari",
    displayName:  "Mercari",
    url:          "https://mercari.com/sell",
    feePct:       0.10,
    shippingCost: 8,           // seller handles or prepaid label option
    payoutDays:   3,
    disputeRate:  0.030,
    returnRate:   0.030,
    buyerFraudRisk: 0.022,
    sellerBurden: "LOW",
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: false,
    authIntegration: "none",
    authCost: 0,
    trustmarkAcceptance: "allowed_in_description",
    certificationClaimAllowed: true,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: true,
    requiredDisclaimer: null,
    prohibitedLanguage: [],
    categoryFit: {
      sneakers:    0.62,
      handbags:    0.58,
      electronics: 0.78,
      generic:     0.82,
      apparel:     0.72,
    },
    velocityDays: {
      sneakers:    10,
      handbags:    14,
      electronics: 5,
      generic:     7,
      apparel:     9,
      default:     8,
    },
    listingComplexity: "LOW",
    localPickup: false,
    buyerQuality: 0.68,
    priceTransparency: "LOW",
    certificationLeverage: 0.08,
    verifiedItemLift: 0.05,
    notes: "Easy listing; broad audience; lower buyer quality than specialty platforms",
  },

  grailed: {
    id:           "grailed",
    displayName:  "Grailed",
    url:          "https://grailed.com/sell",
    feePct:       0.09,
    shippingCost: 10,
    payoutDays:   5,
    disputeRate:  0.018,
    returnRate:   0.015,
    buyerFraudRisk: 0.015,
    sellerBurden: "MEDIUM",
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: false,
    authIntegration: "none",
    authCost: 0,
    trustmarkAcceptance: "allowed_in_description",
    certificationClaimAllowed: true,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: true,
    requiredDisclaimer: null,
    prohibitedLanguage: [],
    categoryFit: {
      streetwear:  0.95,
      apparel:     0.88,
      sneakers:    0.72,
      handbags:    0.45,
      vintage:     0.75,
      generic:     0.30,
    },
    velocityDays: {
      streetwear:  14,
      apparel:     21,
      sneakers:    14,
      handbags:    21,
      vintage:     21,
      default:     21,
    },
    listingComplexity: "MEDIUM",
    localPickup: false,
    buyerQuality: 0.80,
    priceTransparency: "MEDIUM",
    certificationLeverage: 0.10,
    verifiedItemLift: 0.06,
    notes: "Collector/enthusiast buyers willing to pay premium; lower volume than eBay",
  },

  chrono24: {
    id:           "chrono24",
    displayName:  "Chrono24",
    url:          "https://chrono24.com/sell",
    feePct:       0.065,
    shippingCost: 20,          // insured shipping essential for watches
    payoutDays:   10,          // escrow-based payout after buyer confirmation
    disputeRate:  0.010,
    returnRate:   0.010,
    buyerFraudRisk: 0.008,
    sellerBurden: "MEDIUM",
    payoutDelayRisk: "MEDIUM", // escrow means longer wait
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: true,
    authIntegration: "optional",
    authCost: 0,
    trustmarkAcceptance: "allowed_in_description",
    certificationClaimAllowed: true,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: true,
    requiredDisclaimer: "Authentication assessment provided by Evan AI. Chrono24 buyer protection also applies.",
    prohibitedLanguage: [],
    categoryFit: {
      watches: 0.98,
      generic: 0.02,
    },
    velocityDays: {
      watches: 21,
      default: 30,
    },
    listingComplexity: "MEDIUM",
    localPickup: false,
    buyerQuality: 0.92,
    priceTransparency: "HIGH",
    certificationLeverage: 0.12,
    verifiedItemLift: 0.10,
    notes: "Global watch market; lowest fee; escrow protection; ideal for $500+ watches",
  },

  therealreal: {
    id:           "therealreal",
    displayName:  "The RealReal",
    url:          "https://therealreal.com/consign",
    feePct:       0.22,        // avg commission (15-35% sliding scale by price)
    shippingCost: 0,           // consignment; they pick up or ship free
    payoutDays:   14,
    disputeRate:  0.012,
    returnRate:   0.020,
    buyerFraudRisk: 0.008,
    sellerBurden: "LOW",       // they handle listing, photography, authentication
    payoutDelayRisk: "MEDIUM",
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: true,
    authIntegration: "mandatory",
    authCost: 0,
    trustmarkAcceptance: "internal_only",
    certificationClaimAllowed: false,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: false,
    requiredDisclaimer: null,
    prohibitedLanguage: ["Evan-Verified", "third-party certified"],
    categoryFit: {
      handbags:    0.95,
      watches:     0.72,
      apparel:     0.75,
      sneakers:    0.45,
      generic:     0.10,
    },
    velocityDays: {
      handbags: 14,
      watches:  21,
      apparel:  21,
      default:  21,
    },
    listingComplexity: "LOW",
    localPickup: false,
    buyerQuality: 0.88,
    priceTransparency: "LOW",
    certificationLeverage: 0.08,
    verifiedItemLift: 0,
    notes: "Highest trust signal for luxury buyers; slowest payout; high fee; zero listing effort",
  },

  fashionphile: {
    id:           "fashionphile",
    displayName:  "Fashionphile",
    url:          "https://fashionphile.com/sell",
    feePct:       0.19,        // ~19% avg commission
    shippingCost: 0,
    payoutDays:   7,
    disputeRate:  0.010,
    returnRate:   0.012,
    buyerFraudRisk: 0.008,
    sellerBurden: "LOW",
    payoutDelayRisk: "LOW",
    platformPolicyRisk: "LOW",
    hasBuiltInAuth: true,
    authIntegration: "mandatory",
    authCost: 0,
    trustmarkAcceptance: "internal_only",
    certificationClaimAllowed: false,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: false,
    requiredDisclaimer: null,
    prohibitedLanguage: ["Evan-Verified", "third-party certified"],
    categoryFit: {
      handbags: 0.90,
      watches:  0.40,
      apparel:  0.20,
      generic:  0.05,
    },
    velocityDays: {
      handbags: 10,
      watches:  21,
      default:  14,
    },
    listingComplexity: "LOW",
    localPickup: false,
    buyerQuality: 0.88,
    priceTransparency: "LOW",    // they make you an offer
    certificationLeverage: 0.05,
    verifiedItemLift: 0,
    notes: "Instant offers on common LV/Chanel/Gucci; quick payout; slightly lower returns than private sale",
  },

  local: {
    id:           "local",
    displayName:  "Local / In-Person",
    url:          null,
    feePct:       0.00,
    shippingCost: 0,
    payoutDays:   0,           // immediate cash
    disputeRate:  0.005,
    returnRate:   0.010,
    buyerFraudRisk: 0.080,     // no-show, counterfeit bills, item swap scams
    sellerBurden: "LOW",
    payoutDelayRisk: "NONE",
    platformPolicyRisk: "NONE",
    hasBuiltInAuth: false,
    authIntegration: "none",
    authCost: 0,
    trustmarkAcceptance: "allowed_in_description",
    certificationClaimAllowed: true,
    guaranteeClaimAllowed: false,
    externalTrustLinkAllowed: true,
    requiredDisclaimer: "All sales final. Verify cash before releasing item. Meet in safe public location.",
    prohibitedLanguage: ["Evan Guarantee", "refundable"],
    categoryFit: {
      electronics: 0.78,
      generic:     0.80,
      sneakers:    0.60,
      handbags:    0.40,
      watches:     0.35,
    },
    velocityDays: {
      electronics: 3,
      generic:     3,
      sneakers:    5,
      handbags:    7,
      watches:     10,
      default:     4,
    },
    listingComplexity: "LOW",
    localPickup: true,
    buyerQuality: 0.55,
    priceTransparency: "LOW",
    certificationLeverage: 0.05,
    verifiedItemLift: 0.04,
    notes: "Zero fees; immediate cash; high buyer fraud risk; best for bulky/local-only items",
  },
};

// ── Category routing priorities ───────────────────────────────────────────────
// Defines the default platform ranking order per category.
// These are used when no price intel is available to differentiate.

export const CATEGORY_ROUTING_PRIORITIES = {
  sneakers: ["stockx", "goat", "ebay", "grailed", "mercari", "local"],
  handbags: ["therealreal", "fashionphile", "poshmark", "ebay", "mercari", "local"],
  watches:  ["chrono24", "ebay", "grailed", "local"],
  streetwear: ["grailed", "stockx", "ebay", "mercari", "local"],
  electronics:["ebay", "mercari", "local"],
  apparel:  ["grailed", "poshmark", "ebay", "mercari", "local"],
  vintage:  ["ebay", "grailed", "etsy", "local"],
  generic:  ["ebay", "mercari", "local"],
};

// ── Category-specific routing rules ──────────────────────────────────────────

export const CATEGORY_ROUTING_RULES = {
  sneakers: {
    description:        "Sneakers sell best on authenticated platforms for DS/VNDS; eBay wins for rare sizes",
    strongestPlatforms: ["stockx", "goat"],
    mostTrustedPath:    "stockx",          // authentication built-in
    highestRiskPath:    "local",
    useVerificationFor: ["stockx", "goat", "ebay"],
    useCertificationFor:["ebay", "mercari"],
    localSenseAbove:    null,              // local rarely optimal for sneakers
    velocityVsNetTrade: "velocity",        // sneaker market moves fast
    conditionGatings: {
      DS:       ["stockx", "goat"],
      VNDS:     ["stockx", "goat", "ebay"],
      excellent:["ebay", "grailed", "mercari"],
      good:     ["ebay", "mercari", "local"],
      fair:     ["ebay", "local"],
    },
  },
  handbags: {
    description:        "Luxury handbags need authenticated channels; eBay for rare/unusual pieces",
    strongestPlatforms: ["therealreal", "fashionphile", "poshmark"],
    mostTrustedPath:    "therealreal",
    highestRiskPath:    "local",
    useVerificationFor: ["ebay", "poshmark", "mercari"],
    useCertificationFor:["ebay", "poshmark"],
    localSenseAbove:    null,
    velocityVsNetTrade: "net",             // handbag buyers are patient
    authRequiredAbovePrice: 500,           // strongly recommend auth service for $500+
    priceGatings: {
      above2000: ["therealreal", "fashionphile", "ebay"],
      above500:  ["therealreal", "poshmark", "ebay"],
      under500:  ["poshmark", "mercari", "ebay"],
    },
  },
  watches: {
    description:        "Watches require reference verification; Chrono24 for global market, eBay for vintage",
    strongestPlatforms: ["chrono24", "ebay"],
    mostTrustedPath:    "chrono24",
    highestRiskPath:    "local",
    useVerificationFor: ["chrono24", "ebay"],
    useCertificationFor:["chrono24", "ebay"],
    localSenseAbove:    null,
    velocityVsNetTrade: "net",
    expertAuthRequiredAbovePrice: 2000,
    priceGatings: {
      above5000: ["chrono24", "ebay"],
      above1000: ["chrono24", "ebay"],
      under1000: ["ebay", "mercari"],
    },
  },
  streetwear: {
    description:        "Streetwear moves through Grailed; premium brands work on StockX",
    strongestPlatforms: ["grailed", "stockx"],
    mostTrustedPath:    "grailed",
    highestRiskPath:    "local",
    useVerificationFor: ["ebay"],
    useCertificationFor:["ebay", "mercari"],
    velocityVsNetTrade: "velocity",
  },
  electronics: {
    description:        "Electronics move fastest on eBay; local for large/heavy items",
    strongestPlatforms: ["ebay", "mercari"],
    mostTrustedPath:    "ebay",
    highestRiskPath:    "local",
    useVerificationFor: [],
    localSenseAbove:    50,    // local makes sense for cheap electronics (avoid shipping cost)
    velocityVsNetTrade: "velocity",
  },
  generic: {
    description:        "Default routing to highest-reach platforms with best net",
    strongestPlatforms: ["ebay", "mercari"],
    mostTrustedPath:    "ebay",
    highestRiskPath:    "local",
    useVerificationFor: ["ebay"],
    velocityVsNetTrade: "velocity",
  },
};

// ── Trustmark marketplace policy ──────────────────────────────────────────────

export const POLICY_VERSION = "6.0";

/**
 * Get the trustmark marketplace usage policy for a given platform.
 * Defines exactly what Evan trust language may appear in listings on this channel.
 */
export function getTrustmarkMarketplacePolicy(platformId) {
  const p = PLATFORMS[(platformId || "").toLowerCase()];
  if (!p) {
    return {
      platform: platformId,
      verificationClaimAllowed: false,
      certificationClaimAllowed: false,
      guaranteeClaimAllowed: false,
      requiredDisclaimer: "Authentication claim source not verified for this channel.",
      prohibitedLanguage: ["Evan-Verified", "Evan-Certified", "Evan Guarantee"],
      policyVersion: POLICY_VERSION,
    };
  }
  return {
    platform:                  p.displayName,
    verificationClaimAllowed:  p.trustmarkAcceptance !== "internal_only" && p.trustmarkAcceptance !== "condition_note_only",
    certificationClaimAllowed: p.certificationClaimAllowed,
    guaranteeClaimAllowed:     p.guaranteeClaimAllowed,
    externalTrustLinkAllowed:  p.externalTrustLinkAllowed,
    requiredDisclaimer:        p.requiredDisclaimer,
    prohibitedLanguage:        p.prohibitedLanguage,
    notes:                     p.trustmarkAcceptance,
    policyVersion:             POLICY_VERSION,
  };
}

/**
 * Get the listing path optimization parameters for a given platform + category.
 * Returns structured listing guidance that can be consumed by listingAssistEngine.
 */
export function getListingPathOptimization(platformId, category, {
  evanVerification = null,
  certRecord       = null,
  priceEstimate    = null,
} = {}) {
  const p    = PLATFORMS[(platformId || "").toLowerCase()];
  const cat  = (category || "generic").toLowerCase();
  const policy = getTrustmarkMarketplacePolicy(platformId);
  const rules  = CATEGORY_ROUTING_RULES[cat] || CATEGORY_ROUTING_RULES.generic;

  const isVerified   = evanVerification?.status === "VERIFIED";
  const isCertified  = certRecord?.status === "CERTIFIED" || certRecord?.status === "CERTIFIED_PLUS";
  const useVerif     = isVerified && (rules.useVerificationFor?.includes(platformId) ?? false);
  const useCert      = isCertified && (rules.useCertificationFor?.includes(platformId) ?? false);

  // Determine allowed claim language
  const allowedClaims = [];
  if (useVerif && policy.verificationClaimAllowed) {
    allowedClaims.push("Evan-Verified authentic");
  }
  if (useCert && policy.certificationClaimAllowed) {
    allowedClaims.push("Evan-Certified seller");
  }

  // Platform-specific title guidance
  const titleGuidance = _buildTitleGuidance(p, cat, isVerified);
  const requiredPhotos = _buildPhotoChecklist(cat, p);

  return {
    platform:             p?.displayName || platformId,
    category:             cat,
    titleTemplate:        titleGuidance.template,
    titleTips:            titleGuidance.tips,
    descriptionTemplate:  _buildDescriptionTemplate(p, cat, isVerified, isCertified),
    claimLanguage:        evanVerification?.claimLanguage || null,
    allowedClaims,
    requiredPhotos,
    recommendedPrice:     priceEstimate ? Math.round(priceEstimate) : null,
    minAcceptablePrice:   priceEstimate ? Math.round(priceEstimate * 0.85) : null,
    trustmarkUsage:       useVerif ? `Include "${allowedClaims[0] || "Evan-Verified"}" in item description` : null,
    warningText:          policy.requiredDisclaimer,
    platformSpecificTips: _buildPlatformTips(p, cat),
  };
}

// ── Platform data accessors ───────────────────────────────────────────────────

export function getPlatform(platformId) {
  return PLATFORMS[(platformId || "").toLowerCase()] || null;
}

export function getPlatformList() {
  return Object.values(PLATFORMS).map(p => ({
    id:          p.id,
    displayName: p.displayName,
    feePct:      p.feePct,
    hasAuth:     p.hasBuiltInAuth,
  }));
}

export function getPlatformFee(platformId) {
  return PLATFORMS[(platformId || "").toLowerCase()]?.feePct ?? 0.1275;
}

export function getPlatformVelocity(platformId, category) {
  const p   = PLATFORMS[(platformId || "").toLowerCase()];
  if (!p) return 14;
  const cat = (category || "default").toLowerCase();
  return p.velocityDays[cat] || p.velocityDays.default || 14;
}

export function getCategoryFit(platformId, category) {
  const p   = PLATFORMS[(platformId || "").toLowerCase()];
  if (!p) return 0.5;
  const cat = (category || "generic").toLowerCase();
  return p.categoryFit[cat] ?? p.categoryFit.generic ?? 0.3;
}

export function getMarketplaceRisk(platformId) {
  const p = PLATFORMS[(platformId || "").toLowerCase()];
  if (!p) return null;
  return {
    platform:               p.displayName,
    buyerFraudRisk:         _riskLabel(p.buyerFraudRisk, 0.02, 0.05),
    returnRisk:             _riskLabel(p.returnRate, 0.02, 0.04),
    authenticityDisputeRisk:p.hasBuiltInAuth ? "LOW" : _riskLabel(p.disputeRate, 0.02, 0.04),
    sellerBurden:           p.sellerBurden,
    payoutDelayRisk:        p.payoutDelayRisk,
    platformPolicyRisk:     p.platformPolicyRisk,
    trustmarkAcceptance:    p.trustmarkAcceptance,
    recommendedProtectionLevel: _protectionLevel(p),
    overallRisk:            _overallRisk(p),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _riskLabel(rate, medThresh, highThresh) {
  if (rate == null) return "UNKNOWN";
  if (rate < medThresh) return "LOW";
  if (rate < highThresh) return "MEDIUM";
  return "HIGH";
}

function _overallRisk(p) {
  const score = (p.buyerFraudRisk + p.disputeRate + p.returnRate) / 3;
  if (score < 0.015) return "LOW";
  if (score < 0.035) return "MEDIUM";
  return "HIGH";
}

function _protectionLevel(p) {
  if (p.hasBuiltInAuth) return "STANDARD";
  if (p.buyerFraudRisk >= 0.05) return "ELEVATED";
  return "BASIC";
}

function _buildTitleGuidance(p, cat, isVerified) {
  const verifiedTag = isVerified ? " [Evan-Verified]" : "";
  const templates = {
    stockx:    `{Brand} {Model} {Colorway} {Size}{verifiedTag}`,
    goat:      `{Brand} {Model} {Colorway} {Size}`,
    ebay:      `{Brand} {Model} {Colorway} {Size} {Condition}${verifiedTag} {StyleCode}`,
    poshmark:  `{Brand} {Model} {Condition}${verifiedTag}`,
    mercari:   `{Brand} {Model} {Condition} {Size}`,
    grailed:   `{Brand} {Model} {Era} {Condition}${verifiedTag}`,
    chrono24:  `{Brand} {Model} Ref {RefNumber} {Condition}${verifiedTag}`,
    therealreal:`{Brand} {Model} — condition and auth certified`,
    local:     `{Brand} {Model} {Condition} — Local pickup`,
  };
  const template = (templates[p?.id] || templates.ebay).replace("{verifiedTag}", verifiedTag);
  const tips = [
    "Include brand, model, condition in title",
    isVerified ? "Include Evan-Verified in title for eBay/Mercari/Grailed" : null,
    cat === "sneakers" ? "Include size and style code" : null,
    cat === "watches" ? "Include reference number" : null,
  ].filter(Boolean);
  return { template, tips };
}

function _buildDescriptionTemplate(p, cat, isVerified, isCertified) {
  const lines = [
    `{Brand} {Model} — {Condition}`,
    `{ItemDetails}`,
    isVerified ? `\nEvan-Verified: Authentication evidence assessed. ${isCertified ? "Sold by Evan-Certified reseller." : ""}` : null,
    p?.requiredDisclaimer ? `\n${p.requiredDisclaimer}` : null,
    `\nAll sales final.`,
  ].filter(Boolean);
  return lines.join("\n");
}

function _buildPhotoChecklist(cat, p) {
  const base = ["Front", "Back", "Sole/bottom", "Label/tag", "Defects (if any)"];
  const catPhotos = {
    sneakers: ["Box label", "Tongue label (style code)", "Heel", "Size tag", "Box front"],
    handbags: ["Hardware closeup", "Interior", "Date code / serial", "Stitching", "Lining"],
    watches:  ["Dial front", "Crown", "Caseback", "Serial engraving", "Bracelet clasp", "Papers (if available)"],
  };
  return [...base, ...(catPhotos[cat] || [])];
}

function _buildPlatformTips(p, cat) {
  if (!p) return [];
  const tips = [];
  if (p.id === "ebay") {
    tips.push("Set Best Offer to accept 10-15% below list price");
    tips.push("Enable eBay Authenticity Guarantee if category qualifies");
  }
  if (p.id === "stockx") {
    tips.push("Price must be at or below ask for immediate sale");
    tips.push("Item must be in stated condition — rejected items are returned at cost");
  }
  if (p.id === "grailed") {
    tips.push("Price slightly high initially — Grailed buyers negotiate");
    tips.push("Good photos are critical on Grailed — collector buyers expect detail");
  }
  if (p.id === "chrono24") {
    tips.push("Include reference number, year, condition grade, and service history");
    tips.push("Escrow protection: buyer has 5 days to confirm after receipt");
  }
  if (p.id === "local") {
    tips.push("Meet in public location (police station parking lot preferred)");
    tips.push("Verify cash with counterfeit detector pen or at ATM");
    tips.push("Do not release item until cash is verified");
  }
  return tips;
}
