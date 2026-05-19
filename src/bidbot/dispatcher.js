/**
 * dispatcher.js — Bid dispatch orchestrator
 *
 * Full flow:
 *   1. Rate limit check (abort if exceeded)
 *   2. Compute offer price via offerEngine
 *   3. Pull token from vault (ephemeral window)
 *   4. Wait humanoid delay (Gaussian jitter)
 *   5. Fire platform API with opaque UA
 *   6. Record result, release rate limit slot
 *   7. Return opaque result to caller
 *
 * All errors routed through Iron Shield — internal detail never surfaces.
 */

import crypto from "crypto";
import fetch from "node-fetch";

import { withEphemeralToken } from "../vault.js";
import { humanoidDelay, platformUserAgent } from "./humanoidDelay.js";
import { rateLimiter } from "./rateLimiter.js";
import { scoreOpportunity, computeOffer } from "./offerEngine.js";
import { withIronShield, auditBidSuccess, auditBidError, BID_ERROR_CODES } from "./ironShield.js";

// Capital reservation: tracks total USD exposure across open offers
// In production: persist to DB
const _capitalReserve = new Map(); // userId → total USD in open offers

function _getExposure(userId) { return _capitalReserve.get(userId) ?? 0; }
function _addExposure(userId, amount) {
  _capitalReserve.set(userId, _getExposure(userId) + amount);
}
function _releaseExposure(userId, amount) {
  _capitalReserve.set(userId, Math.max(0, _getExposure(userId) - amount));
}

// ─── Main Dispatch ────────────────────────────────────────────────────────────
/**
 * Dispatch a bid for an opportunity.
 *
 * @param {string} userId
 * @param {object} opp         — BidOpportunity (from Swarm output)
 * @param {object} profile     — BidProfile (user config, from DB)
 * @returns {Promise<{ ok: boolean, code?: string, bidId?: string, offerPrice?: number }>}
 */
export async function dispatchBid(userId, opp, profile) {
  const bidId = crypto.randomBytes(12).toString("hex");
  const { platform = "ebay", listingId, tokenRef } = opp;

  return withIronShield(bidId, userId, platform, async () => {

    // ── 1. Rate limit check ────────────────────────────────────────────────
    const rateCheck = rateLimiter.canDispatch(userId, platform);
    if (!rateCheck.allowed) {
      const internalCode = rateCheck.reason === "USER_HOURLY" || rateCheck.reason === "USER_DAILY"
        ? "DAILY_BID_LIMIT"
        : "PLATFORM_RATE_LIMIT";
      throw Object.assign(new Error(rateCheck.reason), { vaultCode: internalCode });
    }

    // ── 2. Capital reservation check ──────────────────────────────────────
    const { maxCapitalExposure = 500 } = profile;
    const currentExposure = _getExposure(userId);
    // Rough reserve: max buy price per opp
    if (currentExposure + opp.askingPrice > maxCapitalExposure) {
      throw Object.assign(new Error("Capital cap hit"), { vaultCode: "CAPITAL_CAP_HIT" });
    }

    // ── 3. Compute offer ──────────────────────────────────────────────────
    const calc = computeOffer(opp, profile);
    if (!calc) {
      // P(accept) too low or no valid offer — hold
      throw Object.assign(new Error("Below ROI or low P(accept)"), { vaultCode: "LOW_ACCEPTANCE_PROB" });
    }

    // ── 4. Reserve capital ────────────────────────────────────────────────
    _addExposure(userId, calc.offerPrice);

    try {
      // ── 5. Humanoid delay ──────────────────────────────────────────────
      await humanoidDelay();

      // ── 6. Dispatch via vault (ephemeral token) ────────────────────────
      let platformResult;
      await withEphemeralToken(tokenRef, async (token) => {
        platformResult = await _platformDispatch(platform, token, listingId, calc.offerPrice, bidId);
      });
      // token is null here — out of ephemeral scope

      // ── 7. Record success ──────────────────────────────────────────────
      rateLimiter.record(userId, platform);
      auditBidSuccess({ bidId, userId, platform, offerPrice: calc.offerPrice, listingId });

      return {
        bidId,
        offerPrice: calc.offerPrice,
        acceptancePct: calc.acceptancePct,
        marginAtOffer: calc.marginAtOffer,
        platformResult,
      };

    } catch (err) {
      // Release capital reserve on failure
      _releaseExposure(userId, calc.offerPrice);
      throw err;
    }
  });
}

// ─── Platform Dispatch Implementations ───────────────────────────────────────

async function _platformDispatch(platform, token, listingId, offerPrice, bidId) {
  switch (platform) {
    case "ebay":     return _dispatchEbay(token, listingId, offerPrice, bidId);
    case "poshmark": return _dispatchPoshmark(token, listingId, offerPrice, bidId);
    default:
      throw Object.assign(new Error(`Unknown platform: ${platform}`), { vaultCode: "DISPATCH_FAIL" });
  }
}

/**
 * eBay Negotiation API — officially supported endpoint.
 * Evan AI acts as the user's authorized OAuth agent, not a scraper.
 * Docs: https://developer.ebay.com/api-docs/sell/negotiation/static/overview.html
 */
async function _dispatchEbay(token, listingId, offerPrice, bidId) {
  const ua = platformUserAgent("ebay");

  const body = {
    counteredPrice: {
      currency: "USD",
      value: offerPrice.toFixed(2),
    },
    itemId: listingId,
    message: "",  // No message — blank offer looks more like a human impulse buy
  };

  const res = await fetch(
    "https://api.ebay.com/sell/negotiation/v1/send_offers",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": ua,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        "X-Request-ID": bidId,  // idempotency key
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const status = res.status;
    // Map HTTP errors to internal codes before Iron Shield catches them
    if (status === 429) throw Object.assign(new Error("eBay rate limit"), { vaultCode: "PLATFORM_RATE_LIMIT" });
    if (status === 404) throw Object.assign(new Error("Listing not found"), { vaultCode: "LISTING_GONE" });
    if (status === 409) throw Object.assign(new Error("Not eligible"), { vaultCode: "LISTING_NOT_ELIGIBLE" });
    if (status === 503) throw Object.assign(new Error("eBay down"), { vaultCode: "PLATFORM_MAINTENANCE" });
    throw Object.assign(new Error(`eBay ${status}`), { vaultCode: "DISPATCH_FAIL" });
  }

  const data = await res.json();
  return { status: "SENT", offerId: data?.offerId ?? null };
}

/**
 * Poshmark offer dispatch.
 * Poshmark's public API is limited — this uses the mobile API endpoints
 * that the official Poshmark iOS app uses (authenticated, not scraped).
 */
async function _dispatchPoshmark(token, listingId, offerPrice, bidId) {
  const ua = platformUserAgent("poshmark");

  const body = {
    offer: {
      listing_id: listingId,
      offer_price: Math.round(offerPrice * 100), // Poshmark uses cents
      currency: "USD",
    },
  };

  const res = await fetch(
    `https://poshmark.com/vm-rest/listings/${listingId}/make_offer`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": ua,
        "X-PM-Request-ID": bidId,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const status = res.status;
    if (status === 429) throw Object.assign(new Error("Poshmark rate limit"), { vaultCode: "PLATFORM_RATE_LIMIT" });
    if (status === 404) throw Object.assign(new Error("Listing not found"), { vaultCode: "LISTING_GONE" });
    throw Object.assign(new Error(`Poshmark ${status}`), { vaultCode: "DISPATCH_FAIL" });
  }

  const data = await res.json();
  return { status: "SENT", offerId: data?.data?.id ?? null };
}

// ─── Capital Exposure Accessor ────────────────────────────────────────────────
export function getCapitalExposure(userId) {
  return { totalExposure: _getExposure(userId) };
}

export function releaseCapital(userId, amount) {
  _releaseExposure(userId, amount);
}
