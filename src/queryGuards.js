// src/queryGuards.js
// Phase 4H.4 — query guard functions extracted for testability.
// node --test src/queryGuards.test.js

/**
 * Catches single-word literal junk ("item", "product", "thing", etc.).
 * Does NOT catch multi-word vague phrases — use isGenericGarbageQuery for that.
 */
export function isGarbageQuery(q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return true;

  const junk = new Set([
    "item",
    "object",
    "product",
    "thing",
    "stuff",
    "consumer product",
    "unknown",
    "misc",
    "misc item",
    "general item",
  ]);

  return junk.has(s);
}

/**
 * Catches multi-word generic phrases that escape isGarbageQuery.
 * Pattern-based: targets constructions produced by the vision fallback
 * ("used item for", "used for pre owned", "item for sale", etc.).
 */
export function isGenericGarbageQuery(q) {
  if (!q) return true;
  const s = String(q).toLowerCase().trim();
  const genericPatterns = [
    /^used item/,
    /^used for/,
    /^item for/,
    /^object for/,
    /^unknown/,
    /^product/,
    /^thing/,
  ];
  if (genericPatterns.some((p) => p.test(s))) return true;
  if (s.split(/\s+/).filter(Boolean).length < 3) return true;
  if (s.length < 10) return true;
  return false;
}

/**
 * A query is a usable vision seed only if it passes both garbage checks and
 * has at least 3 tokens. Used by the hard-deadline path to decide whether
 * vision produced anything worth searching.
 */
export function isUsableVisionSeed(q) {
  if (!q || typeof q !== "string") return false;
  const trimmed = q.trim();
  if (!trimmed) return false;
  if (isGarbageQuery(trimmed)) return false;
  if (isGenericGarbageQuery(trimmed)) return false;
  return true;
}
