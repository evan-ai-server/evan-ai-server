// src/aircraftFamilyFieldRecovery.js
// Phase V3.10B.6 — SAFE aircraft-family recovery from a vision pass's OWN output.
//
// When the master/background vision pass returns an airline but no family in the
// query string (e.g. "Hawaiian Airlines model airplane"), the family may still be
// present in the SAME result's variants or structured identity fields. Recovering
// it from data the model already returned is safe: it is NOT a fresh model call,
// NOT broad similarity, NOT a legacy-snapshot guess. If nothing in the result
// names a family, we recover nothing (caller keeps needsFamilyRecovery:true).
//
// Pure + dependency-free so the decision is unit-testable without booting vision.

// Family token → canonical manufacturer + display. Mirrors AIRCRAFT_FAMILY_MAP in
// index.js; a drift-guard test asserts the key sets stay in sync.
export const FIELD_RECOVERY_FAMILY_TOKENS = {
  "787":      { tokens: ["787", "dreamliner"], manufacturer: "Boeing", display: "787" },
  "777":      { tokens: ["777"],               manufacturer: "Boeing", display: "777" },
  "747":      { tokens: ["747", "jumbo"],      manufacturer: "Boeing", display: "747" },
  "737":      { tokens: ["737"],               manufacturer: "Boeing", display: "737" },
  "a380":     { tokens: ["a380"],              manufacturer: "Airbus", display: "A380" },
  "a350":     { tokens: ["a350"],              manufacturer: "Airbus", display: "A350" },
  "a330":     { tokens: ["a330"],              manufacturer: "Airbus", display: "A330" },
  "a320":     { tokens: ["a320", "a321"],      manufacturer: "Airbus", display: "A320" },
  "a319":     { tokens: ["a319"],              manufacturer: "Airbus", display: "A319" },
  "concorde": { tokens: ["concorde"],          manufacturer: "",       display: "Concorde" },
};

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function hasToken(text, token) {
  return ` ${text} `.includes(` ${token} `);
}

// Detect the first family named in `text` (word-boundary safe).
export function detectFamilyToken(text) {
  const t = norm(text);
  if (!t) return null;
  for (const [family, def] of Object.entries(FIELD_RECOVERY_FAMILY_TOKENS)) {
    for (const tok of def.tokens) {
      if (hasToken(t, tok)) return { family, matchedToken: tok, manufacturer: def.manufacturer, display: def.display };
    }
  }
  return null;
}

// Insert "{manufacturer} {family}" into an airline-bearing query that lacks the
// family. Inserts before the first generic noun if present, else appends.
export function injectAircraftFamily(incompleteQuery, family) {
  const def = FIELD_RECOVERY_FAMILY_TOKENS[family];
  if (!def) return incompleteQuery;
  const insert = [def.manufacturer, def.display].filter(Boolean).join(" ");
  const q = String(incompleteQuery || "").trim();
  if (!q) return insert;
  if (hasToken(norm(q), norm(def.display))) return q; // already present
  const m = q.match(/\b(diecast|model|airplane|aircraft|plane|replica|toy)\b/i);
  if (m) {
    const idx = q.toLowerCase().indexOf(m[0].toLowerCase());
    return `${q.slice(0, idx)}${insert} ${q.slice(idx)}`.replace(/\s+/g, " ").trim();
  }
  return `${q} ${insert}`.replace(/\s+/g, " ").trim();
}

/**
 * Recover a complete airline+family query from a vision pass's own output.
 *
 * @param {object} opts
 * @param {string} opts.incompleteQuery - the airline-bearing query missing a family
 * @param {string} opts.requiredAirline - airline token already detected in the query
 * @param {string[]} opts.candidateStrings - full strings (query, variants, identity.exactQuery,
 *        identity.searchQueries) that might already be a complete airline+family query
 * @param {string[]} opts.fieldValues - bare structured identity field values
 *        (brand, model, itemType, manufacturer, family, modelNumber, category, visibleText)
 * @returns {{recovered:boolean, query?:string, family?:string, matchedToken?:string, source?:string}}
 */
export function recoverFamilyFromMasterFields({
  incompleteQuery = "",
  requiredAirline = "",
  candidateStrings = [],
  fieldValues = [],
} = {}) {
  if (!requiredAirline) return { recovered: false, reason: "no_required_airline" };

  // (a) Prefer a master-origin string that ALREADY has airline + family — use it
  // verbatim (no synthesis). This preserves rich strings like
  // "Hawaiian Airlines Boeing 787-9 1:400 GeminiJets".
  for (const s of candidateStrings) {
    if (typeof s !== "string" || !s.trim()) continue;
    const sNorm = norm(s);
    if (!hasToken(sNorm, norm(requiredAirline))) continue;
    const fam = detectFamilyToken(s);
    if (fam) {
      return { recovered: true, query: s.trim(), family: fam.family, matchedToken: fam.matchedToken, source: "master_complete_string" };
    }
  }

  // (b) No complete string — look for a bare family token in any master field and
  // synthesize a complete query by inserting it into the airline-bearing query.
  for (const v of [...candidateStrings, ...fieldValues]) {
    if (typeof v !== "string" || !v.trim()) continue;
    const fam = detectFamilyToken(v);
    if (fam) {
      return {
        recovered: true,
        query: injectAircraftFamily(incompleteQuery, fam.family),
        family: fam.family,
        matchedToken: fam.matchedToken,
        source: "master_identity_field",
      };
    }
  }

  return { recovered: false, reason: "no_family_in_master_output" };
}
