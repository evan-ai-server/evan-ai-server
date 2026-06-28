// src/highStakesProvisionalGate.js
// Phase 5D.1D — High-stakes provisional response gate (Option B guarded).
//
// When query_fast detects a true high-stakes category but is blocked from
// finalizing identity (master confirmation required), this gate decides:
//   • SPECIFIC provisional — "Likely Apple Watch Ultra — confirming exact model…"
//     Requires high confidence, high brand certainty, and a specific non-generic query.
//   • CATEGORY-ONLY provisional — "Identifying watch — confirming exact model…"
//     Falls back here when the specific guard fails.
//   • INELIGIBLE — no provisional emitted at all (unsupported mode, no category).
//
// Contract:
//   - Pure: no side effects, no logging, no I/O, no global state.
//   - Never sets marketAllowed/affiliateAllowed/verifiedLanguageAllowed — those
//     are the caller's responsibility.
//   - Only judges eligibility; the caller emits the provisional response.

const SPECIFIC_PROVISIONAL_MIN_CONFIDENCE     = 0.92;
const SPECIFIC_PROVISIONAL_MIN_BRAND_CERTAINTY = 0.80;

// Generic terms that are too vague for a "Likely X" claim from a single mini-pass.
// Matched against the full lowercased query.  A false positive here only means
// falling back to category-only — never a wrong specific claim.
const GENERIC_PROVISIONAL_DISQUALIFIERS = [
  // watches (generic)
  "smartwatch", "sport watch", "digital watch", "analog watch",
  "round watch", "square watch", "fitness tracker", "fitness watch",
  "luxury watch", "dress watch", "dive watch", "sport smartwatch",
  // footwear (generic)
  "sneaker", "sneakers", "shoe", "shoes", "trainer", "trainers",
  "athletic shoe", "running shoe",
  // bags (generic)
  "handbag", "purse", "bag", "luxury bag",
  // electronics (generic)
  "smartphone", "mobile phone",
  // cards (generic)
  "trading card", "sports card",
  // jewelry (generic)
  "jewelry", "necklace", "ring", "bracelet",
];

function isGenericProvisionalQuery(query) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (GENERIC_PROVISIONAL_DISQUALIFIERS.includes(q)) return true;
  // Single-word queries are too vague for a "Likely X" specific claim
  if (q.split(/\s+/).filter(Boolean).length < 2) return true;
  return false;
}

/**
 * Decide whether a rejected-but-high-stakes query_fast result qualifies for:
 *   - specific provisional ("Likely Apple Watch Ultra — confirming…"), or
 *   - category-only provisional ("Identifying watch — confirming exact model…"), or
 *   - ineligible (no provisional at all).
 *
 * @param {object} args
 * @param {string|null} args.query          - query_fast parsed.query
 * @param {string|null} args.category       - query_fast category (lowercased ok)
 * @param {number}      args.confidence     - query_fast confidence (0-1)
 * @param {number}      args.brandCertainty - query_fast brandCertainty (0-1)
 * @param {string}      args.mode           - vision mode ("item"|"prop")
 * @returns {{
 *   eligible:          boolean,
 *   specificProvisional: boolean,
 *   reason:            string,
 *   provisionalQuery:  string|null,
 *   provisionalCategory: string
 * }}
 */
export function evaluateHighStakesProvisional({ query, category, confidence, brandCertainty, mode }) {
  const q   = String(query ?? "").trim();
  const cat = String(category ?? "").trim().toLowerCase();

  // Ineligible cases — no provisional emitted
  if (!cat) {
    return { eligible: false, specificProvisional: false, reason: "no_category",      provisionalQuery: null, provisionalCategory: "" };
  }
  if (!["item", "prop"].includes(mode)) {
    return { eligible: false, specificProvisional: false, reason: "unsupported_mode", provisionalQuery: null, provisionalCategory: cat };
  }

  // Category is present but no query → category-only provisional
  if (!q) {
    return { eligible: true, specificProvisional: false, reason: "no_query", provisionalQuery: null, provisionalCategory: cat };
  }

  const conf  = Number(confidence  ?? 0);
  const brand = Number(brandCertainty ?? 0);

  // Option B guard — ALL must pass for a specific provisional
  if (conf < SPECIFIC_PROVISIONAL_MIN_CONFIDENCE) {
    return { eligible: true, specificProvisional: false, reason: "confidence_below_threshold",     provisionalQuery: null, provisionalCategory: cat };
  }
  if (brand < SPECIFIC_PROVISIONAL_MIN_BRAND_CERTAINTY) {
    return { eligible: true, specificProvisional: false, reason: "brand_certainty_below_threshold", provisionalQuery: null, provisionalCategory: cat };
  }
  if (isGenericProvisionalQuery(q)) {
    return { eligible: true, specificProvisional: false, reason: "generic_query",                   provisionalQuery: null, provisionalCategory: cat };
  }

  return { eligible: true, specificProvisional: true, reason: "accepted", provisionalQuery: q, provisionalCategory: cat };
}
