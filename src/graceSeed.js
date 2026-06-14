// Phase V3.3 — no-result-regression helpers (pure + unit-testable).
//
// Background: a fresh scan whose query_fast finishes AFTER the hard deadline is
// rescued by the no-seed grace window. query_fast returns its category FLAT
// (parsed.category), but the downstream fast-accept and seed-recovery paths read
// parsed.identity.category. The grace-rescued result therefore looked like it had
// "no_category", was rejected, and the endpoint waited to the hard-return ceiling
// (~5.5s) instead of returning the correct seed at ~3.6s — starving market of SLA.

/**
 * Mirror query_fast's flat parsed.category into parsed.identity.category so a
 * grace-rescued seed is recognized by the category-aware gates. Never fabricates
 * beyond mirroring an existing flat value; an existing identity.category wins.
 * Returns a new parsed object (does not mutate the input).
 */
export function mirrorQueryFastSeedIdentity(parsed = {}) {
  const flatCat = (typeof parsed.category === "string" && parsed.category.trim())
    ? parsed.category.trim().toLowerCase()
    : null;
  return {
    ...parsed,
    identity: {
      ...(parsed.identity || {}),
      category: parsed.identity?.category || flatCat || null,
    },
  };
}

/** Convenience: the effective category a mirrored seed would expose. */
export function effectiveSeedCategory(parsed = {}) {
  return mirrorQueryFastSeedIdentity(parsed).identity.category;
}

/**
 * Decide the zero-cost cache payload to serve when the market SLA is exhausted.
 * Returns the cached payload ONLY when it actually carries items; otherwise null
 * (caller then emits the honest empty/rescan response). Never triggers network.
 */
export function slaFallbackPayload(cached) {
  const items = Array.isArray(cached?.payload?.items) ? cached.payload.items : [];
  return items.length ? cached.payload : null;
}
