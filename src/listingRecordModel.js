// src/listingRecordModel.js
// Phase 10 — Listing Record Model.
//
// A listing record represents a single attempt to sell an inventory item
// on a specific marketplace. One inventory item can have multiple listings
// (list on eBay, delist, relist on Poshmark, etc.).
//
// This separates "I own this item" (inventoryEngine.js) from
// "I'm trying to sell this item at this price on this platform."
//
// Status lifecycle:
//   DRAFT → ACTIVE → SOLD | ENDED | EXPIRED
//   (SOLD, ENDED, EXPIRED are terminal — no further transitions)
//
// Redis key layout:
//   p10:lst:{listingId}         STRING  full listing JSON (2yr TTL)
//   p10:lst:inv:{invId}         ZSET    listing IDs for an item (scored by listedAt, 2yr TTL)
//   p10:lst:user:{userId}       ZSET    all listing IDs for a user (scored by listedAt, 2yr TTL)
//   p10:lst:ops                 HASH    aggregate counters

import crypto from "crypto";

// ── Constants ─────────────────────────────────────────────────────────────────

const LISTING_TTL = 2 * 365 * 86400;   // 2 years
const MAX_LISTINGS_PER_USER = 20_000;

export const LISTING_STATUS = Object.freeze({
  DRAFT:   "DRAFT",
  ACTIVE:  "ACTIVE",
  SOLD:    "SOLD",
  ENDED:   "ENDED",
  EXPIRED: "EXPIRED",
});

const TERMINAL_LISTING_STATUSES = new Set([
  LISTING_STATUS.SOLD,
  LISTING_STATUS.ENDED,
  LISTING_STATUS.EXPIRED,
]);

const VALID_TRANSITIONS = {
  DRAFT:   [LISTING_STATUS.ACTIVE, LISTING_STATUS.ENDED],
  ACTIVE:  [LISTING_STATUS.SOLD, LISTING_STATUS.ENDED, LISTING_STATUS.EXPIRED],
  SOLD:    [],
  ENDED:   [],
  EXPIRED: [],
};

// Recognized marketplaces (open-ended but canonical normalized forms)
export const MARKETPLACE = Object.freeze({
  EBAY:                "ebay",
  POSHMARK:            "poshmark",
  MERCARI:             "mercari",
  DEPOP:               "depop",
  STOCKX:              "stockx",
  FACEBOOK_MARKETPLACE:"facebook_marketplace",
  VINTED:              "vinted",
  ETSY:                "etsy",
  AMAZON:              "amazon",
  OTHER:               "other",
});

// ── Redis key helpers ─────────────────────────────────────────────────────────

const KEY_LISTING = (id)          => `p10:lst:${id}`;
const KEY_INV     = (invId)       => `p10:lst:inv:${invId}`;
const KEY_USER    = (userId)      => `p10:lst:user:${userId}`;
const KEY_OPS     = ()            => `p10:lst:ops`;

// ── Create ────────────────────────────────────────────────────────────────────

/**
 * Create a new listing record linked to an inventory item.
 *
 * @param {object} redis
 * @param {object} opts
 *   userId       {string}          required
 *   invId        {string}          required — linked inventory item
 *   marketplace  {string}          required — platform (ebay, poshmark, etc.)
 *   listedPrice  {number}          required — asking price on the listing
 *   listedAt     {number|null}     ms timestamp; defaults to now
 *   listingUrl   {string|null}     URL of the live listing
 *   notes        {string|null}
 *   startDraft   {boolean}         if true, starts in DRAFT instead of ACTIVE
 * @returns {Promise<{ ok, listingId, listing, created }>}
 */
export async function createListing(redis, {
  userId,
  invId,
  marketplace,
  listedPrice,
  listedAt    = null,
  listingUrl  = null,
  notes       = null,
  startDraft  = false,
} = {}) {
  if (!redis)      return { ok: false, error: "no_redis" };
  if (!userId)     return { ok: false, error: "missing_user_id" };
  if (!invId)      return { ok: false, error: "missing_inv_id" };
  if (!marketplace) return { ok: false, error: "missing_marketplace" };

  const lp = finitePositive(listedPrice);
  if (lp === null) return { ok: false, error: "invalid_listed_price" };

  try {
    const listingId = _genListingId();
    const now       = Date.now();
    const tsListed  = listedAt != null ? Number(listedAt) : now;
    const mkt       = normStr(marketplace) || MARKETPLACE.OTHER;
    const status    = startDraft ? LISTING_STATUS.DRAFT : LISTING_STATUS.ACTIVE;

    const listing = {
      listingId,
      userId,
      invId,
      marketplace:  mkt,
      listedPrice:  lp,
      listedAt:     tsListed,
      listingUrl:   listingUrl ? String(listingUrl).slice(0, 2000) : null,
      status,
      // Sale outcome — populated when sold
      soldAt:        null,
      soldPrice:     null,
      fees:          null,       // platform fees paid (REALIZED)
      feesEstimated: null,       // platform fee estimate (if actual not provided)
      shippingCost:  null,
      netProceeds:   null,       // soldPrice - fees - shippingCost (REALIZED)
      // Metadata
      endReason:    null,        // for ENDED or EXPIRED
      notes:        notes ? String(notes).slice(0, 1000) : null,
      editHistory:  [],
      createdAt:    now,
      updatedAt:    now,
    };

    const pipe = redis.pipeline();
    pipe.set(KEY_LISTING(listingId), JSON.stringify(listing), "EX", LISTING_TTL);
    pipe.zadd(KEY_INV(invId), tsListed, listingId);
    pipe.zadd(KEY_USER(userId), tsListed, listingId);
    pipe.zremrangebyrank(KEY_USER(userId), 0, -(MAX_LISTINGS_PER_USER + 1));
    pipe.expire(KEY_INV(invId), LISTING_TTL);
    pipe.expire(KEY_USER(userId), LISTING_TTL);
    pipe.hincrby(KEY_OPS(), "total_created", 1);
    pipe.hincrby(KEY_OPS(), `status_${status.toLowerCase()}`, 1);
    await pipe.exec();

    return { ok: true, listingId, listing, created: true };
  } catch (err) {
    return { ok: false, error: "listing_create_failed", reason: err?.message };
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getListing(redis, listingId) {
  if (!redis || !listingId) return null;
  try {
    const raw = await redis.get(KEY_LISTING(listingId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * Get all listing IDs for an inventory item.
 */
export async function getListingsForItem(redis, invId, { limit = 50 } = {}) {
  if (!redis || !invId) return [];
  try {
    const ids = await redis.zrevrangebyscore(KEY_INV(invId), "+inf", "-inf", "LIMIT", 0, limit);
    if (!ids?.length) return [];
    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_LISTING(id));
    const results = await pipe.exec();
    return results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Get listings for a user with optional status filter.
 */
export async function getUserListings(redis, userId, {
  status  = null,
  limit   = 50,
  offset  = 0,
  since   = null,
  until   = null,
} = {}) {
  if (!redis || !userId) return { listings: [], total: 0 };
  try {
    const lo = since != null ? Number(since) : "-inf";
    const hi = until != null ? Number(until) : "+inf";
    const maxLimit = Math.min(limit, 200);

    const [ids, total] = await Promise.all([
      redis.zrevrangebyscore(KEY_USER(userId), hi, lo, "LIMIT", offset, maxLimit),
      redis.zcard(KEY_USER(userId)),
    ]);

    if (!ids?.length) return { listings: [], total };

    const pipe = redis.pipeline();
    for (const id of ids) pipe.get(KEY_LISTING(id));
    const results = await pipe.exec();

    const all = results
      .map(([, raw]) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } })
      .filter(Boolean);

    const filtered = status ? all.filter(l => l.status === status) : all;
    return { listings: filtered, total };
  } catch { return { listings: [], total: 0 }; }
}

// ── Status Transitions ────────────────────────────────────────────────────────

/**
 * Activate a DRAFT listing — make it live.
 */
export async function activateListing(redis, listingId, {
  listingUrl  = null,
  listedAt    = null,
} = {}) {
  return _transition(redis, listingId, LISTING_STATUS.DRAFT, LISTING_STATUS.ACTIVE, (listing) => {
    if (listingUrl) listing.listingUrl = String(listingUrl).slice(0, 2000);
    if (listedAt != null) listing.listedAt = Number(listedAt);
  });
}

/**
 * Mark a listing as SOLD.
 * Computes netProceeds = soldPrice - fees - shippingCost.
 *
 * @param {string} listingId
 * @param {object} opts
 *   soldPrice    {number}  required
 *   fees         {number|null}  actual platform fees (REALIZED)
 *   shippingCost {number|null}
 *   soldAt       {number|null}  ms timestamp
 */
export async function markListingSold(redis, listingId, {
  soldPrice,
  fees         = null,
  shippingCost = null,
  soldAt       = null,
} = {}) {
  const sp = finitePositive(soldPrice);
  if (sp === null) return { ok: false, error: "invalid_sold_price" };

  return _transition(redis, listingId, LISTING_STATUS.ACTIVE, LISTING_STATUS.SOLD, (listing) => {
    const feesVal  = finiteNonNeg(fees)        ?? null;
    const shipVal  = finiteNonNeg(shippingCost) ?? null;
    const net      = sp - (feesVal ?? 0) - (shipVal ?? 0);

    listing.soldPrice    = sp;
    listing.soldAt       = soldAt != null ? Number(soldAt) : Date.now();
    listing.fees         = feesVal;
    listing.shippingCost = shipVal;
    listing.netProceeds  = r2(net);
  }, (listing) => {
    redis.hincrby(KEY_OPS(), "total_sold", 1);
  });
}

/**
 * End a listing manually (took it down, relisted elsewhere, etc.)
 */
export async function endListing(redis, listingId, { reason = null } = {}) {
  return _transition(redis, listingId, LISTING_STATUS.ACTIVE, LISTING_STATUS.ENDED, (listing) => {
    listing.endReason = reason ? String(reason).slice(0, 200) : "manual_end";
  });
}

/**
 * Expire a listing (auto-expired by marketplace).
 */
export async function expireListing(redis, listingId) {
  return _transition(redis, listingId, LISTING_STATUS.ACTIVE, LISTING_STATUS.EXPIRED, (listing) => {
    listing.endReason = "expired";
  });
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Get aggregate listing metrics for a user.
 * Scans all user listings to compute sell-through, revenue, fees.
 */
export async function getListingMetrics(redis, userId, { since = null, until = null } = {}) {
  if (!redis || !userId) return _emptyMetrics();
  try {
    const { listings } = await getUserListings(redis, userId, {
      limit: MAX_LISTINGS_PER_USER, since, until,
    });

    let totalListings = 0, totalActive = 0, totalSold = 0, totalEnded = 0, totalExpired = 0;
    let totalRevenue = 0, totalFees = 0, totalNetProceeds = 0;
    const mktMap = {};

    for (const l of listings) {
      totalListings++;
      switch (l.status) {
        case LISTING_STATUS.ACTIVE:  totalActive++;  break;
        case LISTING_STATUS.ENDED:   totalEnded++;   break;
        case LISTING_STATUS.EXPIRED: totalExpired++; break;
        case LISTING_STATUS.SOLD:
          totalSold++;
          totalRevenue    += l.soldPrice  || 0;
          totalFees       += l.fees       || 0;
          totalNetProceeds += l.netProceeds ?? 0;
          const mkt = l.marketplace || "other";
          if (!mktMap[mkt]) mktMap[mkt] = { sold: 0, revenue: 0, fees: 0, net: 0 };
          mktMap[mkt].sold++;
          mktMap[mkt].revenue += l.soldPrice  || 0;
          mktMap[mkt].fees    += l.fees       || 0;
          mktMap[mkt].net     += l.netProceeds ?? 0;
          break;
      }
    }

    return {
      totalListings,
      totalActive,
      totalSold,
      totalEnded,
      totalExpired,
      sellThroughRate: totalListings > 0 ? r2((totalSold / totalListings) * 100) : null,
      totalRevenue:     r2(totalRevenue),
      totalFees:        r2(totalFees),
      totalNetProceeds: r2(totalNetProceeds),
      avgFeeRate: totalRevenue > 0 ? r2((totalFees / totalRevenue) * 100) : null,
      marketplaceBreakdown: Object.entries(mktMap).map(([mkt, s]) => ({
        marketplace: mkt,
        sold:        s.sold,
        revenue:     r2(s.revenue),
        fees:        r2(s.fees),
        netProceeds: r2(s.net),
        avgFeeRate:  s.revenue > 0 ? r2((s.fees / s.revenue) * 100) : null,
      })).sort((a, b) => b.netProceeds - a.netProceeds),
    };
  } catch { return _emptyMetrics(); }
}

/**
 * Aggregate listing ops counters.
 */
export async function getListingOps(redis) {
  if (!redis) return {};
  try {
    const raw = await redis.hgetall(KEY_OPS());
    const ops = {};
    for (const [k, v] of Object.entries(raw || {})) ops[k] = Number(v) || 0;
    return {
      totalCreated: ops["total_created"] || 0,
      totalSold:    ops["total_sold"]    || 0,
    };
  } catch { return {}; }
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _transition(redis, listingId, fromStatus, toStatus, mutate, postMutate = null) {
  if (!redis || !listingId) return { ok: false, error: "missing_listing_id" };

  try {
    const listing = await getListing(redis, listingId);
    if (!listing) return { ok: false, error: "listing_not_found" };

    const allowed = VALID_TRANSITIONS[listing.status] || [];
    if (!allowed.includes(toStatus)) {
      return {
        ok: false, error: "invalid_transition",
        from: listing.status, to: toStatus,
        allowed: VALID_TRANSITIONS[listing.status],
      };
    }

    const now = Date.now();
    listing.editHistory = [...(listing.editHistory || []).slice(-19), {
      at: now, changes: { status: { from: listing.status, to: toStatus } },
    }];
    listing.status    = toStatus;
    listing.updatedAt = now;

    if (mutate) mutate(listing);

    await redis.set(KEY_LISTING(listingId), JSON.stringify(listing), "EX", LISTING_TTL);
    if (postMutate) postMutate(listing);

    return { ok: true, listing };
  } catch (err) {
    return { ok: false, error: "listing_transition_failed", reason: err?.message };
  }
}

function _genListingId() {
  return "lst_" + crypto.randomBytes(8).toString("hex");
}

function _emptyMetrics() {
  return {
    totalListings: 0, totalActive: 0, totalSold: 0, totalEnded: 0, totalExpired: 0,
    sellThroughRate: null, totalRevenue: 0, totalFees: 0, totalNetProceeds: 0,
    avgFeeRate: null, marketplaceBreakdown: [],
  };
}

function normStr(v) {
  if (!v) return null;
  return String(v).trim().toLowerCase().replace(/\s+/g, "_").slice(0, 80);
}

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteNonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}
