  // src/scanReplay.js
  // Self-Improving Scan Replay — every scan session is recorded and replayable                                                                                                                         
  // Powers: failure analysis, prompt improvement, heuristic tuning                                                                                                                                     
                                                                                                                                                                                                        
  const REPLAY_TTL_SEC  = () => Number(process.env.SCAN_REPLAY_MAX_AGE_DAYS    || 180) * 86400;                                                                                                         
  const MAX_USER_SCANS  = 500;                                                                                                                                                                          
  const MAX_FAILURE_LOG = 2000;                                                                                                                                                                         
                                                                                                                                                                                                        
  const RR_KEY         = (scanId)  => `scan_replay:${scanId}`;                                                                                                                                          
  const RR_USER_KEY    = (userId)  => `scan_replay:user:${userId}`;                                                                                                                                     
  const RR_FAIL_KEY    = ()        => `scan_replay:failures`;                                                                                                                                           
  const RR_OUTCOME_KEY = (scanId)  => `scan_replay:outcome:${scanId}`;                                                                                                                                  
                                                                                                                                                                                                        
  // ── Record a full scan session ────────────────────────────────────────────────                                                                                                                     
                                                                                                                                                                                                        
  export async function recordScanReplay(redis, {                                                                                                                                                       
    scanId,                                                                                                                                                                                           
    userId        = null,
    imageHash     = null,                                                                                                                                                                               
    query         = null,                                                                                                                                                                               
    visionResult  = null,                                                                                                                                                                               
    serialResult  = null,                                                                                                                                                                               
    conditionGrade= null,                                                                                                                                                                               
    attributeCertainty = null,
    marketItems   = [],                                                                                                                                                                                 
    mode          = "item",                                                                                                                                                                             
    plan          = "free",                                                                                                                                                                             
  }) {                                                                                                                                                                                                  
    if (!redis || !scanId) return null;                                                                                                                                                                 
                                                                                                                                                                                                        
    const now    = Date.now();                                                                                                                                                                          
    const ttl    = REPLAY_TTL_SEC();                                                                                                                                                                    
    const record = {                                                                                                                                                                                    
      scanId,                                                                                                                                                                                         
      userId:           userId       || null,                                                                                                                                                           
      imageHash:        imageHash    || null,
      query:            query        || null,                                                                                                                                                           
      mode,                                                                                                                                                                                             
      plan,
      visionConfidence: Number(visionResult?.confidence || 0),                                                                                                                                          
      identityBrand:    visionResult?.identity?.brand    || null,                                                                                                                                     
      identityModel:    visionResult?.identity?.model    || null,                                                                                                                                       
      identityCategory: visionResult?.identity?.category || null,
      serialParsed:     serialResult?.ok  ? serialResult.parsed : null,                                                                                                                                 
      serialRedFlags:   serialResult?.redFlags || [],                                                                                                                                                   
      conditionGrade:   conditionGrade?.letterGrade  || null,                                                                                                                                           
      conditionScore:   conditionGrade?.composite    || null,                                                                                                                                           
      attributeCertainty,                                                                                                                                                                               
      marketItemCount:  Array.isArray(marketItems) ? marketItems.length : 0,                                                                                                                            
      outcome:          null,  // filled by markScanOutcome                                                                                                                                           
      replayFlags:      [],                                                                                                                                                                             
      recordedAt:       now,                                                                                                                                                                            
      updatedAt:        now,                                                                                                                                                                            
    };                                                                                                                                                                                                  
                                                                                                                                                                                                      
    const pipeline = redis.pipeline();
    pipeline.set(RR_KEY(scanId), JSON.stringify(record), "EX", ttl);
                                                                                                                                                                                                        
    if (userId) {
      pipeline.zadd(RR_USER_KEY(userId), now, scanId);                                                                                                                                                  
      pipeline.zremrangebyrank(RR_USER_KEY(userId), 0, -(MAX_USER_SCANS + 1));                                                                                                                          
      pipeline.expire(RR_USER_KEY(userId), ttl);                                                                                                                                                        
    }                                                                                                                                                                                                   
                                                                                                                                                                                                        
    await pipeline.exec();                                                                                                                                                                              
    return scanId;
  }                                                                                                                                                                                                     
                                                                                                                                                                                                      
  // ── Mark outcome on an existing replay ───────────────────────────────────────                                                                                                                      
  // outcome: "correct" | "wrong_id" | "sold" | "unsold" | "confirmed" | "reported_fake" | "confirmed_authentic"                                                                                      
                                                                                                                                                                                                        
  export async function markScanOutcome(redis, scanId, outcome, meta = {}) {                                                                                                                          
    if (!redis || !scanId || !outcome) return null;                                                                                                                                                     
                                                                                                                                                                                                        
    const raw = await redis.get(RR_KEY(scanId));
    if (!raw) return null;                                                                                                                                                                              
                                                                                                                                                                                                      
    let record;                                                                                                                                                                                         
    try { record = JSON.parse(raw); } catch { return null; }
                                                                                                                                                                                                        
    const failed = ["wrong_id", "reported_fake", "unsold"].includes(outcome);                                                                                                                           
    const now    = Date.now();
                                                                                                                                                                                                        
    record.outcome   = outcome;                                                                                                                                                                         
    record.updatedAt = now;
    record.outcomeMeta = meta || {};                                                                                                                                                                    
                                                                                                                                                                                                      
    if (failed) {
      record.replayFlags = [...(record.replayFlags || []), `outcome_${outcome}`];
    }                                                                                                                                                                                                   
  
    const ttl      = REPLAY_TTL_SEC();                                                                                                                                                                  
    const pipeline = redis.pipeline();                                                                                                                                                                
    pipeline.set(RR_KEY(scanId), JSON.stringify(record), "EX", ttl);                                                                                                                                    
                                                                                                                                                                                                        
    if (failed) {
      pipeline.zadd(RR_FAIL_KEY(), now, scanId);                                                                                                                                                        
      pipeline.zremrangebyrank(RR_FAIL_KEY(), 0, -(MAX_FAILURE_LOG + 1));                                                                                                                             
      pipeline.expire(RR_FAIL_KEY(), ttl);                                                                                                                                                              
    }
                                                                                                                                                                                                        
    await pipeline.exec();                                                                                                                                                                              
    return record;
  }                                                                                                                                                                                                     
                                                                                                                                                                                                      
  // ── Get a single replay ───────────────────────────────────────────────────────                                                                                                                     
  
  export async function getScanReplay(redis, scanId) {                                                                                                                                                  
    if (!redis || !scanId) return null;                                                                                                                                                               
    try {
      const raw = await redis.get(RR_KEY(scanId));
      return raw ? JSON.parse(raw) : null;                                                                                                                                                              
    } catch {
      return null;                                                                                                                                                                                      
    }                                                                                                                                                                                                 
  }

  // ── Get user scan history ─────────────────────────────────────────────────────                                                                                                                     
  
  export async function getUserScanReplays(redis, userId, limit = 50) {                                                                                                                                 
    if (!redis || !userId) return [];                                                                                                                                                                 
    try {                                                                                                                                                                                               
      const ids = await redis.zrevrange(RR_USER_KEY(userId), 0, limit - 1);                                                                                                                           
      if (!ids?.length) return [];
                                                                                                                                                                                                        
      const pipeline = redis.pipeline();
      for (const id of ids) pipeline.get(RR_KEY(id));                                                                                                                                                   
      const results = await pipeline.exec();                                                                                                                                                            
  
      return results                                                                                                                                                                                    
        .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })                                                                                                    
        .filter(Boolean);                                                                                                                                                                               
    } catch {                                                                                                                                                                                           
      return [];                                                                                                                                                                                        
    }                                                                                                                                                                                                   
  }                                                                                                                                                                                                   

  // ── Record structured buy/sell outcome for a scan ───────────────────────────
  // Stores real-world purchase/sale data linked to a scan for calibration.

  const RR_BUY_OUTCOME_KEY = (scanId) => `scan_buy_outcome:${scanId}`;
  const BUY_OUTCOME_TTL_SEC = 365 * 86400; // 1 year

  export async function recordBuyOutcome(redis, scanId, {
    didBuy    = false,
    buyPrice  = null,
    didSell   = false,
    sellPrice = null,
    soldAt    = null,
    notes     = null,
    source    = null,
  } = {}) {
    if (!redis || !scanId) return null;

    const now = Date.now();
    const record = {
      scanId,
      didBuy:     !!didBuy,
      buyPrice:   buyPrice  != null ? Number(buyPrice)  : null,
      didSell:    !!didSell,
      sellPrice:  sellPrice != null ? Number(sellPrice) : null,
      soldAt:     soldAt    != null ? Number(soldAt)    : null,
      notes:      notes  ? String(notes).slice(0, 500)  : null,
      source:     source ? String(source).slice(0, 80)  : null,
      recordedAt: now,
      updatedAt:  now,
    };

    await redis.set(RR_BUY_OUTCOME_KEY(scanId), JSON.stringify(record), "EX", BUY_OUTCOME_TTL_SEC);

    // Patch the replay record so buyOutcome is co-located for analysis
    try {
      const raw = await redis.get(RR_KEY(scanId));
      if (raw) {
        const replay   = JSON.parse(raw);
        replay.buyOutcome = {
          didBuy: record.didBuy, buyPrice: record.buyPrice,
          didSell: record.didSell, sellPrice: record.sellPrice,
        };
        replay.updatedAt = now;
        await redis.set(RR_KEY(scanId), JSON.stringify(replay), "EX", REPLAY_TTL_SEC());
      }
    } catch {}

    return record;
  }

  export async function getBuyOutcome(redis, scanId) {
    if (!redis || !scanId) return null;
    try {
      const raw = await redis.get(RR_BUY_OUTCOME_KEY(scanId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ── Store rescan verdict (verdict drift tracking) ────────────────────────────
  // Records a refreshed buySignal on a scan so users can compare original vs current.

  const RR_RESCAN_KEY = (scanId) => `scan_rescan:${scanId}`;

  export async function storeRescanVerdict(redis, scanId, {
    currentBuySignal  = null,
    currentPriceStats = null,
    currentReasoning  = null,
  } = {}) {
    if (!redis || !scanId) return null;

    // Load original verdict from replay
    let originalBuySignal = null;
    try {
      const raw = await redis.get(RR_KEY(scanId));
      if (raw) {
        const replay = JSON.parse(raw);
        originalBuySignal = replay?.buySignal || null;
      }
    } catch {}

    const now = Date.now();
    const record = {
      scanId,
      originalBuySignal,
      currentBuySignal,
      verdictChanged:    originalBuySignal !== null && currentBuySignal !== null && originalBuySignal !== currentBuySignal,
      verdictDelta:      originalBuySignal && currentBuySignal
        ? `${originalBuySignal} → ${currentBuySignal}`
        : null,
      currentPriceStats: currentPriceStats || null,
      currentReasoning:  currentReasoning  || null,
      refreshedAt:       now,
    };

    await redis.set(RR_RESCAN_KEY(scanId), JSON.stringify(record), "EX", REPLAY_TTL_SEC());
    return record;
  }

  export async function getRescanVerdict(redis, scanId) {
    if (!redis || !scanId) return null;
    try {
      const raw = await redis.get(RR_RESCAN_KEY(scanId));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ── Get recent failure scans (for analysis) ───────────────────────────────────                                                                                                                     
  
  export async function getFailureScanIds(redis, limit = 100) {                                                                                                                                         
    if (!redis) return [];                                                                                                                                                                            
    try {                                                                                                                                                                                               
      return await redis.zrevrange(RR_FAIL_KEY(), 0, limit - 1);                                                                                                                                      
    } catch {
      return [];
    }
  }                                                                                                                                                                                                     
  
  // ── Analyze failure patterns (called by batch worker) ────────────────────────                                                                                                                      
                                                                                                                                                                                                      
  export async function analyzeFailurePatterns(redis, limit = 200) {                                                                                                                                    
    if (!redis) return null;                                                                                                                                                                          

    const failIds = await getFailureScanIds(redis, limit);                                                                                                                                              
    if (!failIds.length) return { analyzed: 0, patterns: {} };
                                                                                                                                                                                                        
    const pipeline = redis.pipeline();                                                                                                                                                                
    for (const id of failIds) pipeline.get(RR_KEY(id));                                                                                                                                                 
    const results = await pipeline.exec();                                                                                                                                                              
  
    const records = results                                                                                                                                                                             
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })                                                                                                      
      .filter(Boolean);                                                                                                                                                                                 
  
    const patterns = {                                                                                                                                                                                  
      lowConfidenceFailures:     0,                                                                                                                                                                   
      brandOverconfidence:       0,                                                                                                                                                                     
      modelOverconfidence:       0,                                                                                                                                                                     
      serialMismatch:            0,                                                                                                                                                                     
      conditionMisread:          0,                                                                                                                                                                     
      noMarketComps:             0,                                                                                                                                                                   
      eyewearCategoryDrift:      0,                                                                                                                                                                     
      totalAnalyzed:             records.length,                                                                                                                                                        
    };                                                                                                                                                                                                  
                                                                                                                                                                                                        
    for (const r of records) {                                                                                                                                                                          
      if (r.visionConfidence < 0.55)                                 patterns.lowConfidenceFailures++;                                                                                                
      if (r.attributeCertainty?.brand   > 0.85 && r.outcome === "wrong_id") patterns.brandOverconfidence++;                                                                                             
      if (r.attributeCertainty?.model   > 0.85 && r.outcome === "wrong_id") patterns.modelOverconfidence++;                                                                                             
      if (r.serialRedFlags?.length > 0)                              patterns.serialMismatch++;                                                                                                         
      if (r.conditionGrade === "F" && r.outcome === "unsold")        patterns.conditionMisread++;                                                                                                       
      if (r.marketItemCount === 0)                                   patterns.noMarketComps++;                                                                                                          
      if (r.identityCategory === "eyewear" && r.outcome === "wrong_id") patterns.eyewearCategoryDrift++;                                                                                                
    }                                                                                                                                                                                                   
                                                                                                                                                                                                        
    return {                                                                                                                                                                                            
      analyzed: records.length,                                                                                                                                                                       
      patterns,
      analyzedAt: Date.now(),
    };                                                                                                                                                                                                  
  }
                                                       
