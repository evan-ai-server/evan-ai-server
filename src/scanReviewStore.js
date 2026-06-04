// src/scanReviewStore.js
// Phase 4C — Real-world scan accuracy review store.
//
// Append-only JSONL ledger of structured "scan review" artifacts: one record
// per completed market scan, capturing the predicted identity, the generated
// search query, the market verdict + evidence tier, the exact identity-rejection
// summary, and the top listings the user saw — plus a human `review` block for
// manual identity/query/verdict correction.
//
// This is a DEV/INTERNAL accuracy-review dataset, NOT an outcome/profit tracker
// (that is Phase 4D). Every write is best-effort and NEVER throws: a failed
// review write must never affect a scan response.
//
// No raw image files or image bytes are ever stored — only an optional,
// already-computed imageHash (and its 12-char prefix).

import fs from "fs/promises";
import path from "path";

export const SCAN_REVIEW_SCHEMA_VERSION = "scan_review_v1";

const MAX_TOP_LISTINGS  = 12;
const MAX_TITLE_LEN     = 200;
const MAX_NOTES_LEN     = 4000;
const MAX_NOTE_ITEM_LEN = 500;
const MAX_NOTE_ITEMS    = 50;
const MAX_VARIANTS      = 24;
const MAX_IDENTITY_KEYS = 24;
const MAX_STRING_LEN    = 240;

// Paths are resolved at call time (not import time) so tests can redirect all
// writes via SCAN_REVIEW_DIR without fighting ESM import hoisting.
function storePaths() {
  const dir = process.env.SCAN_REVIEW_DIR
    ? path.resolve(process.env.SCAN_REVIEW_DIR)
    : path.resolve("storage/intelligence");
  return {
    dir,
    jsonl:  path.join(dir, "scan-review.jsonl"),
    latest: path.join(dir, "scan-review-latest.json"),
  };
}

let _dirReady = null;
async function ensureDir(dir) {
  // Re-arm if the target dir changed between calls (e.g. tests vs. prod).
  if (!_dirReady || _dirReady.dir !== dir) {
    _dirReady = { dir, p: fs.mkdir(dir, { recursive: true }).catch(() => {}) };
  }
  return _dirReady.p;
}

// ── primitive sanitizers ────────────────────────────────────────────────────

function str(v, max = MAX_STRING_LEN) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intOr(v, d = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
}
function boolOrNull(v) {
  if (v === true || v === false) return v;
  return null;
}
function strArray(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, maxItems)
    .map((x) => str(x, maxLen))
    .filter((x) => x != null && x !== "");
}

// Known identity vocabulary. Only these keys survive — so an unknown or
// image/byte-like key (imageBytes, thumbnail, base64, rawHtml, …) is dropped
// regardless of its value. An allowlist is deliberate: it guarantees no raw
// image data can ever leak into a review record via a free-form identity blob.
const _IDENTITY_ALLOWED_KEYS = new Set([
  "title", "name", "brand", "manufacturer", "model", "modelVariant", "variant",
  "family", "series", "line", "subline", "theme", "edition", "collection",
  "colorway", "color", "sku", "styleCode", "upc", "mpn",
  "category", "subcategory", "type", "condition", "scale", "year", "releaseYear",
  "size", "gender", "airline", "productLine", "set", "character", "franchise",
]);

// Project a free-form identity object down to small scalar values for known
// identity fields only. Nested objects, arrays, and any non-allowlisted key are
// dropped so records stay compact and never carry raw image data.
function sanitizeIdentityObject(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= MAX_IDENTITY_KEYS) break;
    if (v == null) continue;
    if (!_IDENTITY_ALLOWED_KEYS.has(k)) continue;
    if (typeof v === "string") { out[k] = str(v, MAX_STRING_LEN); n++; }
    else if (typeof v === "number" && Number.isFinite(v)) { out[k] = v; n++; }
    else if (typeof v === "boolean") { out[k] = v; n++; }
    // objects / arrays / buffers are intentionally skipped
  }
  return out;
}

// Only safe, review-useful listing fields survive. Anything image-like or large
// (imageUrl, thumbnail, base64, raw bytes, full description, etc.) is dropped.
function sanitizeListing(raw, rank) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    rank,
    title:             str(r.title, MAX_TITLE_LEN),
    price:             num(r.price ?? r.numericPrice),
    totalPrice:        num(r.totalPrice),
    source:            str(r.source, 80),
    seller:            str(r.seller ?? r.merchant ?? null, 120),
    clickable:         r.clickable === true ? true : (r.clickable === false ? false : null),
    isVerifiedListing: r.isVerifiedListing === true,
    evidenceQuality:   str(r.evidenceQuality, 60),
    urlQuality:        str(r.urlQuality, 60),
    host:              str(r.host ?? null, 120),
  };
}

function sanitizeTopListings(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_TOP_LISTINGS).map((it, i) => sanitizeListing(it, i + 1));
}

// Full identity-rejection bucket set (mirrors src/identityRejectionSummary.js).
const _REJECTION_COUNT_FIELDS = [
  "rejectedCompetitorCount", "rejectedFamilyCount", "rejectedManufacturerCount",
  "rejectedModelMismatchCount", "rejectedMissingAirlineCount",
  "rejectedWeakAirlineGenericCount", "rejectedGenericToyCount", "rejectedMerchCount",
  "rejectedSneakerWrongLineCount", "rejectedSneakerWrongGenerationCount", "rejectedSneakerVariantCount",
  "rejectedJordanWrongModelCount", "rejectedJordanWrongCutCount", "rejectedJordanWrongSublineCount",
  "rejectedJordanWrongThemeCount", "rejectedJordanNonJordanCount",
  "rejectedOtherIdentityCount",
];

function projectIdentityRejections(s) {
  const src = s && typeof s === "object" ? s : {};
  const out = {
    totalRejectedCount: intOr(src.totalRejectedCount, 0),
    rejectionRatio:     num(src.rejectionRatio) ?? 0,
    appliedLocks:       strArray(src.appliedLocks, MAX_IDENTITY_KEYS, 80),
  };
  for (const f of _REJECTION_COUNT_FIELDS) out[f] = intOr(src[f], 0);
  return out;
}

// ── record creation ─────────────────────────────────────────────────────────

/**
 * Build a sanitized, compact scan-review record from loosely-shaped capture
 * input. Pure + synchronous; never throws; always returns a valid record.
 *
 * input = {
 *   scanId, traceId, rid, route, userId, deviceId, imageHash,
 *   predicted: { query, finalQuery, category, brand, model, identity, variants,
 *                visionConfidence, visualConfidence, brandCertainty },
 *   market:    { finalVerdict, displayedVerdict, canonicalVerdict,
 *                calibratedConfidence, marketConfidence, evidenceConfidence,
 *                evidenceTier, verdictStrengthCap, canShowVerifiedLanguage,
 *                canShowStrongLanguage, canShowMedianAsAuthoritative,
 *                verifiedListingCount, pricingSignalCount, cleanCompCount,
 *                consensusMedian, consensusListingCount, consensusSpread,
 *                marketEvidenceConfidence, marketEvidenceReason,
 *                urlVerificationEnabled },
 *   identityRejections: <normalized identity summary>,
 *   topListings: [ <raw listing objects — sanitized + capped here> ],
 * }
 */
export function createScanReviewRecord(input = {}) {
  const i = input && typeof input === "object" ? input : {};
  const p = i.predicted && typeof i.predicted === "object" ? i.predicted : {};
  const m = i.market    && typeof i.market    === "object" ? i.market    : {};
  const now = new Date().toISOString();

  const imageHash = str(i.imageHash, 128);

  return {
    schemaVersion: SCAN_REVIEW_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: null,

    scanId:   str(i.scanId, 128),
    traceId:  str(i.traceId, 128),
    rid:      str(i.rid, 128),
    route:    str(i.route, 80),
    userId:   str(i.userId, 128),
    deviceId: str(i.deviceId, 128),

    imageHash,
    imageHashPrefix: imageHash ? imageHash.slice(0, 12) : null,

    predicted: {
      query:            str(p.query, MAX_STRING_LEN),
      finalQuery:       str(p.finalQuery, MAX_STRING_LEN),
      category:         str(p.category, 120),
      brand:            str(p.brand, 120),
      model:            str(p.model, 120),
      identity:         sanitizeIdentityObject(p.identity),
      variants:         strArray(p.variants, MAX_VARIANTS, MAX_STRING_LEN),
      visionConfidence: num(p.visionConfidence) ?? 0,
      visualConfidence: num(p.visualConfidence) ?? 0,
      brandCertainty:   num(p.brandCertainty) ?? 0,
    },

    market: {
      finalVerdict:     str(m.finalVerdict, 40),
      displayedVerdict: str(m.displayedVerdict, 40),
      canonicalVerdict: str(m.canonicalVerdict, 40),
      calibratedConfidence: num(m.calibratedConfidence),
      marketConfidence:     num(m.marketConfidence),
      evidenceConfidence:   num(m.evidenceConfidence),
      evidenceTier:         str(m.evidenceTier, 60),
      verdictStrengthCap:   str(m.verdictStrengthCap, 60),
      canShowVerifiedLanguage:      boolOrNull(m.canShowVerifiedLanguage),
      canShowStrongLanguage:        boolOrNull(m.canShowStrongLanguage),
      canShowMedianAsAuthoritative: boolOrNull(m.canShowMedianAsAuthoritative),
      verifiedListingCount: intOr(m.verifiedListingCount, 0),
      pricingSignalCount:   intOr(m.pricingSignalCount, 0),
      cleanCompCount:       num(m.cleanCompCount),
      consensusMedian:        num(m.consensusMedian),
      consensusListingCount:  num(m.consensusListingCount),
      consensusSpread:        num(m.consensusSpread),
      marketEvidenceConfidence: str(m.marketEvidenceConfidence, 20),
      marketEvidenceReason:     str(m.marketEvidenceReason, MAX_STRING_LEN),
      urlVerificationEnabled:   m.urlVerificationEnabled === true,
    },

    identityRejections: projectIdentityRejections(i.identityRejections),

    topListings: sanitizeTopListings(i.topListings),

    review: {
      status: "unreviewed",
      identityCorrect: null,
      queryCorrect: null,
      topListingsComparable: null,
      verdictFair: null,
      displayedVerdictMatchesBackend: null,
      correctedIdentity: null,
      correctedSearchQuery: null,
      badListingNotes: [],
      notes: "",
      reviewedAt: null,
      reviewedBy: null,
    },
  };
}

// ── write / read ────────────────────────────────────────────────────────────

/** Append one record as a JSONL line. Returns true on success, false on any
 *  failure. Never throws. Also refreshes the best-effort `latest` pointer. */
export async function appendScanReviewRecord(record) {
  try {
    if (!record || typeof record !== "object") return false;
    const { dir, jsonl, latest } = storePaths();
    await ensureDir(dir);
    await fs.appendFile(jsonl, JSON.stringify(record) + "\n", "utf8");
    // Best-effort convenience pointer for quick `cat`; failure is non-fatal.
    fs.writeFile(latest, JSON.stringify(record, null, 2), "utf8").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Read up to `limit` most-recent records, newest-first. Never throws. */
export async function readRecentScanReviews({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(1000, intOr(limit, 50)));
  const { jsonl } = storePaths();
  let raw;
  try {
    raw = await fs.readFile(jsonl, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  // File is append-order (oldest → newest), so walk from the end for newest-first.
  for (let k = lines.length - 1; k >= 0 && out.length < lim; k--) {
    try { out.push(JSON.parse(lines[k])); } catch { /* skip corrupt line */ }
  }
  return out;
}

/** Return the most-recent record for a scanId, or null. Never throws. */
export async function findScanReviewByScanId(scanId) {
  const id = str(scanId, 128);
  if (!id) return null;
  const { jsonl } = storePaths();
  let raw;
  try { raw = await fs.readFile(jsonl, "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter(Boolean);
  for (let k = lines.length - 1; k >= 0; k--) {
    try {
      const rec = JSON.parse(lines[k]);
      if (rec && rec.scanId === id) return rec;
    } catch { /* skip corrupt line */ }
  }
  return null;
}

// Sanitize + merge a human review patch into the existing review block. Only
// the review block is touched — predicted/market/identityRejections/topListings
// are preserved verbatim by the caller.
function applyReviewPatch(existing, patch) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  const p = patch && typeof patch === "object" ? patch : {};

  if ("identityCorrect" in p)                base.identityCorrect = boolOrNull(p.identityCorrect);
  if ("queryCorrect" in p)                   base.queryCorrect = boolOrNull(p.queryCorrect);
  if ("topListingsComparable" in p)          base.topListingsComparable = boolOrNull(p.topListingsComparable);
  if ("verdictFair" in p)                    base.verdictFair = boolOrNull(p.verdictFair);
  if ("displayedVerdictMatchesBackend" in p) base.displayedVerdictMatchesBackend = boolOrNull(p.displayedVerdictMatchesBackend);
  if ("correctedIdentity" in p)              base.correctedIdentity = p.correctedIdentity == null ? null : sanitizeIdentityObject(p.correctedIdentity);
  if ("correctedSearchQuery" in p)           base.correctedSearchQuery = str(p.correctedSearchQuery, MAX_STRING_LEN);
  if ("badListingNotes" in p)                base.badListingNotes = strArray(p.badListingNotes, MAX_NOTE_ITEMS, MAX_NOTE_ITEM_LEN);
  if ("notes" in p)                          base.notes = str(p.notes, MAX_NOTES_LEN) || "";
  if ("reviewedBy" in p)                     base.reviewedBy = str(p.reviewedBy, 80);

  if (!Array.isArray(base.badListingNotes)) base.badListingNotes = [];
  if (typeof base.notes !== "string")       base.notes = "";

  base.reviewedAt = new Date().toISOString();
  const hasJudgment =
    base.identityCorrect != null || base.queryCorrect != null ||
    base.topListingsComparable != null || base.verdictFair != null ||
    base.displayedVerdictMatchesBackend != null ||
    (typeof base.notes === "string" && base.notes.length > 0) ||
    base.correctedSearchQuery != null ||
    base.correctedIdentity != null ||
    (Array.isArray(base.badListingNotes) && base.badListingNotes.length > 0);
  base.status = hasJudgment ? "reviewed" : (base.status || "unreviewed");

  return base;
}

/** Apply a sanitized review patch to the most-recent record for `scanId`,
 *  rewriting the JSONL. Returns the updated record, or null if not found / on
 *  failure. predicted/market/identityRejections/topListings are preserved. */
export async function updateScanReview(scanId, patch) {
  const id = str(scanId, 128);
  if (!id) return null;
  const { dir, jsonl, latest } = storePaths();
  let raw;
  try { raw = await fs.readFile(jsonl, "utf8"); } catch { return null; }
  const lines = raw.split("\n").filter(Boolean);

  let lastIdx = -1;
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  for (let k = 0; k < parsed.length; k++) {
    if (parsed[k] && parsed[k].scanId === id) lastIdx = k;
  }
  if (lastIdx < 0) return null;

  const rec = parsed[lastIdx];
  rec.review = applyReviewPatch(rec.review, patch);
  rec.updatedAt = new Date().toISOString();
  parsed[lastIdx] = rec;

  try {
    const next = parsed.filter(Boolean).map((r) => JSON.stringify(r)).join("\n") + "\n";
    await ensureDir(dir);
    await fs.writeFile(jsonl, next, "utf8");
    fs.writeFile(latest, JSON.stringify(rec, null, 2), "utf8").catch(() => {});
  } catch {
    return null;
  }
  return rec;
}

export const SCAN_REVIEW_PATHS = { storePaths };
