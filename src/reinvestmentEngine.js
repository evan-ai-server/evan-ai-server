// src/reinvestmentEngine.js
// Missed-profit reinvestment — finds a high-confidence live analog for a missed opportunity.
//
// STRICT quality requirements:
//   1. Same category (required — no cross-category guessing)
//   2. Price within 30% of original missed price
//   3. Analog buy signal must be GOOD DEAL or STRONG BUY
//   4. Analog opportunity score >= 60
//   5. No analog if quality falls below threshold — return null, not garbage
//
// This is NOT "here's random stuff you might like."
// It's specifically: "you passed on X — here's a similar live deal right now."
//
// Redis keys:
//   reinvest:analog:{userId}:{missedId}  STRING  — cached analog (8h TTL)

const KEY_ANALOG   = (uid, mid) => `reinvest:analog:${uid}:${mid}`;
const ANALOG_TTL   = 8 * 3600;  // 8h cache

const MIN_ANALOG_OPP_SCORE = 60;
const MIN_ANALOG_DEAL_STR  = 0.12;
const MAX_PRICE_DEVIATION  = 0.30;  // analog price must be within 30% of missed price
const MIN_ANALOG_SIGNAL    = new Set(["GOOD DEAL", "STRONG BUY"]);

// ── Analog matching ───────────────────────────────────────────────────────────

/**
 * Score how well a live opportunity matches a missed opportunity.
 * Returns 0 if it doesn't qualify.
 *
 * Match criteria:
 *   - Category must match (required)
 *   - Price must be within MAX_PRICE_DEVIATION of missed scanned price
 *   - Signal must be GOOD DEAL or STRONG BUY
 *   - Opportunity score >= MIN_ANALOG_OPP_SCORE
 *   - Deal strength >= MIN_ANALOG_DEAL_STR
 *
 * @returns {{ qualifies: boolean, score: number, reasons: string[] }}
 */
export function scoreAnalogMatch(missedOpp, liveOpp) {
  const reasons = [];

  // Category required match
  const cat1 = String(missedOpp?.category || "").toLowerCase().trim();
  const cat2 = String(liveOpp?.category   || "").toLowerCase().trim();
  if (!cat1 || cat1 !== cat2) {
    return { qualifies: false, score: 0, reasons: ["category_mismatch"] };
  }

  // Signal quality gate
  if (!MIN_ANALOG_SIGNAL.has(liveOpp?.buySignal)) {
    return { qualifies: false, score: 0, reasons: ["weak_signal"] };
  }

  // Opportunity score gate
  if ((liveOpp?.opportunityScore || 0) < MIN_ANALOG_OPP_SCORE) {
    return { qualifies: false, score: 0, reasons: ["score_too_low"] };
  }

  // Deal strength gate
  if ((liveOpp?.dealStrength || 0) < MIN_ANALOG_DEAL_STR) {
    return { qualifies: false, score: 0, reasons: ["deal_strength_too_low"] };
  }

  // Price range gate
  const missedPrice = Number(missedOpp?.scannedPrice || missedOpp?.marketMedian);
  const analogPrice = Number(liveOpp?.priceStats?.median || liveOpp?.priceStats?.low);
  if (missedPrice > 0 && analogPrice > 0) {
    const deviation = Math.abs(missedPrice - analogPrice) / missedPrice;
    if (deviation > MAX_PRICE_DEVIATION) {
      return { qualifies: false, score: 0, reasons: ["price_range_mismatch"] };
    }
    const priceProximity = 1 - deviation;
    reasons.push(`Similar price range ($${analogPrice.toFixed(0)} vs original $${missedPrice.toFixed(0)})`);

    let score = (liveOpp.opportunityScore || 0);
    score += priceProximity * 20;  // up to 20 bonus for price similarity

    // Signal bonus
    if (liveOpp.buySignal === "STRONG BUY") { score += 10; reasons.push("Strong buy signal"); }
    else reasons.push("Good deal signal");

    // Brand match bonus (nice to have, not required)
    const missedBrand = String(missedOpp?.brand || "").toLowerCase().trim();
    const analogBrand = String(liveOpp?.brand  || "").toLowerCase().trim();
    if (missedBrand && analogBrand && missedBrand === analogBrand) {
      score += 8;
      reasons.push(`Same brand: ${liveOpp.brand}`);
    }

    reasons.push(`Same category: ${cat1}`);

    return { qualifies: true, score: Math.min(100, Math.round(score)), reasons };
  }

  // Price not available — still qualify if signal and score are strong
  if ((liveOpp?.opportunityScore || 0) >= 72) {
    reasons.push(`Same category: ${cat1}`, "Strong deal signal");
    return { qualifies: true, score: liveOpp.opportunityScore, reasons };
  }

  return { qualifies: false, score: 0, reasons: ["insufficient_price_data"] };
}

// ── Analog finder ─────────────────────────────────────────────────────────────

/**
 * Find the best live analog for a missed opportunity.
 *
 * @param {object} missedOpp      — missed opportunity record
 * @param {Array}  discoveryOpps  — live opportunities from getDiscoverySnapshot
 * @returns {{ analog: object, matchScore: number, reasons: string[] } | null}
 */
export function findAnalogInSnapshot(missedOpp, discoveryOpps = []) {
  if (!missedOpp || !discoveryOpps.length) return null;

  let bestScore  = 0;
  let bestMatch  = null;
  let bestReasons = [];

  for (const opp of discoveryOpps) {
    const { qualifies, score, reasons } = scoreAnalogMatch(missedOpp, opp);
    if (qualifies && score > bestScore) {
      bestScore   = score;
      bestMatch   = opp;
      bestReasons = reasons;
    }
  }

  if (!bestMatch || bestScore < MIN_ANALOG_OPP_SCORE) return null;

  return {
    analog:     bestMatch,
    matchScore: bestScore,
    reasons:    bestReasons,
  };
}

// ── Card builder ──────────────────────────────────────────────────────────────

/**
 * Build a reinvestment card for the daily feed.
 *
 * @param {object} missedOpp   — original missed opportunity
 * @param {object} analogMatch — from findAnalogInSnapshot
 * @returns {object} feed card
 */
export function buildReinvestmentCard(missedOpp, analogMatch) {
  if (!missedOpp || !analogMatch?.analog) return null;

  const { analog, reasons } = analogMatch;
  const name = [analog.brand, analog.model].filter(Boolean).join(" ")
    || analog.query || analog.category || "Similar item";
  const missedName = [missedOpp.brand, missedOpp.model].filter(Boolean).join(" ")
    || missedOpp.query || missedOpp.category || "your missed deal";

  const priceTarget = analog.priceStats?.low
    ? round2(analog.priceStats.low * 0.95)
    : analog.priceStats?.median
      ? round2(analog.priceStats.median * 0.90)
      : null;

  const profitPotential = analog.priceStats?.median && priceTarget
    ? round2(analog.priceStats.median - priceTarget)
    : null;

  return {
    reinvestId:       `reinvest_${missedOpp.missedId}_${Date.now()}`,
    dedupeKey:        `reinvest_${missedOpp.missedId}_${analog.fingerprint || analog.query}`,
    section:          "REINVESTMENT_ANALOG",
    priority:         analog.buySignal === "STRONG BUY" ? "HIGH" : "MEDIUM",
    title:            `Live analog found: ${name}`,
    subtitle:         `You passed on ${missedName} — here's a similar live deal`,
    body:             [
      `${analog.buySignal} in ${analog.category}`,
      reasons.slice(0, 2).join(" · "),
      profitPotential ? `~$${profitPotential.toFixed(0)} potential margin` : null,
    ].filter(Boolean).join(" · "),
    missedOpportunity: {
      missedId:     missedOpp.missedId,
      category:     missedOpp.category,
      buySignal:    missedOpp.buySignal,
      scannedPrice: missedOpp.scannedPrice,
      passedAt:     missedOpp.detectedAt,
    },
    analog: {
      query:           analog.query,
      category:        analog.category,
      brand:           analog.brand || null,
      model:           analog.model || null,
      fingerprint:     analog.fingerprint || null,
      buySignal:       analog.buySignal,
      opportunityScore: analog.opportunityScore,
      priceTarget,
      priceStats:      analog.priceStats || null,
      listingCount:    analog.listingCount || null,
      bestListing:     analog.bestListing || null,
    },
    matchScore:       analogMatch.matchScore,
    matchReasons:     reasons,
    action:           "SEARCH",
    actionData:       { query: analog.query, category: analog.category },
    score:            Math.min(88, analogMatch.matchScore),
    generatedAt:      Date.now(),
    dismissible:      true,
    expiresAt:        Date.now() + 24 * 3600 * 1000,
  };
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

/**
 * Cache a reinvestment analog for a user+missed combination.
 */
export async function cacheAnalog(redis, userId, missedId, analogData) {
  if (!redis || !userId || !missedId) return;
  await redis.set(KEY_ANALOG(userId, missedId), JSON.stringify(analogData), "EX", ANALOG_TTL).catch(() => {});
}

/**
 * Load cached analog.
 */
export async function loadCachedAnalog(redis, userId, missedId) {
  if (!redis || !userId || !missedId) return null;
  try {
    const raw = await redis.get(KEY_ANALOG(userId, missedId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ── Batch builder ─────────────────────────────────────────────────────────────

/**
 * Build reinvestment cards for the top N missed opportunities.
 * Only returns cards where a strong analog was found.
 *
 * @param {Array}  missedOpps    — from listMissedOpportunities
 * @param {Array}  discoveryOpps — from getDiscoverySnapshot
 * @param {number} limit         — max reinvestment cards to return
 * @returns {Array<object>} array of reinvestment feed cards
 */
export function buildReinvestmentCards(missedOpps = [], discoveryOpps = [], limit = 2) {
  const cards = [];

  for (const missed of missedOpps.slice(0, 10)) { // only check top 10 missed opps
    if (cards.length >= limit) break;

    const analogMatch = findAnalogInSnapshot(missed, discoveryOpps);
    if (!analogMatch) continue;

    const card = buildReinvestmentCard(missed, analogMatch);
    if (card) cards.push(card);
  }

  return cards;
}

// ── Helper ────────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(Number(v) * 100) / 100; }
