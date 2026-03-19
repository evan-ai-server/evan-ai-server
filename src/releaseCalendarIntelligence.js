// src/releaseCalendarIntelligence.js
// Release & restock intelligence: MSRP lookup, restock cadence modeling,
// upcoming drop awareness, and MSRP-to-resale premium calculator.
// "Wait 3 weeks — Nike is restocking this at $110 retail instead of $165 resale."

// ── MSRP registry ─────────────────────────────────────────────────────────────
const MSRP_REGISTRY = {
  // Jordan
  "jordan 1 retro high":      190,
  "jordan 1 retro low":       130,
  "jordan 4 retro":           210,
  "jordan 3 retro":           200,
  "jordan 11 retro":          220,
  "jordan 6 retro":           200,
  // Nike
  "nike dunk low":            110,
  "nike dunk high":           120,
  "nike air force 1 low":      90,
  "nike air force 1 high":    100,
  "nike air max 90":          120,
  "nike air max 1":           110,
  "nike air max 97":          175,
  "nike pegasus":             130,
  // Adidas
  "adidas yeezy boost 350 v2":220,
  "adidas yeezy slide":        70,
  "adidas samba og":           100,
  "adidas campus 00s":        100,
  "adidas ultraboost":        190,
  // New Balance
  "new balance 990v6":        185,
  "new balance 2002r":        150,
  "new balance 1906r":        150,
  "new balance 550":           90,
  "new balance 327":           90,
  // Apple
  "iphone 16 pro":            999,
  "iphone 16":                799,
  "iphone 16 pro max":       1199,
  "airpods pro 2":            249,
  "airpods 4":                129,
  "apple watch series 10":    399,
  "apple watch ultra 2":      799,
  // Sneakers premium
  "on cloud 5":               140,
  "on cloudmonster 2":        170,
  "hoka clifton 9":           145,
  "asics gel-nimbus 26":      160,
  "saucony endorphin speed":  160,
  // Watches
  "apple watch se":           249,
  "garmin forerunner 265":    449,
  // Audio
  "sony wh-1000xm5":         349,
  "bose quietcomfort 45":    279,
};

// ── Restock cadence knowledge ──────────────────────────────────────────────────
// How often items typically restock at retail
const RESTOCK_CADENCE = {
  // Limited drops — rare restocks
  "jordan 1 retro high":    { type: "limited", avgMonthsBetweenRestocks: 18, restockProbability: 0.15 },
  "jordan 4 retro":         { type: "limited", avgMonthsBetweenRestocks: 24, restockProbability: 0.10 },
  "adidas yeezy boost 350": { type: "limited", avgMonthsBetweenRestocks: 6,  restockProbability: 0.30 },
  // GR (General Release) — restocks often
  "nike dunk low":          { type: "gr",      avgMonthsBetweenRestocks: 3,  restockProbability: 0.80 },
  "nike air force 1 low":   { type: "gr",      avgMonthsBetweenRestocks: 2,  restockProbability: 0.90 },
  "adidas samba":           { type: "gr",      avgMonthsBetweenRestocks: 2,  restockProbability: 0.85 },
  "adidas campus":          { type: "gr",      avgMonthsBetweenRestocks: 2,  restockProbability: 0.85 },
  "new balance 550":        { type: "gr",      avgMonthsBetweenRestocks: 3,  restockProbability: 0.75 },
  // Electronics — continuous production
  "iphone":                 { type: "continuous", avgMonthsBetweenRestocks: 0, restockProbability: 0.99 },
  "airpods":                { type: "continuous", avgMonthsBetweenRestocks: 0, restockProbability: 0.99 },
  "apple watch":            { type: "continuous", avgMonthsBetweenRestocks: 0, restockProbability: 0.95 },
  "sony":                   { type: "continuous", avgMonthsBetweenRestocks: 0, restockProbability: 0.95 },
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Look up MSRP for an item identity.
 */
export function lookupMSRP(identity = {}) {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const key   = `${brand} ${model}`.trim();

  for (const [registryKey, msrp] of Object.entries(MSRP_REGISTRY)) {
    if (key.includes(registryKey) || registryKey.split(" ").every(t => t.length >= 3 && key.includes(t))) {
      return { found: true, msrp, registryKey };
    }
  }
  return { found: false, msrp: null, registryKey: null };
}

/**
 * Resolve restock cadence for an item.
 */
function resolveRestockCadence(identity = {}) {
  const brand = String(identity?.brand || "").toLowerCase();
  const model = String(identity?.model || "").toLowerCase();
  const key   = `${brand} ${model}`.trim();

  for (const [cadenceKey, cadence] of Object.entries(RESTOCK_CADENCE)) {
    if (key.includes(cadenceKey) || cadenceKey.split(" ").every(t => t.length >= 3 && key.includes(t))) {
      return { ...cadence, cadenceKey };
    }
  }
  return null;
}

/**
 * Compute MSRP-to-resale premium and buy-at-retail recommendation.
 */
export function computeResalePremium(identity = {}, marketPrice = null) {
  const { found, msrp } = lookupMSRP(identity);
  if (!found || !msrp) return null;

  const market = finiteOrNull(marketPrice);
  if (!market) return { msrp, resaleMultiple: null, premiumDollars: null, premiumPct: null };

  const premiumDollars = round2(market - msrp);
  const premiumPct     = round2((premiumDollars / msrp) * 100);
  const resaleMultiple = round2(market / msrp);

  const worthBuyingAtRetail = msrp < market * 0.85; // retail is 15%+ below resale

  return {
    msrp,
    marketPrice:    round2(market),
    premiumDollars,
    premiumPct,
    resaleMultiple,
    worthBuyingAtRetail,
    signal: worthBuyingAtRetail
      ? `MSRP is $${msrp} — resale is $${round2(market - msrp)} above retail. Buy at drop price for instant profit.`
      : premiumPct > 0
      ? `Resale is ${premiumPct.toFixed(0)}% above MSRP ($${msrp}). Monitor for restocks.`
      : `At or below MSRP — strong value, no hype premium`,
  };
}

/**
 * Build restock intelligence for an item.
 */
export function buildRestockIntelligence(identity = {}, marketPrice = null) {
  const cadence      = resolveRestockCadence(identity);
  const msrpData     = computeResalePremium(identity, marketPrice);

  if (!cadence && !msrpData) return null;

  const restockLikely  = (cadence?.restockProbability ?? 0) >= 0.70;
  const isContinuous   = cadence?.type === "continuous";
  const isGR           = cadence?.type === "gr";
  const isLimited      = cadence?.type === "limited";

  const recommendation = (() => {
    if (isContinuous) return "Always in production — buy directly from retailer for best price";
    if (isGR && msrpData?.worthBuyingAtRetail) return `GR shoe — likely restocking at MSRP ($${msrpData.msrp}). Check Nike/Adidas apps before paying resale.`;
    if (isGR) return `General release — check for restocks before paying resale premium`;
    if (isLimited && msrpData?.premiumPct > 50) return `Limited release with ${msrpData.premiumPct.toFixed(0)}% resale premium — restock unlikely, current resale price is fair`;
    return null;
  })();

  return {
    releaseType:       cadence?.type || "unknown",
    restockProbability:cadence?.restockProbability ?? null,
    avgMonthsBetween:  cadence?.avgMonthsBetweenRestocks ?? null,
    restockLikely,
    msrp:              msrpData,
    recommendation,
    signal: isContinuous
      ? `This is always in production — buy at $${msrpData?.msrp || "MSRP"} from official retailers`
      : isGR && restockLikely
      ? `High restock probability — wait for retail drop at $${msrpData?.msrp || "MSRP"} instead of paying resale`
      : isLimited
      ? `Limited release — ${cadence?.restockProbability ? (cadence.restockProbability * 100).toFixed(0) + "%" : "low"} restock probability`
      : null,
  };
}

/**
 * Master release calendar intelligence payload.
 */
export function buildReleaseCalendarPayload({
  identity     = {},
  scannedPrice = null,
  medianMarket = null,
} = {}) {
  const effectiveMarket = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  const msrpData        = computeResalePremium(identity, effectiveMarket);
  const restockIntel    = buildRestockIntelligence(identity, effectiveMarket);

  return {
    msrp:         msrpData       || null,
    restockIntel: restockIntel   || null,
    topSignal:    restockIntel?.signal || msrpData?.signal || null,
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
