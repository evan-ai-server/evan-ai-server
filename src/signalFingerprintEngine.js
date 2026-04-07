// src/signalFingerprintEngine.js
// Institutional Bridge — Signal Fingerprint Engine.
//
// Post-processes the 3-pass vision consensus output to produce:
//   1. A structured Signal Map  — machine-readable evidence record
//   2. raw_evidence_hash        — SHA-256 of the evidence payload (Phase 7 audit anchor)
//   3. autoCropRequired         — whether the engine should re-scan a cropped region
//   4. institutionalIds         — normalized SKU / serial / model / style code
//   5. Partial progress tokens  — status strings for the Phase 8 UI animation layer
//
// Signal Map feeds directly into:
//   - Phase 7 externalTrustReferenceEngine (via raw_evidence_hash → auditHash)
//   - Phase 8 shareableLinkEngine  (referenceRecord field population)
//   - Phase 10 P&L Engine          (institutional identification for comps accuracy)
//
// Auto-crop trigger:
//   - Fires when overall confidence < AUTO_CROP_CONFIDENCE_THRESHOLD
//   - AND no institutional identifier was resolved
//   - AND at least one pass returned a non-null identity (something is there)
//   - Instructs the client to crop the visible tag/label region and re-scan
//
// Evidence hash:
//   - SHA-256 of canonical JSON: { query, brand, model, institutionalIds, confidence, passCount }
//   - Hex-encoded, prefixed "sha256:"
//   - Deterministic for identical evidence — allows Phase 7 tamper detection

import crypto from "crypto";

export const SIGNAL_FINGERPRINT_VERSION = "bridge_1.0";

const AUTO_CROP_CONFIDENCE_THRESHOLD = 0.42;

// ── Institutional identifier patterns ────────────────────────────────────────
// These are the regex-based extractors that run on visibleText as a safety net
// when the vision model did not fill institutionalIds directly.

const PATTERNS = {
  // Nike/Jordan style code: e.g. "CT8012-100", "DH7138-600"
  nike_sku:     /\b([A-Z]{2}\d{4,5}[-–]\d{3})\b/,
  // Adidas: e.g. "GX3537", "HQ1857"
  adidas_sku:   /\b([A-Z]{2}\d{4,5})\b/,
  // Generic numeric SKU: 6-12 digit pure numeric
  numeric_sku:  /\b(\d{6,12})\b/,
  // Serial: alphanumeric with mixed case, 8–16 chars
  serial:       /\b([A-Z0-9]{8,16})\b/,
  // Model code: uppercase letters + numbers, e.g. "Sub 16610", "J12 H5698"
  model_code:   /\b([A-Z]{1,4}[-\s]?\d{4,6}[A-Z]?)\b/,
  // Barcode-style EAN/UPC (12-13 digits)
  ean:          /\b(\d{12,13})\b/,
  // Style code: e.g. "Style: A01234" or "ST-1234"
  style_code:   /(?:style[:\s#]*|ST[-–\s]?)([A-Z0-9]{4,10})/i,
};

// ── Build Signal Map ──────────────────────────────────────────────────────────

/**
 * Build the full Signal Map from a vision consensus result.
 *
 * @param {object} visionResult
 *   result from runVisionConsensus:
 *   { ok, query, variants, confidence, identity, attributeCertainty, authenticityFlags, conditionFlags }
 *   identity may contain institutionalIds (added to schema in Phase Bridge)
 * @param {object} [opts]
 *   imageHash   {string|null}  — for evidence hash binding
 *   mode        {string}       — "item"|"mark"|"prop"|etc.
 *   passCount   {number}       — how many vision passes ran
 * @returns {SignalMapResult}
 */
export function buildSignalMap(visionResult, { imageHash = null, mode = "item", passCount = 2 } = {}) {
  if (!visionResult) return _emptySignalMap();

  const identity    = visionResult.identity || {};
  const attrCert    = visionResult.attributeCertainty || {};
  const confidence  = clamp01(Number(visionResult.confidence) || 0);
  const query       = visionResult.query || null;

  // 1. Extract / normalize institutional identifiers
  const institutionalIds = _resolveInstitutionalIds(identity, visionResult.institutionalIds);

  // 2. Resolve auto-crop requirement
  const autoCropRequired = _shouldAutoCrop({
    confidence,
    institutionalIds,
    identity,
    mode,
  });

  // 3. Build evidence hash (deterministic anchor for Phase 7)
  const evidencePayload = {
    query,
    brand:            identity.brand  || null,
    model:            identity.model  || null,
    institutionalIds,
    confidence:       Math.round(confidence * 1000) / 1000,
    passCount,
    imageHash:        imageHash || null,
    fingerprintVersion: SIGNAL_FINGERPRINT_VERSION,
  };
  const rawEvidenceHash = _hashEvidence(evidencePayload);

  // 4. Resolve progress token (for Phase 8 UI animation)
  const progressToken = _resolveProgressToken({ institutionalIds, confidence, identity });

  // 5. Identity quality signal (0–1, used by Phase 7 certification scorer)
  const identityQuality = _scoreIdentityQuality({ identity, attrCert, confidence, institutionalIds });

  // 6. Verification readiness — can this evidence support a Phase 7 reference?
  const verificationReady = _isVerificationReady({ identityQuality, institutionalIds, confidence });

  return {
    ok:                 true,
    signalVersion:      SIGNAL_FINGERPRINT_VERSION,
    query,
    institutionalIds,
    identityQuality,
    confidence,
    autoCropRequired,
    autoCropReason:     autoCropRequired ? _autoCropReason({ confidence, institutionalIds }) : null,
    rawEvidenceHash,
    progressToken,
    verificationReady,
    evidenceSummary: {
      hasBrand:           !!identity.brand,
      hasModel:           !!identity.model,
      hasSku:             !!institutionalIds.sku,
      hasSerial:          !!institutionalIds.serialNumber,
      hasModelCode:       !!institutionalIds.modelCode,
      authenticityFlags:  Array.isArray(visionResult.authenticityFlags) ? visionResult.authenticityFlags : [],
      visibleTextCount:   Array.isArray(identity.visibleText) ? identity.visibleText.length : 0,
    },
  };
}

// ── Institutional ID resolution ───────────────────────────────────────────────

function _resolveInstitutionalIds(identity, modelExtracted = null) {
  // Priority: model-extracted > parsed from visibleText > inferred from model name

  const resolved = {
    sku:          null,
    serialNumber: null,
    modelCode:    null,
    styleCode:    null,
    skuSource:    null,
  };

  // Use model-extracted if present (from schema institutionalIds field)
  if (modelExtracted && typeof modelExtracted === "object") {
    if (modelExtracted.sku)          resolved.sku          = String(modelExtracted.sku).trim();
    if (modelExtracted.serialNumber) resolved.serialNumber = String(modelExtracted.serialNumber).trim();
    if (modelExtracted.modelCode)    resolved.modelCode    = String(modelExtracted.modelCode).trim();
    if (modelExtracted.styleCode)    resolved.styleCode    = String(modelExtracted.styleCode).trim();
    if (modelExtracted.skuSource)    resolved.skuSource    = String(modelExtracted.skuSource).trim();
    if (_hasAnyId(resolved))         return resolved;
  }

  // Fall back: parse visibleText
  const visibleText = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const combined    = visibleText.join(" ");

  if (!resolved.sku) {
    const nikeMatch    = combined.match(PATTERNS.nike_sku);
    const adidasMatch  = combined.match(PATTERNS.adidas_sku);
    const numericMatch = combined.match(PATTERNS.numeric_sku);
    resolved.sku       = nikeMatch?.[1] || adidasMatch?.[1] || numericMatch?.[1] || null;
    if (resolved.sku) resolved.skuSource = "visible_text";
  }

  if (!resolved.serialNumber) {
    const serialMatch = combined.match(PATTERNS.serial);
    // Filter out things that look like prices or dates
    if (serialMatch && !/^\d{4}$/.test(serialMatch[1]) && !/\$/.test(serialMatch[1])) {
      resolved.serialNumber = serialMatch[1];
      if (!resolved.skuSource) resolved.skuSource = "visible_text";
    }
  }

  if (!resolved.modelCode) {
    const modelMatch = combined.match(PATTERNS.model_code);
    resolved.modelCode = modelMatch?.[1] || null;
  }

  if (!resolved.styleCode) {
    const styleMatch = combined.match(PATTERNS.style_code);
    resolved.styleCode = styleMatch?.[1] || null;
  }

  // Last resort: if identity.model looks like a code, use as modelCode
  if (!resolved.modelCode && identity.model) {
    const m = identity.model;
    if (/^[A-Z0-9]/.test(m) && /\d/.test(m) && m.length <= 20) {
      resolved.modelCode = m;
      if (!resolved.skuSource) resolved.skuSource = "inferred";
    }
  }

  return resolved;
}

// ── Auto-crop logic ───────────────────────────────────────────────────────────

function _shouldAutoCrop({ confidence, institutionalIds, identity, mode }) {
  if (mode !== "item") return false;
  if (confidence >= AUTO_CROP_CONFIDENCE_THRESHOLD) return false;
  if (_hasAnyId(institutionalIds)) return false;  // already have enough
  // Something is identified (not totally blank)
  const hasAnyIdentity = !!(identity.brand || identity.model || identity.itemType);
  return hasAnyIdentity;
}

function _autoCropReason({ confidence, institutionalIds }) {
  if (confidence < AUTO_CROP_CONFIDENCE_THRESHOLD) {
    return `Low confidence (${Math.round(confidence * 100)}%) — isolate and re-scan the identification tag or label for a stronger signal`;
  }
  return "No institutional identifier found — crop the tag region to extract SKU or serial";
}

// ── Evidence hashing ──────────────────────────────────────────────────────────

function _hashEvidence(payload) {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return "sha256:" + crypto.createHash("sha256").update(canonical).digest("hex");
}

// ── Progress token ────────────────────────────────────────────────────────────

function _resolveProgressToken({ institutionalIds, confidence, identity }) {
  if (institutionalIds.sku || institutionalIds.serialNumber) return "SKU_EXTRACTED";
  if (institutionalIds.modelCode)                            return "MODEL_CODE_EXTRACTED";
  if (identity.brand && identity.model && confidence >= 0.65)return "BRAND_MODEL_CONFIRMED";
  if (identity.brand && confidence >= 0.50)                  return "BRAND_IDENTIFIED";
  if (identity.itemType)                                     return "ITEM_TYPE_DETECTED";
  return "IMAGE_ANALYZED";
}

// ── Identity quality score ────────────────────────────────────────────────────

function _scoreIdentityQuality({ identity, attrCert, confidence, institutionalIds }) {
  let score = 0;

  // Brand certainty
  const brandCert = Number(attrCert.brand || 0);
  if (identity.brand)  score += brandCert > 0.75 ? 0.25 : brandCert > 0.45 ? 0.15 : 0.08;

  // Model certainty
  const modelCert = Number(attrCert.model || 0);
  if (identity.model)  score += modelCert > 0.75 ? 0.25 : modelCert > 0.45 ? 0.15 : 0.08;

  // Institutional identifiers
  if (institutionalIds.sku)          score += 0.20;
  if (institutionalIds.serialNumber) score += 0.15;
  if (institutionalIds.modelCode)    score += 0.10;

  // Raw vision confidence contribution
  score += confidence * 0.15;

  return Math.min(Math.round(score * 100) / 100, 1.0);
}

// ── Verification readiness ────────────────────────────────────────────────────

function _isVerificationReady({ identityQuality, institutionalIds, confidence }) {
  if (identityQuality >= 0.65) return true;
  if (_hasAnyId(institutionalIds) && confidence >= 0.50) return true;
  return false;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _hasAnyId(ids) {
  return !!(ids.sku || ids.serialNumber || ids.modelCode || ids.styleCode);
}

function _emptySignalMap() {
  return {
    ok:              false,
    signalVersion:   SIGNAL_FINGERPRINT_VERSION,
    institutionalIds:{ sku: null, serialNumber: null, modelCode: null, styleCode: null, skuSource: null },
    identityQuality: 0,
    confidence:      0,
    autoCropRequired:false,
    autoCropReason:  null,
    rawEvidenceHash: null,
    progressToken:   "IMAGE_ANALYZED",
    verificationReady: false,
    evidenceSummary: { hasBrand: false, hasModel: false, hasSku: false, hasSerial: false, hasModelCode: false, authenticityFlags: [], visibleTextCount: 0 },
  };
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}
