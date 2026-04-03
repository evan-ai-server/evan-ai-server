// src/categoryProfiles.js
// Phase 2 — Category Domination Engine.
//
// Formal deep category profiles for the three high-priority categories:
//   sneakers, handbags (luxury), watches (luxury)
//
// Each profile encodes:
//   - attributeSchema       canonical fields that must be extracted
//   - authCriticalFields    fields that directly affect authenticity assessment
//   - counterfeitIndicators known red-flag patterns and their severity
//   - priceSensitiveDimensions  what drives resale price variance
//   - conditionSensitiveDimensions  condition factors that move price significantly
//   - trustPenalties        per-field penalties applied when field is missing/wrong
//   - confidenceFloors      minimum confidence thresholds before buy signals fire
//   - warningTypes          machine-readable warning codes with metadata
//
// Non-priority categories get a generic stub — deep intelligence only for 3.

import { CAT } from "./categoryRegistry.js";

// ── Warning code registry ─────────────────────────────────────────────────────

export const WARN = {
  // Sneakers
  STYLE_CODE_UNVERIFIED:          "STYLE_CODE_UNVERIFIED",
  SIZE_UNCONFIRMED:               "SIZE_UNCONFIRMED",
  SOLE_CONSTRUCTION_SUSPICIOUS:   "SOLE_CONSTRUCTION_SUSPICIOUS",
  COLORWAY_MISMATCH:              "COLORWAY_MISMATCH",
  CONDITION_OVERCLAIMED:          "CONDITION_OVERCLAIMED",
  BOX_MISSING_UNMENTIONED:        "BOX_MISSING_UNMENTIONED",

  // Handbags
  DATE_CODE_UNVERIFIED:           "DATE_CODE_UNVERIFIED",
  DATE_CODE_FORMAT_WRONG:         "DATE_CODE_FORMAT_WRONG",
  SERIAL_NUMBER_MISSING:          "SERIAL_NUMBER_MISSING",
  HARDWARE_QUALITY_UNCONFIRMED:   "HARDWARE_QUALITY_UNCONFIRMED",
  ACCESSORIES_INCOMPLETE:         "ACCESSORIES_INCOMPLETE",
  MONOGRAM_ALIGNMENT_SUSPICIOUS:  "MONOGRAM_ALIGNMENT_SUSPICIOUS",
  STITCHING_QUALITY_UNCONFIRMED:  "STITCHING_QUALITY_UNCONFIRMED",
  LEATHER_TYPE_UNSPECIFIED:       "LEATHER_TYPE_UNSPECIFIED",

  // Watches
  REFERENCE_UNVERIFIED:           "REFERENCE_UNVERIFIED",
  MOVEMENT_TYPE_UNCONFIRMED:      "MOVEMENT_TYPE_UNCONFIRMED",
  PAPERS_NOT_MENTIONED:           "PAPERS_NOT_MENTIONED",
  CASEBACK_NOT_VERIFIED:          "CASEBACK_NOT_VERIFIED",
  SERIAL_BETWEEN_LUGS_UNCONFIRMED:"SERIAL_BETWEEN_LUGS_UNCONFIRMED",
  DIAL_DETAILS_INCONSISTENT:      "DIAL_DETAILS_INCONSISTENT",
  BRACELET_STRETCH_UNASSESSED:    "BRACELET_STRETCH_UNASSESSED",
  CYCLOPS_MAGNIFICATION_SUSPECT:  "CYCLOPS_MAGNIFICATION_SUSPECT",

  // Cross-category
  PRICE_BELOW_AUTH_FLOOR:         "PRICE_BELOW_AUTH_FLOOR",
  COUNTERFEIT_PATTERN_MATCH:      "COUNTERFEIT_PATTERN_MATCH",
  EXPERT_FLAGGED:                 "EXPERT_FLAGGED",
  IDENTITY_CONFIDENCE_LOW:        "IDENTITY_CONFIDENCE_LOW",
};

// ── Deep category profiles ────────────────────────────────────────────────────

const DEEP_PROFILES = {

  // ────────────────────────────────────────────────────────────────────────────
  // SNEAKERS
  // ────────────────────────────────────────────────────────────────────────────
  [CAT.SNEAKERS]: {
    displayName: "Sneakers",
    replicaRisk: "HIGH",

    // All canonical fields for a complete sneaker identity
    attributeSchema: {
      brand:        { required: true,  type: "string",  desc: "Nike / Jordan / Adidas / New Balance / etc." },
      model:        { required: true,  type: "string",  desc: "Air Max 90 / Dunk Low / Yeezy 350 V2 / etc." },
      styleCode:    { required: false, type: "string",  desc: "Nike SKU e.g. CT8012-100 — strongest identity signal" },
      colorway:     { required: true,  type: "string",  desc: "Chicago / Bred / Panda / etc." },
      size:         { required: true,  type: "string",  desc: "Men's US 10 / Women's 8 / etc." },
      condition:    { required: true,  type: "string",  desc: "DS / VNDS / Used Excellent / Used Good / Beater" },
      year:         { required: false, type: "number",  desc: "Release year — important for retros vs. OG" },
      edition:      { required: false, type: "string",  desc: "Collab name / Limited / General Release" },
      boxIncluded:  { required: false, type: "boolean", desc: "Whether original box is present" },
      retailPrice:  { required: false, type: "number",  desc: "MSRP at time of release" },
    },

    // These fields directly determine whether auth is possible
    authCriticalFields: ["brand", "model", "styleCode", "colorway"],

    // Known counterfeit indicator patterns with severity
    counterfeitIndicators: [
      { pattern: "price_below_brand_floor",       severity: "critical", desc: "Price is below the brand's authentic price floor" },
      { pattern: "style_code_absent",             severity: "high",    desc: "No style code means identity cannot be verified against Nike/Adidas DB" },
      { pattern: "sole_construction_mismatch",    severity: "high",    desc: "Sole seam, boost texture, or air unit differs from authentic" },
      { pattern: "tag_font_inconsistency",        severity: "high",    desc: "Inner tag font weight/typeface doesn't match legit example" },
      { pattern: "colorway_name_mismatch",        severity: "medium",  desc: "Listed colorway name doesn't match style code" },
      { pattern: "condition_overclaimed",         severity: "medium",  desc: "DS/VNDS claim without box or photos of soles/insoles" },
      { pattern: "logo_stitching_irregular",      severity: "high",    desc: "Swoosh / Jumpman / three-stripe stitching irregular or asymmetric" },
    ],

    // Dimensions that move resale price by >10%
    priceSensitiveDimensions: [
      "colorway",   // grail colorways can be 2x retail
      "size",       // rare sizes (4-6, 14-15) trade at -15%; in-demand (8-11) at premium
      "condition",  // DS to Used Good can be 40% spread
      "edition",    // collabs command significant premium
      "boxIncluded", // no box = -5% to -10%
      "styleCode",   // if style code verifies rare release, premium applies
    ],

    // Condition factors that significantly move price
    conditionSensitiveDimensions: [
      "sole_yellowing",     // significant value destroyer for DS claims
      "heel_drag",          // common on used, affects price band
      "toe_box_creasing",   // heavy creasing = lower condition tier
      "insole_wear",        // shows wear even when exterior looks good
      "sole_separation",    // structural — drops to beater tier
    ],

    // Trust penalties for missing/wrong fields (delta applied to trustScore)
    trustPenalties: {
      styleCode_missing:          -0.08,  // can't verify identity without SKU
      size_missing:               -0.05,  // size is price-critical
      colorway_mismatch:          -0.10,  // colorway/style code don't match
      condition_overclaimed:      -0.12,  // DS claim without evidence
      price_below_brand_floor:    -0.20,  // strongest counterfeit signal
      logo_irregularity_detected: -0.18,
      style_code_format_invalid:  -0.10,
    },

    // Minimum values required for buy signals to fire
    confidenceFloors: {
      minIdentityConfidence:   0.72,  // must be fairly sure what it is
      minTrustForBuySignal:    0.60,
      minTrustForGreatDeal:    0.70,
      maxAuthRiskForGoodDeal:  0.40,  // auth risk above 40% blocks GOOD DEAL
    },

    // Machine-readable warning codes for this category
    warningTypes: {
      [WARN.STYLE_CODE_UNVERIFIED]:       { severity: "high",    blocking: false, message: "Style code not present — identity cannot be verified against brand database" },
      [WARN.SIZE_UNCONFIRMED]:            { severity: "medium",  blocking: false, message: "Shoe size not confirmed — pricing accuracy reduced" },
      [WARN.SOLE_CONSTRUCTION_SUSPICIOUS]:{ severity: "critical", blocking: true,  message: "Sole construction details suggest counterfeit — verify in-person" },
      [WARN.COLORWAY_MISMATCH]:           { severity: "high",    blocking: true,  message: "Colorway name does not match style code — identity inconsistency" },
      [WARN.CONDITION_OVERCLAIMED]:       { severity: "medium",  blocking: false, message: "Condition claim (DS/VNDS) lacks photographic evidence" },
      [WARN.BOX_MISSING_UNMENTIONED]:     { severity: "low",     blocking: false, message: "Original box not mentioned — may reduce resale value" },
      [WARN.PRICE_BELOW_AUTH_FLOOR]:      { severity: "critical", blocking: true,  message: "Price is below the authentic brand price floor — near-certain counterfeit" },
      [WARN.COUNTERFEIT_PATTERN_MATCH]:   { severity: "critical", blocking: true,  message: "Attributes match known counterfeit patterns in memory" },
    },

    // Brand-level auth data extended for sneakers
    brandAuthProfiles: {
      "jordan": {
        priceFloor: 80,
        authTells: [
          "Jumpman logo asymmetry or blurry stitching",
          "Outsole heel pod color mismatch",
          "Lace holes misaligned or uneven spacing",
          "Insole print: fake Jordans have flat Nike logo instead of debossed",
          "Toe box shape: too rounded on fakes vs angular on legit",
        ],
        styleCodeFormat: /^[A-Z]{2}[0-9]{4}-[0-9]{3}$/,
        authServices: ["GOAT", "StockX", "Legit Check App", "Cop or Not"],
      },
      "nike": {
        priceFloor: 40,
        authTells: [
          "Swoosh stitching too thin or misaligned",
          "Tag font inconsistency — check inner tag typeface",
          "Sole unit separation near toe box",
          "Air unit bubbles irregular on fakes",
        ],
        styleCodeFormat: /^[A-Z]{2}[0-9]{4}-[0-9]{3}$/,
        authServices: ["GOAT", "StockX", "Legit Check App"],
      },
      "adidas": {
        priceFloor: 35,
        authTells: [
          "Three stripes uneven width or spacing",
          "Boost foam: fakes shinier and smoother — legit is matte granular",
          "Heel tab: incorrect font or off-center",
          "Inner tag: Adidas logo font angle differs",
        ],
        styleCodeFormat: /^[A-Z]{2}[0-9]{4}$/,
        authServices: ["GOAT", "StockX", "Legit Check App"],
      },
      "new balance": {
        priceFloor: 30,
        authTells: [
          "N logo embroidery — check stitch density and thread color match",
          "Made in USA vs made overseas — significant value difference",
          "Sole pattern: reference authentic pair photos",
        ],
        authServices: ["eBay Authentication", "Legit Check App"],
      },
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  // HANDBAGS (LUXURY)
  // ────────────────────────────────────────────────────────────────────────────
  [CAT.HANDBAGS]: {
    displayName: "Luxury Handbags",
    replicaRisk: "HIGH",

    attributeSchema: {
      brand:            { required: true,  type: "string",  desc: "Louis Vuitton / Chanel / Gucci / Hermès / Prada / etc." },
      model:            { required: true,  type: "string",  desc: "Neverfull / Classic Flap / Marmont / Birkin / etc." },
      material:         { required: true,  type: "string",  desc: "Canvas / Lambskin / Caviar / Saffiano / Monogram / etc." },
      color:            { required: true,  type: "string",  desc: "Black / Beige / Red / Caramel / etc." },
      hardwareColor:    { required: true,  type: "string",  desc: "Gold / Silver / Palladium / Rose Gold" },
      dateCode:         { required: false, type: "string",  desc: "Brand-specific date/factory code stamped inside (LV: SD4090, Chanel: series sticker)" },
      serialNumber:     { required: false, type: "string",  desc: "Unique serial for authentication (Chanel serial card, Gucci number)" },
      size:             { required: false, type: "string",  desc: "PM / MM / GM or dimensions in cm" },
      style:            { required: false, type: "string",  desc: "Tote / Crossbody / Shoulder / Clutch / Top-Handle" },
      accessories:      { required: false, type: "array",   desc: "Dustbag / Box / Authenticity Card / Receipt / Lock & Keys" },
      condition:        { required: true,  type: "string",  desc: "Pristine / Excellent / Very Good / Good / Fair" },
      year:             { required: false, type: "number",  desc: "Approximate year from date code" },
      exoticLeather:    { required: false, type: "boolean", desc: "Croc / Python / Ostrich — major price multiplier" },
    },

    authCriticalFields: ["brand", "model", "material", "dateCode", "serialNumber", "hardwareColor"],

    counterfeitIndicators: [
      { pattern: "date_code_format_wrong",       severity: "critical", desc: "Date code format doesn't match brand convention (LV: 2 letters + 4 digits)" },
      { pattern: "date_code_absent",             severity: "high",    desc: "No date code present — difficult to verify as authentic" },
      { pattern: "hardware_lightweight",         severity: "high",    desc: "Hardware described as lightweight or plastic — authentic luxury hardware is solid metal" },
      { pattern: "stitching_uneven_or_loose",    severity: "high",    desc: "Stitching inconsistency — authentic bags have 5-6 stitches/inch, even, no loose threads" },
      { pattern: "monogram_misaligned_at_seams", severity: "critical", desc: "Pattern/monogram doesn't flow continuously at seams — strong fake indicator (LV/Gucci)" },
      { pattern: "price_below_auth_floor",       severity: "critical", desc: "Price far below brand floor — near-certain counterfeit" },
      { pattern: "serial_card_font_off",         severity: "high",    desc: "Serial/authenticity card font weight or layout differs from authentic" },
      { pattern: "interior_lining_quality_low",  severity: "medium",  desc: "Interior lining material feels plasticky or thin" },
    ],

    priceSensitiveDimensions: [
      "brand",          // LV Neverfull MM vs Chanel Classic Flap — enormous spread
      "model",          // Birkin 30 vs Evelyne — major model-level price variance
      "material",       // exotic leather can 5-10x price vs canvas
      "condition",      // Pristine to Good = 30-50% spread
      "accessories",    // full set (dustbag+box+receipt+card) adds 15-25%
      "hardwareColor",  // gold vs silver can affect value on some models
      "year",           // vintage pieces (pre-2000) can be premium
      "size",           // Neverfull PM vs GM = 30% spread
    ],

    conditionSensitiveDimensions: [
      "corner_wear",          // leather peeling or darkening at corners
      "handle_darkening",     // patina or staining on handles
      "hardware_tarnish",     // scratches or tarnishing on clasps/D-rings
      "interior_staining",    // pen marks, makeup, liquid stains inside
      "strap_cracking",       // leather cracking on straps
      "lining_peeling",       // interior lining separating (common on some LV)
    ],

    trustPenalties: {
      date_code_missing:            -0.10,
      date_code_format_wrong:       -0.22,  // wrong format is near-certain fake
      serial_number_missing:        -0.08,
      hardware_quality_unconfirmed: -0.06,
      monogram_alignment_suspicious:-0.18,
      stitching_quality_unconfirmed:-0.08,
      price_below_brand_floor:      -0.25,  // LV under $200 = almost certainly fake
      accessories_incomplete:       -0.03,  // minor — but noted
    },

    confidenceFloors: {
      minIdentityConfidence:   0.68,
      minTrustForBuySignal:    0.55,
      minTrustForGreatDeal:    0.70,
      maxAuthRiskForGoodDeal:  0.35,
    },

    warningTypes: {
      [WARN.DATE_CODE_UNVERIFIED]:         { severity: "high",    blocking: false, message: "Date code not visible or not mentioned — cannot verify production date" },
      [WARN.DATE_CODE_FORMAT_WRONG]:       { severity: "critical", blocking: true,  message: "Date code format doesn't match brand convention — strong fake indicator" },
      [WARN.SERIAL_NUMBER_MISSING]:        { severity: "high",    blocking: false, message: "No serial number found — authentication card match impossible" },
      [WARN.HARDWARE_QUALITY_UNCONFIRMED]: { severity: "medium",  blocking: false, message: "Hardware weight and quality not confirmed — critical for luxury auth" },
      [WARN.ACCESSORIES_INCOMPLETE]:       { severity: "low",     blocking: false, message: "Dustbag/box/card not mentioned — may indicate prior authentication issue or reduce resale" },
      [WARN.MONOGRAM_ALIGNMENT_SUSPICIOUS]:{ severity: "critical", blocking: true,  message: "Monogram/pattern alignment at seams is suspicious — near-certain counterfeit indicator" },
      [WARN.STITCHING_QUALITY_UNCONFIRMED]:{ severity: "medium",  blocking: false, message: "Stitching quality not confirmed — request close-up photos" },
      [WARN.LEATHER_TYPE_UNSPECIFIED]:     { severity: "low",     blocking: false, message: "Leather type not specified — affects both value and auth assessment" },
      [WARN.PRICE_BELOW_AUTH_FLOOR]:       { severity: "critical", blocking: true,  message: "Price is far below the authentic brand floor — near-certain counterfeit" },
      [WARN.COUNTERFEIT_PATTERN_MATCH]:    { severity: "critical", blocking: true,  message: "Attributes match known counterfeit patterns in memory" },
    },

    brandAuthProfiles: {
      "louis vuitton": {
        priceFloor: 200,
        dateCodeFormat: /^[A-Z]{2}[0-9]{4}$/,  // 2 letters (factory) + 4 digits (week+year)
        dateCodeExplained: "Factory initials + week digits alternating with year digits (e.g. SD4090 = S.D. factory, week 40, year 90→2009→actually 2009 or 1990 depending on format era)",
        authTells: [
          "LV monogram: must flow continuously at ALL seams — no cut-off at edges",
          "Heat stamp: LOUIS VUITTON PARIS must be centered, correct weight, correct font",
          "Date code: 2-letter factory code + 4-digit date code inside seam pocket or under flap",
          "Hardware: solid brass, significant weight, stamped with LV",
          "Zipper pull: Éclair or YKK branded",
          "Stitching: mustard/tan thread, 5-6 stitches/inch, perfectly even",
          "Interior: alcantara or canvas lining depending on line — no glue smell",
        ],
        serialPresence: false,  // LV uses date codes not serial numbers
        authServices: ["Entrupy", "Real Authentication", "Authenticate First", "LV Boutique"],
      },
      "chanel": {
        priceFloor: 1500,
        dateCodeFormat: null,  // Chanel uses series sticker (holographic) + authenticity card
        authTells: [
          "CC logo: LEFT C in front at TOP, RIGHT C in front at BOTTOM — never reversed",
          "Quilting: perfectly even diamond or chevron quilting — no puckering or asymmetry",
          "Serial sticker: holographic, inside bag, must match number on authenticity card",
          "Chain: solid heavy interwoven leather-chain — no rattling or lightweight feel",
          "Lining: authentic burgundy, beige, or black satin — never synthetic-feeling",
          "Zipper: should glide smoothly with appropriate Chanel-branded pull",
          "Dust bag: white cotton with black Chanel text — check font consistency",
        ],
        serialPresence: true,   // Chanel uses serial + auth card
        authServices: ["Entrupy", "Authenticate First", "Chanel Boutique"],
      },
      "gucci": {
        priceFloor: 300,
        dateCodeFormat: null,  // Gucci uses serial on interior leather patch
        authTells: [
          "GG logo: perfectly symmetric interlocking pattern, aligned at seams",
          "Leather serial patch: 6-digit Gucci number + style + color codes",
          "Leather grain: tight, consistent grain on authentic Gucci leather",
          "Hardware: heavy, consistent gold-tone across the piece",
          "Dust bag: brown with Gucci font — check font consistency",
        ],
        serialPresence: true,
        authServices: ["Entrupy", "Real Authentication", "Authenticate First"],
      },
      "hermes": {
        priceFloor: 3000,
        authTells: [
          "Blind stamp: letter + shape code stamped near hardware indicates craftsperson and year",
          "Hardware: palladium or gold — heavy, smooth, engraved 'Hermès Paris'",
          "Stitching: saddle-stitch, 8-10 stitches/inch, waxed linen thread, no loose ends",
          "Leather: each skin has unique characteristics — grain patterns consistent",
          "Lock: Hermès padlock must be heavy, engraved 'Hermès Paris', comes with 2 matching keys",
        ],
        serialPresence: true,
        authServices: ["Authenticate First", "Hermes Boutique — they will authenticate in-store"],
      },
      "prada": {
        priceFloor: 400,
        authTells: [
          "Enamel triangle logo: clean edges, correct font weight, correct angle",
          "Interior label: Prada Milano font — check character spacing",
          "Saffiano leather: distinctive cross-hatch pattern, scratch-resistant",
          "Hardware: brushed or polished gold/silver — consistent color throughout",
          "Authenticity card: credit-card style with logo embossing",
        ],
        serialPresence: true,
        authServices: ["Entrupy", "Real Authentication"],
      },
    },
  },

  // ────────────────────────────────────────────────────────────────────────────
  // WATCHES (LUXURY)
  // ────────────────────────────────────────────────────────────────────────────
  [CAT.WATCHES]: {
    displayName: "Luxury Watches",
    replicaRisk: "HIGH",

    attributeSchema: {
      brand:          { required: true,  type: "string",  desc: "Rolex / Omega / Patek Philippe / AP / Tag Heuer / etc." },
      model:          { required: true,  type: "string",  desc: "Submariner / Datejust / Seamaster / Speedmaster / etc." },
      reference:      { required: true,  type: "string",  desc: "Reference number (e.g. 126610LN for Sub) — single strongest identity signal" },
      movement:       { required: true,  type: "string",  desc: "Automatic / Manual / Quartz — must match authentic spec for that reference" },
      caseMaterial:   { required: true,  type: "string",  desc: "Stainless Steel / Yellow Gold / Rose Gold / Titanium / Platinum" },
      dialColor:      { required: true,  type: "string",  desc: "Black / Blue / White / Green / etc." },
      dialCondition:  { required: false, type: "string",  desc: "Mint / Good / Spider cracks / Relumed / Refinished" },
      bracelet:       { required: false, type: "string",  desc: "Oyster / Jubilee / President / rubber / leather — with stretch level" },
      serialNumber:   { required: false, type: "string",  desc: "Unique serial between lugs or on caseback" },
      yearProduced:   { required: false, type: "number",  desc: "Approximate production year from serial" },
      boxPapers:      { required: false, type: "string",  desc: "Full set / Papers only / Box only / No box no papers" },
      complications:  { required: false, type: "array",   desc: "Date / GMT / Chronograph / Moon phase / Power reserve / etc." },
      caseSize:       { required: false, type: "number",  desc: "Case diameter in mm" },
      caseback:       { required: false, type: "string",  desc: "Solid / Transparent / Exhibition — important for Rolex (solid = authentic)" },
      crown:          { required: false, type: "string",  desc: "Crown logo engraving present — key Rolex auth tell" },
    },

    authCriticalFields: ["brand", "model", "reference", "movement", "caseback"],

    counterfeitIndicators: [
      { pattern: "movement_visible_through_caseback", severity: "critical", desc: "Rolex and many Swiss brands use solid casebacks — exhibition back is immediate fake tell" },
      { pattern: "seconds_hand_ticking",              severity: "critical", desc: "Rolex movement should sweep smoothly (8 ticks/sec visible as sweep) — ticking = quartz = fake" },
      { pattern: "reference_unverifiable",            severity: "high",    desc: "Reference number absent or doesn't correspond to any known authentic model" },
      { pattern: "cyclops_magnification_off",         severity: "high",    desc: "Rolex Datejust cyclops should magnify date 2.5x — fakes often show less" },
      { pattern: "crown_logo_absent",                 severity: "high",    desc: "Crown logo on Rolex crown must be engraved — if absent or printed, fake" },
      { pattern: "rehaut_engraving_missing",          severity: "high",    desc: "Rolex should have 'ROLEX ROLEX ROLEX' laser-engraved on inner bezel ring (rehaut)" },
      { pattern: "weight_too_light",                  severity: "critical", desc: "Authentic Swiss watches are significantly heavier than fakes due to solid construction" },
      { pattern: "price_catastrophically_low",        severity: "critical", desc: "Rolex/AP/Patek at street market prices = replica guaranteed" },
    ],

    priceSensitiveDimensions: [
      "reference",      // specific ref numbers can 5-10x vs base model
      "boxPapers",      // full set adds 20-35% vs naked watch
      "dialCondition",  // original unrefined dial is premium — refinished dial is negative
      "bracelet",       // stretch on bracelet can be -$200-$1000 depending on model
      "year",           // vintage references trade at huge premium
      "caseMaterial",   // gold vs steel = massive spread
      "complications",  // GMT/Chron/moonphase variants command premium
      "dialColor",      // rare dials (tropical, Paul Newman) can be 10x+ premium
    ],

    conditionSensitiveDimensions: [
      "dial_condition",         // spider cracks, moisture damage, relumed dials
      "case_polishing",         // over-polished cases lose value (sharp edges gone)
      "bracelet_stretch",       // stretched links significantly reduce value
      "crystal_scratches",      // deep scratches on crystal affect grade
      "crown_wear",             // crown threading/condition
      "hands_condition",        // lume plots, printing condition on hands
    ],

    trustPenalties: {
      reference_missing:              -0.12,  // can't verify identity without ref
      movement_type_unconfirmed:      -0.08,  // quartz claim on auto model = counterfeit
      movement_visible_through_back:  -0.30,  // Rolex: critical fake tell
      seconds_hand_ticking:           -0.28,  // Rolex: quartz movement = fake
      reference_format_invalid:       -0.15,
      crown_logo_absent:              -0.15,
      cyclops_magnification_wrong:    -0.20,
      price_below_auth_floor:         -0.25,
    },

    confidenceFloors: {
      minIdentityConfidence:   0.75,  // watches require higher confidence
      minTrustForBuySignal:    0.62,
      minTrustForGreatDeal:    0.72,
      maxAuthRiskForGoodDeal:  0.30,  // watches are high-stakes — tighter gate
    },

    warningTypes: {
      [WARN.REFERENCE_UNVERIFIED]:            { severity: "high",    blocking: false, message: "Reference number not present — cannot verify model against authentic spec" },
      [WARN.MOVEMENT_TYPE_UNCONFIRMED]:       { severity: "high",    blocking: false, message: "Movement type not confirmed — quartz in an 'automatic' is a primary fake tell" },
      [WARN.PAPERS_NOT_MENTIONED]:            { severity: "medium",  blocking: false, message: "Box/papers not mentioned — full set commands 20-35% premium; verify completeness" },
      [WARN.CASEBACK_NOT_VERIFIED]:           { severity: "high",    blocking: false, message: "Caseback type not confirmed — transparent back on Rolex = immediate fake indicator" },
      [WARN.SERIAL_BETWEEN_LUGS_UNCONFIRMED]: { severity: "high",    blocking: false, message: "Serial number (between lugs or on caseback) not confirmed — cannot verify production date" },
      [WARN.DIAL_DETAILS_INCONSISTENT]:       { severity: "critical", blocking: true,  message: "Dial details (indexes, printing, lume plots) inconsistent with known authentic references" },
      [WARN.BRACELET_STRETCH_UNASSESSED]:     { severity: "low",     blocking: false, message: "Bracelet stretch not assessed — significant value impact on Rolex/AP bracelets" },
      [WARN.CYCLOPS_MAGNIFICATION_SUSPECT]:   { severity: "critical", blocking: true,  message: "Cyclops magnification suspect — authentic Rolex magnifies date 2.5x" },
      [WARN.PRICE_BELOW_AUTH_FLOOR]:          { severity: "critical", blocking: true,  message: "Price is catastrophically below authentic floor — guaranteed counterfeit" },
      [WARN.COUNTERFEIT_PATTERN_MATCH]:       { severity: "critical", blocking: true,  message: "Attributes match known counterfeit patterns in memory" },
    },

    brandAuthProfiles: {
      "rolex": {
        priceFloor: 3000,
        referenceFormats: [/^\d{5,6}[A-Z]{0,2}$/, /^\d{6}[A-Z]{2}\d{4}$/],
        solidCaseback: true,   // Rolex ALWAYS has solid caseback — exception = fakes
        sweepingSeconds: true, // 8 ticks/second appears as sweep
        rehautEngraved: true,  // ROLEX ROLEX ROLEX around inner bezel
        authTells: [
          "Cyclops lens: must magnify date exactly 2.5x — fakes show less magnification",
          "Sweeping seconds: should appear continuous — ticking seconds = quartz = fake",
          "Caseback: ALWAYS solid on sports/dress models — see-through caseback = fake",
          "Crown: engraved Rolex crown logo, not printed",
          "Serial/model: between lugs at 12 and 6 o'clock — must be present and match",
          "Rehaut: inner bezel ring laser-engraved 'ROLEX ROLEX ROLEX' — post-2002 models",
        ],
        authServices: ["Rolex AD", "WatchCSA", "Bob's Watches", "Chrono24 escrow"],
        complications: {
          "Submariner": ["Date", "No-date"],
          "Datejust": ["Date"],
          "GMT-Master II": ["Date", "GMT"],
          "Daytona": ["Chronograph"],
          "Explorer": ["No complications", "GMT"],
          "Milgauss": ["No complications"],
          "Day-Date": ["Day", "Date"],
        },
      },
      "omega": {
        priceFloor: 500,
        authTells: [
          "Movement: should be automatic with smooth sweep — Speedmaster manual-wind exception",
          "Crown: Omega seahorse logo on crown",
          "Caseback: often has engraving with model info and serial",
          "Crystal: hesalite or sapphire depending on model — check spec",
        ],
        authServices: ["Omega Boutique", "WatchCSA", "Chrono24 escrow"],
      },
      "tag heuer": {
        priceFloor: 400,
        authTells: [
          "TAG Heuer logo: consistent font and positioning on dial",
          "Movement: ETA based or COSC certified — verify model specification",
          "Caseback: usually transparent on sports models showing movement",
        ],
        authServices: ["TAG Heuer Boutique", "Chrono24 escrow"],
      },
      "patek philippe": {
        priceFloor: 8000,
        authTells: [
          "Movements: finished by hand — even entry level PP movements are exquisite",
          "Calatrava cross: on dial and crown",
          "Geneva Seal: hallmark on movement if pre-2009 (now PP Seal)",
          "All new PP come with double-sealed paperwork",
        ],
        authServices: ["Patek Philippe Boutique only — reject any other auth service claim"],
      },
      "audemars piguet": {
        priceFloor: 10000,
        authTells: [
          "Royal Oak octagonal bezel: 8 screws perfectly aligned and tightened",
          "Integrated bracelet: seamless integration with case",
          "Movement: visible through transparent caseback — AP movements are finishing benchmarks",
          "Dial: 'Grande Tapisserie' or 'Petite Tapisserie' pattern must be perfectly regular",
        ],
        authServices: ["AP Boutique", "Watches of Switzerland", "Chrono24 escrow"],
      },
    },
  },
};

// ── Stub for non-priority categories ─────────────────────────────────────────

const GENERIC_PROFILE = {
  displayName: "General",
  replicaRisk: "LOW",
  attributeSchema: {
    brand:     { required: false, type: "string", desc: "Brand name" },
    model:     { required: false, type: "string", desc: "Model name" },
    condition: { required: false, type: "string", desc: "Condition description" },
  },
  authCriticalFields: ["brand"],
  counterfeitIndicators: [
    { pattern: "price_below_any_floor", severity: "medium", desc: "Price suspiciously low" },
  ],
  priceSensitiveDimensions: ["condition", "brand"],
  conditionSensitiveDimensions: ["wear", "damage"],
  trustPenalties: {},
  confidenceFloors: {
    minIdentityConfidence:  0.50,
    minTrustForBuySignal:   0.45,
    minTrustForGreatDeal:   0.60,
    maxAuthRiskForGoodDeal: 0.60,
  },
  warningTypes: {
    [WARN.PRICE_BELOW_AUTH_FLOOR]:   { severity: "high",    blocking: true,  message: "Price suspiciously low for this item type" },
    [WARN.IDENTITY_CONFIDENCE_LOW]:  { severity: "medium",  blocking: false, message: "Item identity is uncertain — pricing accuracy reduced" },
    [WARN.COUNTERFEIT_PATTERN_MATCH]:{ severity: "critical", blocking: true,  message: "Attributes match known counterfeit patterns" },
  },
  brandAuthProfiles: {},
};

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Get the deep category profile for a canonical category.
 * Returns the full deep profile for sneakers/handbags/watches;
 * returns a generic stub for all others.
 */
export function getDeepCategoryProfile(canonicalCategory) {
  return DEEP_PROFILES[canonicalCategory] || GENERIC_PROFILE;
}

/**
 * Check whether a category has a deep (non-generic) profile.
 */
export function hasDeepProfile(canonicalCategory) {
  return canonicalCategory in DEEP_PROFILES;
}

/**
 * Get the brand-level auth profile within a category profile.
 * Returns null if no brand match.
 */
export function getBrandAuthProfile(canonicalCategory, brandString) {
  const profile = getDeepCategoryProfile(canonicalCategory);
  if (!profile.brandAuthProfiles) return null;
  const brand = String(brandString || "").toLowerCase().trim();
  for (const [key, bp] of Object.entries(profile.brandAuthProfiles)) {
    if (brand.includes(key) || key.split(" ").every(t => brand.includes(t))) {
      return { brandKey: key, ...bp };
    }
  }
  return null;
}

/**
 * Get trust penalties for a category.
 */
export function getCategoryTrustPenalties(canonicalCategory) {
  return getDeepCategoryProfile(canonicalCategory).trustPenalties || {};
}

/**
 * Get confidence floors for a category.
 */
export function getConfidenceFloors(canonicalCategory) {
  return getDeepCategoryProfile(canonicalCategory).confidenceFloors || GENERIC_PROFILE.confidenceFloors;
}

/**
 * Get the full warning type registry for a category.
 */
export function getCategoryWarningTypes(canonicalCategory) {
  return getDeepCategoryProfile(canonicalCategory).warningTypes || {};
}

/**
 * Check whether a warning code is blocking (should prevent buy signal)
 * for a given category.
 */
export function isBlockingWarning(canonicalCategory, warningCode) {
  const wt = getCategoryWarningTypes(canonicalCategory);
  return wt[warningCode]?.blocking === true;
}
