// src/categoryAuthEngine.js
// Phase 2 — Category Authentication Engine.
//
// Produces a structured authentication assessment from:
//   - Extracted category attributes (from categoryAttributeExtractor.js)
//   - Category profile (from categoryProfiles.js)
//   - Counterfeit memory matches (from counterfeitMemory.js)
//   - Brand auth profile
//
// Output per scan:
//   authenticityRiskScore  — 0-1 (0=safe, 1=definitely fake)
//   authenticityConfidence — 0-1 (how confident we are in the risk assessment)
//   authenticitySignals    — [{type, direction, detail, weight}]
//   authenticityWarnings   — [{code, severity, message, blocking}]
//   recommendedActions     — string[] of actionable auth steps
//   trustPenalty           — negative delta to apply to trustScore

import { getDeepCategoryProfile, getBrandAuthProfile, WARN } from "./categoryProfiles.js";
import { CAT } from "./categoryRegistry.js";

// ── Main auth engine ──────────────────────────────────────────────────────────

/**
 * Run the category authentication engine.
 *
 * @param {object} opts
 *   extractionResult   {object}  — result from extractCategoryAttributes()
 *   category           {string}  — canonical category
 *   scannedPrice       {number|null}
 *   visionConfidence   {number}  — 0-1 from vision pipeline
 *   counterfeitMatches {Array}   — from counterfeitMemory.matchScanToCounterfeitPatterns()
 *   rawText            {string}
 * @returns {CategoryAuthResult}
 */
export function runCategoryAuthEngine({
  extractionResult   = {},
  category           = "",
  scannedPrice       = null,
  visionConfidence   = 0.5,
  counterfeitMatches = [],
  rawText            = "",
} = {}) {
  const profile    = getDeepCategoryProfile(category);
  const attrs      = extractionResult.extractedAttributes || {};
  const missing    = extractionResult.missingCriticalFields || [];
  const extrConf   = extractionResult.extractionConfidence ?? 0.5;
  const brand      = attrs.brand || "";
  const brandAuth  = getBrandAuthProfile(category, brand);

  const signals  = [];
  const warnings = [];
  let riskScore  = 0;

  // ── Signal 1: Vision confidence ────────────────────────────────────────────
  const visionRisk = clamp01(1 - (visionConfidence ?? 0.5));
  riskScore += visionRisk * 0.15;
  signals.push({
    type:      "vision_confidence",
    direction: visionRisk < 0.3 ? "safe" : visionRisk < 0.6 ? "neutral" : "risk",
    detail:    `Vision confidence ${pct(visionConfidence)} → base risk contribution ${pct(visionRisk * 0.15)}`,
    weight:    0.15,
  });

  // ── Signal 2: Extraction completeness ─────────────────────────────────────
  const extrRisk = clamp01(1 - extrConf);
  riskScore += extrRisk * 0.10;
  if (extrConf < 0.5) {
    signals.push({
      type:      "extraction_completeness",
      direction: "risk",
      detail:    `Only ${pct(extrConf)} of expected attributes extracted — identity is incomplete`,
      weight:    0.10,
    });
    warnings.push(buildWarning(WARN.IDENTITY_CONFIDENCE_LOW, profile));
  }

  // ── Signal 3: Missing critical fields ─────────────────────────────────────
  for (const field of missing) {
    const penalty = profile.trustPenalties?.[`${field}_missing`] ?? -0.04;
    riskScore += Math.abs(penalty) * 0.5;  // convert trust penalty to risk contribution
    signals.push({
      type:      "missing_critical_field",
      direction: "risk",
      detail:    `Critical field '${field}' missing — cannot complete auth assessment`,
      field,
      weight:    Math.abs(penalty) * 0.5,
    });
    const warnCode = fieldToWarningCode(field, category);
    if (warnCode) warnings.push(buildWarning(warnCode, profile));
  }

  // ── Signal 4: Price floor check ───────────────────────────────────────────
  const priceSignal = checkPriceFloor(attrs, brandAuth, scannedPrice, profile);
  if (priceSignal) {
    riskScore += priceSignal.riskContribution;
    signals.push(priceSignal.signal);
    warnings.push(buildWarning(WARN.PRICE_BELOW_AUTH_FLOOR, profile));
  }

  // ── Signal 5: Counterfeit memory matches ──────────────────────────────────
  if (counterfeitMatches.length > 0) {
    const topMatch = counterfeitMatches[0];
    const matchRisk = clamp01(topMatch.matchScore * 0.9);
    riskScore += matchRisk * 0.35;
    signals.push({
      type:      "counterfeit_memory_match",
      direction: "risk",
      detail:    `Matched ${counterfeitMatches.length} known counterfeit pattern(s) — top match ${pct(topMatch.matchScore)} confidence`,
      topPattern: topMatch.patternId,
      weight:    0.35,
    });
    warnings.push(buildWarning(WARN.COUNTERFEIT_PATTERN_MATCH, profile));
  }

  // ── Signal 6: Category-specific checks ────────────────────────────────────
  const catSignals = runCategorySpecificChecks(category, attrs, rawText, profile, brandAuth);
  for (const cs of catSignals) {
    riskScore += cs.riskContribution;
    signals.push(cs.signal);
    if (cs.warnCode) warnings.push(buildWarning(cs.warnCode, profile));
  }

  // ── Signal 7: Brand profile known fake tells match ────────────────────────
  if (brandAuth?.authTells?.length > 0 && rawText) {
    const tellSignal = matchFakeTellsToText(brandAuth.authTells, rawText);
    if (tellSignal) {
      riskScore += tellSignal.riskContribution;
      signals.push(tellSignal.signal);
    }
  }

  // ── Normalize risk score ───────────────────────────────────────────────────
  riskScore = clamp01(riskScore);

  // ── Auth confidence: how sure are we about this risk score? ───────────────
  // High confidence when: many data points, brand recognized, price check done
  const hasPrice        = scannedPrice != null && scannedPrice > 0;
  const brandRecognized = brandAuth !== null;
  const hasCounterfeit  = counterfeitMatches.length > 0;
  let authConfidence    = 0.40;   // base
  if (extrConf > 0.6) authConfidence += 0.15;
  if (hasPrice)       authConfidence += 0.15;
  if (brandRecognized)authConfidence += 0.15;
  if (hasCounterfeit) authConfidence += 0.10;
  if (visionConfidence > 0.7) authConfidence += 0.05;
  authConfidence = clamp01(authConfidence);

  // ── Trust penalty ─────────────────────────────────────────────────────────
  // Sum the trust penalties for confirmed issues (from category profile penalty table)
  let trustPenalty = 0;
  for (const w of warnings) {
    const penaltyKey = warningCodeToPenaltyKey(w.code);
    if (penaltyKey && profile.trustPenalties?.[penaltyKey]) {
      trustPenalty += profile.trustPenalties[penaltyKey];
    }
  }
  // Counterfeit match adds its own significant penalty
  if (counterfeitMatches.length > 0) {
    trustPenalty += Math.max(-0.30, -0.08 * counterfeitMatches.length);
  }
  trustPenalty = Math.max(-0.60, trustPenalty);  // cap at -0.60

  // ── Tier ──────────────────────────────────────────────────────────────────
  const tier = riskScore >= 0.75 ? "critical"
             : riskScore >= 0.50 ? "high"
             : riskScore >= 0.25 ? "moderate"
             : "low";

  // ── Recommended actions ───────────────────────────────────────────────────
  const recommendedActions = buildRecommendedActions(tier, brandAuth, warnings);

  // ── De-duplicate warnings ─────────────────────────────────────────────────
  const seenCodes   = new Set();
  const dedupWarnings = warnings.filter(w => {
    if (seenCodes.has(w.code)) return false;
    seenCodes.add(w.code);
    return true;
  });

  // ── Blocking check ────────────────────────────────────────────────────────
  const hasBlockingWarning = dedupWarnings.some(w => w.blocking);

  return {
    authenticityRiskScore:  round2(riskScore),
    authenticityConfidence: round2(authConfidence),
    tier,
    hasBlockingWarning,
    trustPenalty:           round2(trustPenalty),
    authenticitySignals:    signals,
    authenticityWarnings:   dedupWarnings,
    recommendedActions,
    brandAuth: brandAuth ? {
      brandKey:     brandAuth.brandKey,
      priceFloor:   brandAuth.priceFloor,
      authTells:    brandAuth.authTells?.slice(0, 3) || [],
      authServices: brandAuth.authServices?.slice(0, 3) || [],
    } : null,
  };
}

// ── Category-specific check runners ──────────────────────────────────────────

function runCategorySpecificChecks(category, attrs, rawText, profile, brandAuth) {
  switch (category) {
    case CAT.SNEAKERS: return checkSneakerSpecific(attrs, rawText, profile);
    case CAT.HANDBAGS: return checkHandbagSpecific(attrs, rawText, profile, brandAuth);
    case CAT.WATCHES:  return checkWatchSpecific(attrs, rawText, profile, brandAuth);
    default:           return [];
  }
}

function checkSneakerSpecific(attrs, rawText, profile) {
  const results = [];
  const rt = (rawText || "").toLowerCase();

  // Check style code format validity
  if (attrs.styleCode && attrs.brand) {
    const brandAuthEntry = Object.entries(profile.brandAuthProfiles || {})
      .find(([key]) => (attrs.brand || "").toLowerCase().includes(key));
    if (brandAuthEntry) {
      const [, bAuth] = brandAuthEntry;
      if (bAuth.styleCodeFormat && !bAuth.styleCodeFormat.test(attrs.styleCode)) {
        results.push({
          riskContribution: 0.10,
          warnCode: WARN.STYLE_CODE_UNVERIFIED,
          signal: {
            type:      "style_code_format_invalid",
            direction: "risk",
            detail:    `Style code '${attrs.styleCode}' doesn't match expected format for ${brandAuthEntry[0]}`,
            weight:    0.10,
          },
        });
      }
    }
  }

  // Check for fake sole construction language
  if (/\b(sole.{0,20}(peeling|separating|separated|cracked)|glue.{0,20}sole)\b/.test(rt)) {
    results.push({
      riskContribution: 0.12,
      warnCode: WARN.SOLE_CONSTRUCTION_SUSPICIOUS,
      signal: {
        type:      "sole_construction_suspicious",
        direction: "risk",
        detail:    "Sole construction language suggests separation or quality issues — common on replicas",
        weight:    0.12,
      },
    });
  }

  // DS claim without box
  if (attrs.condition === "DS" && attrs.boxIncluded === false) {
    results.push({
      riskContribution: 0.08,
      warnCode: WARN.CONDITION_OVERCLAIMED,
      signal: {
        type:      "ds_claim_no_box",
        direction: "risk",
        detail:    "DS condition claimed but original box explicitly absent — claim is suspect",
        weight:    0.08,
      },
    });
  }

  return results;
}

function checkHandbagSpecific(attrs, rawText, profile, brandAuth) {
  const results = [];
  const rt = (rawText || "").toLowerCase();
  const brand = (attrs.brand || "").toLowerCase();

  // LV date code format check
  if (brand.includes("louis vuitton") || brand.includes("lv")) {
    if (attrs.dateCode) {
      const lvFormat = /^[A-Z]{2}[0-9]{4}$/.test(attrs.dateCode.toUpperCase());
      if (!lvFormat) {
        results.push({
          riskContribution: 0.22,
          warnCode: WARN.DATE_CODE_FORMAT_WRONG,
          signal: {
            type:      "date_code_format_wrong",
            direction: "risk",
            detail:    `LV date code '${attrs.dateCode}' doesn't match format (2 letters + 4 digits) — strong fake indicator`,
            weight:    0.22,
          },
        });
      }
    } else {
      // No date code on LV = high risk
      results.push({
        riskContribution: 0.10,
        warnCode: WARN.DATE_CODE_UNVERIFIED,
        signal: {
          type:      "lv_date_code_absent",
          direction: "risk",
          detail:    "Louis Vuitton date code not present — all authentic LV items have a date code",
          weight:    0.10,
        },
      });
    }
  }

  // Monogram alignment check — look for explicit misalignment language
  if (/monogram.{0,30}(misalign|off.?center|not.?align|cut.?off)|seam.{0,30}(cut|break|split).{0,20}(pattern|mono)/i.test(rt)) {
    results.push({
      riskContribution: 0.20,
      warnCode: WARN.MONOGRAM_ALIGNMENT_SUSPICIOUS,
      signal: {
        type:      "monogram_alignment_suspicious",
        direction: "risk",
        detail:    "Monogram or pattern alignment described as misaligned — critical fake indicator for LV/Gucci",
        weight:    0.20,
      },
    });
  }

  // Hardware quality signal
  if (/\b(plastic|light|lightweight|hollow|cheap).{0,15}(hardware|clasp|buckle|zipper|lock)\b/.test(rt)) {
    results.push({
      riskContribution: 0.15,
      warnCode: WARN.HARDWARE_QUALITY_UNCONFIRMED,
      signal: {
        type:      "hardware_quality_poor",
        direction: "risk",
        detail:    "Hardware described as lightweight or plastic — authentic luxury hardware is solid metal",
        weight:    0.15,
      },
    });
  }

  // Stitching irregularity
  if (/\b(loose|uneven|sloppy|messy|bad).{0,15}(stitch|stitching|thread|sewing)\b/.test(rt)) {
    results.push({
      riskContribution: 0.12,
      warnCode: WARN.STITCHING_QUALITY_UNCONFIRMED,
      signal: {
        type:      "stitching_quality_poor",
        direction: "risk",
        detail:    "Stitching quality described as poor — authentic luxury bags have precise, even stitching",
        weight:    0.12,
      },
    });
  }

  return results;
}

function checkWatchSpecific(attrs, rawText, profile, brandAuth) {
  const results = [];
  const rt = (rawText || "").toLowerCase();
  const brand = (attrs.brand || "").toLowerCase();

  // Rolex-specific checks
  if (brand.includes("rolex")) {
    // Exhibition/transparent caseback = fake (Rolex never makes exhibition backs on production models)
    if (attrs.caseback === "transparent" || /\b(see.?through|exhibition|display|transparent).{0,15}(back|caseback)\b/.test(rt)) {
      results.push({
        riskContribution: 0.30,
        warnCode: WARN.CASEBACK_NOT_VERIFIED,
        signal: {
          type:      "rolex_exhibition_caseback",
          direction: "risk",
          detail:    "Rolex with exhibition caseback is a definitive fake — all production Rolex watches have solid casebacks",
          weight:    0.30,
        },
      });
    }

    // Ticking seconds hand (quartz movement) on Rolex
    if (/\b(tick|ticking|ticks every second|quartz)\b/.test(rt)) {
      results.push({
        riskContribution: 0.28,
        warnCode: WARN.MOVEMENT_TYPE_UNCONFIRMED,
        signal: {
          type:      "rolex_quartz_movement_detected",
          direction: "risk",
          detail:    "Ticking seconds hand or quartz movement on Rolex is a definitive fake — all Rolex watches use automatic or manual mechanical movements",
          weight:    0.28,
        },
      });
    }

    // Cyclops magnification concern
    if (/\b(date|cyclops)\b/.test(rt) && /\b(no magnif|flat|hard to read|barely|magnif.{0,15}wrong)\b/.test(rt)) {
      results.push({
        riskContribution: 0.18,
        warnCode: WARN.CYCLOPS_MAGNIFICATION_SUSPECT,
        signal: {
          type:      "cyclops_magnification_suspect",
          direction: "risk",
          detail:    "Cyclops lens magnification appears insufficient — authentic Rolex magnifies date 2.5x",
          weight:    0.18,
        },
      });
    }
  }

  // Reference verification for any watch brand
  if (!attrs.reference) {
    const severity = brand.includes("rolex") || brand.includes("patek") || brand.includes("audemars") ? 0.12 : 0.06;
    results.push({
      riskContribution: severity,
      warnCode: WARN.REFERENCE_UNVERIFIED,
      signal: {
        type:      "reference_absent",
        direction: "risk",
        detail:    "No reference number — cannot verify model against authentic specifications",
        weight:    severity,
      },
    });
  }

  // Movement type mismatch signal
  if (attrs.movement && attrs.reference && brandAuth) {
    // Only flag if movement is "quartz" on a brand that is overwhelmingly mechanical
    if (attrs.movement === "quartz" && (brand.includes("rolex") || brand.includes("patek") || brand.includes("audemars"))) {
      results.push({
        riskContribution: 0.25,
        warnCode: WARN.MOVEMENT_TYPE_UNCONFIRMED,
        signal: {
          type:      "movement_type_mismatch",
          direction: "risk",
          detail:    `Quartz movement on ${attrs.brand} — this brand produces exclusively mechanical movements`,
          weight:    0.25,
        },
      });
    }
  }

  // Dial details inconsistency
  if (/\b(wrong|off|incorrect|different|weird).{0,15}(dial|index|marker|hand|lume)\b/.test(rt)) {
    results.push({
      riskContribution: 0.15,
      warnCode: WARN.DIAL_DETAILS_INCONSISTENT,
      signal: {
        type:      "dial_details_inconsistent",
        direction: "risk",
        detail:    "Dial details described as inconsistent with reference — compare against authentic reference photos",
        weight:    0.15,
      },
    });
  }

  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function checkPriceFloor(attrs, brandAuth, scannedPrice, profile) {
  if (!scannedPrice || !Number.isFinite(scannedPrice) || scannedPrice <= 0) return null;
  if (!brandAuth?.priceFloor) return null;

  const floor = brandAuth.priceFloor;
  if (scannedPrice >= floor) return null;

  const severity = scannedPrice < floor * 0.3 ? "critical" : "high";
  const riskContrib = severity === "critical" ? 0.40 : 0.25;

  return {
    riskContribution: riskContrib,
    signal: {
      type:      "price_below_brand_floor",
      direction: "risk",
      detail:    `Price $${scannedPrice} is below authentic ${brandAuth.brandKey} floor ($${floor}) — ${severity} counterfeit risk`,
      weight:    riskContrib,
    },
  };
}

function matchFakeTellsToText(authTells, rawText) {
  const rt = rawText.toLowerCase();
  // Look for language that explicitly confirms a known fake tell exists
  const fakeTriggers = [
    /jumpman.{0,20}(asymmetry|blurry|off|wrong)/,
    /swoosh.{0,20}(thin|misalign|off|wrong)/,
    /\b(flat|shallow).{0,10}(air unit|air bubble)/,
    /boost.{0,15}(shiny|smooth|wrong|cheap)/,
    /lining.{0,15}(plastic|peeling|wrong|fake)/,
  ];
  for (const regex of fakeTriggers) {
    if (regex.test(rt)) {
      return {
        riskContribution: 0.18,
        signal: {
          type:      "fake_tell_language_detected",
          direction: "risk",
          detail:    "Listing text contains language matching known counterfeit tells",
          weight:    0.18,
        },
      };
    }
  }
  return null;
}

function buildWarning(code, profile) {
  const wt = profile.warningTypes?.[code];
  return {
    code,
    severity: wt?.severity || "medium",
    message:  wt?.message || code,
    blocking: wt?.blocking || false,
  };
}

function buildRecommendedActions(tier, brandAuth, warnings) {
  const actions = [];
  if (tier === "critical") {
    actions.push("Do NOT purchase without in-person professional authentication");
  } else if (tier === "high") {
    actions.push("Professional authentication strongly recommended before purchase");
  } else if (tier === "moderate") {
    actions.push("Request high-resolution photos of all authentication checkpoints before buying");
  } else {
    actions.push("Standard due diligence applies — verify key identity points");
  }

  if (brandAuth?.authServices?.length > 0) {
    actions.push(`Recommended auth services: ${brandAuth.authServices.slice(0, 2).join(", ")}`);
  }

  if (warnings.some(w => w.code === WARN.DATE_CODE_FORMAT_WRONG)) {
    actions.push("Ask seller for clear photo of date code — verify format matches brand convention");
  }
  if (warnings.some(w => w.code === WARN.REFERENCE_UNVERIFIED)) {
    actions.push("Ask seller for reference number to verify against authentic model database");
  }
  if (warnings.some(w => w.code === WARN.CASEBACK_NOT_VERIFIED)) {
    actions.push("Confirm caseback type — Rolex solid caseback is mandatory; exhibition back = guaranteed fake");
  }

  return actions;
}

function fieldToWarningCode(field, category) {
  const MAP = {
    // Sneakers
    styleCode:    WARN.STYLE_CODE_UNVERIFIED,
    size:         WARN.SIZE_UNCONFIRMED,
    // Handbags
    dateCode:     WARN.DATE_CODE_UNVERIFIED,
    serialNumber: WARN.SERIAL_NUMBER_MISSING,
    hardwareColor:WARN.HARDWARE_QUALITY_UNCONFIRMED,
    material:     WARN.LEATHER_TYPE_UNSPECIFIED,
    // Watches
    reference:    WARN.REFERENCE_UNVERIFIED,
    movement:     WARN.MOVEMENT_TYPE_UNCONFIRMED,
    caseback:     WARN.CASEBACK_NOT_VERIFIED,
  };
  return MAP[field] || null;
}

function warningCodeToPenaltyKey(code) {
  const MAP = {
    [WARN.STYLE_CODE_UNVERIFIED]:        "styleCode_missing",
    [WARN.SIZE_UNCONFIRMED]:             "size_missing",
    [WARN.COLORWAY_MISMATCH]:            "colorway_mismatch",
    [WARN.CONDITION_OVERCLAIMED]:        "condition_overclaimed",
    [WARN.PRICE_BELOW_AUTH_FLOOR]:       "price_below_brand_floor",
    [WARN.DATE_CODE_UNVERIFIED]:         "date_code_missing",
    [WARN.DATE_CODE_FORMAT_WRONG]:       "date_code_format_wrong",
    [WARN.SERIAL_NUMBER_MISSING]:        "serial_number_missing",
    [WARN.HARDWARE_QUALITY_UNCONFIRMED]: "hardware_quality_unconfirmed",
    [WARN.REFERENCE_UNVERIFIED]:         "reference_missing",
    [WARN.MOVEMENT_TYPE_UNCONFIRMED]:    "movement_type_unconfirmed",
    [WARN.CASEBACK_NOT_VERIFIED]:        "movement_visible_through_back",
  };
  return MAP[code] || null;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function pct(v) {
  return `${Math.round((Number(v) || 0) * 100)}%`;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
