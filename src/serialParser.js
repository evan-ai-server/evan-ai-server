  // src/serialParser.js
  // Non-LLM serial/mark parser — OCR preprocessing + pattern matching
  // Works in text-only mode if tesseract.js is not installed

  import sharp from "sharp";
  import { createHash } from "crypto";
  import { SERIAL_PATTERNS } from "./patternLibraries/serialPatterns.js";

  const OCR_ENABLED            = process.env.SERIAL_PARSER_OCR_ENABLED === "true";
  const MIN_CONFIDENCE         = Number(process.env.SERIAL_PARSER_CONFIDENCE_THRESHOLD || 0.70);
  const CACHE_TTL_MS           = 7 * 24 * 60 * 60 * 1000; // 7 days

  // ── Redis cache helpers ───────────────────────────────────────────────────────

  function cacheKey(inputHash) {
    return `serial_parse:${inputHash}`;
  }

  async function cacheGet(redis, key) {
    if (!redis) return null;
    try {
      const raw = await redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function cacheSet(redis, key, value) {
    if (!redis) return;
    try {
      await redis.set(key, JSON.stringify(value), "EX", Math.floor(CACHE_TTL_MS / 1000));
    } catch {}
  }

  // ── Image preprocessing for OCR ──────────────────────────────────────────────
  // Upscale, grayscale, high-contrast for best OCR results

  async function preprocessForOCR(imageBuffer) {
    try {
      return await sharp(imageBuffer)
        .resize({ width: 1600, withoutEnlargement: false })
        .grayscale()
        .normalise()
        .sharpen()
        .jpeg({ quality: 92 })
        .toBuffer();
    } catch {
      return imageBuffer;
    }
  }

  // ── OCR via tesseract.js (optional dep) ─────────────────────────────────────

  let tesseractWorker = null;
  let tesseractAvailable = null;

  async function getTesseractWorker() {
    if (tesseractAvailable === false) return null;
    if (tesseractWorker) return tesseractWorker;

    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, {
        logger: () => {},
        errorHandler: () => {},
      });
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-./# %",
      });
      tesseractWorker    = worker;
      tesseractAvailable = true;
      return worker;
    } catch {
      tesseractAvailable = false;
      return null;
    }
  }

  async function runOCR(imageBuffer) {
    if (!OCR_ENABLED) return null;
    const worker = await getTesseractWorker();
    if (!worker) return null;

    try {
      const processed   = await preprocessForOCR(imageBuffer);
      const { data }    = await worker.recognize(processed);
      return (data?.text || "").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
    } catch {
      return null;
    }
  }

  // ── Pattern matching core ────────────────────────────────────────────────────

  function runPatternLibrary(text = "") {
    const results = [];
    const upperText = text.toUpperCase();

    for (const pattern of SERIAL_PATTERNS) {
      // Reset lastIndex for global regex
      const re = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match;

      while ((match = re.exec(upperText)) !== null) {
        let fields;
        try {
          fields = pattern.extract(match);
        } catch {
          continue;
        }

        if (!fields) continue;

        const valid = pattern.validate ? pattern.validate(fields) : true;
        if (!valid) continue;

        results.push({
          patternName:  pattern.name,
          brand:        pattern.brand  || fields.brand  || null,
          category:     pattern.category || null,
          line:         fields.line    || null,
          rawMatch:     match[0],
          confidence:   pattern.confidence,
          parsed:       fields,
          valid:        true,
        });

        // Don't collect more than 20 matches across all patterns
        if (results.length >= 20) break;
      }

      if (results.length >= 20) break;
    }

    return results;
  }

  // ── Aggregate results into top parsed output ─────────────────────────────────

  function buildTopResult(matches = []) {
    if (!matches.length) return null;

    // Sort by confidence DESC, then by specificity of brand detection
    const sorted = [...matches].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const aHasBrand = a.brand ? 1 : 0;
      const bHasBrand = b.brand ? 1 : 0;
      return bHasBrand - aHasBrand;
    });

    const top    = sorted[0];
    const flags  = [];
    const redFlags = [];

    // Check for known fake markers in visible text
    if (top.rawMatch) {
      const raw = top.rawMatch.toUpperCase();
      // Nike fakes often have malformed style codes
      if (top.brand === "Nike" && !/^[A-Z]{2,3}[0-9]{4,5}-[0-9]{3}$/.test(raw.trim())) {
        redFlags.push("malformed_nike_style_code");
      }
      // Apple fakes sometimes have all-zero serials
      if (top.brand === "Apple" && /^[A-Z]000/.test(raw)) {
        redFlags.push("suspicious_apple_serial_prefix");
      }
    }

    if (top.confidence >= 0.85) flags.push("high_confidence_match");
    if (top.brand) flags.push("brand_identified");

    // Aggregate all fabric content into one entry if applicable
    const fabricMatches = matches.filter((m) => m.patternName === "fabric_content");
    const fabricContent = fabricMatches.length
      ? fabricMatches.map((m) => `${m.parsed.percentage}% ${m.parsed.material}`).join(", ")
      : null;

    // Aggregate shoe sizes
    const shoeSizeUS = matches.find((m) => m.patternName === "shoe_size_us");
    const shoeSizeEU = matches.find((m) => m.patternName === "shoe_size_eu");

    return {
      raw:         top.rawMatch,
      patternName: top.patternName,
      confidence:  top.confidence,
      parsed: {
        ...top.parsed,
        fabricContent: fabricContent || undefined,
        sizeUS:        shoeSizeUS?.parsed?.sizeUS  ?? undefined,
        sizeEU:        shoeSizeEU?.parsed?.sizeEU  ?? undefined,
      },
      allMatches:  sorted.slice(0, 8).map((m) => ({
        patternName: m.patternName,
        rawMatch:    m.rawMatch,
        confidence:  m.confidence,
        brand:       m.brand,
      })),
      flags,
      redFlags,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  /**
   * Parse from an image Buffer (OCR path).
   * Falls back to text-only parsing if OCR unavailable.
   */
  export async function parseSerialFromImage(imageBuffer, redis = null) {
    if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
      return { ok: false, source: "image", reason: "empty_buffer", parsed: null, allMatches: [], flags: [], redFlags: [] };
    }

    const hash    = createHash("sha256").update(imageBuffer).digest("hex").slice(0, 32);
    const key     = cacheKey(`img:${hash}`);
    const cached  = await cacheGet(redis, key);
    if (cached) return { ...cached, cached: true };

    const ocrText = await runOCR(imageBuffer);

    if (!ocrText || !ocrText.trim()) {
      return { ok: false, source: "image_ocr", reason: "ocr_no_text", parsed: null, allMatches: [], flags: [], redFlags: [] };
    }

    const matches    = runPatternLibrary(ocrText);
    const topResult  = buildTopResult(matches);

    const result = {
      ok:          !!topResult && topResult.confidence >= MIN_CONFIDENCE,
      source:      "image_ocr",
      ocrText,
      parsed:      topResult?.parsed   || null,
      raw:         topResult?.raw      || null,
      patternName: topResult?.patternName || null,
      confidence:  topResult?.confidence  || 0,
      allMatches:  topResult?.allMatches  || [],
      flags:       topResult?.flags       || [],
      redFlags:    topResult?.redFlags    || [],
    };

    await cacheSet(redis, key, result);
    return result;
  }

  /**
   * Parse from visible text strings extracted by the vision model.
   * Zero external deps — always works.
   */
  export async function parseSerialFromText(textArray = [], redis = null) {
    const texts = Array.isArray(textArray) ? textArray : [];
    if (!texts.length) {
      return { ok: false, source: "text", reason: "empty_input", parsed: null, allMatches: [], flags: [], redFlags: [] };
    }

    const combined = texts.join(" ").replace(/\s+/g, " ").trim();
    if (!combined) {
      return { ok: false, source: "text", reason: "empty_combined", parsed: null, allMatches: [], flags: [], redFlags: [] };
    }

    const hash   = createHash("sha256").update(combined).digest("hex").slice(0, 32);
    const key    = cacheKey(`txt:${hash}`);
    const cached = await cacheGet(redis, key);
    if (cached) return { ...cached, cached: true };

    const matches   = runPatternLibrary(combined);
    const topResult = buildTopResult(matches);

    const result = {
      ok:          !!topResult && topResult.confidence >= MIN_CONFIDENCE,
      source:      "text",
      ocrText:     combined,
      parsed:      topResult?.parsed   || null,
      raw:         topResult?.raw      || null,
      patternName: topResult?.patternName || null,
      confidence:  topResult?.confidence  || 0,
      allMatches:  topResult?.allMatches  || [],
      flags:       topResult?.flags       || [],
      redFlags:    topResult?.redFlags    || [],
    };

    await cacheSet(redis, key, result);
    return result;
  }


