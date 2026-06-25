// src/universalIdentitySchema.js
// Phase 5B.1+5B.2+5B.3B+5B.4+5B.5 — Universal identity schema foundation.
// Enriches the existing vision identity with structured confidence labels,
// high-stakes flags, evidence metadata, query-safety metadata,
// book/video-game recognition, headphone taxonomy enrichment,
// watch taxonomy enrichment, and jacket/coat/sweater/zip taxonomy enrichment.
// Pure sync functions, no I/O, no side effects.

import { isTrueHighStakesVisionCategory } from "./visionCategoryPolicy.js";
import { resolveBrandTier } from "./brandTierClassifier.js";

export const CONFIDENCE_LABELS = [
  "confirmed",
  "likely",
  "possible",
  "unknown",
  "insufficient_evidence",
];

export function isHighStakesBrand(brandName) {
  if (!brandName || typeof brandName !== "string") return false;
  const resolved = resolveBrandTier(brandName);
  if (!resolved) return false;
  return resolved.tier === "ultra_luxury" || resolved.tier === "luxury";
}

export function computeConfidenceLabel({
  confidence = 0,
  attributeCertainty = {},
  visibleText = [],
  authenticityFlags = [],
  highStakes = false,
  brand = null,
  model = null,
} = {}) {
  const conf = Number(confidence) || 0;
  const brandCert = Number(attributeCertainty.brand || 0);
  const modelCert = Number(attributeCertainty.model || 0);
  const catCert = Number(attributeCertainty.category || 0);
  const hasText = Array.isArray(visibleText) && visibleText.some((t) => t && String(t).trim().length > 0);
  const hasNegativeAuth = Array.isArray(authenticityFlags) && authenticityFlags.some((f) =>
    typeof f === "string" && /logo_proportions_off|font_wrong|stitching_uneven|monogram_misaligned|hardware_lightweight/.test(f)
  );

  if (conf < 0.15) return "insufficient_evidence";

  if (highStakes) {
    if (
      conf >= 0.85 &&
      brandCert >= 0.80 &&
      brand &&
      hasText &&
      !hasNegativeAuth
    ) {
      return "confirmed";
    }
    if (
      conf >= 0.65 &&
      (brandCert >= 0.55 || modelCert >= 0.55) &&
      (hasText || brandCert >= 0.70)
    ) {
      return "likely";
    }
    if (conf >= 0.40 && (brandCert >= 0.30 || catCert >= 0.50)) {
      return "possible";
    }
    return "unknown";
  }

  if (
    conf >= 0.85 &&
    (brandCert >= 0.75 || modelCert >= 0.75 || (catCert >= 0.80 && hasText))
  ) {
    return "confirmed";
  }
  if (conf >= 0.65 && (brandCert >= 0.50 || modelCert >= 0.50)) {
    return "likely";
  }
  if (conf >= 0.40 && (brandCert >= 0.30 || catCert >= 0.50)) {
    return "possible";
  }
  if (conf >= 0.15) {
    return "unknown";
  }
  return "insufficient_evidence";
}

const BOOK_KEYWORDS = /\b(book|paperback|hardcover|hardback|novel|textbook|manga|comic|graphic novel)\b/i;
const VIDEO_GAME_KEYWORDS = /\b(video game|game case|game cartridge|disc game|nintendo switch game|playstation game|xbox game)\b/i;

export function isBookIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  return fields.some((f) => f && typeof f === "string" && BOOK_KEYWORDS.test(f));
}

export function isVideoGameIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  return fields.some((f) => f && typeof f === "string" && VIDEO_GAME_KEYWORDS.test(f));
}

const AUTHOR_BYLINE_RE = /\bby\s+([A-Z][A-Za-z'.]+(?:\s+[A-Z][A-Za-z'.]+){0,4})/;

export function deriveBookAuthor(visibleText) {
  if (!Array.isArray(visibleText)) return null;
  for (const t of visibleText) {
    if (!t || typeof t !== "string") continue;
    const m = t.match(AUTHOR_BYLINE_RE);
    if (m) return m[1].trim();
  }
  return null;
}

const ISBN13_RE = /(?:^|\D)(97[89]\d{10})(?:\D|$)/;
const ISBN10_RE = /(?:^|\D)(\d{9}[\dX])(?:\D|$)/;

export function deriveIsbn(visibleText) {
  if (!Array.isArray(visibleText)) return null;
  for (const t of visibleText) {
    if (!t || typeof t !== "string") continue;
    const normalized = t.replace(/[-\s]/g, "");
    const m13 = normalized.match(ISBN13_RE);
    if (m13) return m13[1];
    const m10 = normalized.match(ISBN10_RE);
    if (m10) return m10[1];
  }
  return null;
}

const GAME_PLATFORMS = [
  "Nintendo Switch 2",
  "Nintendo Switch",
  "Nintendo 3DS",
  "Wii",
  "PlayStation 5",
  "PlayStation 4",
  "PlayStation 3",
  "Xbox Series X",
  "Xbox Series S",
  "Xbox One",
  "Xbox 360",
  "PS5",
  "PS4",
  "PS3",
  "Steam",
  "PC",
];

export function deriveGamePlatform(visibleText) {
  if (!Array.isArray(visibleText)) return null;
  for (const t of visibleText) {
    if (!t || typeof t !== "string") continue;
    const upper = t.toUpperCase();
    for (const plat of GAME_PLATFORMS) {
      if (upper.includes(plat.toUpperCase())) return plat;
    }
  }
  return null;
}

// --- Headphone taxonomy (Phase 5B.3B) ---

const HEADPHONE_DEVICE_RE = /\b(headphone|headphones|earbud|earbuds|earphone|earphones|in-ear|in ear|on-ear|on ear|over-ear|over ear|around-ear|around ear|circumaural|supra-aural|iem|in-ear monitor|headset|gaming headset|audio headset|wireless headset|bluetooth headset)\b/i;
const HEADPHONE_ACCESSORY_RE = /\b(stand|case|cable|holder|hanger|hook|mount|bracket|adapter|splitter|jack|amp|amplifier|dac|receiver|ear pad|ear pads|earpad|earpads|cushion|cover|replacement|wall)\b/i;
const VR_AR_RE = /\b(vr|virtual reality|ar|augmented)\b/i;
const BARE_HEADSET_RE = /\bheadset\b/i;

export function isHeadphoneIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  if (!HEADPHONE_DEVICE_RE.test(joined)) return false;
  if (HEADPHONE_ACCESSORY_RE.test(joined)) return false;
  // Bare "headset" without audio qualifier — check for VR/AR veto
  const hasOnlyHeadset = BARE_HEADSET_RE.test(joined) &&
    !(/\b(headphone|headphones|earbud|earbuds|earphone|earphones|in-ear|in ear|on-ear|on ear|over-ear|over ear|around-ear|around ear|circumaural|supra-aural|iem|in-ear monitor|gaming headset|audio headset|wireless headset|bluetooth headset)\b/i.test(joined));
  if (hasOnlyHeadset && VR_AR_RE.test(joined)) return false;
  return true;
}

const EARBUD_RE = /\b(earbud|earbuds|earphone|earphones|in-ear|in ear|iem|in-ear monitor)\b/i;
const HEADPHONE_KIND_RE = /\b(headphone|headphones|headset|over-ear|over ear|on-ear|on ear|around-ear|around ear|circumaural|supra-aural)\b/i;

export function deriveAudioKind(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (EARBUD_RE.test(joined)) return "earbuds";
  if (HEADPHONE_KIND_RE.test(joined)) return "headphones";
  return null;
}

const FIT_OVER_EAR_RE = /\b(over-ear|over ear|around-ear|around ear|circumaural)\b/i;
const FIT_ON_EAR_RE = /\b(on-ear|on ear|supra-aural)\b/i;
const FIT_IN_EAR_RE = /\b(in-ear|in ear|earbuds|earphones|iem|in-ear monitor)\b/i;

export function deriveHeadphoneFit(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (FIT_OVER_EAR_RE.test(joined)) return "over_ear";
  if (FIT_ON_EAR_RE.test(joined)) return "on_ear";
  if (FIT_IN_EAR_RE.test(joined)) return "in_ear";
  return null;
}

const BACK_OPEN_RE = /\b(open-back|open back)\b/i;
const BACK_CLOSED_RE = /\b(closed-back|closed back)\b/i;

export function deriveHeadphoneBackType(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ") +
    " " + vt.filter((t) => t && typeof t === "string").join(" ");
  if (BACK_OPEN_RE.test(joined)) return "open_back";
  if (BACK_CLOSED_RE.test(joined)) return "closed_back";
  return null;
}

const WIRELESS_RE = /\b(wireless|bluetooth|true wireless|tws)\b/i;

export function deriveHeadphoneWireless(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const sw = Array.isArray(identity.styleWords) ? identity.styleWords : [];
  const joined = vt.filter((t) => t && typeof t === "string").join(" ") +
    " " + sw.filter((s) => s && typeof s === "string").join(" ");
  if (WIRELESS_RE.test(joined)) return true;
  return null;
}

const NC_RE = /\b(noise cancelling|noise-cancelling|noise canceling|active noise cancelling|active noise cancellation|anc)\b/i;

export function deriveHeadphoneNoiseCancelling(identity) {
  if (!isHeadphoneIdentity(identity)) return null;
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const sw = Array.isArray(identity.styleWords) ? identity.styleWords : [];
  const joined = vt.filter((t) => t && typeof t === "string").join(" ") +
    " " + sw.filter((s) => s && typeof s === "string").join(" ");
  if (NC_RE.test(joined)) return true;
  return null;
}

const BLUETOOTH_RE = /\bbluetooth\b/i;
const WIRELESS_FEAT_RE = /\bwireless\b/i;
const MIC_RE = /\b(mic|microphone)\b/i;
const FOLDABLE_RE = /\b(foldable|folding)\b/i;

export function deriveHeadphoneFeatures(identity) {
  if (!isHeadphoneIdentity(identity)) return [];
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const sw = Array.isArray(identity.styleWords) ? identity.styleWords : [];
  const joined = vt.filter((t) => t && typeof t === "string").join(" ") +
    " " + sw.filter((s) => s && typeof s === "string").join(" ");
  const features = [];
  if (BLUETOOTH_RE.test(joined)) features.push("bluetooth");
  if (WIRELESS_FEAT_RE.test(joined) && !BLUETOOTH_RE.test(joined)) features.push("wireless");
  if (NC_RE.test(joined)) features.push("noise_cancelling");
  if (MIC_RE.test(joined)) features.push("microphone");
  if (FOLDABLE_RE.test(joined)) features.push("foldable");
  return features;
}

// --- Watch taxonomy (Phase 5B.4) ---

const WATCH_ACCESSORY_RE = /\b(watch box|watch case|watch band|watch strap|watch charger|watch stand|watch winder|watch display|watch tool|watch repair|watch holder|watch hanger|watch mount|watch roll|watch cushion|watch pillow|watch cabinet|watch organizer|screen protector|replacement band|replacement strap)\b/i;
const WATCH_NON_WATCH_RE = /\b(wall clock|desk clock|alarm clock|grandfather clock|cuckoo clock|clock tower|stopwatch|timer|compass|bangle|bracelet|jewelry box|poster|book|phone|laptop|tablet|scale|bike computer|clock)\b/i;
const WATCH_DEVICE_RE = /\b(analog watch|digital watch|smartwatch|smart watch|sports watch|sport watch|chronograph watch|dive watch|diver watch|dress watch|field watch|pilot watch|aviator watch|fitness tracker|fitness band|activity tracker|pocket watch|kids watch|children watch|children's watch|couple watch|wristwatches|wristwatch|watches|watch|chronograph|timepiece)\b/i;

export function isWatchIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  if (WATCH_ACCESSORY_RE.test(joined)) return false;
  if (WATCH_NON_WATCH_RE.test(joined) && !WATCH_DEVICE_RE.test(joined)) return false;
  if (WATCH_DEVICE_RE.test(joined)) return true;
  return false;
}

const SMARTWATCH_TYPE_RE = /\b(smartwatch|smart watch)\b/i;
const SMARTWATCH_VT_RE = /\b(apple watch|galaxy watch|wear os|watchos)\b/i;
const FITNESS_BAND_RE = /\b(fitness band|fitness tracker|activity tracker)\b/i;
const POCKET_WATCH_RE = /\bpocket watch\b/i;

export function deriveWatchKind(identity) {
  if (!isWatchIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (SMARTWATCH_TYPE_RE.test(joined)) return "smartwatch";
  if (FITNESS_BAND_RE.test(joined)) return "fitness_band";
  if (POCKET_WATCH_RE.test(joined)) return "pocket_watch";
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const vtJoined = vt.filter((t) => t && typeof t === "string").join(" ");
  if (SMARTWATCH_VT_RE.test(vtJoined)) return "smartwatch";
  return "watch";
}

const DISPLAY_ANALOG_RE = /\b(analog|analog watch)\b/i;
const DISPLAY_DIGITAL_RE = /\b(digital|digital watch|lcd|led display)\b/i;
const DISPLAY_HYBRID_RE = /\bhybrid\b/i;

export function deriveWatchDisplayType(identity) {
  if (!isWatchIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (DISPLAY_ANALOG_RE.test(joined)) return "analog";
  if (DISPLAY_DIGITAL_RE.test(joined)) return "digital";
  if (DISPLAY_HYBRID_RE.test(joined)) return "hybrid";
  return null;
}

const STYLE_SPORTS_RE = /\b(sports watch|sport watch|dive watch|diver|field watch)\b/i;
const STYLE_LUXURY_RE = /\b(dress watch|luxury watch)\b/i;
const STYLE_KIDS_RE = /\b(kids watch|children watch|children's watch)\b/i;
const STYLE_COUPLE_RE = /\b(couple watch|couple watches|his and hers)\b/i;

export function deriveWatchStyle(identity) {
  if (!isWatchIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (STYLE_SPORTS_RE.test(joined)) return "sports";
  if (STYLE_LUXURY_RE.test(joined)) return "luxury_style";
  if (STYLE_KIDS_RE.test(joined)) return "kids";
  if (STYLE_COUPLE_RE.test(joined)) return "couple";
  return null;
}

const STRAP_LEATHER_RE = /\b(leather strap|leather band)\b/i;
const STRAP_METAL_RE = /\b(metal bracelet|metal strap|metal band|stainless steel bracelet|stainless steel)\b/i;
const STRAP_RUBBER_RE = /\b(rubber strap|silicone strap|rubber band)\b/i;
const STRAP_FABRIC_RE = /\b(nato strap|nylon strap|fabric strap|canvas strap)\b/i;

export function deriveWatchStrapType(identity) {
  if (!isWatchIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  const materials = Array.isArray(identity.materials) ? identity.materials : [];
  const matJoined = materials.filter((m) => m && typeof m === "string").join(" ").toLowerCase();
  if (STRAP_LEATHER_RE.test(joined) || matJoined.includes("leather")) return "leather";
  if (STRAP_METAL_RE.test(joined) || matJoined.includes("stainless steel") || matJoined.includes("metal")) return "metal";
  if (STRAP_RUBBER_RE.test(joined) || matJoined.includes("rubber") || matJoined.includes("silicone")) return "rubber";
  if (STRAP_FABRIC_RE.test(joined) || matJoined.includes("nato") || matJoined.includes("nylon") || matJoined.includes("canvas") || matJoined.includes("fabric")) return "fabric";
  return null;
}

const FEAT_CHRONO_RE = /\b(chronograph|subdials|pushers)\b/i;
const FEAT_DATE_RE = /\b(date window|day-date|date display)\b/i;
const FEAT_BEZEL_RE = /\b(rotating bezel|dive bezel)\b/i;
const FEAT_WR_RE = /\b(water resistant|waterproof)\b/i;

export function deriveWatchFeatures(identity) {
  if (!isWatchIdentity(identity)) return [];
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ") +
    " " + vt.filter((t) => t && typeof t === "string").join(" ");
  const features = [];
  if (FEAT_CHRONO_RE.test(joined)) features.push("chronograph");
  if (FEAT_DATE_RE.test(joined)) features.push("date_window");
  if (FEAT_BEZEL_RE.test(joined)) features.push("rotating_bezel");
  if (FEAT_WR_RE.test(joined)) features.push("water_resistant");
  return features;
}

// --- Garment / outerwear taxonomy (Phase 5B.5) ---

const GARMENT_ACCESSORY_RE = /\b(coat rack|coat hanger|coat hook|coat stand|clothes hanger|jacket hanger|garment bag|sweater shaver|sweater stone|lint roller|zipper pull|zipper pouch|zip pouch|zip tie|zip ties|zip code|zippo|parka hood)\b/i;
const GARMENT_NON_RE = /\b(book jacket|dust jacket|record jacket|album jacket|jacket cover|life jacket|life vest|bomber plane|bomber jet|bomber aircraft|puffer fish|pufferfish|blowfish|trench shovel|trench art|trench warfare|trench foot|coat of arms|coat of paint|blanket|throw|pillowcase|fleece blanket)\b/i;
const GARMENT_POSITIVE_RE = /\b(denim jacket|leather jacket|bomber jacket|flight jacket|puffer jacket|down jacket|down vest|down coat|trucker jacket|varsity jacket|letterman jacket|track jacket|fleece jacket|chore jacket|field jacket|utility jacket|harrington jacket|trench coat|wool coat|rain coat|quarter-zip|quarter zip|half-zip|half zip|full-zip|zip-up|mock neck sweater|mock-neck sweater|mock neck knit|hoodie|sweatshirt|sweater|cardigan|turtleneck|crewneck|pullover|blazer|parka|peacoat|overcoat|windbreaker|raincoat|anorak|gilet|jacket|coat|vest)\b/i;

export function isGarmentOuterwearIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  if (GARMENT_ACCESSORY_RE.test(joined)) return false;
  if (GARMENT_NON_RE.test(joined)) return false;
  if (GARMENT_POSITIVE_RE.test(joined)) return true;
  return false;
}

const GKIND_HOODIE_RE = /\b(hoodie|hooded sweatshirt)\b/i;
const GKIND_SWEATSHIRT_RE = /\bsweatshirt\b/i;
const GKIND_VEST_RE = /\b(sweater vest|down vest|vest|gilet)\b/i;
const GKIND_COAT_RE = /\b(trench coat|overcoat|peacoat|parka|wool coat|raincoat|rain coat|coat)\b/i;
const GKIND_JACKET_RE = /\b(jacket|blazer|windbreaker|anorak)\b/i;
const GKIND_SWEATER_RE = /\b(sweater|cardigan|turtleneck|crewneck|pullover|cable-knit|cable knit|quarter-zip|quarter zip|half-zip|half zip|mock neck sweater|mock-neck sweater|mock neck knit)\b/i;

export function deriveGarmentKind(identity) {
  if (!isGarmentOuterwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  // Most-specific first: hoodie > sweatshirt > vest > coat > jacket > sweater
  if (GKIND_HOODIE_RE.test(joined)) return "hoodie";
  if (GKIND_SWEATSHIRT_RE.test(joined)) return "sweatshirt";
  if (GKIND_VEST_RE.test(joined)) return "vest";
  if (GKIND_COAT_RE.test(joined)) return "coat";
  if (GKIND_JACKET_RE.test(joined)) return "jacket";
  if (GKIND_SWEATER_RE.test(joined)) return "sweater";
  return null;
}

export function deriveOuterwearType(identity) {
  if (!isGarmentOuterwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  const materials = Array.isArray(identity.materials) ? identity.materials : [];
  const matJoined = materials.filter((m) => m && typeof m === "string").join(" ").toLowerCase();
  const hasJacket = /\bjacket\b/i.test(joined);
  const hasCoat = /\bcoat\b/i.test(joined);
  if (/\btrucker jacket\b/i.test(joined)) return "trucker_jacket";
  if (/\bdenim jacket\b/i.test(joined)) return "denim_jacket";
  if (matJoined.includes("denim") && hasJacket) return "denim_jacket";
  if (/\b(varsity jacket|letterman jacket)\b/i.test(joined)) return "varsity_jacket";
  if (/\bleather jacket\b/i.test(joined)) return "leather_jacket";
  if (matJoined.includes("leather") && hasJacket) return "leather_jacket";
  if (/\b(bomber jacket|flight jacket)\b/i.test(joined)) return "bomber_jacket";
  if (/\bpuffer jacket\b/i.test(joined)) return "puffer_jacket";
  if (/\bdown jacket\b/i.test(joined)) return "down_jacket";
  if (/\bwindbreaker\b/i.test(joined)) return "windbreaker";
  if (/\brain jacket\b/i.test(joined)) return "rain_jacket";
  if (/\btrack jacket\b/i.test(joined)) return "track_jacket";
  if (/\bfleece jacket\b/i.test(joined)) return "fleece_jacket";
  if (matJoined.includes("fleece") && hasJacket) return "fleece_jacket";
  if (/\bchore jacket\b/i.test(joined)) return "chore_jacket";
  if (/\bfield jacket\b/i.test(joined)) return "field_jacket";
  if (/\butility jacket\b/i.test(joined)) return "utility_jacket";
  if (/\bblazer\b/i.test(joined)) return "blazer";
  if (/\btrench coat\b/i.test(joined)) return "trench_coat";
  if (/\bovercoat\b/i.test(joined)) return "overcoat";
  if (/\bpeacoat\b/i.test(joined)) return "peacoat";
  if (/\bparka\b/i.test(joined)) return "parka";
  if (/\bwool coat\b/i.test(joined)) return "wool_coat";
  if (matJoined.includes("wool") && hasCoat) return "wool_coat";
  if (/\b(raincoat|rain coat)\b/i.test(joined)) return "raincoat";
  return null;
}

const SWEATER_CARDIGAN_RE = /\bcardigan\b/i;
const SWEATER_CREWNECK_RE = /\b(crewneck|crew neck)\b/i;
const SWEATER_VNECK_RE = /\b(v-neck|v neck)\b/i;
const SWEATER_TURTLE_RE = /\b(turtleneck|mock neck sweater|mock-neck sweater|mock neck knit)\b/i;
const SWEATER_QZ_RE = /\b(quarter-zip|quarter zip)\b/i;
const SWEATER_HZ_RE = /\b(half-zip|half zip)\b/i;
const SWEATER_CABLE_RE = /\b(cable-knit|cable knit)\b/i;
const SWEATER_VEST_RE = /\bsweater vest\b/i;

export function deriveSweaterType(identity) {
  if (!isGarmentOuterwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (SWEATER_VEST_RE.test(joined)) return "sweater_vest";
  if (SWEATER_CARDIGAN_RE.test(joined)) return "cardigan";
  if (SWEATER_CREWNECK_RE.test(joined)) return "crewneck";
  if (SWEATER_VNECK_RE.test(joined)) return "v_neck";
  if (SWEATER_TURTLE_RE.test(joined)) return "turtleneck";
  if (SWEATER_QZ_RE.test(joined)) return "quarter_zip";
  if (SWEATER_HZ_RE.test(joined)) return "half_zip";
  if (SWEATER_CABLE_RE.test(joined)) return "cable_knit";
  return null;
}

const CLOSURE_ZIP_RE = /\b(zip-up|zip up|full-zip|full zip|quarter-zip|quarter zip|half-zip|half zip)\b/i;
const CLOSURE_BUTTON_RE = /\b(button front|button-front|buttons|button closure)\b/i;
const CLOSURE_SNAP_RE = /\b(snap front|snap-front|snaps|snap closure)\b/i;
const CLOSURE_PULL_RE = /\bpullover\b/i;

export function deriveClosureType(identity) {
  if (!isGarmentOuterwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (CLOSURE_ZIP_RE.test(joined)) return "zip";
  if (CLOSURE_BUTTON_RE.test(joined)) return "button";
  if (CLOSURE_SNAP_RE.test(joined)) return "snap";
  if (CLOSURE_PULL_RE.test(joined)) return "pullover";
  return null;
}

export function deriveGarmentMaterialSignal(identity) {
  if (!isGarmentOuterwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  const materials = Array.isArray(identity.materials) ? identity.materials : [];
  const matJoined = materials.filter((m) => m && typeof m === "string").join(" ").toLowerCase();
  const all = (joined + " " + matJoined).toLowerCase();
  if (/\bdenim\b/.test(all)) return "denim";
  if (/\bleather\b/.test(all)) return "leather";
  if (/\bwool\b/.test(all)) return "wool";
  if (/\bfleece\b/.test(all)) return "fleece";
  if (/\b(knit|cable-knit|cable knit)\b/.test(all)) return "knit";
  if (/\bnylon\b/.test(all)) return "nylon";
  if (/\bpolyester\b/.test(all)) return "polyester";
  if (/\b(down|puffer)\b/.test(all)) return "down";
  if (/\bcotton\b/.test(all)) return "cotton";
  return null;
}

const GFEAT_RIBBED_RE = /\b(ribbed cuffs|rib cuff|ribbed hem)\b/i;
const GFEAT_CHEST_RE = /\b(chest pockets|chest pocket)\b/i;
const GFEAT_QUILTED_RE = /\b(quilted|quilting)\b/i;
const GFEAT_COLLAR_RE = /\b(stand collar|standing collar|mock neck|mock-neck)\b/i;
const GFEAT_DRAW_RE = /\b(drawstring|drawstrings)\b/i;
const GFEAT_HOOD_RE = /\b(hood|hooded|hoodie)\b/i;

export function deriveGarmentFeatures(identity) {
  if (!isGarmentOuterwearIdentity(identity)) return [];
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ") +
    " " + vt.filter((t) => t && typeof t === "string").join(" ");
  const features = [];
  if (GFEAT_RIBBED_RE.test(joined)) features.push("ribbed_cuffs");
  if (GFEAT_CHEST_RE.test(joined)) features.push("chest_pockets");
  if (GFEAT_QUILTED_RE.test(joined)) features.push("quilted");
  if (GFEAT_COLLAR_RE.test(joined)) features.push("stand_collar");
  if (GFEAT_DRAW_RE.test(joined)) features.push("drawstring");
  if (GFEAT_HOOD_RE.test(joined)) features.push("hooded");
  return features;
}

function computeMissingEvidence(identity) {
  const missing = [];
  if (!identity.brand) missing.push("brand not identified");
  if (!identity.model) missing.push("model/title not identified");
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  if (!vt.some((t) => t && String(t).trim().length > 0)) {
    missing.push("no readable text detected");
  }
  if (!identity.condition) missing.push("condition not assessed");
  return missing;
}

function computeEvidenceSource(identity, attributeCertainty) {
  const vt = Array.isArray(identity.visibleText) ? identity.visibleText : [];
  const hasText = vt.some((t) => t && String(t).trim().length > 0);
  const brandCert = Number(attributeCertainty?.brand || 0);

  if (hasText) return "visible_text";
  if (brandCert >= 0.45 || identity.brand) return "logo_or_mark";
  if (identity.itemType || identity.category) return "inferred";
  return null;
}

function computeQueryTermsAllowed(identity, confidenceLabel, authenticityClaimAllowed, highStakes) {
  const terms = [];
  if (identity.itemType) terms.push(identity.itemType);
  if (identity.category) terms.push(identity.category);
  if (Array.isArray(identity.colors)) {
    for (const c of identity.colors) if (c) terms.push(c);
  }
  if (Array.isArray(identity.materials)) {
    for (const m of identity.materials) if (m) terms.push(m);
  }
  if (identity.subtype) terms.push(identity.subtype);

  let brandAllowed;
  if (highStakes) {
    brandAllowed = authenticityClaimAllowed;
  } else {
    brandAllowed =
      authenticityClaimAllowed ||
      confidenceLabel === "likely" || confidenceLabel === "confirmed";
  }
  if (identity.brand && brandAllowed) terms.push(identity.brand);

  const modelAllowed = highStakes
    ? authenticityClaimAllowed
    : (confidenceLabel === "likely" || confidenceLabel === "confirmed");
  if (identity.model && modelAllowed) terms.push(identity.model);

  return terms;
}

function computeQueryTermsBlocked(identity, highStakes, authenticityClaimAllowed, confidenceLabel, evidenceSource) {
  const blocked = [];
  if (!identity.brand) return blocked;

  const weakEvidence =
    confidenceLabel === "possible" ||
    confidenceLabel === "unknown" ||
    confidenceLabel === "insufficient_evidence";
  const inferredOnly = evidenceSource === "inferred" || evidenceSource === "logo_or_mark";

  if (highStakes && !authenticityClaimAllowed && weakEvidence) {
    blocked.push(identity.brand);
    if (identity.model) blocked.push(identity.model);
  } else if (isHighStakesBrand(identity.brand) && !authenticityClaimAllowed && inferredOnly) {
    blocked.push(identity.brand);
  }

  return blocked;
}

function computeIdentityWarnings(identity, highStakes, confidenceLabel, authenticityClaimAllowed, evidenceSource) {
  const warnings = [];

  if (identity.brand && !authenticityClaimAllowed && highStakes) {
    warnings.push("Luxury/high-stakes item requires stronger evidence before brand/model claims.");
  }

  if (identity.brand && evidenceSource !== "visible_text" && (confidenceLabel === "possible" || confidenceLabel === "unknown")) {
    warnings.push("Brand claim is not confirmed from readable text or strong logo evidence.");
  }

  if (highStakes && (confidenceLabel === "possible" || confidenceLabel === "unknown")) {
    warnings.push("Visual similarity alone is not enough for authenticity.");
  }

  return warnings;
}

export function enrichIdentityWithSchema(identity = {}, options = {}) {
  const id = identity && typeof identity === "object" ? identity : {};
  const attributeCertainty = options.attributeCertainty || {};
  const authenticityFlags = Array.isArray(options.authenticityFlags) ? options.authenticityFlags : [];
  const overallConfidence = Number(options.overallConfidence || 0);

  const highStakes = isTrueHighStakesVisionCategory(id.category);

  const confidenceLabel = computeConfidenceLabel({
    confidence: overallConfidence,
    attributeCertainty,
    visibleText: id.visibleText || [],
    authenticityFlags,
    highStakes,
    brand: id.brand,
    model: id.model,
  });

  const luxuryBrand = isHighStakesBrand(id.brand);
  const luxurySegment =
    id.marketSegment === "luxury" || id.marketSegment === "premium";
  const brandNotConfirmed =
    confidenceLabel === "possible" ||
    confidenceLabel === "unknown" ||
    confidenceLabel === "insufficient_evidence";
  const luxuryCandidate =
    (highStakes || luxurySegment || luxuryBrand) && brandNotConfirmed;

  let authenticityClaimAllowed;
  if (highStakes) {
    authenticityClaimAllowed = confidenceLabel === "confirmed";
  } else {
    authenticityClaimAllowed =
      confidenceLabel === "confirmed" || confidenceLabel === "likely";
  }

  const missingEvidence = computeMissingEvidence(id);
  const evidenceSource = computeEvidenceSource(id, attributeCertainty);

  if (highStakes && id.brand && !authenticityClaimAllowed) {
    const hasBrandEvidence = missingEvidence.every(
      (m) => m !== "no readable text detected"
    );
    if (!hasBrandEvidence) {
      missingEvidence.push("high-stakes brand evidence not strong enough");
    }
  }

  const bookDetected = isBookIdentity(id);
  const gameDetected = isVideoGameIdentity(id);
  const mediaKind = bookDetected ? "book" : gameDetected ? "video_game" : null;

  const vt = Array.isArray(id.visibleText) ? id.visibleText : [];
  const author = bookDetected ? deriveBookAuthor(vt) : null;
  const isbn = bookDetected ? deriveIsbn(vt) : null;
  const platform = gameDetected ? deriveGamePlatform(vt) : null;

  if (bookDetected) {
    if (!id.model) missingEvidence.push("book title not readable");
    if (!author) missingEvidence.push("author not identified");
    if (!isbn) missingEvidence.push("ISBN not visible or not readable");
  }
  if (gameDetected) {
    if (!id.model) missingEvidence.push("video game title not readable");
    if (!platform) missingEvidence.push("game platform not identified");
  }

  const rawQueryTermsAllowed = computeQueryTermsAllowed(
    id, confidenceLabel, authenticityClaimAllowed, highStakes
  );
  const queryTermsBlocked = computeQueryTermsBlocked(
    id, highStakes, authenticityClaimAllowed, confidenceLabel, evidenceSource
  );
  const identityWarnings = computeIdentityWarnings(
    id, highStakes, confidenceLabel, authenticityClaimAllowed, evidenceSource
  );

  if (bookDetected && !id.model) {
    identityWarnings.push("Book title is not confirmed from readable cover text.");
  }
  if (gameDetected && !platform) {
    identityWarnings.push("Platform not confirmed — do not infer from case color.");
  }

  if (bookDetected && (confidenceLabel === "confirmed" || confidenceLabel === "likely")) {
    if (author && !rawQueryTermsAllowed.includes(author)) rawQueryTermsAllowed.push(author);
    if (isbn && !rawQueryTermsAllowed.includes(isbn)) rawQueryTermsAllowed.push(isbn);
  }
  if (gameDetected && (confidenceLabel === "confirmed" || confidenceLabel === "likely")) {
    if (platform && !rawQueryTermsAllowed.includes(platform)) rawQueryTermsAllowed.push(platform);
  }

  // --- Headphone taxonomy enrichment (Phase 5B.3B) ---
  const headphoneDetected = isHeadphoneIdentity(id);
  let audioKind = null;
  let headphoneFit = null;
  let headphoneBackType = null;
  let headphoneWireless = null;
  let headphoneNoiseCancelling = null;
  let headphoneFeatures = [];
  let headphoneEvidence = [];

  if (headphoneDetected) {
    audioKind = deriveAudioKind(id);
    headphoneFit = deriveHeadphoneFit(id);
    headphoneBackType = deriveHeadphoneBackType(id);
    headphoneWireless = deriveHeadphoneWireless(id);
    headphoneNoiseCancelling = deriveHeadphoneNoiseCancelling(id);
    headphoneFeatures = deriveHeadphoneFeatures(id);

    const evidence = [];
    if (headphoneFit) evidence.push(`fit:${headphoneFit}`);
    if (headphoneBackType) evidence.push(`back_type:${headphoneBackType}`);
    if (headphoneWireless === true) {
      const vt = Array.isArray(id.visibleText) ? id.visibleText : [];
      const sw = Array.isArray(id.styleWords) ? id.styleWords : [];
      const j = vt.filter((t) => t && typeof t === "string").join(" ") +
        " " + sw.filter((s) => s && typeof s === "string").join(" ");
      evidence.push(/\bbluetooth\b/i.test(j) ? "wireless:bluetooth" : "wireless:true");
    }
    if (headphoneNoiseCancelling === true) {
      const vt = Array.isArray(id.visibleText) ? id.visibleText : [];
      const sw = Array.isArray(id.styleWords) ? id.styleWords : [];
      const j = vt.filter((t) => t && typeof t === "string").join(" ") +
        " " + sw.filter((s) => s && typeof s === "string").join(" ");
      evidence.push(/\banc\b/i.test(j) ? "noise_cancelling:anc" : "noise_cancelling:true");
    }
    headphoneEvidence = evidence;
  }

  // --- Watch taxonomy enrichment (Phase 5B.4) ---
  const watchDetected = isWatchIdentity(id);
  let watchKind = null;
  let watchDisplayType = null;
  let watchStyle = null;
  let watchStrapType = null;
  let watchFeatures = [];
  let watchEvidence = [];
  let watchLuxurySignal = null;

  if (watchDetected) {
    watchKind = deriveWatchKind(id);
    watchDisplayType = deriveWatchDisplayType(id);
    watchStyle = deriveWatchStyle(id);
    watchStrapType = deriveWatchStrapType(id);
    watchFeatures = deriveWatchFeatures(id);

    const evidence = [];
    if (watchKind) evidence.push(`kind:${watchKind}`);
    if (watchDisplayType) evidence.push(`display:${watchDisplayType}`);
    if (watchStyle) evidence.push(`style:${watchStyle}`);
    if (watchStrapType) evidence.push(`strap:${watchStrapType}`);
    for (const f of watchFeatures) evidence.push(`feature:${f}`);
    watchEvidence = evidence;

    if (watchStyle === "luxury_style") {
      watchLuxurySignal = "possible_luxury_style";
    }
  }

  // --- Garment taxonomy enrichment (Phase 5B.5) ---
  const garmentDetected = isGarmentOuterwearIdentity(id);
  let garmentKind = null;
  let outerwearType = null;
  let sweaterType = null;
  let closureType = null;
  let hoodType = null;
  let garmentMaterialSignal = null;
  let garmentFeatures = [];
  let garmentEvidence = [];

  if (garmentDetected) {
    garmentKind = deriveGarmentKind(id);
    outerwearType = deriveOuterwearType(id);
    sweaterType = deriveSweaterType(id);
    closureType = deriveClosureType(id);
    garmentMaterialSignal = deriveGarmentMaterialSignal(id);
    garmentFeatures = deriveGarmentFeatures(id);
    hoodType = (garmentFeatures.includes("hooded") || garmentKind === "hoodie") ? "hooded" : null;

    const ev = [];
    if (garmentKind) ev.push(`kind:${garmentKind}`);
    if (outerwearType) ev.push(`outer:${outerwearType}`);
    if (sweaterType) ev.push(`sweater:${sweaterType}`);
    if (closureType) ev.push(`closure:${closureType}`);
    if (hoodType) ev.push(`hood:${hoodType}`);
    if (garmentMaterialSignal) ev.push(`material:${garmentMaterialSignal}`);
    for (const f of garmentFeatures) ev.push(`feature:${f}`);
    garmentEvidence = ev;
  }

  const blockedSet = new Set(queryTermsBlocked);
  const queryTermsAllowed = rawQueryTermsAllowed.filter((t) => !blockedSet.has(t));

  return {
    ...id,
    subtype: id.subtype ?? null,
    series: id.series ?? null,
    genderTarget: id.genderTarget ?? null,
    distinguishingFeatures: id.distinguishingFeatures ?? [],
    missingEvidence,
    evidenceSource,
    confidenceLabel,
    highStakes,
    luxuryCandidate,
    authenticityClaimAllowed,
    queryTermsAllowed,
    queryTermsBlocked,
    identityWarnings,
    conditionNotes: id.conditionNotes ?? null,
    broadQuery: id.broadQuery ?? null,
    categoryFallbackQuery: id.categoryFallbackQuery ?? null,
    visualDescriptorQuery: id.visualDescriptorQuery ?? null,
    mediaKind,
    author,
    isbn,
    platform,
    edition: null,
    region: null,
    rating: null,
    publisher: null,
    developer: null,
    audioKind,
    headphoneFit,
    headphoneBackType,
    headphoneWireless,
    headphoneNoiseCancelling,
    headphoneFeatures,
    headphoneEvidence,
    watchKind,
    watchDisplayType,
    watchStyle,
    watchStrapType,
    watchFeatures,
    watchEvidence,
    watchLuxurySignal,
    garmentKind,
    outerwearType,
    sweaterType,
    closureType,
    hoodType,
    garmentMaterialSignal,
    garmentFeatures,
    garmentEvidence,
  };
}
