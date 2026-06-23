// src/nearDupServeGate.js
// Pure decision helpers for the pHash near-duplicate serve path (Phase 5A.4F.2).
//
// pHash proves visual similarity only — NOT same-item identity. These gates
// decide (a) whether a near-dup prior payload is safe to early-return, and
// (b) whether a background verify contradicts the served identity enough to
// self-heal (drop the offending pHash entry).
//
// Over-blocking is the safe direction: a blocked serve just falls through to
// normal vision. A wrong serve is a trust failure. Gates err toward blocking.

// Substring keywords for auth-sensitive categories. Matched against BOTH the
// prior payload's category AND its query (a generic category can still carry a
// luxury brand in the query). Intentionally broad — a false high-stakes match
// only costs a fast-path skip, never a wrong identity. Deliberately excludes
// brand-useful collectible terms (diecast/model airplane/figurine/book).
const HIGH_STAKES_KEYWORDS = [
  // footwear
  "sneaker", "shoe", "trainer", "jordan", "yeezy", "dunk", "air max", "air force", "new balance",
  // bags
  "handbag", "hand bag", "purse", "tote", "clutch", "satchel", "crossbody", "shoulder bag",
  // watches
  "watch", "wristwatch", "timepiece", "rolex", "omega", "patek", "audemars", "cartier", "tag heuer",
  // jewelry / precious
  "jewelry", "jewellery", "necklace", "earring", "bracelet", "pendant", "diamond", "sterling",
  "14k", "18k", "karat", "bullion",
  // electronics
  "electronic", "smartphone", "iphone", "ipad", "macbook", "laptop", "playstation", "xbox",
  "nintendo switch", "airpods", "graphics card", "gpu",
  // trading cards / luxury fashion
  "trading card", "pokemon", "sports card", "graded card", "psa ", "tcg", "louis vuitton",
  "gucci", "chanel", "hermes", "hermès", "prada", "balenciaga", "designer",
];

function matchesHighStakes(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return HIGH_STAKES_KEYWORDS.some((kw) => t.includes(kw));
}

const AIRCRAFT_HINT_RE = /\b(aircraft|airplane|airliner|airline|dreamliner|boeing|airbus|jetliner|plane)\b/;

/**
 * Decide whether a near-dup prior payload is safe to early-return.
 *
 * @param {object} args
 * @param {string} args.query        - prior payload query
 * @param {string} args.category     - prior payload category (lowercased ok)
 * @param {string|null} args.airline - airline lock detected in query (requiredAirline) or null
 * @param {boolean} args.hasFamily   - whether an aircraft family token is present in the query
 * @param {boolean} args.isHighStakesExact - result of the existing exact-set isTrueHighStakesVisionCategory
 * @returns {{ serve: boolean, reason: string }}
 */
export function evaluateNearDupServeGate({ query, category, airline, hasFamily, isHighStakesExact }) {
  const q = String(query ?? "").trim();
  if (!q) return { serve: false, reason: "empty_query" };

  const cat = String(category ?? "").toLowerCase();

  // High-stakes block: exact-set OR substring on category/query. Auth-sensitive
  // categories never early-return from image similarity alone.
  if (isHighStakesExact || matchesHighStakes(cat) || matchesHighStakes(q)) {
    return { serve: false, reason: "high_stakes_category" };
  }

  // Aircraft completeness: require BOTH airline AND family. Blocks family-only
  // (e.g. generic "Boeing 787") and airline-only seeds — airline livery is a
  // value-critical discriminator (Hawaiian 787 ≠ Gulf Air 787).
  const isAircraft = !!airline || AIRCRAFT_HINT_RE.test(`${cat} ${q.toLowerCase()}`);
  if (isAircraft) {
    if (!airline)   return { serve: false, reason: "aircraft_missing_airline" };
    if (!hasFamily) return { serve: false, reason: "aircraft_missing_family" };
  }

  return { serve: true, reason: "ok" };
}

function _tokens(s) {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
  );
}

function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Decide whether a background verify pass contradicts the served near-dup
 * identity strongly enough to self-heal. Conservative: only heals on a
 * confident verify with a clear airline/family mismatch or near-zero token
 * overlap. A low-confidence or noisy verify never removes a good entry.
 *
 * @returns {{ contradicts: boolean, reason: string }}
 */
export function detectNearDupContradiction({
  servedQuery, verifyQuery,
  servedAirline, verifyAirline,
  servedFamily, verifyFamily,
  verifyConfidence, minConfidence = 0.6, minOverlap = 0.2,
}) {
  if (!(Number(verifyConfidence) >= minConfidence)) {
    return { contradicts: false, reason: "verify_low_confidence" };
  }
  if (!String(verifyQuery ?? "").trim()) {
    return { contradicts: false, reason: "verify_empty" };
  }
  if (servedAirline && verifyAirline && servedAirline !== verifyAirline) {
    return { contradicts: true, reason: "airline_mismatch" };
  }
  if (servedFamily && verifyFamily && servedFamily !== verifyFamily) {
    return { contradicts: true, reason: "family_mismatch" };
  }
  const overlap = _jaccard(_tokens(servedQuery), _tokens(verifyQuery));
  if (overlap < minOverlap) {
    return { contradicts: true, reason: "low_token_overlap" };
  }
  return { contradicts: false, reason: "consistent" };
}
