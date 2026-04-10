// src/payloadRegistry.js
// Phase 10 — Payload Specialization Registry.
//
// Each Specialist worker is "equipped" with an Expert Logic Module based on the
// item category identified by Scout. The Orchestrator hot-swaps the payload so
// a Rolex evaluator never runs the same algorithm as a pallet of power tools.
//
// ── Payload Roster ────────────────────────────────────────────────────────────
//
//   VINTAGE_ELECTRONICS   — Component condition, rarity, Parts vs Refurb delta
//   DESIGNER_APPAREL      — Auth markers, seasonal curves, MSRP/resale delta
//   BULK_LIQUIDATED       — APU floor, volume velocity, unknown-item penalty
//   GENERIC               — Fallback — category-agnostic baseline
//
// ── Alpha Signal Filter ───────────────────────────────────────────────────────
//
//   Any item with projected ROI > ALPHA_ROI_THRESHOLD (200%) is flagged as
//   ALPHA_CANDIDATE. The Orchestrator must route it to a Validator Specialist
//   before any capital is committed or ledger entry is written.
//
// ── Category Multiplier ───────────────────────────────────────────────────────
//
//   Each payload publishes a categoryMultiplier used by lotDistributionEngine
//   to weigh the cost-basis allocation heavier toward high-demand verticals.

// ── Payload IDs ───────────────────────────────────────────────────────────────

export const PAYLOAD_ID = Object.freeze({
  VINTAGE_ELECTRONICS: "VINTAGE_ELECTRONICS",
  DESIGNER_APPAREL:    "DESIGNER_APPAREL",
  BULK_LIQUIDATED:     "BULK_LIQUIDATED",
  GENERIC:             "GENERIC",
});

// Alpha threshold — items with projected ROI above this require Validator
export const ALPHA_ROI_THRESHOLD = 200;  // percent

// Validator confidence floor is stricter than the base 65% floor
export const VALIDATOR_CONFIDENCE_FLOOR = 75;

// ── Payload Definitions ───────────────────────────────────────────────────────

const PAYLOADS = {

  // ── Payload A: Vintage Electronics ─────────────────────────────────────────
  [PAYLOAD_ID.VINTAGE_ELECTRONICS]: {
    id:                  PAYLOAD_ID.VINTAGE_ELECTRONICS,
    label:               "Vintage Electronics Expert",
    categoryMultiplier:  1.35,   // High-margin niche — weight cost-basis heavier
    alphaROIThreshold:   ALPHA_ROI_THRESHOLD,

    // Category pattern matching
    categoryPatterns: [
      /electron/i, /camera/i, /audio/i, /synthesizer/i, /synth/i,
      /console/i, /calculator/i, /computer/i, /vintage.*tech/i,
      /amplifier/i, /turntable/i, /receiver/i, /vcr/i, /game/i,
    ],
    namePatterns: [
      /apple/i, /sony/i, /leica/i, /polaroid/i, /canon/i, /nikon/i,
      /gameboy/i, /walkman/i, /macintosh/i, /commodore/i, /atari/i,
      /roland/i, /moog/i, /yamaha.*dx/i,
    ],

    // Condition signal patterns → value multipliers
    conditionSignals: [
      { pattern: /parts?\s*only|for\s*parts/i,            multiplier: 0.35, label: "PARTS_ONLY"       },
      { pattern: /untested/i,                             multiplier: 0.70, label: "UNTESTED"         },
      { pattern: /refurb/i,                               multiplier: 1.20, label: "REFURBISHED"      },
      { pattern: /refurb.*(test|work)/i,                  multiplier: 1.40, label: "REFURB_TESTED"    },
      { pattern: /test.*work|works?\s*great|fully\s*func/i,multiplier:1.15, label: "TESTED_WORKING"   },
      { pattern: /mint|like\s*new|sealed/i,               multiplier: 1.25, label: "MINT"             },
      { pattern: /original.*box|complete\s*in\s*box|cib/i,multiplier: 1.30, label: "COMPLETE_IN_BOX"  },
    ],

    // Pre-1990 items get a rarity premium
    rarityYearCutoff: 1990,
    rarityMultiplier: 1.10,

    // Signal upgrade rules: if condition multiplier >= threshold, upgrade signal
    signalUpgradeThreshold: 1.20,   // multiplier ≥ 1.20 → try to upgrade signal
    signalDowngradeThreshold: 0.60, // multiplier < 0.60 → downgrade signal
  },

  // ── Payload B: Designer Apparel ─────────────────────────────────────────────
  [PAYLOAD_ID.DESIGNER_APPAREL]: {
    id:                  PAYLOAD_ID.DESIGNER_APPAREL,
    label:               "Designer Apparel Expert",
    categoryMultiplier:  1.45,   // Highest margin category — authentication gate
    alphaROIThreshold:   ALPHA_ROI_THRESHOLD,

    categoryPatterns: [
      /apparel/i, /cloth/i, /shoe/i, /sneaker/i, /handbag/i, /bag/i,
      /accessory/i, /watch/i, /jewelry/i, /jewellery/i, /designer/i,
      /fashion/i, /luxury/i,
    ],
    namePatterns: [
      /supreme/i, /louis\s*vuitton|lv/i, /gucci/i, /chanel/i, /prada/i,
      /hermes/i, /burberry/i, /balenciaga/i, /off.white/i, /yeezy/i,
      /jordan/i, /dunk/i, /travis\s*scott/i, /fragment/i,
      /rolex/i, /omega/i, /patek/i, /ap\b|audemars/i,
    ],

    // Authentication markers → confidence + value boost
    authMarkers: [
      { pattern: /receipt|invoice/i,       boost: 0.12, label: "RECEIPT"        },
      { pattern: /dust\s*bag/i,            boost: 0.08, label: "DUST_BAG"       },
      { pattern: /box|original.*box/i,     boost: 0.08, label: "BOX"            },
      { pattern: /serial|serial\s*number/i,boost: 0.10, label: "SERIAL"         },
      { pattern: /tag|hang\s*tag|nwt/i,    boost: 0.10, label: "TAGS"           },
      { pattern: /card|auth.*card/i,       boost: 0.07, label: "AUTH_CARD"      },
    ],
    missingAuthPenalty: -0.20,   // If zero auth markers detected, apply this to value

    // Condition grading → value multipliers
    conditionGrades: [
      { pattern: /deadstock|ds\b|brand\s*new|unworn|nwt/i, multiplier: 1.30 },
      { pattern: /excellent|like\s*new|vnds/i,              multiplier: 1.10 },
      { pattern: /good|gently\s*used/i,                     multiplier: 1.00 },
      { pattern: /fair|worn|used/i,                         multiplier: 0.75 },
      { pattern: /poor|damaged|flaw/i,                      multiplier: 0.50 },
    ],

    // Seasonal demand — month index (0=Jan) → multiplier
    // Winter outerwear peaks Oct–Jan; swimwear peaks Apr–Jul; sneakers flat
    seasonalMultipliers: {
      // coat/jacket/outerwear
      outerwear: [1.20, 1.10, 0.90, 0.70, 0.60, 0.60, 0.60, 0.70, 0.90, 1.10, 1.20, 1.20],
      // sneakers: relatively flat with slight summer peak
      sneakers:  [1.00, 1.00, 1.05, 1.05, 1.10, 1.10, 1.10, 1.05, 1.00, 1.00, 1.00, 1.00],
    },
    seasonalPatterns: {
      outerwear: /coat|jacket|parka|puffer|fleece|outerwear/i,
    },

    // MSRP comparison — if item is < 30% of MSRP it's a STRONG_BUY candidate
    msrpBuyThresholdPct: 0.30,

    signalUpgradeThreshold:   1.25,
    signalDowngradeThreshold: 0.60,
  },

  // ── Payload C: Bulk Liquidated Lots ─────────────────────────────────────────
  [PAYLOAD_ID.BULK_LIQUIDATED]: {
    id:                  PAYLOAD_ID.BULK_LIQUIDATED,
    label:               "Bulk Liquidation Expert",
    categoryMultiplier:  1.10,   // Volume play — lower per-unit margin, higher velocity
    alphaROIThreshold:   ALPHA_ROI_THRESHOLD,

    categoryPatterns: [
      /lot/i, /bulk/i, /liquidat/i, /pallet/i, /wholesale/i,
      /assorted/i, /misc/i, /mixed/i,
    ],
    namePatterns: [
      /amazon\s*returns?/i, /overstock/i, /shelf\s*pull/i,
      /customer\s*return/i, /b\s*stock/i,
    ],

    // APU (average price per unit) floor — don't buy if APU > this fraction of comps
    apuFloorFraction: 0.60,   // pay no more than 60% of average comp per unit

    // Velocity threshold — items that sell in < 14 days score higher
    velocityDaysThreshold: 14,
    velocityBoost: 1.15,

    // Penalize lots with high unknown/untested fraction
    unknownPenaltyThreshold: 0.30,  // > 30% unknown items → apply penalty
    unknownPenaltyMultiplier: 0.80,

    // Floor protection: minimum projected margin to proceed
    minProjectedMarginPct: 0.20,    // need ≥20% gross margin

    signalUpgradeThreshold:   1.10,
    signalDowngradeThreshold: 0.75,
  },

  // ── Generic fallback ────────────────────────────────────────────────────────
  [PAYLOAD_ID.GENERIC]: {
    id:                  PAYLOAD_ID.GENERIC,
    label:               "General Appraiser",
    categoryMultiplier:  1.00,
    alphaROIThreshold:   ALPHA_ROI_THRESHOLD,
    categoryPatterns:    [],
    namePatterns:        [],
    signalUpgradeThreshold:   1.20,
    signalDowngradeThreshold: 0.60,
  },
};

// ── Category Router ───────────────────────────────────────────────────────────

/**
 * Route an item to its Expert Logic Module based on category + item name.
 * Returns the full payload object (never null — falls back to GENERIC).
 *
 * @param {string} category
 * @param {string} itemName
 * @returns {PayloadDefinition}
 */
export function resolvePayload(category = "", itemName = "") {
  const cat  = String(category  || "").toLowerCase();
  const name = String(itemName  || "").toLowerCase();

  // Priority order: DESIGNER_APPAREL > VINTAGE_ELECTRONICS > BULK_LIQUIDATED > GENERIC
  const priority = [
    PAYLOAD_ID.DESIGNER_APPAREL,
    PAYLOAD_ID.VINTAGE_ELECTRONICS,
    PAYLOAD_ID.BULK_LIQUIDATED,
  ];

  for (const payloadId of priority) {
    const payload = PAYLOADS[payloadId];
    const catMatch  = payload.categoryPatterns.some(p => p.test(cat));
    const nameMatch = payload.namePatterns.some(p => p.test(name));
    if (catMatch || nameMatch) return payload;
  }

  return PAYLOADS[PAYLOAD_ID.GENERIC];
}

/**
 * Get the category cost-basis multiplier for a given category + item name.
 * Used by lotDistributionEngine to weight allocations toward high-margin verticals.
 *
 * @param {string} category
 * @param {string} itemName
 * @returns {number}
 */
export function getCategoryMultiplier(category, itemName) {
  return resolvePayload(category, itemName).categoryMultiplier;
}

// ── Payload Valuation Engine ──────────────────────────────────────────────────

/**
 * Apply Expert Logic Module rules to produce a payload-adjusted valuation.
 *
 * @param {object} payload     Resolved payload from resolvePayload()
 * @param {object} item        Item record (has category, itemName, conditionNotes, flags, msrp, etc.)
 * @param {string} baseSignal  BUY_SIGNAL value from _deriveBuySignal()
 * @param {number} allocatedCost
 * @returns {{ adjustedSignal, adjustedValue, payloadMultiplier, authScore, reasoning[] }}
 */
export function applyPayloadValuation(payload, item, baseSignal, allocatedCost = 0) {
  const reasoning = [];
  let multiplier  = 1.0;
  let authScore   = 1.0;   // 1.0 = neutral, >1 = confidence boost, <1 = penalty

  const conditionText = [
    item.conditionNotes || "",
    item.itemName       || "",
    (item.flags || []).join(" "),
  ].join(" ");

  const estimatedValue = Number(item.estimatedValue || item.estimatedCost || 0);

  switch (payload.id) {

    // ── Vintage Electronics logic ──────────────────────────────────────────
    case PAYLOAD_ID.VINTAGE_ELECTRONICS: {
      // Check condition signals
      let condMult = 1.0;
      let condLabel = null;
      for (const sig of payload.conditionSignals) {
        if (sig.pattern.test(conditionText)) {
          condMult  = sig.multiplier;
          condLabel = sig.label;
          break; // first match wins (ordered by priority)
        }
      }
      if (condLabel) {
        multiplier *= condMult;
        reasoning.push(`condition=${condLabel} → ×${condMult}`);
      }

      // Rarity: check if item might be pre-cutoff vintage
      const yearMatch = conditionText.match(/\b(19\d{2})\b/);
      if (yearMatch) {
        const year = Number(yearMatch[1]);
        if (year < payload.rarityYearCutoff) {
          multiplier *= payload.rarityMultiplier;
          reasoning.push(`vintage_${year} → rarity ×${payload.rarityMultiplier}`);
        }
      }

      // Brand name detection in item name
      for (const p of payload.namePatterns) {
        if (p.test(item.itemName || "")) {
          multiplier *= 1.05;  // premium brand recognition
          reasoning.push(`brand_premium ×1.05`);
          break;
        }
      }
      break;
    }

    // ── Designer Apparel logic ─────────────────────────────────────────────
    case PAYLOAD_ID.DESIGNER_APPAREL: {
      // Authentication scoring
      let authBoost = 0;
      const foundMarkers = [];
      for (const marker of payload.authMarkers) {
        if (marker.pattern.test(conditionText)) {
          authBoost += marker.boost;
          foundMarkers.push(marker.label);
        }
      }
      if (foundMarkers.length > 0) {
        authScore += authBoost;
        reasoning.push(`auth_markers=[${foundMarkers.join(",")}] → score +${r2(authBoost * 100)}%`);
      } else {
        authScore += payload.missingAuthPenalty;
        reasoning.push(`no_auth_markers → score ${payload.missingAuthPenalty * 100}%`);
      }
      multiplier *= Math.max(0.1, authScore);

      // Condition grade
      for (const grade of payload.conditionGrades) {
        if (grade.pattern.test(conditionText)) {
          multiplier *= grade.multiplier;
          reasoning.push(`condition_grade ×${grade.multiplier}`);
          break;
        }
      }

      // Seasonal demand
      const currentMonth = new Date().getMonth();
      if (payload.seasonalPatterns.outerwear.test(conditionText)) {
        const seasonal = payload.seasonalMultipliers.outerwear[currentMonth];
        multiplier *= seasonal;
        reasoning.push(`seasonal_outerwear[month=${currentMonth}] ×${seasonal}`);
      } else if (/sneak|jordan|dunk|shoe/i.test(conditionText)) {
        const seasonal = payload.seasonalMultipliers.sneakers[currentMonth];
        multiplier *= seasonal;
        reasoning.push(`seasonal_sneaker[month=${currentMonth}] ×${seasonal}`);
      }

      // MSRP check
      const msrp = Number(item.msrp || 0);
      if (msrp > 0 && allocatedCost > 0) {
        const pctOfMsrp = allocatedCost / msrp;
        if (pctOfMsrp < payload.msrpBuyThresholdPct) {
          reasoning.push(`msrp_delta: cost ${r2(pctOfMsrp * 100)}% of MSRP — strong_buy_candidate`);
          multiplier *= 1.15;  // MSRP deep discount is strong signal
        }
      }
      break;
    }

    // ── Bulk Liquidated logic ──────────────────────────────────────────────
    case PAYLOAD_ID.BULK_LIQUIDATED: {
      // APU floor check
      const itemCount = Number(item.itemCount || item.quantity || 1);
      const apu       = allocatedCost / itemCount;
      const compApu   = estimatedValue > 0 ? estimatedValue / itemCount : 0;

      if (compApu > 0) {
        const apuRatio = apu / compApu;
        if (apuRatio > payload.apuFloorFraction) {
          const penalty = 1 - ((apuRatio - payload.apuFloorFraction) * 0.5);
          multiplier *= Math.max(0.5, penalty);
          reasoning.push(`apu_floor_breach: paying ${r2(apuRatio * 100)}% of comp APU → ×${r2(Math.max(0.5, penalty))}`);
        } else {
          reasoning.push(`apu_ok: ${r2(apuRatio * 100)}% of comp APU`);
        }
      }

      // Unknown item penalty
      const unknownFraction = Number(item.unknownFraction || 0);
      if (unknownFraction > payload.unknownPenaltyThreshold) {
        multiplier *= payload.unknownPenaltyMultiplier;
        reasoning.push(`high_unknown_fraction=${r2(unknownFraction * 100)}% → ×${payload.unknownPenaltyMultiplier}`);
      }

      // Velocity boost — items with fast sell history
      const avgDaysToSell = Number(item.avgDaysToSell || 0);
      if (avgDaysToSell > 0 && avgDaysToSell < payload.velocityDaysThreshold) {
        multiplier *= payload.velocityBoost;
        reasoning.push(`velocity_fast: ${avgDaysToSell}d avg → ×${payload.velocityBoost}`);
      }

      // Minimum margin gate
      const projectedMargin = estimatedValue > 0 && allocatedCost > 0
        ? (estimatedValue - allocatedCost) / estimatedValue
        : null;
      if (projectedMargin !== null && projectedMargin < payload.minProjectedMarginPct) {
        multiplier *= 0.70;
        reasoning.push(`margin_below_floor: ${r2(projectedMargin * 100)}% < ${payload.minProjectedMarginPct * 100}% → ×0.70`);
      }
      break;
    }

    default:
      reasoning.push("generic_payload_no_adjustments");
      break;
  }

  // ── Signal adjustment based on final multiplier ─────────────────────────
  const adjustedSignal = _adjustSignal(baseSignal, multiplier, payload);
  const adjustedValue  = estimatedValue > 0 ? r2(estimatedValue * multiplier) : estimatedValue;

  return {
    adjustedSignal,
    adjustedValue,
    payloadId:        payload.id,
    payloadLabel:     payload.label,
    payloadMultiplier: r2(multiplier),
    authScore:        r2(authScore),
    reasoning,
  };
}

// ── Alpha Signal Filter ───────────────────────────────────────────────────────

/**
 * Compute projected ROI and determine if this is an Alpha Lot candidate.
 * Alpha items (ROI > ALPHA_ROI_THRESHOLD) must be validated by a second
 * Specialist before any capital is committed.
 *
 * @param {object} item        Item with estimatedValue and allocatedCost
 * @param {object} payload     Resolved payload
 * @param {number} allocatedCost
 * @returns {{ roi: number, isAlpha: boolean, threshold: number, projectedProfit: number }}
 */
export function computeAlphaScore(item, payload, allocatedCost) {
  const cost  = Number(allocatedCost || item.allocatedCost || 0);
  const value = Number(item.estimatedValue || item.estimatedCost || 0);

  if (cost <= 0 || value <= 0) {
    return { roi: 0, isAlpha: false, threshold: payload.alphaROIThreshold, projectedProfit: 0 };
  }

  const projectedProfit = r2(value - cost);
  const roi             = r2((projectedProfit / cost) * 100);
  const threshold       = payload.alphaROIThreshold ?? ALPHA_ROI_THRESHOLD;
  const isAlpha         = roi > threshold;

  return { roi, isAlpha, threshold, projectedProfit };
}

// ── Private helpers ───────────────────────────────────────────────────────────

const SIGNAL_ORDER = ["PASS", "WATCH", "GOOD_DEAL", "STRONG_BUY"];

function _adjustSignal(baseSignal, multiplier, payload) {
  const idx = SIGNAL_ORDER.indexOf(baseSignal);
  if (idx === -1) return baseSignal;

  if (multiplier >= payload.signalUpgradeThreshold && idx < SIGNAL_ORDER.length - 1) {
    return SIGNAL_ORDER[idx + 1];  // upgrade one level
  }
  if (multiplier < payload.signalDowngradeThreshold && idx > 0) {
    return SIGNAL_ORDER[idx - 1];  // downgrade one level
  }
  return baseSignal;
}

function r2(n) { return Math.round(n * 100) / 100; }
