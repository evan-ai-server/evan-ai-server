  // src/liquidityEngine.js
  // Resale Liquidity Score — how fast does this item sell, on which platform, at what price

  // ── Category base scores ─────────────────────────────────────────────────────

  const CATEGORY_BASE_LIQUIDITY = {
    sneakers:    72,
    footwear:    68,
    apparel:     55,
    clothing:    55,
    eyewear:     50,
    electronics: 65,
    collectibles:45,
    watches:     60,
    bags:        52,
    handbags:    52,
    toys:        48,
    default:     50,
  };

  // ── Fastest platforms per category ───────────────────────────────────────────

  const CATEGORY_PLATFORMS = {
    sneakers:    { fast: "eBay",    premium: "StockX", local: "Facebook Marketplace" },
    apparel:     { fast: "eBay",    premium: "Grailed", local: "Facebook Marketplace" },
    clothing:    { fast: "eBay",    premium: "Grailed", local: "Facebook Marketplace" },
    eyewear:     { fast: "eBay",    premium: "eBay",    local: "Facebook Marketplace" },
    electronics: { fast: "eBay",    premium: "eBay",    local: "Craigslist" },
    collectibles:{ fast: "eBay",    premium: "eBay",    local: "Facebook Marketplace" },
    watches:     { fast: "eBay",    premium: "Chrono24",local: "Facebook Marketplace" },
    bags:        { fast: "eBay",    premium: "Poshmark", local: "Facebook Marketplace" },
    handbags:    { fast: "Poshmark",premium: "The RealReal", local: "Facebook Marketplace" },
    default:     { fast: "eBay",    premium: "eBay",    local: "Facebook Marketplace" },
  };

  // ── Resolve category key ─────────────────────────────────────────────────────

  function resolveCategoryKey(category = "") {
    const c = String(category || "").toLowerCase().trim();
    if (c.includes("shoe") || c.includes("sneaker") || c.includes("boot") || c.includes("footwear")) return "sneakers";
    if (c.includes("glass") || c.includes("eyewear") || c.includes("sunglass") || c.includes("frame") || c.includes("lens")) return "eyewear";
    if (c.includes("cloth") || c.includes("apparel") || c.includes("shirt") || c.includes("jacket") || c.includes("hoodie") || c.includes("pant") || c.includes("dress")) return "apparel";
    if (c.includes("electron") || c.includes("phone") || c.includes("tablet") || c.includes("laptop") || c.includes("camera") || c.includes("headphone") || c.includes("speaker")) return "electronics";
    if (c.includes("watch")) return "watches";
    if (c.includes("handbag") || c.includes("purse")) return "handbags";
    if (c.includes("bag") || c.includes("backpack") || c.includes("tote")) return "bags";
    if (c.includes("collectible") || c.includes("toy") || c.includes("card") || c.includes("figure") || c.includes("vintage")) return "collectibles";
    if (CATEGORY_BASE_LIQUIDITY[c]) return c;
    return "default";
  }

  // ── Condition text → liquidity modifier ──────────────────────────────────────

  function conditionToLiquidityMod(conditionText = "", conditionGrade = null) {
    // Use structured grade first
    if (conditionGrade?.letterGrade) {
      const mods = { "S": 18, "A+": 14, "A": 10, "B+": 6, "B": 2, "C+": -4, "C": -10, "D": -18, "F": -28 };
      return mods[conditionGrade.letterGrade] ?? 0;
    }
    // Fall back to condition text from vision
    const text = String(conditionText || "").toLowerCase();
    if (/\b(mint|new|deadstock|ds|nwt|nib)\b/.test(text)) return 15;
    if (/\b(like\s*new|excellent|lightly?\s*used)\b/.test(text)) return 10;
    if (/\b(good|very\s*good)\b/.test(text)) return 4;
    if (/\b(fair|worn|used)\b/.test(text)) return -4;
    if (/\b(poor|damaged|broken|parts)\b/.test(text)) return -20;
    return 0;
  }

  // ── Price point modifier ─────────────────────────────────────────────────────

  function priceToLiquidityMod(medianPrice) {
    if (!Number.isFinite(medianPrice) || medianPrice <= 0) return 0;
    if (medianPrice < 25)  return 16;
    if (medianPrice < 50)  return 12;
    if (medianPrice < 100) return 8;
    if (medianPrice < 200) return 3;
    if (medianPrice < 400) return -2;
    if (medianPrice < 700) return -8;
    return -14;
  }

  // ── Listing count modifier ────────────────────────────────────────────────────

  function listingCountToMod(count) {
    if (count <= 0)  return -18;
    if (count <= 3)  return -10;
    if (count <= 8)  return -4;
    if (count <= 20) return 0;
    if (count <= 40) return 5;
    return 8;
  }

  // ── Graph velocity modifier ───────────────────────────────────────────────────

  function velocityToMod(medianDaysToSell) {
    if (!Number.isFinite(medianDaysToSell)) return 0;
    if (medianDaysToSell < 2)  return 22;
    if (medianDaysToSell < 4)  return 16;
    if (medianDaysToSell < 7)  return 8;
    if (medianDaysToSell < 14) return 0;
    if (medianDaysToSell < 30) return -10;
    return -20;
  }

  // ── Tier label ────────────────────────────────────────────────────────────────

  function scoreToTier(score) {
    if (score >= 82) return "hot";
    if (score >= 66) return "liquid";
    if (score >= 48) return "moderate";
    if (score >= 30) return "slow";
    return "illiquid";
  }

  // ── Price targets ─────────────────────────────────────────────────────────────

  function buildPriceTargets(medianPrice) {
    if (!Number.isFinite(medianPrice) || medianPrice <= 0) {
      return { priceToClearIn48h: null, priceToClearIn7d: null, priceToClearIn30d: null };
    }
    return {
      priceToClearIn48h: Math.round(medianPrice * 0.80 * 100) / 100,
      priceToClearIn7d:  Math.round(medianPrice * 0.90 * 100) / 100,
      priceToClearIn30d: Math.round(medianPrice * 0.98 * 100) / 100,
    };
  }

  // ── Main export ───────────────────────────────────────────────────────────────

  /**
   * @param {object} opts
   * @param {string} opts.category          - item category string
   * @param {Array}  opts.marketItems        - live market items from mergeCheapestSources
   * @param {object} opts.conditionGrade     - from conditionGrader (or null)
   * @param {string} opts.visionCondition    - raw condition string from vision identity
   * @param {number} opts.priceMedian        - override median price (or computed from items)
   * @param {object} opts.graphData          - from queryResaleGraph (or null)
   */
  export function computeLiquidityScore({
    category        = "",
    marketItems     = [],
    conditionGrade  = null,
    visionCondition = "",
    priceMedian     = null,
    graphData       = null,
  } = {}) {
    const catKey    = resolveCategoryKey(category);
    const base      = CATEGORY_BASE_LIQUIDITY[catKey] ?? CATEGORY_BASE_LIQUIDITY.default;
    const platforms = CATEGORY_PLATFORMS[catKey]     ?? CATEGORY_PLATFORMS.default;

    const items  = Array.isArray(marketItems) ? marketItems.filter(Boolean) : [];
    const prices = items
      .map((i) => Number(i.totalPrice ?? i.price))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);

    const computedMedian = prices.length
      ? prices[Math.floor(prices.length / 2)]
      : null;

    const median = Number.isFinite(priceMedian) && priceMedian > 0
      ? priceMedian
      : computedMedian;

    const condMod  = conditionToLiquidityMod(visionCondition, conditionGrade);
    const priceMod = priceToLiquidityMod(median);
    const countMod = listingCountToMod(items.length);
    const velMod   = velocityToMod(graphData?.medianDaysToSell ?? null);

    const raw   = base + condMod + priceMod + countMod + velMod;
    const score = Math.round(Math.max(0, Math.min(100, raw)));
    const tier  = scoreToTier(score);

    const priceTargets = buildPriceTargets(median);

    // Platform selection: if graph data shows a platform with more sold comps, prefer it
    let fastestPlatform = platforms.fast;
    if (graphData?.soldPrices?.length) {
      const platformCounts = {};
      for (const sp of graphData.soldPrices) {
        if (sp?.platform) {
          platformCounts[sp.platform] = (platformCounts[sp.platform] || 0) + 1;
        }
      }
      const topPlatform = Object.entries(platformCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (topPlatform) fastestPlatform = topPlatform;
    }

    const medianDaysToSell = graphData?.medianDaysToSell
      ?? (score >= 80 ? 3 : score >= 65 ? 7 : score >= 48 ? 14 : score >= 30 ? 28 : 60);

    return {
      liquidityScore:  score,
      tier,
      fastestPlatform,
      premiumPlatform: platforms.premium,
      localPlatform:   platforms.local,
      medianDaysToSell,
      medianPrice:     median ?? null,
      listingCount:    items.length,
      categoryKey:     catKey,
      ...priceTargets,
      scored: true,
    };
  }

