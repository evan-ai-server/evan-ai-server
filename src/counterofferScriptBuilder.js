// src/counterofferScriptBuilder.js
// Counteroffer Script Builder: multi-round negotiation scripts with exact
// dollar amounts, psychology-backed framing, and a walk-away line.
// Uses anchoring, loss aversion, urgency, and social proof tactics.
// "Round 1: $185. Round 2: $195. Walk away: $210. Here's what to say."

// ── Strategy matrix ────────────────────────────────────────────────────────────
// Maps seller motivation tier to negotiation aggression
const STRATEGY_BY_MOTIVATION = {
  high:     { openingDiscount: 0.22, maxDiscount: 0.15, roundCount: 3, tactic: "aggressive_anchor" },
  moderate: { openingDiscount: 0.15, maxDiscount: 0.10, roundCount: 2, tactic: "soft_anchor" },
  low:      { openingDiscount: 0.08, maxDiscount: 0.05, roundCount: 2, tactic: "compliment_close" },
  unknown:  { openingDiscount: 0.12, maxDiscount: 0.08, roundCount: 2, tactic: "soft_anchor" },
};

// ── Condition damage talking points ───────────────────────────────────────────
const DAMAGE_TALKING_POINTS = {
  "Toe box creasing":          "I noticed the toe box has some creasing",
  "Sole yellowing / oxidation":"The soles show oxidation",
  "Cracked screen":            "There's a cracked screen",
  "Staining / discoloration":  "I can see some staining",
  "Sole cracking":             "The sole has cracking",
  "Corner wear":               "The corners show wear",
  "Hardware tarnishing":       "The hardware is tarnished",
  "Heavy overall wear":        "There's heavy overall wear",
  "Water damage":              "I noticed water damage indicators",
};

// ── Tactic scripts ────────────────────────────────────────────────────────────
const TACTIC_OPENERS = {
  aggressive_anchor: [
    "I've done my research on current market prices and I have to be honest with you —",
    "I'm genuinely interested but I need to be transparent about the comps I'm seeing —",
  ],
  soft_anchor: [
    "I really like this item and I'd love to make it work —",
    "This is exactly what I'm looking for, I just want to make sure the numbers work —",
  ],
  compliment_close: [
    "This is a great listing — photos are excellent —",
    "Looks well cared for, I appreciate the detail in the listing —",
  ],
};

const URGENCY_LINES = [
  "I can pay today via PayPal if we can agree.",
  "I'm ready to buy right now if we can make this work.",
  "I'm looking at a couple of options — yours is my first choice if the price works.",
];

const WALK_AWAY_LINES = [
  "I appreciate your time, but I'm going to have to pass at that price. If anything changes, please feel free to reach out.",
  "Totally understand — this one just doesn't work at that number for me. Good luck with the sale.",
  "Thanks for considering. I'll have to move on, but I hope it sells fast.",
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Build a single negotiation round message.
 */
function buildRoundMessage({
  round          = 1,
  offerPrice     = null,
  askPrice       = null,
  tactic         = "soft_anchor",
  conditionPoints = [],
  isLastRound    = false,
} = {}) {
  const opener = TACTIC_OPENERS[tactic]?.[round === 1 ? 0 : 1] || TACTIC_OPENERS.soft_anchor[0];
  const urgency = URGENCY_LINES[round - 1] || URGENCY_LINES[0];

  const condLine = conditionPoints.length > 0
    ? ` ${conditionPoints.slice(0, 2).join(" and ")} which does affect the value.`
    : "";

  if (round === 1) {
    return `${opener} comparable items are selling for around $${offerPrice?.toFixed(2)}.${condLine} Would you consider $${offerPrice?.toFixed(2)}? ${urgency}`;
  }

  if (isLastRound) {
    return `I understand you need more, and I want to make this work. My absolute best is $${offerPrice?.toFixed(2)}. ${urgency} That's genuinely the most I can do.`;
  }

  return `I appreciate the counter — I can come up to $${offerPrice?.toFixed(2)}. That's a fair number based on current comps. ${urgency}`;
}

/**
 * Build the full multi-round negotiation script.
 */
export function buildCounteroffer({
  askPrice         = null,
  marketMedian     = null,
  sellerMotivation = "unknown",  // high / moderate / low / unknown
  conditionForensics = null,
  dealVerdict      = "fair",
} = {}) {
  const ask    = finiteOrNull(askPrice) || finiteOrNull(marketMedian);
  if (!ask) return null;

  const market = finiteOrNull(marketMedian) || ask;
  const strategy = STRATEGY_BY_MOTIVATION[sellerMotivation] || STRATEGY_BY_MOTIVATION.unknown;

  // Opening offer: our anchor
  const openingOffer = round2(market * (1 - strategy.openingDiscount));

  // Max we'll pay: target price
  const maxOffer = round2(market * (1 - strategy.maxDiscount));

  // Walk-away: if they won't come below this, leave
  const walkAwayPrice = round2(market * 1.02); // 2% above market = walk away

  // Intermediate round (if 3 rounds)
  const midOffer = round2((openingOffer + maxOffer) / 2);

  // Condition damage talking points
  const detections = conditionForensics?.detections || [];
  const condPoints = detections
    .slice(0, 2)
    .map(d => DAMAGE_TALKING_POINTS[d.label] || `the ${d.label.toLowerCase()}`);

  const rounds = [];

  // Round 1: opening anchor
  rounds.push({
    round:    1,
    offer:    openingOffer,
    message:  buildRoundMessage({ round: 1, offerPrice: openingOffer, askPrice: ask, tactic: strategy.tactic, conditionPoints: condPoints }),
    label:    "Opening Offer",
  });

  // Round 2: step up (only if 3 rounds)
  if (strategy.roundCount >= 3) {
    rounds.push({
      round:   2,
      offer:   midOffer,
      message: buildRoundMessage({ round: 2, offerPrice: midOffer, askPrice: ask, tactic: strategy.tactic }),
      label:   "Counter",
    });
  }

  // Final round: best offer
  rounds.push({
    round:       strategy.roundCount,
    offer:       maxOffer,
    message:     buildRoundMessage({ round: strategy.roundCount, offerPrice: maxOffer, askPrice: ask, tactic: strategy.tactic, isLastRound: true }),
    label:       "Best & Final",
  });

  const walkAwayMessage = WALK_AWAY_LINES[0];

  // Total potential savings
  const savings = round2(ask - maxOffer);

  return {
    askPrice:       ask,
    marketMedian:   market,
    openingOffer,
    maxOffer,
    walkAwayPrice,
    rounds,
    walkAway: {
      price:   walkAwayPrice,
      message: walkAwayMessage,
    },
    savings,
    savingsPct:  round2((savings / ask) * 100),
    strategy:    strategy.tactic,
    topSignal: `Open at $${openingOffer.toFixed(2)} — max $${maxOffer.toFixed(2)} — walk away above $${walkAwayPrice.toFixed(2)} (saves ~$${savings.toFixed(2)})`,
  };
}

/**
 * Master counteroffer script payload.
 */
export function buildCounteroferScriptPayload({
  scannedPrice     = null,
  medianMarket     = null,
  dealVerdict      = "fair",
  negotiationIntel = null,
  conditionForensics = null,
} = {}) {
  const sellerMotivation = negotiationIntel?.sellerMotivation?.tier || "unknown";
  const script = buildCounteroffer({
    askPrice:          finiteOrNull(scannedPrice),
    marketMedian:      finiteOrNull(medianMarket),
    sellerMotivation,
    conditionForensics,
    dealVerdict,
  });

  return {
    script:     script || null,
    topSignal:  script?.topSignal || null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function round2(v) { return Math.round(v * 100) / 100; }
