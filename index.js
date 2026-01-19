import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

/** -------------------------
 * Middleware
 * -------------------------- */
app.use(cors());
app.use(express.json({ limit: "15mb" })); // base64 images can be big

/** -------------------------
 * Config
 * -------------------------- */
const PORT = process.env.PORT || 3001;
const FREE_LIMIT = Number(process.env.FREE_LIMIT || 7); // change to 6 if you want

// quick visibility in logs
console.log(
  `Keys loaded: openai=${!!process.env.OPENAI_API_KEY ? "yes" : "no"}, serpapi=${
    !!process.env.SERPAPI_KEY ? "yes" : "no"
  }, etsy=${!!process.env.ETSY_API_KEY && !!process.env.ETSY_SHARED_SECRET ? "yes" : "no"}`
);

/** -------------------------
 * Routes
 * -------------------------- */
app.get("/", (req, res) => {
  res.json({ ok: true, status: "backend alive" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.get("/debug/ping", (req, res) => {
  res.json({ ok: true, pong: true, time: new Date().toISOString() });
});

/**
 * POST /scan
 * Body: { image_base64: string, deviceId?: string }
 * Returns: { ok, item_name, confidence, listings: [{title, price_text, store, url, image}] }
 */
app.post("/scan", async (req, res) => {
  try {
    const { image_base64, deviceId } = req.body || {};

    if (!image_base64 || typeof image_base64 !== "string" || image_base64.length < 50) {
      return res.status(400).json({
        ok: false,
        error: "Missing/invalid image_base64 (send a real base64 string).",
      });
    }

    // TODO: plug in your actual OpenAI Vision + SerpAPI logic here.
    // For now, this prevents "Unknown item" / empty response confusion:
    return res.json({
      ok: true,
      cached: false,
      deviceId: deviceId || "anon",
      used: 0,
      free_limit: FREE_LIMIT,
      remaining: FREE_LIMIT,
      item_name: "Item detected",
      confidence: 0.5,
      listings: [],
      note: "Scan endpoint is alive. Plug in vision + marketplace search here.",
    });
  } catch (err) {
    console.error("SCAN_ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error in /scan" });
  }
});

/** -------------------------
 * Listen (Render friendly)
 * -------------------------- */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Evan AI backend running on http://localhost:${PORT}`);
});
