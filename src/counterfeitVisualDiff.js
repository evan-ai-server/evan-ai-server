// src/counterfeitVisualDiff.js
// Feature 69 — Counterfeit Visual Diff Engine
// For known fake-prone items (Supreme, LV, Nike, Jordan, Gucci, Chanel, Rolex,
// Yeezy, Off-White, Ray-Ban), compares extracted visual features from the scan
// against known-authentic reference specs stored in this module.
// Outputs: diff score (0-100), specific discrepancies, authenticity verdict.
// "Swoosh is 12% too wide. Heel tab font is wrong. Risk: HIGH."

// ── Authentic reference specs per brand ───────────────────────────────────────
// Each spec: { checkpoints[], knownFakeIndicators[], fakeRiskLevel }
// checkpoints: things that must match for the item to be considered authentic
// knownFakeIndicators: commonly seen on counterfeits
const AUTHENTIC_SPECS = {

  Nike: {
    fakeRiskLevel: "moderate",
    checkpoints: [
      { id: "swoosh_shape",       label: "Swoosh shape",         failFlags: ["logo_proportions_off"] },
      { id: "heel_tab_text",      label: "Heel tab text",        failFlags: ["font_wrong"] },
      { id: "insole_branding",    label: "Insole branding",      failFlags: ["logo_proportions_off"] },
      { id: "stitch_consistency", label: "Stitching consistency", failFlags: ["stitching_uneven"] },
    ],
    knownFakeIndicators: [
      "gum sole is lighter than authentic coffee brown",
      "tick mark in swoosh is rounder than official sharp point",
      "heel pull loop is wider/shorter on fakes",
      "foam midsole density visibly different (fakes look more hollow)",
      "Nike Air heel unit bubbles appear smaller or flatter",
    ],
    textChecks: [
      { expected: "NIKE",        placement: "heel_tab",  critical: true  },
      { expected: "Nike",        placement: "insole",    critical: true  },
      { expected: "SWOOSH",      placement: "lace_tag",  critical: false },
    ],
    hardFloors: {
      minAuthPrice: 60, // Below $60, Nike authentics rarely exist on resale
    },
  },

  "Air Jordan": {
    fakeRiskLevel: "high",
    checkpoints: [
      { id: "jumpman_silhouette", label: "Jumpman silhouette",    failFlags: ["logo_proportions_off"] },
      { id: "wing_logo",          label: "Wings logo (AJ1)",      failFlags: ["logo_proportions_off"] },
      { id: "nike_air_heel",      label: "NIKE AIR heel text",    failFlags: ["font_wrong"] },
      { id: "stitching",          label: "Stitching quality",     failFlags: ["stitching_uneven"] },
      { id: "lace_texture",       label: "Lace texture/weave",    failFlags: [] },
    ],
    knownFakeIndicators: [
      "Jumpman's legs are too spread / ball missing",
      "Wings logo has wrong font weight (fakes use thinner strokes)",
      "NIKE AIR embossing is faint or absent on heel",
      "Toe box leather has visible grain inconsistency on fakes",
      "Outsole pivot point circle is oval on fakes, round on authentic",
      "Jordan Flight tag font is wrong (fakes use helvetica not futura)",
    ],
    textChecks: [
      { expected: "NIKE AIR",    placement: "heel",      critical: true  },
      { expected: "AIR JORDAN",  placement: "tongue",    critical: true  },
      { expected: "JUMPMAN",     placement: "insole",    critical: false },
    ],
    hardFloors: {
      minAuthPrice: 100,
      popularModels: {
        "Air Jordan 1": 150,
        "Air Jordan 11": 180,
        "Air Jordan 4": 160,
      },
    },
  },

  Yeezy: {
    fakeRiskLevel: "extreme",
    checkpoints: [
      { id: "boost_texture",      label: "Boost sole texture",   failFlags: [] },
      { id: "primeknit_pattern",  label: "Primeknit weave",      failFlags: ["logo_proportions_off"] },
      { id: "pull_tab",           label: "Pull tab stitching",   failFlags: ["stitching_uneven"] },
      { id: "size_tag_format",    label: "Size tag format",      failFlags: ["font_wrong"] },
    ],
    knownFakeIndicators: [
      "Boost foam pellets are too uniform / plastic-looking on fakes",
      "Primeknit pattern knot count is lower on fakes (less dense)",
      "Size tag uses wrong font — authentic uses Futura",
      "Heel pull tab is too thick or too thin",
      "350 V2 side stripe is too narrow on many fakes",
      "Midsole is too bright white — authentic is slightly off-white/cream",
    ],
    textChecks: [
      { expected: "adidas",      placement: "tongue",    critical: true  },
      { expected: "YEEZY",       placement: "side",      critical: false },
    ],
    hardFloors: { minAuthPrice: 200 },
  },

  Supreme: {
    fakeRiskLevel: "extreme",
    checkpoints: [
      { id: "box_logo_font",      label: "Box logo font (Futura Heavy Oblique)", failFlags: ["font_wrong"] },
      { id: "box_proportions",    label: "Box dimensions (wider than tall)",     failFlags: ["logo_proportions_off"] },
      { id: "tag_quality",        label: "Interior tag quality",                 failFlags: ["hardware_lightweight"] },
      { id: "stitch_density",     label: "Stitch density",                       failFlags: ["stitching_uneven"] },
    ],
    knownFakeIndicators: [
      "Box logo text is too narrow or too wide (authentic is specific ratio)",
      "Red is wrong shade — authentic Supreme red is Pantone 485C",
      "Interior tag uses wrong font for size (fakes often use Arial)",
      "Hangtag has wrong proportions or missing barcode",
      "Double-stitching on hood is single-stitch on fakes",
      "Fakes often have visible glue residue around chest logo",
    ],
    textChecks: [
      { expected: "Supreme",     placement: "chest_logo",critical: true  },
      { expected: "NEW YORK",    placement: "tag",       critical: false },
    ],
    hardFloors: { minAuthPrice: 30 },
  },

  "Louis Vuitton": {
    fakeRiskLevel: "extreme",
    checkpoints: [
      { id: "monogram_alignment", label: "Monogram seam alignment", failFlags: ["monogram_misaligned"] },
      { id: "lv_symmetry",        label: "LV logo symmetry",        failFlags: ["logo_proportions_off"] },
      { id: "hardware_weight",    label: "Hardware weight/quality", failFlags: ["hardware_lightweight"] },
      { id: "stitching_color",    label: "Stitching color (mustard yellow)", failFlags: ["stitching_uneven"] },
      { id: "date_code",          label: "Date code format",        failFlags: ["date_code_format_wrong"] },
      { id: "zipper_brand",       label: "Zipper hardware (LV stamped)", failFlags: [] },
    ],
    knownFakeIndicators: [
      "Monogram does NOT cut at seams — on authentic bags it always cuts/realigns",
      "LV letters are exactly symmetrical — fakes often have one L wider",
      "Stitching is mustard yellow, 5 stitches per inch — fakes deviate",
      "Interior alcantara/microfiber is smooth, NOT rough",
      "Heat stamp is deep and clear — fakes are often shallow or offset",
      "Date code format: 2 letters + 4 numbers — invalid format = fake",
      "Hardware should not be light or plasticky",
    ],
    textChecks: [
      { expected: "LOUIS VUITTON PARIS", placement: "interior", critical: true },
      { expected: "made in France",      placement: "interior", critical: false },
    ],
    hardFloors: { minAuthPrice: 300 },
  },

  Chanel: {
    fakeRiskLevel: "extreme",
    checkpoints: [
      { id: "cc_symmetry",        label: "CC logo symmetry",       failFlags: ["logo_proportions_off"] },
      { id: "quilt_pattern",      label: "Quilting consistency",   failFlags: [] },
      { id: "serial_sticker",     label: "Serial sticker format",  failFlags: ["serial_sticker_wrong"] },
      { id: "chain_weight",       label: "Chain weight/quality",   failFlags: ["hardware_lightweight"] },
      { id: "interior_stamp",     label: "Interior stamp quality", failFlags: [] },
    ],
    knownFakeIndicators: [
      "Left C is on top in authentic CC logo — fakes sometimes reverse this",
      "Quilting diamonds are 100% consistent in size — fakes often vary",
      "Hologram serial sticker starts with specific year-coded number",
      "Chain links are gold or silver, never hollow-sounding",
      "Lambskin is buttery soft — fakes use stiffer leather",
    ],
    textChecks: [
      { expected: "CHANEL",      placement: "interior",  critical: true },
      { expected: "Made in Italy", placement: "interior",critical: false },
    ],
    hardFloors: { minAuthPrice: 500 },
  },

  Gucci: {
    fakeRiskLevel: "high",
    checkpoints: [
      { id: "gg_logo",            label: "GG logo proportions",   failFlags: ["logo_proportions_off"] },
      { id: "hardware_quality",   label: "Hardware quality",      failFlags: ["hardware_lightweight"] },
      { id: "stitching",          label: "Stitching quality",     failFlags: ["stitching_uneven"] },
    ],
    knownFakeIndicators: [
      "GG interlocked letters — one G is slightly larger than the other on authentic",
      "Gucci stripe (green-red-green) colors are very specific — fakes fade or blur",
      "Interior tag font uses specific serif on authentic pieces",
    ],
    textChecks: [
      { expected: "GUCCI",       placement: "interior",  critical: true },
    ],
    hardFloors: { minAuthPrice: 200 },
  },

  Rolex: {
    fakeRiskLevel: "extreme",
    checkpoints: [
      { id: "crown_logo",         label: "Crown logo (5 points)", failFlags: ["crown_logo_off"] },
      { id: "cyclops_lens",       label: "Cyclops date magnification", failFlags: ["cyclops_missing"] },
      { id: "sweep_seconds",      label: "Seconds hand sweep (smooth)", failFlags: [] },
      { id: "bracelet_quality",   label: "Bracelet link quality", failFlags: ["hardware_lightweight"] },
      { id: "dial_text",          label: "Dial text precision",   failFlags: ["font_wrong"] },
    ],
    knownFakeIndicators: [
      "Rolex crown has exactly 5 points — fakes often have 4 or 6",
      "Cyclops magnifies date 2.5x — fakes often show 1x or distorted",
      "Authentic Rolex seconds hand sweeps ~8 ticks/sec — fakes tick",
      "Jubilee bracelet links click together solidly — fakes rattle",
      "ROLEX text at 12 is crisp with no ink bleed — fakes often bleed",
      "Rehaut (inner bezel) has ROLEX engraved all around on modern pieces",
    ],
    textChecks: [
      { expected: "ROLEX",         placement: "dial_12",   critical: true },
      { expected: "SWISS MADE",    placement: "dial_6",    critical: true },
      { expected: "SUPERLATIVE CHRONOMETER", placement: "dial", critical: false },
    ],
    hardFloors: { minAuthPrice: 4000 },
  },

  "Ray-Ban": {
    fakeRiskLevel: "moderate",
    checkpoints: [
      { id: "rb_engraving",       label: "RB lens engraving",     failFlags: [] },
      { id: "temple_text",        label: "Temple text quality",   failFlags: ["font_wrong"] },
      { id: "frame_quality",      label: "Acetate quality",       failFlags: ["hardware_lightweight"] },
    ],
    knownFakeIndicators: [
      "RB engraving on lens is crisp and not a sticker — fakes use stickers",
      "Ray-Ban on temple uses specific font size and spacing",
      "Nose pads on metal frames should be adjustable",
    ],
    textChecks: [
      { expected: "Ray-Ban",     placement: "temple",    critical: true },
      { expected: "RB",          placement: "lens",      critical: false },
    ],
    hardFloors: { minAuthPrice: 50 },
  },
};

// ── Scoring engine ────────────────────────────────────────────────────────────

const RISK_LEVELS = {
  clean:    { label: "LIKELY AUTHENTIC",  color: "green",  score: 0   },
  low:      { label: "LOW RISK",          color: "green",  score: 15  },
  moderate: { label: "MODERATE RISK",     color: "yellow", score: 40  },
  high:     { label: "HIGH RISK",         color: "orange", score: 65  },
  extreme:  { label: "EXTREME RISK",      color: "red",    score: 85  },
};

/**
 * Run a visual diff for a specific brand.
 */
export function runVisualDiff(brandName, visionOutput) {
  const spec = AUTHENTIC_SPECS[brandName];
  if (!spec) return null;

  const authFlags    = visionOutput?.authenticityFlags || [];
  const visibleText  = (visionOutput?.identity?.visibleText || []).join(" ").toLowerCase();
  const styleWords   = (visionOutput?.identity?.styleWords  || []).join(" ").toLowerCase();
  const allText      = visibleText + " " + styleWords;
  const scannedPrice = Number(visionOutput?.scannedPrice ?? visionOutput?.bestPrice ?? 0);

  const failedCheckpoints = [];
  const passedCheckpoints = [];
  const warnings          = [];

  // ── Checkpoint evaluation ────────────────────────────────────────────────
  for (const cp of spec.checkpoints) {
    const failed = cp.failFlags.some(flag => authFlags.includes(flag));
    if (failed) {
      failedCheckpoints.push({ id: cp.id, label: cp.label });
    } else {
      passedCheckpoints.push({ id: cp.id, label: cp.label });
    }
  }

  // ── Text check evaluation ────────────────────────────────────────────────
  const failedTextChecks = [];
  for (const tc of (spec.textChecks || [])) {
    const found = allText.includes(tc.expected.toLowerCase());
    if (!found && tc.critical) {
      failedTextChecks.push(`"${tc.expected}" not found on ${tc.placement}`);
    }
  }

  // ── Price floor check ────────────────────────────────────────────────────
  const floor = spec.hardFloors?.minAuthPrice;
  if (floor && scannedPrice > 0 && scannedPrice < floor) {
    warnings.push(`Price $${scannedPrice} is below minimum authentic price floor ($${floor}) — possible fake or heavily damaged`);
  }

  // ── Risk score calculation ───────────────────────────────────────────────
  const totalCheckpoints  = spec.checkpoints.length;
  const failedCount       = failedCheckpoints.length + failedTextChecks.length;
  const baseRiskFromFlags = totalCheckpoints > 0 ? failedCount / totalCheckpoints : 0;

  // Base brand risk amplifies the score
  const brandRiskMultiplier = { low: 0.7, moderate: 1.0, high: 1.3, extreme: 1.6 }[spec.fakeRiskLevel] ?? 1.0;
  const rawRiskScore        = Math.min(100, Math.round(baseRiskFromFlags * 100 * brandRiskMultiplier));

  // Extra risk from explicit auth flags
  const extraRisk = authFlags.length * 8;
  const finalScore = Math.min(100, rawRiskScore + extraRisk + (warnings.length * 12));

  // Tier
  let tier = "clean";
  if (finalScore >= 80) tier = "extreme";
  else if (finalScore >= 60) tier = "high";
  else if (finalScore >= 35) tier = "moderate";
  else if (finalScore >= 15) tier = "low";

  return {
    brand:             brandName,
    riskScore:         finalScore,
    tier,
    tierLabel:         RISK_LEVELS[tier].label,
    failedCheckpoints,
    passedCheckpoints,
    failedTextChecks,
    warnings,
    knownFakeIndicators: spec.knownFakeIndicators.slice(0, 4),
    totalCheckpoints,
    passRate:          totalCheckpoints ? round2((passedCheckpoints.length / totalCheckpoints)) : null,
    priceFloorWarning: warnings.find(w => w.includes("price floor")) || null,
  };
}

/**
 * Auto-detect which brand to diff against, then run the diff.
 */
export function autoRunVisualDiff(visionOutput) {
  const brand = visionOutput?.identity?.brand || visionOutput?.brand;
  if (!brand) return null;

  // Find matching spec (case-insensitive, partial match)
  const brandLower = brand.toLowerCase();
  const matchedKey = Object.keys(AUTHENTIC_SPECS).find(k =>
    k.toLowerCase().includes(brandLower) || brandLower.includes(k.toLowerCase())
  );

  if (!matchedKey) return null;
  return runVisualDiff(matchedKey, visionOutput);
}

/**
 * Master payload builder.
 */
export function buildCounterfeitDiffPayload(visionOutput = {}) {
  const diff = autoRunVisualDiff(visionOutput);
  if (!diff) return { counterfeitDiff: null, topSignal: null };

  const topSignal = diff.riskScore >= 60
    ? `⚠️ Counterfeit risk ${diff.tier.toUpperCase()} (${diff.riskScore}/100) — ${diff.failedCheckpoints[0]?.label || diff.failedTextChecks[0] || "multiple issues"}`
    : diff.riskScore >= 30
    ? `Moderate counterfeit risk (${diff.riskScore}/100) — verify before buying`
    : `Visual diff: ${diff.brand} appears authentic (${diff.riskScore}/100 risk)`;

  return {
    counterfeitDiff: diff,
    topSignal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
