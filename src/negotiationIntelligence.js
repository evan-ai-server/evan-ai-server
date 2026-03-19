// src/negotiationIntelligence.js
// Negotiation coach: optimal offer amount, counter-offer script,
// seller motivation signals, and walk-away price calculator.

// ── Negotiation strategy matrix ───────────────────────────────────────────────
// Based on deal verdict tier → offer aggressiveness
const STRATEGY_BY_VERDICT = {
  steal: {
    offerMultiplier:   1.00, // pay asking — it's already a steal
    aggressiveness:    "none",
    rationale:         "Price is already at or below market — don't lowball and risk losing it",
    openingScript:     "I'll take it at your asking price.",
    counterScript:     null,
  },
  good_deal: {
    offerMultiplier:   0.95,
    aggressiveness:    "light",
    rationale:         "Good deal — a small ask is reasonable but don't push hard",
    openingScript:     "Would you take [OFFER]? It's close to your ask but works for me.",
    counterScript:     "I appreciate it — closest I can go is [COUNTER].",
  },
  fair: {
    offerMultiplier:   0.90,
    aggressiveness:    "moderate",
    rationale:         "At market — 10% off is a reasonable opening",
    openingScript:     "I'm interested — would you consider [OFFER]? That's my best offer.",
    counterScript:     "I can do [COUNTER] and that's my walk-away.",
  },
  overpriced: {
    offerMultiplier:   0.82,
    aggressiveness:    "firm",
    rationale:         "Priced above market — lead with market data, offer 18% below ask",
    openingScript:     "I've seen comparable [ITEM] selling for [MARKET] — would you do [OFFER]?",
    counterScript:     "Based on recent comps, [COUNTER] is fair. Happy to share the data.",
  },
  price_trap: {
    offerMultiplier:   0.72,
    aggressiveness:    "aggressive",
    rationale:         "Significantly overpriced — make a bold offer anchored to market reality",
    openingScript:     "This is listed well above current market ($[MARKET]) — I can offer [OFFER].",
    counterScript:     "Market is showing $[MARKET] for this condition. [COUNTER] is my final offer.",
  },
};

// Seller motivation modifiers (additional negotiation room)
const DAYS_LISTED_DISCOUNT = [
  { days: 0,   discount: 0.00 },
  { days: 7,   discount: 0.02 }, // 1 week = slight motivation
  { days: 14,  discount: 0.04 },
  { days: 21,  discount: 0.06 },
  { days: 30,  discount: 0.08 }, // 1 month = motivated seller
  { days: 60,  discount: 0.12 }, // 2 months = very motivated
  { days: 90,  discount: 0.16 }, // 3+ months = must sell
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Score seller motivation from available listing signals.
 * Higher = more motivated seller = more negotiating room.
 */
export function scoreSellerMotivation({
  daysListed       = null,
  hasPriceDrops    = false,
  hasMultipleItems = false,
  isBestOffer      = false,
  isAuction        = false,
} = {}) {
  let motivation = 0.20; // baseline

  // Days listed
  const days = finiteOrNull(daysListed) ?? 0;
  const dayEntry = [...DAYS_LISTED_DISCOUNT]
    .reverse()
    .find(e => days >= e.days);
  motivation += dayEntry?.discount ?? 0;

  // Signals
  if (hasPriceDrops)    motivation += 0.12; // already reduced = trying to sell
  if (isBestOffer)      motivation += 0.08; // "best offer" = open to negotiation
  if (hasMultipleItems) motivation += 0.06; // selling in bulk = motivated to clear
  if (isAuction)        motivation += 0.05; // auctions resolve at market

  motivation = Math.min(0.95, motivation);

  const tier = motivation >= 0.70 ? "very_motivated"
             : motivation >= 0.50 ? "motivated"
             : motivation >= 0.30 ? "mildly_motivated"
             : "firm";

  return {
    motivationScore: round2(motivation),
    tier,
    daysListed:      days || null,
    hasPriceDrops,
    isBestOffer,
    signal: tier === "very_motivated"
      ? `Seller is very motivated — ${days > 0 ? `listed ${days} days ago` : "showing multiple motivation signals"} — push hard`
      : tier === "motivated"
      ? "Seller appears motivated — moderate offer is appropriate"
      : tier === "firm"
      ? "Seller appears firm — don't open too low or you'll lose them"
      : null,
  };
}

/**
 * Compute the optimal offer amount.
 */
export function computeOptimalOffer({
  listingPrice     = null,
  marketMedian     = null,
  dealVerdict      = "fair",
  sellerMotivation = null,
  conditionAdjusted = null,
} = {}) {
  const listed  = finiteOrNull(listingPrice);
  const market  = finiteOrNull(marketMedian) || listed;
  if (!listed && !market) return null;

  const basePrice  = listed || market;
  const strategy   = STRATEGY_BY_VERDICT[dealVerdict] || STRATEGY_BY_VERDICT.fair;

  // Base offer from strategy
  let offerMultiplier = strategy.offerMultiplier;

  // Adjust for seller motivation (more room if motivated)
  const motivationBonus = sellerMotivation?.motivationScore
    ? (sellerMotivation.motivationScore - 0.20) * 0.15
    : 0;
  offerMultiplier = Math.max(0.60, offerMultiplier - motivationBonus);

  // Use condition-adjusted price if available as floor
  const condFloor = finiteOrNull(conditionAdjusted?.adjustedPrice);

  const openingOffer   = round2(basePrice * offerMultiplier);
  const counterOffer   = round2(basePrice * Math.min(offerMultiplier + 0.05, 1.00));
  const walkAwayAbove  = condFloor
    ? round2(Math.max(condFloor * 1.05, basePrice * 0.92))
    : round2(basePrice * 0.92);

  return {
    dealVerdict,
    openingOffer,
    counterOffer,
    walkAwayAbove,
    offerMultiplier:   round2(offerMultiplier),
    offerVsListed:     listed ? round2(((openingOffer - listed)  / listed)  * 100) : null,
    offerVsMarket:     market ? round2(((openingOffer - market)  / market)  * 100) : null,
    aggressiveness:    strategy.aggressiveness,
    rationale:         strategy.rationale,
  };
}

/**
 * Generate a ready-to-use negotiation script.
 */
export function buildNegotiationScript({
  listingPrice     = null,
  marketMedian     = null,
  dealVerdict      = "fair",
  identity         = {},
  sellerMotivation = null,
  offerResult      = null,
} = {}) {
  const offer    = offerResult || computeOptimalOffer({ listingPrice, marketMedian, dealVerdict, sellerMotivation });
  if (!offer) return null;

  const strategy  = STRATEGY_BY_VERDICT[dealVerdict] || STRATEGY_BY_VERDICT.fair;
  const itemLabel = [identity?.brand, identity?.model].filter(Boolean).join(" ") || "this item";
  const market    = finiteOrNull(marketMedian);

  const fill = (template) =>
    (template || "")
      .replace(/\[OFFER\]/g,   `$${offer.openingOffer.toFixed(2)}`)
      .replace(/\[COUNTER\]/g, `$${offer.counterOffer.toFixed(2)}`)
      .replace(/\[MARKET\]/g,  market ? `$${round2(market).toFixed(2)}` : "market price")
      .replace(/\[ITEM\]/g,    itemLabel);

  return {
    openingLine:  fill(strategy.openingScript),
    counterLine:  strategy.counterScript ? fill(strategy.counterScript) : null,
    walkAwayLine: `Walk away if they won't go below $${offer.walkAwayAbove.toFixed(2)}.`,
    tips: buildNegotiationTips(dealVerdict, sellerMotivation),
  };
}

function buildNegotiationTips(verdict, sellerMotivation) {
  const tips = [];
  if (verdict === "price_trap" || verdict === "overpriced") {
    tips.push("Lead with market data — show comps to anchor the conversation");
    tips.push("Don't apologize for the offer — state it confidently");
  }
  if (sellerMotivation?.hasPriceDrops) {
    tips.push("Seller has already dropped the price — they're flexible, push further");
  }
  if (sellerMotivation?.isBestOffer) {
    tips.push('"Best Offer" listed — always send an offer, the seller expects it');
  }
  if (sellerMotivation?.tier === "very_motivated") {
    tips.push("Long-listed item — seller needs to move it. Use time as leverage.");
  }
  if (verdict === "steal") {
    tips.push("Don't lowball a steal — you'll lose it to another buyer");
  }
  return tips;
}

/**
 * Master negotiation intelligence payload.
 */
export function buildNegotiationIntelPayload({
  listingPrice      = null,
  marketMedian      = null,
  dealVerdict       = "fair",
  identity          = {},
  daysListed        = null,
  hasPriceDrops     = false,
  isBestOffer       = false,
  hasMultipleItems  = false,
  conditionAdjusted = null,
} = {}) {
  const sellerMotivation = scoreSellerMotivation({
    daysListed, hasPriceDrops, isBestOffer, hasMultipleItems,
  });

  const offer  = computeOptimalOffer({
    listingPrice,
    marketMedian,
    dealVerdict,
    sellerMotivation,
    conditionAdjusted,
  });

  const script = buildNegotiationScript({
    listingPrice,
    marketMedian,
    dealVerdict,
    identity,
    sellerMotivation,
    offerResult: offer,
  });

  return {
    sellerMotivation,
    offer:  offer  || null,
    script: script || null,
    topSignal: offer
      ? `Open at $${offer.openingOffer.toFixed(2)}, walk away above $${offer.walkAwayAbove.toFixed(2)}`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
