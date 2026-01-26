console.log("🔥 LOADED INDEX.JS FROM:", new URL(import.meta.url).pathname);
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import multer from "multer";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

/* -------------------- middleware -------------------- */
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// request logger
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

/* -------------------- multer -------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

/* -------------------- simple in-memory caches -------------------- */
// imageHash -> { ok, query, confidence }
const visionCache = new Map();

// query -> cheapest listings array
const serpCache = new Map();

/* -------------------- health -------------------- */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

console.log("✅ ROUTES REGISTERED");
/* -------------------- routes list (debug) -------------------- */
app.get("/routes", (_req, res) => {
  const routes = [];
  const stack = app._router?.stack || [];

  for (const layer of stack) {
    if (layer?.route?.path) {
      const methods = Object.keys(layer.route.methods || {}).map((m) =>
        m.toUpperCase()
      );
      routes.push({ path: layer.route.path, methods });
    }
  }

  res.status(200).json({ ok: true, routes });
});

/* -------------------- helpers -------------------- */
function parsePriceNumber(price) {
  if (!price) return null;
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeItem(it) {
  const price = it.extracted_price ?? parsePriceNumber(it.price);

  return {
    title: it.title || null,
    price,
    price_display: it.price || null,
    source: it.source || null,
    link: it.link || it.product_link || null,
    image: it.thumbnail || it.thumbnail_url || it.serpapi_thumbnail || null,
    rating: typeof it.rating === "number" ? it.rating : null,
    reviews: typeof it.reviews === "number" ? it.reviews : null,
  };
}

function sortCheapest(items) {
  return [...items].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
}

/* -------------------- utils -------------------- */
function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

/* -------------------- VISION ANALYZE -------------------- */
app.get(["/vision/analyze", "/api/vision/analyze"], (_req, res) => {
  res.status(200).json({
    ok: true,
    hint: 'POST multipart/form-data with field name "image"',
  });
});

app.post(
  ["/vision/analyze", "/api/vision/analyze"],
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(200).json({
          ok: true,
          query: null,
          confidence: 0,
          reason: "no_file_received",
        });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(200).json({
          ok: true,
          query: null,
          confidence: 0,
          reason: "missing_openai_api_key",
        });
      }

      const base64 = req.file.buffer.toString("base64");

      // ---- Vision cache (fast path) ----
      const imageHash = base64.slice(0, 800);
      if (visionCache.has(imageHash)) {
        console.log("🧠 Vision cache hit");
        return res.status(200).json(visionCache.get(imageHash));
      }

      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const dataUrl = `data:image/jpeg;base64,${base64}`;

      // ⬇️ YOUR PROMPT (unchanged, already excellent)
const prompt = `
You are Evan AI — a high-precision visual product identification system for thrift, vintage, and resale ecommerce search.

PRIMARY GOAL
Identify the SINGLE most likely real-world product shown in the image, optimized for:
- Thrift/vintage items (used condition, partial tags, older releases)
- Resale marketplaces (eBay/Etsy/StockX/GOAT/Depop)
- Search queries that return the correct listing with minimal noise

NON-NEGOTIABLE HARD CONSTRAINTS (must follow exactly)
1) Respond with ONLY valid JSON.
2) Do NOT include markdown. Do NOT include explanations. Do NOT include any extra keys.
3) JSON format must be EXACTLY:
   {"query": string|null, "confidence": number}

IF YOU BREAK FORMAT, THE SYSTEM FAILS. OUTPUT ONLY THE JSON OBJECT.

WHAT TO IDENTIFY (object selection rules)
- Identify the MOST PROMINENT item: centered + largest + most in-focus.
- Ignore background, hands, people, floors, shelves, and secondary objects.
- If multiple items are equally prominent, prefer the one with:
  (a) visible logo/text, then (b) distinctive design cues, then (c) higher clarity.
- If the image is mostly packaging/box/label, identify the product indicated by the packaging.

THRIFT/VINTAGE SPECIALIZATION RULES
- Expect partial wear, glare, faded print, missing tags, and older variants.
- Prefer “product line + model + type” over guessing an exact year unless it is clearly visible.
- If you suspect “vintage” but cannot place an era reliably, do NOT invent a year.
- If the item looks handmade or one-off (common on Etsy), you may return a descriptive query WITHOUT a brand IF no brand is visible.

BRAND & MODEL TRUTHFULNESS (anti-hallucination)
- NEVER invent brand names, collaborations, or model numbers.
- Only name a brand/model if supported by clear evidence in the image:
  - readable text, recognizable logo, unique silhouette, signature design elements.
- If brand is not truly supported, leave it out or set query null (depending on clarity).
- If the item resembles a famous brand but the logo is not visible and could be generic:
  lower confidence, and avoid naming the brand unless the design is uniquely identifiable.

BRAND WHITELIST BIAS (use as PRIOR, not as invention)
When evidence is present, these brands are common in thrift/resale and should be preferred as candidates:
Nike, Jordan, Adidas, New Balance, Puma, Converse, Vans,
Apple, Samsung, Sony, Bose, Beats,
Ralph Lauren, Polo, Levi’s, Carhartt, Dickies, The North Face, Patagonia,
Supreme, Stüssy, Off-White, Bape,
Coach, Michael Kors, Kate Spade,
Lululemon, Under Armour,
Yeti, Hydro Flask,
Nintendo, PlayStation, Xbox,
Canon, Nikon,
Dyson.
IMPORTANT: This whitelist is ONLY a bias to consider — do NOT output any of these unless the image actually supports it.

QUERY RULES (must be search-ready)
If confident, "query" MUST be short, precise, and optimized for Google Shopping / marketplace search:
- Core format: Brand + Model/Product line + Item type
Examples:
- "Apple AirPods Pro 2nd generation"
- "Nike Air Force 1 Low sneakers"
- "Levi’s 501 original fit jeans"
- "Sony WH-1000XM4 headphones"
- "Carhartt Detroit jacket"

Include OPTIONAL attributes ONLY if clearly visible and helpful:
- Color ONLY if obvious (e.g., "black", "white", "red").
- Material ONLY if obvious (e.g., "leather", "denim", "canvas").
- Version/Generation ONLY if strongly supported (e.g., "2nd gen", "Series 7").
- NEVER include size unless it is clearly visible (e.g., “US 10”, “32x32”) — otherwise omit.

FORBIDDEN QUERY CONTENT
- No filler words: do NOT include "looks like", "probably", "similar to", "style of".
- No vague adjectives that do not help search: "nice", "cool", "vintage style".
- No store names, no “thrift”, no “used”, no “authentic”.
- No multiple options in one query. Pick ONE best guess or null.

EVIDENCE PRIORITY (how you should reason)
Prioritize in this order:
1) Readable text (model numbers, product names, labels)
2) Logos / brand marks
3) Unique shape + distinctive features (soles, stitching, hardware, ports, button layouts)
4) Packaging cues (if box is primary)
5) Color/material (only if clear)

If evidence is weak, DO NOT guess.

EDGE CASES (important)
- Glare/blur/low light: lower confidence. If you can’t support brand/model, set query null.
- Partial view/cropped item: identify only what you can support. Avoid exact model if missing key features.
- Counterfeits/dupes: if branding looks inconsistent or suspicious, avoid naming a specific model unless clearly confirmed. Lower confidence.
- Generic items (plain hoodie, random mug, basic phone case): usually query null unless text/branding exists.
- If the photo contains a tag/label that is readable: prefer the tag text over silhouette guessing.

CONFIDENCE SCORING (0.0 to 1.0) — calibrated for a UI bar
Treat confidence as: “If a user searched this query, how likely would top results match the exact item?”

Use this scale strictly:
- 0.95–1.00: Brand + exact model clearly confirmed by readable text/logos and distinctive features.
- 0.85–0.94: Brand is confirmed; model is very likely (strong distinctive cues) but not fully readable.
- 0.70–0.84: Brand likely (some evidence); product line/type clear; exact model uncertain.
- 0.50–0.69: Product type clear (e.g., headphones, sneakers), but brand/model not reliably supported.
- 0.30–0.49: Only broad category guessable; too risky for search query.
- 0.00–0.29: Insufficient clarity → query MUST be null.

CRITICAL RULE:
If confidence < 0.40, "query" MUST be null.

OUTPUT REQUIREMENTS
Return ONLY the JSON object.
- "query": a single string or null
- "confidence": a number between 0 and 1 (decimals allowed)

VALID OUTPUT EXAMPLES (format only)
{"query":"Apple AirPods Pro 2nd generation","confidence":0.93}
{"query":"Nike Air Force 1 Low white sneakers","confidence":0.84}
{"query":null,"confidence":0.22}

Now analyze the image and return ONLY the JSON object.
`.trim();

      const timeout = withTimeout(9000); // ⏱ Vision timeout

      const response = await client.responses.create(
        {
          model: "gpt-4.1",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: prompt },
                { type: "input_image", image_url: dataUrl },
              ],
            },
          ],
        },
        { signal: timeout.signal }
      );

      timeout.cancel();

      const text = response.output_text || "";
      let parsed = null;

      try {
        parsed = JSON.parse(text);
      } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          try {
            parsed = JSON.parse(match[0]);
          } catch {}
        }
      }

      let query =
        typeof parsed?.query === "string" && parsed.query.trim()
          ? parsed.query.trim()
          : null;

      let confidence =
        typeof parsed?.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0;

      // ---- confidence calibration (UI-safe) ----
      if (confidence < 0.4) query = null;
      if (!query) confidence = Math.min(confidence, 0.39);

      const result = { ok: true, query, confidence };
      visionCache.set(imageHash, result);

      console.log("✅ VISION RESULT:", result);
      return res.status(200).json(result);
    } catch (err) {
      if (err?.name === "AbortError") {
        console.warn("⏱ Vision timeout");
      } else {
        console.error("❌ VISION ERROR:", err);
      }

      return res.status(200).json({
        ok: true,
        query: null,
        confidence: 0,
        reason: "vision_exception",
      });
    }
  }
);

/* -------------------- SERP SEARCH (GET) -------------------- */
app.get("/search/serp", async (req, res) => {
const query = typeof req.query?.q === "string" ? req.query.q.trim() : "";
// 🧠 SERP cache check (5 min TTL)
const cached = SERP_CACHE.get(query);
if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
  console.log("🧠 SERP CACHE HIT:", query);
  return res.status(200).json(cached.items);
}

  try {
    const SERPAPI_KEY = process.env.SERPAPI_KEY;

    if (!query || !SERPAPI_KEY) return res.status(200).json([]);

const serpController = new AbortController();
const serpTimeout = setTimeout(() => serpController.abort(), 7000);

    const params = new URLSearchParams({
      engine: "google_shopping",
      q: query,
      hl: "en",
      gl: "us",
      api_key: SERPAPI_KEY,
    });

    const url = `https://serpapi.com/search.json?${params.toString()}`;
const r = await fetch(url, { signal: serpController.signal });
clearTimeout(serpTimeout);

    const data = await r.json();

    const raw = [
      ...(data.shopping_results || []),
      ...(data.inline_shopping_results || []),
    ];

    const items = raw.map(normalizeItem).filter((x) => x.title && x.link);
    const cheapest = sortCheapest(items);
// 💾 write SERP cache
SERP_CACHE.set(query, {
  items: cheapest,
  ts: Date.now(),
});

    return res.status(200).json(cheapest);
  } catch (e) {
    if (e?.name === "AbortError") {
      console.warn("⏱ Serp timeout");
    } else {
      console.error("SEARCH SERP ERROR:", e);
    }
    return res.status(200).json([]);
  }
});

/* -------------------- EBAY STUB -------------------- */
app.get("/search/ebay", async (_req, res) => {
  return res.status(200).json([]);
});

/* -------------------- MARKET SEARCH (POST) -------------------- */
app.post("/market/search", async (req, res) => {
  try {
    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    const query =
      typeof req.body?.query === "string" ? req.body.query.trim() : "";

    if (!query)
      return res.status(400).json({ ok: false, error: "Missing query" });

 if (!SERPAPI_KEY) {
  return res.status(200).json({
    ok: true,
    query,
    items: [],
    top3: [],
    reason: "missing_serpapi_key",
  });
}
    const params = new URLSearchParams({
      engine: "google_shopping",
      q: query,
      hl: "en",
      gl: "us",
      api_key: SERPAPI_KEY,
    });

    const r = await fetch(
      `https://serpapi.com/search.json?${params.toString()}`
    );
    const data = await r.json();

    const raw = [
      ...(data.shopping_results || []),
      ...(data.inline_shopping_results || []),
    ];

    const items = raw.map(normalizeItem).filter((x) => x.title && x.link);
    const cheapest = sortCheapest(items);

    return res.status(200).json({
      ok: true,
      query,
      items: cheapest,
      top3: cheapest.slice(0, 3),
    });
  } catch (err) {
    console.error("MARKET SEARCH ERROR:", err);
    return res.status(500).json({ ok: false, error: "market_search_failed" });
  }
});

/* -------------------- start -------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ evan-ai-server running on http://0.0.0.0:${PORT}`);
});

