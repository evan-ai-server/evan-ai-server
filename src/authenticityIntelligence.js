// src/authenticityIntelligence.js
// Deep counterfeit intelligence: brand-specific fake tells, price floor detection,
// authentication service routing, and layered risk scoring.

// ── Brand-specific fake tell registry ────────────────────────────────────────
const BRAND_FAKE_TELLS = {
  "jordan": {
    priceFloor:      80,
    knownFakeTells: [
      "Jumpman logo asymmetry or blurry stitching",
      "Outsole color mismatch — check heel pod color",
      "Lace holes misaligned or uneven spacing",
      "Insole print: fake Jordans often have a flat Nike logo instead of debossed",
      "Toe box shape too rounded on fakes vs. angular on legit",
    ],
    authServices:    ["GOAT", "StockX", "Legit Check App", "Cop or Not"],
    legitimacyHints: ["DS box with correct SKU", "Retail receipt", "Nike.com order confirmation"],
  },
  "nike": {
    priceFloor:      40,
    knownFakeTells: [
      "Swoosh stitching too thin or misaligned",
      "Tag font inconsistency — check inner tag typeface",
      "Sole unit separation near toe box on replicas",
      "Air unit: bubbles in fakes are often irregular shape",
    ],
    authServices:    ["GOAT", "StockX", "Legit Check App"],
    legitimacyHints: ["Nike.com receipt", "Retail box with correct barcode SKU"],
  },
  "adidas": {
    priceFloor:      35,
    knownFakeTells: [
      "Three stripes uneven width or spacing",
      "Boost foam: fakes have smoother, shinier boost — legit has matte granular texture",
      "Heel tab: incorrect font or off-center placement",
      "Inner tag: Adidas logo font differs from legit — check angle of A",
    ],
    authServices:    ["GOAT", "StockX", "Legit Check App"],
    legitimacyHints: ["Adidas box with matching barcode", "Retail receipt"],
  },
  "louis vuitton": {
    priceFloor:      300,
    knownFakeTells: [
      "LV monogram misaligned at seams — should flow continuously",
      "Date code format: LV codes follow factory+year+week format",
      "Heat stamp: stamping should be clear, centered, correct font weight",
      "Hardware: fake hardware is lightweight and dulls quickly",
      "Stitching: authentic LV has 5-6 stitches per inch, even, no loose threads",
      "Zipper: should be Éclair or YKK branded",
    ],
    authServices:    ["Entrupy", "Real Authentication", "Authenticate First", "LV Boutique"],
    legitimacyHints: ["Receipt from LV boutique", "Certificate of authenticity", "Date code visible and correct format"],
  },
  "gucci": {
    priceFloor:      200,
    knownFakeTells: [
      "GG logo: pattern should be perfectly symmetric and aligned",
      "Serial number: must be 6-digit Gucci number, not random",
      "Leather: authentic Gucci leather has a tight grain pattern",
      "Dust bag: check for Gucci font consistency — fakes have loose typeface",
      "Hardware: should be heavy, gold-tone consistent across the piece",
    ],
    authServices:    ["Entrupy", "Real Authentication", "Authenticate First"],
    legitimacyHints: ["Gucci certificate card", "Gucci store receipt", "Provenance documentation"],
  },
  "chanel": {
    priceFloor:      500,
    knownFakeTells: [
      "CC logo: interlocking C's must overlap correctly — left C in front at top, right C in front at bottom",
      "Quilting: diamond quilting should be perfectly even with no puckering",
      "Serial sticker: always inside — matches authenticity card number",
      "Chain: should be heavy, solid link, no light rattling",
      "Lining: authentic burgundy, black, or beige satin — not plasticky",
    ],
    authServices:    ["Entrupy", "Authenticate First", "Chanel Boutique"],
    legitimacyHints: ["Authenticity card matching serial", "Chanel dust bag", "Boutique receipt"],
  },
  "rolex": {
    priceFloor:      3000,
    knownFakeTells: [
      "Cyclops lens: authentic magnifies date 2.5x — fakes often show less magnification",
      "Sweeping seconds hand: authentic Rolex has near-continuous sweep (8 ticks/sec) — fakes tick",
      "Caseback: authentic Rolex has plain solid caseback — visible movement through back = fake",
      "Crown: should have Rolex crown logo engraved, not printed",
      "Serial/model: found between lugs — must match references",
      "Rehaut: inner bezel should have 'ROLEX ROLEX ROLEX' laser engraved",
    ],
    authServices:    ["Rolex AD", "WatchCSA", "Bob's Watches authentication", "Chrono24 escrow"],
    legitimacyHints: ["Rolex papers and box", "Rolex service card", "AD purchase receipt"],
  },
  "ray-ban": {
    priceFloor:      30,
    knownFakeTells: [
      "Lens etching: 'RB' should be etched (not printed) in top corner of right lens",
      "Temple arm: Ray-Ban logo molded into arm — not sticker",
      "Hinge: authentic uses 7-barrel hinge — fakes use 5 or look rough",
      "Nose pad: adjustable, screwed in — fakes often have fixed plastic pads",
      "Case: should be hard shell with Ray-Ban branding inside",
    ],
    authServices:    ["Ray-Ban verified reseller check", "Legit Check App"],
    legitimacyHints: ["Original case with cloth", "Price tag with barcode", "Ray-Ban serial on right temple arm"],
  },
  "supreme": {
    priceFloor:      30,
    knownFakeTells: [
      "Box logo stitching: thread count and font size must match the specific season",
      "Tee tags: Hanes or Fruit of the Loom — check the exact tag format for that season",
      "Embroidery: fake BOGO has looser stitch density",
      "Hang tag: check hole punch placement and string color by season",
    ],
    authServices:    ["Legit Check App", "Grailed authentication", "Depop authenticity badge"],
    legitimacyHints: ["Supreme receipt or order confirmation", "Original bag", "Season/week drop proof"],
  },
  "apple": {
    priceFloor:      50,
    knownFakeTells: [
      "Serial number: check on apple.com/activate — fake serials return 'unable to check'",
      "IMEI: for iPhones, IMEI in Settings > General > About must match box",
      "Build quality: screen bezels, weight, and haptic feedback all off on clones",
      "USB-C/Lightning: fake connectors often have imprecise fit or look different",
      "FaceID/TouchID: functional on legit devices — missing or laggy on fakes",
    ],
    authServices:    ["Apple Store", "Apple.com serial check", "Apple Certified Refurbisher"],
    legitimacyHints: ["Apple box with matching serial", "iCloud activation check", "Original receipt"],
  },
};

// ── Price floor thresholds by category ───────────────────────────────────────
// If scanned price is below floor, high counterfeit risk
const CATEGORY_PRICE_FLOORS = {
  sneakers:    { floor: 30,    warning: "Sneakers under $30 are almost certainly counterfeit" },
  bag:         { floor: 50,    warning: "Luxury bags under $50 are near-certainly fake" },
  watch:       { floor: 20,    warning: "Watches under $20 from premium brands are counterfeit" },
  apparel:     { floor: 15,    warning: "Premium apparel under $15 is likely fake or stolen" },
  electronics: { floor: 25,    warning: "Electronics under $25 from premium brands are suspicious" },
  eyewear:     { floor: 15,    warning: "Premium eyewear under $15 is almost certainly counterfeit" },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Resolve brand-specific fake tells and auth service recommendations.
 */
export function resolveBrandAuthProfile(identity = {}) {
  const brand = String(identity?.brand || "").toLowerCase();

  for (const [key, profile] of Object.entries(BRAND_FAKE_TELLS)) {
    if (brand.includes(key) || key.split(" ").every(t => brand.includes(t))) {
      return { matched: true, brandKey: key, ...profile };
    }
  }
  return { matched: false, brandKey: null };
}

/**
 * Detect if the scanned price is suspiciously below the authentic price floor.
 */
export function detectPriceFloorViolation(identity = {}, scannedPrice, category = "") {
  const scanned = finiteOrNull(scannedPrice);
  if (!scanned) return null;

  const brand   = String(identity?.brand || "").toLowerCase();
  const profile = resolveBrandAuthProfile(identity);

  // Check brand-specific floor
  if (profile.matched && profile.priceFloor) {
    if (scanned < profile.priceFloor) {
      return {
        violated:      true,
        type:          "brand_price_floor",
        floor:         profile.priceFloor,
        scannedPrice:  scanned,
        riskLevel:     scanned < profile.priceFloor * 0.5 ? "critical" : "high",
        warning:       `Price is below the authentic ${brand} price floor ($${profile.priceFloor}) — extremely high counterfeit risk`,
      };
    }
  }

  // Check category floor
  const cat      = String(category || "").toLowerCase().replace(/s$/, "");
  const catFloor = CATEGORY_PRICE_FLOORS[cat];
  if (catFloor && scanned < catFloor.floor) {
    return {
      violated:     true,
      type:         "category_price_floor",
      floor:        catFloor.floor,
      scannedPrice: scanned,
      riskLevel:    "high",
      warning:      catFloor.warning,
    };
  }

  return { violated: false, scannedPrice: scanned };
}

/**
 * Compute a layered counterfeit risk score.
 */
export function computeLayeredAuthRisk({
  identity         = {},
  scannedPrice     = null,
  category         = "",
  visionConfidence = 0.5,
  existingAuthScore = null,  // 0-1 from existing authEngine if available
} = {}) {
  const profile       = resolveBrandAuthProfile(identity);
  const floorCheck    = detectPriceFloorViolation(identity, scannedPrice, category);

  // Base risk from vision confidence (low confidence = higher doubt)
  let riskScore = clamp01(1 - (visionConfidence ?? 0.5));

  // Price floor violation adds significant risk
  if (floorCheck?.violated) {
    riskScore = Math.min(1, riskScore + (floorCheck.riskLevel === "critical" ? 0.5 : 0.3));
  }

  // Existing auth engine score blends in if available
  if (existingAuthScore != null) {
    riskScore = riskScore * 0.4 + (1 - existingAuthScore) * 0.6;
  }

  const tier = riskScore >= 0.75 ? "critical"
             : riskScore >= 0.50 ? "high"
             : riskScore >= 0.25 ? "moderate"
             : "low";

  const recommendation = tier === "critical" ? "Do NOT buy without professional authentication"
    : tier === "high"     ? "Authentication strongly recommended before purchase"
    : tier === "moderate" ? "Request seller photos of key auth points before buying"
    : "Low risk — standard due diligence applies";

  return {
    riskScore:       round2(riskScore),
    tier,
    recommendation,
    priceFloorCheck: floorCheck     || null,
    brandProfile:    profile.matched ? {
      brandKey:      profile.brandKey,
      priceFloor:    profile.priceFloor,
      knownFakeTells:profile.knownFakeTells,
      authServices:  profile.authServices,
      legitimacyHints: profile.legitimacyHints,
    } : null,
  };
}

/**
 * Master authenticity intelligence payload.
 */
export function buildAuthenticityIntelPayload({
  identity         = {},
  scannedPrice     = null,
  category         = "",
  visionConfidence = 0.5,
  existingAuthScore = null,
} = {}) {
  const layeredRisk = computeLayeredAuthRisk({
    identity,
    scannedPrice,
    category,
    visionConfidence,
    existingAuthScore,
  });

  const profile = layeredRisk.brandProfile;

  return {
    riskScore:      layeredRisk.riskScore,
    tier:           layeredRisk.tier,
    recommendation: layeredRisk.recommendation,
    priceFloorCheck: layeredRisk.priceFloorCheck || null,

    // What to look for
    knownFakeTells:    profile?.knownFakeTells    || [],
    legitimacyHints:   profile?.legitimacyHints   || [],

    // Where to authenticate
    authServices:      profile?.authServices      || ["eBay Authentication", "Legit Check App"],

    // Top signal for UI
    topSignal: layeredRisk.tier === "critical" || layeredRisk.tier === "high"
      ? `⚠️ ${layeredRisk.recommendation}`
      : profile?.knownFakeTells?.length
      ? `Check: ${profile.knownFakeTells[0]}`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
