import { test } from "node:test";
import assert from "node:assert/strict";

// Phase 3A — mirrors routeAllowsUserOrApiKey (index.js ~3002-3021) and the
// abuseTrackerMiddleware limitPaths list (index.js ~3168-3170) without
// importing index.js (side effects / env deps, per existing test convention —
// see src/ebayVerifiedPipeline.test.js). Kept in sync by hand; if the real
// predicate changes, update this mirror too.
function routeAllowsUserOrApiKey(pathname = "") {
  const p = String(pathname || "");
  return (
    p === "/analytics/event" ||
    p === "/deal/hunt" ||
    p === "/sell/estimate" ||
    p === "/upload/presign" ||
    p === "/upload/complete" ||
    p === "/upload/image" ||
    p === "/api/upload/image" ||
    p === "/vision/analyze" ||
    p === "/api/vision/analyze" ||
    p === "/search/serp" ||
    p === "/search/ebay" ||
    p === "/search/etsy" ||
    p === "/vision/enrich" ||
    p === "/api/receipt/analyze" ||
    p === "/api/auth/deep-scan" ||
    p === "/api/arbitrage/flip-scanner" ||
    p.startsWith("/market/")
  );
}

const ABUSE_TRACKER_LIMIT_PATHS = [
  "/market/search", "/api/vision/analyze", "/upload/presign", "/vision/enrich",
  "/search/serp", "/search/ebay", "/search/etsy",
  "/api/receipt/analyze", "/api/auth/deep-scan", "/api/arbitrage/flip-scanner",
];

const PAID_ENDPOINTS = [
  "/vision/enrich",
  "/api/receipt/analyze",
  "/api/auth/deep-scan",
  "/api/arbitrage/flip-scanner",
];

test("Phase 3A: all four paid endpoints now require signed user/API access", () => {
  for (const path of PAID_ENDPOINTS) {
    assert.equal(routeAllowsUserOrApiKey(path), true, `${path} should require product access`);
  }
});

test("Phase 3A: all four paid endpoints are covered by abuseTracker limitPaths", () => {
  for (const path of PAID_ENDPOINTS) {
    const covered = ABUSE_TRACKER_LIMIT_PATHS.some((p) => path.startsWith(p));
    assert.equal(covered, true, `${path} should be abuse-tracked`);
  }
});

test("existing main scan path protections are not weakened", () => {
  assert.equal(routeAllowsUserOrApiKey("/vision/analyze"), true);
  assert.equal(routeAllowsUserOrApiKey("/api/vision/analyze"), true);
  assert.equal(routeAllowsUserOrApiKey("/market/search"), true);
  assert.equal(routeAllowsUserOrApiKey("/market/search/stream"), true);
  assert.equal(routeAllowsUserOrApiKey("/search/serp"), true);
  assert.equal(routeAllowsUserOrApiKey("/search/ebay"), true);
  assert.equal(routeAllowsUserOrApiKey("/search/etsy"), true);
});

test("intentionally public/unrelated routes are not accidentally locked", () => {
  assert.equal(routeAllowsUserOrApiKey("/health"), false);
  assert.equal(routeAllowsUserOrApiKey("/api/guest/identify"), false);
  assert.equal(routeAllowsUserOrApiKey("/api/scan/check"), false);
  assert.equal(routeAllowsUserOrApiKey("/api/scan/consume"), false);
  assert.equal(routeAllowsUserOrApiKey("/attribution/click"), false);
});
