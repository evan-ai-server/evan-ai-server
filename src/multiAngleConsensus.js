// src/multiAngleConsensus.js
// Multi-Angle Consensus Engine — Feature 64
// Accepts 2-4 vision pass results from different photos of the same item.
// Detects conflicts between passes (different brand/model/category).
// Computes agreement scores. Returns unified consensus with conflict flags.
// If two passes disagree on brand: surface both alternatives, lower confidence.
// "Pass 1: Nike Air Jordan 1 (0.91). Pass 2: Nike Air Jordan 1 (0.88). Consensus: confirmed."
// "Pass 1: Supreme hoodie (0.72). Pass 2: Off-White hoodie (0.69). CONFLICT — needs tiebreaker."

// ── Agreement thresholds ──────────────────────────────────────────────────────
const CONFLICT_THRESHOLD       = 0.30; // if token overlap < 30% between two queries → conflict
const BRAND_MISMATCH_PENALTY   = 0.25; // confidence penalty when brands disagree
const MODEL_MISMATCH_PENALTY   = 0.10; // confidence penalty when models disagree

// ── Token overlap (Jaccard) ───────────────────────────────────────────────────
function tokenSet(str) {
  return new Set(String(str || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (!sa.size && !sb.size) return 1;
  const intersection = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Field extraction helpers ──────────────────────────────────────────────────
function getBrand(pass) {
  return String(pass?.identity?.brand || pass?.brand || "").toLowerCase().trim();
}
function getModel(pass) {
  return String(pass?.identity?.model || pass?.model || "").toLowerCase().trim();
}
function getQuery(pass) {
  return String(pass?.query || pass?.identity?.exactQuery || "").toLowerCase().trim();
}
function getCategory(pass) {
  return String(pass?.identity?.category || pass?.category || "").toLowerCase().trim();
}
function getCondition(pass) {
  return String(pass?.identity?.condition || pass?.condition || "").toLowerCase().trim();
}
function getConfidence(pass) {
  return Math.min(1, Math.max(0, Number(pass?.confidence ?? 0.5)));
}

// ── Majority vote helper ──────────────────────────────────────────────────────
function majorityValue(values) {
  const freq = {};
  for (const v of values) {
    if (!v) continue;
    freq[v] = (freq[v] || 0) + 1;
  }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || null;
}

// ── Weighted average of confidence scores ────────────────────────────────────
function weightedConfidence(passes) {
  if (!passes.length) return 0;
  const total = passes.reduce((s, p) => s + getConfidence(p), 0);
  return total / passes.length;
}

// ── Core consensus engine ─────────────────────────────────────────────────────

/**
 * Analyze conflicts between vision passes.
 * Returns: { brandConflict, modelConflict, categoryConflict, conflictDetails[] }
 */
export function detectPassConflicts(passes = []) {
  if (passes.length < 2) return { brandConflict: false, modelConflict: false, categoryConflict: false, conflictDetails: [] };

  const brands     = passes.map(getBrand).filter(Boolean);
  const models     = passes.map(getModel).filter(Boolean);
  const categories = passes.map(getCategory).filter(Boolean);
  const details    = [];

  // Brand conflict: any two passes have different non-empty brands
  let brandConflict = false;
  for (let i = 0; i < brands.length; i++) {
    for (let j = i + 1; j < brands.length; j++) {
      if (brands[i] && brands[j] && brands[i] !== brands[j]) {
        brandConflict = true;
        details.push({
          type:     "brand_mismatch",
          passA:    i,
          passB:    j,
          valueA:   brands[i],
          valueB:   brands[j],
          severity: "high",
          message:  `Pass ${i + 1} identified "${brands[i]}", Pass ${j + 1} identified "${brands[j]}"`,
        });
      }
    }
  }

  // Model conflict: query-level jaccard below threshold
  let modelConflict = false;
  const queries = passes.map(getQuery).filter(Boolean);
  for (let i = 0; i < queries.length; i++) {
    for (let j = i + 1; j < queries.length; j++) {
      const overlap = jaccard(queries[i], queries[j]);
      if (overlap < CONFLICT_THRESHOLD) {
        modelConflict = true;
        details.push({
          type:     "query_mismatch",
          passA:    i,
          passB:    j,
          valueA:   queries[i],
          valueB:   queries[j],
          overlap:  round2(overlap),
          severity: overlap < 0.10 ? "high" : "medium",
          message:  `Low query agreement (${(overlap * 100).toFixed(0)}%) between passes`,
        });
      }
    }
  }

  // Category conflict
  let categoryConflict = false;
  const uniqueCategories = [...new Set(categories)];
  if (uniqueCategories.length > 1) {
    categoryConflict = true;
    details.push({
      type:     "category_mismatch",
      values:   uniqueCategories,
      severity: "medium",
      message:  `Category disagreement: ${uniqueCategories.join(" vs ")}`,
    });
  }

  return { brandConflict, modelConflict, categoryConflict, conflictDetails: details };
}

/**
 * Score per-pass agreement relative to the consensus query.
 */
export function scorePassAgreement(passes = [], consensusQuery = "") {
  return passes.map((pass, i) => ({
    passIndex:       i,
    query:           getQuery(pass),
    brand:           getBrand(pass),
    model:           getModel(pass),
    confidence:      getConfidence(pass),
    agreementScore:  round2(jaccard(getQuery(pass), consensusQuery)),
  }));
}

/**
 * Merge all passes into a single consensus identity.
 * Strategy: highest-confidence pass wins for identity fields;
 * we aggregate colors/materials/searchQueries across all passes.
 */
export function mergePassIdentities(passes = []) {
  if (!passes.length) return null;

  // Sort by confidence descending — primary pass first
  const sorted = [...passes].sort((a, b) => getConfidence(b) - getConfidence(a));
  const primary = sorted[0];

  // Merge arrays: colors, materials, searchQueries, visibleText from all passes
  const mergedColors   = [...new Set(passes.flatMap(p => p?.identity?.colors || []))];
  const mergedMaterials= [...new Set(passes.flatMap(p => p?.identity?.materials || []))];
  const mergedQueries  = [...new Set(passes.flatMap(p => p?.identity?.searchQueries || []))];
  const mergedText     = [...new Set(passes.flatMap(p => p?.identity?.visibleText || []))];
  const mergedAuthFlags= [...new Set(passes.flatMap(p => p?.authenticityFlags || []))];
  const mergedCondFlags= [...new Set(passes.flatMap(p => p?.conditionFlags || []))];

  // Condition: use majority vote (more robust than just primary)
  const conditions = passes.map(getCondition).filter(Boolean);
  const consensusCondition = majorityValue(conditions) || getCondition(primary);

  return {
    ...(primary?.identity || {}),
    colors:         mergedColors,
    materials:      mergedMaterials,
    searchQueries:  mergedQueries.slice(0, 12),
    visibleText:    mergedText,
    condition:      consensusCondition,
    // Prefer highest-confidence brand/model
    brand:          primary?.identity?.brand || null,
    model:          primary?.identity?.model || null,
    exactQuery:     primary?.identity?.exactQuery || primary?.query || null,
    // Merged certainty: average of all passes per field
    _mergedFromPasses: passes.length,
  };
}

/**
 * Master multi-angle consensus builder.
 */
export function buildMultiAngleConsensus(passes = []) {
  const validPasses = (passes || []).filter(p => p && typeof p === "object");
  if (!validPasses.length) {
    return { ok: false, reason: "no_valid_passes", consensus: null };
  }

  if (validPasses.length === 1) {
    return {
      ok:           true,
      passCount:    1,
      consensus:    validPasses[0],
      conflicts:    { brandConflict: false, modelConflict: false, categoryConflict: false, conflictDetails: [] },
      agreement:    1.0,
      needsTiebreaker: false,
      topSignal:    "Single angle — no conflict detection possible",
    };
  }

  const conflicts  = detectPassConflicts(validPasses);
  const avgConf    = weightedConfidence(validPasses);

  // Build consensus query: pick highest-confidence non-null query
  const sortedByConf = [...validPasses].sort((a, b) => getConfidence(b) - getConfidence(a));
  const primaryQuery = getQuery(sortedByConf[0]);

  // Agreement: average jaccard of all passes vs the primary query
  const agreements  = validPasses.map(p => jaccard(getQuery(p), primaryQuery));
  const avgAgreement = agreements.reduce((s, v) => s + v, 0) / agreements.length;

  // Confidence penalty for conflicts
  let penalizedConf = avgConf;
  if (conflicts.brandConflict)    penalizedConf -= BRAND_MISMATCH_PENALTY;
  if (conflicts.modelConflict)    penalizedConf -= MODEL_MISMATCH_PENALTY;
  penalizedConf = Math.max(0.1, Math.min(1.0, penalizedConf));

  const mergedIdentity = mergePassIdentities(validPasses);
  const passAgreements = scorePassAgreement(validPasses, primaryQuery);

  // Need tiebreaker: brand conflict with high individual confidences
  const needsTiebreaker = conflicts.brandConflict &&
    validPasses.some(p => getConfidence(p) >= 0.75);

  // Build the final consensus object
  const consensus = {
    ...(sortedByConf[0] || {}),
    query:             primaryQuery,
    confidence:        penalizedConf,
    identity:          mergedIdentity,
    authenticityFlags: [...new Set(validPasses.flatMap(p => p?.authenticityFlags || []))],
    conditionFlags:    [...new Set(validPasses.flatMap(p => p?.conditionFlags    || []))],
    attributeCertainty: buildMergedCertainty(validPasses),
  };

  // Alternatives: if brand conflict, surface the competing identities
  const alternatives = conflicts.brandConflict
    ? validPasses
        .filter(p => getBrand(p) !== getBrand(sortedByConf[0]))
        .map(p => ({ query: getQuery(p), brand: getBrand(p), model: getModel(p), confidence: getConfidence(p) }))
    : [];

  const topSignal = buildConsensusSignal(validPasses.length, conflicts, penalizedConf, needsTiebreaker, primaryQuery);

  return {
    ok:              true,
    passCount:       validPasses.length,
    consensus,
    conflicts,
    agreement:       round2(avgAgreement),
    passAgreements,
    alternatives,
    needsTiebreaker,
    topSignal,
  };
}

function buildMergedCertainty(passes) {
  const fields = ["brand", "model", "category", "condition", "authenticity", "resaleConfidence"];
  const result = {};
  for (const field of fields) {
    const vals = passes.map(p => p?.attributeCertainty?.[field]).filter(v => typeof v === "number");
    result[field] = vals.length ? round2(vals.reduce((s, v) => s + v, 0) / vals.length) : 0.5;
  }
  return result;
}

function buildConsensusSignal(count, conflicts, conf, needsTiebreaker, query) {
  if (needsTiebreaker) return `${count} angles conflict on brand — tiebreaker photo recommended (conf: ${(conf * 100).toFixed(0)}%)`;
  if (conflicts.brandConflict) return `Brand conflict across ${count} angles — lowered confidence to ${(conf * 100).toFixed(0)}%`;
  if (conflicts.modelConflict) return `Model variation across ${count} angles — ${(conf * 100).toFixed(0)}% consensus`;
  return `${count} angles agree: "${query}" — ${(conf * 100).toFixed(0)}% confidence`;
}

// ── Payload builder ───────────────────────────────────────────────────────────
export function buildMultiAngleConsensusPayload(passes = []) {
  try {
    return buildMultiAngleConsensus(passes);
  } catch {
    return { ok: false, reason: "consensus_error", consensus: null };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }
