// src/queryGuards.js
// Phase 4H.4 — query guard functions extracted for testability.
// node --test src/queryGuards.test.js

// Airline names (mirrors AIRLINE_COMPETITOR_MAP keys + extended list from isGenericAircraftToyQuery).
// Multi-word names tested as phrases before single-token fallback.
const _AIRLINE_PHRASES = ["american airlines", "korean air", "british airways", "air france", "air canada"];
const _AIRLINE_TOKENS  = /\b(hawaiian|united|delta|southwest|alaska|jetblue|spirit|frontier|ana|jal|lufthansa|emirates|qatar|etihad|aeromexico|qantas|virgin|cathay|iberia|turkish|thai|klm|singapore)\b/;

// Aircraft family identifiers (mirrors AIRCRAFT_FAMILY_MATCH tokens + extras).
// Presence of any of these in the query means requiredFamily is known.
const _FAMILY_PATTERN = /\b(787|777|747|737|757|767|727|717|a380|a350|a330|a321|a321neo|a320|a319|a318|a300|a310|a340|concorde|dreamliner|jumbo)\b/;

// Terms that place the query firmly in aircraft/diecast context.
const _AIRCRAFT_TERM = /\b(airplane|aircraft|airliner|diecast|die-cast|model airplane|model plane|aircraft model|collectible airplane)\b|\bplane\b/;

/**
 * Catches single-word literal junk ("item", "product", "thing", etc.).
 * Does NOT catch multi-word vague phrases — use isGenericGarbageQuery for that.
 */
export function isGarbageQuery(q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;

  const junk = new Set([
    "item",
    "object",
    "product",
    "thing",
    "stuff",
    "consumer product",
    "unknown",
    "misc",
    "misc item",
    "general item",
  ]);

  return junk.has(s);
}

/**
 * Catches multi-word generic phrases that escape isGarbageQuery.
 * Pattern-based: targets constructions produced by the vision fallback
 * ("used item for", "used for pre owned", "item for sale", etc.).
 */
export function isGenericGarbageQuery(q) {
  if (!q) return true;
  const s = String(q).toLowerCase().trim();
  const genericPatterns = [
    /^used item/,
    /^used for/,
    /^item for/,
    /^object for/,
    /^unknown/,
    /^product/,
    /^thing/,
  ];
  if (genericPatterns.some((p) => p.test(s))) return true;
  if (s.split(/\s+/).filter(Boolean).length < 3) return true;
  if (s.length < 10) return true;
  return false;
}

/**
 * A query is a usable vision seed only if it passes both garbage checks and
 * has at least 3 tokens. Used by the hard-deadline path to decide whether
 * vision produced anything worth searching.
 */
export function isUsableVisionSeed(q) {
  if (!q || typeof q !== "string") return false;
  const trimmed = q.trim();
  if (!trimmed) return false;
  if (isGarbageQuery(trimmed)) return false;
  if (isGenericGarbageQuery(trimmed)) return false;
  return true;
}

/**
 * Returns true when the query describes a generic/unbranded aircraft toy or
 * model airplane WITHOUT specific airline, family, manufacturer, scale, or
 * collector-brand identity. These produce garbage market results (toy comps
 * for premium diecast models) and must not be accepted as final vision identity.
 *
 * Examples → true:  "white plastic model airplane toy", "model airplane", "toy airplane"
 * Examples → false: "Hawaiian Airlines Boeing 787 diecast model airplane",
 *                   "ANA A380 Sea Turtle 1:400", "GeminiJets Boeing 747"
 */
export function isGenericAircraftToyQuery(query) {
  if (!query) return false;
  const q = String(query).toLowerCase().trim();

  // Must contain a generic aircraft/toy aircraft term
  const hasAircraftToyTerm = (
    /\bmodel airplane\b/.test(q) ||
    /\btoy airplane\b/.test(q) ||
    /\bplastic airplane\b/.test(q) ||
    /\bdiecast airplane\b/.test(q) ||
    /\bmodel plane\b/.test(q) ||
    /\bairplane toy\b/.test(q) ||
    /\baircraft model\b/.test(q) ||
    /\bplastic plane\b/.test(q) ||
    /\bairplane model\b/.test(q) ||
    /\bmodel aircraft\b/.test(q)
  );
  if (!hasAircraftToyTerm) return false;

  // Specific airline name → not generic
  if (/\b(hawaiian|united|delta|american airlines|southwest|alaska|jetblue|spirit|frontier|ana|jal|lufthansa|emirates|british airways|air france|klm|aeromexico|qantas|singapore|cathay|thai|turkish|iberia|air canada|virgin|korean air|etihad)\b/.test(q)) return false;
  // Aircraft family / model number → not generic
  if (/\b(787|747|a380|a320|a350|777|737|a330|a321|a319|757|767|727|717|dc-[0-9]|concorde|dreamliner|jumbo)\b/.test(q)) return false;
  // Manufacturer → not generic
  if (/\b(boeing|airbus|embraer|bombardier|lockheed|mcdonnell|douglas)\b/.test(q)) return false;
  // Scale notation (1:400, 1:200) → collector model, not generic toy
  if (/\b1\s*[:/]\s*\d{2,3}\b/.test(q)) return false;
  // Collector brand → not generic
  if (/\b(geminijets?|herpa|ng model|aviation400|hogan|jc wings|dragon wings|inflight|phoenix|aeroclassics)\b/.test(q)) return false;

  return true;
}

/**
 * Returns { incomplete: true } when the query identifies a specific airline but
 * lacks any aircraft family token (787, A380, 747, etc.).
 * These queries produce vague market results and must never trigger GPT oracle.
 *
 * Examples → incomplete: "Hawaiian Airlines diecast airplane model"
 * Examples → not incomplete: "Hawaiian Airlines Boeing 787 diecast model airplane"
 *                             "ANA Airbus A380 Sea Turtle 1:400"
 *                             "white plastic model airplane toy"  (no airline → incomplete=false)
 */
export function detectIncompleteAircraftIdentityQuery(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return { incomplete: false };

  // Detect airline (phrases first, then single-token)
  let requiredAirline = null;
  for (const phrase of _AIRLINE_PHRASES) {
    if (q.includes(phrase)) { requiredAirline = phrase; break; }
  }
  if (!requiredAirline) {
    const m = q.match(_AIRLINE_TOKENS);
    if (m) requiredAirline = m[0];
  }

  if (!requiredAirline) return { incomplete: false };

  // Not incomplete if there's a specific family/model identifier
  const hasFamily = _FAMILY_PATTERN.test(q);
  if (hasFamily) return { incomplete: false, requiredAirline, requiredFamily: q.match(_FAMILY_PATTERN)?.[0] || null };

  // Not incomplete unless the query is aircraft-ish
  const hasAircraftTerm = _AIRCRAFT_TERM.test(q);
  if (!hasAircraftTerm) return { incomplete: false };

  return { incomplete: true, requiredAirline, requiredFamily: null, reason: "airline_present_family_missing" };
}
