// Phase V3 — item/prop similarity-cache provisional vision seed eligibility.
//
// Pure, dependency-light gating so a near-duplicate scan can return a prior
// identity BEFORE OpenAI, without ever inventing identity or serving a risky
// category from cache. Kept out of index.js so it can be unit-tested directly.
//
// Safety model:
//   - only "safe" collectible categories (diecast / model aircraft / collectible)
//   - never high-stakes categories (sneakers/electronics/luxury/watches/cards)
//   - never an incomplete aircraft identity (airline but no family) — defer to OpenAI
//   - the returned query is the CACHED query verbatim; nothing is fabricated

import { detectIncompleteAircraftIdentityQuery, isGarbageQuery } from "./queryGuards.js";

// Positive allowlist — collectible categories where a high-similarity image match
// is a trustworthy provisional identity.
const SAFE_CATEGORY_RE = /\b(die-?cast|model airplane|model plane|aircraft model|airplane model|model aircraft|diecast model|collectib)/i;

// Hard block — categories where a wrong identity is expensive/risky. Never
// provisional-seed these in this slice even on a high similarity score.
const HIGH_STAKES_CATEGORY_RE = /\b(sneaker|shoe|trainer|jordan|yeezy|watch|rolex|omega|electronic|airpod|iphone|ipad|macbook|laptop|console|gpu|camera|lux|luxury|handbag|purse|gucci|chanel|louis|hermes|prada|card|pokemon|tcg|graded|psa|bgs|coin|jewelry|jewellery|diamond|gold)/i;

export function isSafeProvisionalCategory(category) {
  const c = String(category || "").toLowerCase().trim();
  if (!c) return false;
  if (HIGH_STAKES_CATEGORY_RE.test(c)) return false;
  return SAFE_CATEGORY_RE.test(c);
}

/**
 * Decide whether a similarity hit may be returned as a provisional vision seed.
 * Returns { eligible, reason }. Never mutates input; never fabricates identity.
 *
 * @param {object} args
 * @param {string} args.mode          - vision mode ("item"|"prop"|...)
 * @param {string} args.query         - cached prior query (used verbatim)
 * @param {string} args.category      - cached prior category
 * @param {number} args.similarity    - cosine similarity of the match (0..1)
 * @param {number} args.threshold     - strict minimum similarity
 */
export function evaluateProvisionalSeed({ mode, query, category, similarity, threshold = 0.92 } = {}) {
  if (mode !== "item" && mode !== "prop") {
    return { eligible: false, reason: "mode_not_item_prop" };
  }
  const q = String(query || "").trim();
  if (!q) return { eligible: false, reason: "no_prior_query" };
  if (isGarbageQuery(q)) return { eligible: false, reason: "garbage_query" };

  const sim = Number(similarity);
  const thr = Number(threshold);
  if (!Number.isFinite(sim) || !Number.isFinite(thr) || sim < thr) {
    return { eligible: false, reason: "below_similarity_threshold" };
  }

  if (!isSafeProvisionalCategory(category)) {
    return { eligible: false, reason: "unsafe_or_unknown_category" };
  }

  // Aircraft honesty: an airline-without-family cached query must NOT be served
  // as a confident provisional seed — defer to OpenAI / approximate-mode path.
  const air = detectIncompleteAircraftIdentityQuery(q);
  if (air?.incomplete) {
    return { eligible: false, reason: "incomplete_aircraft_identity" };
  }

  return { eligible: true, reason: "accepted" };
}
