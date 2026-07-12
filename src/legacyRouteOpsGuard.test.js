import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Phase 6A.1 — legacy internal/B2B route ops-gating.
//
// Full HTTP wiring will be validated against the deployed service after
// separate deployment approval. These tests provide direct production-
// source wiring assertions, route-table regression coverage, and isolated
// middleware-branch coverage without booting the monolithic server.
//
// Deliberately a separate file from paidEndpointAccessGuard.test.js: that
// file covers PRODUCT-access gating (JWT/API-key) on paid consumer
// endpoints; this covers OPS-access gating (x-ops-secret) on internal/B2B
// legacy endpoints with no mobile consumer — a different mechanism and
// route set.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_JS_PATH = path.join(__dirname, "..", "index.js");
const indexJsSource = fs.readFileSync(INDEX_JS_PATH, "utf8");

// ============================================================================
// PART 1 — direct assertions against the ACTUAL index.js source text.
//
// index.js is read via fs.readFileSync only — never imported or executed
// (it has side effects: Redis/OpenAI client construction, app.listen, boot
// warmup). Named functions and route handlers are located by name/snippet
// (never by fixed line number) and their body isolated with a brace-depth
// scanner that is comment/string-aware. If a target function or route is
// ever renamed or removed, extraction throws immediately and every test in
// this file fails loudly — that is the intended drift-detection behavior.
// ============================================================================

function findMatchingCloseBrace(source, openBraceIdx) {
  let depth = 0;
  let inSingle = false, inDouble = false, inTemplate = false, inLineComment = false, inBlockComment = false;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inLineComment) { if (ch === "\n") inLineComment = false; continue; }
    if (inBlockComment) { if (ch === "/" && prev === "*") inBlockComment = false; continue; }
    if (inSingle) { if (ch === "'" && prev !== "\\") inSingle = false; continue; }
    if (inDouble) { if (ch === '"' && prev !== "\\") inDouble = false; continue; }
    if (inTemplate) { if (ch === "`" && prev !== "\\") inTemplate = false; continue; }
    if (ch === "/" && source[i + 1] === "/") { inLineComment = true; continue; }
    if (ch === "/" && source[i + 1] === "*") { inBlockComment = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "`") { inTemplate = true; continue; }
    if (ch === "{") { depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
      continue;
    }
  }
  throw new Error("findMatchingCloseBrace: unbalanced braces — depth never returned to 0");
}

// Locates `function name(` or `async function name(`, skips the parameter
// list (paren-depth balanced — sufficient for this file's plain (req, res)
// style signatures, none of which use destructured params), then isolates
// the body via findMatchingCloseBrace. Scoped to named function
// declarations only, which is all Phase 6A.1 touched.
function extractFunctionSource(source, functionName) {
  const declRe = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const declMatch = declRe.exec(source);
  if (!declMatch) {
    throw new Error(`extractFunctionSource: could not locate "function ${functionName}(" in index.js — has it been renamed or removed?`);
  }
  const startIdx = declMatch.index;
  let i = declMatch.index + declMatch[0].length - 1; // at the "(" itself
  let parenDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") { parenDepth--; if (parenDepth === 0) { i++; break; } }
  }
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== "{") {
    throw new Error(`extractFunctionSource: expected "{" after ${functionName}'s parameter list, found ${JSON.stringify(source[i])}`);
  }
  const bodyEnd = findMatchingCloseBrace(source, i);
  return source.slice(startIdx, bodyEnd);
}

// Locates a route-registration snippet (e.g. `app.post("/x/y"`), then
// isolates the handler body via the same balanced-brace scanner. Assumes
// the handler is `(req, res) => { ... }` / `async (req, res) => { ... }`
// with a plain (non-destructured) parameter list — true of every route
// this file inspects — so the first "{" after the snippet is the body's
// opening brace.
function extractRouteHandlerSource(source, routeRegistrationSnippet) {
  const startIdx = source.indexOf(routeRegistrationSnippet);
  if (startIdx === -1) {
    throw new Error(`extractRouteHandlerSource: could not locate ${JSON.stringify(routeRegistrationSnippet)} in index.js`);
  }
  const braceIdx = source.indexOf("{", startIdx);
  if (braceIdx === -1) {
    throw new Error(`extractRouteHandlerSource: no "{" found after ${JSON.stringify(routeRegistrationSnippet)}`);
  }
  const bodyEnd = findMatchingCloseBrace(source, braceIdx);
  return source.slice(startIdx, bodyEnd);
}

// Extraction happens at module-load time — if any of these three functions
// is renamed/removed, the whole file fails loudly here rather than a test
// silently passing against nothing.
const isLegacyOpsGatedRouteSource = extractFunctionSource(indexJsSource, "isLegacyOpsGatedRoute");
const phase2RouteProtectionSource = extractFunctionSource(indexJsSource, "phase2RouteProtection");
const requireOpsAccessSource      = extractFunctionSource(indexJsSource, "requireOpsAccess");
const revenueCatRouteSource       = extractRouteHandlerSource(indexJsSource, 'app.post("/api/webhooks/revenuecat"');

// ---- A. actual isLegacyOpsGatedRoute ---------------------------------------

test("actual source: isLegacyOpsGatedRoute covers all 10 approved legacy prefixes", () => {
  const requiredFragments = [
    '"/autopilot/run"', '"/scan/replay/"', '"/api/partner/"', '"/api/webhook/"',
    '"/api/widget/"', '"/api/analytics/"', '"/api/verify/"', '"/api/trust/"',
    '"/api/trustmark/"', '"/api/distribution/"',
  ];
  for (const fragment of requiredFragments) {
    assert.ok(isLegacyOpsGatedRouteSource.includes(fragment), `expected isLegacyOpsGatedRoute to contain ${fragment}`);
  }
});

test("actual source: isLegacyOpsGatedRoute never references /api/webhooks/ (plural, RevenueCat)", () => {
  assert.ok(!isLegacyOpsGatedRouteSource.includes("/api/webhooks/"), "must never reference the plural /api/webhooks/ prefix");
  assert.ok(!isLegacyOpsGatedRouteSource.includes("/api/webhooks/revenuecat"), "must never reference the RevenueCat route directly");
});

test("actual source: /autopilot/run is exact-match logic, not a broad prefix", () => {
  assert.ok(isLegacyOpsGatedRouteSource.includes('p === "/autopilot/run"'), "expected an exact === match for /autopilot/run");
  assert.ok(!isLegacyOpsGatedRouteSource.includes('startsWith("/autopilot'), "/autopilot must not be matched via startsWith");
});

// ---- B. actual phase2RouteProtection: presence + ordering -----------------

test("actual source: phase2RouteProtection computes the request path and calls the legacy gate", () => {
  assert.ok(/const\s+path\s*=\s*String\(req\.path/.test(phase2RouteProtectionSource), "expected phase2RouteProtection to compute `path` from req.path");
  assert.ok(phase2RouteProtectionSource.includes("isLegacyOpsGatedRoute(path)"), "expected a call to isLegacyOpsGatedRoute(path)");
  assert.ok(phase2RouteProtectionSource.includes("requireOpsAccess(req, res, next)"), "expected the legacy branch to delegate to requireOpsAccess(req, res, next)");
});

test("actual source: the legacy ops-gate check occurs BEFORE signed-user/product-access checks", () => {
  const legacyGateIdx = phase2RouteProtectionSource.indexOf("isLegacyOpsGatedRoute(path)");
  assert.notEqual(legacyGateIdx, -1, "isLegacyOpsGatedRoute(path) not found");

  const laterChecks = ["hasSignedUser", "hasDevFallbackUser", "hasProductAccess", "routeRequiresSignedUser(", "routeAllowsUserOrApiKey("];
  for (const marker of laterChecks) {
    const idx = phase2RouteProtectionSource.indexOf(marker);
    assert.notEqual(idx, -1, `expected to find ${marker} in phase2RouteProtection`);
    assert.ok(legacyGateIdx < idx, `legacy ops-gate check (source index ${legacyGateIdx}) must precede ${marker} (source index ${idx}) — ordering regression`);
  }
});

// ---- C. actual requireOpsAccess: fail-closed proof -------------------------

test("actual source: requireOpsAccess — non-production passthrough is a standalone check, not combined with OPS_SECRET", () => {
  assert.ok(/if\s*\(\s*!IS_PROD\s*\)\s*return\s+next\(\)/.test(requireOpsAccessSource), "expected a standalone `if (!IS_PROD) return next();`");
});

test("actual source: requireOpsAccess — the old fail-open combined condition is gone", () => {
  // Precise statement-shape regex (not a bare substring check) so this
  // cannot be tripped by an explanatory comment mentioning the old form —
  // it only matches the executable `if (...) return next()` shape.
  const oldFailOpenPattern = /if\s*\(\s*!IS_PROD\s*\|\|\s*!OPS_SECRET\s*\)\s*return\s+next\(\)/;
  assert.ok(!oldFailOpenPattern.test(requireOpsAccessSource), "the old fail-open form must not exist as live code");
});

test("actual source: requireOpsAccess — missing OPS_SECRET fails closed with 503 ops_access_not_configured", () => {
  assert.ok(/if\s*\(\s*!OPS_SECRET\s*\)/.test(requireOpsAccessSource), "expected a standalone `if (!OPS_SECRET)` check");
  assert.ok(requireOpsAccessSource.includes("res.status(503)"), "expected a 503 response for the missing-secret case");
  assert.ok(requireOpsAccessSource.includes("ops_access_not_configured"), "expected the exact error identifier ops_access_not_configured");
});

test("actual source: requireOpsAccess — header name, timing-safe comparison, and pass/reject responses are all present", () => {
  assert.ok(requireOpsAccessSource.includes('"x-ops-secret"'), "expected the inbound header name x-ops-secret");
  assert.ok(requireOpsAccessSource.includes("safeTimingEqual("), "expected safeTimingEqual to still gate the comparison");
  assert.ok(requireOpsAccessSource.includes("return next();"), "expected a next() call for the valid-secret path");
  assert.ok(requireOpsAccessSource.includes("res.status(404)"), "expected a 404 response for the invalid-secret path");
  assert.ok(/res\.status\(404\)\.json\(\{\s*ok:\s*false\s*\}\)/.test(requireOpsAccessSource), "expected the hidden rejection body to remain the bare {ok:false}");
});

// ---- D. actual RevenueCat route: registered, distinct, unmodified ---------

test("actual source: POST /api/webhooks/revenuecat remains registered, distinct from singular /api/webhook/", () => {
  assert.ok(indexJsSource.includes('app.post("/api/webhooks/revenuecat"'), "RevenueCat webhook route registration must remain present");
  assert.equal("/api/webhooks/revenuecat".startsWith("/api/webhook/"), false, "sanity: the plural route string does not start with the singular ops-gated prefix");
});

test("actual source: the RevenueCat route handler still references RC_WEBHOOK_SECRET", () => {
  assert.ok(revenueCatRouteSource.includes("RC_WEBHOOK_SECRET"), "expected the RevenueCat handler to still check RC_WEBHOOK_SECRET");
});

test("actual source: the RevenueCat route was NOT changed to use requireOpsAccess", () => {
  assert.ok(!revenueCatRouteSource.includes("requireOpsAccess"), "the RevenueCat webhook must keep its own independent secret check, never requireOpsAccess");
});

// ---- E. actual global middleware order -------------------------------------

test("actual source: app.use(phase2RouteProtection) is registered before the mapped legacy and RevenueCat route declarations", () => {
  const middlewareIdx = indexJsSource.indexOf("app.use(phase2RouteProtection)");
  assert.notEqual(middlewareIdx, -1, "app.use(phase2RouteProtection) not found");

  const routeDeclarations = [
    'app.post("/autopilot/run"',
    'app.get("/scan/replay/:scanId"',
    'app.post("/api/webhook/dispatch"',
    'app.post("/api/webhooks/revenuecat"',
  ];
  for (const decl of routeDeclarations) {
    const idx = indexJsSource.indexOf(decl);
    assert.notEqual(idx, -1, `expected to find route declaration ${decl}`);
    assert.ok(middlewareIdx < idx, `app.use(phase2RouteProtection) (index ${middlewareIdx}) must precede ${decl} (index ${idx})`);
  }
});

// ============================================================================
// PART 2 — supplemental mirrored-logic tests (fast, isolated). These check a
// hand-copied predicate/guard, NOT the real Express wiring — PART 1 above is
// what checks the actual production source. Kept for precise, fast branch
// coverage and for the full 56-route enumeration, which is impractical to
// assert via substring search alone.
// ============================================================================

function isLegacyOpsGatedRoute(pathname = "") {
  const p = String(pathname || "");
  return (
    p === "/autopilot/run" ||
    p.startsWith("/scan/replay/") ||
    p.startsWith("/api/partner/") ||
    p.startsWith("/api/webhook/") ||
    p.startsWith("/api/widget/") ||
    p.startsWith("/api/analytics/") ||
    p.startsWith("/api/verify/") ||
    p.startsWith("/api/trust/") ||
    p.startsWith("/api/trustmark/") ||
    p.startsWith("/api/distribution/")
  );
}

function safeTimingEqualMirror(a = "", b = "") {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (!aBuf.length || !bBuf.length) return false;
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireOpsAccessMirror(req, res, next, { isProd, opsSecret }) {
  if (!isProd) return next();
  if (!opsSecret) return res.status(503).json({ ok: false, error: "ops_access_not_configured" });
  const inbound = String(req.headers["x-ops-secret"] || "");
  if (safeTimingEqualMirror(inbound, opsSecret)) return next();
  return res.status(404).json({ ok: false });
}

function mockReq({ path = "/", headers = {} } = {}) { return { path, headers }; }
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}
function mockNext() {
  const fn = () => { fn.called = true; };
  fn.called = false;
  return fn;
}

const ALL_56_LEGACY_ROUTES = [
  "/autopilot/run",
  "/scan/replay/abc123scan",
  "/scan/replay/outcome",
  "/api/partner/sandbox/issue-key",
  "/api/partner/sandbox/rotate-key",
  "/api/partner/sandbox/revoke-key",
  "/api/partner/sandbox/usage/p123",
  "/api/partner/sandbox/ops",
  "/api/partner/register",
  "/api/partner/jwt/issue",
  "/api/partner/jwt/verify",
  "/api/partner/jwt/revoke",
  "/api/partner/p123",
  "/api/partner/p123/audit-log",
  "/api/partner/compliance/guard",
  "/api/partner/p123/compliance/log",
  "/api/partner/p123/dashboard",
  "/api/webhook/register",
  "/api/webhook/p123",
  "/api/webhook/wh123/deactivate",
  "/api/webhook/dispatch",
  "/api/webhook/process-queue",
  "/api/webhook/ops",
  "/api/widget/domain/register",
  "/api/widget/domain/p123",
  "/api/widget/nonce",
  "/api/widget/build",
  "/api/widget/ops",
  "/api/analytics/track",
  "/api/analytics/trust/t123",
  "/api/analytics/partner/p123",
  "/api/analytics/conversions/top",
  "/api/analytics/ops",
  "/api/verify/resolve",
  "/api/verify/resolve-batch",
  "/api/trust/external-reference",
  "/api/trust/revoke-reference",
  "/api/trust/identity-profile",
  "/api/trust/timeline-event",
  "/api/trust/timeline/scan/e123",
  "/api/trust/portable-packet",
  "/api/trust/portable-packet/pk123",
  "/api/trust/govern-claim",
  "/api/trust/badge-policies",
  "/api/trust/consent-policy",
  "/api/trust/validate-phase7",
  "/api/trust/validate-phase8",
  "/api/trust/packet",
  "/api/trust/packet/ops",
  "/api/trust/validate-phase9",
  "/api/trustmark/item-display",
  "/api/trustmark/reseller-display",
  "/api/trustmark/embed-widget",
  "/api/distribution/playbook",
  "/api/distribution/monitor",
  "/api/distribution/alerts",
];

test("supplemental mirrored route table: all 56 mapped legacy routes match the predicate mirror", () => {
  assert.equal(ALL_56_LEGACY_ROUTES.length, 56, "mapping list itself must stay at 56 — update if the census changes");
  for (const p of ALL_56_LEGACY_ROUTES) {
    assert.equal(isLegacyOpsGatedRoute(p), true, `${p} should be ops-gated`);
  }
});

test("supplemental mirrored route table: near-miss paths do NOT match, including /api/webhooks/revenuecat", () => {
  const nearMisses = [
    "/api/webhooks/revenuecat", "/api/webhooks/other",
    "/autopilot", "/autopilot/run/extra",
    "/scan/replayoutcome",
    "/api/partnerX",
    "/api/trustworthy", "/api/trust",
    "/api/analyticsx", "/api/analytics",
    "/api/verify",
    "/api/webhook", "/api/widget",
    "/api/distributionZZZ",
    "/api/trustmark",
  ];
  for (const p of nearMisses) {
    assert.equal(isLegacyOpsGatedRoute(p), false, `${p} should NOT be ops-gated`);
  }
});

test("supplemental mirrored route table: normal production mobile paths are unaffected", () => {
  const mobileRoutes = [
    "/api/vision/analyze", "/vision/analyze", "/api/usage/status",
    "/market/search", "/market/search/stream",
    "/api/auth/register", "/api/auth/login", "/auth/me",
    "/history/list", "/watchlist/add",
    "/search/serp", "/search/ebay", "/search/etsy",
    "/health", "/ready",
    "/attribution/subscription", "/attribution/click",
  ];
  for (const p of mobileRoutes) {
    assert.equal(isLegacyOpsGatedRoute(p), false, `${p} must not become ops-gated`);
  }
});

test("supplemental mirrored middleware branch: requireOpsAccess non-production preserves dev behavior regardless of secret", () => {
  for (const opsSecret of [null, "", "some-secret"]) {
    const req = mockReq({ path: "/api/partner/register" });
    const res = mockRes();
    const next = mockNext();
    requireOpsAccessMirror(req, res, next, { isProd: false, opsSecret });
    assert.equal(next.called, true);
    assert.equal(res.statusCode, null);
  }
});

test("supplemental mirrored middleware branch: production + missing OPS_SECRET fails CLOSED (503)", () => {
  const req = mockReq({ path: "/api/partner/register" });
  const res = mockRes();
  const next = mockNext();
  requireOpsAccessMirror(req, res, next, { isProd: true, opsSecret: "" });
  assert.equal(next.called, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { ok: false, error: "ops_access_not_configured" });
});

test("supplemental mirrored middleware branch: production + configured secret + no/wrong header → 404", () => {
  for (const headers of [{}, { "x-ops-secret": "wrong-value" }]) {
    const req = mockReq({ path: "/api/partner/register", headers });
    const res = mockRes();
    const next = mockNext();
    requireOpsAccessMirror(req, res, next, { isProd: true, opsSecret: "test-ops-secret" });
    assert.equal(next.called, false);
    assert.equal(res.statusCode, 404);
  }
});

test("supplemental mirrored middleware branch: production + correct secret → next(), no status set", () => {
  const req = mockReq({ path: "/api/partner/register", headers: { "x-ops-secret": "test-ops-secret" } });
  const res = mockRes();
  const next = mockNext();
  requireOpsAccessMirror(req, res, next, { isProd: true, opsSecret: "test-ops-secret" });
  assert.equal(next.called, true);
  assert.equal(res.statusCode, null);
});

// No test in this file makes a network call, spawns a process, or imports
// index.js — Part 1 reads its text via fs.readFileSync; Part 2 touches
// neither the file nor the network.
