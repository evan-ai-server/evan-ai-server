// src/urlEvidenceAudit.js
// Phase V3.9A — URL Evidence Audit helpers.
//
// PURE + dependency-free. These summarize listing FIELD PRESENCE only
// (counts, booleans, urlQuality histogram, short title prefixes). They never
// emit raw URLs or whole payloads, never mutate items, and never make network
// calls — so the logs that consume them are safe to leave on in dev and prod.
//
// They model the exact recovery-eligibility rule used in
// buildMarketSearchResponsePayload (index.js ~25188): a recovery candidate is a
// NON-clickable item that still carries a `_productId`. That is why the live
// Hawaiian 787 scan logs `DIRECT_URL_RECOVERY_ELIGIBLE ... reason:'no_product_ids'`
// — the snapshot it was served from had already dropped `_productId`.

// Fields the frontend may open / that indicate a usable listing URL.
export const URL_FIELDS = ["directUrl", "url", "link", "buyLink"];

// Recovery-relevant fields that must survive caching for V3.9B to ever work.
export const RECOVERY_FIELDS = ["_productId", "_serpapiProductApiUrl", "urlQuality", "directUrl"];

function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function present(v) {
  return v != null && v !== "";
}

export function hasAnyUrl(it = {}) {
  return URL_FIELDS.some((f) => nonEmptyString(it?.[f]));
}

// Compact field-presence summary for an array of listing items.
// Output is small and bounded (urlQuality is a closed enum).
export function summarizeUrlEvidence(items = []) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  const count = (pred) => arr.reduce((n, it) => (pred(it) ? n + 1 : n), 0);

  const urlQualityCounts = {};
  for (const it of arr) {
    const q = it?.urlQuality || "(none)";
    urlQualityCounts[q] = (urlQualityCounts[q] || 0) + 1;
  }

  return {
    total:            arr.length,
    withDirectUrl:    count((it) => nonEmptyString(it?.directUrl)),
    withAnyUrl:       count(hasAnyUrl),
    withProductId:    count((it) => present(it?._productId)),
    withSerpApiUrl:   count((it) => present(it?._serpapiProductApiUrl)),
    withUrlQuality:   count((it) => present(it?.urlQuality)),
    clickableTrue:    count((it) => it?.clickable === true),
    withEvidenceTier: count((it) => present(it?.evidenceQuality)),
    verifiedListings: count((it) => it?.isVerifiedListing === true),
    urlQualityCounts,
    sampleTitles:     arr.slice(0, 3).map((it) => (it?.title || "").slice(0, 40)),
  };
}

// Which recovery-relevant fields went from present -> absent across a transform
// (e.g. snapshot write-compaction). Counts only; safe for logs. A positive
// `droppedProductId` is the V3.9A smoking gun.
export function diffUrlEvidence(before = [], after = []) {
  const b = summarizeUrlEvidence(before);
  const a = summarizeUrlEvidence(after);
  const drop = (k) => Math.max(0, (b[k] || 0) - (a[k] || 0));
  const droppedProductId  = drop("withProductId");
  const droppedSerpApiUrl = drop("withSerpApiUrl");
  const droppedDirectUrl  = drop("withDirectUrl");
  const droppedUrlQuality = drop("withUrlQuality");
  return {
    beforeTotal: b.total,
    afterTotal:  a.total,
    droppedProductId,
    droppedSerpApiUrl,
    droppedDirectUrl,
    droppedUrlQuality,
    anyRecoveryFieldDropped:
      droppedProductId > 0 || droppedSerpApiUrl > 0 ||
      droppedDirectUrl > 0 || droppedUrlQuality > 0,
  };
}

// Mirror of the server's recovery-eligibility rule (index.js ~25188).
// NOTE: deliberately ignores title/identity — URL evidence must never be a
// back-channel for identity. Identity locks run upstream, before this.
export function classifyRecoveryCandidate(it = {}) {
  if (it?.isVerifiedListing === true || it?.clickable === true) {
    return { candidate: false, reason: "already_clickable_or_verified" };
  }
  if (present(it?._productId)) {
    return { candidate: true, reason: "has_product_id" };
  }
  return { candidate: false, reason: "missing_product_id" };
}

export function extractProductIdFromGoogleUrl(googleUrl) {
  if (typeof googleUrl !== "string" || !googleUrl) return null;
  const m = googleUrl.match(/[?&,=]productid[=:](\d{5,})/i);
  return m ? m[1] : null;
}

export function recoveryEligibilitySummary(items = []) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  let eligible = 0;
  let missingProductId = 0;
  let alreadyClickableOrVerified = 0;
  for (const it of arr) {
    const c = classifyRecoveryCandidate(it);
    if (c.candidate) eligible += 1;
    else if (c.reason === "missing_product_id") missingProductId += 1;
    else alreadyClickableOrVerified += 1;
  }
  let reason;
  if (eligible > 0) reason = "has_product_ids";
  else if (arr.length === 0) reason = "empty_pool";
  else if (alreadyClickableOrVerified === arr.length) reason = "all_clickable_or_verified";
  else reason = "no_product_ids";
  return { total: arr.length, eligible, missingProductId, alreadyClickableOrVerified, reason };
}
