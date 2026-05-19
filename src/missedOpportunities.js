// src/missedOpportunities.js
// "You Missed This" Loop — surfaces deals that were available but passed on.
// Creates learning moments: what signals to watch, what to do differently.
// Motivates users to set alerts and act faster on future STRONG BUY signals.

// ── Redis key schema ──────────────────────────────────────────────────────────
// missed:user:{userId}        ZSET  — missedId scored by detectedAt timestamp
// missed:item:{missedId}      STRING — missed opportunity record

const KEY_USER_MISSED = (uid)     => `missed:user:${uid}`;
const KEY_MISSED_ITEM = (missedId) => `missed:item:${missedId}`;

const MISSED_TTL   = 60 * 86400;  // 60 days
const MAX_MISSED   = 100;

// ── Detect & Store ────────────────────────────────────────────────────────────

/**
 * Detect if a scan result represents a missed opportunity.
 * A missed opportunity is when:
 *   1. Buy signal was STRONG BUY or GOOD DEAL
 *   2. User passed on it (didBuy = false on outcome)
 *   3. OR a discovery opportunity expired without action (stale > 48h, was STRONG BUY)
 */
export function detectMissedOpportunity({
  scanId        = null,
  buySignal     = null,
  dealStrength  = 0,
  priceStats    = null,
  category      = "",
  brand         = "",
  model         = "",
  query         = null,
  didBuy        = false,
  passReason    = null,  // reason user gave for passing, if any
  scannedPrice  = null,
  source        = "scan",
}) {
  // Only track strong signals that were passed on
  if (!["STRONG BUY", "GOOD DEAL"].includes(buySignal)) return null;
  if (didBuy) return null;

  const potentialProfit = priceStats?.median && scannedPrice
    ? round2(priceStats.median - scannedPrice)
    : null;

  const missedGrade = buySignal === "STRONG BUY" ? "A"
                    : dealStrength >= 0.25        ? "B+"
                    : dealStrength >= 0.15        ? "B"
                    : "C+";

  const lesson = buildLesson({ buySignal, dealStrength, priceStats, scannedPrice, category });

  return {
    type:            "missed_deal",
    scanId,
    source,
    category,
    brand,
    model,
    query,
    buySignal,
    missedGrade,
    dealStrength:    round2(dealStrength || 0),
    scannedPrice:    scannedPrice ?? null,
    marketMedian:    priceStats?.median ?? null,
    potentialProfit,
    passReason:      passReason || null,
    lesson,
    detectedAt:      Date.now(),
  };
}

/**
 * Store a missed opportunity for a user.
 */
export async function storeMissedOpportunity(redis, userId, missedData) {
  if (!redis || !userId || !missedData) return null;

  const missedId = `miss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record   = { missedId, userId, ...missedData };

  const pipeline = redis.pipeline();
  pipeline.set(KEY_MISSED_ITEM(missedId), JSON.stringify(record), "EX", MISSED_TTL);
  pipeline.zadd(KEY_USER_MISSED(userId), record.detectedAt || Date.now(), missedId);
  pipeline.zremrangebyrank(KEY_USER_MISSED(userId), 0, -(MAX_MISSED + 1));
  pipeline.expire(KEY_USER_MISSED(userId), MISSED_TTL);
  await pipeline.exec();

  return record;
}

/**
 * List missed opportunities for a user.
 */
export async function listMissedOpportunities(redis, userId, limit = 20) {
  if (!redis || !userId) return [];
  try {
    const ids = await redis.zrevrange(KEY_USER_MISSED(userId), 0, limit - 1);
    if (!ids?.length) return [];

    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.get(KEY_MISSED_ITEM(id));
    const results = await pipeline.exec();

    return results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build a display card for a missed opportunity.
 */
export function buildMissedOpportunityCard(missed) {
  if (!missed) return null;

  const title = [missed.brand, missed.model].filter(Boolean).join(" ")
    || missed.query
    || missed.category
    || "Item";

  const ageHours = missed.detectedAt
    ? Math.round((Date.now() - missed.detectedAt) / 3600000)
    : null;

  const ageLabel = ageHours === null   ? ""
                 : ageHours < 1        ? "Just now"
                 : ageHours < 24       ? `${ageHours}h ago`
                 : `${Math.floor(ageHours / 24)}d ago`;

  const profitDisplay = missed.potentialProfit != null
    ? (missed.potentialProfit > 0 ? `+$${missed.potentialProfit.toFixed(2)} potential profit` : null)
    : null;

  const urgencyLabel = missed.buySignal === "STRONG BUY" ? "You passed on a STRONG BUY" : "You passed on a GOOD DEAL";

  return {
    missedId:       missed.missedId,
    title,
    ageLabel,
    urgencyLabel,
    buySignal:      missed.buySignal,
    missedGrade:    missed.missedGrade,
    category:       missed.category || "",
    scannedPrice:   missed.scannedPrice,
    marketMedian:   missed.marketMedian,
    potentialProfit: missed.potentialProfit,
    profitDisplay,
    dealStrength:   missed.dealStrength,
    lesson:         missed.lesson,
    passReason:     missed.passReason,
    callToAction:   buildMissedCTA(missed),
    detectedAt:     missed.detectedAt,
    source:         missed.source || "scan",
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildLesson({ buySignal, dealStrength, priceStats, scannedPrice, category }) {
  if (buySignal === "STRONG BUY") {
    return {
      headline: "All 6 buy conditions were met — this was a clear signal",
      insight:  dealStrength >= 0.30
        ? `Price was ${Math.round(dealStrength * 100)}% below market median — a rare deal`
        : "Market data, confidence, demand, and deal strength all aligned",
      tip:      "Set a price alert in your watchlist so you don't miss the next one",
      action:   "Set Alert",
    };
  }
  if (dealStrength >= 0.20) {
    return {
      headline: `${Math.round(dealStrength * 100)}% below market — solid margin potential`,
      insight:  priceStats?.median && scannedPrice
        ? `Market median was $${priceStats.median.toFixed(2)}, item was at $${scannedPrice.toFixed(2)}`
        : "Good deal signal — price was meaningfully below market",
      tip:      "Next time you see a GOOD DEAL in " + (category || "this category") + ", act faster",
      action:   "Set Category Alert",
    };
  }
  return {
    headline: "You had a good buy signal — you passed",
    insight:  "Market conditions were favorable at the time",
    tip:      "Review what held you back — was it price, condition, or uncertainty?",
    action:   "Review Decision",
  };
}

function buildMissedCTA(missed) {
  if (missed.buySignal === "STRONG BUY") {
    return { label: "Set alert for next one", action: "set_alert", category: missed.category };
  }
  return { label: "Find similar deals", action: "search_category", category: missed.category };
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}
