// src/expertCorrections.js
// Phase 2 — Expert Correction System.
//
// Allows domain experts to flag scans as fake, correct attributes, and inject
// knowledge directly into the counterfeit memory system.
//
// Flow:
//   1. User/expert submits a correction via POST /corrections/submit
//   2. Correction is stored as "pending" in Redis
//   3. Expert reviews and verifies via POST /corrections/verify
//   4. Verified corrections are applied to counterfeit memory
//   5. Rejected corrections are archived but not applied
//
// Redis key structure:
//   correction:{correctionId}           → JSON (full correction)
//   corrections:pending                 → ZSET (correctionId → ts)
//   corrections:verified                → ZSET (correctionId → ts)
//   corrections:scan:{scanId}           → SET  (correctionIds for a scan)
//   corrections:brand:{category}:{brand}→ SET  (correctionIds for brand/category)
//
// Correction object:
// {
//   correctionId        string
//   scanId              string|null     — original scan being corrected
//   userId              string|null     — who submitted the correction
//   expertId            string|null     — who verified it (null until verified)
//   category            string
//   brand               string
//   model               string|null
//   reportedAttributes  object          — what the scan extracted (may be wrong)
//   correctedAttributes object          — what the expert says is correct
//   isFake              boolean         — is this item fake?
//   fakePatterns        string[]        — specific fake tells identified
//   notes               string|null
//   status              "pending"|"verified"|"rejected"
//   ts                  number          — submission timestamp
//   verifiedTs          number|null
//   patternId           string|null     — if a counterfeit pattern was created from this
// }

import crypto from "crypto";
import { addCounterfeitPattern, reinforcePattern } from "./counterfeitMemory.js";

const KEY_CORRECTION  = (id)       => `correction:${id}`;
const KEY_PENDING     = "corrections:pending";
const KEY_VERIFIED    = "corrections:verified";
const KEY_SCAN        = (scanId)   => `corrections:scan:${scanId}`;
const KEY_BRAND       = (cat, br)  => `corrections:brand:${cat}:${norm(br)}`;
const TTL_CORRECTION  = 180 * 86400;  // 6 months
const MAX_LIST = 100;

// ── Submit a correction ───────────────────────────────────────────────────────

/**
 * Submit an expert correction for a scan.
 * Automatically applies if autoApply=true and isFake=true (trusted expert sources).
 *
 * @param {object} redis
 * @param {object} opts
 * @returns {string|null} correctionId
 */
export async function submitExpertCorrection(redis, {
  scanId              = null,
  userId              = null,
  category            = "",
  brand               = "",
  model               = null,
  reportedAttributes  = {},
  correctedAttributes = {},
  isFake              = false,
  fakePatterns        = [],
  notes               = null,
  autoApply           = false,   // if true, immediately feeds into counterfeit memory
} = {}) {
  if (!redis) return null;
  try {
    const correctionId = generateCorrectionId();
    const now          = Date.now();

    const correction = {
      correctionId,
      scanId:              scanId  || null,
      userId:              userId  || null,
      expertId:            null,
      category:            category || "generic",
      brand:               brand    || "",
      model:               model    || null,
      reportedAttributes:  reportedAttributes  || {},
      correctedAttributes: correctedAttributes || {},
      isFake:              Boolean(isFake),
      fakePatterns:        Array.isArray(fakePatterns) ? fakePatterns : [],
      notes:               notes || null,
      status:              autoApply && isFake ? "verified" : "pending",
      ts:                  now,
      verifiedTs:          autoApply && isFake ? now : null,
      patternId:           null,
    };

    // Store the correction
    await redis.set(KEY_CORRECTION(correctionId), JSON.stringify(correction), { EX: TTL_CORRECTION });
    await redis.zAdd(KEY_PENDING, [{ score: now, value: correctionId }]);

    // Index by scanId if present
    if (scanId) {
      await redis.sAdd(KEY_SCAN(scanId), correctionId);
    }
    // Index by brand/category
    if (brand) {
      await redis.sAdd(KEY_BRAND(category, brand), correctionId);
    }

    // Auto-apply: immediately seed into counterfeit memory
    if (autoApply && isFake && fakePatterns.length > 0) {
      const patternId = await addCounterfeitPattern(redis, {
        category,
        brand,
        model,
        patternType:  "expert_confirmed",
        attributes:   { ...reportedAttributes, ...correctedAttributes, brand, model },
        fakeSignals:  fakePatterns,
        confidence:   0.80,
        reportCount:  1,
        source:       "expert_correction",
        addedBy:      userId || "expert",
      });

      // Update correction with patternId
      correction.patternId = patternId;
      correction.status    = "verified";
      await redis.set(KEY_CORRECTION(correctionId), JSON.stringify(correction), { EX: TTL_CORRECTION });
    }

    return correctionId;
  } catch (err) {
    console.error("[expertCorrections] submitExpertCorrection error:", err?.message);
    return null;
  }
}

/**
 * Verify (approve) a pending correction and apply to counterfeit memory.
 *
 * @param {object} redis
 * @param {string} correctionId
 * @param {object} opts — { expertId, overrides }
 * @returns {boolean} success
 */
export async function verifyCorrection(redis, correctionId, { expertId = null, overrides = {} } = {}) {
  if (!redis || !correctionId) return false;
  try {
    const raw = await redis.get(KEY_CORRECTION(correctionId));
    if (!raw) return false;

    const correction = JSON.parse(raw);
    if (correction.status !== "pending") return false;

    const now = Date.now();
    correction.status     = "verified";
    correction.expertId   = expertId || "admin";
    correction.verifiedTs = now;

    // Apply overrides from expert (e.g., expert adds more fake patterns)
    if (overrides.fakePatterns) {
      correction.fakePatterns = [...new Set([...correction.fakePatterns, ...overrides.fakePatterns])];
    }

    // Feed into counterfeit memory if it's a fake
    if (correction.isFake && correction.fakePatterns.length > 0) {
      const patternId = await addCounterfeitPattern(redis, {
        category:    correction.category,
        brand:       correction.brand,
        model:       correction.model,
        patternType: "expert_confirmed",
        attributes:  {
          ...correction.reportedAttributes,
          ...correction.correctedAttributes,
          brand: correction.brand,
          model: correction.model,
        },
        fakeSignals:  correction.fakePatterns,
        confidence:   0.85,
        reportCount:  1,
        source:       "expert_correction",
        addedBy:      correction.expertId,
      });
      correction.patternId = patternId;
    }

    // Move from pending to verified
    await redis.set(KEY_CORRECTION(correctionId), JSON.stringify(correction), { EX: TTL_CORRECTION });
    await redis.zRem(KEY_PENDING, correctionId);
    await redis.zAdd(KEY_VERIFIED, [{ score: now, value: correctionId }]);

    return true;
  } catch (err) {
    console.error("[expertCorrections] verifyCorrection error:", err?.message);
    return false;
  }
}

/**
 * Reject a pending correction.
 */
export async function rejectCorrection(redis, correctionId, { expertId = null, reason = null } = {}) {
  if (!redis || !correctionId) return false;
  try {
    const raw = await redis.get(KEY_CORRECTION(correctionId));
    if (!raw) return false;

    const correction = JSON.parse(raw);
    correction.status    = "rejected";
    correction.expertId  = expertId || "admin";
    correction.notes     = reason ? `REJECTED: ${reason}` : correction.notes;

    await redis.set(KEY_CORRECTION(correctionId), JSON.stringify(correction), { EX: TTL_CORRECTION });
    await redis.zRem(KEY_PENDING, correctionId);
    return true;
  } catch (err) {
    console.error("[expertCorrections] rejectCorrection error:", err?.message);
    return false;
  }
}

// ── Read path ─────────────────────────────────────────────────────────────────

/**
 * Get pending corrections (for admin/expert review).
 */
export async function getPendingCorrections(redis, { limit = 20, offset = 0 } = {}) {
  if (!redis) return [];
  try {
    const ids = await redis.zRange(KEY_PENDING, offset, offset + limit - 1, { REV: true });
    return fetchCorrections(redis, ids);
  } catch (err) {
    console.error("[expertCorrections] getPendingCorrections error:", err?.message);
    return [];
  }
}

/**
 * Get corrections for a specific scan.
 */
export async function getCorrectionsForScan(redis, scanId) {
  if (!redis || !scanId) return [];
  try {
    const ids = await redis.sMembers(KEY_SCAN(scanId));
    return fetchCorrections(redis, ids);
  } catch (err) {
    return [];
  }
}

/**
 * Get corrections by brand/category.
 */
export async function getCorrectionsByBrand(redis, category, brand) {
  if (!redis) return [];
  try {
    const ids = await redis.sMembers(KEY_BRAND(category, brand));
    return fetchCorrections(redis, ids.slice(0, 50));
  } catch (err) {
    return [];
  }
}

/**
 * Get correction stats summary.
 */
export async function getCorrectionStats(redis) {
  if (!redis) return { pending: 0, verified: 0 };
  try {
    const [pending, verified] = await Promise.all([
      redis.zCard(KEY_PENDING),
      redis.zCard(KEY_VERIFIED),
    ]);
    return { pending: pending || 0, verified: verified || 0 };
  } catch { return { pending: 0, verified: 0 }; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchCorrections(redis, ids) {
  if (!ids || ids.length === 0) return [];
  const raws = await Promise.all(ids.map(id => redis.get(KEY_CORRECTION(id))));
  return raws
    .filter(Boolean)
    .map(raw => { try { return JSON.parse(raw); } catch { return null; } })
    .filter(Boolean);
}

function generateCorrectionId() {
  return "corr_" + crypto.randomBytes(8).toString("hex");
}

function norm(s) {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
}
