// src/serpapiHardening.js
//
// SerpAPI hardening layer.
//
// Single source of truth for:
//   1. Direct-merchant URL resolution (never let a Google redirect/search/aclk
//      page reach the frontend).
//   2. Listing quality scoring + filter/rank.
//   3. Stale-while-revalidate SerpAPI cache.
//   4. Market-evidence summary used by the verdict engine to cap BUY
//      confidence when SerpAPI evidence is weak.
//   5. Telemetry surfaced via /debug/serp.
//
// Designed as a leaf module: zero imports from index.js so there is no
// circular dependency. The fetcher (serpShopping / serpAmazon / …) lives in
// index.js and feeds raw items through here.

import crypto from "crypto";

// ──────────────────────────────────────────────────────────────────────────
// Tunables (env-driven so prod can tighten without a redeploy)
// ──────────────────────────────────────────────────────────────────────────
export const SERPAPI_TIMEOUT_MS       = Number(process.env.SERPAPI_TIMEOUT_MS       || 3000);
export const SERPAPI_MAX_RESULTS      = Number(process.env.SERPAPI_MAX_RESULTS      || 10);
export const SERPAPI_MIN_GOOD_RESULTS = Number(process.env.SERPAPI_MIN_GOOD_RESULTS || 3);
export const SERPAPI_CACHE_TTL_MS     = Number(process.env.SERPAPI_CACHE_TTL_MS     || 6 * 60 * 60 * 1000);
export const SERPAPI_STALE_TTL_MS     = Number(process.env.SERPAPI_STALE_TTL_MS     || 24 * 60 * 60 * 1000);

// ──────────────────────────────────────────────────────────────────────────
// URL hardening
// ──────────────────────────────────────────────────────────────────────────

const GOOGLE_HOST_PATTERNS = [
  /(^|\.)google\./i,
  /(^|\.)googleadservices\./i,
  /(^|\.)googlesyndication\./i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)doubleclick\.net$/i,
];

const REDIRECT_PARAM_KEYS = [
  "url", "u", "q", "dest", "destination",
  "adurl", "redirect", "redirect_uri", "redirecturl", "ru",
];

const TRACKING_PARAM_KEYS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "msclkid", "_ga", "_gl", "ref", "ref_src",
  "ved", "sa", "ei", "iflsig", "uact", "oq", "gs_lcrp",
]);

function _safeDecode(value) {
  if (!value || typeof value !== "string") return "";
  let out = value.trim();
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch { break; }
  }
  return out;
}

function _hostOf(url) {
  try { return String(new URL(url).hostname || "").toLowerCase(); } catch { return ""; }
}

function _isGoogleHost(host) {
  if (!host) return false;
  return GOOGLE_HOST_PATTERNS.some((re) => re.test(host));
}

/** Strip common tracking params so listings dedupe correctly. */
function _scrubTrackingParams(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_KEYS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return url; }
}

/** True if URL is a Google search/redirect/aclk/shopping-aggregator wrapper. */
export function isGoogleRedirect(url) {
  if (!url || typeof url !== "string") return false;
  const decoded = _safeDecode(url);
  let u;
  try { u = new URL(decoded); } catch { return false; }
  const host = String(u.hostname || "").toLowerCase();
  const path = String(u.pathname || "").toLowerCase();

  // /aclk is Google ad-click; sometimes mirrored on non-google hosts.
  if (/\/aclk(\?|\/|$)/i.test(decoded)) return true;

  if (!_isGoogleHost(host)) return false;

  return (
    path === "/url" ||
    path === "/search" ||
    path.startsWith("/aclk") ||
    path.startsWith("/shopping/product") ||
    /googleadservices\./.test(host) ||
    /googlesyndication\./.test(host) ||
    /doubleclick\.net$/.test(host)
  );
}

/** Pull the real destination out of a Google redirect URL. Returns "" if none. */
export function extractFromGoogleRedirect(url) {
  if (!url) return "";
  const decoded = _safeDecode(url);
  let u;
  try { u = new URL(decoded); } catch { return ""; }
  for (const key of REDIRECT_PARAM_KEYS) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    const inner = _safeDecode(v);
    if (!/^https?:\/\//i.test(inner)) continue;
    const innerHost = _hostOf(inner);
    if (!innerHost || _isGoogleHost(innerHost)) continue;
    return _scrubTrackingParams(inner);
  }
  return "";
}

/**
 * resolveDirectProductUrl — pick the safest merchant URL for a raw SerpAPI item.
 *
 *   {
 *     directUrl:   string | null,   // safe to open; null = no usable URL
 *     originalUrl: string | null,   // raw best candidate (pre-hardening)
 *     source:      "direct" | "extracted" | "rejected" | "missing",
 *     confidence:  number,          // 0..1
 *     reason?:     string,
 *   }
 */
export function resolveDirectProductUrl(rawItem = {}) {
  const candidates = [
    rawItem.product_link,
    rawItem.product_page_url,
    rawItem.offer_page_url,
    rawItem.offer_link,
    rawItem.merchant_link,
    rawItem.product_url,
    rawItem.seller_link,
    rawItem.link,
    rawItem.url,
    rawItem.shopping_result_link,
    rawItem.google_product_link,
    rawItem.google_shopping_product_link,
    rawItem.serpapi_link,
  ]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  if (!candidates.length) {
    return { directUrl: null, originalUrl: null, source: "missing", confidence: 0, reason: "no_url_fields" };
  }

  const original = candidates[0];

  // Pass 1: take the first candidate that is already a direct merchant URL.
  for (const c of candidates) {
    if (!/^https?:\/\//i.test(c)) continue;
    if (isGoogleRedirect(c)) continue;
    const host = _hostOf(c);
    if (!host || _isGoogleHost(host)) continue;
    return {
      directUrl: _scrubTrackingParams(c),
      originalUrl: original,
      source: "direct",
      confidence: 0.95,
    };
  }

  // Pass 2: extract the real destination out of a Google redirect wrapper.
  for (const c of candidates) {
    if (!/^https?:\/\//i.test(c)) continue;
    const inner = extractFromGoogleRedirect(c);
    if (inner) {
      return {
        directUrl: inner,
        originalUrl: original,
        source: "extracted",
        confidence: 0.7,
      };
    }
  }

  // Pass 3: allow Google Shopping aggregator pages (/shopping/product/…) as
  // a low-confidence fallback. The aggregator lists merchant offers — not
  // ideal, but strictly better than returning null and forcing the frontend
  // to fall back to an eBay search built from the title. The frontend can
  // surface the lower confidence with a "via Google" badge if it wants.
  // The blocked patterns (/url, /search, /aclk, googleadservices,
  // googlesyndication, doubleclick) are still rejected — those are pure
  // redirect/ad wrappers, not browsable pages.
  for (const c of candidates) {
    if (!/^https?:\/\//i.test(c)) continue;
    let u;
    try { u = new URL(c); } catch { continue; }
    const host = String(u.hostname || "").toLowerCase();
    const path = String(u.pathname || "").toLowerCase();
    if (_isGoogleHost(host) && path.startsWith("/shopping/product")) {
      return {
        directUrl: c,
        originalUrl: original,
        source: "google_product",
        confidence: 0.4,
        reason: "google_shopping_aggregator_fallback",
      };
    }
  }

  return {
    directUrl: null,
    originalUrl: original,
    source: "rejected",
    confidence: 0,
    reason: "only_google_wrappers",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Quality scoring + filter/rank
// ──────────────────────────────────────────────────────────────────────────

const STOP = new Set([
  "the","and","for","with","from","new","used","vintage","retro","style",
  "rare","sale","best","price","a","an","of","in","on","to","is","item",
  "official","authentic","original","genuine","brand",
]);

function _tokens(s = "") {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

function _titleOverlap(query, title) {
  const Q = _tokens(query);
  const T = new Set(_tokens(title));
  if (!Q.length || !T.size) return 0;
  let hits = 0;
  for (const q of Q) if (T.has(q)) hits++;
  return hits / Q.length;
}

/** Score a normalized SerpAPI listing against the user query. Range 0..1. */
export function scoreListing(item = {}, query = "") {
  let s = 0;

  const overlap = _titleOverlap(query, item.title || "");
  s += overlap * 0.45;

  const price = Number(item.totalPrice ?? item.price);
  if (Number.isFinite(price) && price > 0) s += 0.15;

  const urlConf = Number(item.urlConfidence || 0);
  s += Math.max(0, Math.min(1, urlConf)) * 0.20;

  if (item.image) s += 0.05;

  // Organic favored over sponsored
  if (item.__isSponsored === true || item.isSponsored === true) s -= 0.10;
  else                                                          s += 0.10;

  const src = String(item.source || "").toLowerCase();
  if (src && !src.includes("google")) s += 0.05;

  return Math.max(0, Math.min(1, s));
}

/**
 * filterAndRankSerpItems — produces a sorted, quality-filtered listing list.
 *
 * Sort:
 *   1. items with a valid directUrl first
 *   2. quality score (desc)
 *   3. lower price
 *
 * opts.maxResults    — defaults to SERPAPI_MAX_RESULTS
 * opts.minRelevance  — defaults to 0.20 (1 in 5 query tokens must hit)
 */
export function filterAndRankSerpItems(items, query, opts = {}) {
  const maxResults   = Number(opts.maxResults   || SERPAPI_MAX_RESULTS);
  const minRelevance = Number(opts.minRelevance ?? 0.20);

  const rejected = {
    noTitle: 0, noPrice: 0, badUrl: 0, lowRelevance: 0, duplicate: 0,
  };
  const seen = new Set();
  const scored = [];

  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || !raw.title) { rejected.noTitle++; continue; }

    const price = Number(raw.totalPrice ?? raw.price);
    if (!Number.isFinite(price) || price <= 0) { rejected.noPrice++; continue; }

    // Dedupe by directUrl exact match when available (same offer page = same
    // listing regardless of title). Without a URL, fall back to host+title
    // prefix so two storefronts with identical titles still collapse.
    const dedupKey = raw.directUrl
      ? `url:${raw.directUrl}`
      : `ht:${_hostOf(raw.link || "")}|${String(raw.title).toLowerCase().slice(0, 60)}`;
    if (seen.has(dedupKey)) { rejected.duplicate++; continue; }
    seen.add(dedupKey);

    const relevance = _titleOverlap(query, raw.title);
    if (query && relevance < minRelevance) { rejected.lowRelevance++; continue; }

    const score = scoreListing(raw, query);
    scored.push({ raw, score, relevance });
  }

  scored.sort((a, b) => {
    const aHas = a.raw.directUrl ? 1 : 0;
    const bHas = b.raw.directUrl ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    if (Math.abs(a.score - b.score) > 0.02) return b.score - a.score;
    const ap = Number(a.raw.totalPrice ?? a.raw.price);
    const bp = Number(b.raw.totalPrice ?? b.raw.price);
    return ap - bp;
  });

  const top = scored.slice(0, maxResults).map((x) => x.raw);
  return {
    items: top,
    rejected,
    rawCount: Array.isArray(items) ? items.length : 0,
    usableCount: scored.length,
    directUrlCount: top.filter((x) => x.directUrl).length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Market evidence (Phase 7 — BUY/HOLD/PASS safety gate)
// ──────────────────────────────────────────────────────────────────────────

function _median(nums) {
  const arr = nums.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

function _avg(nums) {
  const arr = nums.filter((x) => Number.isFinite(x));
  return arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0;
}

/**
 * Summarise a listing list into a {low/medium/high} confidence value the
 * verdict engine uses to *cap* BUY when SerpAPI evidence is weak.
 *
 *   {
 *     listingCount, directUrlCount, medianPrice, priceSpreadPct,
 *     qualityAvg, confidence: "low"|"medium"|"high", reason
 *   }
 */
export function computeMarketEvidence(items, query = "") {
  const list = Array.isArray(items) ? items : [];

  const directUrlCount = list.filter(
    (x) => x.directUrl || (x.link && !isGoogleRedirect(x.link))
  ).length;

  const prices = list
    .map((x) => Number(x.totalPrice ?? x.price))
    .filter((n) => Number.isFinite(n) && n > 0);

  const med = _median(prices);
  const spread = med > 0 && prices.length > 1
    ? (Math.max(...prices) - Math.min(...prices)) / med
    : 0;

  const qualityAvg = _avg(list.map((x) => scoreListing(x, query)));

  const reasons = [];
  let confidence = "high";

  if (list.length < SERPAPI_MIN_GOOD_RESULTS) {
    confidence = "low";
    reasons.push(`only_${list.length}_listings`);
  } else if (directUrlCount === 0) {
    confidence = "low";
    reasons.push("no_direct_urls");
  } else {
    if (directUrlCount < SERPAPI_MIN_GOOD_RESULTS) {
      confidence = "medium";
      reasons.push("few_direct_urls");
    }
    if (spread > 1.5) {
      confidence = confidence === "high" ? "medium" : confidence;
      reasons.push("price_spread_too_wide");
    }
    if (qualityAvg < 0.35) {
      confidence = confidence === "high" ? "medium" : confidence;
      reasons.push("low_quality_avg");
    }
  }

  return {
    listingCount:   list.length,
    directUrlCount,
    medianPrice:    Math.round(med * 100) / 100,
    priceSpreadPct: Math.round(spread * 100),
    qualityAvg:     Math.round(qualityAvg * 100) / 100,
    confidence,
    reason:         reasons.join(",") || "ok",
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Query builder
// ──────────────────────────────────────────────────────────────────────────

const CATEGORY_KEYS = {
  sneakers:    ["brand", "model", "colorway"],
  shoes:       ["brand", "model", "colorway"],
  electronics: ["brand", "model"],
  books:       ["title", "author", "isbn"],
  cards:       ["title", "set", "number"],
  watches:     ["brand", "model", "reference"],
  bags:        ["brand", "model"],
  clothing:    ["brand", "model"],
  generic:     ["brand", "model"],
};

const NOISE_TOKENS = new Set([
  "item", "object", "thing", "product", "listing",
  "approximately", "approx", "looks", "appears", "possibly",
]);

function _cleanToken(v) {
  if (v == null) return "";
  const s = String(v).trim().replace(/\s+/g, " ");
  if (!s) return "";
  if (NOISE_TOKENS.has(s.toLowerCase())) return "";
  return s;
}

/** Build a SerpAPI-ready query string from a parsed identity object. */
export function buildSerpQuery(identity = {}) {
  const cat = String(identity.category || "generic").toLowerCase();
  const fieldOrder = CATEGORY_KEYS[cat] || CATEGORY_KEYS.generic;

  const parts = [];
  const seen = new Set();

  for (const k of fieldOrder) {
    const tok = _cleanToken(identity[k]);
    if (!tok) continue;
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(tok);
  }

  for (const k of ["itemType", "type", "condition"]) {
    const tok = _cleanToken(identity[k]);
    if (!tok) continue;
    if (k === "condition" && /^new$/i.test(tok)) continue; // adds noise
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(tok);
  }

  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Fallback queries fired only if the primary returns zero usable results. */
export function buildSerpFallbackQueries(identity = {}) {
  const out = [];
  const brand    = _cleanToken(identity.brand);
  const model    = _cleanToken(identity.model);
  const itemType = _cleanToken(identity.itemType || identity.type);
  const vision   = _cleanToken(identity.visionLabel);

  if (brand && model)    out.push(`${brand} ${model}`);
  if (brand && itemType) out.push(`${brand} ${itemType}`);
  if (vision)            out.push(vision);

  const seen = new Set();
  return out
    .map((s) => s.slice(0, 80))
    .filter((s) => {
      const k = s.toLowerCase();
      if (!s || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

// ──────────────────────────────────────────────────────────────────────────
// Cache (stale-while-revalidate)
// ──────────────────────────────────────────────────────────────────────────

function _hashKey(s) {
  return crypto.createHash("sha1")
    .update(String(s || "").toLowerCase().trim())
    .digest("hex").slice(0, 16);
}

export function serpCacheKey(query, engine = "shopping") {
  return `serp:v1:${engine}:${_hashKey(query)}`;
}

/**
 * Two-tier in-process cache (fresh + stale).
 *
 *   get(key) → { fresh, stale, entry } | { fresh: false, stale: false, entry: null }
 *   set(key, payload)
 *
 * Past the stale TTL the entry is dropped on read.
 */
export class SerpCache {
  constructor({ freshTtlMs, staleTtlMs, maxSize = 2000 } = {}) {
    this.freshTtlMs = Number(freshTtlMs || SERPAPI_CACHE_TTL_MS);
    this.staleTtlMs = Number(staleTtlMs || SERPAPI_STALE_TTL_MS);
    this.maxSize = maxSize;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return { fresh: false, stale: false, entry: null };
    const age = Date.now() - hit.createdAt;
    if (age > this.staleTtlMs) {
      this.map.delete(key);
      return { fresh: false, stale: false, entry: null };
    }
    if (age <= this.freshTtlMs) return { fresh: true, stale: false, entry: hit };
    return { fresh: false, stale: true, entry: hit };
  }
  set(key, payload) {
    if (this.map.size >= this.maxSize) {
      const target = Math.floor(this.maxSize * 0.85);
      while (this.map.size > target) {
        const first = this.map.keys().next().value;
        this.map.delete(first);
      }
    }
    this.map.set(key, { createdAt: Date.now(), ...payload });
  }
  delete(key) { return this.map.delete(key); }
  size() { return this.map.size; }
}

// ──────────────────────────────────────────────────────────────────────────
// Telemetry
// ──────────────────────────────────────────────────────────────────────────

const _telemetry = {
  cacheHits: 0,
  staleHits: 0,
  misses: 0,
  timeouts: 0,
  errors: 0,
  totalLatencyMs: 0,
  latencySamples: [],
  rejectedRedirects: 0,
  directUrlAccepted: 0,
  directUrlExtracted: 0,
  itemsRaw: 0,
  itemsUsable: 0,
  rejectedReasons: Object.create(null),
};

function _bump(field, n = 1) { _telemetry[field] = (_telemetry[field] || 0) + n; }

/** Call once per SerpAPI fetch (whether cache-served or live). */
export function recordSerpFetch({
  cacheStatus,
  latencyMs,
  rawCount,
  usableCount,
  directUrlCount,
  rejected,
  timeout,
  error,
} = {}) {
  if (cacheStatus === "fresh")      _bump("cacheHits");
  else if (cacheStatus === "stale") _bump("staleHits");
  else                              _bump("misses");

  if (timeout) _bump("timeouts");
  if (error)   _bump("errors");

  if (Number.isFinite(latencyMs)) {
    _bump("totalLatencyMs", latencyMs);
    _telemetry.latencySamples.push(latencyMs);
    if (_telemetry.latencySamples.length > 200) _telemetry.latencySamples.shift();
  }

  _bump("itemsRaw",   Number(rawCount)       || 0);
  _bump("itemsUsable", Number(usableCount)   || 0);
  _bump("directUrlAccepted", Number(directUrlCount) || 0);

  if (rejected && typeof rejected === "object") {
    for (const [k, v] of Object.entries(rejected)) {
      _telemetry.rejectedReasons[k] = (_telemetry.rejectedReasons[k] || 0) + Number(v || 0);
    }
  }
}

/** Call per resolved URL outcome (direct / extracted / rejected / missing). */
export function recordUrlOutcome(source) {
  if (source === "extracted") _bump("directUrlExtracted");
  if (source === "rejected")  _bump("rejectedRedirects");
}

export function getSerpDebug() {
  const n = _telemetry.latencySamples.length;
  const sorted = [..._telemetry.latencySamples].sort((a, b) => a - b);
  const total = _telemetry.cacheHits + _telemetry.staleHits + _telemetry.misses;

  return {
    cacheHits:     _telemetry.cacheHits,
    staleHits:     _telemetry.staleHits,
    misses:        _telemetry.misses,
    timeouts:      _telemetry.timeouts,
    errors:        _telemetry.errors,
    avgLatencyMs:  total ? Math.round(_telemetry.totalLatencyMs / total) : 0,
    p95LatencyMs:  n ? Math.round(sorted[Math.min(n - 1, Math.floor(n * 0.95))]) : 0,
    itemsRaw:      _telemetry.itemsRaw,
    itemsUsable:   _telemetry.itemsUsable,
    usableRate:    _telemetry.itemsRaw
      ? Math.round((_telemetry.itemsUsable / _telemetry.itemsRaw) * 100)
      : 0,
    directUrlRate: _telemetry.itemsUsable
      ? Math.round(
          ((_telemetry.directUrlAccepted + _telemetry.directUrlExtracted) /
            _telemetry.itemsUsable) * 100
        )
      : 0,
    directUrlAccepted:  _telemetry.directUrlAccepted,
    directUrlExtracted: _telemetry.directUrlExtracted,
    rejectedRedirects:  _telemetry.rejectedRedirects,
    rejectedReasons:    { ..._telemetry.rejectedReasons },
    config: {
      timeoutMs:      SERPAPI_TIMEOUT_MS,
      maxResults:     SERPAPI_MAX_RESULTS,
      minGoodResults: SERPAPI_MIN_GOOD_RESULTS,
      freshTtlMs:     SERPAPI_CACHE_TTL_MS,
      staleTtlMs:     SERPAPI_STALE_TTL_MS,
    },
  };
}

export function resetSerpDebug() {
  for (const k of Object.keys(_telemetry)) {
    if (Array.isArray(_telemetry[k])) _telemetry[k].length = 0;
    else if (typeof _telemetry[k] === "number") _telemetry[k] = 0;
    else if (_telemetry[k] && typeof _telemetry[k] === "object") {
      for (const kk of Object.keys(_telemetry[k])) delete _telemetry[k][kk];
    }
  }
}
