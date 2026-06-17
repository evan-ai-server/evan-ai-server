// src/aircraftFamilyRecovery.js
// Phase V3.10B — pure decision helpers for background aircraft family recovery.
//
// When the master vision pass returns "Hawaiian Airlines diecast airplane model"
// (airline present, family missing), the background-result endpoint blocks market
// search. This module provides a safe recovery path: check the similarity index
// for a prior scan of the SAME item that had a complete identity (airline + family).
//
// Recovery is only attempted for aircraft collectible context (diecast/model).
// The recovered family must match the required airline. No GPT oracle, no URL
// trust, no fabricated listings.

/**
 * Evaluate whether a similarity hit can provide a safe family hint for an
 * incomplete aircraft query.
 *
 * @param {{
 *   incompleteQuery: string,
 *   requiredAirline: string,
 *   candidateQuery: string,
 *   candidateCategory: string|null,
 *   candidateConfidence: number,
 *   similarity: number,
 *   threshold: number,
 * }} opts
 * @returns {{
 *   accepted: boolean,
 *   recoveredQuery: string|null,
 *   reason: string,
 * }}
 */
export function evaluateFamilyRecoveryHint({
  incompleteQuery = "",
  requiredAirline = "",
  candidateQuery = "",
  candidateCategory = null,
  candidateConfidence = 0,
  similarity = 0,
  threshold = 0.88,
} = {}) {
  if (!incompleteQuery || !requiredAirline || !candidateQuery) {
    return { accepted: false, recoveredQuery: null, reason: "missing_inputs" };
  }

  if (similarity < threshold) {
    return { accepted: false, recoveredQuery: null, reason: "below_similarity_threshold" };
  }

  // Must be aircraft collectible context
  const cat = String(candidateCategory || "").toLowerCase();
  const isSafeCategory = /diecast|model aircraft|aircraft model|die-cast|collectible/.test(cat) ||
    /diecast|model airplane|aircraft model/.test(candidateQuery.toLowerCase());
  if (!isSafeCategory) {
    return { accepted: false, recoveredQuery: null, reason: "not_aircraft_collectible_context" };
  }

  // Candidate must contain the same airline
  const cNorm = candidateQuery.toLowerCase();
  const airline = requiredAirline.toLowerCase();
  if (!cNorm.includes(airline)) {
    return { accepted: false, recoveredQuery: null, reason: "airline_mismatch" };
  }

  // Candidate must have an aircraft family (boeing/airbus + model number)
  const hasManufacturer = /\b(boeing|airbus|embraer|bombardier|lockheed|mcdonnell|douglas)\b/i.test(candidateQuery);
  const hasFamily = /\b(787|787-9|787-8|747|747-400|777|777-300|737|737-800|a380|a350|a330|a320|a321|a319|dreamliner|concorde|dc-10|dc-8|md-11|md-80|e190|e175|crj|erj)\b/i.test(candidateQuery);
  if (!hasManufacturer && !hasFamily) {
    return { accepted: false, recoveredQuery: null, reason: "candidate_missing_family" };
  }

  if (candidateConfidence < 0.6) {
    return { accepted: false, recoveredQuery: null, reason: "candidate_low_confidence" };
  }

  return {
    accepted: true,
    recoveredQuery: candidateQuery,
    reason: "similarity_family_hint_accepted",
  };
}

/**
 * Minimum similarity for family recovery hints. Slightly lower than the
 * provisional seed threshold (0.92) because we're only using it to recover
 * a missing aircraft family, not to trust the entire identity.
 */
export const FAMILY_RECOVERY_SIMILARITY_THRESHOLD = 0.88;
