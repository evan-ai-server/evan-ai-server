// src/authServiceRouter.js
// Authentication Service Router: for high-value items routes to the correct
// third-party authentication service. Computes whether authentication is
// financially worth it based on the price lift it adds vs. the service cost.
// "Authenticate with GOAT ($25) → adds $80 to sale price → net +$55. Worth it."

// ── Auth service registry ─────────────────────────────────────────────────────
const AUTH_SERVICES = {
  goat: {
    label:          "GOAT Authentication",
    url:            "https://www.goat.com/sell",
    categories:     ["sneakers"],
    brands:         [], // all sneaker brands
    cost:           0,   // built into GOAT platform fee
    turnaroundDays: 2,
    priceLiftPct:   12,  // authenticated listings sell for ~12% more on GOAT
    trustScore:     0.95,
    note:           "Built into GOAT platform — no upfront cost, included in 9.5% seller fee",
    requiresShipping: true,
  },
  stockx: {
    label:          "StockX Verification",
    url:            "https://stockx.com/sell",
    categories:     ["sneakers", "apparel", "electronics"],
    brands:         [],
    cost:           0,
    turnaroundDays: 3,
    priceLiftPct:   10,
    trustScore:     0.96,
    note:           "Built into StockX platform — buyers pay a premium for verified listings",
    requiresShipping: true,
  },
  entrupy: {
    label:          "Entrupy Authentication",
    url:            "https://entrupy.com",
    categories:     ["bag"],
    brands:         ["louis vuitton", "lv", "chanel", "gucci", "prada", "hermes", "hermès", "dior", "fendi", "balenciaga", "saint laurent", "ysl"],
    cost:           25,
    turnaroundDays: 1,
    priceLiftPct:   18,
    trustScore:     0.93,
    note:           "AI + microscopy authentication for luxury bags — adds significant buyer confidence",
    requiresShipping: false,
  },
  real_authentication: {
    label:          "Real Authentication",
    url:            "https://www.realauthentication.com",
    categories:     ["bag", "apparel", "sneakers", "eyewear"],
    brands:         [],
    cost:           20,
    turnaroundDays: 2,
    priceLiftPct:   15,
    trustScore:     0.88,
    note:           "Multi-category authentication service — cert adds buyer trust on eBay/Poshmark",
    requiresShipping: false,
  },
  watch_csa: {
    label:          "WatchCSA",
    url:            "https://www.watchcsa.com",
    categories:     ["watch"],
    brands:         [],
    cost:           45,
    turnaroundDays: 5,
    priceLiftPct:   20,
    trustScore:     0.91,
    note:           "Watch authentication + condition report — essential for luxury watches over $500",
    requiresShipping: true,
  },
  chrono24_trusted: {
    label:          "Chrono24 Trusted Seller",
    url:            "https://www.chrono24.com/seller",
    categories:     ["watch"],
    brands:         [],
    cost:           0,
    turnaroundDays: 0,
    priceLiftPct:   12,
    trustScore:     0.90,
    note:           "Chrono24 trusted seller verification — buyers pay more for trusted profiles",
    requiresShipping: false,
  },
  psa: {
    label:          "PSA Grading",
    url:            "https://www.psacard.com",
    categories:     ["collectibles", "cards"],
    brands:         [],
    cost:           30,
    turnaroundDays: 60,
    priceLiftPct:   200,
    trustScore:     0.99,
    note:           "PSA graded cards command massive premiums — worth it for high-grade cards",
    requiresShipping: true,
  },
  fashionphile_auth: {
    label:          "Fashionphile Authentication",
    url:            "https://www.fashionphile.com/sell",
    categories:     ["bag"],
    brands:         ["louis vuitton", "lv", "chanel", "hermes", "hermès"],
    cost:           0,
    turnaroundDays: 7,
    priceLiftPct:   8,
    trustScore:     0.92,
    note:           "Fashionphile in-house authentication — trusted by buyers, no upfront cost",
    requiresShipping: true,
  },
};

// ── Price lift thresholds by category ─────────────────────────────────────────
// Below this price, authentication usually isn't financially worth it
const MIN_AUTH_VALUE_THRESHOLD = {
  sneakers:    150,
  bag:         300,
  watch:       400,
  apparel:     200,
  eyewear:     200,
  default:     200,
};

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Find relevant authentication services for an item.
 */
export function findAuthServices(category = "", brand = "") {
  const cat = String(category || "").toLowerCase().replace(/s$/, "");
  const br  = String(brand    || "").toLowerCase();

  return Object.entries(AUTH_SERVICES)
    .filter(([, svc]) => {
      const catMatch   = svc.categories.includes(cat);
      const brandMatch = svc.brands.length === 0 || svc.brands.some(b => br.includes(b) || b.includes(br));
      return catMatch && brandMatch;
    })
    .map(([key, svc]) => ({ key, ...svc }))
    .sort((a, b) => b.trustScore - a.trustScore);
}

/**
 * Compute whether authentication is financially worth it.
 */
export function computeAuthROI(service = {}, currentPrice = null) {
  const price = finiteOrNull(currentPrice);
  if (!price || !service) return null;

  const priceLift  = round2(price * (service.priceLiftPct / 100));
  const cost       = service.cost || 0;
  const netBenefit = round2(priceLift - cost);
  const roi        = cost > 0 ? round2((netBenefit / cost) * 100) : null;
  const worthIt    = netBenefit > 15; // at least $15 net benefit

  return {
    cost,
    priceLift,
    netBenefit,
    roi,
    worthIt,
    signal: worthIt
      ? `${service.label} ($${cost || "free"}) adds ~$${priceLift.toFixed(2)} to sale price — net +$${netBenefit.toFixed(2)}${roi ? ` (${roi.toFixed(0)}% ROI)` : ""}`
      : `${service.label} adds ~$${priceLift.toFixed(2)} but costs $${cost} — marginal benefit`,
  };
}

/**
 * Build authentication routing for an item.
 */
export function buildAuthRoute(category = "", brand = "", currentPrice = null) {
  const cat       = String(category || "").toLowerCase().replace(/s$/, "");
  const price     = finiteOrNull(currentPrice);
  const minValue  = MIN_AUTH_VALUE_THRESHOLD[cat] ?? MIN_AUTH_VALUE_THRESHOLD.default;
  const services  = findAuthServices(category, brand);

  if (!services.length) {
    return { recommended: null, alternatives: [], isAuthRecommended: false, reason: "No authentication services available for this category" };
  }

  // Authentication only worth recommending above minimum price threshold
  const isAuthRecommended = !price || price >= minValue;

  // Compute ROI for each service
  const withROI = services.map(svc => ({
    ...svc,
    roi: computeAuthROI(svc, price),
  }));

  const worthIt      = withROI.filter(s => s.roi?.worthIt);
  const recommended  = worthIt[0] || withROI[0];

  return {
    recommended,
    alternatives:       withROI.slice(1, 4),
    isAuthRecommended,
    minValueThreshold:  minValue,
    topSignal: isAuthRecommended && recommended?.roi
      ? recommended.roi.signal
      : price && price < minValue
      ? `Item is below $${minValue} — authentication fees likely exceed the price lift`
      : `Authentication available: ${services[0].label}`,
  };
}

/**
 * Master auth service router payload.
 */
export function buildAuthServiceRouterPayload({
  identity         = {},
  category         = "",
  scannedPrice     = null,
  medianMarket     = null,
  authenticityIntel = null,
} = {}) {
  const brand       = identity?.brand || "";
  const price       = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  const authRoute   = buildAuthRoute(category, brand, price);

  // Only surface auth routing if there's a risk signal or high-value item
  const authRisk    = authenticityIntel?.riskTier || "low";
  const isHighRisk  = ["moderate", "high", "extreme"].includes(authRisk);
  const isHighValue = price && price >= (MIN_AUTH_VALUE_THRESHOLD[String(category || "").toLowerCase().replace(/s$/, "")] ?? 200);

  return {
    authRoute:          authRoute,
    isAuthRecommended:  authRoute.isAuthRecommended && (isHighRisk || isHighValue),
    authRiskTier:       authRisk,
    topSignal: (isHighRisk || isHighValue) ? authRoute.topSignal : null,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function round2(v) { return Math.round(v * 100) / 100; }
