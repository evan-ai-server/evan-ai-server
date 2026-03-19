// src/thriftScannerMode.js
// Thrift Scanner Mode: Redis-backed session engine for in-store scanning runs.
// Tracks all items scanned in a session, maintains a running deal tally,
// and runs a budget optimizer: "You have $200 — buy items 3 and 7 for best ROI."

// ── Redis key schemas ─────────────────────────────────────────────────────────
// thrift:session:{sessionId}        HASH  — session metadata
// thrift:items:{sessionId}          ZSET  — scanned items (score = timestamp)
// thrift:session:user:{userId}      SET   — active session IDs for a user

const KEY_SESSION  = (sid)  => `thrift:session:${sid}`;
const KEY_ITEMS    = (sid)  => `thrift:items:${sid}`;
const KEY_USER_SESSIONS = (uid) => `thrift:session:user:${uid}`;

const SESSION_TTL  = 60 * 60 * 8; // 8 hours — a full shopping trip

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Start a new thrift scanner session.
 */
export async function startThriftSession(redis, userId = "", opts = {}) {
  if (!redis || !userId) return null;

  const sessionId = `ts_${userId}_${Date.now()}`;
  const now       = Date.now();

  const meta = {
    sessionId,
    userId,
    startedAt:  String(now),
    location:   String(opts?.location || ""),
    budget:     String(finiteOrNull(opts?.budget) ?? 0),
    status:     "active",
  };

  const pipeline = redis.pipeline();
  pipeline.hmset(KEY_SESSION(sessionId), meta);
  pipeline.expire(KEY_SESSION(sessionId), SESSION_TTL);
  pipeline.sadd(KEY_USER_SESSIONS(userId), sessionId);
  pipeline.expire(KEY_USER_SESSIONS(userId), SESSION_TTL);
  await pipeline.exec();

  return { sessionId, startedAt: now, ...meta };
}

/**
 * Add a scanned item to a session.
 */
export async function addSessionScan(redis, sessionId = "", scanResult = {}) {
  if (!redis || !sessionId) return null;

  const ts   = Date.now();
  const item = {
    scanId:       `scan_${ts}`,
    title:        scanResult?.visionIdentity?.model || scanResult?.query || "Unknown",
    brand:        scanResult?.visionIdentity?.brand || "",
    category:     scanResult?.category || "",
    scannedPrice: finiteOrNull(scanResult?.scannedPrice ?? scanResult?.bestPrice) ?? 0,
    medianMarket: finiteOrNull(scanResult?.consensus?.median) ?? 0,
    flipScore:    scanResult?.flipScore?.flipScore?.score ?? null,
    verdict:      scanResult?.dealComparator?.verdict || "unknown",
    netProfit:    scanResult?.priceTargets?.targets?.netProfit ?? null,
    roi:          scanResult?.priceTargets?.targets?.roi ?? null,
    ts,
  };

  await redis.zadd(KEY_ITEMS(sessionId), ts, JSON.stringify(item));
  await redis.expire(KEY_ITEMS(sessionId), SESSION_TTL);

  return { added: true, scanId: item.scanId, item };
}

/**
 * Budget optimizer: given a budget, pick the best combination of items to buy.
 * Uses a 0/1 knapsack greedy approach sorted by flip score × savings.
 */
function optimizeForBudget(items = [], budget = 0) {
  if (!budget || !items.length) return { recommended: items, totalCost: 0, totalProfit: 0 };

  // Filter to items that are deals (verdict = steal or good)
  const candidates = items
    .filter(i => i.scannedPrice > 0 && (i.verdict === "steal" || i.verdict === "good" || (i.flipScore ?? 0) >= 55))
    .sort((a, b) => {
      // Sort by efficiency: flip score / price
      const effA = ((a.flipScore ?? 50) * (a.netProfit ?? 0)) / (a.scannedPrice || 1);
      const effB = ((b.flipScore ?? 50) * (b.netProfit ?? 0)) / (b.scannedPrice || 1);
      return effB - effA;
    });

  let remaining = budget;
  const chosen  = [];

  for (const item of candidates) {
    if (item.scannedPrice <= remaining) {
      chosen.push(item);
      remaining -= item.scannedPrice;
    }
  }

  const totalCost   = round2(chosen.reduce((s, i) => s + i.scannedPrice, 0));
  const totalProfit = round2(chosen.reduce((s, i) => s + (i.netProfit ?? 0), 0));

  return { recommended: chosen, totalCost, totalProfit, budgetUsed: totalCost, budgetRemaining: round2(budget - totalCost) };
}

/**
 * Get a live session summary with budget optimization.
 */
export async function getSessionSummary(redis, sessionId = "") {
  if (!redis || !sessionId) return null;

  const [meta, rawItems] = await Promise.all([
    redis.hgetall(KEY_SESSION(sessionId)),
    redis.zrange(KEY_ITEMS(sessionId), 0, -1),
  ]);

  if (!meta) return null;

  const items = rawItems.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  const budget = finiteOrNull(meta?.budget) || 0;

  const deals     = items.filter(i => i.verdict === "steal" || i.verdict === "good");
  const totalFlipPotential = round2(items.reduce((s, i) => s + (i.netProfit ?? 0), 0));
  const topFlip   = [...items].sort((a, b) => (b.flipScore ?? 0) - (a.flipScore ?? 0))[0] || null;

  const budgetOpt = budget > 0 ? optimizeForBudget(items, budget) : null;

  const elapsed   = meta?.startedAt ? Math.round((Date.now() - parseInt(meta.startedAt)) / 60000) : 0;

  return {
    sessionId,
    userId:           meta?.userId || "",
    location:         meta?.location || "",
    budget,
    status:           meta?.status || "active",
    elapsedMinutes:   elapsed,
    totalScans:       items.length,
    items,
    dealCount:        deals.length,
    totalFlipPotential,
    topFlip,
    budgetOptimization: budgetOpt,
    topSignal: items.length
      ? `${items.length} scans — ${deals.length} deal${deals.length !== 1 ? "s" : ""}, $${totalFlipPotential.toFixed(2)} flip potential${budgetOpt ? ` — budget pick: $${budgetOpt.totalCost.toFixed(2)} for $${budgetOpt.totalProfit.toFixed(2)} profit` : ""}`
      : "Session started — start scanning items",
  };
}

/**
 * End a session (mark as complete).
 */
export async function endThriftSession(redis, sessionId = "") {
  if (!redis || !sessionId) return null;
  await redis.hset(KEY_SESSION(sessionId), "status", "completed");
  const summary = await getSessionSummary(redis, sessionId);
  return { ended: true, summary };
}

/**
 * Get all active sessions for a user.
 */
export async function getUserSessions(redis, userId = "") {
  if (!redis || !userId) return [];
  const ids = await redis.smembers(KEY_USER_SESSIONS(userId));
  return ids || [];
}
