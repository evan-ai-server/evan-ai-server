const CANONICAL_QUERIES = new Map();

export function canonicalizeQuery(q) {

  const key = q.toLowerCase();

  if (CANONICAL_QUERIES.has(key)) {
    return CANONICAL_QUERIES.get(key);
  }

  const cleaned = key.replace(/\b(vintage|retro|used)\b/g, "").trim();

  CANONICAL_QUERIES.set(key, cleaned);

  return cleaned;
}
