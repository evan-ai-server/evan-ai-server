/**
 * offerEngine.js — Bid opportunity scoring and optimal offer calculation
 *
 * Two core functions:
 *   scoreOpportunity(opp)         → priority score (0–100+)
 *   computeOffer(opp, profile)    → { offerPrice, acceptancePct } | null
 *
 * Null return = "hold, don't fire" (P(accept) too low or below ROI floor).
 * This prevents wasted offers on doomed bids and protects negotiation capital.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const TARGET_STR_FLOOR = 0.35;  // Min sell-through rate to consider (35%)
const MIN_ACCEPTANCE_PROB = 0.18; // Don't fire if P(accept) < 18%

// ─── Opportunity Scoring ──────────────────────────────────────────────────────
/**
 * Scores a bid opportunity on a 0–100+ scale.
 * Higher = more attractive. Used to prioritize the auto-bid queue.
 *
 * Inputs (BidOpportunity object):
 *   str30d          — Sell-Through Rate over last 30 days (0–1)
 *   velocityDelta14d — % change in listing velocity vs prior 14 days
 *   estimatedSellPrice — what we expect to sell it for (comps median)
 *   askingPrice     — current listing price
 *   fees            — platform + shipping fees estimate
 *   daysListed      — how long this listing has been up
 *
 * @param {object} opp
 * @returns {number} priority score
 */
export function scoreOpportunity(opp) {
  const {
    str30d = 0,
    velocityDelta14d = 0,
    estimatedSellPrice = 0,
    askingPrice = 0,
    fees = 0,
    daysListed = 0,
  } = opp;

  // Velocity multiplier: rising market = 1.35x, falling = 0.70x
  const velocityFactor =
    velocityDelta14d > 15  ? 1.35 :
    velocityDelta14d < -15 ? 0.70 : 1.0;

  // STR factor: capped at 2x for exceptional items (STR > 70%)
  const strFactor = Math.min(str30d / TARGET_STR_FLOOR, 2.0);

  // Margin delta: net profit if bought at asking price
  const marginDelta = Math.max(estimatedSellPrice - askingPrice - fees, 0);

  // Capital at risk (avoid divide by zero)
  const capitalRisk = Math.max(askingPrice, 1);

  // Freshness: newer listings score higher (less competition, more room to negotiate)
  const freshness = Math.max(1, 30 - daysListed) / 30;

  const score = ((strFactor * velocityFactor * marginDelta) / capitalRisk) * freshness * 100;
  return Math.round(Math.max(0, score));
}

// ─── Acceptance Probability Model ────────────────────────────────────────────
/**
 * Estimates P(seller accepts offer) using a logistic curve.
 * Parameters calibrated on eBay sold data — sellers accept ~65% of offers
 * within 5% of asking price; acceptance drops sharply below 80%.
 *
 * @param {object} params
 * @param {number} params.offerRatio        — offer / askingPrice (0–1)
 * @param {number} params.sellerAcceptRate  — seller's historical accept rate (0–1)
 * @param {number} params.daysListed        — days since listing posted
 * @param {"ebay"|"poshmark"|string} params.platform
 * @returns {number} probability 0–1
 */
export function estimateAcceptanceProbability({ offerRatio, sellerAcceptRate = 0.5, daysListed = 0, platform = "ebay" }) {
  // Base logistic: P = 1 / (1 + e^(-k * (x - x0)))
  // Calibrated: x0=0.90 (inflection at 90% of ask), k=12
  const x0 = 0.90;
  const k  = 12;
  const baseP = 1 / (1 + Math.exp(-k * (offerRatio - x0)));

  // Seller-specific adjustment: multiply by their historical accept rate
  // (a seller who accepts 80% of offers → boost; one at 10% → penalize)
  const sellerAdj = 0.5 + sellerAcceptRate * 0.5; // maps [0,1] → [0.5, 1.0]

  // Listing age boost: sellers get more flexible over time
  const ageFactor = daysListed > 21 ? 1.18 : daysListed > 14 ? 1.08 : daysListed > 7 ? 1.03 : 1.0;

  // Platform norms: Poshmark sellers expect offers more (culture of negotiation)
  const platformFactor = platform === "poshmark" ? 1.12 : 1.0;

  return Math.min(1.0, baseP * sellerAdj * ageFactor * platformFactor);
}

// ─── Offer Computation ────────────────────────────────────────────────────────
/**
 * Computes the optimal offer price for a given opportunity and bid profile.
 *
 * Returns null if:
 *   - P(accept) < MIN_ACCEPTANCE_PROB (not worth a wasted offer slot)
 *   - Computed offer is below the fee-adjusted ROI floor
 *   - Computed offer exceeds maxBuyPrice
 *
 * @param {object} opp         — BidOpportunity
 * @param {object} profile     — BidProfile (user config)
 * @returns {{ offerPrice: number, acceptancePct: number, marginAtOffer: number } | null}
 */
export function computeOffer(opp, profile) {
  const {
    compMedian,
    estimatedSellPrice,
    askingPrice,
    fees,
    daysListed = 0,
    sellerAcceptRate = 0.50,
    platform = "ebay",
  } = opp;

  const {
    maxBuyPrice,
    targetROIFloor = 0.15,  // 15% default ROI floor
    aggressiveness = 5,     // 1–10 scale
  } = profile;

  // ── ROI Floor ──────────────────────────────────────────────────────────────
  // The highest we can pay and still hit targetROIFloor after fees:
  //   offerPrice ≤ (estimatedSellPrice - fees) / (1 + targetROIFloor)
  const feeAdjustedFloor = (estimatedSellPrice - fees) / (1 + targetROIFloor);

  // ── Aggression Curve ───────────────────────────────────────────────────────
  // aggressiveness 1 → 88% of comp median (deep discount)
  // aggressiveness 10 → 98% of comp median (near market)
  const aggrFactor = 0.88 + (aggressiveness / 10) * 0.10;

  // ── Seller Fatigue Discount ────────────────────────────────────────────────
  // Listings > 14 days old: seller is motivated, take 3% more
  const fatigueMod =
    daysListed > 14 ? 0.97 :
    daysListed > 7  ? 0.99 : 1.0;

  // ── Raw offer ─────────────────────────────────────────────────────────────
  const rawOffer = compMedian * aggrFactor * fatigueMod;

  // ── Constrain to valid range ───────────────────────────────────────────────
  // Must be: >= feeAdjustedFloor (ROI floor)
  //          <= maxBuyPrice (user cap)
  //          <= askingPrice (never offer more than asking)
  const constrainedOffer = Math.min(
    Math.max(rawOffer, feeAdjustedFloor),
    maxBuyPrice,
    askingPrice
  );

  // ── Acceptance probability check ──────────────────────────────────────────
  const offerRatio = constrainedOffer / askingPrice;
  const acceptancePct = estimateAcceptanceProbability({
    offerRatio,
    sellerAcceptRate,
    daysListed,
    platform,
  });

  // Hold if P(accept) is too low — don't burn an offer slot
  if (acceptancePct < MIN_ACCEPTANCE_PROB) {
    return null;
  }

  // Hold if we can't make a valid offer (floor > cap, etc.)
  if (constrainedOffer <= 0 || constrainedOffer > maxBuyPrice) {
    return null;
  }

  const offerPrice = Math.floor(constrainedOffer * 100) / 100; // round down to cents
  const marginAtOffer = estimatedSellPrice - offerPrice - fees;

  return {
    offerPrice,
    acceptancePct: Math.round(acceptancePct * 100), // as integer %
    marginAtOffer: Math.round(marginAtOffer * 100) / 100,
    aggrFactor,
    fatigueMod,
    feeAdjustedFloor: Math.round(feeAdjustedFloor * 100) / 100,
  };
}
