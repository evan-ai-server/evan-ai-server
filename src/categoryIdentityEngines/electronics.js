// src/categoryIdentityEngines/electronics.js
// Electronics Identity Engine — Phase 15: Category Immortality.
//
// Scores expertise at brand + product line + storage tier level.
// Electronics have fast depreciation curves — expertise here means knowing
// when a model is at the bottom of its depreciation vs. still falling.
//
// Redis keys:
//   catid:electronics:{userId}:brand:{brand}              HASH (180d TTL)
//   catid:electronics:{userId}:line:{brand}:{line}        HASH (180d TTL)
//   catid:electronics:{userId}:model:{brand}:{model}:{gb} HASH (180d TTL)

const KEY_BRAND = (uid, brand)             => `catid:electronics:${uid}:brand:${n(brand)}`;
const KEY_LINE  = (uid, brand, line)       => `catid:electronics:${uid}:line:${n(brand)}:${n(line)}`;
const KEY_MODEL = (uid, brand, model, gb)  => `catid:electronics:${uid}:model:${n(brand)}:${n(model)}:${gb || "unk"}`;
const TTL = 180 * 86400;

// ── Brand → product line extractor ────────────────────────────────────────────

const BRAND_LINES = {
  apple:    ["iphone", "ipad", "macbook", "mac mini", "mac pro", "imac", "apple watch", "airpods"],
  samsung:  ["galaxy s", "galaxy a", "galaxy z", "galaxy tab", "galaxy watch"],
  sony:     ["playstation", "ps5", "ps4", "xperia", "wh-", "wf-"],
  microsoft:["xbox", "surface", "surface pro"],
  google:   ["pixel", "pixel watch", "chromebook"],
  nintendo: ["switch", "ds", "3ds"],
  dell:     ["xps", "inspiron", "latitude"],
  hp:       ["envy", "spectre", "pavilion"],
  lenovo:   ["thinkpad", "ideapad", "yoga"],
};

function extractLine(brand, model) {
  const b = String(brand || "").toLowerCase();
  const m = String(model  || "").toLowerCase();
  const lines = BRAND_LINES[b] || [];
  return lines.find((l) => m.startsWith(l) || m.includes(l)) || null;
}

// ── Record ─────────────────────────────────────────────────────────────────────

/**
 * Record a realized electronics outcome.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} outcome
 *   brand     {string}  e.g. "apple", "samsung"
 *   model     {string}  e.g. "iphone 14 pro"
 *   storageGB {number|null}  e.g. 256
 *   isWin     {boolean}
 *   netProfit {number}
 *   buyPrice  {number}
 *   holdDays  {number|null}  days from buy to sell (depreciation awareness)
 */
export async function recordElectronicsOutcome(redis, userId, {
  brand     = null,
  model     = null,
  storageGB = null,
  isWin     = false,
  netProfit = 0,
  buyPrice  = null,
  holdDays  = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const pipe = redis.pipeline();
    const pnl  = Number(netProfit) || 0;
    const line = extractLine(brand, model);
    const gb   = storageGB ? String(storageGB) : null;

    function pipeRecord(key) {
      pipe.hincrby(key,      "tradeCount", 1);
      pipe.hincrby(key,      isWin ? "wins" : "losses", 1);
      pipe.hincrbyfloat(key, "netPnl", pnl);
      if (holdDays != null) {
        pipe.hincrby(key,     "totalHoldDays", Number(holdDays));
        pipe.hincrby(key,     "holdCount", 1);
      }
      pipe.expire(key, TTL);
    }

    if (brand)                    pipeRecord(KEY_BRAND(userId, brand));
    if (brand && line)            pipeRecord(KEY_LINE(userId, brand, line));
    if (brand && model)           pipeRecord(KEY_MODEL(userId, brand, model, gb));

    await pipe.exec();
  } catch { /* non-fatal */ }
}

// ── Score ──────────────────────────────────────────────────────────────────────

/**
 * Compute electronics identity score.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {object} ctx — { brand, model, storageGB }
 */
export async function computeElectronicsIdentityScore(redis, userId, {
  brand     = null,
  model     = null,
  storageGB = null,
} = {}) {
  if (!redis || !userId) return null;
  try {
    const line = extractLine(brand, model);
    const gb   = storageGB ? String(storageGB) : null;

    const [brandHash, lineHash, modelHash] = await Promise.all([
      brand                ? redis.hgetall(KEY_BRAND(userId, brand)).catch(() => null)              : null,
      brand && line        ? redis.hgetall(KEY_LINE(userId, brand, line)).catch(() => null)          : null,
      brand && model       ? redis.hgetall(KEY_MODEL(userId, brand, model, gb)).catch(() => null)    : null,
    ]);

    const brandDim = parseDimension(brandHash);
    const lineDim  = parseDimension(lineHash);
    const modelDim = parseDimension(modelHash);

    // Model (50%) > line (35%) > brand (15%)
    let score = 0, totalWeight = 0;
    if (modelDim && modelDim.tradeCount >= 1) { score += modelDim.winScore * 50; totalWeight += 50; }
    if (lineDim  && lineDim.tradeCount  >= 1) { score += lineDim.winScore  * 35; totalWeight += 35; }
    if (brandDim && brandDim.tradeCount >= 1) { score += brandDim.winScore * 15; totalWeight += 15; }

    if (totalWeight === 0) return null;

    const finalScore  = Math.round(score / totalWeight);
    const totalTrades = (modelDim?.tradeCount || 0) + (lineDim?.tradeCount || 0);
    const confidence  = totalTrades >= 5 ? "high" : totalTrades >= 2 ? "medium" : "low";

    // Avg hold days — useful for depreciation warning
    const avgHoldDays = computeAvgHold(modelDim || lineDim || brandDim);

    return {
      score:      finalScore,
      confidence,
      dimensions: {
        brand:  brandDim,
        line:   lineDim,
        model:  modelDim,
      },
      avgHoldDays,
      signal: buildSignal({ brand, model, line, score: finalScore, lineDim, modelDim, avgHoldDays }),
    };
  } catch { return null; }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDimension(h) {
  if (!h || !h.tradeCount) return null;
  const tradeCount  = parseInt(h.tradeCount)  || 0;
  const wins        = parseInt(h.wins)          || 0;
  const netPnl      = parseFloat(h.netPnl)      || 0;
  const holdCount   = parseInt(h.holdCount)     || 0;
  const totalHold   = parseInt(h.totalHoldDays) || 0;
  const winRate     = tradeCount > 0 ? wins / tradeCount : 0;
  const tradeFactor = Math.min(1, tradeCount / 8);
  const winScore    = winRate * 0.65 + tradeFactor * 0.35;
  const avgHold     = holdCount > 0 ? Math.round(totalHold / holdCount) : null;
  return { tradeCount, wins, winRate: Math.round(winRate * 100), netPnl: round2(netPnl), winScore, avgHold };
}

function computeAvgHold(dim) {
  return dim?.avgHold || null;
}

function buildSignal({ brand, model, line, score, lineDim, modelDim, avgHoldDays }) {
  const name = model || line || brand || "this electronics";
  if (modelDim && modelDim.tradeCount >= 3) {
    if (score >= 70) {
      const hold = avgHoldDays ? ` (avg ${avgHoldDays}d hold)` : "";
      return `Solid ${name} track record — ${modelDim.winRate}% win rate${hold}.`;
    }
    if (score >= 45) return `Mixed ${name} results. Electronics depreciation timing matters.`;
    return `You've struggled with ${name}. Check depreciation curve before committing.`;
  }
  if (lineDim && lineDim.tradeCount >= 2) {
    if (score >= 65) return `You know ${line || brand} products — ${lineDim.winRate}% win rate.`;
  }
  if (avgHoldDays && avgHoldDays > 60) {
    return `Electronics lose value fast — your avg hold has been ${avgHoldDays}d. Flip quickly.`;
  }
  return null;
}

function n(s) { return String(s || "").toLowerCase().trim().slice(0, 50).replace(/\s+/g, "_"); }
function round2(v) { return Math.round(Number(v) * 100) / 100; }
