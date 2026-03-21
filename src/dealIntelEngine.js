// src/dealIntelEngine.js
// 60% Cheaper Hunter + Deal Intel Engine
// Finds, scores, and surfaces massive savings opportunities.
// "Don't buy this for $280. Here's the same thing for $89."

// ── Savings thresholds ────────────────────────────────────────────────────────
const SAVINGS_TIERS = {
  massive:   { minPct: 60, label: "Massive savings",    emoji: "🔥", color: "#00d478" },
  strong:    { minPct: 40, label: "Strong savings",     emoji: "💰", color: "#50e040" },
  moderate:  { minPct: 25, label: "Solid deal",         emoji: "✅", color: "#90ff60" },
  minor:     { minPct: 10, label: "Slight discount",    emoji: "📉", color: "#c0e080" },
  none:      { minPct: 0,  label: "At market price",    emoji: "➡️", color: "#888888" },
};

function getSavingsTier(pct) {
  if (pct >= 60) return SAVINGS_TIERS.massive;
  if (pct >= 40) return SAVINGS_TIERS.strong;
  if (pct >= 25) return SAVINGS_TIERS.moderate;
  if (pct >= 10) return SAVINGS_TIERS.minor;
  return SAVINGS_TIERS.none;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0));
}

function normalizeTitle(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleTokens(s) {
  return normalizeTitle(s).split(" ").filter(w => w.length > 2);
}

function titleOverlap(a, b) {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter(t => tb.has(t)).length;
  return shared / Math.max(ta.size, tb.size);
}

// ── Core: score a single item as a "cheaper alternative" ─────────────────────
export function scoreCheaperItem(item, {
  scannedPrice = null,
  referenceQuery = "",
  identity = null,
  allowedMatchTypes = ["exact", "near", "category"],
} = {}) {
  const price = finiteOrNull(item?.price ?? item?.totalPrice);
  if (!price) return null;
  if (!scannedPrice) return null;

  const savingsDollars = round2(scannedPrice - price);
  const savingsPct = round2((savingsDollars / scannedPrice) * 100);
  if (savingsPct < 5) return null; // must be meaningfully cheaper

  const title = String(item?.title || item?.itemName || "");
  const overlap = titleOverlap(title, referenceQuery);

  // Match type determination
  let matchType = "category"; // default: same category, different item
  if (overlap >= 0.65) matchType = "near";
  if (overlap >= 0.85) matchType = "exact";

  if (!allowedMatchTypes.includes(matchType)) return null;

  // Match confidence based on overlap + price sanity
  const tooChep = price < scannedPrice * 0.05; // suspiciously cheap = likely wrong category
  if (tooChep) return null;

  const matchConfidence = clamp(
    overlap * 70 +
    (matchType === "exact" ? 25 : matchType === "near" ? 15 : 5) +
    (savingsPct >= 60 ? 10 : savingsPct >= 40 ? 5 : 0),
    0, 99
  );

  const tier = getSavingsTier(savingsPct);
  const savingsMultiplier = scannedPrice > 0 ? round2(scannedPrice / price) : null;

  return {
    ...item,
    savingsDollars,
    savingsPct: round2(savingsPct),
    savingsMultiplier,
    matchType,
    matchConfidence,
    savingsTier: tier.label,
    savingsTierEmoji: tier.emoji,
    savingsTierColor: tier.color,
    isMassiveSaving: savingsPct >= 60,
    isStrongSaving: savingsPct >= 40,
    isHiddenGem: savingsPct >= 40 && matchConfidence >= 55,
  };
}

// ── Hunt for 60%+ cheaper items across all results ───────────────────────────
export function hunt60PctCheaper(items = [], scannedPrice = null, referenceQuery = "") {
  if (!scannedPrice || !items.length) return [];

  return items
    .map(item => scoreCheaperItem(item, { scannedPrice, referenceQuery }))
    .filter(Boolean)
    .filter(s => s.savingsPct >= 55) // 55%+ threshold for "60% cheaper" claim
    .sort((a, b) => {
      // Sort by: hidden gem first, then savings%, then match confidence
      if (a.isHiddenGem !== b.isHiddenGem) return b.isHiddenGem ? 1 : -1;
      if (Math.abs(b.savingsPct - a.savingsPct) > 5) return b.savingsPct - a.savingsPct;
      return b.matchConfidence - a.matchConfidence;
    })
    .slice(0, 5);
}

// ── Find the single best cheaper alternative ─────────────────────────────────
export function findBestAlternative(items = [], scannedPrice = null, referenceQuery = "") {
  if (!scannedPrice || !items.length) return null;

  const scored = items
    .map(item => scoreCheaperItem(item, { scannedPrice, referenceQuery }))
    .filter(Boolean)
    .sort((a, b) => {
      // Best alternative = strong savings + strong match confidence
      const scoreA = (a.savingsPct * 0.5) + (a.matchConfidence * 0.5);
      const scoreB = (b.savingsPct * 0.5) + (b.matchConfidence * 0.5);
      return scoreB - scoreA;
    });

  return scored[0] || null;
}

// ── Build the full deal intel payload for API response ───────────────────────
export function buildDealIntelPayload({
  items = [],
  scannedPrice = null,
  referenceQuery = "",
  identity = null,
  medianMarket = null,
}) {
  if (!items.length) return null;

  const bestAlternative = findBestAlternative(items, scannedPrice, referenceQuery);
  const massiveSavings = hunt60PctCheaper(items, scannedPrice, referenceQuery);
  const hiddenGems = items
    .map(item => scoreCheaperItem(item, { scannedPrice, referenceQuery }))
    .filter(i => i?.isHiddenGem)
    .sort((a, b) => b.savingsPct - a.savingsPct)
    .slice(0, 3);

  const cheapestItem = items.reduce((best, item) => {
    const p = finiteOrNull(item?.price ?? item?.totalPrice);
    const bp = finiteOrNull(best?.price ?? best?.totalPrice);
    if (!p) return best;
    if (!bp || p < bp) return item;
    return best;
  }, null);

  const cheapestPrice = finiteOrNull(cheapestItem?.price ?? cheapestItem?.totalPrice);
  const cheapestSavings = (scannedPrice && cheapestPrice)
    ? round2(((scannedPrice - cheapestPrice) / scannedPrice) * 100)
    : null;

  // Price distribution analysis
  const prices = items
    .map(i => finiteOrNull(i?.price ?? i?.totalPrice))
    .filter(Boolean)
    .sort((a, b) => a - b);

  const medianIdx = Math.floor(prices.length / 2);
  const marketMedian = prices.length ? prices[medianIdx] : null;
  const marketMin = prices.length ? prices[0] : null;
  const marketMax = prices.length ? prices[prices.length - 1] : null;

  // Buy recommendation
  let recommendation = "check_market";
  let recommendationReason = null;

  if (scannedPrice && marketMedian) {
    const vsMedian = ((scannedPrice - marketMedian) / marketMedian) * 100;
    if (vsMedian >= 40) {
      recommendation = "skip";
      recommendationReason = `Listed at ${Math.round(vsMedian)}% above market median. Overprice`;
    } else if (vsMedian >= 15) {
      recommendation = "negotiate";
      recommendationReason = `${Math.round(vsMedian)}% above market. Offer ${Math.round(marketMedian * 1.05)} or less`;
    } else if (vsMedian <= -25) {
      recommendation = "buy_now";
      recommendationReason = `${Math.round(Math.abs(vsMedian))}% below market — exceptional deal`;
    } else if (vsMedian <= -10) {
      recommendation = "buy";
      recommendationReason = `Good deal — below market median by ${Math.round(Math.abs(vsMedian))}%`;
    } else {
      recommendation = "fair_price";
      recommendationReason = "At market price — not a deal, not overpriced";
    }
  }

  // Savings opportunity summary
  let savingsOpportunity = null;
  if (bestAlternative && scannedPrice) {
    const altPrice = finiteOrNull(bestAlternative.price ?? bestAlternative.totalPrice);
    if (altPrice && bestAlternative.savingsPct >= 20) {
      savingsOpportunity = {
        title: bestAlternative.title || bestAlternative.itemName,
        price: altPrice,
        savingsDollars: round2(scannedPrice - altPrice),
        savingsPct: bestAlternative.savingsPct,
        savingsMultiplier: round2(scannedPrice / altPrice),
        url: bestAlternative.buyLink || bestAlternative.url || null,
        matchType: bestAlternative.matchType,
        isHiddenGem: bestAlternative.isHiddenGem,
        headline: bestAlternative.savingsPct >= 60
          ? `Same thing. ${bestAlternative.savingsPct}% cheaper.`
          : bestAlternative.savingsPct >= 40
          ? `Strong alternative. Save $${round2(scannedPrice - altPrice)}.`
          : `Cheaper option found. Save $${round2(scannedPrice - altPrice)}.`,
      };
    }
  }

  return {
    bestAlternative: savingsOpportunity,
    hiddenGems: hiddenGems.map(g => ({
      title: g.title || g.itemName,
      price: finiteOrNull(g.price ?? g.totalPrice),
      savingsPct: g.savingsPct,
      savingsDollars: g.savingsDollars,
      isHiddenGem: true,
    })).slice(0, 3),
    massiveSavingsCount: massiveSavings.length,
    hasMassiveSavings: massiveSavings.length > 0,
    marketMin,
    marketMax,
    marketMedian,
    cheapestAvailable: cheapestPrice,
    cheapestSavingsPct: cheapestSavings,
    recommendation,
    recommendationReason,
    pricePosition: scannedPrice && marketMedian
      ? round2(((scannedPrice - marketMedian) / marketMedian) * 100)
      : null,
  };
}
