  // src/conditionGrader.js
  // Structured condition grading engine
  // Input: vision identity + visible damage cues + category
  // Output: 0–100 composite score, letter grade, resale loss %, sell-through drag

  // ── Category damage profiles ─────────────────────────────────────────────────
  // Each profile: { dimensionName: weight (must sum to 1.0) }

  const CATEGORY_PROFILES = {
    sneakers: {
      soleWear:    0.30,
      upperWear:   0.25,
      creasing:    0.20,
      yellowing:   0.10,
      hardware:    0.08,
      insole:      0.07,
    },
    apparel: {
      fabricCondition: 0.35,
      stains:          0.30,
      structuralDamage:0.20,
      hardware:        0.10,
      labelCondition:  0.05,
    },
    eyewear: {
      lensCondition:  0.40,
      frameCondition: 0.35,
      hinges:         0.15,
      nosePads:       0.10,
    },
    electronics: {
      screenCondition: 0.30,
      bodyWear:        0.25,
      ports:           0.15,
      batteryHealth:   0.15,
      cosmeticDamage:  0.15,
    },
    collectibles: {
      completeness:   0.35,
      packaging:      0.25,
      surfaceCondition:0.25,
      functionality:  0.15,
    },
    watches: {
      crystalCondition: 0.30,
      caseWear:         0.25,
      braceletCondition:0.25,
      functionality:    0.20,
    },
    bags: {
      exteriorCondition: 0.30,
      hardwareCondition: 0.25,
      interiorCondition: 0.25,
      strapCondition:    0.20,
    },
    default: {
      surfaceWear:    0.35,
      functionality:  0.30,
      cosmeticDamage: 0.25,
      completeness:   0.10,
    },
  };

  // ── Condition text → base score ───────────────────────────────────────────────

  const CONDITION_TEXT_SCORES = [
    { patterns: /\b(mint|brand\s*new|deadstock|ds|new\s*with\s*tags|nwt|new\s*in\s*box|nib|vnds)\b/i, score: 96 },
    { patterns: /\b(like\s*new|lnwot|lightly?\s*used|great\s*cond|excellent)\b/i,                       score: 88 },
    { patterns: /\b(very\s*good|good\s*cond|gently?\s*used)\b/i,                                         score: 78 },
    { patterns: /\b(^good$|used|normal\s*wear|acceptable|average|moderate)\b/i,                          score: 65 },
    { patterns: /\b(fair|worn|heavy\s*use|well\s*worn|visible\s*wear|noticeable)\b/i,                    score: 48 },
    { patterns: /\b(poor|damaged|defective|broken|cracked|missing|parts\s*only|for\s*parts)\b/i,         score: 20 },
  ];

  function conditionTextToScore(conditionText = "") {
    const text = String(conditionText || "").toLowerCase().trim();
    if (!text) return null;
    for (const { patterns, score } of CONDITION_TEXT_SCORES) {
      if (patterns.test(text)) return score;
    }
    return null;
  }

  // ── Visual damage penalties from text cues ────────────────────────────────────

  const DAMAGE_PENALTIES = [
    { patterns: /\b(crack(ed|s)?|broken)\b/i,              penalty: 22, flag: "cracked" },
    { patterns: /\b(tear(s)?|torn|rip(ped)?|hole(s)?)\b/i, penalty: 20, flag: "structural_damage" },
    { patterns: /\b(rust(ed)?|corrod(ed)?)\b/i,             penalty: 18, flag: "rust_corrosion" },
    { patterns: /\b(stain(s|ed)?|discolored)\b/i,           penalty: 15, flag: "staining" },
    { patterns: /\b(missing)\b/i,                           penalty: 15, flag: "missing_parts" },
    { patterns: /\b(bent|dent(ed)?|warp(ed)?)\b/i,          penalty: 12, flag: "structural_deformation" },
    { patterns: /\b(scratch(ed|es)?)\b/i,                   penalty: 10, flag: "scratching" },
    { patterns: /\b(dirty|filthy|grim(y)?)\b/i,             penalty: 10, flag: "dirty" },
    { patterns: /\b(yellow(ed|ing)?)\b/i,                   penalty: 8,  flag: "yellowing" },
    { patterns: /\b(fad(ed|ing))\b/i,                       penalty: 8,  flag: "fading" },
    { patterns: /\b(worn|wear|scuff(ed|s)?)\b/i,            penalty: 8,  flag: "surface_wear" },
    { patterns: /\b(pill(ing|ed)?)\b/i,                     penalty: 5,  flag: "pilling" },
    { patterns: /\b(crease(d|s)?)\b/i,                      penalty: 5,  flag: "creasing" },
    { patterns: /\b(loose|wobbly|unstable)\b/i,             penalty: 6,  flag: "structural_looseness" },
  ];

  function extractDamagePenalties(textArray = []) {
    const combined = (Array.isArray(textArray) ? textArray : []).join(" ").toLowerCase();
    if (!combined.trim()) return { totalPenalty: 0, flags: [] };

    const flags       = [];
    let totalPenalty  = 0;

    for (const { patterns, penalty, flag } of DAMAGE_PENALTIES) {
      if (patterns.test(combined)) {
        flags.push(flag);
        totalPenalty += penalty;
      }
    }

    return { totalPenalty: Math.min(totalPenalty, 60), flags };
  }

  // ── Category profile lookup ───────────────────────────────────────────────────

  function getCategoryProfile(category = "") {
    const cat = String(category || "").toLowerCase().trim();
    if (cat.includes("shoe") || cat.includes("sneaker") || cat.includes("boot") || cat.includes("footwear")) {
      return { key: "sneakers", profile: CATEGORY_PROFILES.sneakers };
    }
    if (cat.includes("cloth") || cat.includes("apparel") || cat.includes("shirt") ||
        cat.includes("jacket") || cat.includes("hoodie") || cat.includes("pant") ||
        cat.includes("dress") || cat.includes("coat")) {
      return { key: "apparel", profile: CATEGORY_PROFILES.apparel };
    }
    if (cat.includes("glass") || cat.includes("eyewear") || cat.includes("sunglass") ||
        cat.includes("frame") || cat.includes("lens")) {
      return { key: "eyewear", profile: CATEGORY_PROFILES.eyewear };
    }
    if (cat.includes("electron") || cat.includes("phone") || cat.includes("tablet") ||
        cat.includes("laptop") || cat.includes("computer") || cat.includes("camera") ||
        cat.includes("headphone") || cat.includes("speaker")) {
      return { key: "electronics", profile: CATEGORY_PROFILES.electronics };
    }
    if (cat.includes("collectible") || cat.includes("toy") || cat.includes("card") ||
        cat.includes("figure") || cat.includes("vintage")) {
      return { key: "collectibles", profile: CATEGORY_PROFILES.collectibles };
    }
    if (cat.includes("watch")) {
      return { key: "watches", profile: CATEGORY_PROFILES.watches };
    }
    if (cat.includes("bag") || cat.includes("purse") || cat.includes("backpack") ||
        cat.includes("handbag") || cat.includes("tote")) {
      return { key: "bags", profile: CATEGORY_PROFILES.bags };
    }
    return { key: "default", profile: CATEGORY_PROFILES.default };
  }

  // ── Score to letter grade ──────────────────────────────────────────────────────

  function scoreToLetterGrade(score) {
    if (score >= 95) return "S";    // Near-mint / DS
    if (score >= 88) return "A+";
    if (score >= 80) return "A";
    if (score >= 72) return "B+";
    if (score >= 64) return "B";
    if (score >= 55) return "C+";
    if (score >= 45) return "C";
    if (score >= 32) return "D";
    return "F";
  }

  // ── Resale loss % by grade ─────────────────────────────────────────────────────

  const GRADE_TO_RESALE_LOSS = {
    "S":  0,
    "A+": 3,
    "A":  8,
    "B+": 14,
    "B":  22,
    "C+": 32,
    "C":  44,
    "D":  58,
    "F":  75,
  };

  // ── Sell-through drag label ────────────────────────────────────────────────────

  function gradeToSellThroughDrag(letterGrade) {
    if (["S", "A+", "A"].includes(letterGrade)) return "fast";
    if (["B+", "B"].includes(letterGrade))       return "moderate";
    if (["C+", "C"].includes(letterGrade))       return "slow";
    return "very_slow";
  }

  // ── Condition label for display ───────────────────────────────────────────────

  function gradeToConditionLabel(letterGrade) {
    const labels = {
      "S":  "Deadstock / New",
      "A+": "Like New",
      "A":  "Excellent",
      "B+": "Very Good",
      "B":  "Good",
      "C+": "Fair — Visible Wear",
      "C":  "Worn — Significant Wear",
      "D":  "Poor — Damage Present",
      "F":  "Parts / Heavily Damaged",
    };
    return labels[letterGrade] || "Unknown";
  }

  // ── Main grader ───────────────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {object} opts.visionResult  - shaped vision result ({ identity, confidence })
   * @param {string} opts.category      - item category (override; falls back to identity.category)
   * @param {number} opts.overallConfidence - overall scan confidence (0-1)
   */
  export function gradeCondition({ visionResult = {}, category = null, overallConfidence = 0.5 }) {
    const identity = visionResult?.identity || visionResult?.visionIdentity || {};
    const rawCategory = category || identity?.category || identity?.itemType || "";
    const { key: categoryKey, profile } = getCategoryProfile(rawCategory);

    // 1. Base score from condition text
    const conditionText     = identity?.condition || "";
    const conditionCueTexts = [
      ...(Array.isArray(identity?.visibleText)  ? identity.visibleText  : []),
      ...(Array.isArray(identity?.styleWords)   ? identity.styleWords   : []),
      conditionText,
    ];
    const conditionTextScore = conditionTextToScore(conditionText) ||
                               conditionTextToScore(conditionCueTexts.join(" ")) ||
                               70; // default if no cues

    // 2. Damage penalties from all visible text
    const { totalPenalty, flags: damageFlags } = extractDamagePenalties(conditionCueTexts);

    // 3. Confidence modifier: low scan confidence means we can't grade well
    const confidenceMod = Math.max(0, (Number(overallConfidence) - 0.5) * 10); // -5 to +5

    // 4. Composite score
    const rawScore    = conditionTextScore - totalPenalty + confidenceMod;
    const composite   = Math.round(Math.max(0, Math.min(100, rawScore)));

    // 5. Letter grade + outputs
    const letterGrade      = scoreToLetterGrade(composite);
    const resaleLossPct    = GRADE_TO_RESALE_LOSS[letterGrade] ?? 30;
    const sellThroughDrag  = gradeToSellThroughDrag(letterGrade);
    const conditionLabel   = gradeToConditionLabel(letterGrade);

    const positiveSignals = [];
    if (composite >= 80) positiveSignals.push("clean_condition");
    if (!damageFlags.length) positiveSignals.push("no_visible_damage");
    if (conditionText.match(/\b(mint|new|excellent|like\s*new)\b/i)) positiveSignals.push("seller_claims_excellent");

    return {
      composite,
      letterGrade,
      resaleLossPct,
      sellThroughDrag,
      conditionLabel,
      categoryKey,
      damageFlags,
      positiveSignals,
      profile: Object.keys(profile),
      graded: true,
    };
  }

