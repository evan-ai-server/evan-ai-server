// src/offerIdentityGuard.js
// Phase 4B.1 — Offer identity guard for verified URL recovery.
//
// Before an item can be upgraded to verified_listing via the google_product
// recovery path, the chosen seller must be identity-compatible with the
// original listing on three dimensions:
//   1. Source / merchant host — same store family (required)
//   2. Price — within tight absolute or relative tolerance (required)
//   3. Identity anchor — no explicit aircraft/airline contradiction (required)
//
// Pure synchronous functions. No I/O, no side effects, no network.

// ── Constants ─────────────────────────────────────────────────────────────────

export const PRICE_ABS_TOLERANCE = 2.00;   // within $2.00 absolute
export const PRICE_PCT_TOLERANCE = 0.08;   // within 8% relative
export const MIN_GUARD_SCORE     = 0.80;   // source(0.50) + price(0.30) both required

// Stopwords excluded from source token extraction
const SOURCE_STOP_WORDS = new Set([
  "the", "a", "an", "of", "in", "at", "on", "and", "or", "for", "by",
  "shop", "store", "models", "model", "aviation", "hobbies", "hobby",
  "market", "mall", "online", "direct", "official", "co", "ltd", "inc",
]);

// Aircraft family tokens — contradiction: original has "787", recovered has "777"
const AIRCRAFT_FAMILY_TOKENS = [
  "787", "777", "747", "737", "757", "767",
  "a380", "a320", "a330", "a350", "a321", "a319",
];

// Competing airline tokens — used to detect airline contradictions
const COMPETITOR_AIRLINE_TOKENS = [
  "ana", "jal", "united", "delta", "american", "lufthansa", "emirates",
  "southwest", "alaska", "jetblue", "spirit", "frontier", "qantas", "british",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Extract meaningful tokens from a source label such as:
 *   "eBay - hobby-4-you"     → ["ebay"]
 *   "ScaleModelStore.com"    → ["scalemodelstore"]
 *   "The Flying Mule"        → ["flying", "mule"]
 *   "MTS Aviation Models"    → ["mts"]
 *   "wingsmo.com"            → ["wingsmo"]
 */
export function extractSourceTokens(source) {
  let s = String(source || "").toLowerCase().trim();
  // Strip trailing TLD
  s = s.replace(/\.(com|net|org|co\.uk|co|io|store|shop|info)$/i, "");
  // eBay pattern: always normalize to just "ebay"
  if (s.startsWith("ebay")) return ["ebay"];
  return s
    .split(/[\s\-_.\/]+/)
    .map(t => t.replace(/[^a-z0-9]/g, ""))
    .filter(t => t.length >= 2 && !SOURCE_STOP_WORDS.has(t));
}

/**
 * Extract tokens from a hostname such as:
 *   "www.ebay.com"            → ["ebay"]
 *   "scalemodelstore.com"     → ["scalemodelstore"]
 *   "flyingmule.com"          → ["flyingmule"]
 *   "mtsaviationmodels.com"   → ["mtsaviationmodels"]
 */
export function extractHostTokens(host) {
  const h = String(host || "").toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.(com|net|org|co\.uk|co|io|store|shop|info|us|uk|ca|au).*$/, "");
  return h.split("-")
    .map(t => t.replace(/[^a-z0-9]/g, ""))
    .filter(t => t.length >= 2);
}

/**
 * Returns true if the original source label plausibly matches the recovered host.
 * Uses token overlap: any source token appearing in the concatenated host string
 * (or vice versa) is a match.
 *
 * Examples that PASS: "eBay - hobby-4-you" / "ebay.com", "ScaleModelStore.com" / "scalemodelstore.com"
 * Examples that FAIL: "eBay - sellerA" / "scalemodelstore.com", "ScaleModelStore.com" / "ebay.com"
 */
export function sourceMatchesHost(source, host) {
  const sToks = extractSourceTokens(source);
  const hToks = extractHostTokens(host);
  if (!sToks.length || !hToks.length) return false;

  const hStr = hToks.join("");
  for (const st of sToks) {
    if (hStr.includes(st) || st === hStr) return true;
  }
  const sStr = sToks.join("");
  for (const ht of hToks) {
    if (sStr.includes(ht) || ht === sStr) return true;
  }
  return false;
}

/**
 * Returns true if the recovered seller name or host contains an explicit
 * contradiction with the original item's identity anchors.
 *
 * Checks:
 *   - Aircraft family: original "787" → reject if recovered has "777", "747", etc.
 *   - Airline: original "hawaiian" → reject if recovered has "ana", "jal", etc.
 *
 * No NLP — only explicit token presence.
 */
export function hasIdentityContradiction(originalTitle, sellerName, recoveredHost) {
  const orig = (originalTitle || "").toLowerCase();
  const rec  = ((sellerName || "") + " " + (recoveredHost || "")).toLowerCase();

  // Aircraft family contradiction
  let origFamily = null;
  for (const f of AIRCRAFT_FAMILY_TOKENS) {
    if (orig.includes(f)) { origFamily = f; break; }
  }
  if (origFamily) {
    for (const f of AIRCRAFT_FAMILY_TOKENS) {
      if (f !== origFamily && rec.includes(f)) return true;
    }
  }

  // Airline contradiction
  const origHasHawaiian = orig.includes("hawaiian");
  if (origHasHawaiian) {
    if (COMPETITOR_AIRLINE_TOKENS.some(a => rec.includes(a))) return true;
  } else {
    const origAirline = COMPETITOR_AIRLINE_TOKENS.find(a => orig.includes(a));
    if (origAirline) {
      const others = COMPETITOR_AIRLINE_TOKENS.filter(a => a !== origAirline);
      if (others.some(a => rec.includes(a))) return true;
      if (rec.includes("hawaiian")) return true;
    }
  }

  return false;
}

// ── Core guard ────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a recovered seller offer is identity-compatible with the
 * original listing.
 *
 * Required to pass: sourceMatch AND priceMatch AND no identity contradiction.
 * MIN_GUARD_SCORE = 0.80, meaning source(0.50) + price(0.30) are both required.
 *
 * @returns {{ ok: boolean, reason: string, score: number, details: object }}
 */
export function evaluateRecoveredOfferIdentity(originalItem, seller, recoveredUrl) {
  const originalSource = String(originalItem?.source || "");
  const originalTitle  = String(originalItem?.title  || "");
  const originalPrice  = _safeNum(originalItem?.totalPrice ?? originalItem?.price);
  const sellerName     = String(seller?.name || "");

  let recoveredHost;
  try {
    recoveredHost = new URL(recoveredUrl).hostname.toLowerCase();
  } catch {
    return {
      ok: false, reason: "offer_blocked_host", score: 0,
      details: {
        originalSource, recoveredHost: "invalid",
        originalPrice, recoveredPrice: null,
        priceDeltaAbs: null, priceDeltaPct: null,
        sourceMatch: false, priceMatch: false,
        titleMatch: false, identityAnchorMatch: false,
      },
    };
  }

  const recoveredPrice = _safeNum(
    seller?.extracted_total_price ??
    seller?.total_price ??
    seller?.extracted_price ??
    seller?.price
  );

  // ── 1. Source / host match ─────────────────────────────────────────────────
  const sourceMatch = sourceMatchesHost(originalSource, recoveredHost);

  // ── 2. Price match ─────────────────────────────────────────────────────────
  let priceMatch = false;
  let priceDeltaAbs = null;
  let priceDeltaPct = null;

  if (originalPrice == null || recoveredPrice == null) {
    priceMatch = false;
  } else {
    priceDeltaAbs = Math.abs(originalPrice - recoveredPrice);
    priceDeltaPct = priceDeltaAbs / Math.max(originalPrice, 0.01);
    priceMatch = priceDeltaAbs <= PRICE_ABS_TOLERANCE || priceDeltaPct <= PRICE_PCT_TOLERANCE;
  }

  // ── 3. Identity anchor contradiction ──────────────────────────────────────
  const contradiction   = hasIdentityContradiction(originalTitle, sellerName, recoveredHost);
  const titleMatch      = !contradiction;
  const identityAnchorMatch = titleMatch;

  // ── Score and decision ─────────────────────────────────────────────────────
  let score = 0;
  if (sourceMatch) score += 0.50;
  if (priceMatch)  score += 0.30;
  if (titleMatch)  score += 0.20;

  let reason;
  if (!sourceMatch) {
    reason = "offer_source_mismatch";
  } else if (originalPrice == null || recoveredPrice == null) {
    reason = "offer_missing_price";
  } else if (!priceMatch) {
    reason = "offer_price_mismatch";
  } else if (contradiction) {
    reason = "offer_identity_anchor_mismatch";
  } else {
    reason = "guard_passed";
  }

  const ok = score >= MIN_GUARD_SCORE && !contradiction;

  return {
    ok,
    reason,
    score: Math.round(score * 100) / 100,
    details: {
      originalSource,
      recoveredHost,
      originalPrice,
      recoveredPrice,
      priceDeltaAbs:        priceDeltaAbs != null ? Math.round(priceDeltaAbs * 100) / 100 : null,
      priceDeltaPct:        priceDeltaPct != null ? Math.round(priceDeltaPct * 1000) / 1000 : null,
      sourceMatch,
      priceMatch,
      titleMatch,
      identityAnchorMatch,
    },
  };
}

/**
 * Given sellers from google_product, find the best one that passes the offer
 * identity guard. Returns { seller, link, host, guardResult } or null.
 *
 * Does NOT pick cheapest-first. Evaluates ALL sellers and picks the highest-
 * scoring guard-passing seller. If no seller passes, returns null.
 *
 * @param {Array}    sellers              — SerpAPI sellers_results.online_sellers
 * @param {object}   originalItem         — the original listing item
 * @param {Function} urlValidator         — e.g. _isValidMerchantUrl(url) → boolean
 */
export function selectBestVerifiedSeller(sellers, originalItem, urlValidator) {
  if (!Array.isArray(sellers) || !sellers.length) return null;

  let best = null;
  let bestScore = -1;

  for (const seller of sellers) {
    const link = String(seller?.link || "");
    if (!link) continue;
    if (urlValidator && !urlValidator(link)) continue;

    let host;
    try { host = new URL(link).hostname.toLowerCase(); } catch { continue; }

    const guardResult = evaluateRecoveredOfferIdentity(originalItem, seller, link);
    if (guardResult.ok && guardResult.score > bestScore) {
      best       = { seller, link, host, guardResult };
      bestScore  = guardResult.score;
    }
  }

  return best;
}
