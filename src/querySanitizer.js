// Phase 5B.9B — pure blocked-term query sanitizer (logging-only consumer)

/**
 * @param {string} query
 * @param {string[]} variants
 * @param {string[]} blockedTerms
 * @returns {{ sanitizedQuery: string, sanitizedVariants: string[], removedTerms: string[], wouldChange: boolean, noopReason: string|null }}
 */
export function sanitizeQueryAgainstBlocked(query, variants = [], blockedTerms = []) {
  try {
    if (!Array.isArray(blockedTerms) || blockedTerms.length === 0) {
      return noop(query, variants, "blocked_terms_empty");
    }

    const q = typeof query === "string" ? query : "";
    if (!q.trim()) {
      return noop(q, variants, "query_empty");
    }

    const safeVariants = Array.isArray(variants) ? [...variants] : [];

    const removedTerms = [];

    const sanitizedQuery = removeBlockedTerms(q, blockedTerms, removedTerms);
    const sanitizedVariants = safeVariants.map(
      (v) => (typeof v === "string" ? removeBlockedTerms(v, blockedTerms, removedTerms) : v)
    );

    const tokens = sanitizedQuery.trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
      return noop(q, safeVariants, "sanitized_query_too_short");
    }

    const uniqueRemoved = [...new Set(removedTerms)];
    const queryChanged = sanitizedQuery !== q;
    const variantsChanged = sanitizedVariants.some((v, i) => v !== safeVariants[i]);

    return {
      sanitizedQuery,
      sanitizedVariants,
      removedTerms: uniqueRemoved,
      wouldChange: queryChanged || variantsChanged,
      noopReason: null,
    };
  } catch (_err) {
    return noop(
      typeof query === "string" ? query : "",
      Array.isArray(variants) ? [...variants] : [],
      "sanitizer_error"
    );
  }
}

function noop(query, variants, reason) {
  return {
    sanitizedQuery: typeof query === "string" ? query : "",
    sanitizedVariants: Array.isArray(variants) ? [...variants] : [],
    removedTerms: [],
    wouldChange: false,
    noopReason: reason,
  };
}

function removeBlockedTerms(text, blockedTerms, removedAccumulator) {
  let result = text;
  for (const term of blockedTerms) {
    if (!term || typeof term !== "string") continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "gi");
    if (re.test(result)) {
      removedAccumulator.push(term);
      result = result.replace(re, " ");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}
