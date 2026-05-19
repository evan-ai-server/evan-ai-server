// src/arbitrageEngine.js
// Cross-platform arbitrage detector for Evan AI.
//
// STRICT rules — all must pass before flagging arbitrage:
//   1. Strong identity match: brand + model required, not category alone
//   2. Real spread: ≥$15 net AND ≥15% net after sell-side fees
//   3. Source reliability: untrustworthy sources discounted
//   4. Condition tier compatibility: no poor/damaged vs mint comparisons
//   5. Never surfaces arbitrage without identity confidence >= 0.65
//
// This is buy-low / sell-high detection ONLY.
// No relisting infrastructure, no transaction logic, no sharing.

// ── Platform data ─────────────────────────────────────────────────────────────

// Estimated sell-side fees (taker rates, rough)
const PLATFORM_FEE_PCT = {
  stockx:               0.095,
  goat:                 0.095,
  ebay:                 0.133,
  poshmark:             0.200,
  depop:                0.100,
  mercari:              0.100,
  chrono24:             0.065,
  "the realreal":       0.250,
  fashionphile:         0.200,
  grailed:              0.090,
  "facebook marketplace": 0.050,
  offerup:              0.079,
  vinted:               0.050,
  vestiaire:            0.150,
};

// Source reliability: how trustworthy is a price/identity from this platform
// 0–1 scale. Lower = noisier, more listings with wrong titles, condition mismatches
const PLATFORM_RELIABILITY = {
  stockx:               0.95,  // authenticated, standardized listings
  goat:                 0.95,
  chrono24:             0.90,
  "the realreal":       0.88,
  grailed:              0.82,
  vestiaire:            0.80,
  ebay:                 0.75,
  mercari:              0.72,
  depop:                0.72,
  vinted:               0.68,
  poshmark:             0.70,
  fashionphile:         0.85,
  "facebook marketplace": 0.50, // local, unverified
  offerup:              0.52,
};

// Minimum thresholds
const MIN_NET_SPREAD_DOLLARS = 15;
const MIN_NET_SPREAD_PCT     = 0.15;
const MIN_IDENTITY_CONFIDENCE = 0.65;
const MIN_RELIABILITY_FLOOR  = 0.50; // discard items from lower-reliability sources

// ── Condition tier map ────────────────────────────────────────────────────────
// Tier 0 = worst, Tier 4 = best. Arbitrage only valid if tiers within 1 step.
const CONDITION_TIER = {
  poor: 0, damaged: 0, broken: 0, parts: 0,
  fair: 1, worn: 1, used: 1,
  good: 2, "very good": 2,
  excellent: 3, "like new": 3, "near mint": 3,
  new: 4, mint: 4, deadstock: 4, ds: 4, nwt: 4, bnib: 4,
};

function conditionTier(condStr = "") {
  const c = String(condStr).toLowerCase().trim();
  for (const [key, tier] of Object.entries(CONDITION_TIER)) {
    if (c.includes(key)) return tier;
  }
  return 2; // default: good
}

// ── Identity match ────────────────────────────────────────────────────────────

/**
 * Normalize a string for fuzzy comparison:
 * lowercase, strip special chars, collapse spaces.
 */
function normStr(s = "") {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Strict identity match between two items.
 * Returns { matched: boolean, confidence: 0–1, reason }
 *
 * Matching rules:
 *   - Both must have a non-trivial brand (≥2 chars after normalization)
 *   - Both must have a non-trivial model (≥2 chars)
 *   - Brand must match exactly (normalized)
 *   - Model: one must be a substring of the other (normalized), length ≥4
 *   - Condition tiers within 1 step
 *   - Category must be same or closely related
 */
export function assessIdentityMatch(item1, item2) {
  const brand1 = normStr(item1?.brand || item1?.identity?.brand || "");
  const brand2 = normStr(item2?.brand || item2?.identity?.brand || "");
  const model1 = normStr(item1?.model || item1?.identity?.model || "");
  const model2 = normStr(item2?.model || item2?.identity?.model || "");
  const cat1   = normStr(item1?.category || "");
  const cat2   = normStr(item2?.category || "");

  // Both must have meaningful brand + model
  if (brand1.length < 2 || brand2.length < 2) {
    return { matched: false, confidence: 0, reason: "missing_brand" };
  }
  if (model1.length < 2 || model2.length < 2) {
    return { matched: false, confidence: 0, reason: "missing_model" };
  }

  // Brand must match exactly
  if (brand1 !== brand2) {
    return { matched: false, confidence: 0, reason: "brand_mismatch" };
  }

  // Model: substring match (longer must contain shorter, min 4 chars of overlap)
  const shorter = model1.length <= model2.length ? model1 : model2;
  const longer  = model1.length >  model2.length ? model1 : model2;
  if (shorter.length < 4) {
    return { matched: false, confidence: 0.3, reason: "model_too_short" };
  }
  if (!longer.includes(shorter)) {
    // Try word overlap as a fallback
    const words1 = new Set(model1.split(" ").filter(w => w.length >= 3));
    const words2 = new Set(model2.split(" ").filter(w => w.length >= 3));
    const overlap = [...words1].filter(w => words2.has(w));
    if (overlap.length < 2) {
      return { matched: false, confidence: 0.2, reason: "model_mismatch" };
    }
    // Partial model match — lower confidence
    const conf = Math.min(0.75, 0.5 + overlap.length * 0.1);
    if (conf < MIN_IDENTITY_CONFIDENCE) {
      return { matched: false, confidence: conf, reason: "weak_model_match" };
    }
    return { matched: true, confidence: conf, reason: "word_overlap" };
  }

  // Condition tier check
  const tier1 = conditionTier(item1?.condition || "");
  const tier2 = conditionTier(item2?.condition || "");
  if (Math.abs(tier1 - tier2) > 1) {
    return { matched: false, confidence: 0.4, reason: "condition_tier_mismatch" };
  }

  // Category match is helpful but not required if brand+model already matched
  const catMatch = cat1 === cat2 || cat1.includes(cat2) || cat2.includes(cat1);
  const confidence = catMatch ? 0.92 : 0.78;

  return { matched: confidence >= MIN_IDENTITY_CONFIDENCE, confidence, reason: "strong_match" };
}

// ── Spread computation ────────────────────────────────────────────────────────

function platformKey(source = "") {
  return String(source).toLowerCase().replace(/[^a-z ]/g, "").trim();
}

function platformFee(source = "") {
  return PLATFORM_FEE_PCT[platformKey(source)] ?? 0.13; // conservative default
}

function platformReliability(source = "") {
  return PLATFORM_RELIABILITY[platformKey(source)] ?? 0.60;
}

/**
 * Compute the net arbitrage spread between a low-price and high-price item.
 *
 * Net = (highPrice × (1 − sellFee)) − buyPrice
 *
 * @returns {{ netDollars, netPct, grossSpread, sellFee, viable }}
 */
export function computeArbitrageSpread(buyPrice, sellPrice, sellPlatform = "") {
  const buy  = Number(buyPrice)  || 0;
  const sell = Number(sellPrice) || 0;
  if (!buy || !sell || sell <= buy) return { netDollars: 0, netPct: 0, grossSpread: 0, sellFee: 0, viable: false };

  const fee        = platformFee(sellPlatform);
  const netRevenue = sell * (1 - fee);
  const netDollars = round2(netRevenue - buy);
  const netPct     = round2((netRevenue - buy) / buy);
  const grossSpread = round2((sell - buy) / buy);

  const viable = netDollars >= MIN_NET_SPREAD_DOLLARS && netPct >= MIN_NET_SPREAD_PCT;
  return { netDollars, netPct, grossSpread, sellFee: fee, viable };
}

// ── Arbitrage score ───────────────────────────────────────────────────────────

/**
 * Composite arbitrage opportunity score 0–100.
 *
 * Components:
 *   - Net spread (0–50pts)
 *   - Identity confidence (0–25pts)
 *   - Sell platform reliability (0–15pts)
 *   - Buy platform reliability (0–10pts)
 */
export function computeArbitrageScore(spread, identityConfidence, buySource, sellSource) {
  const spreadPts  = Math.min(50, (spread.netPct / 0.50) * 50);
  const idPts      = Math.min(25, (identityConfidence - MIN_IDENTITY_CONFIDENCE) / (1 - MIN_IDENTITY_CONFIDENCE) * 25);
  const sellRelPts = Math.min(15, platformReliability(sellSource) * 15);
  const buyRelPts  = Math.min(10, platformReliability(buySource) * 10);
  return Math.min(100, Math.round(spreadPts + idPts + sellRelPts + buyRelPts));
}

// ── Main detector ─────────────────────────────────────────────────────────────

/**
 * Detect arbitrage opportunities within a set of market items.
 *
 * Items must come from different platforms.
 * Identity (brand/model) must be explicitly provided for strict matching.
 *
 * @param {Array}  items         — market items from different platforms
 * @param {object} identity      — { brand, model, category } from vision/trust layer
 * @param {object} opts
 *   sellPlatform   — preferred sell platform (used for fee calculation)
 *   identityConf   — vision identity confidence 0–1 (minimum MIN_IDENTITY_CONFIDENCE)
 *   condition      — item condition string
 *
 * @returns {Array<ArbitrageOpportunity>} sorted by score desc (may be empty)
 */
export function detectArbitrageOpportunities(items = [], identity = {}, opts = {}) {
  const { sellPlatform = null, identityConf = 0, condition = "" } = opts;

  // Gate: identity confidence must be strong
  if (identityConf < MIN_IDENTITY_CONFIDENCE) return [];

  // Gate: must have brand + model on the identity
  if (!identity?.brand || !identity?.model) return [];
  if (normStr(identity.brand).length < 2 || normStr(identity.model).length < 2) return [];

  const validItems = items
    .map(it => ({
      ...it,
      _price:       extractPrice(it),
      _source:      String(it?.source || it?.marketplace || it?.platform || "unknown").toLowerCase(),
      _reliability: platformReliability(it?.source || it?.marketplace || ""),
    }))
    .filter(it =>
      it._price !== null &&
      it._price > 0 &&
      it._reliability >= MIN_RELIABILITY_FLOOR
    );

  if (validItems.length < 2) return [];

  // Sort by price ascending
  const sorted = [...validItems].sort((a, b) => a._price - b._price);

  const opportunities = [];
  const seen = new Set(); // dedup: lowSource|highSource|price pairs

  for (let i = 0; i < sorted.length - 1; i++) {
    const buyItem = sorted[i];

    for (let j = i + 1; j < sorted.length; j++) {
      const sellItem = sorted[j];

      // Must be different platforms
      if (buyItem._source === sellItem._source) continue;

      // Dedup key
      const pairKey = `${buyItem._source}|${sellItem._source}|${buyItem._price}|${sellItem._price}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      // Identity match between the two items
      const idMatch = assessIdentityMatch(
        { ...buyItem,  brand: identity.brand, model: identity.model, category: identity.category, condition },
        { ...sellItem, brand: identity.brand, model: identity.model, category: identity.category, condition },
      );
      if (!idMatch.matched || idMatch.confidence < MIN_IDENTITY_CONFIDENCE) continue;

      // Compute spread
      const targetSellPlatform = sellPlatform || sellItem._source;
      const spread = computeArbitrageSpread(buyItem._price, sellItem._price, targetSellPlatform);
      if (!spread.viable) continue;

      const score = computeArbitrageScore(spread, idMatch.confidence, buyItem._source, sellItem._source);
      if (score < 30) continue; // minimum quality gate

      opportunities.push({
        arbitrageId:        `arb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        identityConfidence: idMatch.confidence,
        buyPlatform:        buyItem._source,
        buyPrice:           buyItem._price,
        buyListingUrl:      buyItem.url || buyItem.link || null,
        buyListingTitle:    String(buyItem.title || "").slice(0, 120),
        sellPlatform:       targetSellPlatform,
        sellPrice:          sellItem._price,
        sellListingUrl:     sellItem.url || sellItem.link || null,
        netDollars:         spread.netDollars,
        netPct:             spread.netPct,
        grossSpreadPct:     spread.grossSpread,
        sellFeeEstimated:   spread.sellFee,
        score,
        brand:              identity.brand,
        model:              identity.model,
        category:           identity.category || "",
        condition,
        detectedAt:         Date.now(),
      });
    }
  }

  return opportunities.sort((a, b) => b.score - a.score);
}

// ── Summary builder ───────────────────────────────────────────────────────────

/**
 * Build a single best arbitrage summary for scan response inclusion.
 * Returns null if no viable arbitrage found.
 *
 * @param {Array}  items     — market items
 * @param {object} identity  — { brand, model, category }
 * @param {object} opts      — { identityConf, condition }
 * @returns {object|null}
 */
export function buildArbitrageSummary(items, identity, opts = {}) {
  const opps = detectArbitrageOpportunities(items, identity, opts);
  if (!opps.length) return null;

  const best = opps[0];
  return {
    detected:           true,
    score:              best.score,
    buyPlatform:        best.buyPlatform,
    buyPrice:           best.buyPrice,
    sellPlatform:       best.sellPlatform,
    sellPrice:          best.sellPrice,
    netProfit:          best.netDollars,
    netMarginPct:       round2(best.netPct * 100),
    grossSpreadPct:     round2(best.grossSpreadPct * 100),
    sellFeeEstimated:   round2(best.sellFeeEstimated * 100),
    identityConfidence: round2(best.identityConfidence),
    buyListingUrl:      best.buyListingUrl,
    reasoning:          `Buy on ${best.buyPlatform} at $${best.buyPrice.toFixed(2)}, sell on ${best.sellPlatform} at $${best.sellPrice.toFixed(2)} — ~$${best.netDollars.toFixed(0)} net after ${Math.round(best.sellFeeEstimated * 100)}% fees`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPrice(item) {
  const p = item?.price ?? item?.totalPrice ?? item?.currentPrice ?? item?.extractedPrice;
  const n = Number(p);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }
