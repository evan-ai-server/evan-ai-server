  // src/inventoryAutopilot.js
  // Inventory Autopilot — proactive per-item recommendations for resellers                                                                                                                             
  // Runs as a scheduled queue worker; results stored in Redis                                                                                                                                          
                                                                                                                                                                                                        
  const AP_RECS_KEY = (userId) => `autopilot:recs:${userId}`;                                                                                                                                           
  const AP_TTL_SEC  = 48 * 3600; // recommendations expire in 48h                                                                                                                                       
  const AP_MAX_RECS = 50;                                                                                                                                                                               
  
  // ── Action types ──────────────────────────────────────────────────────────────                                                                                                                     
                                                                                                                                                                                                      
  const ACTIONS = {                                                                                                                                                                                     
    list_now:    { label: "List Now",             urgency: "high" },
    lower_price: { label: "Lower Your Price",      urgency: "high" },                                                                                                                                   
    relist:      { label: "Relist This Item",      urgency: "medium" },                                                                                                                                 
    hold:        { label: "Hold — Better Time Soon",urgency: "low" },                                                                                                                                   
    cross_post:  { label: "Cross-Post to More Platforms", urgency: "medium" },                                                                                                                          
    part_out:    { label: "Consider Parting Out",  urgency: "medium" },                                                                                                                                 
    sell_now:    { label: "Sell Now — Price Peaked", urgency: "high" },                                                                                                                                 
  };                                                                                                                                                                                                    
                                                                                                                                                                                                        
  // ── Per-item recommendation logic ─────────────────────────────────────────────                                                                                                                     
                                                                                                                                                                                                      
  /**                                                                                                                                                                                                   
   * @param {object} portfolioItem  - from listPortfolioItems                                                                                                                                         
   * @param {object} opts                                                                                                                                                                               
   * @param {object} opts.liquidityResult   - from computeLiquidityScore
   * @param {number} opts.currentMarketBest - current best price from market                                                                                                                            
   * @param {number} opts.now               - current timestamp                                                                                                                                         
   */                                                                                                                                                                                                   
  export function generateItemRecommendation(portfolioItem, {                                                                                                                                           
    liquidityResult = {},                                                                                                                                                                               
    currentMarketBest = null,                                                                                                                                                                         
    now = Date.now(),                                                                                                                                                                                   
  } = {}) {                                                                                                                                                                                             
    if (!portfolioItem) return null;
                                                                                                                                                                                                        
    const item           = portfolioItem;                                                                                                                                                             
    const holdMs         = now - Number(item.addedAt || now);
    const holdDays       = holdMs / (1000 * 86400);                                                                                                                                                     
    const acqPrice       = Number(item.acquisitionPrice || 0);
    const currentValue   = Number(item.currentValue   || acqPrice);                                                                                                                                     
    const marketBest     = Number(currentMarketBest   || currentValue);                                                                                                                               
    const liqScore       = Number(liquidityResult?.liquidityScore ?? 50);                                                                                                                               
    const tier           = liquidityResult?.tier || "moderate";                                                                                                                                         
    const category       = String(item.category || "").toLowerCase();                                                                                                                                   
    const conditionGrade = String(item.conditionGrade || "B");                                                                                                                                          
    const listingStatus  = item.listingStatus || "unlisted";                                                                                                                                            
                                                                                                                                                                                                      
    const isElectronics = /electron|phone|tablet|laptop|camera/.test(category);                                                                                                                         
    const priceDropped  = marketBest < currentValue * 0.90;                                                                                                                                           
    const priceRose     = marketBest > currentValue * 1.10;                                                                                                                                             
    const isStale       = holdDays > 30 && listingStatus !== "sold";                                                                                                                                  
    const isVeryStale   = holdDays > 60;                                                                                                                                                                
    const isUnlisted    = listingStatus === "unlisted";                                                                                                                                                 
                                                                                                                                                                                                        
    // Priority scoring per action                                                                                                                                                                      
    const scores = {                                                                                                                                                                                  
      list_now:    0,                                                                                                                                                                                   
      lower_price: 0,                                                                                                                                                                                   
      relist:      0,
      hold:        0,                                                                                                                                                                                   
      cross_post:  0,                                                                                                                                                                                   
      part_out:    0,
      sell_now:    0,                                                                                                                                                                                   
    };                                                                                                                                                                                                  
   
    // list_now: unlisted and good liquidity                                                                                                                                                            
    if (isUnlisted) {                                                                                                                                                                                 
      scores.list_now += 30 + (liqScore > 65 ? 20 : 0) + (holdDays < 7 ? 10 : 0);                                                                                                                       
    }                                                                                                                                                                                                   
                                                                                                                                                                                                        
    // sell_now: price has risen significantly                                                                                                                                                          
    if (priceRose && !isUnlisted) {                                                                                                                                                                   
      scores.sell_now += 40 + (liqScore > 60 ? 15 : 0);                                                                                                                                                 
    }                                                                                                                                                                                                   
   
    // lower_price: stale listing AND market price dropped                                                                                                                                              
    if (isStale && priceDropped) {                                                                                                                                                                    
      scores.lower_price += 35 + (isVeryStale ? 20 : 0);                                                                                                                                                
    }                                                                                                                                                                                                   
   
    // relist: very stale, moderate condition                                                                                                                                                           
    if (isVeryStale && listingStatus !== "unlisted") {                                                                                                                                                
      scores.relist += 30 + (tier === "moderate" ? 10 : 0);                                                                                                                                             
    }
                                                                                                                                                                                                        
    // hold: good condition, seasonal potential, not urgent                                                                                                                                           
    if (!isStale && !isVeryStale && ["S","A+","A"].includes(conditionGrade)) {                                                                                                                          
      scores.hold += 20 + (liqScore < 50 ? 15 : 0);                                                                                                                                                     
    }                                                                                                                                                                                                   
                                                                                                                                                                                                        
    // cross_post: moderate liquidity, not cross-posted yet                                                                                                                                             
    if (tier === "moderate" && listingStatus !== "sold") {                                                                                                                                              
      scores.cross_post += 25 + (holdDays > 14 ? 10 : 0);                                                                                                                                               
    }
                                                                                                                                                                                                        
    // part_out: electronics in poor condition                                                                                                                                                          
    if (isElectronics && ["D","F","C"].includes(conditionGrade)) {
      scores.part_out += 35;                                                                                                                                                                            
    }                                                                                                                                                                                                 
                                                                                                                                                                                                        
    const ranked = Object.entries(scores)                                                                                                                                                             
      .sort((a, b) => b[1] - a[1])
      .filter(([, s]) => s > 15);                                                                                                                                                                       
                                                                                                                                                                                                        
    if (!ranked.length) return null;                                                                                                                                                                    
                                                                                                                                                                                                        
    const [topAction] = ranked[0];                                                                                                                                                                      
    const topDef      = ACTIONS[topAction] || {};                                                                                                                                                     
                                                                                                                                                                                                        
    const targetPrice = (() => {
      if (!Number.isFinite(marketBest) || marketBest <= 0) return null;                                                                                                                                 
      if (topAction === "lower_price")  return Math.round(marketBest * 0.92 * 100) / 100;                                                                                                               
      if (topAction === "sell_now")     return Math.round(marketBest * 0.96 * 100) / 100;                                                                                                               
      if (topAction === "list_now")     return Math.round(marketBest * 0.93 * 100) / 100;                                                                                                               
      if (topAction === "relist")       return Math.round(marketBest * 0.90 * 100) / 100;                                                                                                               
      return null;                                                                                                                                                                                      
    })();                                                                                                                                                                                               
                                                                                                                                                                                                      
    const reason = (() => {                                                                                                                                                                             
      if (topAction === "list_now")    return `Item unlisted for ${Math.round(holdDays)} days. Liquidity tier: ${tier}.`;                                                                             
      if (topAction === "sell_now")    return `Market value up ${Math.round((marketBest/currentValue - 1) * 100)}% since you acquired this. Take profit.`;                                              
      if (topAction === "lower_price") return `Market dropped ${Math.round((1 - marketBest/currentValue) * 100)}% and item is ${Math.round(holdDays)}d old. Adjust price.`;                             
      if (topAction === "relist")      return `Item listed ${Math.round(holdDays)} days without sale. Refresh the listing.`;                                                                            
      if (topAction === "hold")        return `Condition strong (${conditionGrade}) but market is slow right now. Hold.`;                                                                               
      if (topAction === "cross_post")  return `Moderate liquidity on current platform. Try additional channels.`;                                                                                       
      if (topAction === "part_out")    return `Electronics in ${conditionGrade} condition sell faster parted out.`;                                                                                     
      return "Review this item.";                                                                                                                                                                       
    })();                                                                                                                                                                                               
                                                                                                                                                                                                        
    return {                                                                                                                                                                                            
      itemId:          item.id,                                                                                                                                                                       
      query:           item.query || item.title || null,                                                                                                                                                
      action:          topAction,                                                                                                                                                                     
      label:           topDef.label || topAction,                                                                                                                                                       
      urgency:         topDef.urgency || "medium",                                                                                                                                                      
      reason,
      targetPrice,                                                                                                                                                                                      
      targetPlatform:  liquidityResult?.fastestPlatform || null,                                                                                                                                      
      holdDays:        Math.round(holdDays),                                                                                                                                                            
      currentValue,                                                                                                                                                                                     
      marketBest:      Number.isFinite(marketBest) ? marketBest : null,
      liquidityScore:  liqScore,                                                                                                                                                                        
      expiresAt:       now + AP_TTL_SEC * 1000,                                                                                                                                                       
      generatedAt:     now,                                                                                                                                                                             
    };                                                                                                                                                                                                
  }                                                                                                                                                                                                     
                                                                                                                                                                                                      
  // ── Store recommendations ─────────────────────────────────────────────────────                                                                                                                     
  
  export async function storeAutopilotRecommendations(redis, userId, recommendations = []) {                                                                                                            
    if (!redis || !userId) return;                                                                                                                                                                    
    const now    = Date.now();                                                                                                                                                                          
    const valid  = recommendations.filter(Boolean).slice(0, AP_MAX_RECS);                                                                                                                               
    const payload = JSON.stringify({ recommendations: valid, updatedAt: now });                                                                                                                         
    await redis.set(AP_RECS_KEY(userId), payload, "EX", AP_TTL_SEC);                                                                                                                                    
  }                                                                                                                                                                                                     
                                                                                                                                                                                                      
  // ── Get recommendations ───────────────────────────────────────────────────────                                                                                                                     
                                                                                                                                                                                                      
  export async function getAutopilotRecommendations(redis, userId) {                                                                                                                                    
    if (!redis || !userId) return null;                                                                                                                                                               
    try {                                                                                                                                                                                               
      const raw = await redis.get(AP_RECS_KEY(userId));                                                                                                                                               
      if (!raw) return null;                                                                                                                                                                            
      return JSON.parse(raw);                                                                                                                                                                           
    } catch {                                                                                                                                                                                           
      return null;                                                                                                                                                                                      
    }                                                                                                                                                                                                 
  }

  // ── Run autopilot for a user (called by queue worker) ────────────────────────                                                                                                                      
  
  export async function runAutopilotForUser(redis, userId, {                                                                                                                                            
    listPortfolioItemsFn,                                                                                                                                                                             
    computeLiquidityScoreFn,                                                                                                                                                                            
    mergeCheapestSourcesFn,                                                                                                                                                                             
  } = {}) {                                                                                                                                                                                             
    if (!redis || !userId) return null;                                                                                                                                                                 
    if (typeof listPortfolioItemsFn !== "function") return null;                                                                                                                                        
                                                                                                                                                                                                        
    const items = await listPortfolioItemsFn(redis, userId, 100);
    if (!items?.length) return { userId, count: 0, recommendations: [] };                                                                                                                               
                                                                                                                                                                                                        
    const now = Date.now();
    const recommendations = [];                                                                                                                                                                         
                                                                                                                                                                                                      
    for (const item of items) {
      if (item.listingStatus === "sold") continue;
                                                                                                                                                                                                        
      // Fetch current market price for this item (cheap: just use cached / internal)                                                                                                                   
      let currentMarketBest = null;                                                                                                                                                                     
      let liquidityResult   = null;                                                                                                                                                                     
                                                                                                                                                                                                      
      if (typeof mergeCheapestSourcesFn === "function" && item.query) {                                                                                                                                 
        try {                                                                                                                                                                                         
          const marketItems = await mergeCheapestSourcesFn(item.query, [], null);                                                                                                                       
          const prices = (marketItems || [])                                                                                                                                                            
            .map((i) => Number(i.totalPrice ?? i.price))                                                                                                                                                
            .filter((n) => Number.isFinite(n) && n > 0)                                                                                                                                                 
            .sort((a, b) => a - b);                                                                                                                                                                     
                                                                                                                                                                                                        
          currentMarketBest = prices.length ? prices[Math.floor(prices.length / 4)] : null; // Q1 price as target                                                                                       
                                                                                                                                                                                                        
          if (typeof computeLiquidityScoreFn === "function") {                                                                                                                                          
            liquidityResult = computeLiquidityScoreFn({                                                                                                                                               
              category:      item.category || "",                                                                                                                                                       
              marketItems:   marketItems || [],                                                                                                                                                         
              visionCondition: item.conditionGrade || "",                                                                                                                                               
            });                                                                                                                                                                                         
          }                                                                                                                                                                                             
        } catch {                                                                                                                                                                                       
          // non-fatal: continue without market data                                                                                                                                                    
        }                                                                                                                                                                                               
      }                                                                                                                                                                                                 
                                                                                                                                                                                                        
      const rec = generateItemRecommendation(item, {                                                                                                                                                  
        liquidityResult:   liquidityResult || {},                                                                                                                                                       
        currentMarketBest,                                                                                                                                                                            
        now,                                                                                                                                                                                            
      });
                                                                                                                                                                                                        
      if (rec) recommendations.push(rec);                                                                                                                                                             
    }                                                                                                                                                                                                   
                                                                                                                                                                                                      
    // Sort by urgency: high → medium → low                                                                                                                                                             
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => (urgencyOrder[a.urgency] ?? 2) - (urgencyOrder[b.urgency] ?? 2));                                                                                                    
                                                                                                                                                                                                        
    await storeAutopilotRecommendations(redis, userId, recommendations);                                                                                                                                
                                                                                                                                                                                                        
    return {                                                                                                                                                                                            
      userId,                                                                                                                                                                                         
      count:           recommendations.length,
      recommendations: recommendations.slice(0, 20),                                                                                                                                                    
      runAt:           now,                                                                                                                                                                             
    };                                                                                                                                                                                                  
  }                                                                                   
