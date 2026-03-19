  // src/exitStrategy.js
  // Exit Strategy Engine — prescriptive "what should I do with this item" intelligence

  const STRATEGY_DEFS = {
    flip_fast_ebay: {
      label:       "Flip Fast on eBay",
      description: "List at competitive price for fast sell-through.",
      platform:    "eBay",
      urgency:     "high",
    },
    hold_for_seasonal_spike: {
      label:       "Hold for Seasonal Spike",
      description: "Demand will rise — hold and relist at peak.",
      platform:    null,
      urgency:     "low",
    },
    list_grailed_premium: {
      label:       "List on Grailed (Premium)",
      description: "Premium streetwear platform; buyers expect higher prices.",
      platform:    "Grailed",
      urgency:     "medium",
    },
    bundle_with_accessory: {
      label:       "Bundle With Accessory",
      description: "Pair with a low-cost add-on to justify higher price.",
      platform:    "eBay",
      urgency:     "medium",
    },
    part_out: {
      label:       "Part Out",
      description: "Sell components individually for higher total return.",
      platform:    "eBay",
      urgency:     "medium",
    },
    local_cash_sale: {
      label:       "Sell Locally for Cash",
      description: "Facebook Marketplace or Craigslist — best for bulky/cheap items.",
      platform:    "Facebook Marketplace",
      urgency:     "high",
    },
    auction_high_engagement: {
      label:       "Run as eBay Auction",
      description: "High-demand item — let buyers bid it up.",
      platform:    "eBay",
      urgency:     "high",
    },
    cross_post_arbitrage: {
      label:       "Cross-Post on Multiple Platforms",
      description: "Maximize exposure; take the first serious offer.",
      platform:    "Multiple",
      urgency:     "medium",
    },
  };

  // ── Strategy scoring ──────────────────────────────────────────────────────────

  function scoreStrategies({
    liquidityScore,
    tier,
    conditionLetterGrade,
    category,
    brand,
    priceMedian,
    listingCount,
    scannedPrice,
    hasKnownBrand,
    isPremiumBrand,
    isElectronics,
    isSneakers,
    isApparel,
  }) {
    const scores = {};

    // flip_fast_ebay
    scores.flip_fast_ebay =
      liquidityScore * 0.45 +
      (tier === "hot" ? 25 : tier === "liquid" ? 15 : tier === "moderate" ? 5 : -10) +
      (["S","A+","A","B+","B"].includes(conditionLetterGrade) ? 12 : -8) +
      (listingCount > 5 ? 8 : 0);                                                                                                                                                                       
   
    // hold_for_seasonal_spike                                                                                                                                                                          
    scores.hold_for_seasonal_spike =                                                                                                                                                                  
      (100 - liquidityScore) * 0.30 +                                                                                                                                                                 
      (isPremiumBrand ? 18 : 0) +                                                                                                                                                                       
      (["S","A+","A"].includes(conditionLetterGrade) ? 10 : 0) +
      (tier === "illiquid" ? 12 : tier === "slow" ? 6 : -8);                                                                                                                                            
                                                                                                                                                                                                        
    // list_grailed_premium                                                                                                                                                                             
    scores.list_grailed_premium =                                                                                                                                                                       
      (isApparel || isSneakers ? 20 : -20) +                                                                                                                                                            
      (isPremiumBrand ? 28 : 0) +                                                                                                                                                                       
      (hasKnownBrand ? 12 : -15) +                                                                                                                                                                    
      (["S","A+","A","B+"].includes(conditionLetterGrade) ? 14 : -10) +                                                                                                                                 
      (Number.isFinite(priceMedian) && priceMedian >= 60 ? 10 : -5);                                                                                                                                  
                                                                                                                                                                                                        
    // bundle_with_accessory                                                                                                                                                                          
    scores.bundle_with_accessory =                                                                                                                                                                      
      (tier === "slow" || tier === "moderate" ? 20 : 5) +                                                                                                                                               
      (Number.isFinite(priceMedian) && priceMedian < 80 ? 12 : 0) +                                                                                                                                     
      (listingCount > 10 ? 8 : 0);                                                                                                                                                                      
                                                                                                                                                                                                        
    // part_out                                                                                                                                                                                         
    scores.part_out =                                                                                                                                                                                 
      (isElectronics ? 30 : -25) +                                                                                                                                                                    
      (["D","F","C"].includes(conditionLetterGrade) ? 28 : -10) +                                                                                                                                       
      (tier === "illiquid" || tier === "slow" ? 15 : -5);                                                                                                                                               
                                                                                                                                                                                                        
    // local_cash_sale                                                                                                                                                                                  
    scores.local_cash_sale =                                                                                                                                                                            
      (Number.isFinite(priceMedian) && priceMedian < 40 ? 25 : 0) +                                                                                                                                   
      (tier === "illiquid" ? 20 : tier === "slow" ? 10 : 0) +                                                                                                                                           
      (["D","F"].includes(conditionLetterGrade) ? 10 : 0);
                                                                                                                                                                                                        
    // auction_high_engagement                                                                                                                                                                          
    scores.auction_high_engagement =                                                                                                                                                                    
      (tier === "hot" ? 30 : tier === "liquid" ? 18 : -10) +                                                                                                                                            
      (isPremiumBrand || isSneakers ? 15 : 0) +                                                                                                                                                         
      (["S","A+","A"].includes(conditionLetterGrade) ? 12 : -5) +                                                                                                                                       
      (listingCount <= 10 ? 8 : 0); // scarcity boosts auctions                                                                                                                                         
                                                                                                                                                                                                        
    // cross_post_arbitrage                                                                                                                                                                             
    scores.cross_post_arbitrage =                                                                                                                                                                       
      (tier === "moderate" ? 22 : tier === "liquid" ? 12 : 0) +                                                                                                                                         
      (hasKnownBrand ? 10 : 5) +                                                                                                                                                                      
      (listingCount >= 4 ? 6 : 0);                                                                                                                                                                      
                                                                                                                                                                                                      
    return scores;                                                                                                                                                                                      
  }                                                                                                                                                                                                   
                                                                                                                                                                                                        
  // ── Price recommendation per strategy ────────────────────────────────────────                                                                                                                      
                                                                                                                                                                                                      
  function strategyPrice(strategyKey, medianPrice, scannedPrice) {                                                                                                                                      
    const m = Number(medianPrice) || 0;                                                                                                                                                               
    if (m <= 0) return null;                                                                                                                                                                            
    const map = {                                                                                                                                                                                       
      flip_fast_ebay:          Math.round(m * 0.88 * 100) / 100,                                                                                                                                        
      hold_for_seasonal_spike: Math.round(m * 1.12 * 100) / 100,                                                                                                                                        
      list_grailed_premium:    Math.round(m * 1.22 * 100) / 100,                                                                                                                                        
      bundle_with_accessory:   Math.round(m * 1.15 * 100) / 100,                                                                                                                                        
      part_out:                Math.round(m * 0.75 * 100) / 100, // total parts value                                                                                                                   
      local_cash_sale:         Math.round(m * 0.80 * 100) / 100,                                                                                                                                        
      auction_high_engagement: Math.round(m * 0.82 * 100) / 100, // auction start                                                                                                                       
      cross_post_arbitrage:    Math.round(m * 0.93 * 100) / 100,                                                                                                                                        
    };                                                                                                                                                                                                  
    return map[strategyKey] ?? null;                                                                                                                                                                    
  }                                                                                                                                                                                                     
                                                                                                                                                                                                      
  // ── Wait weeks for hold strategy ─────────────────────────────────────────────                                                                                                                      
   
  function holdWeeks(category = "") {                                                                                                                                                                   
    const c = category.toLowerCase();                                                                                                                                                                 
    if (c.includes("sneaker") || c.includes("shoe")) return 4;                                                                                                                                          
    if (c.includes("apparel") || c.includes("cloth")) return 6;                                                                                                                                         
    if (c.includes("electron")) return 3;                                                                                                                                                             
    if (c.includes("collect")) return 8;                                                                                                                                                                
    return 5;                                                                                                                                                                                         
  }                                                                                                                                                                                                     
                                                                                                                                                                                                      
  // ── Category helpers ──────────────────────────────────────────────────────────                                                                                                                     
                                                                                                                                                                                                      
  const PREMIUM_BRANDS = new Set([                                                                                                                                                                      
    "gucci","prada","louis vuitton","hermes","chanel","balenciaga","off-white",                                                                                                                       
    "supreme","nike","jordan","adidas","yeezy","new balance","asics","salehe bembury",                                                                                                                  
    "oakley","ray-ban","dior","burberry","versace","fendi","rolex","omega","apple",                                                                                                                     
    "sony","bose","bang & olufsen","leica","canon","nikon",                                                                                                                                             
  ]);                                                                                                                                                                                                   
                                                                                                                                                                                                        
  function isPremium(brand = "") {                                                                                                                                                                      
    return PREMIUM_BRANDS.has((brand || "").toLowerCase().trim());                                                                                                                                    
  }                                                                                                                                                                                                     
   
  // ── Main export ───────────────────────────────────────────────────────────────                                                                                                                     
                                                                                                                                                                                                      
  /**                                                                                                                                                                                                   
   * @param {object} opts
   * @param {object} opts.identity          - vision identity                                                                                                                                           
   * @param {object} opts.liquidityResult   - from computeLiquidityScore                                                                                                                              
   * @param {Array}  opts.marketItems        - live market items                                                                                                                                        
   * @param {object} opts.consensus          - market consensus
   * @param {object} opts.prediction         - flip prediction                                                                                                                                          
   * @param {number} opts.scannedPrice       - price user paid or is seeing                                                                                                                           
   */                                                                                                                                                                                                   
  export function buildExitStrategy({                                                                                                                                                                   
    identity        = {},                                                                                                                                                                               
    liquidityResult = {},                                                                                                                                                                               
    marketItems     = [],                                                                                                                                                                               
    consensus       = {},                                                                                                                                                                             
    prediction      = {},                                                                                                                                                                             
    scannedPrice    = null,                                                                                                                                                                             
  } = {}) {
    const id = identity || {};                                                                                                                                                                          
                                                                                                                                                                                                      
    const category   = String(id.category || id.itemType || "").toLowerCase();                                                                                                                          
    const brand      = String(id.brand || "").toLowerCase();
    const condition  = String(id.condition || "").toLowerCase();                                                                                                                                        
                                                                                                                                                                                                      
    const isElectronics = /electron|phone|tablet|laptop|camera|headphone|speaker/.test(category);                                                                                                       
    const isSneakers    = /shoe|sneaker|boot|footwear/.test(category);
    const isApparel     = /cloth|apparel|shirt|jacket|hoodie|pant|dress/.test(category);                                                                                                                
    const hasKnownBrand = !!id.brand;                                                                                                                                                                   
    const isPremiumBrand= isPremium(id.brand || "");                                                                                                                                                    
                                                                                                                                                                                                        
    const liquidityScore    = Number(liquidityResult?.liquidityScore ?? 50);                                                                                                                            
    const tier              = liquidityResult?.tier || "moderate";                                                                                                                                      
    const medianPrice       = liquidityResult?.medianPrice                                                                                                                                              
      ?? consensus?.medianPrice                                                                                                                                                                       
      ?? prediction?.medianPrice                                                                                                                                                                        
      ?? null;                                                                                                                                                                                          
    const listingCount      = liquidityResult?.listingCount ?? marketItems?.length ?? 0;                                                                                                                
                                                                                                                                                                                                        
    // Condition grade from conditionGrader (if passed through) or fallback to text                                                                                                                     
    const conditionLetterGrade = (() => {
      if (condition.match(/\b(mint|deadstock|nwt|nib)\b/)) return "S";                                                                                                                                  
      if (condition.match(/\b(like\s*new|excellent)\b/))   return "A+";                                                                                                                                 
      if (condition.match(/\b(very\s*good|good)\b/))        return "B+";                                                                                                                                
      if (condition.match(/\b(fair|used|worn)\b/))          return "C";                                                                                                                                 
      if (condition.match(/\b(poor|damaged|broken)\b/))     return "F";                                                                                                                                 
      return "B"; // default middle                                                                                                                                                                     
    })();                                                                                                                                                                                             
                                                                                                                                                                                                        
    const rawScores = scoreStrategies({                                                                                                                                                                 
      liquidityScore, tier, conditionLetterGrade,
      category, brand,                                                                                                                                                                                  
      priceMedian:  medianPrice,                                                                                                                                                                      
      listingCount,
      scannedPrice,                                                                                                                                                                                     
      hasKnownBrand, isPremiumBrand,
      isElectronics, isSneakers, isApparel,                                                                                                                                                             
    });                                                                                                                                                                                               
                                                                                                                                                                                                        
    const ranked = Object.entries(rawScores)                                                                                                                                                            
      .map(([key, rawScore]) => ({
        key,                                                                                                                                                                                            
        score: Math.max(0, Math.min(100, Math.round(rawScore))),                                                                                                                                      
      }))                                                                                                                                                                                               
      .sort((a, b) => b.score - a.score);
                                                                                                                                                                                                        
    const topKey  = ranked[0]?.key;                                                                                                                                                                     
    const topScore= ranked[0]?.score;
    const topDef  = STRATEGY_DEFS[topKey] || {};                                                                                                                                                        
                                                                                                                                                                                                        
    const recommended = {
      strategy:         topKey,                                                                                                                                                                         
      label:            topDef.label || topKey,                                                                                                                                                         
      description:      topDef.description || "",
      targetPlatform:   topDef.platform,                                                                                                                                                                
      targetPrice:      strategyPrice(topKey, medianPrice, scannedPrice),                                                                                                                               
      urgency:          topDef.urgency || "medium",                                                                                                                                                     
      confidence:       Math.round(Math.max(0, Math.min(100, topScore))),                                                                                                                               
      waitWeeks:        topKey === "hold_for_seasonal_spike" ? holdWeeks(category) : null,                                                                                                              
    };                                                                                                                                                                                                  
                                                                                                                                                                                                        
    const alternatives = ranked                                                                                                                                                                         
      .slice(1, 4)                                                                                                                                                                                    
      .filter((r) => r.score > 20)                                                                                                                                                                      
      .map((r) => {                                                                                                                                                                                     
        const def = STRATEGY_DEFS[r.key] || {};                                                                                                                                                         
        return {                                                                                                                                                                                        
          strategy:       r.key,                                                                                                                                                                        
          label:          def.label || r.key,                                                                                                                                                           
          targetPlatform: def.platform,                                                                                                                                                               
          targetPrice:    strategyPrice(r.key, medianPrice, scannedPrice),                                                                                                                              
          urgency:        def.urgency || "medium",
          confidence:     Math.round(r.score),                                                                                                                                                          
          waitWeeks:      r.key === "hold_for_seasonal_spike" ? holdWeeks(category) : null,                                                                                                             
        };
      });                                                                                                                                                                                               
                                                                                                                                                                                                      
    return {
      recommended,
      alternatives,                                                                                                                                                                                     
      scored: true,
      scoredAt: Date.now(),                                                                                                                                                                             
    };                                                                                                                                                                                                
  }

