// src/replicaRiskEngine.js
// Replica Risk Engine — hard ceiling for high-counterfeit-risk categories.
//
// HIGH categories (sneakers, watches, handbags, streetwear, trading_cards):
//   if authentication markers are absent → cap signal at FAIR, add warning
// MEDIUM categories: add warning only, no cap
// LOW categories: no action

// ── Category risk map ─────────────────────────────────────────────────────────
export const CATEGORY_REPLICA_RISK = {
  sneakers:        "HIGH",
  footwear:        "HIGH",
  shoes:           "HIGH",
  watches:         "HIGH",
  watch:           "HIGH",
  handbags:        "HIGH",
  handbag:         "HIGH",
  bag:             "HIGH",
  bags:            "HIGH",
  purse:           "HIGH",
  purses:          "HIGH",
  streetwear:      "HIGH",
  trading_cards:   "HIGH",
  "trading cards": "HIGH",
  cards:           "HIGH",
  jewelry:         "MEDIUM",
  jewellery:       "MEDIUM",
  electronics:     "MEDIUM",
  vintage_clothing:"LOW",
  clothing:        "LOW",
  apparel:         "LOW",
  tools:           "LOW",
  furniture:       "LOW",
};

// Patterns that indicate authentication evidence in visible text / item context
const AUTH_MARKER_PATTERNS = [
  /\breceipt\b/i,
  /\bauth(enticit[y]?)?\b/i,
  /\bserial\s*(number|#|no\.?)?\b/i,
  /\bcertificate\b/i,
  /\bdust\s*bag\b/i,
  /\bbarcode\b/i,
  /\bqr\s*code\b/i,
  /\bholo(gram)?\b/i,
  /\bhangtag\b/i,
  /\bhang\s*tag\b/i,
  /\bprice\s*tag\b/i,
  /\bdeadstock\b/i,
  /\bnew\s*in\s*box\b/i,
  /\bnwt\b/i,
  /\bnwob\b/i,
  /\bcoa\b/i,
  /\bsticker\b.*\bserial\b/i,
  /\bbox\b.*\blabel\b/i,
  /\bcard\b.*\bauthenti/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCat(category) {
  return String(category || "").toLowerCase().trim().replace(/[^a-z0-9 _]/g, "").replace(/\s+/g, "_");
}

function getCategoryTier(category) {
  const key = normalizeCat(category);
  if (CATEGORY_REPLICA_RISK[key]) return CATEGORY_REPLICA_RISK[key];
  // Partial match
  for (const [k, tier] of Object.entries(CATEGORY_REPLICA_RISK)) {
    const kn = k.replace(/ /g, "_");
    if (key.includes(kn) || kn.includes(key)) return tier;
  }
  return "LOW";
}

function detectAuthMarkers(visionIdentity, scanContext) {
  const sources = [
    ...(Array.isArray(visionIdentity?.visibleText) ? visionIdentity.visibleText : []),
    visionIdentity?.notes       || "",
    visionIdentity?.description || "",
    scanContext?.title          || "",
    scanContext?.notes          || "",
    scanContext?.description    || "",
  ].map(t => String(t || "").toLowerCase());

  const combined = sources.join(" ");
  return AUTH_MARKER_PATTERNS.some(p => p.test(combined));
}

// ── Text mismatch (spoof detection) ──────────────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = [];
  for (let i = 0; i <= m; i++) dp[i] = [i];
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Returns true if visible text contains a near-match that is NOT an exact match
 * for the brand — e.g., "Nikee", "N1ke", "Ad1das".
 */
function detectTextMismatch(brand, visibleText) {
  if (!brand || !Array.isArray(visibleText) || !visibleText.length) return false;
  const brandL = brand.toLowerCase().trim();
  if (brandL.length < 3) return false;

  for (const token of visibleText) {
    const t = String(token || "").toLowerCase().trim();
    if (!t || t.length < 2) continue;
    // Exact match or contains brand → not a mismatch
    if (t === brandL || t.includes(brandL) || brandL.includes(t)) continue;
    // Near-match: edit distance 1–2 for similar-length strings → spoof candidate
    const lenRatio = Math.min(t.length, brandL.length) / Math.max(t.length, brandL.length);
    if (lenRatio >= 0.7 && levenshtein(brandL, t) <= 2) return true;
  }
  return false;
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Compute replica risk for a scanned item.
 * Only runs marker detection for HIGH categories — avoids work on LOW/MEDIUM.
 *
 * @returns {{ tier, markersDetected, cappingSignal, warning }}
 */
export function computeReplicaRisk(category, visionIdentity, visibleText, scanContext = {}) {
  const tier = getCategoryTier(category);

  const markersDetected = tier === "HIGH"
    ? detectAuthMarkers(visionIdentity || {}, scanContext)
    : true; // LOW/MEDIUM pass without inspection

  const cappingSignal = tier === "HIGH" && !markersDetected;

  const warning = cappingSignal
    ? "Replica risk: authentication not confirmed — tags, receipt, or serial number not visible in image"
    : tier === "MEDIUM"
    ? "Category has moderate counterfeit risk — verify authenticity before buying"
    : null;

  return { tier, markersDetected, cappingSignal, warning };
}

/**
 * Compute identity confidence flags.
 * Returned alongside identity quality in the scan response.
 */
export function computeIdentityFlags(visionIdentity, attributeCertainty) {
  const brand      = visionIdentity?.brand  || null;
  const model      = visionIdentity?.model  || null;
  const visText    = Array.isArray(visionIdentity?.visibleText)
    ? visionIdentity.visibleText.filter(t => String(t || "").length >= 2)
    : [];
  const brandL     = brand ? brand.toLowerCase() : null;
  const modelL     = model ? model.toLowerCase() : null;

  const brandTextVisible = brandL
    ? visText.some(t => String(t).toLowerCase().includes(brandL))
    : false;
  const modelTextVisible = modelL
    ? visText.some(t => String(t).toLowerCase().includes(modelL))
    : false;
  const textMismatchDetected = brand ? detectTextMismatch(brand, visText) : false;

  return { brandTextVisible, modelTextVisible, textMismatchDetected };
}
