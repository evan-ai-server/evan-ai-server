// src/signalWarnings.js
// Structured Signal Warnings — converts scan output into typed warning objects.
//
// Called in assembleProfitIntel after all gates have run.
// Produces warnings[] that are always present (never null) in the response.
// Frontend uses type to render the right badge/card.

const WARNING_TYPES = {
  THIN_MARKET:      "THIN_MARKET",
  WEAK_IDENTITY:    "WEAK_IDENTITY",
  SIGNAL_CAPPED:    "SIGNAL_CAPPED",
  UNCALIBRATED:     "UNCALIBRATED",
  REPLICA_RISK:     "REPLICA_RISK",
  LISTED_DOMINATED: "LISTED_DOMINATED",
  LOCAL_SPARSE:     "LOCAL_SPARSE",
};

/**
 * Generate structured warning objects from assembled scan output.
 *
 * @param {object} scanOutput — partial or full output of assembleProfitIntel
 * @returns {Array<{ type, severity, message, detail? }>}
 */
export function generateScanWarnings(scanOutput) {
  const w = [];

  // ── THIN_MARKET: too few real comparable sales ────────────────────────────
  const depthTier  = scanOutput?.depthTier;
  const depthCount = scanOutput?.depthCount ?? 0;
  if (depthTier === "THIN" || depthTier === "INSUFFICIENT") {
    w.push({
      type:     WARNING_TYPES.THIN_MARKET,
      severity: depthTier === "INSUFFICIENT" ? "HIGH" : "MEDIUM",
      message:  `Only ${depthCount} comparable sale${depthCount !== 1 ? "s" : ""} found.`,
      detail:   "Price estimate has wide uncertainty — verify independently before buying.",
    });
  }

  // ── LISTED_DOMINATED: comps are mostly unsold listings ────────────────────
  if (scanOutput?.listedDominated) {
    w.push({
      type:     WARNING_TYPES.LISTED_DOMINATED,
      severity: "MEDIUM",
      message:  "Most comps are unsold listings — market may not clear at this price.",
      detail:   `Effective sold comp count: ${scanOutput?.effectiveCount ?? "?"}`,
    });
  }

  // ── WEAK_IDENTITY: brand/model not confirmed from image ───────────────────
  const iq    = Number(scanOutput?.identityQuality ?? 1);
  const flags = scanOutput?.identityFlags;
  if (iq < 0.45 || (flags && flags.brandTextVisible === false && scanOutput?.visionIdentityBrand)) {
    w.push({
      type:     WARNING_TYPES.WEAK_IDENTITY,
      severity: iq < 0.30 ? "HIGH" : "MEDIUM",
      message:  "Brand or model could not be confirmed from image.",
      detail:   flags?.textMismatchDetected
        ? "Possible brand name variation detected in visible text."
        : "No brand text visible in photo — identification is shape-based only.",
    });
  }

  // ── SIGNAL_CAPPED: signal was downgraded ──────────────────────────────────
  if (scanOutput?.signalCapped && scanOutput?.signalRaw && scanOutput?.capReason) {
    w.push({
      type:     WARNING_TYPES.SIGNAL_CAPPED,
      severity: "MEDIUM",
      message:  `Signal downgraded from ${scanOutput.signalRaw} — ${scanOutput.capReason}.`,
      detail:   null,
    });
  }

  // ── REPLICA_RISK: high-risk category without auth markers ─────────────────
  if (scanOutput?.replicaRisk?.cappingSignal) {
    w.push({
      type:     WARNING_TYPES.REPLICA_RISK,
      severity: "HIGH",
      message:  scanOutput.replicaRisk.warning || "Replica risk: authentication not confirmed.",
      detail:   "Look for receipt, serial sticker, tags, or authentication card before buying.",
    });
  } else if (scanOutput?.replicaRisk?.tier === "MEDIUM" && scanOutput?.replicaRisk?.warning) {
    w.push({
      type:     WARNING_TYPES.REPLICA_RISK,
      severity: "LOW",
      message:  scanOutput.replicaRisk.warning,
      detail:   null,
    });
  }

  // ── UNCALIBRATED: no local calibration data for this category ────────────
  const catWinRate    = scanOutput?.categoryWinRate;
  const totalSamples  = scanOutput?.calibrationSamples ?? 0;
  if (catWinRate === null && totalSamples === 0) {
    w.push({
      type:     WARNING_TYPES.UNCALIBRATED,
      severity: "LOW",
      message:  "No local calibration data for this category.",
      detail:   "Signal accuracy in this category is unverified for your account.",
    });
  }

  // ── LOCAL_SPARSE: LOCAL mode but not enough local comps ──────────────────
  if (scanOutput?.resaleMode === "LOCAL" && scanOutput?.localResultCount != null
      && scanOutput.localResultCount < 8) {
    w.push({
      type:     WARNING_TYPES.LOCAL_SPARSE,
      severity: "MEDIUM",
      message:  `Limited local data — only ${scanOutput.localResultCount} local listing${scanOutput.localResultCount !== 1 ? "s" : ""} found.`,
      detail:   "Price confidence is reduced for this locally-traded item.",
    });
  }

  return w;
}

/**
 * Merge structured warnings from generateScanWarnings with existing plain-string
 * warnings already in the scan output. Returns deduplicated mixed array.
 * The structured objects go first (they have `type`), then legacy strings.
 */
export function mergeWarnings(structuredWarnings, legacyStrings) {
  const structured = Array.isArray(structuredWarnings) ? structuredWarnings : [];
  const legacy     = Array.isArray(legacyStrings)
    ? legacyStrings.filter(s => typeof s === "string" && s.length > 0)
    : [];

  // De-dup legacy strings that are already covered by a structured warning
  const coveredMessages = new Set(structured.map(w => w.message));
  const filteredLegacy  = legacy.filter(s => !coveredMessages.has(s));

  return [...structured, ...filteredLegacy];
}

export { WARNING_TYPES };
