// index.js — Evan AI Backend (ESM)
// ✅ /scan (Vision + Listings + Savings) + monthly scan limits + caching
// Works on Render AND locally

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
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 7);

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const SERPAPI_KEY = (process.env.SERPAPI_KEY || "").trim();

const HAS_OPENAI = !!OPENAI_API_KEY;
const HAS_SERPAPI = !!SERPAPI_KEY;

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(cors({ origin: "*" }));

app.use((req, res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

const openai = HAS_OPENAI ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// -------------------------
// Helpers
// -------------------------
function normalizeBase64(input) {
  if (!input || typeof input !== "string") return "";
  const trimmed = input.trim();

  // If client accidentally sends a data URL: data:image/jpeg;base64,...
  const idx = trimmed.indexOf("base64,");
  if (idx !== -1) return trimmed.slice(idx + "base64,".length).trim();

  return trimmed;
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function parsePriceToNumber(p) {
  if (!p) return null;
  const n = Number(String(p).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function monthKeyNow() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`; // e.g. 2026-01
}

function getDeviceId(req) {
  return (req.headers["x-device-id"] || "anon").toString().trim() || "anon";
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s === -1 || e === -1 || e <= s) return null;
  const candidate = text.slice(s, e + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// -------------------------
// Monthly usage (in-memory dev)
// deviceId -> { monthKey: "YYYY-MM", used: number }
// -------------------------
const usageByDevice = new Map();

function getUsage(deviceId) {
  const mk = monthKeyNow();
  const row = usageByDevice.get(deviceId);

  if (!row || row.monthKey !== mk) {
    usageByDevice.set(deviceId, { monthKey: mk, used: 0 });
    return 0;
  }
  return Number(row.used || 0);
}

function bumpUsage(deviceId) {
  const mk = monthKeyNow();
  const row = usageByDevice.get(deviceId);

  if (!row || row.monthKey !== mk) {
    const next = 1;
    usageByDevice.set(deviceId, { monthKey: mk, used: next });
    return next;
  }

  const next = Number(row.used || 0) + 1;
  usageByDevice.set(deviceId, { monthKey: mk, used: next });
  return next;
}

// -------------------------
// Cache (image hash -> payload)
// -------------------------
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

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

app.post("/scan", async (req, res) => {
  const deviceId = getDeviceId(req);
  const usedBefore = getUsage(deviceId);

  // Validate image (DO NOT charge user if payload is invalid)
  const imageBase64 = normalizeBase64(req.body?.imageBase64);
  if (!imageBase64 || imageBase64.length < 200) {
    return res.status(400).json({
      ok: false,
      cached: false,
      deviceId,
      used: usedBefore,
      free_limit: FREE_LIMIT,
      remaining: Math.max(0, FREE_LIMIT - usedBefore),
      error: "Missing/invalid imageBase64 (send raw base64 string)",
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

  // Enforce monthly free limit
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

  // Count this scan attempt now that payload is valid
  const used = bumpUsage(deviceId);

  // Cache by image hash
  const cacheKey = sha256(imageBase64);
  const cachedPayload = getCache(cacheKey);
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

  let note = "";

  // -------------------------
  // 🧠 Vision (OpenAI) — Responses API with base64
  // -------------------------
  let visionResult = {
    item_name: "Unknown item",
    confidence: 0, // 0–100
    search_query: "unknown product",
  };

  if (!openai) {
    note = "OpenAI key missing";
  } else {
    try {
      const prompt = `
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

      const resp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_base64: imageBase64 },
            ],
          },
        ],
      });

      const raw = resp.output_text || resp.output?.[0]?.content?.[0]?.text || "";
      const parsed = extractJson(raw);

      if (parsed) {
        const conf01 = Number(parsed.confidence ?? 0);
        const confPct = Math.max(0, Math.min(100, Math.round(conf01 * 100)));

        visionResult = {
          item_name: String(parsed.item_name || "Unknown item").trim(),
          confidence: confPct,
          search_query: String(
            parsed.search_query || parsed.item_name || "unknown product"
          ).trim(),
        };
      } else {
        note = "Vision returned non-JSON";
      }
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const msg = err?.message || err?.error?.message || "OpenAI request failed";
      note = `OpenAI error${status ? " " + status : ""}: ${msg}`;
      console.error("OpenAI error:", status, msg);
    }
  }

  // -------------------------
  // 🛒 SerpAPI Listings (Google Shopping)
  // -------------------------
  let listings = [];
  let prices = [];

  if (!SERPAPI_KEY) {
    note = note || "SerpAPI key missing";
  } else {
    try {
      const serpUrl = `https://serpapi.com/search.json?engine=google_shopping&q=${encodeURIComponent(
        visionResult.search_query
      )}&hl=en&gl=us&api_key=${SERPAPI_KEY}`;

      const serpRes = await fetch(serpUrl);
      const serpData = await serpRes.json();

      if (Array.isArray(serpData.shopping_results)) {
        listings = serpData.shopping_results.slice(0, 8).map((item) => {
          const priceNum = parsePriceToNumber(item.price);
          if (priceNum !== null) prices.push(priceNum);

          // ✅ IMPORTANT: Prefer product_link (product page) over link (more "search-ish")
          const productUrl =
            item.product_link ||
            item.link ||
            item.offer_link ||
            item.merchant_link ||
            "";

          return {
            title: item.title || "Item",
            price: priceNum,
            price_text: item.price || "",
            store: item.source || item.seller || "Store",
            url: productUrl,
            image: item.thumbnail || item.thumbnail_url || null,
          };
        });
      } else {
        note = note || "No shopping_results from SerpAPI";
      }
    } catch (err) {
      const msg = err?.message || "SerpAPI request failed";
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

app.listen(PORT, () => {
  console.log(`🚀 Evan AI backend running on http://localhost:${PORT}`);
});
