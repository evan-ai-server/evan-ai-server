// src/urlRecoveryInjectionPolicy.js
// Phase 5A.3C — Injection-time identity re-check for URL_RECOVERY_CACHE.
// Phase 5A.3C.2 — require persisted write-time guard metadata and positively
// re-prove identity (generic hosts like ebay.com carry no contradiction tokens).
//
// Pure + synchronous. No I/O, no side effects, no network.
// Called inside buildMarketSearchResponsePayload before injecting a cached
// recovered directUrl into an item. Fail-closed: any ambiguity → no injection.

import {
  hasIdentityContradiction,
  PRICE_ABS_TOLERANCE,
  PRICE_PCT_TOLERANCE,
} from "./offerIdentityGuard.js";

function _safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Mirror of offerIdentityGuard's price tolerance: within $2.00 absolute OR 8% relative.
function _priceWithinTolerance(current, anchor) {
  if (current == null || anchor == null) return false;
  const abs = Math.abs(current - anchor);
  const pct = abs / Math.max(anchor, 0.01);
  return abs <= PRICE_ABS_TOLERANCE || pct <= PRICE_PCT_TOLERANCE;
}

/**
 * Decide whether a cached recovery record may inject its directUrl into the
 * current item. Returns { inject, item, reason }.
 *
 * @param {object} item          — current payload item (title, source, price, _productId, etc.)
 * @param {object} cachedRec     — from URL_RECOVERY_CACHE. Phase 5A.3C.2 requires write-time
 *                                  guard metadata: { recoveryGuardVersion, origTitle, origSource,
 *                                  origPrice, recoveredPrice, guardScore, directUrl, urlHost }.
 * @param {object} context       — { scanId, query, isValidMerchantUrl }
 * @returns {{ inject: boolean, item: object, reason: string }}
 */
export function applyUrlRecoveryCacheRecord(item, cachedRec, context = {}) {
  const { query = "", isValidMerchantUrl = null } = context;
  const _pid = item?._productId || null;

  if (!_pid || !cachedRec) {
    return { inject: false, item, reason: "no_cached_record" };
  }

  if (item?.isVerifiedListing === true) {
    return { inject: false, item, reason: "already_verified" };
  }

  // Phase 5A.3C.2: merchant URL validator is mandatory — fail closed if absent.
  if (typeof isValidMerchantUrl !== "function") {
    return { inject: false, item, reason: "missing_merchant_url_validator" };
  }

  if (!cachedRec.directUrl) {
    return { inject: false, item, reason: "missing_direct_url" };
  }

  if (!isValidMerchantUrl(cachedRec.directUrl)) {
    let host = null;
    try { host = new URL(cachedRec.directUrl).hostname.toLowerCase(); } catch {}
    const isGoogle = host && (/(^|\.)google\./i.test(host) || /(^|\.)googleadservices\./i.test(host));
    return { inject: false, item, reason: isGoogle ? "google_shell_url" : "invalid_merchant_url" };
  }

  // Phase 5A.3C.2: old-shape records (pre-5A.3C.2, no guard metadata) cannot
  // prove identity at injection time → fail closed. Existing cache entries that
  // lack this metadata will not silently become verified after this patch.
  if (cachedRec.recoveryGuardVersion == null || !cachedRec.origTitle) {
    return { inject: false, item, reason: "insufficient_recovery_identity_evidence" };
  }

  const itemTitle = String(item?.title || "");
  const recoveredHost = cachedRec.urlHost || "";

  // Existing 5A.3C checks: current item/query must not contradict the recovered host.
  if (hasIdentityContradiction(itemTitle, "", recoveredHost)) {
    return { inject: false, item, reason: "identity_contradiction_host" };
  }
  if (query && hasIdentityContradiction(query, "", recoveredHost)) {
    return { inject: false, item, reason: "identity_contradiction_query" };
  }

  // Phase 5A.3C.2 positive recheck: current item/query must agree with the
  // cached write-time original title (family/airline/manufacturer anchors).
  const origTitle = String(cachedRec.origTitle || "");
  if (hasIdentityContradiction(itemTitle, origTitle, recoveredHost)) {
    return { inject: false, item, reason: "injection_title_contradiction" };
  }
  if (query && hasIdentityContradiction(query, origTitle, recoveredHost)) {
    return { inject: false, item, reason: "injection_title_contradiction" };
  }

  // Phase 5A.3C.2 positive recheck: current item price must not drift beyond
  // tolerance from the cached write-time prices. Missing price evidence → fail closed.
  const curPrice  = _safeNum(item?.totalPrice ?? item?.price);
  const origPrice = _safeNum(cachedRec.origPrice);
  const recPrice  = _safeNum(cachedRec.recoveredPrice);
  if (curPrice == null || (origPrice == null && recPrice == null)) {
    return { inject: false, item, reason: "injection_guard_metadata_mismatch" };
  }
  if (!_priceWithinTolerance(curPrice, origPrice) && !_priceWithinTolerance(curPrice, recPrice)) {
    return { inject: false, item, reason: "injection_price_drift" };
  }

  const injectedItem = {
    ...item,
    directUrl: cachedRec.directUrl,
    link: cachedRec.directUrl,
    url: cachedRec.directUrl,
    buyLink: cachedRec.directUrl,
    clickable: true,
    urlQuality: "merchant_direct",
    urlHost: cachedRec.urlHost,
  };

  return { inject: true, item: injectedItem, reason: "identity_passed" };
}
