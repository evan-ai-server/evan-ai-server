// src/finalUiIdentityLock.js
// Phase V3.10B.9 — last-net identity filter for the FINAL UI comp list.
//
// The retrieval-stage aircraft identity lock is the primary filter, but the UI
// pool is built from a wider source list and can still carry missing-airline /
// wrong-family comps (e.g. "Gulf Air 787-9", a generic "787-9 Dreamliner"). The
// earlier UI net only rejected KNOWN competitors, so anything that simply lacked
// the required airline slipped through. This helper ENFORCES required-airline
// presence AND required-family presence (and still rejects competitors).
//
// Policy: never refill with off-identity comps to hit a count. Fewer (or zero)
// honest comps is correct — the caller keeps "Signal only / thin market" framing.
//
// Pure + dependency-free so the leak is unit-testable. norm/hasToken mirror
// index.js normalizeTitleKey/titleHasToken (a drift-guard test checks the wiring).

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function hasToken(text, token) {
  return ` ${text} `.includes(` ${norm(token)} `);
}

/**
 * @param {Array<{title?: string}>} items
 * @param {object} lock
 * @param {string|null} lock.requiredAirline      normalized airline token (e.g. "hawaiian")
 * @param {string[]}    lock.competitors          normalized competitor airline tokens
 * @param {string|null} lock.requiredFamily       e.g. "787" (or null when none specified)
 * @param {string[]}    lock.familyTokens         normalized family tokens (e.g. ["787","dreamliner"])
 * @param {Record<string,string[]>} lock.competitorAliases  aircraft-context aliases per competitor
 * @returns {{ kept: Array, rejectedCompetitor: number, rejectedMissingAirline: number, rejectedFamily: number }}
 */
export function filterFinalUiByAircraftIdentity(items, {
  requiredAirline = null,
  competitors = [],
  requiredFamily = null,
  familyTokens = [],
  competitorAliases = {},
} = {}) {
  if (!requiredAirline || !Array.isArray(items) || items.length === 0) {
    return { kept: Array.isArray(items) ? items : [], rejectedCompetitor: 0, rejectedMissingAirline: 0, rejectedFamily: 0 };
  }
  let rejectedCompetitor = 0, rejectedMissingAirline = 0, rejectedFamily = 0;
  const kept = items.filter((it) => {
    const t = norm(it?.title || "");
    const isCompetitor = competitors.some((c) => {
      if (hasToken(t, c)) return true;
      return (competitorAliases[c] || []).some((a) => hasToken(t, a));
    });
    if (isCompetitor) { rejectedCompetitor++; return false; }
    if (!hasToken(t, requiredAirline)) { rejectedMissingAirline++; return false; }
    if (requiredFamily && familyTokens.length > 0 && !familyTokens.some((tok) => t.includes(norm(tok)))) {
      rejectedFamily++; return false;
    }
    return true;
  });
  return { kept, rejectedCompetitor, rejectedMissingAirline, rejectedFamily };
}
