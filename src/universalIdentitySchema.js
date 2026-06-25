// src/universalIdentitySchema.js
// Phase 5B.1+5B.2+5B.3B+5B.4+5B.5+5B.6+5B.7+5B.8 — Universal identity schema foundation.
// Enriches the existing vision identity with structured confidence labels,
// high-stakes flags, evidence metadata, query-safety metadata,
// book/video-game recognition, headphone taxonomy enrichment,
// watch taxonomy enrichment, jacket/coat/sweater/zip taxonomy enrichment,
// broader clothing taxonomy enrichment, hat/cap/beanie taxonomy enrichment,
// and bag/backpack/handbag/wallet taxonomy enrichment.
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

// --- Broader clothing taxonomy (Phase 5B.6) ---

const CLOTHING_ACCESSORY_RE = /\b(pants hanger|pants rack|shirt hanger|skirt hanger|dress hanger|clothes hanger|garment bag|dress form|mannequin|shirt folder|t-shirt press|tee shirt press|heat press|screen printing press|clothing rack|display rack)\b/i;
const CLOTHING_HOMONYM_RE = /\b(golf tee|tee time|tee ball|tee box|tee off|tee-off|polo cologne|polo horse|polo pony|polo match|polo club|water polo|marco polo|graphic poster|graphic novel|graphic card|graphic design|graphic designer|button battery|push button|belly button|button mushroom|button down folder|panic button|flannel blanket|flannel sheet|flannel fabric|blouse pattern|fish tank|gas tank|water tank|septic tank|think tank|army tank|tank engine|tank toy|tank lid|tank filter|tank top filter|propane tank|storage tank|holding tank|crop tool|crop field|crop circle|crop duster|crop yield|crop rotation|cargo box|cargo ship|cargo van|cargo plane|cargo bay|cargo net|cargo container|cargo bike|cargo trailer|dress shoes|dress shoe|dress watch|dress code|dress rehearsal|dressing|window dressing|salad dressing|dress up|dress-up|dressed|hair dress|wound dressing|fancy pants|smarty pants|pants on fire|short circuit|shortstop|short story|short film|short stack|short squeeze|sell short|skirt steak|grass skirt|outskirts|skirting board|mini fridge|mini keyboard|mini cooper|mini golf|mini me|mini van|minivan|mini bike|mini split|mini pc|mini blind|midi keyboard|midi controller|midi cable|midi file|midi interface|maxi pad|maxi cab|maxi scooter|maxi taxi|record sleeve|album sleeve|cable sleeve|vinyl sleeve|sleeve cover|long sleeve record)\b/i;
const CLOTHING_EXCLUDED_CAT_RE = /\b(shoe|shoes|sneaker|sneakers|boot|boots|sandal|sandals|heel|heels|loafer|loafers|cleat|cleats|footwear|slipper|slippers|moccasin|hat|cap|beanie|scarf|gloves|glove|socks|sock|belt(?!\s+loops)|necktie|bowtie|mittens|earmuffs|bandana|balaclava)\b/i;
const CLOTHING_POSITIVE_RE = /\b(t-shirt|t shirt|tshirt|tee shirt|graphic tee|graphic t-shirt|pocket tee|crew tee|polo shirt|polo top|rugby shirt|button-down shirt|button down shirt|button-up shirt|button up shirt|oxford shirt|flannel shirt|dress shirt|henley|blouse|tank top|camisole|cami|long sleeve shirt|long-sleeve shirt|long sleeve tee|long-sleeve tee|short sleeve shirt|short-sleeve shirt|crop top|tube top|halter top|jersey|jeans|denim jeans|skinny jeans|straight leg jeans|bootcut jeans|boyfriend jeans|cargo pants|cargo trousers|dress pants|chinos|chino pants|khakis|trousers|slacks|sweatpants|track pants|joggers|jogger pants|leggings|yoga pants|shorts|cargo shorts|denim shorts|board shorts|chino shorts|athletic shorts|bermuda shorts|dress|maxi dress|midi dress|mini dress|sundress|shirt dress|shirtdress|sweater dress|cocktail dress|wrap dress|bodycon dress|skirt|maxi skirt|midi skirt|mini skirt|pleated skirt|pencil skirt|denim skirt|a-line skirt|skater skirt|pants)\b/i;

export function isClothingIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  // 1. Accessory veto
  if (CLOTHING_ACCESSORY_RE.test(joined)) return false;
  // 2. Homonym veto (UNCONDITIONAL — no positive override)
  if (CLOTHING_HOMONYM_RE.test(joined)) return false;
  // 3. Excluded-category veto
  if (CLOTHING_EXCLUDED_CAT_RE.test(joined)) return false;
  // 4. Positive match
  if (CLOTHING_POSITIVE_RE.test(joined)) return true;
  // 5. else false
  return false;
}

const CLOTHING_DRESS_GUARD_RE = /\bdress\b(?!\s+(shirt|pants|shoe|shoes|sock|socks|glove|gloves|code|up|form|rehearsal))/i;

export function deriveClothingKind(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  // Priority: skirt > dress(guarded) > top > bottom
  if (/\bskirt\b/i.test(joined)) return "skirt";
  if (CLOTHING_DRESS_GUARD_RE.test(joined)) return "dress";
  // Tops
  if (/\b(t-shirt|t shirt|tshirt|tee shirt|graphic tee|graphic t-shirt|pocket tee|crew tee|polo shirt|polo top|rugby shirt|button-down shirt|button down shirt|button-up shirt|button up shirt|oxford shirt|flannel shirt|dress shirt|henley|blouse|tank top|camisole|cami|long sleeve shirt|long-sleeve shirt|long sleeve tee|long-sleeve tee|short sleeve shirt|short-sleeve shirt|crop top|tube top|halter top|jersey)\b/i.test(joined)) return "top";
  // Bottoms
  if (/\b(jeans|cargo pants|cargo trousers|dress pants|chinos|chino pants|khakis|trousers|slacks|sweatpants|track pants|joggers|jogger pants|leggings|yoga pants|shorts|cargo shorts|denim shorts|board shorts|chino shorts|athletic shorts|bermuda shorts|pants)\b/i.test(joined)) return "bottom";
  return null;
}

export function deriveTopType(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  // graphic_tee wins over t_shirt when graphic/printed/front-print co-occurs with tee/t-shirt
  if (/\b(graphic tee|graphic t-shirt)\b/i.test(joined)) return "graphic_tee";
  if (/\b(printed|front.print)\b/i.test(joined) && /\b(t-shirt|t shirt|tshirt|tee shirt|tee)\b/i.test(joined)) return "graphic_tee";
  if (/\b(polo shirt|polo top)\b/i.test(joined)) return "polo";
  if (/\b(button-down shirt|button down shirt|button-up shirt|button up shirt|oxford shirt)\b/i.test(joined)) return "button_down";
  if (/\bflannel shirt\b/i.test(joined)) return "flannel";
  if (/\bdress shirt\b/i.test(joined)) return "dress_shirt";
  if (/\bblouse\b/i.test(joined)) return "blouse";
  if (/\b(tank top|camisole|cami)\b/i.test(joined)) return "tank_top";
  if (/\b(crop top)\b/i.test(joined)) return "crop_top";
  if (/\bhenley\b/i.test(joined)) return "henley";
  if (/\bjersey\b/i.test(joined)) return "jersey";
  if (/\b(long sleeve shirt|long-sleeve shirt|long sleeve tee|long-sleeve tee)\b/i.test(joined)) return "long_sleeve";
  if (/\b(t-shirt|t shirt|tshirt|tee shirt)\b/i.test(joined)) return "t_shirt";
  return null;
}

export function deriveBottomType(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  // Guard: denim jacket / jean jacket must not become jeans
  if (/\b(denim jacket|jean jacket)\b/i.test(joined)) return null;
  if (/\b(cargo shorts)\b/i.test(joined)) return "cargo_shorts";
  if (/\b(cargo pants|cargo trousers|cargo pocket pants)\b/i.test(joined)) return "cargo_pants";
  if (/\b(dress pants|formal pants|slacks)\b/i.test(joined)) return "dress_pants";
  if (/\b(chinos|chino pants|khakis)\b/i.test(joined)) return "chinos";
  if (/\bsweatpants\b/i.test(joined)) return "sweatpants";
  if (/\b(joggers|jogger pants|track pants)\b/i.test(joined)) return "joggers";
  if (/\b(leggings|yoga pants)\b/i.test(joined)) return "leggings";
  if (/\btrousers\b/i.test(joined)) return "trousers";
  if (/\bjeans\b/i.test(joined)) return "jeans";
  if (/\b(denim shorts|board shorts|chino shorts|athletic shorts|bermuda shorts|shorts)\b/i.test(joined)) return "shorts";
  return null;
}

export function deriveDressSkirtType(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  // Guard: "dress shirt"/"dress pants" must NOT become a dress/skirt type
  if (/\b(dress shirt|dress pants)\b/i.test(joined) && !CLOTHING_DRESS_GUARD_RE.test(joined.replace(/\bdress (shirt|pants)\b/gi, ""))) return null;
  // Specific dress types before bare dress
  if (/\b(shirt dress|shirtdress)\b/i.test(joined)) return "shirt_dress";
  if (/\bsweater dress\b/i.test(joined)) return "sweater_dress";
  if (/\bcocktail dress\b/i.test(joined)) return "cocktail_dress";
  if (/\bwrap dress\b/i.test(joined)) return "wrap_dress";
  if (/\bbodycon dress\b/i.test(joined)) return "bodycon_dress";
  if (/\bsundress\b/i.test(joined)) return "sundress";
  if (/\bmaxi dress\b/i.test(joined)) return "maxi_dress";
  if (/\bmidi dress\b/i.test(joined)) return "midi_dress";
  if (/\bmini dress\b/i.test(joined)) return "mini_dress";
  // Specific skirt types before bare skirt
  if (/\bpleated skirt\b/i.test(joined)) return "pleated_skirt";
  if (/\bpencil skirt\b/i.test(joined)) return "pencil_skirt";
  if (/\bdenim skirt\b/i.test(joined)) return "denim_skirt";
  if (/\ba-line skirt\b/i.test(joined)) return "a_line_skirt";
  if (/\bskater skirt\b/i.test(joined)) return "skater_skirt";
  if (/\bmaxi skirt\b/i.test(joined)) return "maxi_skirt";
  if (/\bmidi skirt\b/i.test(joined)) return "midi_skirt";
  if (/\bmini skirt\b/i.test(joined)) return "mini_skirt";
  if (CLOTHING_DRESS_GUARD_RE.test(joined)) return "dress";
  if (/\bskirt\b/i.test(joined)) return "skirt";
  return null;
}

export function deriveSleeveType(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\b(short sleeve|short-sleeve)\b/i.test(joined)) return "short_sleeve";
  if (/\b(long sleeve|long-sleeve)\b/i.test(joined)) return "long_sleeve";
  if (/\b(sleeveless|tank top|camisole|cami|halter)\b/i.test(joined)) return "sleeveless";
  return null;
}

export function deriveCollarType(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\b(crewneck|crew neck)\b/i.test(joined)) return "crewneck";
  if (/\b(v-neck|v neck)\b/i.test(joined)) return "v_neck";
  if (/\b(polo shirt|polo collar)\b/i.test(joined)) return "polo_collar";
  if (/\bbutton-down collar\b/i.test(joined)) return "button_down_collar";
  if (/\bcollared\b/i.test(joined)) return "collared";
  return null;
}

export function deriveFitSignal(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\bslim\b/i.test(joined)) return "slim";
  if (/\brelaxed\b/i.test(joined)) return "relaxed";
  if (/\boversized\b/i.test(joined)) return "oversized";
  if (/\b(wide-leg|wide leg)\b/i.test(joined)) return "wide_leg";
  if (/\b(straight-leg|straight leg)\b/i.test(joined)) return "straight_leg";
  if (/\b(skinny jeans|skinny pants|skinny fit)\b/i.test(joined)) return "skinny";
  return null;
}

export function deriveClothingPatternSignal(identity) {
  if (!isClothingIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\b(graphic|printed|front print)\b/i.test(joined)) return "graphic";
  if (/\b(stripe|stripes|striped)\b/i.test(joined)) return "striped";
  if (/\b(plaid|tartan|checkered)\b/i.test(joined)) return "plaid";
  if (/\bfloral\b/i.test(joined)) return "floral";
  if (/\b(solid|solid color)\b/i.test(joined)) return "solid";
  return null;
}

export function deriveClothingMaterialSignal(identity) {
  if (!isClothingIdentity(identity)) return null;
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
  if (/\bcotton\b/.test(all)) return "cotton";
  if (/\bdenim\b/.test(all)) return "denim";
  if (/\blinen\b/.test(all)) return "linen";
  if (/\bsilk\b/.test(all)) return "silk";
  if (/\bpolyester\b/.test(all)) return "polyester";
  if (/\bwool\b/.test(all)) return "wool";
  if (/\bcorduroy\b/.test(all)) return "corduroy";
  return null;
}

const CFEAT_FRONT_PRINT_RE = /\b(front.print|graphic|printed)\b/i;
const CFEAT_CARGO_POCKETS_RE = /\b(cargo pockets|cargo pocket)\b/i;
const CFEAT_DRAWSTRING_RE = /\b(drawstring waist|drawstring)\b/i;
const CFEAT_PLEATED_RE = /\bpleated\b/i;
const CFEAT_BUTTON_FRONT_RE = /\b(button front|button-front)\b/i;
const CFEAT_ELASTIC_WAIST_RE = /\b(elastic waist|elasticized waist)\b/i;
const CFEAT_BELT_LOOPS_RE = /\bbelt loops\b/i;
const CFEAT_FIVE_POCKET_RE = /\b(five.pocket|5.pocket)\b/i;
const CFEAT_EMBROIDERED_RE = /\b(embroidered|embroidery)\b/i;
const CFEAT_LOGO_PRINT_RE = /\b(logo print|logo printed)\b/i;

export function deriveClothingFeatures(identity) {
  if (!isClothingIdentity(identity)) return [];
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
  if (CFEAT_FRONT_PRINT_RE.test(joined)) features.push("front_print");
  if (CFEAT_CARGO_POCKETS_RE.test(joined)) features.push("cargo_pockets");
  if (CFEAT_DRAWSTRING_RE.test(joined)) features.push("drawstring_waist");
  if (CFEAT_PLEATED_RE.test(joined)) features.push("pleated");
  if (CFEAT_BUTTON_FRONT_RE.test(joined)) features.push("button_front");
  if (CFEAT_ELASTIC_WAIST_RE.test(joined)) features.push("elastic_waist");
  if (CFEAT_BELT_LOOPS_RE.test(joined)) features.push("belt_loops");
  if (CFEAT_FIVE_POCKET_RE.test(joined)) features.push("five_pocket");
  if (CFEAT_EMBROIDERED_RE.test(joined)) features.push("embroidered");
  if (CFEAT_LOGO_PRINT_RE.test(joined)) features.push("logo_print");
  return features;
}

// --- Headwear taxonomy (Phase 5B.7) ---

const HEADWEAR_ACCESSORY_RE = /\b(hat rack|hat stand|hat box|hat hook|hat pin|hatpin|hat band|hatband|cap rack|cap holder|cap display|hat display|visor clip|visor mount|hat form)\b/i;
const HEADWEAR_HOMONYM_RE = /\b(bottle cap|lens cap|hub cap|hubcap|gas cap|fuel cap|oil cap|radiator cap|valve cap|wheel cap|toe cap|cap toe|ice cap|knee cap|kneecap|end cap|dust cap|screw cap|twist cap|flip cap|filler cap|distributor cap|cap screw|cap nut|pen cap|marker cap|cap gun|cap table|cap rate|salary cap|market cap|price cap|debt cap|spending cap|cap sleeve|hat trick|beanie baby|beanie babies|beanie boo|bucket list|bucket seat|bucket bag|bucket truck|fedora linux|fedora os|fedora workstation|fedora server|sun visor|car visor|helmet visor|windshield visor|cowboy boot|cowboy boots|cowboy belt|cowboy bebop|beret pattern)\b/i;
const HEADWEAR_EXCLUDED_CAT_RE = /\b(headphone|headphones|earbud|earbuds|earmuff|earmuffs|helmet|helmets|mask|wig|wigs|hairpiece|toupee|scarf|gloves|glove|shoe|shoes|sneaker|sneakers|boot|boots|sandal|sandals)\b/i;
const HEADWEAR_POSITIVE_RE = /\b(headwear|head wear|baseball cap|dad hat|dad cap|snapback cap|snapback|fitted cap|fitted hat|trucker hat|trucker cap|bucket hat|knit beanie|knit cap|knit hat|skull cap|beanie|sun hat|cowboy hat|flat cap|newsboy cap|ball cap|golf cap|cycling cap|mesh cap|painters cap|driver cap|ivy cap|fedora|beret|balaclava|trapper hat|earflap hat|winter hat|visor|hat)\b/i;

export function isHeadwearIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  // 1. Accessory veto
  if (HEADWEAR_ACCESSORY_RE.test(joined)) return false;
  // 2. Homonym veto (UNCONDITIONAL — no positive override)
  if (HEADWEAR_HOMONYM_RE.test(joined)) return false;
  // 3. Excluded-category veto
  if (HEADWEAR_EXCLUDED_CAT_RE.test(joined)) return false;
  // 4. Positive match
  if (HEADWEAR_POSITIVE_RE.test(joined)) return true;
  // 5. else false
  return false;
}

const HWKIND_BEANIE_RE = /\b(beanie|knit cap|knit hat|skull cap)\b/i;
const HWKIND_VISOR_RE = /\bvisor\b/i;
const HWKIND_BALACLAVA_RE = /\bbalaclava\b/i;
const HWKIND_CAP_RE = /\b(baseball cap|snapback|fitted cap|fitted hat|trucker cap|trucker hat|flat cap|newsboy cap|dad hat|dad cap|ball cap|golf cap|cycling cap|mesh cap|driver cap|ivy cap|painters cap)\b/i;
const HWKIND_HAT_RE = /\b(hat|fedora|cowboy hat|bucket hat|sun hat|trapper hat|earflap hat|winter hat|beret|straw hat|top hat)\b/i;

export function deriveHeadwearKind(identity) {
  if (!isHeadwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (HWKIND_BEANIE_RE.test(joined)) return "beanie";
  if (HWKIND_VISOR_RE.test(joined)) return "visor";
  if (HWKIND_BALACLAVA_RE.test(joined)) return "balaclava";
  if (HWKIND_CAP_RE.test(joined)) return "cap";
  if (HWKIND_HAT_RE.test(joined)) return "hat";
  return null;
}

export function deriveHeadwearType(identity) {
  if (!isHeadwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  // Most-specific first
  if (/\bsnapback\b/i.test(joined)) return "snapback";
  if (/\b(dad hat|dad cap)\b/i.test(joined)) return "dad_hat";
  if (/\b(fitted cap|fitted hat)\b/i.test(joined)) return "fitted_cap";
  if (/\b(trucker cap|trucker hat)\b/i.test(joined)) return "trucker_cap";
  if (/\bknit beanie\b/i.test(joined)) return "knit_beanie";
  if (/\bskull cap\b/i.test(joined)) return "skull_cap";
  if (/\bbucket hat\b/i.test(joined)) return "bucket_hat";
  if (/\bvisor\b/i.test(joined)) return "visor";
  if (/\bsun hat\b/i.test(joined)) return "sun_hat";
  if (/\bfedora\b/i.test(joined)) return "fedora";
  if (/\bcowboy hat\b/i.test(joined)) return "cowboy_hat";
  if (/\bflat cap\b/i.test(joined)) return "flat_cap";
  if (/\bnewsboy cap\b/i.test(joined)) return "newsboy_cap";
  if (/\bberet\b/i.test(joined)) return "beret";
  if (/\bbalaclava\b/i.test(joined)) return "balaclava";
  if (/\btrapper hat\b/i.test(joined)) return "trapper_hat";
  if (/\bearflap hat\b/i.test(joined)) return "earflap_hat";
  if (/\bwinter hat\b/i.test(joined)) return "winter_hat";
  if (/\b(baseball cap|ball cap)\b/i.test(joined)) return "baseball_cap";
  if (/\bbeanie\b/i.test(joined)) return "beanie";
  return null;
}

export function deriveBrimType(identity) {
  if (!isHeadwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\b(curved brim|curved bill)\b/i.test(joined)) return "curved_brim";
  if (/\b(flat brim|flat bill)\b/i.test(joined)) return "flat_brim";
  if (/\b(wide brim|wide-brim)\b/i.test(joined)) return "wide_brim";
  // Structural no_brim for definitionally brimless types
  const hwType = deriveHeadwearType(identity);
  if (hwType === "beanie" || hwType === "knit_beanie" || hwType === "skull_cap" || hwType === "balaclava") return "no_brim";
  return null;
}

export function deriveClosureAdjustType(identity) {
  if (!isHeadwearIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\b(snapback|snap closure|snap back)\b/i.test(joined)) return "snapback";
  if (/\b(strapback|strap-back|strap back|buckle back)\b/i.test(joined)) return "strapback";
  if (/\b(fitted cap|fitted hat)\b/i.test(joined)) return "fitted";
  if (/\b(adjustable|velcro back|hook and loop)\b/i.test(joined)) return "adjustable";
  return null;
}

export function deriveHeadwearMaterialSignal(identity) {
  if (!isHeadwearIdentity(identity)) return null;
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
  if (/\bcotton\b/.test(all)) return "cotton";
  if (/\bwool\b/.test(all)) return "wool";
  // knit: from knit beanie/cap/hat compound OR explicit knit in materials
  if (/\b(knit beanie|knit cap|knit hat)\b/.test(all)) return "knit";
  if (/\bknit\b/.test(matJoined)) return "knit";
  // mesh: from mesh back/mesh cap compound OR explicit mesh in materials
  if (/\b(mesh back|mesh cap)\b/.test(all)) return "mesh";
  if (/\bmesh\b/.test(matJoined)) return "mesh";
  if (/\bfelt\b/.test(all)) return "felt";
  if (/\bstraw\b/.test(all)) return "straw";
  if (/\bpolyester\b/.test(all)) return "polyester";
  if (/\bacrylic\b/.test(all)) return "acrylic";
  return null;
}

const HWFEAT_EMBROIDERED_RE = /\b(embroidered|embroidery)\b/i;
const HWFEAT_PATCH_RE = /\bpatch\b/i;
const HWFEAT_LOGO_PRINT_RE = /\b(logo print|logo printed)\b/i;
const HWFEAT_MESH_BACK_RE = /\bmesh back\b/i;
const HWFEAT_FOLDED_CUFF_RE = /\b(folded cuff|fold.over cuff|cuffed brim|cuffed beanie)\b/i;
const HWFEAT_POM_POM_RE = /\b(pom pom|pom-pom|pompom)\b/i;
const HWFEAT_ADJUSTABLE_BACK_RE = /\b(adjustable back|adjustable strap)\b/i;
const HWFEAT_SNAP_CLOSURE_RE = /\b(snap closure|snap back|snapback closure)\b/i;
const HWFEAT_CURVED_BILL_RE = /\b(curved bill|curved brim)\b/i;
const HWFEAT_FLAT_BILL_RE = /\b(flat bill|flat brim)\b/i;

export function deriveHeadwearFeatures(identity) {
  if (!isHeadwearIdentity(identity)) return [];
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
  if (HWFEAT_EMBROIDERED_RE.test(joined)) features.push("embroidered");
  if (HWFEAT_PATCH_RE.test(joined)) features.push("patch");
  if (HWFEAT_LOGO_PRINT_RE.test(joined)) features.push("logo_print");
  if (HWFEAT_MESH_BACK_RE.test(joined)) features.push("mesh_back");
  if (HWFEAT_FOLDED_CUFF_RE.test(joined)) features.push("folded_cuff");
  if (HWFEAT_POM_POM_RE.test(joined)) features.push("pom_pom");
  if (HWFEAT_ADJUSTABLE_BACK_RE.test(joined)) features.push("adjustable_back");
  if (HWFEAT_SNAP_CLOSURE_RE.test(joined)) features.push("snap_closure");
  if (HWFEAT_CURVED_BILL_RE.test(joined)) features.push("curved_bill");
  if (HWFEAT_FLAT_BILL_RE.test(joined)) features.push("flat_bill");
  return features;
}

// --- Bag / wallet taxonomy (Phase 5B.8) ---

const BAG_ACCESSORY_RE = /\b(bag holder|bag rack|bag stand|bag hook|purse hanger|purse organizer)\b/i;
const BAG_HOMONYM_RE = /\b(bag of|tea bag|coffee bag|grocery bag|plastic bag|trash bag|garbage bag|shopping bag|dust bag|sleeping bag|body bag|air bag|airbag|sandbag|sand bag|punching bag|bean bag|money bag|goody bag|gift bag|lunch bag|barf bag|feed bag|colostomy bag|iv bag|baggage|bagel|bagpipe|bagpipes|tote bin|tote box|crypto wallet|digital wallet|mobile wallet|e-wallet|ewallet|apple wallet|google wallet|samsung wallet|steam wallet|bitcoin wallet|ethereum wallet|hardware wallet|cold wallet|hot wallet|wallet app|wallet case|purse seine|purse string|purse strings|pursed lips|purse lips|clutch pedal|clutch kit|clutch plate|clutch disc|clutch cable|clutch master|clutch cylinder|clutch fork|clutch release|clutch hitter|clutch player|clutch performance|clutch gene|clutch of eggs|messenger app|messenger rna|facebook messenger|messenger pigeon|messenger bird|backpack blower|backpack vacuum|backpack sprayer|backpack leaf blower|pouch cell|battery pouch|tobacco pouch|kangaroo pouch|marsupial pouch|cheek pouch|food pouch|ketchup pouch|briefcase icon|trading card holder|card game holder|toploader|primary cardholder|credit cardholder|phone card holder|duffel coat|duffle coat|satchel paige|baby sling|arm sling|slingshot|sling tv)\b/i;
const BAG_EXCLUDED_CAT_RE = /\b(shoe|shoes|sneaker|sneakers|boot|boots|sandal|sandals|hat|cap|beanie|watch|headphone|headphones|earbud|earbuds|shirt|pants|jacket|coat|dress|skirt|sweater|hoodie|scarf|gloves|glove|sock|socks)\b/i;
const BAG_POSITIVE_RE = /\b(backpack|handbag|tote bag|crossbody bag|crossbody purse|crossbody|shoulder bag|messenger bag|satchel|clutch bag|clutch purse|evening clutch|clutch|wristlet|coin purse|coin pouch|purse|bifold wallet|trifold wallet|zip wallet|leather wallet|card holder|cardholder|wallet|fanny pack|belt bag|waist bag|sling bag|duffel bag|duffle bag|gym bag|travel bag|laptop bag|briefcase|cosmetic bag|makeup bag|drawstring bag|pouch|tote|bag)\b/i;

export function isBagIdentity(identity) {
  if (!identity || typeof identity !== "object") return false;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (!joined) return false;
  if (BAG_ACCESSORY_RE.test(joined)) return false;
  if (BAG_HOMONYM_RE.test(joined)) return false;
  if (BAG_EXCLUDED_CAT_RE.test(joined)) return false;
  if (BAG_POSITIVE_RE.test(joined)) return true;
  return false;
}

const BKIND_WALLET_RE = /\b(wallet|cardholder|card holder|bifold|trifold|coin purse)\b/i;
const BKIND_BACKPACK_RE = /\bbackpack\b/i;
const BKIND_HANDBAG_RE = /\b(handbag|purse|shoulder bag|crossbody|crossbody bag|crossbody purse|clutch|clutch bag|satchel)\b/i;
const BKIND_POUCH_RE = /\b(pouch|wristlet|cosmetic bag|makeup bag|coin pouch)\b/i;
const BKIND_BAG_RE = /\b(tote|tote bag|messenger bag|duffel bag|duffle bag|gym bag|travel bag|laptop bag|briefcase|sling bag|fanny pack|belt bag|waist bag|drawstring bag|bag)\b/i;

export function deriveBagKind(identity) {
  if (!isBagIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (BKIND_WALLET_RE.test(joined)) return "wallet";
  if (BKIND_BACKPACK_RE.test(joined)) return "backpack";
  if (BKIND_HANDBAG_RE.test(joined)) return "handbag";
  if (BKIND_POUCH_RE.test(joined)) return "pouch";
  if (BKIND_BAG_RE.test(joined)) return "bag";
  return null;
}

export function deriveBagType(identity) {
  if (!isBagIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\bbifold wallet\b/i.test(joined)) return "bifold_wallet";
  if (/\btrifold wallet\b/i.test(joined)) return "trifold_wallet";
  if (/\bzip wallet\b/i.test(joined)) return "zip_wallet";
  if (/\b(leather wallet)\b/i.test(joined) && !/\b(bifold|trifold|zip)\b/i.test(joined)) return "wallet";
  if (/\b(cardholder|card holder)\b/i.test(joined)) return "cardholder";
  if (/\bcoin purse\b/i.test(joined)) return "coin_purse";
  if (/\bcrossbody bag\b/i.test(joined)) return "crossbody_bag";
  if (/\bcrossbody purse\b/i.test(joined)) return "crossbody_bag";
  if (/\bshoulder bag\b/i.test(joined)) return "shoulder_bag";
  if (/\btote bag\b/i.test(joined)) return "tote_bag";
  if (/\bmessenger bag\b/i.test(joined)) return "messenger_bag";
  if (/\bsatchel\b/i.test(joined)) return "satchel";
  if (/\b(clutch bag|clutch purse|evening clutch)\b/i.test(joined)) return "clutch";
  if (/\bwristlet\b/i.test(joined)) return "wristlet";
  if (/\bfanny pack\b/i.test(joined)) return "fanny_pack";
  if (/\bbelt bag\b/i.test(joined)) return "belt_bag";
  if (/\bwaist bag\b/i.test(joined)) return "waist_bag";
  if (/\bsling bag\b/i.test(joined)) return "sling_bag";
  if (/\b(duffel bag|duffle bag)\b/i.test(joined)) return "duffel_bag";
  if (/\bgym bag\b/i.test(joined)) return "gym_bag";
  if (/\btravel bag\b/i.test(joined)) return "travel_bag";
  if (/\blaptop bag\b/i.test(joined)) return "laptop_bag";
  if (/\bbriefcase\b/i.test(joined)) return "briefcase";
  if (/\bcosmetic bag\b/i.test(joined)) return "cosmetic_bag";
  if (/\bmakeup bag\b/i.test(joined)) return "makeup_bag";
  if (/\bdrawstring bag\b/i.test(joined)) return "drawstring_bag";
  if (/\bbackpack\b/i.test(joined)) return "backpack";
  if (/\bhandbag\b/i.test(joined)) return "handbag";
  if (/\bpurse\b/i.test(joined)) return "purse";
  if (/\bwallet\b/i.test(joined)) return "wallet";
  if (/\bpouch\b/i.test(joined)) return "pouch";
  if (/\b(coin pouch)\b/i.test(joined)) return "pouch";
  if (/\btote\b/i.test(joined)) return "tote_bag";
  if (/\bclutch\b/i.test(joined)) return "clutch";
  return null;
}

const CARRY_CROSSBODY_RE = /\b(crossbody|cross-body)\b/i;
const CARRY_SHOULDER_RE = /\b(shoulder bag|shoulder strap)\b/i;
const CARRY_BACKPACK_RE = /\b(backpack|shoulder straps)\b/i;
const CARRY_WAIST_RE = /\b(fanny pack|belt bag|waist bag)\b/i;
const CARRY_WRISTLET_RE = /\b(wristlet|wrist strap)\b/i;
const CARRY_HANDHELD_RE = /\b(top handle|handbag|clutch|briefcase)\b/i;

export function deriveCarryType(identity) {
  if (!isBagIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (CARRY_CROSSBODY_RE.test(joined)) return "crossbody";
  if (CARRY_BACKPACK_RE.test(joined)) return "backpack";
  if (CARRY_SHOULDER_RE.test(joined)) return "shoulder";
  if (CARRY_WAIST_RE.test(joined)) return "waist";
  if (CARRY_WRISTLET_RE.test(joined)) return "wristlet";
  if (CARRY_HANDHELD_RE.test(joined)) return "handheld";
  return null;
}

export function deriveBagClosureType(identity) {
  if (!isBagIdentity(identity)) return null;
  const fields = [
    identity.category,
    identity.itemType,
    identity.subtype,
    Array.isArray(identity.styleWords) ? identity.styleWords.join(" ") : null,
  ];
  const joined = fields.filter((f) => f && typeof f === "string").join(" ");
  if (/\b(zipper|zip closure|zip wallet)\b/i.test(joined)) return "zip";
  if (/\bsnap closure\b/i.test(joined)) return "snap";
  if (/\bmagnetic closure\b/i.test(joined)) return "magnetic";
  if (/\bbuckle closure\b/i.test(joined)) return "buckle";
  if (/\b(drawstring bag|drawstring closure)\b/i.test(joined)) return "drawstring";
  if (/\b(flap closure|flap bag)\b/i.test(joined)) return "flap";
  if (/\b(open top|open-top)\b/i.test(joined)) return "open_top";
  return null;
}

export function deriveBagMaterialSignal(identity) {
  if (!isBagIdentity(identity)) return null;
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
  if (/\bleather\b/.test(all)) return "leather";
  if (/\bcanvas\b/.test(all)) return "canvas";
  if (/\bnylon\b/.test(all)) return "nylon";
  if (/\bpolyester\b/.test(all)) return "polyester";
  if (/\bsuede\b/.test(all)) return "suede";
  if (/\bdenim\b/.test(all)) return "denim";
  if (/\bstraw\b/.test(all)) return "straw";
  if (/\bvinyl\b/.test(all)) return "vinyl";
  if (/\bfabric\b/.test(all)) return "fabric";
  return null;
}

const BFEAT_CARD_SLOTS_RE = /\b(card slots|card slot)\b/i;
const BFEAT_BILL_RE = /\b(bill compartment|bill pocket)\b/i;
const BFEAT_COIN_POCKET_RE = /\bcoin pocket\b/i;
const BFEAT_LAPTOP_SLEEVE_RE = /\blaptop sleeve\b/i;
const BFEAT_ADJ_STRAP_RE = /\badjustable strap\b/i;
const BFEAT_DET_STRAP_RE = /\bdetachable strap\b/i;
const BFEAT_CHAIN_STRAP_RE = /\bchain strap\b/i;
const BFEAT_SHOULDER_STRAP_RE = /\bshoulder strap\b/i;
const BFEAT_TOP_HANDLE_RE = /\btop handle\b/i;
const BFEAT_FRONT_POCKET_RE = /\bfront pocket\b/i;
const BFEAT_ZIP_POCKET_RE = /\bzip pocket\b/i;
const BFEAT_DRAWSTRING_RE = /\bdrawstring\b/i;
const BFEAT_QUILTED_RE = /\b(quilted|quilting)\b/i;
const BFEAT_HARDWARE_RE = /\bhardware\b/i;
const BFEAT_FEET_RE = /\b(feet|bag feet|bottom feet)\b/i;
const BFEAT_MONOGRAM_RE = /\b(monogram pattern|monogram print|monogram)\b/i;
const BFEAT_LOGO_PRINT_RE = /\b(logo print|logo printed)\b/i;

export function deriveBagFeatures(identity) {
  if (!isBagIdentity(identity)) return [];
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
  if (BFEAT_CARD_SLOTS_RE.test(joined)) features.push("card_slots");
  if (BFEAT_BILL_RE.test(joined)) features.push("bill_compartment");
  if (BFEAT_COIN_POCKET_RE.test(joined)) features.push("coin_pocket");
  if (BFEAT_LAPTOP_SLEEVE_RE.test(joined)) features.push("laptop_sleeve");
  if (BFEAT_ADJ_STRAP_RE.test(joined)) features.push("adjustable_strap");
  if (BFEAT_DET_STRAP_RE.test(joined)) features.push("detachable_strap");
  if (BFEAT_CHAIN_STRAP_RE.test(joined)) features.push("chain_strap");
  if (BFEAT_SHOULDER_STRAP_RE.test(joined)) features.push("shoulder_strap");
  if (BFEAT_TOP_HANDLE_RE.test(joined)) features.push("top_handle");
  if (BFEAT_FRONT_POCKET_RE.test(joined)) features.push("front_pocket");
  if (BFEAT_ZIP_POCKET_RE.test(joined)) features.push("zip_pocket");
  if (BFEAT_DRAWSTRING_RE.test(joined)) features.push("drawstring");
  if (BFEAT_QUILTED_RE.test(joined)) features.push("quilted");
  if (BFEAT_HARDWARE_RE.test(joined)) features.push("hardware");
  if (BFEAT_FEET_RE.test(joined)) features.push("feet");
  if (BFEAT_MONOGRAM_RE.test(joined)) features.push("monogram_pattern");
  if (BFEAT_LOGO_PRINT_RE.test(joined)) features.push("logo_print");
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

  // --- Broader clothing taxonomy enrichment (Phase 5B.6) ---
  const clothingDetected = isClothingIdentity(id);
  let clothingKind = null;
  let topType = null;
  let bottomType = null;
  let dressSkirtType = null;
  let sleeveType = null;
  let collarType = null;
  let fitSignal = null;
  let patternSignal = null;
  let clothingMaterialSignal = null;
  let clothingFeatures = [];
  let clothingEvidence = [];
  if (clothingDetected) {
    clothingKind = deriveClothingKind(id);
    topType = deriveTopType(id);
    bottomType = deriveBottomType(id);
    dressSkirtType = deriveDressSkirtType(id);
    sleeveType = deriveSleeveType(id);
    collarType = deriveCollarType(id);
    fitSignal = deriveFitSignal(id);
    patternSignal = deriveClothingPatternSignal(id);
    clothingMaterialSignal = deriveClothingMaterialSignal(id);
    clothingFeatures = deriveClothingFeatures(id);
    const ev = [];
    if (clothingKind) ev.push(`kind:${clothingKind}`);
    if (topType) ev.push(`top:${topType}`);
    if (bottomType) ev.push(`bottom:${bottomType}`);
    if (dressSkirtType) ev.push(`dress_skirt:${dressSkirtType}`);
    if (sleeveType) ev.push(`sleeve:${sleeveType}`);
    if (collarType) ev.push(`collar:${collarType}`);
    if (fitSignal) ev.push(`fit:${fitSignal}`);
    if (patternSignal) ev.push(`pattern:${patternSignal}`);
    if (clothingMaterialSignal) ev.push(`material:${clothingMaterialSignal}`);
    for (const f of clothingFeatures) ev.push(`feature:${f}`);
    clothingEvidence = ev;
  }

  // --- Headwear taxonomy enrichment (Phase 5B.7) ---
  const headwearDetected = isHeadwearIdentity(id);
  let headwearKind = null;
  let headwearType = null;
  let brimType = null;
  let closureAdjustType = null;
  let headwearMaterialSignal = null;
  let headwearFeatures = [];
  let headwearEvidence = [];
  if (headwearDetected) {
    headwearKind = deriveHeadwearKind(id);
    headwearType = deriveHeadwearType(id);
    brimType = deriveBrimType(id);
    closureAdjustType = deriveClosureAdjustType(id);
    headwearMaterialSignal = deriveHeadwearMaterialSignal(id);
    headwearFeatures = deriveHeadwearFeatures(id);
    const ev = [];
    if (headwearKind) ev.push(`kind:${headwearKind}`);
    if (headwearType) ev.push(`type:${headwearType}`);
    if (brimType) ev.push(`brim:${brimType}`);
    if (closureAdjustType) ev.push(`closure:${closureAdjustType}`);
    if (headwearMaterialSignal) ev.push(`material:${headwearMaterialSignal}`);
    for (const f of headwearFeatures) ev.push(`feature:${f}`);
    headwearEvidence = ev;
  }

  // --- Bag / wallet taxonomy enrichment (Phase 5B.8) ---
  const bagDetected = isBagIdentity(id);
  let bagKind = null;
  let bagType = null;
  let carryType = null;
  let bagClosureType = null;
  let bagMaterialSignal = null;
  let bagFeatures = [];
  let bagEvidence = [];
  if (bagDetected) {
    bagKind = deriveBagKind(id);
    bagType = deriveBagType(id);
    carryType = deriveCarryType(id);
    bagClosureType = deriveBagClosureType(id);
    bagMaterialSignal = deriveBagMaterialSignal(id);
    bagFeatures = deriveBagFeatures(id);
    const ev = [];
    if (bagKind) ev.push(`kind:${bagKind}`);
    if (bagType) ev.push(`type:${bagType}`);
    if (carryType) ev.push(`carry:${carryType}`);
    if (bagClosureType) ev.push(`closure:${bagClosureType}`);
    if (bagMaterialSignal) ev.push(`material:${bagMaterialSignal}`);
    for (const f of bagFeatures) ev.push(`feature:${f}`);
    bagEvidence = ev;
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
    clothingKind,
    topType,
    bottomType,
    dressSkirtType,
    sleeveType,
    collarType,
    fitSignal,
    patternSignal,
    clothingMaterialSignal,
    clothingFeatures,
    clothingEvidence,
    headwearKind,
    headwearType,
    brimType,
    closureAdjustType,
    headwearMaterialSignal,
    headwearFeatures,
    headwearEvidence,
    bagKind,
    bagType,
    carryType,
    bagClosureType,
    bagMaterialSignal,
    bagFeatures,
    bagEvidence,
  };
}
