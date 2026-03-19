// src/categorySpecificIntel.js
// Category-deep intelligence: each category gets its own dedicated analysis layer.
// Sneakers: size run + colorway demand. Electronics: spec parsing + lock risk.
// Watches: reference validation + movement. Bags: hardware color premium.

// ── SNEAKERS ──────────────────────────────────────────────────────────────────

// Colorway demand index: relative resale multiplier vs. base retail
const SNEAKER_COLORWAY_DEMAND = {
  // Jordan 1
  "chicago":        1.80,  "bred":          1.70,  "royal":        1.65,
  "shadow":         1.50,  "university blue":1.55, "mocha":        1.40,
  "unc":            1.45,  "trophy room":   1.60,  "lost and found":1.75,
  // Nike Dunk
  "panda":          1.25,  "syracuse":      1.35,  "michigan":     1.30,
  "kentucky":       1.40,  "sb grateful dead":1.90,"travis scott": 2.20,
  // Adidas
  "yeezy zebra":    1.60,  "yeezy cream":   1.30,  "yeezy static": 1.35,
  "samba og white": 1.15,  "samba black":   1.10,
  // New Balance
  "navy":           1.20,  "steel":         1.15,  "sea salt":     1.25,
  // General
  "black white":    1.00,  "white":         1.05,  "black":        1.00,
  "grey":           0.95,  "neon":          0.90,  "yellow":       0.95,
};

// Half sizes trade at premium — full size chart premiums
const SNEAKER_SIZE_PREMIUM = {
  "4":   0.85,  "4.5": 0.88,  "5":   0.90,  "5.5": 0.92,
  "6":   0.95,  "6.5": 0.97,  "7":   0.98,  "7.5": 1.00,
  "8":   1.05,  "8.5": 1.08,  "9":   1.12,  "9.5": 1.10,
  "10":  1.15,  "10.5":1.12,  "11":  1.10,  "11.5":1.08,
  "12":  1.05,  "13":  1.00,  "14":  0.90,  "15":  0.85,
};

export function analyzeSneakerIntel(identity = {}, uiItems = []) {
  const model    = String(identity?.model    || "").toLowerCase();
  const colorway = String(identity?.colorway || identity?.color || "").toLowerCase();
  const size     = String(identity?.size     || "").replace(/[^0-9.]/g, "");

  // Colorway demand
  let colorwayMultiplier = 1.00;
  let colorwayLabel      = null;
  for (const [key, mult] of Object.entries(SNEAKER_COLORWAY_DEMAND)) {
    if (colorway.includes(key) || model.includes(key)) {
      colorwayMultiplier = mult;
      colorwayLabel      = key;
      break;
    }
  }

  // Size premium
  const sizePremium  = SNEAKER_SIZE_PREMIUM[size] ?? 1.00;
  const sizeInDemand = sizePremium >= 1.08;
  const sizeRare     = sizePremium <= 0.92;

  // DS (deadstock) signal from condition
  const isDS = /\b(ds|deadstock|new|unworn|nwt|vnds)\b/i.test(
    String(identity?.condition || "").trim()
  );

  return {
    category:          "sneakers",
    colorwayDemand: {
      colorway:         colorwayLabel || colorway || null,
      multiplier:       round2(colorwayMultiplier),
      tier:             colorwayMultiplier >= 1.50 ? "grail"
                      : colorwayMultiplier >= 1.20 ? "high_demand"
                      : colorwayMultiplier >= 1.00 ? "standard"
                      : "low_demand",
      signal:           colorwayMultiplier >= 1.50
        ? `${colorwayLabel || colorway} — grail colorway, commands ${((colorwayMultiplier - 1) * 100).toFixed(0)}% premium`
        : colorwayMultiplier >= 1.20
        ? `High-demand colorway — resale premium applies`
        : null,
    },
    sizeDemand: {
      size,
      premium:          round2(sizePremium),
      inDemand:         sizeInDemand,
      rare:             sizeRare,
      signal:           sizeInDemand
        ? `Size ${size} is in-demand — commands ${((sizePremium - 1) * 100).toFixed(0)}% premium`
        : sizeRare
        ? `Size ${size} is rare — may be harder to sell, expect lower offers`
        : null,
    },
    deadstock:          isDS,
    deadstockPremium:   isDS ? "DS pairs command 20-40% over worn condition" : null,
  };
}

// ── ELECTRONICS ───────────────────────────────────────────────────────────────

// Storage size premium multipliers (vs. base storage)
const STORAGE_MULTIPLIERS = {
  "64gb":  0.85,  "128gb": 1.00,  "256gb": 1.15,
  "512gb": 1.30,  "1tb":   1.50,
};

export function analyzeElectronicsIntel(identity = {}, visibleText = []) {
  const model   = String(identity?.model || "").toLowerCase();
  const allText = [model, ...visibleText.map(t => String(t).toLowerCase())].join(" ");

  // Detect storage
  let storageKey = null;
  let storageMult = 1.00;
  for (const key of ["1tb", "512gb", "256gb", "128gb", "64gb"]) {
    if (allText.includes(key)) {
      storageKey  = key;
      storageMult = STORAGE_MULTIPLIERS[key];
      break;
    }
  }

  // Detect carrier lock risk
  const carrierLocked    = /\b(at&t|verizon|t-mobile|sprint|locked|carrier locked)\b/i.test(allText);
  const explicitUnlocked = /\b(unlocked|factory unlocked|sim free)\b/i.test(allText);
  const carrierRisk      = carrierLocked && !explicitUnlocked;

  // iCloud / activation lock risk (Apple only)
  const isApple       = /\b(iphone|ipad|apple|ios)\b/i.test(allText);
  const iCloudRisk    = isApple && /\b(icloud|activation lock|apple id|find my)\b/i.test(allText);
  const iCloudLocked  = iCloudRisk && /\b(locked|not removed|still enabled)\b/i.test(allText);

  // Refurbished / open box signal
  const isRefurb      = /\b(refurbished|refurb|renewed|open box|oem)\b/i.test(allText);

  // Color premium — Pro/Max models
  const isProMax      = /\b(pro max|ultra|plus|pro)\b/i.test(model);

  return {
    category:    "electronics",
    storage: {
      detected:    storageKey,
      multiplier:  round2(storageMult),
      signal:      storageKey
        ? `${storageKey.toUpperCase()} storage — ${storageMult > 1 ? "premium" : "base"} tier`
        : null,
    },
    carrierLock: {
      risk:        carrierRisk,
      unlocked:    explicitUnlocked,
      signal:      carrierRisk
        ? "Carrier-locked device — reduces resale value and buyer pool significantly"
        : explicitUnlocked
        ? "Unlocked — maximizes resale value and buyer pool"
        : null,
    },
    iCloudLock: {
      risk:        iCloudLocked,
      signal:      iCloudLocked
        ? "⚠️ iCloud/activation lock detected — DO NOT BUY unless seller can unlock before sale"
        : isApple
        ? "Verify iCloud lock status before buying: Settings > [Name] > Find My"
        : null,
    },
    condition: {
      isRefurbished: isRefurb,
      isProMax,
      signal:        isRefurb ? "Refurbished/open box — verify warranty status" : null,
    },
  };
}

// ── WATCHES ───────────────────────────────────────────────────────────────────

// Known reference number patterns and their significance
const WATCH_REFERENCE_SIGNALS = {
  // Rolex
  "126610": { brand: "rolex", name: "Submariner Date",     significance: "Current production, commands premium" },
  "126613": { brand: "rolex", name: "Submariner Two-Tone", significance: "Two-tone premium, strong resale" },
  "116500": { brand: "rolex", name: "Daytona Panda",       significance: "Most sought-after Daytona — significant premium" },
  "126570": { brand: "rolex", name: "Explorer II",         significance: "Solid everyday Rolex, good liquidity" },
  "126334": { brand: "rolex", name: "Datejust 41",         significance: "High production, excellent liquidity" },
  // Omega
  "210.32": { brand: "omega", name: "Seamaster Diver 300M", significance: "Bond watch — strong cultural demand" },
  "311.30": { brand: "omega", name: "Speedmaster Moonwatch", significance: "Icon — consistent appreciating demand" },
  // Seiko
  "SRPE03": { brand: "seiko", name: "Prospex",             significance: "Popular dive reference, good value" },
  "SBSA":   { brand: "seiko", name: "Prospex SBSA",        significance: "Japan-spec — collector premium" },
};

// Movement types and their premium signals
const MOVEMENT_SIGNALS = {
  automatic:  { premium: 0.20, label: "Automatic", signal: "Automatic movement — commands premium over quartz" },
  manual:     { premium: 0.15, label: "Manual Wind", signal: "Manual wind — traditional mechanical, collector appeal" },
  quartz:     { premium: 0.00, label: "Quartz",     signal: "Quartz movement — accurate but lower collector value" },
  solar:      { premium: 0.05, label: "Solar",      signal: "Solar-powered — good value for daily wear" },
  kinetic:    { premium: 0.08, label: "Kinetic",    signal: "Kinetic — hybrid tech, niche appeal" },
};

export function analyzeWatchIntel(identity = {}, visibleText = []) {
  const brand   = String(identity?.brand || "").toLowerCase();
  const model   = String(identity?.model || "").toLowerCase();
  const allText = [brand, model, ...visibleText.map(t => String(t).toLowerCase())].join(" ");

  // Reference number lookup
  let refSignal = null;
  for (const [ref, data] of Object.entries(WATCH_REFERENCE_SIGNALS)) {
    if (allText.includes(ref.toLowerCase())) {
      refSignal = { reference: ref, ...data };
      break;
    }
  }

  // Movement detection
  let movement = null;
  for (const [type, data] of Object.entries(MOVEMENT_SIGNALS)) {
    if (allText.includes(type)) {
      movement = { type, ...data };
      break;
    }
  }
  // Auto-detect from brand context if not explicitly mentioned
  if (!movement) {
    if (/\b(rolex|omega|patek|ap|seiko|hamilton|citizen)\b/.test(brand)) {
      movement = MOVEMENT_SIGNALS.automatic;
    }
  }

  // Box and papers signal
  const hasBox    = /\b(box|original box|watch box)\b/i.test(allText);
  const hasPapers = /\b(papers|warranty card|certificate|b&p|full set)\b/i.test(allText);
  const fullSet   = hasBox && hasPapers;

  return {
    category: "watch",
    reference: {
      detected:    refSignal?.reference || null,
      name:        refSignal?.name       || null,
      significance:refSignal?.significance || null,
      signal:      refSignal ? `Ref ${refSignal.reference}: ${refSignal.significance}` : null,
    },
    movement: {
      type:        movement?.type    || null,
      label:       movement?.label   || null,
      premiumPct:  movement ? round2(movement.premium * 100) : null,
      signal:      movement?.signal  || null,
    },
    provenance: {
      hasBox,
      hasPapers,
      fullSet,
      signal:      fullSet   ? "Full set (box + papers) — commands 20-40% premium"
                 : hasPapers ? "Papers present — significant value add"
                 : hasBox    ? "Box present — moderate value add"
                 : "No box or papers mentioned — reduced collector appeal",
    },
  };
}

// ── BAGS ──────────────────────────────────────────────────────────────────────

// Hardware color premiums (gold vs silver vs ruthenium vs rose gold)
const HARDWARE_PREMIUMS = {
  "gold hardware":      0.12,
  "ghw":               0.12,
  "silver hardware":   0.05,
  "shw":               0.05,
  "rose gold":         0.10,
  "rghw":              0.10,
  "ruthenium":         0.15,
  "aged gold":         0.18,
  "palladium":         0.08,
  "brushed gold":      0.10,
};

// Color demand by brand
const BAG_COLOR_DEMAND = {
  "black":       1.10,  "white":       0.95,  "beige":       1.00,
  "camel":       1.05,  "brown":       1.00,  "tan":         1.00,
  "navy":        1.00,  "red":         0.90,  "pink":        0.85,
  "blue":        1.00,  "green":       0.88,  "orange":      0.82,
  "yellow":      0.80,  "grey":        0.95,  "nude":        1.05,
  "monogram":    1.15,  "damier":      1.10,  "canvas":      1.05,
};

export function analyzeBagIntel(identity = {}, visibleText = []) {
  const brand   = String(identity?.brand || "").toLowerCase();
  const model   = String(identity?.model || "").toLowerCase();
  const color   = String(identity?.color || "").toLowerCase();
  const allText = [brand, model, color, ...visibleText.map(t => String(t).toLowerCase())].join(" ");

  // Hardware color premium
  let hardwarePremium = 0;
  let hardwareType    = null;
  for (const [hw, prem] of Object.entries(HARDWARE_PREMIUMS)) {
    if (allText.includes(hw)) {
      hardwarePremium = prem;
      hardwareType    = hw;
      break;
    }
  }

  // Color demand
  let colorMultiplier = 1.00;
  let colorKey        = null;
  for (const [c, mult] of Object.entries(BAG_COLOR_DEMAND)) {
    if (color.includes(c) || allText.includes(c)) {
      colorMultiplier = mult;
      colorKey        = c;
      break;
    }
  }

  // Size signal
  const hasSizeInfo = /\b(mini|small|medium|large|pm|mm|gm|nano|micro|tpm)\b/i.test(allText);
  const isSmall     = /\b(mini|small|pm|nano|micro|tpm)\b/i.test(allText);
  const isLarge     = /\b(large|gm|maxi)\b/i.test(allText);

  // Authenticity signals (dustbag, receipt, card)
  const hasDustbag  = /\b(dustbag|dust bag|pochon)\b/i.test(allText);
  const hasReceipt  = /\b(receipt|proof of purchase|invoice)\b/i.test(allText);
  const hasAuthCard = /\b(auth card|authenticity card|certificate|serial card)\b/i.test(allText);

  return {
    category: "bag",
    hardware: {
      type:        hardwareType,
      premiumPct:  round2(hardwarePremium * 100),
      signal:      hardwareType
        ? `${hardwareType.replace(/(^\w|\s\w)/g, m => m.toUpperCase())} — ${(hardwarePremium * 100).toFixed(0)}% premium vs base hardware`
        : null,
    },
    colorDemand: {
      color:       colorKey || color || null,
      multiplier:  round2(colorMultiplier),
      signal:      colorMultiplier >= 1.10
        ? `${colorKey} is a high-demand colorway for bags — commands ${((colorMultiplier - 1) * 100).toFixed(0)}% premium`
        : colorMultiplier < 0.90
        ? `${colorKey} is lower-demand — expect softer resale`
        : null,
    },
    size: {
      hasSizeInfo,
      isSmall,
      isLarge,
      signal: isSmall ? "Mini/small size — wide appeal, easier to sell"
            : isLarge ? "Large size — narrower buyer pool, price accordingly"
            : null,
    },
    provenance: {
      hasDustbag,
      hasReceipt,
      hasAuthCard,
      fullProvenance: hasDustbag && (hasReceipt || hasAuthCard),
      signal: (hasReceipt || hasAuthCard)
        ? "Receipt/auth card present — significant buyer confidence boost"
        : hasDustbag
        ? "Dustbag present — expected for luxury bags"
        : "No provenance documents — may reduce buyer confidence",
    },
  };
}

// ── Master dispatcher ─────────────────────────────────────────────────────────

/**
 * Build category-specific intelligence for any item.
 * Returns null if category has no specific module.
 */
export function buildCategorySpecificIntel({
  identity    = {},
  category    = "",
  uiItems     = [],
  visibleText = [],
} = {}) {
  const cat = String(category || "").toLowerCase().replace(/s$/, "");

  switch (cat) {
    case "sneaker":      return analyzeSneakerIntel(identity, uiItems);
    case "electronic":   return analyzeElectronicsIntel(identity, visibleText);
    case "watch":        return analyzeWatchIntel(identity, visibleText);
    case "bag":          return analyzeBagIntel(identity, visibleText);
    default:             return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function round2(v) {
  return Math.round(v * 100) / 100;
}
