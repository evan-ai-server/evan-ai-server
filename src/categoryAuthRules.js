// src/categoryAuthRules.js
// Phase 4 — Category-Specific Authentication Rule Evaluators.
//
// Each category has a set of concrete YES/NO/UNKNOWN authentication checks.
// Unlike the Phase 2 auth engine (which produces risk scores), this module
// produces structured rule results that are:
//   - Named and codified for traceability
//   - Directly explainable to a user ("Style code present and valid")
//   - Independently evaluable (each rule is self-contained)
//   - The source of `positiveSignals` / `negativeSignals` / `missingSignals`
//     in the auth evidence model
//
// Rule result shape:
//   {
//     ruleId:         string,
//     category:       string,
//     description:    string,    — human-readable description of the rule
//     passed:         boolean | null,   — null = unable to evaluate (data missing)
//     weight:         number,    — relative importance 0.1–0.50
//     signal:         "positive" | "negative" | "unknown",
//     detail:         string,    — specific finding for this item
//     blocking:       boolean,   — if true, failure alone warrants RISKY signal
//     actionRequired: string | null,  — concrete verification step if failed/unknown
//   }

// ── Rule weight constants ─────────────────────────────────────────────────────

const W = {
  CRITICAL:  0.50,   // single failure blocks buy signal
  HIGH:      0.35,   // significant penalty
  MEDIUM:    0.20,   // moderate concern
  LOW:       0.10,   // informational
};

// ── Regex helpers ─────────────────────────────────────────────────────────────

const STYLE_CODE_PATTERNS = {
  nike:      /^[A-Z]{2}\d{4}-\d{3}$/i,                   // BQ6472-010
  jordan:    /^[A-Z]{2}\d{4}-\d{3}$/i,                   // CT8529-162
  adidas:    /^[A-Z]{2}\d{4}$/i,                          // EG7893
  "new balance": /^\d{3}[A-Z]{2}[A-Z0-9]*$/i,            // 574EC, 990GL3
  default:   /^[A-Z0-9]{4,15}(-[A-Z0-9]{3})?$/i,
};

const LV_DATE_CODE   = /^[A-Z]{2}[0-9]{4}$/i;
const CHANEL_SERIAL  = /^\d{7,10}$/;
const WATCH_REF      = /^[A-Z0-9]{4,16}(-[A-Z0-9]+)?$/i;
const ROLEX_SERIAL   = /^[A-Z0-9]{5,9}$/;

// ── Text presence helpers ─────────────────────────────────────────────────────

function textContains(rawText, ...terms) {
  const t = (rawText || "").toLowerCase();
  return terms.some(term => t.includes(term.toLowerCase()));
}

// ── Generic counterfeit rule (all categories) ─────────────────────────────────

function ruleCounterfeitMatch(counterfeitMatches, category) {
  const top = counterfeitMatches?.[0];
  if (!top) {
    return {
      ruleId: `${category.toUpperCase().slice(0,4)}_CF0`,
      category,
      description: "No known counterfeit pattern matched",
      passed: true,
      weight: W.CRITICAL,
      signal: "positive",
      detail: "No known counterfeit patterns found in Evan's memory for this item.",
      blocking: false,
      actionRequired: null,
    };
  }
  const blocking = top.matchScore >= 0.60;
  return {
    ruleId: `${category.toUpperCase().slice(0,4)}_CF0`,
    category,
    description: "No known counterfeit pattern matched",
    passed: false,
    weight: W.CRITICAL,
    signal: "negative",
    detail: `Matched known counterfeit pattern (score ${top.matchScore.toFixed(2)}): ${top.fakeSignals?.slice(0,2).join(", ") || "pattern matched"}.`,
    blocking,
    actionRequired: "Physically compare against documented authentic example. Seek expert authentication.",
  };
}

// ── SNEAKER RULES ─────────────────────────────────────────────────────────────

function evaluateSneakerRules({ extractedAttributes, authResult, counterfeitMatches, scannedPrice, rawText }) {
  const attrs = extractedAttributes || {};
  const brand = (attrs.brand || "").toLowerCase();
  const results = [];

  // SNKR_001 — Style code present and valid format
  {
    const sc = attrs.styleCode;
    const pattern = STYLE_CODE_PATTERNS[brand] || STYLE_CODE_PATTERNS.default;
    if (!sc) {
      results.push({
        ruleId: "SNKR_001", category: "sneakers",
        description: "Style code present and valid format",
        passed: null, weight: W.HIGH,
        signal: "unknown",
        detail: "No style code found. Style codes are the primary way to verify authenticity for this brand.",
        blocking: false,
        actionRequired: "Ask seller for clear photo of the tag on the tongue or insole showing the style code.",
      });
    } else if (pattern.test(sc)) {
      results.push({
        ruleId: "SNKR_001", category: "sneakers",
        description: "Style code present and valid format",
        passed: true, weight: W.HIGH,
        signal: "positive",
        detail: `Style code ${sc} is present and matches expected format.`,
        blocking: false,
        actionRequired: null,
      });
    } else {
      results.push({
        ruleId: "SNKR_001", category: "sneakers",
        description: "Style code present and valid format",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: `Style code "${sc}" does not match the expected format for ${attrs.brand || "this brand"}.`,
        blocking: false,
        actionRequired: "Verify the style code by cross-referencing with the brand's official product database.",
      });
    }
  }

  // SNKR_002 — Brand confirmed from image
  {
    const hasBrand = !!attrs.brand;
    results.push({
      ruleId: "SNKR_002", category: "sneakers",
      description: "Brand confirmed from image",
      passed: hasBrand ? true : null, weight: W.CRITICAL,
      signal: hasBrand ? "positive" : "unknown",
      detail: hasBrand
        ? `Brand confirmed: ${attrs.brand}.`
        : "Brand could not be confirmed from available image or text.",
      blocking: false,
      actionRequired: hasBrand ? null : "Provide a clear image showing the brand logo and tag.",
    });
  }

  // SNKR_003 — Condition claim is credible
  {
    const cond = (attrs.condition || "").toLowerCase();
    const boxIncluded = attrs.boxIncluded;
    if (!cond) {
      results.push({
        ruleId: "SNKR_003", category: "sneakers",
        description: "Condition claim is credible and consistent",
        passed: null, weight: W.MEDIUM,
        signal: "unknown",
        detail: "Condition was not specified.",
        blocking: false,
        actionRequired: "Ask seller to clarify condition with specific photos.",
      });
    } else if ((cond === "ds" || cond === "deadstock") && boxIncluded === false) {
      results.push({
        ruleId: "SNKR_003", category: "sneakers",
        description: "Condition claim is credible and consistent",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: `DS/Deadstock claim but no original box. Deadstock without original box is unusual and suspicious.`,
        blocking: false,
        actionRequired: "Ask seller why the box is missing if the shoe is truly unworn deadstock.",
      });
    } else {
      results.push({
        ruleId: "SNKR_003", category: "sneakers",
        description: "Condition claim is credible and consistent",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: `Condition "${cond}" is consistent with available evidence.`,
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // SNKR_004 — Price above brand floor
  {
    const floor = authResult?.brandAuth?.priceFloor ?? null;
    if (scannedPrice != null && floor != null) {
      const passed = scannedPrice >= floor;
      results.push({
        ruleId: "SNKR_004", category: "sneakers",
        description: "Price above brand floor",
        passed, weight: passed ? W.LOW : W.CRITICAL,
        signal: passed ? "positive" : "negative",
        detail: passed
          ? `Price $${scannedPrice} is above the $${floor} floor for ${attrs.brand || "this brand"}.`
          : `Price $${scannedPrice} is below the $${floor} minimum for genuine ${attrs.brand || "this brand"}. This is a strong counterfeit indicator.`,
        blocking: !passed,
        actionRequired: passed ? null : "Price is below the cost of genuine product. Treat as likely counterfeit unless explained.",
      });
    }
  }

  // SNKR_005 — No construction or material red flags in text
  {
    const soleIssue = textContains(rawText, "sole separation", "peeling sole", "sole peel", "glue", "re-glued");
    const logoIssue = textContains(rawText, "logo off-center", "swoosh asymmetry", "jumpman asymmetry", "logo misplaced", "stitching uneven");
    if (soleIssue || logoIssue) {
      const issues = [soleIssue && "sole construction issue", logoIssue && "logo/stitching concern"].filter(Boolean);
      results.push({
        ruleId: "SNKR_005", category: "sneakers",
        description: "No construction or material red flags",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: `Construction concern detected: ${issues.join(", ")}.`,
        blocking: false,
        actionRequired: "Request additional photos focusing on the sole and logo stitching.",
      });
    } else {
      results.push({
        ruleId: "SNKR_005", category: "sneakers",
        description: "No construction or material red flags",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: "No construction or material red flags detected in available description.",
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // SNKR_006 — Size specified
  {
    const hasSize = !!attrs.size;
    results.push({
      ruleId: "SNKR_006", category: "sneakers",
      description: "Size specified",
      passed: hasSize ? true : null, weight: W.LOW,
      signal: hasSize ? "positive" : "unknown",
      detail: hasSize ? `Size ${attrs.size} specified.` : "Size not specified in listing.",
      blocking: false,
      actionRequired: hasSize ? null : "Confirm size with seller.",
    });
  }

  // SNKR_007 — Counterfeit pattern
  results.push(ruleCounterfeitMatch(counterfeitMatches, "sneakers"));

  return results;
}

// ── HANDBAG RULES ─────────────────────────────────────────────────────────────

function evaluateHandbagRules({ extractedAttributes, authResult, counterfeitMatches, scannedPrice, rawText }) {
  const attrs = extractedAttributes || {};
  const brand = (attrs.brand || "").toLowerCase();
  const results = [];

  // HBAG_001 — Brand confirmed
  {
    const hasBrand = !!attrs.brand;
    results.push({
      ruleId: "HBAG_001", category: "handbags",
      description: "Brand confirmed from item",
      passed: hasBrand ? true : null, weight: W.CRITICAL,
      signal: hasBrand ? "positive" : "unknown",
      detail: hasBrand ? `Brand confirmed: ${attrs.brand}.` : "Brand could not be confirmed.",
      blocking: false,
      actionRequired: hasBrand ? null : "Provide clear image of the brand stamp, heat stamp, or interior label.",
    });
  }

  // HBAG_002 — Date code format valid (LV, Chanel, Gucci)
  {
    const dc = attrs.dateCode;
    if (brand.includes("louis vuitton") || brand.includes("lv")) {
      if (!dc) {
        results.push({
          ruleId: "HBAG_002", category: "handbags",
          description: "Date code present and valid format",
          passed: null, weight: W.HIGH,
          signal: "unknown",
          detail: "No date code found. Louis Vuitton items should have a date code stamped in the interior.",
          blocking: false,
          actionRequired: "Ask seller for a clear photo of the interior date code stamp.",
        });
      } else if (LV_DATE_CODE.test(dc)) {
        results.push({
          ruleId: "HBAG_002", category: "handbags",
          description: "Date code present and valid format",
          passed: true, weight: W.HIGH,
          signal: "positive",
          detail: `LV date code "${dc}" present and matches expected format (2 letters + 4 digits).`,
          blocking: false,
          actionRequired: null,
        });
      } else {
        results.push({
          ruleId: "HBAG_002", category: "handbags",
          description: "Date code present and valid format",
          passed: false, weight: W.HIGH,
          signal: "negative",
          detail: `Date code "${dc}" does not match LV format (should be 2 letters + 4 digits, e.g. "AR4121").`,
          blocking: true,
          actionRequired: "This is a strong counterfeit indicator. Seek expert authentication.",
        });
      }
    } else if (brand.includes("chanel")) {
      const hasSN = !!attrs.serialNumber;
      results.push({
        ruleId: "HBAG_002", category: "handbags",
        description: "Authentication serial sticker present",
        passed: hasSN ? true : null, weight: W.HIGH,
        signal: hasSN ? "positive" : "unknown",
        detail: hasSN
          ? `Chanel serial number ${attrs.serialNumber} present.`
          : "Chanel bags should have an authentication serial sticker inside. Not confirmed.",
        blocking: false,
        actionRequired: hasSN ? null : "Ask seller for photo of the interior authentication sticker.",
      });
    } else if (attrs.dateCode) {
      results.push({
        ruleId: "HBAG_002", category: "handbags",
        description: "Date/authenticity code present",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: `Authenticity identifier "${attrs.dateCode}" present.`,
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // HBAG_003 — Serial number present (brands requiring it)
  {
    const brandsRequiringSerial = ["chanel", "gucci", "prada", "hermès", "hermes"];
    const requiresSerial = brandsRequiringSerial.some(b => brand.includes(b));
    if (requiresSerial) {
      const hasSN = !!attrs.serialNumber;
      results.push({
        ruleId: "HBAG_003", category: "handbags",
        description: "Serial number present for brand requiring it",
        passed: hasSN ? true : null, weight: W.MEDIUM,
        signal: hasSN ? "positive" : "unknown",
        detail: hasSN
          ? `Serial number present: ${attrs.serialNumber}.`
          : `${attrs.brand || "This brand"} should have a serial number — not confirmed in listing.`,
        blocking: false,
        actionRequired: hasSN ? null : "Ask seller for photo of the authentication card or interior serial stamp.",
      });
    }
  }

  // HBAG_004 — Hardware quality described as authentic
  {
    const hwIssue = textContains(rawText, "plastic hardware", "light hardware", "hardware fell off", "chipped hardware", "peeling hardware");
    if (hwIssue) {
      results.push({
        ruleId: "HBAG_004", category: "handbags",
        description: "Hardware quality consistent with genuine",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: "Hardware quality concern detected. Genuine luxury hardware is solid brass/gold-tone — plastic or chipping is a counterfeit indicator.",
        blocking: false,
        actionRequired: "Request close-up photos of all hardware including zippers and clasps.",
      });
    } else if (attrs.hardwareColor) {
      results.push({
        ruleId: "HBAG_004", category: "handbags",
        description: "Hardware quality consistent with genuine",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: `Hardware color specified as "${attrs.hardwareColor}". No quality concerns detected.`,
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // HBAG_005 — Accessories presence adds credibility
  {
    const accs = Array.isArray(attrs.accessories) ? attrs.accessories : [];
    const hasDustbag   = accs.includes("dustbag");
    const hasAuthCard  = accs.includes("auth_card") || accs.includes("authenticity_card");
    const hasReceipt   = accs.includes("receipt");
    const hasBox       = accs.includes("box");
    const credentialCount = [hasDustbag, hasAuthCard, hasReceipt, hasBox].filter(Boolean).length;

    if (credentialCount >= 2) {
      results.push({
        ruleId: "HBAG_005", category: "handbags",
        description: "Original accessories present",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: `Original accessories: ${accs.join(", ")}. Multiple provenance items increase credibility.`,
        blocking: false,
        actionRequired: null,
      });
    } else if (credentialCount === 1) {
      results.push({
        ruleId: "HBAG_005", category: "handbags",
        description: "Original accessories present",
        passed: true, weight: W.LOW,
        signal: "positive",
        detail: `One accessory noted: ${accs.join(", ")}.`,
        blocking: false,
        actionRequired: null,
      });
    } else {
      results.push({
        ruleId: "HBAG_005", category: "handbags",
        description: "Original accessories present",
        passed: null, weight: W.LOW,
        signal: "unknown",
        detail: "No accessories (dustbag, auth card, receipt) mentioned.",
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // HBAG_006 — No pattern/alignment red flags
  {
    const alignIssue = textContains(rawText,
      "monogram cut off", "pattern misaligned", "logo off-center", "pattern doesn't align",
      "stitching uneven", "uneven stitching", "loose threads", "stitch count");
    if (alignIssue) {
      results.push({
        ruleId: "HBAG_006", category: "handbags",
        description: "No pattern or alignment red flags",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: "Pattern alignment or stitching concern detected. Authentic luxury bags have precise pattern alignment and even stitching.",
        blocking: true,
        actionRequired: "Request full exterior photos including seams and pattern alignment near handles.",
      });
    } else {
      results.push({
        ruleId: "HBAG_006", category: "handbags",
        description: "No pattern or alignment red flags",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: "No pattern alignment or stitching concerns detected.",
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // HBAG_007 — Price above brand floor
  {
    const floor = authResult?.brandAuth?.priceFloor ?? null;
    if (scannedPrice != null && floor != null) {
      const passed = scannedPrice >= floor;
      results.push({
        ruleId: "HBAG_007", category: "handbags",
        description: "Price above brand floor",
        passed, weight: passed ? W.LOW : W.CRITICAL,
        signal: passed ? "positive" : "negative",
        detail: passed
          ? `Price $${scannedPrice} is above the $${floor} floor for ${attrs.brand || "this brand"}.`
          : `Price $${scannedPrice} is below the $${floor} floor for genuine ${attrs.brand || "this brand"}. Authentic examples never sell this low.`,
        blocking: !passed,
        actionRequired: passed ? null : "Price is inconsistent with genuine product. Assume counterfeit until proven otherwise.",
      });
    }
  }

  // HBAG_008 — Counterfeit pattern
  results.push(ruleCounterfeitMatch(counterfeitMatches, "handbags"));

  return results;
}

// ── WATCH RULES ───────────────────────────────────────────────────────────────

function evaluateWatchRules({ extractedAttributes, authResult, counterfeitMatches, scannedPrice, rawText }) {
  const attrs = extractedAttributes || {};
  const brand = (attrs.brand || "").toLowerCase();
  const results = [];

  // WTCH_001 — Reference number present
  {
    const ref = attrs.reference;
    if (!ref) {
      results.push({
        ruleId: "WTCH_001", category: "watches",
        description: "Reference number present",
        passed: null, weight: W.HIGH,
        signal: "unknown",
        detail: "Reference number not found. This is required to verify the watch is a genuine, produced model.",
        blocking: false,
        actionRequired: "Ask seller to provide the reference number from the case back or documentation.",
      });
    } else if (WATCH_REF.test(ref)) {
      results.push({
        ruleId: "WTCH_001", category: "watches",
        description: "Reference number present",
        passed: true, weight: W.HIGH,
        signal: "positive",
        detail: `Reference number ${ref} present and valid format.`,
        blocking: false,
        actionRequired: null,
      });
    } else {
      results.push({
        ruleId: "WTCH_001", category: "watches",
        description: "Reference number present",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: `Reference number "${ref}" has unusual format.`,
        blocking: false,
        actionRequired: "Verify this reference against the manufacturer's official catalog.",
      });
    }
  }

  // WTCH_002 — Movement type specified and consistent
  {
    const mv = (attrs.movement || "").toLowerCase();
    if (!mv) {
      results.push({
        ruleId: "WTCH_002", category: "watches",
        description: "Movement type specified and consistent",
        passed: null, weight: W.HIGH,
        signal: "unknown",
        detail: "Movement type not confirmed. Mechanical vs quartz matters enormously for authentication.",
        blocking: false,
        actionRequired: "Ask seller if the watch is automatic, manual-wind, or quartz.",
      });
    } else {
      // Check brand/movement consistency
      let passed = true;
      let detail = `Movement specified as "${attrs.movement}".`;
      // Rolex does not make quartz dress watches (Oysterquartz discontinued 2001)
      if (brand.includes("rolex") && mv === "quartz") {
        passed = false;
        detail = "Rolex Submariner, Datejust, and modern Rolex models are never quartz. A quartz Rolex is almost certainly a fake.";
      }
      results.push({
        ruleId: "WTCH_002", category: "watches",
        description: "Movement type specified and consistent",
        passed, weight: passed ? W.MEDIUM : W.CRITICAL,
        signal: passed ? "positive" : "negative",
        detail,
        blocking: !passed,
        actionRequired: passed ? null : "Do not purchase this watch without in-person verification by a watchmaker.",
      });
    }
  }

  // WTCH_003 — Caseback correct for brand
  {
    const caseback = (attrs.caseback || "").toLowerCase();
    if (brand.includes("rolex")) {
      const isExhibition = caseback.includes("transparent") || caseback.includes("exhibition") || caseback.includes("open");
      if (isExhibition) {
        results.push({
          ruleId: "WTCH_003", category: "watches",
          description: "Caseback correct for brand",
          passed: false, weight: W.CRITICAL,
          signal: "negative",
          detail: "Exhibition/transparent caseback on a Rolex is a definitive counterfeit marker. Rolex does not produce exhibition casebacks on any current model.",
          blocking: true,
          actionRequired: "Do not purchase. This is a confirmed counterfeit indicator.",
        });
      } else if (caseback === "solid" || caseback === "screw-back" || caseback.includes("solid")) {
        results.push({
          ruleId: "WTCH_003", category: "watches",
          description: "Caseback correct for brand",
          passed: true, weight: W.HIGH,
          signal: "positive",
          detail: "Solid/screw-back caseback is correct for Rolex.",
          blocking: false,
          actionRequired: null,
        });
      } else if (!caseback) {
        results.push({
          ruleId: "WTCH_003", category: "watches",
          description: "Caseback correct for brand",
          passed: null, weight: W.HIGH,
          signal: "unknown",
          detail: "Caseback type not confirmed. For Rolex, solid caseback is required.",
          blocking: false,
          actionRequired: "Ask seller to describe the caseback. Rolex should have a solid, screw-down caseback.",
        });
      }
    } else if (caseback) {
      results.push({
        ruleId: "WTCH_003", category: "watches",
        description: "Caseback type noted",
        passed: true, weight: W.LOW,
        signal: "positive",
        detail: `Caseback described as "${attrs.caseback}".`,
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // WTCH_004 — Seconds sweep consistent with movement
  {
    const mv = (attrs.movement || "").toLowerCase();
    const ticking = textContains(rawText, "ticking seconds", "tick", "stepped seconds", "quartz movement");
    if (mv === "automatic" && ticking) {
      results.push({
        ruleId: "WTCH_004", category: "watches",
        description: "Seconds hand behavior consistent with movement",
        passed: false, weight: W.CRITICAL,
        signal: "negative",
        detail: "Automatic movement claimed but ticking/stepped seconds detected. Automatic movements should have a smooth, continuous sweep.",
        blocking: true,
        actionRequired: "This is a strong counterfeit indicator. Do not purchase without expert authentication.",
      });
    } else if (mv === "automatic" || mv === "manual") {
      results.push({
        ruleId: "WTCH_004", category: "watches",
        description: "Seconds hand behavior consistent with movement",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: `Mechanical movement (${attrs.movement}). Sweeping seconds expected.`,
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // WTCH_005 — Serial number present
  {
    const hasSN = !!attrs.serialNumber;
    results.push({
      ruleId: "WTCH_005", category: "watches",
      description: "Serial number present",
      passed: hasSN ? true : null, weight: W.MEDIUM,
      signal: hasSN ? "positive" : "unknown",
      detail: hasSN ? `Serial number present: ${attrs.serialNumber}.` : "Serial number not noted. Serialization is key for provenance.",
      blocking: false,
      actionRequired: hasSN ? null : "Ask seller for a photo of the case back showing the serial number engraving.",
    });
  }

  // WTCH_006 — Box and papers status noted
  {
    const bp = attrs.boxPapers;
    if (bp) {
      const isGood = ["full_set", "papers_only"].includes(bp);
      results.push({
        ruleId: "WTCH_006", category: "watches",
        description: "Box and papers status noted",
        passed: isGood, weight: W.LOW,
        signal: isGood ? "positive" : "positive", // even no-box is informative
        detail: `Box and papers: ${bp.replace(/_/g, " ")}.`,
        blocking: false,
        actionRequired: null,
      });
    } else {
      results.push({
        ruleId: "WTCH_006", category: "watches",
        description: "Box and papers status noted",
        passed: null, weight: W.LOW,
        signal: "unknown",
        detail: "Box and papers status not confirmed.",
        blocking: false,
        actionRequired: "Ask seller about original box and papers.",
      });
    }
  }

  // WTCH_007 — Price above brand floor
  {
    const floor = authResult?.brandAuth?.priceFloor ?? null;
    if (scannedPrice != null && floor != null) {
      const passed = scannedPrice >= floor;
      results.push({
        ruleId: "WTCH_007", category: "watches",
        description: "Price above brand floor",
        passed, weight: passed ? W.LOW : W.CRITICAL,
        signal: passed ? "positive" : "negative",
        detail: passed
          ? `Price $${scannedPrice} is above the $${floor} floor for ${attrs.brand || "this brand"}.`
          : `Price $${scannedPrice} is below the $${floor} minimum for genuine ${attrs.brand || "this brand"}.`,
        blocking: !passed,
        actionRequired: passed ? null : "Price is far below market. This is almost always a counterfeit indicator.",
      });
    }
  }

  // WTCH_008 — No dial or bezel inconsistencies
  {
    const dialIssue = textContains(rawText,
      "dial faded", "lume worn", "markers misaligned", "bezel scratched off",
      "bezel insert crack", "dial marker off", "incorrect font");
    if (dialIssue) {
      results.push({
        ruleId: "WTCH_008", category: "watches",
        description: "No dial or bezel inconsistencies",
        passed: false, weight: W.HIGH,
        signal: "negative",
        detail: "Dial or bezel concern detected. Authentic luxury watches have precise dial text and properly aligned markers.",
        blocking: false,
        actionRequired: "Request high-resolution photos of the dial under good lighting.",
      });
    } else {
      results.push({
        ruleId: "WTCH_008", category: "watches",
        description: "No dial or bezel inconsistencies",
        passed: true, weight: W.MEDIUM,
        signal: "positive",
        detail: "No dial or bezel inconsistencies detected.",
        blocking: false,
        actionRequired: null,
      });
    }
  }

  // WTCH_009 — Counterfeit pattern
  results.push(ruleCounterfeitMatch(counterfeitMatches, "watches"));

  return results;
}

// ── Generic fallback rules (non-deep categories) ──────────────────────────────

function evaluateGenericRules({ extractedAttributes, counterfeitMatches, scannedPrice }) {
  const attrs = extractedAttributes || {};
  const results = [];

  results.push({
    ruleId: "GEN_001", category: "generic",
    description: "Brand identified",
    passed: attrs.brand ? true : null, weight: W.MEDIUM,
    signal: attrs.brand ? "positive" : "unknown",
    detail: attrs.brand ? `Brand identified: ${attrs.brand}.` : "Brand not confirmed.",
    blocking: false,
    actionRequired: attrs.brand ? null : "Confirm brand with seller.",
  });

  results.push(ruleCounterfeitMatch(counterfeitMatches, "generic"));

  return results;
}

// ── Score computation ─────────────────────────────────────────────────────────

/**
 * Compute an auth score from rule results.
 * authScore = positiveWeight / (positiveWeight + negativeWeight)
 * Ranges 0-1. Higher = more positive signals.
 */
function computeAuthScore(ruleResults) {
  let posW = 0;
  let negW = 0;
  for (const r of ruleResults) {
    if (r.passed === true)  posW += r.weight;
    if (r.passed === false) negW += r.weight;
    // null (unknown) rules don't contribute to the score
  }
  const total = posW + negW;
  if (total === 0) return 0.50;
  return Math.round((posW / total) * 1000) / 1000;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run category-specific authentication rules.
 *
 * @param {object} opts
 *   category            {string}
 *   extractedAttributes {object}  — from categoryAttributeExtractor
 *   authResult          {object}  — from categoryAuthEngine
 *   counterfeitMatches  {Array}
 *   scannedPrice        {number|null}
 *   rawText             {string}
 * @returns {AuthRulesResult}
 */
export function runCategoryAuthRules({
  category          = "",
  extractedAttributes = {},
  authResult        = null,
  counterfeitMatches = [],
  scannedPrice      = null,
  rawText           = "",
} = {}) {
  let ruleResults;

  try {
    const args = { extractedAttributes, authResult, counterfeitMatches, scannedPrice, rawText };
    switch (category) {
      case "sneakers": ruleResults = evaluateSneakerRules(args); break;
      case "handbags": ruleResults = evaluateHandbagRules(args); break;
      case "watches":  ruleResults = evaluateWatchRules(args);  break;
      default:         ruleResults = evaluateGenericRules(args);
    }
  } catch (err) {
    console.error("[categoryAuthRules] rule evaluation error:", err?.message);
    ruleResults = [];
  }

  const passCount    = ruleResults.filter(r => r.passed === true).length;
  const failCount    = ruleResults.filter(r => r.passed === false).length;
  const unknownCount = ruleResults.filter(r => r.passed === null).length;
  const authScore    = computeAuthScore(ruleResults);
  const blockingFails = ruleResults.filter(r => r.passed === false && r.blocking);

  return {
    category,
    ruleResults,
    passCount,
    failCount,
    unknownCount,
    authScore,
    hasBlockingFail: blockingFails.length > 0,
    blockingFails,
    evaluatedAt: Date.now(),
  };
}
