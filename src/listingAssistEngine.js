// src/listingAssistEngine.js
// Phase 3 — Listing Assist Engine.
//
// Converts a purchased inventory item into a sell-ready listing.
// Does NOT hallucinate — every attribute in the output is sourced
// directly from the stored inventory item snapshot (Phase 2 structured
// attributes) or from known market logic.
//
// Per category:
//   sneakers  → StockX/GOAT/eBay, title template, size/condition emphasis
//   handbags  → TheRealReal/Fashionphile/Poshmark, luxury language, auth cert emphasis
//   watches   → Chrono24/WatchBox/eBay, ref number, box+papers status, condition
//   generic   → eBay/Mercari/FB Marketplace, simple title, condition-first

import { getInventoryItem } from "./inventoryEngine.js";
import { CAT } from "./categoryRegistry.js";

// ── Trust-safe listing helpers ────────────────────────────────────────────────

/**
 * Build trust-aware brand claim prefix for listing descriptions.
 * Avoids overclaiming authenticity when evidence is weak or verdict is uncertain.
 *
 * @param {string} brand
 * @param {object|null} authEvidence — payload.authenticationEvidence if stored in snapshot
 * @returns {{ claimPrefix: string, confidenceNote: string|null, blockStrongClaims: boolean }}
 */
function buildTrustSafeListingClaims(brand, authEvidence) {
  if (!authEvidence) {
    // No evidence data — use neutral brand attribution
    return {
      claimPrefix: brand || "Item",
      confidenceNote: null,
      blockStrongClaims: false,
    };
  }

  const verdict  = authEvidence.verdict;
  const strength = authEvidence.evidenceStrength;

  if (verdict === "LIKELY_COUNTERFEIT") {
    // Should not be listed — but if it is, never claim authentic
    return {
      claimPrefix: brand || "Item",
      confidenceNote: "Authentication concerns noted. Buyer should independently verify authenticity.",
      blockStrongClaims: true,
    };
  }

  if (verdict === "LIKELY_AUTHENTIC" && (strength === "STRONG" || strength === "MEDIUM")) {
    return {
      claimPrefix: `Authentic ${brand}`.trim(),
      confidenceNote: null,
      blockStrongClaims: false,
    };
  }

  if (verdict === "INSUFFICIENT_EVIDENCE" || strength === "NONE") {
    return {
      claimPrefix: brand || "Item",
      confidenceNote: "Authenticity not independently verified. Buyer should authenticate prior to purchase.",
      blockStrongClaims: true,
    };
  }

  // UNCERTAIN or WEAK evidence — hedged language
  return {
    claimPrefix: brand || "Item",
    confidenceNote: "Authentication not confirmed. Independent verification recommended.",
    blockStrongClaims: false,
  };
}

// ── Platform recommendations by category ─────────────────────────────────────

const PLATFORM_RECS = {
  [CAT.SNEAKERS]: [
    { platform: "StockX",   fee: 0.095, pros: "Price transparency, no haggling, DS only", best_for: "deadstock/VNDS" },
    { platform: "GOAT",     fee: 0.095, pros: "Largest buyer pool, used condition accepted", best_for: "any condition" },
    { platform: "eBay",     fee: 0.1275,pros: "Highest ceiling for rare sizes, auction format", best_for: "rare sizes/colorways" },
    { platform: "Poshmark", fee: 0.20,  pros: "Social + lower price buyers", best_for: "mid-tier shoes" },
  ],
  [CAT.HANDBAGS]: [
    { platform: "The RealReal",  fee: 0.20, pros: "Authenticated resale, luxury buyer pool", best_for: "high-value authenticated bags" },
    { platform: "Fashionphile",  fee: 0.18, pros: "Instant offers for common LV/Chanel/Gucci", best_for: "LV Neverfull, Chanel Classic" },
    { platform: "Vestiaire Collective", fee: 0.15, pros: "European buyer pool, authentication built-in", best_for: "European luxury brands" },
    { platform: "eBay",          fee: 0.1275, pros: "Widest audience, highest ceiling for rare pieces", best_for: "limited/rare styles" },
    { platform: "Poshmark",      fee: 0.20, pros: "Lower buyer bar, faster sale on mid-tier", best_for: "$200-800 bags" },
  ],
  [CAT.WATCHES]: [
    { platform: "Chrono24",  fee: 0.065, pros: "Global watch collector market, low fee, escrow", best_for: "all luxury watches" },
    { platform: "WatchBox",  fee: 0.12,  pros: "Instant offer, authenticated, no listing work", best_for: "Rolex/AP/Patek" },
    { platform: "eBay",      fee: 0.1275, pros: "Largest US audience, best for vintage/mid-tier", best_for: "vintage, sub-$5k" },
    { platform: "Watchuseek", fee: 0,    pros: "Community forums, zero fee (need account history)", best_for: "established sellers" },
  ],
  generic: [
    { platform: "eBay",              fee: 0.1275, pros: "Largest audience", best_for: "general items" },
    { platform: "Facebook Marketplace", fee: 0,  pros: "No fees, local pickup", best_for: "bulky/local items" },
    { platform: "Mercari",           fee: 0.10,  pros: "Easy listing, fast sales", best_for: "fashion/collectibles" },
    { platform: "Poshmark",          fee: 0.20,  pros: "Social selling, fashion focus", best_for: "clothing/accessories" },
  ],
};

// ── Suggested price multipliers by condition ──────────────────────────────────

const CONDITION_PRICE_FACTOR = {
  "DS":             1.00,
  "deadstock":      1.00,
  "VNDS":           0.92,
  "used_excellent": 0.80,
  "excellent":      0.80,
  "pristine":       0.95,
  "very_good":      0.75,
  "used_good":      0.65,
  "good":           0.65,
  "fair":           0.45,
  "beater":         0.30,
  "full_set":       1.00,
  "papers_only":    0.85,
  "box_only":       0.80,
  "no_box_no_papers": 0.70,
};

// ── Main generator ─────────────────────────────────────────────────────────────

/**
 * Generate a listing for an inventory item.
 *
 * @param {object} redis
 * @param {object} opts
 *   invId           {string}  — inventory item ID
 *   targetPlatform  {string|null} — if provided, optimize listing for this platform
 * @returns {ListingResult}
 */
export async function generateListing(redis, { invId, targetPlatform = null } = {}) {
  if (!redis || !invId) return { ok: false, error: "missing_inv_id" };

  const item = await getInventoryItem(redis, invId);
  if (!item) return { ok: false, error: "item_not_found" };

  const attrs    = item.itemSnapshot || {};
  const category = item.category    || "generic";

  try {
    let listing;
    switch (category) {
      case CAT.SNEAKERS: listing = generateSneakerListing(item, attrs); break;
      case CAT.HANDBAGS: listing = generateHandbagListing(item, attrs); break;
      case CAT.WATCHES:  listing = generateWatchListing(item, attrs);   break;
      default:           listing = generateGenericListing(item, attrs);
    }

    const platforms    = PLATFORM_RECS[category] || PLATFORM_RECS.generic;
    const recommended  = targetPlatform
      ? platforms.filter(p => p.platform.toLowerCase().includes(targetPlatform.toLowerCase()))
          .concat(platforms.filter(p => !p.platform.toLowerCase().includes(targetPlatform.toLowerCase())))
      : platforms;

    // Net revenue estimates for top 3 platforms
    const netRevenueByPlatform = recommended.slice(0, 3).map(p => {
      const mid   = listing.suggestedPriceRange?.mid ?? 0;
      const net   = mid > 0 ? r2(mid * (1 - p.fee)) : null;
      const gross = listing.suggestedPriceRange;
      return {
        platform: p.platform,
        fee:      p.fee,
        bestFor:  p.best_for,
        pros:     p.pros,
        netEstimate: net,
        netLow:  gross?.low  ? r2(gross.low  * (1 - p.fee)) : null,
        netHigh: gross?.high ? r2(gross.high * (1 - p.fee)) : null,
      };
    });

    return {
      ok:        true,
      invId,
      itemName:  item.itemName,
      category,
      ...listing,
      platforms: recommended.slice(0, 4),
      netRevenueByPlatform,
      generatedAt: Date.now(),
    };
  } catch (err) {
    return { ok: false, error: "listing_generation_failed", reason: err?.message };
  }
}

// ── Category-specific listing generators ──────────────────────────────────────

function generateSneakerListing(item, attrs) {
  const brand    = attrs.brand    || item.itemName?.split(" ")[0] || "Unknown";
  const model    = attrs.model    || "";
  const colorway = attrs.colorway || "";
  const size     = attrs.size     || "";
  const condition = normalizeConditionLabel(attrs.condition);
  const styleCode = attrs.styleCode || null;
  const boxIncluded = attrs.boxIncluded;
  const edition  = attrs.edition || null;

  // Title: brand + model + colorway + size + condition (no hallucination — only use known fields)
  const titleParts = [brand, model, colorway, size ? `Size ${size}` : null, condition].filter(Boolean);
  const title = titleParts.join(" ").slice(0, 80);

  // Description
  const descParts = [
    `${brand} ${model}${colorway ? " " + colorway : ""} — ${condition}`,
    size ? `Men's US Size ${size}.` : null,
    styleCode ? `Style code: ${styleCode}.` : null,
    edition ? `Edition: ${edition}.` : null,
    boxIncluded === true  ? "Includes original box and all accessories." : null,
    boxIncluded === false ? "Original box not included." : null,
    "Sold as described. All sales final.",
  ].filter(Boolean);
  const description = descParts.join(" ");

  // Key attributes for structured listing
  const keyAttributes = [
    brand      ? { label: "Brand",     value: brand }    : null,
    model      ? { label: "Model",     value: model }    : null,
    colorway   ? { label: "Colorway",  value: colorway } : null,
    size       ? { label: "Size",      value: `US ${size}` } : null,
    { label: "Condition",  value: condition },
    styleCode  ? { label: "Style Code",value: styleCode } : null,
    { label: "Box",        value: boxIncluded === true ? "Included" : boxIncluded === false ? "Not included" : "Unknown" },
  ].filter(Boolean);

  // Price suggestion based on purchase price + expected margin
  const pp   = item.purchasePrice;
  const cond = (attrs.condition || "used_good").toLowerCase().trim();
  const condFactor = CONDITION_PRICE_FACTOR[cond] ?? 0.65;
  // For DS/VNDS, suggest 2x-3x purchase price if bought at thrift; use purchase price as floor
  const isThrift = ["THRIFT", "GARAGE", "ESTATE"].includes(item.sourceType);
  const minMult  = isThrift ? 1.8 : 1.1;
  const maxMult  = isThrift ? 3.5 : 1.8;

  const suggestedPriceRange = pp ? {
    low:  r2(pp * minMult),
    mid:  r2(pp * ((minMult + maxMult) / 2)),
    high: r2(pp * maxMult),
  } : null;

  const conditionSummary = buildConditionSummary(condition, "sneakers");

  return {
    title,
    description,
    keyAttributes,
    conditionSummary,
    suggestedPriceRange,
  };
}

function generateHandbagListing(item, attrs) {
  const brand    = attrs.brand    || "";
  const model    = attrs.model    || "";
  const material = attrs.material || "";
  const color    = attrs.color    || "";
  const hardware = attrs.hardwareColor || "";
  const condition = normalizeConditionLabel(attrs.condition);
  const dateCode = attrs.dateCode || null;
  const accessories = Array.isArray(attrs.accessories) ? attrs.accessories : [];
  const size     = attrs.size     || null;

  // Phase 4: trust-safe authentication claims
  const authEvidence = item.itemSnapshot?.authenticationEvidence || null;
  const { claimPrefix, confidenceNote, blockStrongClaims } = buildTrustSafeListingClaims(brand, authEvidence);

  // Luxury title format
  const titleParts = [
    brand,
    model,
    material,
    color,
    hardware ? `${hardware} Hardware` : null,
    size     ? `(${size})`           : null,
  ].filter(Boolean);
  const title = titleParts.join(" ").slice(0, 80);

  const accessoryStr = accessories.length > 0
    ? `Comes with: ${accessories.map(a => a.replace(/_/g, " ")).join(", ")}.`
    : null;

  // Use trust-safe brand claim prefix — never "Authentic" when evidence is weak
  const brandClaimLine = `${claimPrefix} ${model}${material ? " in " + material : ""}${color ? ", " + color : ""}.`.trim();

  // Authenticity documentation claim — only state if evidence supports it
  const hasAuthDocs = accessories.includes("receipt") || accessories.includes("authenticity_card");
  const authDocLine = hasAuthDocs
    ? "Authenticity documentation included."
    : (blockStrongClaims ? null : "Authentication verification recommended before purchase.");

  const descParts = [
    brandClaimLine,
    condition ? `Condition: ${condition}.` : null,
    hardware  ? `${hardware} tone hardware.` : null,
    dateCode  ? `Date code present: ${dateCode}.` : null,
    accessoryStr,
    authDocLine,
    confidenceNote,
    "All sales final. International buyers welcome.",
  ].filter(Boolean);
  const description = descParts.join(" ");

  const keyAttributes = [
    brand     ? { label: "Brand",     value: brand }     : null,
    model     ? { label: "Model",     value: model }     : null,
    material  ? { label: "Material",  value: material }  : null,
    color     ? { label: "Color",     value: color }     : null,
    hardware  ? { label: "Hardware",  value: hardware }  : null,
    size      ? { label: "Size",      value: size }      : null,
    { label: "Condition", value: condition },
    dateCode  ? { label: "Date Code", value: dateCode }  : null,
    { label: "Accessories", value: accessories.length > 0 ? accessories.join(", ") : "None mentioned" },
  ].filter(Boolean);

  const pp  = item.purchasePrice;
  const isThrift = ["THRIFT", "GARAGE", "ESTATE", "CONSIGNMENT"].includes(item.sourceType);
  const minMult  = isThrift ? 2.5 : 1.1;
  const maxMult  = isThrift ? 6.0 : 1.5;

  const suggestedPriceRange = pp ? {
    low:  r2(pp * minMult),
    mid:  r2(pp * ((minMult + maxMult) / 2)),
    high: r2(pp * maxMult),
  } : null;

  return {
    title,
    description,
    keyAttributes,
    conditionSummary: buildConditionSummary(condition, "handbags"),
    suggestedPriceRange,
    trustSafety: {
      blockStrongClaims,
      confidenceNote,
      authVerdictAtListing: authEvidence?.verdict || null,
    },
  };
}

function generateWatchListing(item, attrs) {
  const brand      = attrs.brand      || "";
  const model      = attrs.model      || "";
  const reference  = attrs.reference  || null;
  const dialColor  = attrs.dialColor  || null;
  const caseMat    = attrs.caseMaterial || null;
  const movement   = attrs.movement   || null;
  const boxPapers  = attrs.boxPapers  || null;
  const caseSize   = attrs.caseSize   || null;
  const complications = attrs.complications || [];
  const condition  = normalizeConditionLabel(attrs.dialCondition || attrs.condition);

  const titleParts = [
    brand,
    model,
    reference ? `Ref ${reference}` : null,
    caseMat,
    dialColor ? `${dialColor} Dial` : null,
  ].filter(Boolean);
  const title = titleParts.join(" ").slice(0, 80);

  const boxPapersStr = {
    full_set:       "Full set — box, papers, and all accessories.",
    papers_only:    "Papers only — no box.",
    box_only:       "Box only — no papers.",
    no_box_no_papers: "No box, no papers (naked watch).",
  }[boxPapers] || "Box/papers status not confirmed.";

  const descParts = [
    `${brand} ${model}${reference ? " (Ref " + reference + ")" : ""}.`,
    caseMat       ? `Case: ${caseMat}.`          : null,
    dialColor     ? `Dial: ${dialColor}.`         : null,
    movement      ? `Movement: ${movement}.`      : null,
    caseSize      ? `Case diameter: ${caseSize}mm.` : null,
    complications.length > 0 ? `Complications: ${complications.join(", ")}.` : null,
    boxPapersStr,
    condition     ? `Condition: ${condition}.`    : null,
    "Authenticate with authorized dealer or third-party service before purchase.",
  ].filter(Boolean);
  const description = descParts.join(" ");

  const keyAttributes = [
    brand      ? { label: "Brand",       value: brand }     : null,
    model      ? { label: "Model",       value: model }     : null,
    reference  ? { label: "Reference",   value: reference } : null,
    caseMat    ? { label: "Case",        value: caseMat }   : null,
    dialColor  ? { label: "Dial",        value: dialColor } : null,
    movement   ? { label: "Movement",    value: movement }  : null,
    caseSize   ? { label: "Case Size",   value: `${caseSize}mm` } : null,
    { label: "Box & Papers", value: boxPapers?.replace(/_/g, " ") || "Unknown" },
    condition  ? { label: "Condition",   value: condition } : null,
  ].filter(Boolean);

  const pp = item.purchasePrice;
  const bpFactor = { full_set: 1.25, papers_only: 1.10, box_only: 1.05, no_box_no_papers: 1.0 }[boxPapers] ?? 1.0;
  const isThrift = ["THRIFT", "GARAGE", "ESTATE"].includes(item.sourceType);
  const minMult  = isThrift ? 3.0 : 1.05;
  const maxMult  = isThrift ? 8.0 : 1.30;

  const suggestedPriceRange = pp ? {
    low:  r2(pp * minMult * bpFactor),
    mid:  r2(pp * ((minMult + maxMult) / 2) * bpFactor),
    high: r2(pp * maxMult * bpFactor),
  } : null;

  return {
    title,
    description,
    keyAttributes,
    conditionSummary: buildConditionSummary(condition, "watches"),
    suggestedPriceRange,
  };
}

function generateGenericListing(item, attrs) {
  const brand    = attrs.brand    || "";
  const model    = attrs.model    || "";
  const condition = normalizeConditionLabel(attrs.condition);
  const itemName = item.itemName  || [brand, model].filter(Boolean).join(" ") || "Item";

  const title = [itemName, condition].filter(Boolean).join(" — ").slice(0, 80);
  const description = [
    itemName + ".",
    condition ? `Condition: ${condition}.` : null,
    "Sold as described.",
  ].filter(Boolean).join(" ");

  const keyAttributes = [
    brand     ? { label: "Brand",     value: brand }     : null,
    model     ? { label: "Model",     value: model }     : null,
    condition ? { label: "Condition", value: condition } : null,
  ].filter(Boolean);

  const pp = item.purchasePrice;
  const isThrift = ["THRIFT", "GARAGE", "ESTATE"].includes(item.sourceType);
  const minMult  = isThrift ? 1.5 : 1.05;
  const maxMult  = isThrift ? 3.0 : 1.40;

  const suggestedPriceRange = pp ? {
    low:  r2(pp * minMult),
    mid:  r2(pp * ((minMult + maxMult) / 2)),
    high: r2(pp * maxMult),
  } : null;

  return {
    title,
    description,
    keyAttributes,
    conditionSummary: buildConditionSummary(condition, "generic"),
    suggestedPriceRange,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeConditionLabel(raw) {
  if (!raw) return "Used";
  const LABELS = {
    "DS":           "Deadstock (New, Unworn)",
    "deadstock":    "Deadstock (New, Unworn)",
    "VNDS":         "Very Near Deadstock",
    "used_excellent":"Used — Excellent",
    "excellent":    "Excellent",
    "pristine":     "Pristine",
    "very_good":    "Very Good",
    "used_good":    "Good",
    "good":         "Good",
    "fair":         "Fair",
    "beater":       "Heavy Wear",
    "full_set":     "New (Full Set)",
    "new_full_set": "New (Full Set)",
  };
  return LABELS[raw] || raw;
}

function buildConditionSummary(condLabel, category) {
  const SUMMARIES = {
    sneakers: {
      "Deadstock (New, Unworn)": "Unworn, original box included. No creasing, no sole wear.",
      "Very Near Deadstock": "Tried on only. No visible wear. Box may or may not be present.",
      "Used — Excellent": "Light wear visible only on close inspection. No major flaws.",
      "Good": "Normal wear consistent with use. No structural damage.",
      "Fair": "Noticeable wear throughout. Priced accordingly.",
    },
    handbags: {
      "Pristine": "No signs of use. Hardware, leather, and interior in perfect condition.",
      "Excellent": "Minimal signs of use. Sharp corners, clean interior, bright hardware.",
      "Very Good": "Light wear consistent with occasional use. Minor marks possible.",
      "Good": "Moderate wear — handle darkening, corner softening, minor interior marks.",
      "Fair": "Significant wear. Heavily used condition. Priced to reflect.",
    },
    watches: {
      "Excellent": "Case and bracelet show minimal wear. Dial in perfect condition.",
      "Good": "Normal wear. Case scratches, bracelet stretch within normal parameters.",
      "Fair": "Heavy use marks. May require service. Dial and movement function correctly.",
    },
  };
  return SUMMARIES[category]?.[condLabel] || `Condition: ${condLabel}.`;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
