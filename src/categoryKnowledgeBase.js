// src/categoryKnowledgeBase.js
// Category Knowledge Base — Phase 15: Category Immortality.
//
// Per-category static knowledge assets that compound into an unfair advantage:
//   1. Replica marker libraries — text/visual patterns indicating fakes
//   2. Defect surface maps     — where defects appear and how they affect value
//   3. Local-market adjustment tables — regional demand offsets
//
// All maps are keyed by canonical CAT names from categoryRegistry.js.
// This file exports pure lookup functions — no Redis, no async.

import { CAT } from "./categoryRegistry.js";

// ── 1. Replica marker libraries ───────────────────────────────────────────────
//
// Each entry is an object:
//   positiveMarkers  — text patterns that INCREASE authenticity confidence
//   negativeMarkers  — text patterns that DECREASE authenticity confidence (red flags)
//   priceFloorRatio  — if price < retail * ratio, trigger replica warning
//   visualRedFlags   — description-level cues (used in prompt injection context)

const REPLICA_MARKER_LIBRARY = {
  [CAT.SNEAKERS]: {
    positiveMarkers: [
      /\bnike\s*id\b/i,          // Nike ID custom (authenticated by customization)
      /\breceipt\b/i,
      /\bauth(enticit[y]?)?\b/i,
      /\bqr\s*code\b/i,
      /\bhangtag\b/i,
      /\bdeadstock\b/i,
      /\bnwb\b/i,
      /\bnib\b/i,
      /\bds\b/i,
      /\boriginal\s*box\b/i,
      /\bunworn\b/i,
      /\bstock\s*lace\b/i,
      /\blegit\s*check/i,
      /\bstadium\s*goods\b/i,
      /\bgoat\b.*\bauth/i,
    ],
    negativeMarkers: [
      /\brep\b(?!utation|lacement)/i,
      /\breplica\b/i,
      /\bfake\b/i,
      /\bkick\s*game\b/i,
      /\bdhgate\b/i,
      /\baaa\b/i,
      /\b1:1\b/i,
      /\bsuper\s*fake\b/i,
      /\bkick\s*rep\b/i,
      /\bpk\s*batch\b/i,
      /\bwant\s*legit\s*check\b/i,
      /\bglue\b.*\bpeel\b/i,
      /\bkicking\s*in\s*reps\b/i,
    ],
    priceFloorRatio: 0.35,   // if price < 35% of median market → likely fake
    visualRedFlags: [
      "stitching misalignment on toe box",
      "font inconsistency on heel tag",
      "off-color midsole foam",
      "incorrect outsole pattern",
      "box label font mismatch",
    ],
    authenticityTips: [
      "Check heel tab stitching: authentic Nikes use 8–10 stitches/cm",
      "Jordan 1 wings logo should be perfectly centered",
      "Yeezy 350 boost beads should be uniform, not clumped",
    ],
  },

  [CAT.WATCHES]: {
    positiveMarkers: [
      /\bbox\s*(?:and|&)\s*papers?\b/i,
      /\bcomplete\s*set\b/i,
      /\boriginal\s*bracelet\b/i,
      /\bservice\s*record\b/i,
      /\bserial\b.*\b\d{6,8}\b/i,
      /\bref\.?\s*\d{4}/i,
      /\bauth\b/i,
      /\bwarrranty\s*card\b/i,
      /\bchronoext\b/i,
      /\bwatchfinder\b/i,
    ],
    negativeMarkers: [
      /\breplica\b/i,
      /\bhomage\b/i,
      /\binspired\b/i,
      /\bgen\s*[23]\b/i,
      /\bsuper\s*clone\b/i,
      /\bnoob\s*factory\b/i,
      /\barfwatch\b/i,
      /\bgen[23]?\s*rolex\b/i,
      /\batz\b/i,
      /\brep\b(?!utation)/i,
    ],
    priceFloorRatio: 0.40,
    visualRedFlags: [
      "cyclops lens misaligned with date window",
      "drilled lugs absent on Submariner",
      "Mercedes hand on incorrect model",
      "rehaut text blurred or off-font",
      "quickset crown not present on date models",
    ],
    authenticityTips: [
      "Rolex serial should be engraved between lugs at 6 o'clock",
      "Rolex cyclops magnifies date 2.5× — fakes often 1×",
      "AP Royal Oak screws should be hexagonal and perfectly aligned",
    ],
  },

  [CAT.ELECTRONICS]: {
    positiveMarkers: [
      /\bfactory\s*sealed\b/i,
      /\bapple\s*certified\b/i,
      /\bimei\b/i,
      /\bserial\b.*\b[A-Z0-9]{8,}\b/i,
      /\breceipt\b/i,
      /\bapplecare\b/i,
      /\bunlocked\b/i,
      /\boriginal\s*box\b/i,
    ],
    negativeMarkers: [
      /\bicloud\s*lock(?:ed)?\b/i,
      /\bactivation\s*lock\b/i,
      /\bfinancial\s*lock\b/i,
      /\bblacklisted\b/i,
      /\bclone\b/i,
      /\bcounterfeit\b/i,
      /\bflashed\b/i,
    ],
    priceFloorRatio: 0.30,
    visualRedFlags: [
      "serial number mismatch between device and box",
      "iCloud lock on activation screen",
      "non-standard USB port shape",
      "off-brand charger included as 'original'",
    ],
    authenticityTips: [
      "Verify iPhone serial at apple.com/support before buying",
      "Check IMEI is not blacklisted on IMEI.info",
    ],
  },

  [CAT.HANDBAGS]: {
    positiveMarkers: [
      /\bdust\s*bag\b/i,
      /\bauth\s*card\b/i,
      /\breceipt\b/i,
      /\bserial\s*(number|no\.?|#)\b/i,
      /\bdate\s*stamp\b/i,
      /\bauth(enticit[y]?)?\b/i,
      /\bfull\s*set\b/i,
      /\bentrust\b/i,
    ],
    negativeMarkers: [
      /\breplica\b/i,
      /\bhigh\s*quality\s*copy\b/i,
      /\b1:1\b/i,
      /\baaa\b/i,
      /\bsuperfake\b/i,
      /\bking\s*factory\b/i,
      /\bdhgate\b/i,
      /\bgrade\s*[abcABC]\s*replica\b/i,
    ],
    priceFloorRatio: 0.35,
    visualRedFlags: [
      "stitching count inconsistent across panels",
      "font on logo hardware slightly off",
      "lining material coarser than expected",
      "zipper pull lighter than authentic",
      "date stamp not matching production period",
    ],
    authenticityTips: [
      "Louis Vuitton date codes: 2 letters + 4 digits (since 2007)",
      "Chanel serial stickers should be holographic and match card",
      "Hermès Birkin stitching is hand-sewn: 8–9 stitches per inch",
    ],
  },

  [CAT.TRADING_CARDS]: {
    positiveMarkers: [
      /\bpsa\s*\d\b/i,
      /\bbgs\s*\d/i,
      /\bcgc\s*\d/i,
      /\bsgc\s*\d/i,
      /\bgraded\b/i,
      /\bslabbed\b/i,
      /\bauthenticated\b/i,
    ],
    negativeMarkers: [
      /\bproxy\b/i,
      /\bcounterfeit\b/i,
      /\bfake\b/i,
      /\btest\s*print\b/i,
      /\bfanmade\b/i,
      /\bcustom\s*card\b/i,
      /\bprint\s*on\s*demand\b/i,
    ],
    priceFloorRatio: 0.20,   // ungraded raw cards can legitimately be cheap
    visualRedFlags: [
      "card stock thinner than expected",
      "color saturation off vs. reference",
      "font kerning mismatch on card name",
      "Pokémon card back pattern slightly wrong shade",
    ],
    authenticityTips: [
      "PSA graded slabs: check serial on PSAcard.com",
      "BGS 9.5 subgrades should all be listed on the case",
      "Light test: real cards show a defined black dot core",
    ],
  },
};

/**
 * Get the replica marker library for a canonical category.
 * Returns null if no entry exists.
 */
export function getReplicaMarkerLibrary(canonicalCategory) {
  return REPLICA_MARKER_LIBRARY[canonicalCategory] || null;
}

/**
 * Scan item text against the replica marker library.
 * Returns { positiveCount, negativeCount, redFlagFound, priceWarning, authenticityTips }.
 *
 * @param {string} canonicalCategory
 * @param {string} text        — item title + description concatenated
 * @param {number|null} price  — scanned price
 * @param {number|null} medianMarket — median market price for reference
 */
export function scanReplicaMarkers(canonicalCategory, text = "", price = null, medianMarket = null) {
  const lib = REPLICA_MARKER_LIBRARY[canonicalCategory];
  if (!lib) return { positiveCount: 0, negativeCount: 0, redFlagFound: false, priceWarning: false, authenticityTips: [] };

  const t = String(text || "");
  const positiveCount = lib.positiveMarkers.filter((p) => p.test(t)).length;
  const negativeCount = lib.negativeMarkers.filter((p) => p.test(t)).length;
  const redFlagFound  = negativeCount > 0;

  let priceWarning = false;
  if (price != null && medianMarket != null && medianMarket > 0) {
    priceWarning = (price / medianMarket) < lib.priceFloorRatio;
  }

  return {
    positiveCount,
    negativeCount,
    redFlagFound,
    priceWarning,
    visualRedFlags:    lib.visualRedFlags    || [],
    authenticityTips:  lib.authenticityTips  || [],
  };
}

// ── 2. Defect surface maps ─────────────────────────────────────────────────────
//
// Per-category map of defect zones → value impact fraction.
// impact: 0.0 = no impact, 1.0 = total loss
//
// These inform condition-tier scoring: a creased toe box on a sneaker drops
// value more than a scuff on the heel.

const DEFECT_SURFACE_MAPS = {
  [CAT.SNEAKERS]: {
    "toe box crease":         0.25,
    "heel tab worn":          0.15,
    "midsole yellowing":      0.30,
    "outsole separation":     0.45,
    "upper hole":             0.50,
    "stain on upper":         0.20,
    "sole wear":              0.35,
    "missing laces":          0.05,
    "insole worn":            0.10,
    "paint crack":            0.15,
    "deep crease toe box":    0.40,
  },
  [CAT.WATCHES]: {
    "crystal scratch":        0.15,
    "deep crystal scratch":   0.30,
    "case dent":              0.35,
    "bracelet stretch":       0.20,
    "dial scratch":           0.45,
    "crown missing":          0.40,
    "lume pip missing":       0.25,
    "bezel damage":           0.30,
    "caseback crack":         0.50,
    "movement service needed":0.20,
  },
  [CAT.ELECTRONICS]: {
    "screen crack":           0.40,
    "screen scratch":         0.15,
    "back glass crack":       0.25,
    "dent on body":           0.20,
    "camera scratch":         0.15,
    "missing button":         0.30,
    "battery health < 80%":   0.25,
    "water damage indicator": 0.60,
    "charging port loose":    0.20,
    "speaker grille damage":  0.10,
  },
  [CAT.HANDBAGS]: {
    "corner wear":            0.15,
    "deep corner wear":       0.30,
    "strap tear":             0.45,
    "lining stain":           0.20,
    "hardware tarnish":       0.15,
    "hardware deep scratch":  0.25,
    "logo rubbed off":        0.40,
    "zipper broken":          0.50,
    "smell":                  0.35,
    "pen mark inside":        0.20,
    "ink transfer":           0.25,
  },
  [CAT.TRADING_CARDS]: {
    "corner wear":            0.40,
    "edge wear":              0.35,
    "crease":                 0.60,
    "stain":                  0.45,
    "print defect":           0.20,
    "centering off":          0.25,
    "scratch on holo":        0.30,
    "whitening":              0.30,
    "bend":                   0.55,
    "hole punch":             0.90,
  },
};

/**
 * Get defect surface map for a category.
 * Returns an object mapping defect name → value impact fraction, or {}.
 */
export function getDefectSurfaceMap(canonicalCategory) {
  return DEFECT_SURFACE_MAPS[canonicalCategory] || {};
}

/**
 * Estimate value impact from a list of defect names detected in item text.
 * Accumulates impacts up to a maximum of 0.90 total (item still has some value).
 *
 * @param {string} canonicalCategory
 * @param {string} text — item title + description
 * @returns {{ impact: number, defectsFound: string[] }}
 */
export function estimateDefectImpact(canonicalCategory, text = "") {
  const map  = DEFECT_SURFACE_MAPS[canonicalCategory] || {};
  const t    = String(text || "").toLowerCase();
  const defectsFound = [];
  let impact = 0;

  for (const [defect, frac] of Object.entries(map)) {
    if (t.includes(defect.toLowerCase())) {
      defectsFound.push(defect);
      impact = Math.min(0.90, impact + frac);
    }
  }

  return { impact: round2(impact), defectsFound };
}

// ── 3. Local-market adjustment tables ─────────────────────────────────────────
//
// Regional demand multipliers on top of national median.
// Only categories where local supply/demand varies meaningfully.
// Key: metro area slug.  Value: multiplier vs. national median.

const LOCAL_MARKET_ADJUSTMENTS = {
  [CAT.SNEAKERS]: {
    "new_york":     1.05,
    "los_angeles":  1.08,
    "chicago":      1.03,
    "miami":        1.04,
    "atlanta":      1.06,
    "houston":      1.01,
    "dallas":       1.00,
    "seattle":      1.02,
    "san_francisco":1.06,
    "boston":       1.02,
    "phoenix":      0.97,
    "midwest":      0.95,
    "rural":        0.90,
  },
  [CAT.CLOTHING]: {
    "new_york":     1.08,
    "los_angeles":  1.10,
    "miami":        1.05,
    "san_francisco":1.06,
    "rural":        0.88,
  },
};

/**
 * Get local market multiplier for a category + metro area.
 * Returns 1.0 if no data available.
 *
 * @param {string} canonicalCategory
 * @param {string|null} metro — metro slug (e.g. "new_york")
 */
export function getLocalMarketMultiplier(canonicalCategory, metro = null) {
  if (!metro) return 1.0;
  const adjustments = LOCAL_MARKET_ADJUSTMENTS[canonicalCategory];
  if (!adjustments) return 1.0;
  const key = String(metro).toLowerCase().replace(/\s+/g, "_");
  return adjustments[key] ?? adjustments["rural"] ?? 1.0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function round2(v) {
  return v != null ? Math.round(Number(v) * 100) / 100 : 0;
}
