  // src/attributeCertaintyMap.js
  // Attribute-level confidence scores — per-field trust breakdown
  // Replaces single overall confidence score with a graded breakdown

  const FIELDS = ["brand", "model", "category", "condition", "authenticity", "resaleConfidence"];

  const DEFAULT_MAP = Object.fromEntries(FIELDS.map((f) => [f, 0]));

  // ── Normalize raw map from vision output ─────────────────────────────────────

  export function normalizeAttributeCertaintyMap(raw) {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_MAP };

    const result = {};
    for (const field of FIELDS) {
      const v = Number(raw[field]);
      result[field] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    }
    return result;
  }

  // ── Merge multiple maps from N vision passes (average per field) ──────────────

  export function mergeAttributeCertaintyMaps(maps = []) {
    const valid = maps
      .filter((m) => m && typeof m === "object")
      .map(normalizeAttributeCertaintyMap);

    if (!valid.length) return { ...DEFAULT_MAP };

    const merged = {};
    for (const field of FIELDS) {
      const values = valid.map((m) => m[field]).filter(Number.isFinite);
      merged[field] = values.length
        ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100
        : 0;
    }
    return merged;
  }

  // ── Convert a certainty value to a letter grade ───────────────────────────────

  export function certaintyToGrade(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return "?";
    if (v >= 0.92) return "A+";
    if (v >= 0.85) return "A";
    if (v >= 0.75) return "B+";
    if (v >= 0.65) return "B";
    if (v >= 0.55) return "C+";
    if (v >= 0.45) return "C";
    if (v >= 0.30) return "D";
    return "F";
  }

  // ── Build full display payload ─────────────────────────────────────────────────

  export function buildAttributeCertaintyPayload(certaintyMap) {
    const map = normalizeAttributeCertaintyMap(certaintyMap);

    return {
      fields: Object.fromEntries(
        FIELDS.map((field) => [
          field,
          {
            score: map[field],
            grade: certaintyToGrade(map[field]),
            pct:   Math.round(map[field] * 100),
          },
        ])
      ),
      overallScore: Math.round(
        (FIELDS.reduce((sum, f) => sum + map[f], 0) / FIELDS.length) * 100
      ) / 100,
      weakestField: FIELDS.reduce((a, b) => (map[a] <= map[b] ? a : b)),
      strongestField: FIELDS.reduce((a, b) => (map[a] >= map[b] ? a : b)),
      trustworthy: FIELDS.filter((f) => map[f] >= 0.70).length >= 3,
    };
  }

  // ── Derive certainty from identity when model doesn't return it ───────────────
  // Fallback heuristic: infer from what identity fields are populated

  export function inferAttributeCertaintyFromIdentity(identity = {}, overallConfidence = 0) {
    const base = Math.max(0, Math.min(1, Number(overallConfidence) || 0));

    return {
      brand:           identity?.brand   ? Math.min(1, base + 0.12) : Math.max(0, base - 0.20),
      model:           identity?.model   ? Math.min(1, base + 0.08) : Math.max(0, base - 0.25),
      category:        identity?.category ? Math.min(1, base + 0.15) : Math.max(0, base - 0.10),
      condition:       identity?.condition ? Math.min(1, base + 0.05) : Math.max(0, base - 0.15),
      authenticity:    Math.max(0, base - 0.10),
      resaleConfidence: base,
    };
  }


