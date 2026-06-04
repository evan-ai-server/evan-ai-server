// src/identityRejectionSummary.js
// Phase 4B.2 / 4B.2.2 — Pure helpers for building an exact identity rejection summary.
//
// The summary is accumulated as identity-filter functions run (optional _out sidecar),
// then normalized and passed into calibrateEvidenceConfidence() as identitySummary.
// All helpers are pure and synchronous — no I/O, no network.

// ── Shape ─────────────────────────────────────────────────────────────────────

export function createEmptyIdentitySummary() {
  return {
    rawCount:   0,
    keptCount:  0,

    // Aircraft / airline
    rejectedCompetitorCount:           0,
    rejectedFamilyCount:               0,
    rejectedManufacturerCount:         0,
    rejectedModelMismatchCount:        0,
    rejectedMissingAirlineCount:       0,
    rejectedWeakAirlineGenericCount:   0,
    rejectedGenericToyCount:           0,
    rejectedMerchCount:                0,

    // Sneaker
    rejectedSneakerWrongLineCount:       0,
    rejectedSneakerWrongGenerationCount: 0,
    rejectedSneakerVariantCount:         0,

    // Jordan
    rejectedJordanWrongModelCount:  0,
    rejectedJordanWrongCutCount:    0,
    rejectedJordanWrongSublineCount:0,
    rejectedJordanWrongThemeCount:  0,
    rejectedJordanNonJordanCount:   0,

    // Catch-all for unknown or non-categorized rejections
    rejectedOtherIdentityCount: 0,

    // Computed by normalizeIdentitySummary()
    totalRejectedCount: 0,
    rejectionRatio:     0,

    appliedLocks: [],
    relaxed:      false,
  };
}

// ── Merge ─────────────────────────────────────────────────────────────────────

const _ADDITIVE_FIELDS = [
  "rawCount", "keptCount",
  "rejectedCompetitorCount", "rejectedFamilyCount", "rejectedManufacturerCount",
  "rejectedModelMismatchCount", "rejectedMissingAirlineCount",
  "rejectedWeakAirlineGenericCount", "rejectedGenericToyCount", "rejectedMerchCount",
  "rejectedSneakerWrongLineCount", "rejectedSneakerWrongGenerationCount", "rejectedSneakerVariantCount",
  "rejectedJordanWrongModelCount", "rejectedJordanWrongCutCount", "rejectedJordanWrongSublineCount",
  "rejectedJordanWrongThemeCount", "rejectedJordanNonJordanCount",
  "rejectedOtherIdentityCount",
];

/** Additively merge one or more summary objects into a single summary. */
export function mergeIdentitySummaries(...summaries) {
  const out = createEmptyIdentitySummary();
  for (const s of summaries) {
    if (!s || typeof s !== "object") continue;
    for (const f of _ADDITIVE_FIELDS) {
      out[f] += Math.max(0, Number(s[f] ?? 0));
    }
    if (Array.isArray(s.appliedLocks)) out.appliedLocks.push(...s.appliedLocks);
    if (s.relaxed === true) out.relaxed = true;
  }
  out.appliedLocks = [...new Set(out.appliedLocks)];
  return out;
}

// ── Normalize ─────────────────────────────────────────────────────────────────

// ── Cache pack/unpack ─────────────────────────────────────────────────────────

/**
 * Pack items + identity summary into a single cache-safe object.
 * normalizeIdentitySummary is called so stored counts are always clean.
 */
export function packMarketItemsWithIdentity(items, identitySummary) {
  return {
    items: Array.isArray(items) ? items : [],
    identitySummary: normalizeIdentitySummary(identitySummary || {}),
  };
}

/**
 * Unpack a cached value that may be either a legacy plain array or a packed
 * { items, identitySummary } object. Always returns { items, identitySummary }.
 * Backward-compatible: plain arrays return identitySummary = null.
 */
export function unpackMarketItemsWithIdentity(value) {
  if (Array.isArray(value)) {
    return { items: value, identitySummary: null };
  }
  if (value && Array.isArray(value.items)) {
    return {
      items: value.items,
      identitySummary: value.identitySummary || null,
    };
  }
  return { items: [], identitySummary: null };
}

/** Compute totalRejectedCount, rejectionRatio, and clamp all fields ≥ 0. */
export function normalizeIdentitySummary(summary) {
  if (!summary || typeof summary !== "object") return createEmptyIdentitySummary();
  const s = { ...createEmptyIdentitySummary(), ...summary };

  for (const f of _ADDITIVE_FIELDS) {
    s[f] = Math.max(0, Math.round(Number(s[f] ?? 0)));
  }

  // Sum every specific bucket (totalRejectedCount is always the sum of specifics)
  s.totalRejectedCount =
    s.rejectedCompetitorCount +
    s.rejectedFamilyCount +
    s.rejectedManufacturerCount +
    s.rejectedModelMismatchCount +
    s.rejectedMissingAirlineCount +
    s.rejectedWeakAirlineGenericCount +
    s.rejectedGenericToyCount +
    s.rejectedMerchCount +
    s.rejectedSneakerWrongLineCount +
    s.rejectedSneakerWrongGenerationCount +
    s.rejectedSneakerVariantCount +
    s.rejectedJordanWrongModelCount +
    s.rejectedJordanWrongCutCount +
    s.rejectedJordanWrongSublineCount +
    s.rejectedJordanWrongThemeCount +
    s.rejectedJordanNonJordanCount +
    s.rejectedOtherIdentityCount;

  const denominator = s.totalRejectedCount + s.keptCount;
  s.rejectionRatio = denominator > 0
    ? Math.round((s.totalRejectedCount / denominator) * 1000) / 1000
    : 0;

  if (!Array.isArray(s.appliedLocks)) s.appliedLocks = [];
  s.appliedLocks = [...new Set(s.appliedLocks)];
  if (typeof s.relaxed !== "boolean") s.relaxed = false;

  return s;
}
