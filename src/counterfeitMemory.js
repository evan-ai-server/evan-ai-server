// src/counterfeitMemory.js
// Phase 2 — Counterfeit Memory System.
//
// Redis-backed persistent store of known counterfeit patterns.
// Patterns are reusable across scans — once a fake pattern is identified
// (by expert correction or flagged scan), it enriches future assessments.
//
// Redis key structure:
//   counterfeit:pattern:{patternId}         → JSON  (full pattern object)
//   counterfeit:idx:{category}:{brand}      → SET   (patternIds for this brand/category)
//   counterfeit:idx:{category}:ALL          → SET   (all patternIds for category)
//   counterfeit:stats                       → HASH  (total patterns, matches, etc.)
//
// Pattern object:
// {
//   patternId      string   — unique ID
//   category       string   — canonical category
//   brand          string   — normalized brand name
//   model          string|null
//   patternType    string   — "price_floor" | "visual_tell" | "attribute_mismatch" | "expert_confirmed" | "structural"
//   attributes     object   — key-value pairs that identify this fake pattern
//   fakeSignals    string[] — human-readable tells associated with this pattern
//   confidence     number   — 0-1, how certain this is a real fake pattern
//   reportCount    number   — how many times this has been independently confirmed
//   source         string   — "expert_correction" | "community_flag" | "automated" | "system_seed"
//   addedBy        string   — userId or system identifier
//   ts             number   — epoch ms when added
//   lastMatchTs    number|null
//   matchCount     number
// }

import crypto from "crypto";

const KEY_PATTERN  = (id)       => `counterfeit:pattern:${id}`;
const KEY_IDX_BRAND= (cat, br)  => `counterfeit:idx:${cat}:${brand_key(br)}`;
const KEY_IDX_CAT  = (cat)      => `counterfeit:idx:${cat}:ALL`;
const KEY_STATS    = "counterfeit:stats";
const TTL_PATTERN  = 365 * 86400;   // 1 year
const MAX_MATCHES_RETURNED = 5;

// ── Write path ────────────────────────────────────────────────────────────────

/**
 * Add a new counterfeit pattern to memory.
 *
 * @param {object} redis
 * @param {object} pattern — see schema above (patternId will be auto-generated)
 * @returns {string} patternId
 */
export async function addCounterfeitPattern(redis, pattern) {
  if (!redis || !pattern) return null;
  try {
    const patternId = pattern.patternId || generatePatternId(pattern);
    const now = Date.now();

    const stored = {
      patternId,
      category:    pattern.category   || "generic",
      brand:       brand_key(pattern.brand || ""),
      model:       pattern.model      || null,
      patternType: pattern.patternType || "visual_tell",
      attributes:  pattern.attributes || {},
      fakeSignals: Array.isArray(pattern.fakeSignals) ? pattern.fakeSignals : [],
      confidence:  clamp01(Number(pattern.confidence) || 0.7),
      reportCount: Number(pattern.reportCount) || 1,
      source:      pattern.source     || "system_seed",
      addedBy:     pattern.addedBy    || "system",
      ts:          pattern.ts         || now,
      lastMatchTs: null,
      matchCount:  0,
    };

    const multi = redis.multi();
    multi.set(KEY_PATTERN(patternId), JSON.stringify(stored), "EX", TTL_PATTERN);
    multi.sadd(KEY_IDX_CAT(stored.category), patternId);
    if (stored.brand) {
      multi.sadd(KEY_IDX_BRAND(stored.category, stored.brand), patternId);
    }
    multi.hincrby(KEY_STATS, "totalPatterns", 1);
    await multi.exec();

    return patternId;
  } catch (err) {
    console.error("[counterfeitMemory] addCounterfeitPattern error:", err?.message);
    return null;
  }
}

/**
 * Increment report count on an existing pattern (called when confirmed by another source).
 */
export async function reinforcePattern(redis, patternId) {
  if (!redis || !patternId) return;
  try {
    const raw = await redis.get(KEY_PATTERN(patternId));
    if (!raw) return;
    const p = JSON.parse(raw);
    p.reportCount = (p.reportCount || 1) + 1;
    p.confidence  = Math.min(1, p.confidence + 0.05);
    await redis.set(KEY_PATTERN(patternId), JSON.stringify(p), "EX", TTL_PATTERN);
  } catch (err) {
    console.error("[counterfeitMemory] reinforcePattern error:", err?.message);
  }
}

// ── Read path ─────────────────────────────────────────────────────────────────

/**
 * Look up all counterfeit patterns for a brand/category.
 *
 * @param {object} redis
 * @param {object} opts — { category, brand }
 * @returns {Array} pattern objects
 */
export async function lookupCounterfeitPatterns(redis, { category, brand } = {}) {
  if (!redis) return [];
  try {
    let patternIds;
    if (brand) {
      patternIds = await redis.smembers(KEY_IDX_BRAND(category, brand));
    } else {
      patternIds = await redis.smembers(KEY_IDX_CAT(category));
    }
    if (!patternIds || patternIds.length === 0) return [];

    const fetched = await Promise.all(
      patternIds.slice(0, 50).map(id => redis.get(KEY_PATTERN(id)))
    );
    return fetched
      .filter(Boolean)
      .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(Boolean);
  } catch (err) {
    console.error("[counterfeitMemory] lookupCounterfeitPatterns error:", err?.message);
    return [];
  }
}

/**
 * Match a scan's extracted attributes against known counterfeit patterns.
 * Returns an array of matches sorted by matchScore descending.
 *
 * @param {object} redis
 * @param {object} opts
 *   category             {string}
 *   extractedAttributes  {object} — from categoryAttributeExtractor
 * @returns {Array<{patternId, matchScore, matchedFields, fakeSignals}>}
 */
export async function matchScanToCounterfeitPatterns(redis, { category, extractedAttributes } = {}) {
  if (!redis || !extractedAttributes) return [];
  try {
    const brand    = brand_key(extractedAttributes.brand || "");
    const patterns = await lookupCounterfeitPatterns(redis, { category, brand });
    if (patterns.length === 0) return [];

    const attrs  = extractedAttributes;
    const matches = [];

    for (const p of patterns) {
      const { score, matchedFields } = scorePatternMatch(p, attrs);
      if (score >= 0.3) {
        matches.push({
          patternId:    p.patternId,
          matchScore:   round2(score),
          matchedFields,
          fakeSignals:  p.fakeSignals || [],
          confidence:   p.confidence,
          reportCount:  p.reportCount,
          source:       p.source,
        });
      }
    }

    // Sort by score descending, then by confidence
    matches.sort((a, b) => b.matchScore - a.matchScore || b.confidence - a.confidence);

    // Record match stats for top match
    if (matches.length > 0) {
      incrementMatchCount(redis, matches[0].patternId).catch(() => {});
    }

    return matches.slice(0, MAX_MATCHES_RETURNED);
  } catch (err) {
    console.error("[counterfeitMemory] matchScanToCounterfeitPatterns error:", err?.message);
    return [];
  }
}

// ── Pattern matching logic ────────────────────────────────────────────────────

function scorePatternMatch(pattern, attrs) {
  const pa    = pattern.attributes || {};
  const keys  = Object.keys(pa);
  if (keys.length === 0) return { score: 0, matchedFields: [] };

  const matchedFields = [];
  let totalWeight = 0;
  let matchWeight = 0;

  for (const key of keys) {
    const weight = FIELD_WEIGHTS[key] || 0.5;
    totalWeight += weight;

    const patternVal = String(pa[key] || "").toLowerCase().trim();
    const attrVal    = String(attrs[key] || "").toLowerCase().trim();

    if (!attrVal || !patternVal) continue;

    if (attrVal === patternVal) {
      matchWeight += weight;
      matchedFields.push(key);
    } else if (attrVal.includes(patternVal) || patternVal.includes(attrVal)) {
      matchWeight += weight * 0.7;
      matchedFields.push(key);
    }
  }

  // Brand is mandatory — if brand doesn't match, score is 0
  if (pa.brand && attrs.brand) {
    const patBrand  = brand_key(pa.brand);
    const scanBrand = brand_key(attrs.brand);
    if (!scanBrand.includes(patBrand) && !patBrand.includes(scanBrand)) {
      return { score: 0, matchedFields: [] };
    }
  }

  const score = totalWeight > 0 ? matchWeight / totalWeight : 0;
  return { score, matchedFields };
}

// Field importance weights for matching
const FIELD_WEIGHTS = {
  brand:     1.0,   // brand match is essential
  model:     0.8,
  styleCode: 0.9,
  reference: 0.9,   // watches
  dateCode:  0.8,
  colorway:  0.6,
  material:  0.6,
  movement:  0.7,
  condition: 0.3,
  size:      0.4,
};

// ── Stats helpers ─────────────────────────────────────────────────────────────

async function incrementMatchCount(redis, patternId) {
  const raw = await redis.get(KEY_PATTERN(patternId));
  if (!raw) return;
  const p = JSON.parse(raw);
  p.matchCount  = (p.matchCount || 0) + 1;
  p.lastMatchTs = Date.now();
  await redis.set(KEY_PATTERN(patternId), JSON.stringify(p), "EX", TTL_PATTERN);
  await redis.hincrby(KEY_STATS, "totalMatches", 1);
}

/**
 * Get memory-level stats for the counterfeit system.
 */
export async function getCounterfeitStats(redis) {
  if (!redis) return {};
  try {
    const stats = await redis.hgetall(KEY_STATS);
    return {
      totalPatterns: Number(stats.totalPatterns) || 0,
      totalMatches:  Number(stats.totalMatches)  || 0,
    };
  } catch { return {}; }
}

/**
 * Seed the counterfeit memory with system-level known patterns.
 * Called once during server startup if patterns don't yet exist.
 */
export async function seedCounterfeitMemory(redis) {
  if (!redis) return;
  try {
    const existing = await redis.hget(KEY_STATS, "seeded");
    if (existing) return;  // already seeded

    const seeds = SYSTEM_SEED_PATTERNS;
    for (const pattern of seeds) {
      await addCounterfeitPattern(redis, { ...pattern, source: "system_seed", addedBy: "system" });
    }
    await redis.hset(KEY_STATS, "seeded", "1");
    console.log(`[counterfeitMemory] Seeded ${seeds.length} known counterfeit patterns`);
  } catch (err) {
    console.error("[counterfeitMemory] seedCounterfeitMemory error:", err?.message);
  }
}

// ── System seed patterns ──────────────────────────────────────────────────────

const SYSTEM_SEED_PATTERNS = [
  // Sneakers — Jordan 1 replica (most common)
  {
    category:    "sneakers",
    brand:       "jordan",
    model:       "Air Jordan 1",
    patternType: "structural",
    attributes:  { brand: "jordan", model: "Air Jordan 1", condition: "DS" },
    fakeSignals: [
      "Jumpman logo has asymmetric or blurry stitching",
      "Outsole heel pod color is incorrect for colorway",
      "Toe box shape is too rounded compared to authentic",
      "Inner insole has flat Nike logo instead of debossed",
    ],
    confidence:  0.85,
    reportCount: 12,
  },
  // Sneakers — Yeezy 350 V2 replica
  {
    category:    "sneakers",
    brand:       "adidas",
    model:       "Yeezy 350 V2",
    patternType: "structural",
    attributes:  { brand: "adidas", model: "Yeezy 350 V2" },
    fakeSignals: [
      "Boost foam has shiny smooth texture instead of matte granular",
      "Primeknit weave pattern is inconsistent or too loose",
      "SPLY-350 text on midsole wrong color for colorway",
      "Heel tab font weight or position incorrect",
    ],
    confidence:  0.90,
    reportCount: 18,
  },
  // Handbags — LV Neverfull replica
  {
    category:    "handbags",
    brand:       "louis vuitton",
    model:       "Neverfull",
    patternType: "attribute_mismatch",
    attributes:  { brand: "louis vuitton", model: "Neverfull" },
    fakeSignals: [
      "LV monogram pattern cuts off or misaligns at seams",
      "Date code format doesn't match authentic convention",
      "Interior lining is non-alcantara plasticky material",
      "Hardware is lightweight and doesn't feel solid brass",
      "Stitching thread color wrong — should be mustard/tan",
    ],
    confidence:  0.88,
    reportCount: 22,
  },
  // Handbags — Chanel Classic Flap replica
  {
    category:    "handbags",
    brand:       "chanel",
    model:       "Classic Flap",
    patternType: "structural",
    attributes:  { brand: "chanel", model: "Classic Flap" },
    fakeSignals: [
      "CC logo overlap is reversed — left C should be in front at top",
      "Quilting has puckering or is asymmetric",
      "Chain feels lightweight with rattle",
      "Interior lining feels synthetic rather than satin",
      "Serial sticker missing or doesn't match authenticity card",
    ],
    confidence:  0.92,
    reportCount: 31,
  },
  // Watches — Rolex Submariner replica (most counterfeited watch)
  {
    category:    "watches",
    brand:       "rolex",
    model:       "Submariner",
    patternType: "structural",
    attributes:  { brand: "rolex", model: "Submariner" },
    fakeSignals: [
      "Exhibition/transparent caseback — Rolex always uses solid caseback",
      "Seconds hand ticks instead of sweeping",
      "Cyclops lens doesn't magnify date 2.5x",
      "Crown lacks engraved Rolex crown logo",
      "Rehaut lacks laser-engraved ROLEX text",
      "Watch is significantly lighter than authentic (authentic ~155g)",
    ],
    confidence:  0.95,
    reportCount: 45,
  },
  // Watches — Rolex Datejust replica
  {
    category:    "watches",
    brand:       "rolex",
    model:       "Datejust",
    patternType: "structural",
    attributes:  { brand: "rolex", model: "Datejust" },
    fakeSignals: [
      "Date jumps slowly or erratically rather than clean snap at midnight",
      "Jubilee bracelet links feel loose or have rough edges",
      "Cyclops magnification insufficient on date window",
      "Dial printing quality poor — uneven font weight on indices",
    ],
    confidence:  0.88,
    reportCount: 28,
  },
  // Watches — AP Royal Oak replica
  {
    category:    "watches",
    brand:       "audemars piguet",
    model:       "Royal Oak",
    patternType: "structural",
    attributes:  { brand: "audemars piguet", model: "Royal Oak" },
    fakeSignals: [
      "Octagonal bezel screws are not perfectly aligned or feel loose",
      "Tapisserie dial pattern is irregular or printed rather than machined",
      "Bracelet integration with case is not seamless",
      "Movement visible through caseback shows poor finishing",
    ],
    confidence:  0.90,
    reportCount: 15,
  },
];

// ── Utility helpers ───────────────────────────────────────────────────────────

function brand_key(brand) {
  return String(brand || "").toLowerCase().trim().replace(/\s+/g, "_");
}

function generatePatternId(pattern) {
  const seed = `${pattern.category}:${pattern.brand}:${pattern.model}:${pattern.patternType}:${Date.now()}`;
  return crypto.createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
