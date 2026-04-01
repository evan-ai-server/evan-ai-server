// src/affiliateRouter.js
// Affiliate Router — Phase 14: Money Engine.
//
// Attaches affiliate tracking tags to listing URLs AFTER all signal computation
// and plan gating are complete. Signal truth is immutable — this module never
// touches buySignal, price rankings, or item ordering.
//
// Supported programs:
//   EBAY_EPN     — eBay Partner Network (rover.ebay.com redirect)
//   AMAZON_ASSOC — Amazon Associates (tag= query param)
//
// Environment variables required (set via Railway / .env):
//   EBAY_EPN_CAMPAIGN_ID   — your eBay EPN campaign ID
//   EBAY_EPN_PARTNER_ID    — your eBay EPN partner ID (optional, improves tracking)
//   AMAZON_ASSOCIATE_TAG   — your Amazon Associates tag (e.g. "evan-20")
//
// Every affiliate-linked payload includes `affiliateDisclosure` so the UI
// can render "Affiliate link" labels transparently. Non-negotiable.
//
// Redis keys:
//   aff:click:{userId}:{scanId}   STRING  click record (7d TTL)

const EBAY_ROVER_BASE = "https://rover.ebay.com/rover/1/711-53200-19255-0/1";

// Program configs — read env vars at startup
const PROGRAMS = {
  ebay_epn: {
    id:         "ebay_epn",
    name:       "eBay Partner Network",
    campaignId: process.env.EBAY_EPN_CAMPAIGN_ID  || null,
    partnerId:  process.env.EBAY_EPN_PARTNER_ID   || null,
    domains:    ["ebay.com", "ebay.co.uk", "ebay.de", "ebay.com.au", "ebay.ca"],
    get enabled() { return !!this.campaignId; },
  },
  amazon_assoc: {
    id:         "amazon_assoc",
    name:       "Amazon Associates",
    tag:        process.env.AMAZON_ASSOCIATE_TAG  || null,
    domains:    ["amazon.com", "amazon.co.uk", "amazon.ca", "amazon.com.au"],
    get enabled() { return !!this.tag; },
  },
};

export const AFFILIATE_DISCLOSURE =
  "Some links may earn Evan a small commission at no cost to you. " +
  "Deal signals are computed independently — affiliate relationships never influence rankings.";

const CLICK_TTL = 7 * 86400; // 7 days

// ── URL helpers ────────────────────────────────────────────────────────────────

/**
 * Detect which affiliate program applies to a URL.
 * Returns the program config or null if no match or program not enabled.
 */
function detectProgram(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const prog of Object.values(PROGRAMS)) {
      if (!prog.enabled) continue;
      if (prog.domains.some((d) => host === d || host.endsWith(`.${d}`))) return prog;
    }
  } catch { /* invalid URL */ }
  return null;
}

/**
 * Build an affiliate-tracked URL for a known program.
 * Returns the original URL if the program is disabled or URL construction fails.
 *
 * CRITICAL: This only appends tracking parameters — item identity and ordering
 * are determined entirely by signal computation, never by this function.
 */
export function buildAffiliateUrl(rawUrl, program) {
  if (!rawUrl || !program?.enabled) return rawUrl;
  try {
    if (program.id === "ebay_epn") {
      // eBay Partner Network rover redirect
      const mpre = encodeURIComponent(rawUrl);
      let rover = `${EBAY_ROVER_BASE}?icep_id=114&ipn=icep&toolid=20004&campid=${program.campaignId}&mpre=${mpre}`;
      if (program.partnerId) rover += `&customid=${program.partnerId}`;
      return rover;
    }
    if (program.id === "amazon_assoc") {
      const u = new URL(rawUrl);
      u.searchParams.set("tag", program.tag);
      return u.toString();
    }
  } catch { /* fall through */ }
  return rawUrl;
}

/**
 * Tag a single URL with affiliate tracking.
 * Returns { url, isAffiliate, affiliateProgram, _originalUrl } or the original item if no match.
 */
export function tagUrl(rawUrl) {
  const program = detectProgram(rawUrl);
  if (!program) return { url: rawUrl, isAffiliate: false };
  const affiliateUrl = buildAffiliateUrl(rawUrl, program);
  if (affiliateUrl === rawUrl) return { url: rawUrl, isAffiliate: false };
  return {
    url:              affiliateUrl,
    isAffiliate:      true,
    affiliateProgram: program.name,
    _originalUrl:     rawUrl,
  };
}

// ── Payload attachment ─────────────────────────────────────────────────────────

/**
 * Attach affiliate links to an array of listing items.
 * NEVER reorders or filters items — only appends tracking to matching URLs.
 *
 * @param {object[]} items
 * @returns {{ items: object[], hasAffiliateLinks: boolean }}
 */
export function attachAffiliateLinksToItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: items || [], hasAffiliateLinks: false };
  }

  let hasAffiliateLinks = false;
  const tagged = items.map((item) => {
    const rawUrl = item.url || item.link || item.listingUrl || null;
    if (!rawUrl) return item;
    const { url, isAffiliate, affiliateProgram, _originalUrl } = tagUrl(rawUrl);
    if (!isAffiliate) return item;
    hasAffiliateLinks = true;
    return {
      ...item,
      url,
      isAffiliate: true,
      affiliateProgram,
      _originalUrl,
    };
  });

  return { items: tagged, hasAffiliateLinks };
}

/**
 * Apply affiliate routing to a complete scan payload.
 * Runs LAST — after signal computation, plan gating, and all other logic.
 *
 * @param {object} payload  — scan response (mutated in place)
 * @returns {object} payload
 */
export function attachAffiliateLinksToPayload(payload) {
  if (!payload?.profitIntel?.items?.length) return payload;

  const { items: taggedItems, hasAffiliateLinks } =
    attachAffiliateLinksToItems(payload.profitIntel.items);

  payload.profitIntel = { ...payload.profitIntel, items: taggedItems };

  if (hasAffiliateLinks) {
    payload.affiliateDisclosure = AFFILIATE_DISCLOSURE;
  }

  return payload;
}

// ── Click recording ────────────────────────────────────────────────────────────

/**
 * Record an affiliate link click into Redis.
 * Non-blocking — called from POST /attribution/click after client taps a listing.
 */
export async function recordAffiliateClick(redis, userId, {
  scanId   = null,
  source   = null,
  category = null,
  program  = null,
  url      = null,
} = {}) {
  if (!redis || !userId) return;
  try {
    const key = `aff:click:${userId}:${scanId || "noscan"}:${Date.now()}`;
    await redis.set(key, JSON.stringify({
      userId, scanId, source, category, program, url: url?.slice(0, 500), at: Date.now(),
    }), "EX", CLICK_TTL);
  } catch { /* non-fatal */ }
}

/**
 * Check whether any affiliate programs are currently configured (for ops health checks).
 */
export function getAffiliateStatus() {
  return Object.fromEntries(
    Object.values(PROGRAMS).map((p) => [p.id, { enabled: p.enabled, name: p.name }])
  );
}
