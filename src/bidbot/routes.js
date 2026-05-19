/**
 * routes.js — Bid-Bot API routes
 *
 * Mount in index.js:
 *   import { bidBotRouter } from "./src/bidbot/routes.js";
 *   app.use("/api/bidbot", bidBotRouter);
 *
 * Routes:
 *   POST /api/bidbot/connect          — OAuth callback → store token
 *   DELETE /api/bidbot/disconnect     — Revoke all tokens (kill switch)
 *   GET  /api/bidbot/status           — Connection status + rate limit usage
 *   POST /api/bidbot/bid              — Dispatch a single bid
 *   GET  /api/bidbot/audit            — Internal audit log (admin-only)
 */

import express from "express";
import {
  handleOAuthCallback,
  getTokenStatus,
  revokeAllTokens,
} from "../vault.js";
import { dispatchBid, getCapitalExposure } from "./dispatcher.js";
import { rateLimiter } from "./rateLimiter.js";
import { _getInternalAudit } from "./ironShield.js";

export const bidBotRouter = express.Router();

// ─── Middleware: require auth ─────────────────────────────────────────────────
// Replace with your actual auth middleware (JWT verify, session check, etc.)
function requireAuth(req, res, next) {
  const userId = req.headers["x-user-id"] || req.body?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

// ─── OAuth Connect ────────────────────────────────────────────────────────────
// Called after OAuth code exchange on your server. The raw access token
// arrives here and immediately enters the vault — it never touches the frontend.
bidBotRouter.post("/connect", requireAuth, (req, res) => {
  const { platform, accessToken, handle } = req.body;

  if (!platform || !accessToken) {
    return res.status(400).json({ error: "platform and accessToken required" });
  }

  try {
    const record = handleOAuthCallback(req.userId, platform, accessToken, handle);
    // Return ONLY safe fields — no token, no encrypted data
    res.json({
      connected: record.connected,
      platform: record.platform,
      handle: record.handle,
      ref: record.ref,
    });
  } catch (err) {
    res.status(500).json({ error: "Connection failed" });
  }
});

// ─── Kill Switch: Revoke All ──────────────────────────────────────────────────
// User hits "Disconnect all accounts" — wipes all tokens, forensic deletion.
bidBotRouter.delete("/disconnect", requireAuth, (req, res) => {
  const { revoked } = revokeAllTokens(req.userId);
  res.json({ disconnected: true, tokensRevoked: revoked });
});

// ─── Status ───────────────────────────────────────────────────────────────────
bidBotRouter.get("/status", requireAuth, (req, res) => {
  const { ref, platform = "ebay" } = req.query;
  const tokenStatus = ref ? getTokenStatus(ref) : null;
  const usage = rateLimiter.usage(req.userId, platform);
  const capital = getCapitalExposure(req.userId);

  res.json({
    connected: tokenStatus?.connected ?? false,
    platform: tokenStatus?.platform ?? null,
    handle: tokenStatus?.handle ?? null,
    usage,
    capital,
  });
});

// ─── Bid Dispatch ─────────────────────────────────────────────────────────────
bidBotRouter.post("/bid", requireAuth, async (req, res) => {
  const { opportunity, profile } = req.body;

  if (!opportunity || !profile) {
    return res.status(400).json({ error: "opportunity and profile required" });
  }

  const result = await dispatchBid(req.userId, opportunity, profile);

  // Result is already opaque-safe from withIronShield
  // { ok: true, bidId, offerPrice, acceptancePct } or { ok: false, code: "BID_ERR_XX" }
  res.json(result);
});

// ─── Internal Audit (admin only) ─────────────────────────────────────────────
// IMPORTANT: Protect this route with strict IP allowlist or admin token
// in production. Never expose this publicly.
bidBotRouter.get("/audit", (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_AUDIT_KEY) {
    // Return 404 (not 401) — don't reveal the route exists
    return res.status(404).send("Not Found");
  }

  const limit = parseInt(req.query.limit) || 100;
  res.json({ entries: _getInternalAudit(limit) });
});
