// src/categoryAttributeExtractor.js
// Phase 2 — Category Attribute Extractor.
//
// Extracts structured, normalized attribute data from the vision pipeline's
// identity object into the canonical per-category schema defined in categoryProfiles.js.
//
// Input:  { identity, category, rawText? }
// Output: {
//   extractedAttributes   — { field: value | null }  keyed by schema fields
//   presentFields         — string[] of fields that have a non-null value
//   missingCriticalFields — string[] of authCriticalFields that are null
//   missingRequiredFields — string[] of required schema fields that are null
//   extractionConfidence  — 0-1 overall confidence in extraction completeness
//   extractionNotes       — string[] of notes about what couldn't be extracted
// }

import { getDeepCategoryProfile } from "./categoryProfiles.js";
import { CAT } from "./categoryRegistry.js";

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * Extract structured category attributes from the vision identity object.
 *
 * @param {object} opts
 *   identity   {object}  — identity blob from vision pipeline
 *   category   {string}  — canonical category (CAT.SNEAKERS etc.)
 *   rawText    {string}  — optional raw listing text for supplemental extraction
 * @returns {CategoryAttributeResult}
 */
export function extractCategoryAttributes({ identity = {}, category, rawText = "" } = {}) {
  switch (category) {
    case CAT.SNEAKERS: return extractSneakerAttributes(identity, rawText);
    case CAT.HANDBAGS: return extractHandbagAttributes(identity, rawText);
    case CAT.WATCHES:  return extractWatchAttributes(identity, rawText);
    default:           return extractGenericAttributes(identity, category, rawText);
  }
}

// ── Sneaker extractor ─────────────────────────────────────────────────────────

function extractSneakerAttributes(identity, rawText) {
  const notes = [];
  const raw   = String(rawText || "").toLowerCase();
  const ident = identity || {};

  // Brand
  const brand = normalizeStr(ident.brand);

  // Model — try multiple identity fields
  const model = normalizeStr(ident.model || ident.productName || ident.name);

  // Style code — Nike/Adidas/Jordan SKU (e.g. CT8012-100)
  let styleCode = normalizeStr(ident.styleCode || ident.sku || ident.itemNumber);
  if (!styleCode) {
    // Try to pull from raw text — look for SKU-like pattern
    const skuMatch = raw.match(/\b([a-z]{2}[0-9]{4}-[0-9]{3}|[a-z]{1,3}[0-9]{4,6})\b/i);
    if (skuMatch) {
      styleCode = skuMatch[1].toUpperCase();
      notes.push("styleCode extracted from raw text via pattern match");
    }
  }

  // Colorway
  const colorway = normalizeStr(
    ident.colorway || ident.color || ident.colorName || ident.colorDescription
  );

  // Size — normalize to number string like "10" or "10.5"
  let size = normalizeStr(ident.size || ident.shoeSize);
  if (!size && rawText) {
    // Try to extract "size 10", "US 10.5", "men's 10"
    const sizeMatch = raw.match(/\b(?:size|us|men'?s|women'?s)?\s*([0-9]{1,2}(?:\.[05])?)\b/i);
    if (sizeMatch) {
      size = sizeMatch[1];
      notes.push("size extracted from raw text via pattern match");
    }
  }

  // Condition — normalize to canonical tiers
  const rawCondition = normalizeStr(ident.condition || ident.conditionDescription);
  const condition = normalizeSneakerCondition(rawCondition);

  // Year
  const year = extractYear(ident.year || ident.releaseYear, rawText);

  // Edition / collab
  const edition = normalizeStr(ident.edition || ident.collaboration || ident.collab);

  // Box included
  const boxIncluded = extractBoxIncluded(ident, rawText);

  // Retail price
  const retailPrice = extractFiniteNumber(ident.retailPrice || ident.msrp || ident.originalPrice);

  // ── Assemble ──
  const extractedAttributes = {
    brand, model, styleCode, colorway, size, condition,
    year, edition, boxIncluded, retailPrice,
  };

  return buildResult(extractedAttributes, CAT.SNEAKERS, notes);
}

// ── Handbag extractor ─────────────────────────────────────────────────────────

function extractHandbagAttributes(identity, rawText) {
  const notes = [];
  const raw   = String(rawText || "").toLowerCase();
  const ident = identity || {};

  const brand    = normalizeStr(ident.brand);
  const model    = normalizeStr(ident.model || ident.collection || ident.productName || ident.name);
  const material = normalizeStr(ident.material || ident.leather || ident.fabric || ident.canvas);
  const color    = normalizeStr(ident.color || ident.colorName);
  const hardwareColor = normalizeStr(ident.hardware || ident.hardwareColor || ident.hardwareTone);

  // Date code — critical for LV and Chanel
  let dateCode = normalizeStr(ident.dateCode || ident.datecode || ident.factoryCode);
  if (!dateCode && rawText) {
    // LV date code format: 2 uppercase letters + 4 digits
    const lvMatch = raw.match(/\b([a-z]{2}[0-9]{4})\b/i);
    if (lvMatch) {
      dateCode = lvMatch[1].toUpperCase();
      notes.push("dateCode extracted from raw text — verify format matches brand");
    }
    // Chanel series number (all digits, 7-8 chars)
    if (!dateCode) {
      const chanelMatch = raw.match(/\bseries\s*#?\s*([0-9]{7,8})\b/i);
      if (chanelMatch) {
        dateCode = chanelMatch[1];
        notes.push("dateCode (Chanel series) extracted from raw text");
      }
    }
  }

  const serialNumber = normalizeStr(
    ident.serialNumber || ident.serial || ident.authCard
  );

  // Size — try dimensions or S/M/L notation
  const size = normalizeStr(ident.size || ident.bagSize || ident.dimensions);

  const style = normalizeStr(ident.style || ident.bagStyle || ident.type);

  // Accessories — parse array or extract from text
  const accessories = extractAccessories(ident, rawText);

  const condition = normalizeHandbagCondition(
    normalizeStr(ident.condition || ident.conditionDescription)
  );

  const year = extractYear(ident.year, rawText);

  const exoticLeather = detectExoticLeather(material, rawText);

  const extractedAttributes = {
    brand, model, material, color, hardwareColor, dateCode,
    serialNumber, size, style, accessories, condition, year, exoticLeather,
  };

  return buildResult(extractedAttributes, CAT.HANDBAGS, notes);
}

// ── Watch extractor ───────────────────────────────────────────────────────────

function extractWatchAttributes(identity, rawText) {
  const notes = [];
  const raw   = String(rawText || "").toLowerCase();
  const ident = identity || {};

  const brand      = normalizeStr(ident.brand);
  const model      = normalizeStr(ident.model || ident.productName || ident.name);

  // Reference number — most critical watch attribute
  let reference = normalizeStr(ident.reference || ident.referenceNumber || ident.refNumber || ident.ref);
  if (!reference && rawText) {
    // Common Rolex ref pattern: 5-6 digits, optional suffix
    const refMatch = raw.match(/\bref(?:erence)?\.?\s*#?\s*([0-9]{5,6}[a-z]{0,4})\b/i)
                  || raw.match(/\b(1[0-9]{5}[a-z]{0,4}|[0-9]{4,5}[a-z]{0,4})\b/);
    if (refMatch) {
      reference = refMatch[1].toUpperCase();
      notes.push("reference extracted from raw text — verify against brand catalog");
    }
  }

  // Movement type
  const rawMovement = normalizeStr(ident.movement || ident.movementType || ident.caliber);
  const movement = normalizeMovementType(rawMovement, rawText);

  const caseMaterial = normalizeStr(ident.caseMaterial || ident.material || ident.case);
  const dialColor    = normalizeStr(ident.dialColor || ident.dial);
  const dialCondition = normalizeStr(ident.dialCondition || ident.dialGrade);
  const bracelet     = normalizeStr(ident.bracelet || ident.strap || ident.band);

  // Serial number — often between lugs on older Rolex, on caseback on others
  let serialNumber = normalizeStr(ident.serialNumber || ident.serial);
  if (!serialNumber && rawText) {
    const serialMatch = raw.match(/\bserial\s*#?\s*:?\s*([a-z]?[0-9]{6,10}[a-z]?)\b/i);
    if (serialMatch) {
      serialNumber = serialMatch[1].toUpperCase();
      notes.push("serialNumber extracted from raw text");
    }
  }

  const yearProduced = extractYear(ident.yearProduced || ident.year || ident.vintage, rawText);

  // Box/Papers — normalize to canonical values
  const boxPapers = normalizeBoxPapers(ident.boxPapers || ident.papers || ident.box, rawText);

  // Complications — may be array or comma-separated string
  const complications = extractComplications(ident, rawText);

  const caseSize = extractFiniteNumber(ident.caseSize || ident.diameter || ident.size);

  // Caseback type — critical Rolex fake tell
  const caseback = detectCasebackType(ident, rawText);

  // Crown logo presence
  const crown = normalizeStr(ident.crown);

  const extractedAttributes = {
    brand, model, reference, movement, caseMaterial, dialColor,
    dialCondition, bracelet, serialNumber, yearProduced, boxPapers,
    complications, caseSize, caseback, crown,
  };

  return buildResult(extractedAttributes, CAT.WATCHES, notes);
}

// ── Generic extractor ─────────────────────────────────────────────────────────

function extractGenericAttributes(identity, category, rawText) {
  const ident = identity || {};
  const extractedAttributes = {
    brand:     normalizeStr(ident.brand),
    model:     normalizeStr(ident.model || ident.productName),
    condition: normalizeStr(ident.condition),
  };
  return buildResult(extractedAttributes, category, []);
}

// ── Result builder ────────────────────────────────────────────────────────────

function buildResult(extractedAttributes, category, notes) {
  const profile = getDeepCategoryProfile(category);

  const presentFields  = Object.entries(extractedAttributes)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k]) => k);

  const missingCriticalFields = (profile.authCriticalFields || [])
    .filter(f => !presentFields.includes(f));

  const missingRequiredFields = Object.entries(profile.attributeSchema || {})
    .filter(([f, schema]) => schema.required && !presentFields.includes(f))
    .map(([f]) => f);

  // Extraction confidence: ratio of present to total schema fields
  const totalFields = Object.keys(profile.attributeSchema || {}).length || 1;
  const filledFields = presentFields.filter(f => f in (profile.attributeSchema || {})).length;
  const criticalPenalty = missingCriticalFields.length * 0.12;
  const extractionConfidence = Math.max(0, Math.min(1,
    (filledFields / totalFields) - criticalPenalty
  ));

  return {
    extractedAttributes,
    presentFields,
    missingCriticalFields,
    missingRequiredFields,
    extractionConfidence: round2(extractionConfidence),
    extractionNotes: notes,
  };
}

// ── Normalization helpers ─────────────────────────────────────────────────────

function normalizeStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function extractFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractYear(v, rawText) {
  const n = extractFiniteNumber(v);
  if (n && n >= 1950 && n <= new Date().getFullYear() + 1) return n;
  // Try raw text
  if (rawText) {
    const match = rawText.match(/\b(19[5-9][0-9]|20[0-2][0-9])\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function extractBoxIncluded(ident, rawText) {
  if (ident.boxIncluded !== undefined) return Boolean(ident.boxIncluded);
  const raw = String(rawText || "").toLowerCase();
  if (/\b(no box|missing box|without box|box not included)\b/.test(raw)) return false;
  if (/\b(with box|includes? box|og box|original box|comes with box)\b/.test(raw)) return true;
  return null;  // unknown
}

function normalizeSneakerCondition(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (/\b(ds|deadstock|new|unworn|nwt|brand new)\b/.test(s)) return "DS";
  if (/\b(vnds|very near deadstock|tried on)\b/.test(s)) return "VNDS";
  if (/\b(used excellent|9\/10|excellent|lightly worn|near perfect)\b/.test(s)) return "used_excellent";
  if (/\b(used good|8\/10|good|worn|normal wear)\b/.test(s)) return "used_good";
  if (/\b(beater|heavily worn|worn out|7\/10|6\/10|fair)\b/.test(s)) return "beater";
  return raw;  // pass through if unrecognized
}

function normalizeHandbagCondition(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (/\b(pristine|new|unused|never used|flawless|10\/10)\b/.test(s)) return "pristine";
  if (/\b(excellent|like new|9\/10|barely used|minimal wear)\b/.test(s)) return "excellent";
  if (/\b(very good|8\/10|light wear|slight wear)\b/.test(s)) return "very_good";
  if (/\b(good|7\/10|moderate wear|some wear|normal wear)\b/.test(s)) return "good";
  if (/\b(fair|6\/10|heavy wear|worn|damaged|needs work)\b/.test(s)) return "fair";
  return raw;
}

function normalizeMovementType(raw, rawText) {
  if (!raw && !rawText) return null;
  const s = (raw || "").toLowerCase().trim();
  const rt = (rawText || "").toLowerCase();
  if (/\b(auto|automatic|self.?wind)\b/.test(s) || /\b(auto|automatic)\b/.test(rt)) return "automatic";
  if (/\b(manual|hand.?wind|hand.?wound)\b/.test(s) || /\b(manual.?wind)\b/.test(rt)) return "manual";
  if (/\b(quartz|battery|solar)\b/.test(s) || /\b(quartz)\b/.test(rt)) return "quartz";
  return raw;
}

function normalizeBoxPapers(raw, rawText) {
  if (raw) {
    const s = String(raw).toLowerCase();
    if (/full.?set|box.{0,10}papers|complete/.test(s)) return "full_set";
    if (/papers.?only|no box/.test(s)) return "papers_only";
    if (/box.?only|no papers/.test(s)) return "box_only";
    if (/no box|no papers|unworn|none/.test(s)) return "no_box_no_papers";
  }
  if (rawText) {
    const rt = rawText.toLowerCase();
    if (/full.?set|box.{0,10}papers|with papers/.test(rt)) return "full_set";
    if (/papers.?only|no box/.test(rt)) return "papers_only";
    if (/box.?only/.test(rt)) return "box_only";
    if (/no box|no papers/.test(rt)) return "no_box_no_papers";
  }
  return null;
}

function extractComplications(ident, rawText) {
  const comps = [];
  if (Array.isArray(ident.complications)) {
    comps.push(...ident.complications.map(String).filter(Boolean));
  } else if (ident.complications) {
    comps.push(...String(ident.complications).split(/[,;]/).map(s => s.trim()).filter(Boolean));
  }
  if (comps.length === 0 && rawText) {
    const rt = rawText.toLowerCase();
    if (/\bdate\b/.test(rt)) comps.push("date");
    if (/\bgmt\b/.test(rt)) comps.push("gmt");
    if (/\bchrono(graph)?\b/.test(rt)) comps.push("chronograph");
    if (/\bmoon.?phase\b/.test(rt)) comps.push("moonphase");
    if (/\bday.?date\b/.test(rt)) comps.push("day", "date");
  }
  return comps.length > 0 ? comps : null;
}

function detectCasebackType(ident, rawText) {
  if (ident.caseback) return normalizeStr(ident.caseback);
  const rt = (rawText || "").toLowerCase();
  if (/transparent|exhibition|see.?through|display|sapphire back/.test(rt)) return "transparent";
  if (/solid caseback|closed back/.test(rt)) return "solid";
  if (/\bscrew.?back\b/.test(rt)) return "solid";  // screw-back = solid on most Swiss watches
  return null;
}

function extractAccessories(ident, rawText) {
  const found = [];
  const rt = (rawText || "").toLowerCase();
  const identStr = JSON.stringify(ident || {}).toLowerCase();
  const combined = rt + " " + identStr;

  if (/\bdust.?bag\b/.test(combined)) found.push("dustbag");
  if (/\bbox\b/.test(combined)) found.push("box");
  if (/\bauth(enticity)?.?card\b/.test(combined)) found.push("authenticity_card");
  if (/\breceipt\b/.test(combined)) found.push("receipt");
  if (/\block.{0,5}keys?\b/.test(combined)) found.push("lock_keys");
  if (/\bshoulder strap\b/.test(combined)) found.push("shoulder_strap");
  if (Array.isArray(ident.accessories)) found.push(...ident.accessories);
  return found.length > 0 ? [...new Set(found)] : [];
}

function detectExoticLeather(material, rawText) {
  const combined = ((material || "") + " " + (rawText || "")).toLowerCase();
  return /\b(crocodile|croc|alligator|python|ostrich|lizard|stingray)\b/.test(combined);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
