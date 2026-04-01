// src/categoryIdentityEngines/tradingCards.js
// Trading Card Identity Engine — Phase 15: Category Immortality.
//
// Scores expertise at game + set + grade tier level.
// Graded cards behave very differently from raw — expertise in one ≠ the other.
//
// Redis keys:
//   catid:tcg:{userId}:game:{game}              HASH (180d TTL)
//   catid:tcg:{userId}:set:{game}:{set}         HASH (180d TTL)
//   catid:tcg:{userId}:grade:{gradeSlug}        HASH (180d TTL) — graded vs. raw

const KEY_GAME  = (uid, game)       => `catid:tcg:${uid}:game:${n(game)}`;
const KEY_SET   = (uid, game, set)  => `catid:tcg:${uid}:set:${n(game)}:${n(set)}`;
const KEY_GRADE = (uid, slug)       => `catid:tcg:${uid}:grade:${n(slug)}`;
const TTL = 180 * 86400;

const GRADED_TIER_SLUGS = new Set(["psa10", "psa9", "bgs95", "bgs9", "cgc10", "cgc9", "graded"]);

function gradeSlug(gradeStr) {
  if (!gradeStr) return "raw";
  const g = String(gradeStr).toLowerCase().replace(/\s+/g, "");
  if (/psa10/.test(g))  return "psa10";
  if (/psa9/.test(g))   return "psa9";
  if (/bgs9\.5/.test(g))return "bgs95";
  if (/bgs9/.test(g))   return "bgs9";
  if (/cgc10/.test(g))  return "cgc10";
  if (/cgc9/.test(g))   return "cgc9";
  if (/graded|slab/.test(g)) return "graded";
  return "raw";
}

// ── Record ─────────────────────────────────────────────────────────────────────

/**
 * Record a realized trading card outcome.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} outcome
 *   game        {string}  e.g. "pokemon", "mtg", "sports"
 *   set         {string}  e.g. "base set", "shadowless", "1st edition"
 *   cardName    {string}  e.g. "charizard", "black lotus"
 *   grade       {string}  e.g. "PSA 10", "ungraded"
 *   isWin       {boolean}
 *   netProfit   {number}
 *   buyPrice    {number}
 */
export async function recordTradingCardOutcome(redis, userId, {
  game      = null,
  set       = null,
  cardName  = null,
  grade     = null,
  isWin     = false,
  netProfit = 0,
  buyPrice  = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const pipe = redis.pipeline();
    const pnl  = Number(netProfit) || 0;
    const slug = gradeSlug(grade);
    const isGraded = GRADED_TIER_SLUGS.has(slug);

    function pipeRecord(key) {
      pipe.hincrby(key,      "tradeCount", 1);
      pipe.hincrby(key,      isWin ? "wins" : "losses", 1);
      pipe.hincrbyfloat(key, "netPnl", pnl);
      pipe.hincrby(key,      isGraded ? "gradedTrades" : "rawTrades", 1);
      if (buyPrice != null) pipe.hincrbyfloat(key, "totalCapital", Number(buyPrice));
      pipe.expire(key, TTL);
    }

    if (game)              pipeRecord(KEY_GAME(userId, game));
    if (game && set)       pipeRecord(KEY_SET(userId, game, set));
    pipeRecord(KEY_GRADE(userId, slug));

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Score ──────────────────────────────────────────────────────────────────────

/**
 * Compute trading card identity score.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} ctx — { game, set, grade }
 */
export async function computeTradingCardIdentityScore(redis, userId, {
  game  = null,
  set   = null,
  grade = null,
} = {}) {
  if (!redis || !userId) return null;
  try {
    const slug = gradeSlug(grade);

    const [gameHash, setHash, gradeHash] = await Promise.all([
      game           ? redis.hgetall(KEY_GAME(userId, game)).catch(() => null)        : null,
      game && set    ? redis.hgetall(KEY_SET(userId, game, set)).catch(() => null)    : null,
      redis.hgetall(KEY_GRADE(userId, slug)).catch(() => null),
    ]);

    const gameDim  = parseDimension(gameHash);
    const setDim   = parseDimension(setHash);
    const gradeDim = parseDimension(gradeHash);

    // Set (50%) > game (30%) > grade (20%)
    let score = 0, totalWeight = 0;
    if (setDim   && setDim.tradeCount   >= 1) { score += setDim.winScore   * 50; totalWeight += 50; }
    if (gameDim  && gameDim.tradeCount  >= 1) { score += gameDim.winScore  * 30; totalWeight += 30; }
    if (gradeDim && gradeDim.tradeCount >= 1) { score += gradeDim.winScore * 20; totalWeight += 20; }

    if (totalWeight === 0) return null;

    const finalScore  = Math.round(score / totalWeight);
    const totalTrades = (setDim?.tradeCount || 0) + (gameDim?.tradeCount || 0);
    const confidence  = totalTrades >= 5 ? "high" : totalTrades >= 2 ? "medium" : "low";
    const isGraded    = GRADED_TIER_SLUGS.has(slug);

    return {
      score:      finalScore,
      confidence,
      gradeSlug:  slug,
      isGraded,
      dimensions: {
        game:  gameDim,
        set:   setDim,
        grade: gradeDim,
      },
      signal: buildSignal({ game, set, grade, slug, score: finalScore, gameDim, setDim, gradeDim, isGraded }),
    };
  } catch { return null; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDimension(h) {
  if (!h || !h.tradeCount) return null;
  const tradeCount  = parseInt(h.tradeCount)  || 0;
  const wins        = parseInt(h.wins)          || 0;
  const netPnl      = parseFloat(h.netPnl)      || 0;
  const gradedTrades = parseInt(h.gradedTrades)  || 0;
  const rawTrades    = parseInt(h.rawTrades)     || 0;
  const winRate     = tradeCount > 0 ? wins / tradeCount : 0;
  const tradeFactor = Math.min(1, tradeCount / 8);
  const winScore    = winRate * 0.65 + tradeFactor * 0.35;
  return { tradeCount, wins, winRate: Math.round(winRate * 100), netPnl: round2(netPnl), gradedTrades, rawTrades, winScore };
}

function buildSignal({ game, set, grade, slug, score, gameDim, setDim, gradeDim, isGraded }) {
  const gameName = game ? game.charAt(0).toUpperCase() + game.slice(1) : "Trading card";
  const setName  = set  ? `${gameName} — ${set}` : gameName;

  if (setDim && setDim.tradeCount >= 3) {
    if (score >= 70) return `Strong ${setName} history — ${setDim.winRate}% win rate on this set.`;
    if (score >= 45) return `Mixed ${setName} results. Verify condition and pop report carefully.`;
    return `You've struggled with ${setName}. Check PSA/BGS pop and current market before buying.`;
  }
  if (gameDim && gameDim.tradeCount >= 3) {
    if (score >= 65) return `Solid ${gameName} trading experience — ${gameDim.winRate}% win rate.`;
    return `Variable ${gameName} results in your history.`;
  }
  if (gradeDim && gradeDim.tradeCount >= 3 && isGraded) {
    if (gradeDim.winRate >= 65) return `You've done well with ${slug.toUpperCase()} slabs — ${gradeDim.winRate}% win rate.`;
    return `Graded card trades have been tricky for you — check pop report and comps.`;
  }
  if (isGraded && (!gradeDim || gradeDim.tradeCount < 2)) {
    return "Graded card — verify slab serial at PSAcard.com or BGSgrades.com before buying.";
  }
  return null;
}

function n(s) { return String(s || "").toLowerCase().trim().slice(0, 60).replace(/\s+/g, "_"); }
function round2(v) { return Math.round(Number(v) * 100) / 100; }
