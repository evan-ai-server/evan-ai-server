// src/smartSubstituteRanker.js
// Smart Substitute Ranker: unified ranking across ALL substitute systems.
// Pulls from DNA match, colorway substitutes, brand tier alternatives, and
// alternative marketplaces into one ranked list with match confidence,
// savings, and a clear reason for each recommendation.
// "Top alternative: Adidas Samba OG at $85 — 91% match, saves $145 (63%)."

// ── Substitute type labels ────────────────────────────────────────────────────
const SUBSTITUTE_TYPES = {
  exact_cheaper:     { label: "Same item, lower price",          rank: 1, confidenceBase: 98 },
  dna_match:         { label: "Near-identical DNA match",        rank: 2, confidenceBase: 88 },
  colorway_match:    { label: "Same colorway, different brand",  rank: 3, confidenceBase: 85 },
  brand_tier_down:   { label: "One tier down, similar function", rank: 4, confidenceBase: 72 },
  alt_marketplace:   { label: "Same item on cheaper platform",   rank: 5, confidenceBase: 95 },
  hidden_gem:        { label: "Hidden gem — undervalued match",  rank: 6, confidenceBase: 70 },
  premium_upgrade:   { label: "Premium upgrade",                 rank: 7, confidenceBase: 80 },
};

// ── Role labels for UI grouping ───────────────────────────────────────────────
const ROLES = {
  best_value:      "Best Value",
  best_match:      "Best Match",
  biggest_savings: "Biggest Savings",
  hidden_gem:      "Hidden Gem",
  premium_upgrade: "Premium Upgrade",
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Normalize a raw substitute from any source into a canonical substitute record.
 */
function normalizeSubstitute(raw = {}, type = "dna_match", scannedPrice = null) {
  const price    = finiteOrNull(raw?.estimatedPrice ?? raw?.price ?? raw?.expectedPrice);
  const savings  = (scannedPrice && price) ? round2(scannedPrice - price) : finiteOrNull(raw?.savings ?? raw?.savingsDollars);
  const savPct   = (scannedPrice && savings) ? round2((savings / scannedPrice) * 100) : finiteOrNull(raw?.savingsPct ?? raw?.typicalDiscount);
  const typeMeta = SUBSTITUTE_TYPES[type] || SUBSTITUTE_TYPES.dna_match;

  return {
    type,
    typeLabel:   typeMeta.label,
    brand:       raw?.brand || raw?.label || "",
    model:       raw?.model || raw?.registryKey || "",
    label:       raw?.label || [raw?.brand, raw?.model].filter(Boolean).join(" ") || raw?.key || "",
    url:         raw?.url         || raw?.searchUrl || null,
    price,
    savings,
    savingsPct:  savPct,
    matchScore:  raw?.matchScore  ?? raw?.colorMatchScore ?? raw?.trust ?? null,
    confidence:  raw?.confidence  ?? typeMeta.confidenceBase,
    note:        raw?.note        || raw?.signal || null,
    query:       raw?.query       || raw?.searchUrl || null,
    buyerProtection: raw?.buyerProtection ?? null,
  };
}

/**
 * Assign roles to top substitutes.
 */
function assignRoles(substitutes = []) {
  if (!substitutes.length) return substitutes;

  const sorted = [...substitutes].filter(s => s.savings !== null);

  const bestMatch   = [...substitutes].sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))[0];
  const bestValue   = [...sorted].sort((a, b) => {
    // best value = highest savings % with matchScore >= 60
    const scoreA = (a.savingsPct ?? 0) * (a.matchScore ?? 70) / 100;
    const scoreB = (b.savingsPct ?? 0) * (b.matchScore ?? 70) / 100;
    return scoreB - scoreA;
  })[0];
  const biggestSavings = [...sorted].sort((a, b) => (b.savings ?? 0) - (a.savings ?? 0))[0];
  const hiddenGem      = substitutes.find(s => s.type === "hidden_gem" || (s.savingsPct > 40 && (s.matchScore ?? 0) >= 70));
  const premiumUpgrade = substitutes.find(s => s.type === "premium_upgrade" || (s.savings !== null && s.savings < 0));

  return substitutes.map(s => ({
    ...s,
    role: s === premiumUpgrade ? "premium_upgrade"
        : s === hiddenGem      ? "hidden_gem"
        : s === bestValue      ? "best_value"
        : s === bestMatch      ? "best_match"
        : s === biggestSavings ? "biggest_savings"
        : null,
    roleLabel: s === premiumUpgrade ? ROLES.premium_upgrade
             : s === hiddenGem      ? ROLES.hidden_gem
             : s === bestValue      ? ROLES.best_value
             : s === bestMatch      ? ROLES.best_match
             : s === biggestSavings ? ROLES.biggest_savings
             : null,
  }));
}

/**
 * Combine all substitute sources into one ranked list.
 */
export function rankSubstitutes({
  scannedPrice      = null,
  dnaMatch          = null,
  colorwaySubstitutes = null,
  brandTier         = null,
  altMarketplaces   = null,
  deduplicatedMarket = null,
} = {}) {
  const price = finiteOrNull(scannedPrice);
  const all   = [];

  // ── DNA matches ────────────────────────────────────────────────────────────
  const dnaSubstitutes = dnaMatch?.substitutes || [];
  for (const s of dnaSubstitutes.slice(0, 4)) {
    const norm = normalizeSubstitute({ ...s, confidence: s.matchScore ?? 85 }, "dna_match", price);
    if (norm.label) all.push(norm);
  }

  // ── Colorway substitutes ───────────────────────────────────────────────────
  const colorAlts = colorwaySubstitutes?.substitutes?.alternatives || [];
  for (const s of colorAlts.slice(0, 3)) {
    const norm = normalizeSubstitute({ ...s, matchScore: s.colorMatchScore ?? 88 }, "colorway_match", price);
    if (norm.label) all.push(norm);
  }

  // ── Brand tier downgrades (cheaper alternatives) ───────────────────────────
  const tierDowns = brandTier?.alternatives?.downgrades || [];
  for (const s of tierDowns.slice(0, 2)) {
    const norm = normalizeSubstitute({
      brand: s.brand,
      model: "",
      note:  `${s.tierMeta?.label || s.tier} brand — ${Math.round((s.resaleRetention || 0) * 100)}% resale retention`,
      confidence: 68,
    }, "brand_tier_down", price);
    if (norm.label) all.push(norm);
  }

  // ── Brand tier upgrades (premium options for context) ─────────────────────
  const tierUps = brandTier?.alternatives?.upgrades || [];
  for (const s of tierUps.slice(0, 1)) {
    const norm = normalizeSubstitute({
      brand: s.brand,
      model: "",
      note:  `${s.tierMeta?.label || s.tier} brand — ${Math.round((s.resaleRetention || 0) * 100)}% resale retention`,
      confidence: 75,
    }, "premium_upgrade", price);
    if (norm.label) all.push(norm);
  }

  // ── Alternative marketplaces (same item, cheaper platform) ────────────────
  const markets = altMarketplaces?.markets || [];
  for (const m of markets.slice(0, 3)) {
    if (!m.expectedPrice) continue;
    const norm = normalizeSubstitute({
      label:          m.label,
      url:            m.url,
      price:          m.expectedPrice,
      savings:        m.savingsDollars,
      savingsPct:     m.typicalDiscount,
      matchScore:     Math.round((m.trust || 0.8) * 100),
      buyerProtection: m.buyerProtection,
      note:           m.note,
      confidence:     95,
    }, "alt_marketplace", price);
    if (norm.label) all.push(norm);
  }

  // ── Dedup: remove duplicates by label ────────────────────────────────────
  const seen    = new Set();
  const unique  = all.filter(s => {
    const key = `${s.brand}|${s.model}|${s.type}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Score each substitute ─────────────────────────────────────────────────
  const scored = unique.map(s => {
    const typeRank    = SUBSTITUTE_TYPES[s.type]?.rank ?? 9;
    const savingsScore = s.savingsPct ? Math.min(50, s.savingsPct)   : 0;
    const matchScore   = s.matchScore  ? Math.min(40, s.matchScore * 0.4) : 20;
    const confScore    = s.confidence  ? s.confidence * 0.1           : 5;
    const rankPenalty  = typeRank * 1.5;
    const composite    = round2(savingsScore + matchScore + confScore - rankPenalty);
    return { ...s, compositeScore: composite };
  }).sort((a, b) => b.compositeScore - a.compositeScore);

  return assignRoles(scored);
}

/**
 * Master smart substitute ranker payload.
 */
export function buildSmartSubstituteRankerPayload({
  scannedPrice       = null,
  medianMarket       = null,
  dnaMatch           = null,
  colorwaySubstitutes = null,
  brandTier          = null,
  altMarketplaces    = null,
  deduplicatedMarket = null,
} = {}) {
  const price = finiteOrNull(scannedPrice) || finiteOrNull(medianMarket);
  const ranked = rankSubstitutes({
    scannedPrice: price,
    dnaMatch,
    colorwaySubstitutes,
    brandTier,
    altMarketplaces,
    deduplicatedMarket,
  });

  const top      = ranked[0] || null;
  const bestValue      = ranked.find(s => s.role === "best_value")      || null;
  const biggestSavings = ranked.find(s => s.role === "biggest_savings") || null;
  const hiddenGem      = ranked.find(s => s.role === "hidden_gem")      || null;

  return {
    ranked:          ranked.slice(0, 8),
    totalFound:      ranked.length,
    top,
    bestValue,
    biggestSavings,
    hiddenGem,
    topSignal: top
      ? `Top substitute: ${top.label}${top.price ? ` at ~$${top.price.toFixed(2)}` : ""}${top.savings ? ` — saves ~$${top.savings.toFixed(2)}` : ""}${top.savingsPct ? ` (${top.savingsPct.toFixed(0)}%)` : ""} — ${top.typeLabel}`
      : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function round2(v) { return Math.round(v * 100) / 100; }
