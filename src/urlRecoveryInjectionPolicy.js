// src/urlRecoveryInjectionPolicy.js
// Phase 5A.3C — Injection-time identity re-check for URL_RECOVERY_CACHE.
//
// Pure + synchronous. No I/O, no side effects, no network.
// Called inside buildMarketSearchResponsePayload before injecting a cached
// recovered directUrl into an item. Fail-closed: any ambiguity → no injection.

import { hasIdentityContradiction } from "./offerIdentityGuard.js";

/**
 * Decide whether a cached recovery record may inject its directUrl into the
 * current item. Returns { inject, item, reason }.
 *
 * @param {object} item          — current payload item (title, source, price, _productId, etc.)
 * @param {object} cachedRec     — from URL_RECOVERY_CACHE ({ directUrl, urlHost, urlQuality, _productId })
 * @param {object} context       — { scanId, query, isValidMerchantUrl }
 * @returns {{ inject: boolean, item: object, reason: string }}
 */
export function applyUrlRecoveryCacheRecord(item, cachedRec, context = {}) {
  const { scanId = null, query = "", isValidMerchantUrl = null } = context;
  const _pid = item?._productId || null;

  if (!_pid || !cachedRec) {
    return { inject: false, item, reason: "no_cached_record" };
  }

  if (item?.isVerifiedListing === true) {
    return { inject: false, item, reason: "already_verified" };
  }

  if (!cachedRec.directUrl) {
    return { inject: false, item, reason: "missing_direct_url" };
  }

  if (isValidMerchantUrl && !isValidMerchantUrl(cachedRec.directUrl)) {
    let host = null;
    try { host = new URL(cachedRec.directUrl).hostname.toLowerCase(); } catch {}
    const isGoogle = host && (/(^|\.)google\./i.test(host) || /(^|\.)googleadservices\./i.test(host));
    return { inject: false, item, reason: isGoogle ? "google_shell_url" : "invalid_merchant_url" };
  }

  const itemTitle = String(item?.title || "");
  const recoveredHost = cachedRec.urlHost || "";

  if (hasIdentityContradiction(itemTitle, "", recoveredHost)) {
    return { inject: false, item, reason: "identity_contradiction_host" };
  }

  if (query) {
    if (hasIdentityContradiction(query, "", recoveredHost)) {
      return { inject: false, item, reason: "identity_contradiction_query" };
    }
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
