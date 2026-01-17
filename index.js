// index.js — Evan AI Backend (ESM)
// ✅ /scan: Vision (OpenAI) + Listings (SerpAPI) + Savings + Caching + Scan limits
import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

// -------------------------
// Config
// -------------------------
const PORT = Number(process.env.PORT || 3001);
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 10);

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();

const HAS_OPENAI = !!OPENAI_API_KEY;
const HAS_SERPAPI = !!SERPAPI_KEY;

// Bigger payloads for photos
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Open CORS for dev
app.use(cors({ origin: "*" }));

// Simple request logger
app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

// -------------------------
// Helpers
// -------------------------
const openai = HAS_OPENAI ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function getDeviceId(req) {
  return (req.headers["x-device-id"] || "anon").toString().trim() || "anon";
}

function parsePriceToNumber(p) {
  if (!p) return null;
  const n = Number(String(p).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Accepts either:
// 1) raw base64 string
// 2) data URL "data:image/...;base64,...."
// Returns { base64, dataUrl }
function normalizeImageInput(input) {
  if (!input || typeof input !== "string") return { base64: "", dataUrl: "" };

  const trimmed = input.trim();
  if (trimmed.startsWith("data:image/")) {
    // data URL already
    // also compute base64 by stripping prefix
    const idx = trimmed.indexOf("base64,");
    const b64 = idx !== -1 ? trimmed.slice(idx + "base64,".length).trim() : "";
    return { base64: b64, dataUrl: trimmed };
  }

  // raw base64: make it a data URL (OpenAI expects image_url to be a string URL or data URL)
  const b64 = trimmed;
  const dataUrl = `data:image/jpeg;base64,${b64}`;
  return { base64: b64, dataUrl };
}

// -------------------------
// In-memory state (dev)
// -------------------------
const usageByDevice = new Map(); // deviceId -> used count

// Cache results by image hash
const cache = new Map(); // key -> { expiresAt, payload }
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

function getUsage(deviceId) {
  return Number(usageByDevice.get(deviceId) || 0);
}

function bumpUsage(deviceId) {
  const next = getUsage(deviceId) + 1;
  usageByDevice.set(deviceId, next);
  return next;
}

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function setCache(key, payload) {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, payload });
}

// -------------------------
// Routes
// -------------------------
app.get("/", (req, res) => {
  res.json({ ok: true, status: "backend alive" });
});

app.get("/debug/ping", (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    has_openai: HAS_OPENAI,
    has_serpapi: HAS_SERPAPI,
    has_ebay: false,
    free_limit: FREE_LIMIT,
  });
});

// Main endpoint UI should call
app.post("/scan", async (req, res) => {
  const deviceId = getDeviceId(req);

  // Enforce free limit (dev)
  const usedBefore = getUsage(deviceId);
  if (usedBefore >= FREE_LIMIT) {
    return res.status(429).json({
      ok: false,
      cached: false,
      deviceId,
      used: usedBefore,
      free_limit: FREE_LIMIT,
      remaining: 0,
      error: "Free scan limit reached",
      item_name: "Limit reached",
      confidence: 0,
      note: "Upgrade required",
      listings: [],
      savings: {
        best_price: null,
        avg_price: null,
        savings: null,
        savings_pct: null,
      },
    });
  }

  // Validate image
  const imageBase64Raw = req.body?.imageBase64;
  const { base64, dataUrl } = normalizeImageInput(imageBase64Raw);

  if (!base64 || base64.length < 50) {
    const used = bumpUsage(deviceId);
    return res.status(400).json({
      ok: false,
      cached: false,
      deviceId,
      used,
      free_limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used),
      error: "Missing/invalid imageBase64 (send a real base64 string)",
      item_name: "Unknown item",
      confidence: 0,
      note: "Bad image payload",
      listings: [],
      savings: {
        best_price: null,
        avg_price: null,
        savings: null,
        savings_pct: null,
      },
    });
  }

  // Cache key based on base64
  const cacheKey = sha256(base64);
  const cachedPayload = getCache(cacheKey);

  const used = bumpUsage(deviceId);

  if (cachedPayload) {
    return res.json({
      ...cachedPayload,
      ok: true,
      cached: true,
      deviceId,
      used,
      free_limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - used),
    });
  }

  // -------------------------
  // 🧠 OpenAI Vision (FIXED)
  // -------------------------
  let visionResult = {
    item_name: "Unknown item",
    confidence: 0, // percent 0-100
    search_query: "unknown product",
  };

  let note = "";

  if (!openai) {
    note = "OpenAI missing key";
  } else {
    try {
      const visionPrompt = `
You are a product identification AI.

Given an image, identify the product clearly and concisely.

Return JSON ONLY with this exact schema:
{
  "item_name": string,
  "brand": string | null,
  "category": string,
  "attributes": string[],
  "confidence": number,
  "search_query": string
}

Rules:
- item_name must be consumer-facing (what someone would say)
- confidence is 0–1
- search_query must be optimized for Google Shopping
- If unsure, still guess reasonably
`;

      // IMPORTANT:
      // input_image uses image_url: STRING (URL or data URL), NOT an object. :contentReference[oaicite:1]{index=1}
      const visionResponse = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: visionPrompt },
              { type: "input_image", image_url: dataUrl },
            ],
          },
        ],
      });

      const rawText =
        visionResponse.output_text ||
        visionResponse.output?.[0]?.content?.[0]?.text ||
        "";

      // Guard JSON extraction
      const jsonStart = rawText.indexOf("{");
      const jsonEnd = rawText.lastIndexOf("}");
      const jsonText =
        jsonStart !== -1 && jsonEnd !== -1
          ? rawText.slice(jsonStart, jsonEnd + 1)
          : rawText;

      const parsed = JSON.parse(jsonText);

      const conf01 = Number(parsed.confidence || 0);
      const confPct = Math.max(0, Math.min(100, Math.round(conf01 * 100)));

      visionResult = {
        item_name: (parsed.item_name || "Unknown item").toString().trim(),
        confidence: confPct,
        search_query: (parsed.search_query ||
          parsed.item_name ||
          "unknown product")
          .toString()
          .trim(),
      };
    } catch (err) {
      const msg =
        err?.message ||
        err?.error?.message ||
        (typeof err === "string" ? err : "OpenAI error");

      const status = err?.status || err?.response?.status;
      note = `OpenAI error${status ? " " + status : ""}: ${msg}`;
      console.error("OpenAI error:", status, msg);
    }
  }

  // -------------------------
  // 🛒 SerpAPI Listings
  // -------------------------
  let listings = [];
  let prices = [];

  if (!SERPAPI_KEY) {
    note = note || "SerpAPI missing key";
  } else {
    try {
      const url = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(
        visionResult.search_query
      )}&hl=en&gl=us&api_key=${SERPAPI_KEY}`;

      const serpRes = await fetch(url);
      const serpData = await serpRes.json();

      if (Array.isArray(serpData.shopping_results)) {
        listings = serpData.shopping_results.slice(0, 6).map((item) => {
          const priceNum = parsePriceToNumber(item.price);
          if (priceNum !== null) prices.push(priceNum);

          return {
            title: item.title || "Item",
            price: priceNum,
            store: item.source || item.seller || "Store",
            url: item.link || "",
            image: item.thumbnail || item.image || "",
          };
        });
      }
    } catch (err) {
      const msg = err?.message || "SerpAPI error";
      note = note || `SerpAPI error: ${msg}`;
      console.error("SerpAPI error:", msg);
    }
  }

  // -------------------------
  // 💰 Savings Math
  // -------------------------
  let savings = {
    best_price: null,
    avg_price: null,
    savings: null,
    savings_pct: null,
  };

  if (prices.length > 0) {
    const best = Math.min(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    savings.best_price = Number(best.toFixed(2));
    savings.avg_price = Number(avg.toFixed(2));
    savings.savings = Number((avg - best).toFixed(2));
    savings.savings_pct = Number((((avg - best) / avg) * 100).toFixed(1));
  }

  // Final response payload your UI can consume
  const payload = {
    ok: true,
    cached: false,
    deviceId,
    used,
    free_limit: FREE_LIMIT,
    remaining: Math.max(0, FREE_LIMIT - used),
    query: visionResult.search_query,
    item_name: visionResult.item_name,
    confidence: visionResult.confidence,
    note: note || "",
    listings,
    savings,
  };

  setCache(cacheKey, payload);
  return res.json(payload);
});

// -------------------------
app.listen(PORT, () => {
  console.log(`🚀 Evan AI backend running on http://localhost:${PORT}`);
});
