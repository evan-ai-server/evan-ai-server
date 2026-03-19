  // src/patternLibraries/serialPatterns.js
  // Regex pattern library for serial / model / SKU identification
  // Each pattern: { name, category, brand, regex, extract(match) → fields, confidence }

  export const SERIAL_PATTERNS = [

    // ── Nike / Jordan ─────────────────────────────────────────────────────────
    {
      name:       "nike_style_code",
      category:   "sneakers",
      brand:      "Nike",
      // BQ5671-010, CT8532-100, CW7575-001, DV0568-070
      regex:      /\b([A-Z]{2,3}[0-9]{4,5}-[0-9]{3})\b/g,
      confidence: 0.92,
      extract(match) {
        const [styleCode, colorCode] = match[1].split("-");
        return {
          serialFormat: "NIKE_STYLE_CODE",
          styleCode:    match[1],
          colorCode:    colorCode || null,
          brand:        "Nike",
          line:         null,
        };
      },
      validate(fields) {
        // Color codes are 3-digit numbers 001–999
        return /^[0-9]{3}$/.test(fields.colorCode || "");
      },
    },

    // ── Adidas ────────────────────────────────────────────────────────────────
    {
      name:       "adidas_article_number",
      category:   "sneakers",
      brand:      "Adidas",
      // EE4437, FW6395, GW0573, HR0491
      regex:      /\b([A-Z]{2}[0-9]{4})\b/g,
      confidence: 0.78,
      extract(match) {
        return {
          serialFormat: "ADIDAS_ARTICLE_NUMBER",
          articleNumber: match[1],
          brand: "Adidas",
          line:  null,
        };
      },
      validate(fields) {
        return /^[A-Z]{2}[0-9]{4}$/.test(fields.articleNumber || "");
      },
    },

    // ── New Balance ───────────────────────────────────────────────────────────
    {
      name:       "new_balance_model",
      category:   "sneakers",
      brand:      "New Balance",
      // ML574EVB, M990GL4, W1080N10
      regex:      /\b([MWU][A-Z][0-9]{3,4}[A-Z0-9]{1,6})\b/g,
      confidence: 0.82,
      extract(match) {
        return {
          serialFormat: "NEW_BALANCE_MODEL",
          modelCode: match[1],
          brand: "New Balance",
          line:  match[1].slice(0, 5),
        };
      },
      validate(fields) {
        return /^[MWU][A-Z][0-9]{3,4}[A-Z0-9]{1,6}$/.test(fields.modelCode || "");
      },
    },

    // ── Oakley ────────────────────────────────────────────────────────────────
    {
      name:       "oakley_frame_sku",
      category:   "eyewear",
      brand:      "Oakley",
      // OO9208-01, OO9448-0155, OJ9001-01
      regex:      /\b(O[OJ][0-9]{4}(?:-[0-9]{2,4})?)\b/g,
      confidence: 0.91,
      extract(match) {
        const parts = match[1].split("-");
        return {
          serialFormat: "OAKLEY_FRAME_SKU",
          frameSku:     parts[0],
          colorCode:    parts[1] || null,
          brand:        "Oakley",
          line:         null,
        };
      },
      validate(fields) {
        return /^O[OJ][0-9]{4}$/.test(fields.frameSku || "");
      },
    },

    // ── Ray-Ban ───────────────────────────────────────────────────────────────
    {
      name:       "rayban_model",
      category:   "eyewear",
      brand:      "Ray-Ban",
      // RB3025, RB4171, RB2132
      regex:      /\b(RB[0-9]{4}[A-Z]?)\b/g,
      confidence: 0.90,
      extract(match) {
        return {
          serialFormat: "RAYBAN_MODEL",
          modelNumber:  match[1],
          brand:        "Ray-Ban",
          line:         null,
        };
      },
      validate(fields) {
        return /^RB[0-9]{4}[A-Z]?$/.test(fields.modelNumber || "");
      },
    },

    // ── Apple Serial (pre-2021, 12 chars) ─────────────────────────────────────
    {
      name:       "apple_serial_12",
      category:   "electronics",
      brand:      "Apple",
      // C02XG2CNJG5J, DQHF2LL/A
      regex:      /\b([A-Z0-9]{12})\b/g,
      confidence: 0.72,
      extract(match) {
        return {
          serialFormat: "APPLE_SERIAL_12",
          serial:       match[1],
          brand:        "Apple",
          line:         null,
        };
      },
      validate(fields) {
        // Apple 12-char serials: alphanumeric, no I, O (ambiguous chars)
        return /^[A-Z0-9]{12}$/.test(fields.serial || "") &&
               !/[IO]/.test(fields.serial || "");
      },
    },

    // ── Apple Model Number ────────────────────────────────────────────────────
    {
      name:       "apple_model_number",
      category:   "electronics",
      brand:      "Apple",
      // MN9P3LL/A, MGN63LL/A, MHGJ3LL/A
      regex:      /\b([A-Z]{2}[0-9A-Z]{3}[0-9A-Z][A-Z]{2}\/[A-Z])\b/g,
      confidence: 0.87,
      extract(match) {
        return {
          serialFormat: "APPLE_MODEL_NUMBER",
          modelNumber:  match[1],
          brand:        "Apple",
          line:         null,
        };
      },
      validate(fields) {
        return /^[A-Z]{2}[0-9A-Z]{3}[0-9A-Z][A-Z]{2}\/[A-Z]$/.test(fields.modelNumber || "");
      },
    },

    // ── Sony Audio/Electronics ────────────────────────────────────────────────
    {
      name:       "sony_model",
      category:   "electronics",
      brand:      "Sony",
      // WH-1000XM4, MDR-XB950N1, WF-1000XM3
      regex:      /\b([A-Z]{2,3}-[0-9A-Z]{4,10})\b/g,
      confidence: 0.68,
      extract(match) {
        return {
          serialFormat: "SONY_MODEL",
          modelNumber:  match[1],
          brand:        "Sony",
          line:         match[1].split("-")[0] || null,
        };
      },
      validate(fields) {
        const known = ["WH", "WF", "MDR", "SRS", "KD", "XBR", "HT"];
        const prefix = (fields.modelNumber || "").split("-")[0];
        return known.includes(prefix);
      },
    },

    // ── Samsung Phone ─────────────────────────────────────────────────────────
    {
      name:       "samsung_phone_model",
      category:   "electronics",
      brand:      "Samsung",
      // SM-A536BZKGEUE, SM-G991B, SM-F926B
      regex:      /\b(SM-[A-Z][0-9]{3}[A-Z0-9]{0,6})\b/g,
      confidence: 0.88,
      extract(match) {
        return {
          serialFormat: "SAMSUNG_PHONE_MODEL",
          modelNumber:  match[1],
          brand:        "Samsung",
          line:         match[1].slice(3, 5),
        };
      },
      validate(fields) {
        return /^SM-[A-Z][0-9]{3}/.test(fields.modelNumber || "");
      },
    },

    // ── FCC ID ────────────────────────────────────────────────────────────────
    {
      name:       "fcc_id",
      category:   "electronics",
      brand:      null,
      // 2AJNPBC4, BCG-E2946A, A3LSMG960U
      regex:      /\b(FCC(?:\s+ID)?[:\s]+([A-Z0-9]{3,4}-?[A-Z0-9]{4,12}))/gi,
      confidence: 0.84,
      extract(match) {
        return {
          serialFormat: "FCC_ID",
          fccId:        match[2] || match[1],
          brand:        null,
          line:         null,
        };
      },
      validate() { return true; },
    },

    // ── IMEI ──────────────────────────────────────────────────────────────────
    {
      name:       "imei",
      category:   "electronics",
      brand:      null,
      regex:      /\b([0-9]{15})\b/g,
      confidence: 0.80,
      extract(match) {
        return {
          serialFormat: "IMEI",
          imei:         match[1],
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        // Luhn check for IMEI
        const digits = (fields.imei || "").split("").map(Number);
        let sum = 0;
        for (let i = 0; i < digits.length; i++) {
          let d = digits[i];
          if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
          sum += d;
        }
        return sum % 10 === 0;
      },
    },

    // ── UPC (12-digit) ────────────────────────────────────────────────────────
    {
      name:       "upc",
      category:   "general",
      brand:      null,
      regex:      /\b([0-9]{12})\b/g,
      confidence: 0.74,
      extract(match) {
        return {
          serialFormat: "UPC",
          upc:          match[1],
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        const digits = (fields.upc || "").split("").map(Number);
        if (digits.length !== 12) return false;
        const check = digits.pop();
        const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
        return (10 - (sum % 10)) % 10 === check;
      },
    },

    // ── EAN (13-digit) ────────────────────────────────────────────────────────
    {
      name:       "ean",
      category:   "general",
      brand:      null,
      regex:      /\b([0-9]{13})\b/g,
      confidence: 0.74,
      extract(match) {
        return {
          serialFormat: "EAN",
          ean:          match[1],
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        const digits = (fields.ean || "").split("").map(Number);
        if (digits.length !== 13) return false;
        const check = digits.pop();
        const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
        return (10 - (sum % 10)) % 10 === check;
      },
    },

    // ── RN# (US clothing Registered Number) ───────────────────────────────────
    {
      name:       "rn_number",
      category:   "apparel",
      brand:      null,
      regex:      /\bRN\s*#?\s*([0-9]{5,6})\b/gi,
      confidence: 0.85,
      extract(match) {
        return {
          serialFormat: "RN_NUMBER",
          rnNumber:     match[1],
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        return /^[0-9]{5,6}$/.test(fields.rnNumber || "");
      },
    },

    // ── Shoe size (US/EU/UK) ──────────────────────────────────────────────────
    {
      name:       "shoe_size_us",
      category:   "sneakers",
      brand:      null,
      regex:      /\bUS\s*([0-9]{1,2}(?:\.5)?)\b/gi,
      confidence: 0.89,
      extract(match) {
        return {
          serialFormat: "SHOE_SIZE_US",
          sizeUS:       Number(match[1]),
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        return Number.isFinite(fields.sizeUS) && fields.sizeUS >= 1 && fields.sizeUS <= 20;
      },
    },
    {
      name:       "shoe_size_eu",
      category:   "sneakers",
      brand:      null,
      regex:      /\bEU\s*([0-9]{2,3})\b/gi,
      confidence: 0.87,
      extract(match) {
        return {
          serialFormat: "SHOE_SIZE_EU",
          sizeEU:       Number(match[1]),
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        return Number.isFinite(fields.sizeEU) && fields.sizeEU >= 28 && fields.sizeEU <= 55;
      },
    },

    // ── Fabric care tag content ───────────────────────────────────────────────
    {
      name:       "fabric_content",
      category:   "apparel",
      brand:      null,
      // "100% COTTON", "60% POLYESTER 40% COTTON"
      regex:      /([0-9]{1,3})\s*%\s*(COTTON|POLYESTER|NYLON|WOOL|SILK|LINEN|RAYON|SPANDEX|LYCRA|ACRYLIC|LEATHER|SUEDE|DOWN|CASHMERE)/gi,
      confidence: 0.88,
      extract(match) {
        return {
          serialFormat: "FABRIC_CONTENT",
          percentage:   Number(match[1]),
          material:     match[2].toLowerCase(),
          brand:        null,
          line:         null,
        };
      },
      validate(fields) {
        return Number.isFinite(fields.percentage) &&
               fields.percentage > 0 && fields.percentage <= 100;
      },
    },
  ];


