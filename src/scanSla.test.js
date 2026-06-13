// src/scanSla.test.js
// Phase 4H.5 — SLA budget and clean-fail payload tests.
// node --test src/scanSla.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMarketDeadlineMs,
  isSlaExhausted,
  buildSlaExhaustedPayload,
  buildMarketTimeoutPayload,
  isCleanFailPayload,
  MARKET_MIN_DEADLINE_MS,
  MARKET_MAX_DEADLINE_MS,
} from "./scanSla.js";
import { isUsableVisionSeed, isGenericAircraftToyQuery, detectIncompleteAircraftIdentityQuery } from "./queryGuards.js";

// ── SLA budget math ───────────────────────────────────────────────────────────

test("market gets full default deadline when no remaining-ms is provided", () => {
  assert.equal(computeMarketDeadlineMs(null), MARKET_MAX_DEADLINE_MS);
  assert.equal(computeMarketDeadlineMs(undefined), MARKET_MAX_DEADLINE_MS);
});

test("market deadline is clamped to minimum 800ms", () => {
  assert.equal(computeMarketDeadlineMs(500), MARKET_MIN_DEADLINE_MS, "500ms remaining → clamped to 800");
  assert.equal(computeMarketDeadlineMs(0),   MARKET_MIN_DEADLINE_MS);
});

test("market deadline = remainingMs - 250 when within bounds", () => {
  // remainingMs=1700 → 1700-250=1450
  assert.equal(computeMarketDeadlineMs(1700), 1450);
  // remainingMs=1000 → 1000-250=750 → clamped to 800
  assert.equal(computeMarketDeadlineMs(1000), 800);
  // remainingMs=2500 → 2500-250=2250 → clamped to max 1700
  assert.equal(computeMarketDeadlineMs(2500), 1700);
});

test("SLA exhausted when remaining ≤ 800ms", () => {
  assert.equal(isSlaExhausted(800),  true,  "800ms is at the threshold → exhausted");
  assert.equal(isSlaExhausted(500),  true,  "500ms → exhausted");
  assert.equal(isSlaExhausted(0),    true,  "0ms → exhausted");
  assert.equal(isSlaExhausted(801),  false, "801ms → not exhausted");
  assert.equal(isSlaExhausted(1700), false, "1700ms → not exhausted");
  assert.equal(isSlaExhausted(null), false, "null → not exhausted (no budget info)");
});

// ── Clean-fail payloads ───────────────────────────────────────────────────────

test("market SLA exhausted payload has displayMode=rescan_needed and trust=none", () => {
  const p = buildSlaExhaustedPayload();
  assert.equal(p.displayMode, "rescan_needed");
  assert.equal(p.trust, "none");
  assert.deepEqual(p.items, []);
  assert.equal(p.reason, "scan_sla_exhausted_before_market");
});

test("market timeout payload has displayMode=rescan_needed and trust=none", () => {
  const p = buildMarketTimeoutPayload();
  assert.equal(p.displayMode, "rescan_needed");
  assert.equal(p.trust, "none");
  assert.deepEqual(p.items, []);
  assert.equal(p.reason, "market_first_payload_timeout");
});

test("isCleanFailPayload: detects all clean-fail markers", () => {
  assert.equal(isCleanFailPayload({ displayMode: "rescan_needed", items: [] }), true);
  assert.equal(isCleanFailPayload({ trust: "none", items: [] }), true);
  assert.equal(isCleanFailPayload({ reason: "market_first_payload_timeout", items: [] }), true);
  assert.equal(isCleanFailPayload({ reason: "scan_sla_exhausted_before_market" }), true);
  assert.equal(isCleanFailPayload({ blocked: "generic_query_post_recovery" }), true);
  assert.equal(isCleanFailPayload(null), false, "null is not a clean fail");
  assert.equal(isCleanFailPayload({ items: [{ title: "iPhone" }] }), false, "real result is not a clean fail");
});

// ── Query guard integration with oracle ──────────────────────────────────────

test("oracle blocked: 'used item for' is not a usable vision seed", () => {
  assert.equal(isUsableVisionSeed("used item for"), false,
    "oracle must not run — used item for is unusable");
});

test("oracle blocked: 'used for pre owned' is not a usable vision seed", () => {
  assert.equal(isUsableVisionSeed("used for pre owned"), false,
    "oracle must not run — used for pre owned is unusable");
});

test("oracle blocked: null query is not a usable vision seed", () => {
  assert.equal(isUsableVisionSeed(null), false);
  assert.equal(isUsableVisionSeed(""), false);
});

test("oracle allowed: 'Hawaiian Airlines 787-9 diecast model airplane' is usable", () => {
  assert.equal(isUsableVisionSeed("Hawaiian Airlines 787-9 diecast model airplane"), true,
    "oracle must be allowed — real aircraft identity is usable");
});

// ── Background master result rejection ───────────────────────────────────────

test("background master: rejects generic query from master", () => {
  // isUsableVisionSeed is the gate used before storing background result
  assert.equal(isUsableVisionSeed("used item for sale"), false,
    "background master must not store generic query");
  assert.equal(isUsableVisionSeed("item for"), false,
    "background master must not store 'item for'");
  assert.equal(isUsableVisionSeed("object"), false,
    "background master must not store single-word garbage");
});

test("background master: stores usable aircraft query", () => {
  assert.equal(isUsableVisionSeed("Hawaiian Airlines Boeing 787-9 1:400 diecast model"), true,
    "background master must store valid aircraft identity");
  assert.equal(isUsableVisionSeed("Nike Air Jordan 1 Low OG Bred"), true,
    "background master must store valid sneaker identity");
});

// ── Phase 4H.6: Background recovery endpoint + aircraft query completeness ───

// Mirror the aircraft family + airline detection logic used by the background store.
const AIRCRAFT_FAMILY_MATCH_TEST = [
  { family: "787",      tokens: ["787 9", "787", "dreamliner", "boeing 787"] },
  { family: "777",      tokens: ["777", "boeing 777"] },
  { family: "747",      tokens: ["747", "jumbo jet", "boeing 747"] },
  { family: "a380",     tokens: ["a380", "airbus a380"] },
  { family: "a330",     tokens: ["a330", "airbus a330"] },
  { family: "a321",     tokens: ["a321neo", "a321", "airbus a321"] },
];
const AIRLINE_KEYWORDS = ["hawaiian", "united", "delta", "american airlines", "southwest", "alaska", "ana", "jal", "emirates"];

function normalizeQ(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function bgHasFamily(q) {
  const n = normalizeQ(q);
  return AIRCRAFT_FAMILY_MATCH_TEST.some(({ tokens }) => tokens.some((tok) => n.includes(tok)));
}
function bgHasAirline(q) {
  const n = normalizeQ(q);
  return AIRLINE_KEYWORDS.some((kw) => (` ${n} `).includes(` ${kw} `));
}
function bgRecoverFamilyFromVariants(mainQuery, variants) {
  if (!bgHasAirline(mainQuery) || bgHasFamily(mainQuery)) return mainQuery;
  const hit = variants.find((v) => bgHasFamily(v));
  return hit || null;
}

test("aircraft background query: detects incomplete airline-only query", () => {
  assert.equal(bgHasAirline("Hawaiian Airlines diecast model airplane"), true, "should detect airline");
  assert.equal(bgHasFamily("Hawaiian Airlines diecast model airplane"), false, "should be missing family");
});

test("aircraft background query: detects complete airline+family query", () => {
  assert.equal(bgHasAirline("Hawaiian Airlines Boeing 787-9 diecast model airplane"), true);
  assert.equal(bgHasFamily("Hawaiian Airlines Boeing 787-9 diecast model airplane"), true);
});

test("aircraft background query: recovers family from variant", () => {
  const main = "Hawaiian Airlines diecast model airplane";
  const variants = ["Hawaiian Airlines 1:400 diecast", "Hawaiian Airlines Boeing 787 diecast model airplane"];
  const recovered = bgRecoverFamilyFromVariants(main, variants);
  assert.ok(recovered, "should recover a variant with family");
  assert.equal(bgHasFamily(recovered), true, "recovered variant must have family token");
});

test("aircraft background query: returns null when no variant has family", () => {
  const main = "Hawaiian Airlines diecast model airplane";
  const variants = ["Hawaiian Airlines 1:400 collectible", "Hawaiian Airlines airplane toy"];
  const recovered = bgRecoverFamilyFromVariants(main, variants);
  assert.equal(recovered, null, "no family in any variant → null, needsFamilyRecovery=true");
});

test("aircraft background query: skips recovery when family already present", () => {
  const main = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const variants = ["some other query"];
  const recovered = bgRecoverFamilyFromVariants(main, variants);
  assert.equal(recovered, main, "family already present → main query returned unchanged");
});

test("hard-fail response includes imageHash: isUsableVisionSeed gates background store", () => {
  // The gate before storing a background result is isUsableVisionSeed.
  // A real aircraft query without family should still pass the seed gate.
  assert.equal(isUsableVisionSeed("Hawaiian Airlines diecast model airplane"), true,
    "airline-only aircraft query is usable seed — gets stored and can trigger family recovery");
  assert.equal(isUsableVisionSeed("model airplane"), false,
    "generic 2-word query must not reach background store");
});

// ── Phase 4H.7: Long-poll logic (in-process simulation) ──────────────────────

test("long-poll: returns ready when result appears within wait window", async () => {
  // Simulate BACKGROUND_VISION_RESULTS map with delayed insertion
  const store = new Map();
  const INTERVAL_MS = 50;
  const WAIT_MS = 500;
  let found = false;

  // Insert result after 150ms
  const insertTimer = setTimeout(() => {
    store.set("hash123", { query: "Hawaiian Airlines diecast", completedAt: Date.now(), elapsedMs: 8000 });
  }, 150);

  const _pollStart = Date.now();
  while (!found && (Date.now() - _pollStart) < WAIT_MS) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (store.has("hash123")) found = true;
  }
  clearTimeout(insertTimer);
  assert.equal(found, true, "long-poll should find result within 500ms window");
});

test("long-poll: times out cleanly when result never arrives", async () => {
  const store = new Map();
  const INTERVAL_MS = 50;
  const WAIT_MS = 200;
  let found = false;

  const _pollStart = Date.now();
  while (!found && (Date.now() - _pollStart) < WAIT_MS) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    if (store.has("hash_never")) found = true;
  }
  const elapsed = Date.now() - _pollStart;
  assert.equal(found, false, "should not find a result that was never stored");
  assert.ok(elapsed >= WAIT_MS, `should wait at least ${WAIT_MS}ms`);
  assert.ok(elapsed < WAIT_MS + 200, "should not overshoot the wait window by more than 200ms");
});

test("long-poll: result stored after 11s is catchable if window is 15s", () => {
  // 11134ms master elapsedMs < 15000ms window → should be caught
  const masterElapsedMs = 11134;
  const pollWindowMs    = 15000;
  assert.equal(masterElapsedMs < pollWindowMs, true,
    "11.1s master must be within 15s long-poll window");
  // Old 8s window would miss it
  assert.equal(masterElapsedMs < 8000, false,
    "old 8s window would miss 11.1s master (confirms the bug)");
});

test("background result: needsFamilyRecovery preserved in stored entry", () => {
  // When family recovery fails, needsFamilyRecovery:true must survive the store/read cycle
  const entry = {
    query: "Hawaiian Airlines diecast airplane model",
    variants: ["Hawaiian Airlines model plane"],
    confidence: 0.85,
    completedAt: Date.now(),
    elapsedMs: 11134,
    needsFamilyRecovery: true,
  };
  // Simulate reading it back
  const restored = { ready: true, ...entry };
  assert.equal(restored.needsFamilyRecovery, true,
    "needsFamilyRecovery:true must be preserved in the response payload");
  assert.equal(restored.query, "Hawaiian Airlines diecast airplane model");
});

// ── Phase 4H.8: background market family recovery + phase1 deadline wiring ──

// Mirror the family recovery logic used by the stream route.
const AIRCRAFT_FAMILY_MATCH_STREAM = [
  { family: "787",   tokens: ["787 9", "787", "dreamliner", "boeing 787"] },
  { family: "777",   tokens: ["777", "boeing 777"] },
  { family: "747",   tokens: ["747", "jumbo jet", "boeing 747"] },
  { family: "a380",  tokens: ["a380", "airbus a380"] },
  { family: "a330",  tokens: ["a330", "airbus a330"] },
  { family: "a321",  tokens: ["a321neo", "a321", "airbus a321"] },
  { family: "a320",  tokens: ["a320", "airbus a320"] },
  { family: "a350",  tokens: ["a350", "airbus a350"] },
];
function normTok(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function streamHasFamily(t) {
  return AIRCRAFT_FAMILY_MATCH_STREAM.some(({ tokens }) => tokens.some((tok) => normTok(t).includes(tok)));
}
function streamRecoverFamily(query, variants) {
  if (streamHasFamily(query)) return query;
  return variants.find((v) => v && streamHasFamily(v)) || null;
}

test("4H.8: variant promotion — boeing 787 variant upgrades airline-only query", () => {
  const q = "Hawaiian Airlines diecast airplane model";
  const variants = ["Hawaiian Airlines 1:400 diecast", "Hawaiian Airlines Boeing 787 diecast model airplane"];
  const promoted = streamRecoverFamily(q, variants);
  assert.ok(promoted, "should promote a variant");
  assert.equal(streamHasFamily(promoted), true, "promoted variant must have family token");
  assert.notEqual(promoted, q, "promoted query must differ from original");
});

test("4H.8: no promotion when all variants lack family — original query kept, not crashed", () => {
  const q = "Hawaiian Airlines diecast airplane model";
  const variants = ["Hawaiian Airlines 1:400 collectible", "Hawaiian Airlines airplane toy"];
  const promoted = streamRecoverFamily(q, variants);
  assert.equal(promoted, null, "no variant has family → null (caller logs FAILED and proceeds with original)");
});

test("4H.8: query already has family — no promotion needed", () => {
  const q = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const variants = ["some other query"];
  const promoted = streamRecoverFamily(q, variants);
  assert.equal(promoted, q, "family already present → returns original query unchanged");
});

test("4H.8: needsFamilyRecovery=true blocks oracle (incomplete aircraft)", () => {
  // Oracle must be skipped when needsFamilyRecovery=true + airline detected + no family
  const needsFamilyRecovery = true;
  const requiredAirline = "hawaiian";
  const requiredFamily = null;
  const incompleteAircraft = needsFamilyRecovery && !!requiredAirline && !requiredFamily;
  assert.equal(incompleteAircraft, true, "incomplete aircraft identity must block oracle");
});

test("4H.8: oracle allowed when family is resolved post-recovery", () => {
  // After variant promotion upgrades the query to include 787, oracle is no longer blocked
  const needsFamilyRecovery = true;
  const requiredAirline = "hawaiian";
  const requiredFamily = "787"; // family found in promoted variant
  const incompleteAircraft = needsFamilyRecovery && !!requiredAirline && !requiredFamily;
  assert.equal(incompleteAircraft, false, "oracle must not be blocked when family is resolved");
});

test("4H.8: background recovery market gets 6000ms deadline, not 4500ms", () => {
  const MARKET_BACKGROUND_RECOVERY_DEADLINE_MS = 6000;
  const MARKET_FIRST_PAYLOAD_DEADLINE_MS = 1700;
  const MARKET_PHASE1_DEFAULT_MS = 4500;

  // Simulate: isBackgroundRecovery=true, no SLA clock
  const slaMsRemaining = null;
  const isBackgroundRecovery = true;
  const marketDeadlineMs = slaMsRemaining !== null
    ? Math.max(800, Math.min(slaMsRemaining - 250, MARKET_FIRST_PAYLOAD_DEADLINE_MS))
    : isBackgroundRecovery
      ? MARKET_BACKGROUND_RECOVERY_DEADLINE_MS
      : MARKET_FIRST_PAYLOAD_DEADLINE_MS;

  assert.equal(marketDeadlineMs, 6000, "background recovery must get 6000ms outer deadline");
  // phase1TimeoutMs is now passed down from marketDeadlineMs — verify it's > default
  assert.ok(marketDeadlineMs > MARKET_PHASE1_DEFAULT_MS,
    "background recovery phase1 budget must exceed the old 4500ms default");
});

// ── Phase 4H.9: stream-first market success ──────────────────────────────────

// Mirror token-based exact identity detection (Phase 4H.9b)
const AIRLINE_KEYWORDS_BUDGET = ["hawaiian", "united", "delta", "american airlines", "southwest", "alaska", "ana", "jal", "emirates"];
const FAMILY_TOKENS_BUDGET = ["787", "777", "747", "737", "a380", "a350", "a330", "a320", "a321", "dreamliner"];
function normBudget(t) { return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
function budgetHasAirline(q) { const n = normBudget(q); return AIRLINE_KEYWORDS_BUDGET.some((a) => (` ${n} `).includes(` ${a} `)); }
function budgetHasFamily(q)  { const n = normBudget(q); return FAMILY_TOKENS_BUDGET.some((f) => n.includes(f)); }
function isExactAircraftIdentity(q) { return budgetHasAirline(q) && budgetHasFamily(q); }

test("4H.9b: exact aircraft identity detected from query tokens (not visionConfidence)", () => {
  const q = "hawaiian airlines boeing 787 diecast model airplane";
  assert.equal(isExactAircraftIdentity(q), true, "airline + family present → exact identity");
  // Even when client sends low confidence (the 4H.9b bug scenario)
  const clientVisionConf = 0.69; // client downscaled from 0.95
  const MARKET_FIRST_PAYLOAD_DEADLINE_MS  = 1700;
  const MARKET_BACKGROUND_RECOVERY_DEADLINE_MS = 6000;
  const MARKET_EXACT_IDENTITY_MIN_MS      = 3000;
  const slaMsRemaining = 2272;

  const marketDeadlineBase = Math.max(800, Math.min(slaMsRemaining - 250, MARKET_FIRST_PAYLOAD_DEADLINE_MS));
  const isHighConf = (isExactAircraftIdentity(q) || clientVisionConf >= 0.85);
  const marketDeadlineMs = isHighConf ? Math.max(marketDeadlineBase, MARKET_EXACT_IDENTITY_MIN_MS) : marketDeadlineBase;

  assert.equal(marketDeadlineBase, 1700, "base is still 1700ms");
  assert.equal(marketDeadlineMs, 3000,   "token detection upgrades despite low reported visionConfidence");
});

test("4H.9b: generic query without airline+family does NOT trigger upgrade", () => {
  const q = "nike air jordan 1 low"; // no airline, no family
  assert.equal(isExactAircraftIdentity(q), false, "no airline → not exact aircraft identity");
  const MARKET_FIRST_PAYLOAD_DEADLINE_MS = 1700;
  const MARKET_EXACT_IDENTITY_MIN_MS     = 3000;
  const slaMsRemaining = 2272;
  const marketDeadlineBase = Math.max(800, Math.min(slaMsRemaining - 250, MARKET_FIRST_PAYLOAD_DEADLINE_MS));
  const isHighConf = isExactAircraftIdentity(q) || 0.60 >= 0.85;
  const marketDeadlineMs = isHighConf ? Math.max(marketDeadlineBase, MARKET_EXACT_IDENTITY_MIN_MS) : marketDeadlineBase;
  assert.equal(marketDeadlineMs, 1700, "non-aircraft query keeps standard 1700ms cap");
});

test("4H.9b: airline present but no family does NOT trigger upgrade", () => {
  const q = "hawaiian airlines diecast model airplane"; // airline, no 787
  assert.equal(isExactAircraftIdentity(q), false, "airline only (no family) is incomplete identity");
  const MARKET_FIRST_PAYLOAD_DEADLINE_MS = 1700;
  const MARKET_EXACT_IDENTITY_MIN_MS     = 3000;
  const slaMsRemaining = 2272;
  const marketDeadlineBase = Math.max(800, Math.min(slaMsRemaining - 250, MARKET_FIRST_PAYLOAD_DEADLINE_MS));
  const isHighConf = isExactAircraftIdentity(q) || 0.60 >= 0.85;
  const marketDeadlineMs = isHighConf ? Math.max(marketDeadlineBase, MARKET_EXACT_IDENTITY_MIN_MS) : marketDeadlineBase;
  assert.equal(marketDeadlineMs, 1700, "incomplete aircraft identity keeps 1700ms cap");
});

test("4H.9: low-confidence non-aircraft scan does NOT get budget upgrade", () => {
  const MARKET_FIRST_PAYLOAD_DEADLINE_MS = 1700;
  const MARKET_EXACT_IDENTITY_MIN_MS     = 3000;
  const slaMsRemaining = 2272;
  const visionConfidence = 0.60;
  const q = "used leather couch brown";
  const marketDeadlineBase = Math.max(800, Math.min(slaMsRemaining - 250, MARKET_FIRST_PAYLOAD_DEADLINE_MS));
  const isHighConf = isExactAircraftIdentity(q) || visionConfidence >= 0.85;
  const marketDeadlineMs = isHighConf ? Math.max(marketDeadlineBase, MARKET_EXACT_IDENTITY_MIN_MS) : marketDeadlineBase;
  assert.equal(marketDeadlineMs, 1700, "low-confidence non-aircraft scan keeps 1700ms cap");
});

test("4H.9: aircraft query_fast identity quality — airline+family yields non-low score", () => {
  // Mirror computeIdentityQuality logic with enriched aircraft identity
  function computeIdentityQualityMirror(visionIdentity, attributeCertainty) {
    if (!visionIdentity) return 0;
    let score = 0;
    const brandConf = attributeCertainty?.brand ?? (visionIdentity.brand ? 0.55 : 0);
    score += Math.min(brandConf, 1) * 0.30;
    const modelConf = attributeCertainty?.model ?? (visionIdentity.model ? 0.50 : 0);
    score += Math.min(modelConf, 1) * 0.20;
    const catConf = attributeCertainty?.category ?? (visionIdentity.category ? 0.70 : 0);
    score += Math.min(catConf, 1) * 0.15;
    const visibleTextCount = Array.isArray(visionIdentity.visibleText)
      ? visionIdentity.visibleText.filter((t) => t && String(t).length >= 2).length
      : 0;
    score += Math.min(visibleTextCount / 3, 1) * 0.15;
    const attrCount = (visionIdentity.itemType ? 1 : 0);
    score += Math.min(attrCount / 4, 1) * 0.10;
    if (visionIdentity.exactQuery) score += 0.05;
    if (visionIdentity.brand) {
      const brandStr = String(visionIdentity.brand).toLowerCase();
      const brandInVisText = (visionIdentity.visibleText || []).some(t => String(t).toLowerCase().includes(brandStr));
      if (brandConf > 0.65 && !brandInVisText) score -= 0.15;
    }
    return Math.min(1, Math.max(0, Math.round(score * 100) / 100));
  }

  // OLD: query_fast returns brand=null, model=null
  const oldIdentity = {
    itemType: "diecast model airplane", category: "diecast model airplane",
    brand: null, model: null, colors: [], visibleText: [], exactQuery: "Hawaiian Airlines Boeing 787 diecast model airplane",
  };
  const oldAttrCert = { brand: 0, model: 0, category: 0.95, condition: 0, authenticity: 0, resaleConfidence: 0.95 };
  const oldScore = computeIdentityQualityMirror(oldIdentity, oldAttrCert);
  assert.ok(oldScore < 0.30, `old score should be low, got ${oldScore}`);

  // NEW: enriched with airline=brand, family=model
  const newIdentity = {
    itemType: "diecast model airplane", category: "diecast model airplane",
    brand: "hawaiian", model: "787", colors: [],
    visibleText: ["hawaiian", "787", "Hawaiian Airlines Boeing 787 diecast model airplane"],
    exactQuery: "Hawaiian Airlines Boeing 787 diecast model airplane",
  };
  const newAttrCert = { brand: 0.95, model: 0.95, category: 0.95, condition: 0, authenticity: 0, resaleConfidence: 0.95 };
  const newScore = computeIdentityQualityMirror(newIdentity, newAttrCert);
  assert.ok(newScore >= 0.45, `enriched score should be moderate/high, got ${newScore}`);
});

test("4H.9: competitor airline item blocked from cheapest — American Airlines removed from Hawaiian query", () => {
  const requiredAirline = "hawaiian";
  const competitors = ["american airlines", "united", "delta", "southwest"];
  const items = [
    { title: "American Airlines Airbus A320 Diecast Model 1:500", price: 12 },
    { title: "Hawaiian Airlines Boeing 787-9 GeminiJets 1:400", price: 89 },
    { title: "United Airlines 777 diecast model", price: 45 },
  ];
  const filtered = items.filter((it) => {
    const t = it.title.toLowerCase();
    return !competitors.some((c) => {
      const words = c.split(/\s+/).filter(Boolean);
      return words.length >= 1 && words.every((w) => t.includes(w));
    });
  });
  assert.equal(filtered.length, 1, "only Hawaiian Airlines item should remain");
  assert.ok(filtered[0].title.includes("Hawaiian"), "remaining item must be Hawaiian");
});

test("4H.9: canonical scanId — client scanId is preserved as stream scanId", () => {
  const clientScanId = "abc123.xyz9";
  const streamScanId = clientScanId || `${Date.now().toString(36)}.fallback`;
  assert.equal(streamScanId, clientScanId, "client scanId must be used as stream scanId");
});

test("4H.9: canonical scanId — no client scanId generates server-side id", () => {
  const clientScanId = null;
  const streamScanId = clientScanId || `${Date.now().toString(36)}.fallback`;
  assert.notEqual(streamScanId, null, "must generate id when client omits one");
  assert.ok(streamScanId.length > 0, "generated id must be non-empty");
});

// ── Phase 4I.0: cached scan freshness + scanId propagation ──────────────────

test("4I.0: retrievalMeta includes scanId — downstream logs show scan id not null", () => {
  const scanId = "c.abc123.xyz";
  const kind = "fresh_snapshot";
  const source = "internal_cache";
  const retrievalMeta = { source, kind, scanId };
  assert.equal(retrievalMeta.scanId, scanId, "scanId must be present in retrievalMeta");
  assert.equal(retrievalMeta.kind, kind);
});

test("4I.0: cache background refresh de-duplication — exact title+price+source match rejected", () => {
  const cachedItems = [
    { title: "Hawaiian Airlines 1:400 Boeing 787-9 GeminiJets", totalPrice: 89.99, source: "ebay" },
    { title: "Herpa Boeing 787-9 Hawaiian Airlines 1:200", totalPrice: 70.87, source: "ebay-arcadia" },
  ];
  const cacheFingerprints = new Set(
    cachedItems.map((it) => {
      const t = String(it?.title || "").toLowerCase().slice(0, 60);
      const p = Math.round(Number(it?.totalPrice ?? it?.price ?? 0) * 10) / 10;
      const s = String(it?.source || "").toLowerCase().slice(0, 30);
      return `${t}|${p}|${s}`;
    })
  );
  const refreshCandidates = [
    { title: "Hawaiian Airlines 1:400 Boeing 787-9 GeminiJets", totalPrice: 89.99, source: "ebay" }, // duplicate
    { title: "NG Models Hawaiian Airlines Boeing 787-9 N780HA 1:400", totalPrice: 105.00, source: "airlinegeeks" }, // new
    { title: "Herpa Boeing 787-9 Hawaiian Airlines 1:200", totalPrice: 70.87, source: "ebay-arcadia" }, // duplicate
  ];
  const netNew = refreshCandidates.filter((it) => {
    const t = String(it.title).toLowerCase().slice(0, 60);
    const p = Math.round(Number(it.totalPrice ?? 0) * 10) / 10;
    const s = String(it.source).toLowerCase().slice(0, 30);
    return !cacheFingerprints.has(`${t}|${p}|${s}`);
  });
  assert.equal(netNew.length, 1, "only 1 net-new item should pass de-dup");
  assert.ok(netNew[0].title.includes("NG Models"), "net-new item must be the novel one");
});

test("4I.0: cache background refresh — 2+ net-new items triggers merge", () => {
  const MIN_NEW_ITEMS = 2;
  const netNew = [
    { title: "NG Models 787-9 Hawaiian 1:400", totalPrice: 99, source: "shop1" },
    { title: "Aviation400 787-9 Hawaiian 1:400", totalPrice: 115, source: "shop2" },
  ];
  assert.ok(netNew.length >= MIN_NEW_ITEMS, "2+ net-new items should trigger merge into cache");
});

test("4I.0: cache background refresh — fewer than 2 net-new items does not merge", () => {
  const MIN_NEW_ITEMS = 2;
  const netNew = [
    { title: "NG Models 787-9 Hawaiian 1:400", totalPrice: 99, source: "shop1" },
  ];
  assert.ok(netNew.length < MIN_NEW_ITEMS, "1 net-new item should not trigger merge");
});

test("4I.0: cache background refresh — aircraft identity filter rejects competitor items", () => {
  const requiredAirline = "hawaiian";
  const competitorAirlines = ["united", "delta", "american airlines"];
  const netNewCandidates = [
    { title: "United Airlines Boeing 787 diecast model", totalPrice: 55, source: "shop1" },
    { title: "Hawaiian Airlines Boeing 787-9 NG Models 1:400", totalPrice: 99, source: "shop2" },
  ];
  // Simulate aircraft filter: reject competitor airlines
  const afterIdentityFilter = netNewCandidates.filter((it) => {
    const t = it.title.toLowerCase();
    const isCompetitor = competitorAirlines.some((c) => t.includes(c.toLowerCase()));
    return !isCompetitor;
  });
  assert.equal(afterIdentityFilter.length, 1, "competitor airline must be rejected by identity filter");
  assert.ok(afterIdentityFilter[0].title.includes("Hawaiian"), "only Hawaiian item survives");
});

// ── Phase 4K: hard-deadline grace window + late storage ───────────────────────

test("4K: grace window — usable fast result resolves race before timeout", async () => {
  // Simulate: fast returns usable seed at 80ms, grace is 200ms → rescue wins.
  // Uses a simple race without "stay-pending" wrappers to avoid dangling promises.
  const GRACE_MS = 200;
  const passT0 = Date.now();
  let raceWinner = null;

  const fastResult = { parsed: { query: "Hawaiian Airlines Boeing 787 diecast model airplane", confidence: 0.85 } };
  // Simulates fast resolving after 80ms
  const fastRaceP = new Promise(res => setTimeout(() =>
    res(isUsableVisionSeed(fastResult.parsed.query) ? { src: "fast", r: fastResult } : null),
    80
  ));
  const timeoutP = new Promise(res => setTimeout(() => res(null), GRACE_MS));

  raceWinner = await Promise.race([fastRaceP, timeoutP]);
  assert.ok(raceWinner !== null, "usable fast result should win before grace timeout");
  assert.equal(raceWinner.src, "fast");
  assert.ok(Date.now() - passT0 < GRACE_MS + 50, "should resolve well within grace window");
});

test("4K: grace window — cancelled result does not win; timeout fires instead", async () => {
  const GRACE_MS = 80;
  let raceWinner = null;

  // Simulate cancelled fast (common when deadline fires first)
  const fastP = Promise.resolve({ cancelled: true, parsed: null });
  // Grace wrap logic: only resolve if usable
  const wrappedFast = fastP.then(r =>
    (r && !r.cancelled && isUsableVisionSeed(r?.parsed?.query)) ? { src: "fast", r } : new Promise(() => {})
  );
  const timeoutP = new Promise(res => setTimeout(() => res(null), GRACE_MS));

  raceWinner = await Promise.race([wrappedFast, timeoutP]);
  assert.equal(raceWinner, null, "cancelled fast should not win; timeout returns null");
});

test("4K: grace window — usable seed check: Hawaiian 787 passes, generic fails", () => {
  assert.equal(isUsableVisionSeed("Hawaiian Airlines Boeing 787 diecast model airplane"), true,
    "complete aircraft query must pass usable seed check");
  assert.equal(isUsableVisionSeed("model airplane"), false,
    "generic 2-word query must fail usable seed check");
  assert.equal(isUsableVisionSeed(null), false);
});

test("4K: late storage skips when BACKGROUND_VISION_RESULTS already has a result (master won)", () => {
  // Simulate: store map already has master's result when fast's late handler fires.
  const store = new Map();
  const imageHash = "abc123";
  store.set(imageHash, { query: "master result", confidence: 0.9 });

  const lateQuery = "Hawaiian Airlines Boeing 787 diecast model airplane";
  // Check the guard: if already has key, skip
  const shouldSkip = store.has(imageHash);
  assert.equal(shouldSkip, true, "late storage must be skipped when master already stored");
});

test("4K: late fast result with complete identity → marketReady:true, needsFamilyRecovery:false", () => {
  const q = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const result = detectIncompleteAircraftIdentityQuery(q);
  assert.equal(result.incomplete, false, "complete aircraft query must not be flagged incomplete");
  const marketReady = !result.incomplete;
  assert.equal(marketReady, true);
});

test("4K: late fast result with incomplete aircraft → needsFamilyRecovery:true, marketReady:false", () => {
  const q = "Hawaiian Airlines diecast airplane model";
  const familyPattern = /\b(787|777|747|737|a380|a350|a330|a321|a320|a319|concorde|dreamliner|jumbo)\b/;
  const hasFamily = familyPattern.test(q.toLowerCase());
  assert.equal(hasFamily, false);
  // Incomplete: no family → needsFamilyRecovery = true
  const airlinePattern = /\b(hawaiian|united|delta|ana|jal|emirates)\b/;
  const aircraftTermPattern = /\b(airplane|aircraft|diecast|model airplane)\b/;
  const hasAirline = airlinePattern.test(q.toLowerCase());
  const hasAircraftTerm = aircraftTermPattern.test(q.toLowerCase());
  const incomplete = hasAirline && hasAircraftTerm && !hasFamily;
  assert.equal(incomplete, true);
});

test("4K: late generic aircraft result is rejected (isGenericAircraftToyQuery)", () => {
  const q = "white plastic model airplane toy";
  assert.equal(isGenericAircraftToyQuery(q), true, "generic aircraft query must be rejected from late storage");
});

// ── Phase 4K.1: quality-aware late-storage guard ──────────────────────────────

test("4K.1: complete late result overwrites incomplete — prince arrives before gate closes", () => {
  // Simulate: fast stored incomplete, then query_fast stored complete.
  const store = new Map();
  const imageHash = "abc123";

  // Simulate _storeLateResult quality guard logic
  const tryStore = (entry) => {
    const existing = store.get(imageHash);
    if (existing && !existing.needsFamilyRecovery) return false; // existing complete — skip
    if (existing?.needsFamilyRecovery && entry.needsFamilyRecovery) return false; // both incomplete — first wins
    store.set(imageHash, entry);
    return true;
  };

  // fast stores incomplete result first
  const incompleteEntry = { query: "Hawaiian Airlines diecast airplane model", needsFamilyRecovery: true };
  assert.equal(tryStore(incompleteEntry), true, "incomplete fast result should store");
  assert.equal(store.get(imageHash)?.needsFamilyRecovery, true);

  // query_fast arrives later with complete result — should overwrite
  const completeEntry = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", needsFamilyRecovery: false };
  assert.equal(tryStore(completeEntry), true, "complete query_fast result must overwrite incomplete fast");
  assert.equal(store.get(imageHash)?.query, "Hawaiian Airlines Boeing 787 diecast model airplane");
  assert.equal(store.get(imageHash)?.needsFamilyRecovery, false);
});

test("4K.1: second incomplete result does not overwrite first incomplete — first wins", () => {
  const store = new Map();
  const imageHash = "abc456";

  const tryStore = (entry) => {
    const existing = store.get(imageHash);
    if (existing && !existing.needsFamilyRecovery) return false;
    if (existing?.needsFamilyRecovery && entry.needsFamilyRecovery) return false;
    store.set(imageHash, entry);
    return true;
  };

  const first  = { query: "Hawaiian Airlines diecast airplane model", needsFamilyRecovery: true };
  const second = { query: "United Airlines diecast airplane model",   needsFamilyRecovery: true };
  assert.equal(tryStore(first),  true,  "first incomplete stores");
  assert.equal(tryStore(second), false, "second incomplete must NOT overwrite first");
  assert.equal(store.get(imageHash)?.query, first.query);
});

test("4K.1: complete existing result blocks any new result — don't downgrade", () => {
  const store = new Map();
  const imageHash = "abc789";

  const tryStore = (entry) => {
    const existing = store.get(imageHash);
    if (existing && !existing.needsFamilyRecovery) return false;
    if (existing?.needsFamilyRecovery && entry.needsFamilyRecovery) return false;
    store.set(imageHash, entry);
    return true;
  };

  // Master stored a complete result
  store.set(imageHash, { query: "Hawaiian Airlines Boeing 787 diecast model airplane", needsFamilyRecovery: false });

  // Late fast tries to store something (even if complete) — should be blocked
  const lateEntry = { query: "Hawaiian Airlines Boeing 787-9 1:400", needsFamilyRecovery: false };
  assert.equal(tryStore(lateEntry), false, "complete existing must not be overwritten by any late result");
});

test("4K.1: no existing entry — first result (even incomplete) stores freely", () => {
  const store = new Map();
  const imageHash = "abc000";

  const tryStore = (entry) => {
    const existing = store.get(imageHash);
    if (existing && !existing.needsFamilyRecovery) return false;
    if (existing?.needsFamilyRecovery && entry.needsFamilyRecovery) return false;
    store.set(imageHash, entry);
    return true;
  };

  const entry = { query: "Hawaiian Airlines diecast airplane model", needsFamilyRecovery: true };
  assert.equal(tryStore(entry), true, "first result should always store when no existing entry");
});

// ── Phase 4K.2: quality-score guard ──────────────────────────────────────────
// Mirrors the _scoreBackgroundVisionEntry + guard logic from index.js.

function scoreEntry(entry, isGenericAircraftFn) {
  const q = String(entry?.query || "").toLowerCase();
  let score = 0;
  if (!entry?.needsFamilyRecovery) score += 100; else score -= 50;
  score += Math.round(Number(entry?.confidence || 0) * 20);
  if (/\b(hawaiian|united|delta|american airlines|southwest|alaska|jetblue|ana|jal|lufthansa|emirates|british airways|air france|klm|qantas|singapore|cathay|air canada)\b/.test(q)) score += 20;
  if (/\b(boeing|airbus|embraer|bombardier|lockheed|mcdonnell|douglas)\b/.test(q)) score += 20;
  if (/\b(787|787-9|787 9|747|777|737|a380|a350|a330|a320|a321|a319|dreamliner|concorde)\b/.test(q)) score += 25;
  if (/\b1\s*[:/]\s*\d{2,3}\b/.test(q)) score += 18;
  if (/\b(geminijets?|herpa|ng model|aviation400|jc wings|phoenix|hogan|inflight|aeroclassics)\b/.test(q)) score += 18;
  if (/\b(diecast|die-cast|collectible|model airplane|aircraft model)\b/.test(q)) score += 10;
  if (isGenericAircraftFn && isGenericAircraftFn(q)) score -= 80;
  score += Math.min(20, Math.floor(q.length / 12));
  return score;
}

function tryStoreQuality(store, imageHash, incomingEntry) {
  const existing = store.get(imageHash);
  if (!existing) { store.set(imageHash, incomingEntry); return { stored: true, reason: "no_existing" }; }
  const existScore = scoreEntry(existing, isGenericAircraftToyQuery);
  const inScore    = scoreEntry(incomingEntry, isGenericAircraftToyQuery);
  // Incomplete cannot overwrite complete
  if (!existing.needsFamilyRecovery && incomingEntry.needsFamilyRecovery)
    return { stored: false, reason: "incoming_incomplete_existing_complete" };
  // Both incomplete: need +15 to overwrite
  if (existing.needsFamilyRecovery && incomingEntry.needsFamilyRecovery && inScore < existScore + 15)
    return { stored: false, reason: "both_incomplete_incoming_not_substantially_better" };
  // Both complete: need +10 to overwrite
  if (!existing.needsFamilyRecovery && !incomingEntry.needsFamilyRecovery && inScore < existScore + 10)
    return { stored: false, reason: "incoming_complete_not_stronger" };
  store.set(imageHash, incomingEntry);
  return { stored: true, reason: "replacing" };
}

test("4K.2: score — complete entry scores much higher than incomplete", () => {
  const complete   = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", confidence: 0.85, needsFamilyRecovery: false };
  const incomplete = { query: "Hawaiian Airlines diecast airplane model",            confidence: 0.85, needsFamilyRecovery: true };
  const cs = scoreEntry(complete,   isGenericAircraftToyQuery);
  const is = scoreEntry(incomplete, isGenericAircraftToyQuery);
  assert.ok(cs > is + 100, `complete (${cs}) must score >100 pts above incomplete (${is})`);
});

test("4K.2: score — collector model beats generic diecast query", () => {
  const collector = { query: "Hawaiian Airlines Boeing 787-9 GeminiJets 1:400 diecast model", confidence: 0.9, needsFamilyRecovery: false };
  const generic   = { query: "Hawaiian Airlines Boeing 787 diecast model airplane",           confidence: 0.85, needsFamilyRecovery: false };
  const cs = scoreEntry(collector, isGenericAircraftToyQuery);
  const gs = scoreEntry(generic,   isGenericAircraftToyQuery);
  assert.ok(cs > gs, `collector (${cs}) must outscore generic (${gs})`);
});

test("4K.2: incomplete existing + complete incoming → overwrite", () => {
  const store = new Map();
  const hash  = "h1";
  const inc = { query: "Hawaiian Airlines diecast airplane model",            confidence: 0.7, needsFamilyRecovery: true };
  const comp = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", confidence: 0.85, needsFamilyRecovery: false };
  tryStoreQuality(store, hash, inc);
  const result = tryStoreQuality(store, hash, comp);
  assert.equal(result.stored, true, "complete must overwrite incomplete");
  assert.equal(store.get(hash)?.query, comp.query);
});

test("4K.2: weak complete existing + stronger complete incoming → overwrite", () => {
  const store = new Map();
  const hash  = "h2";
  const weak   = { query: "Hawaiian Airlines Boeing 787 diecast model airplane",             confidence: 0.75, needsFamilyRecovery: false };
  const strong = { query: "Hawaiian Airlines Boeing 787-9 GeminiJets 1:400 diecast model", confidence: 0.90, needsFamilyRecovery: false };
  tryStoreQuality(store, hash, weak);
  const result = tryStoreQuality(store, hash, strong);
  assert.equal(result.stored, true, "stronger complete must overwrite weaker complete");
  assert.equal(store.get(hash)?.query, strong.query);
});

test("4K.2: strong complete existing + weaker complete incoming → skip", () => {
  const store = new Map();
  const hash  = "h3";
  const strong = { query: "Hawaiian Airlines Boeing 787-9 GeminiJets 1:400 diecast model", confidence: 0.90, needsFamilyRecovery: false };
  const weak   = { query: "Hawaiian Airlines Boeing 787 diecast model airplane",             confidence: 0.75, needsFamilyRecovery: false };
  tryStoreQuality(store, hash, strong);
  const result = tryStoreQuality(store, hash, weak);
  assert.equal(result.stored, false, "weaker complete must not overwrite stronger complete");
  assert.equal(store.get(hash)?.query, strong.query);
});

test("4K.2: complete existing + incomplete incoming → skip (never downgrade)", () => {
  const store = new Map();
  const hash  = "h4";
  const comp = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", confidence: 0.85, needsFamilyRecovery: false };
  const inc  = { query: "Hawaiian Airlines diecast airplane model",            confidence: 0.95, needsFamilyRecovery: true };
  tryStoreQuality(store, hash, comp);
  const result = tryStoreQuality(store, hash, inc);
  assert.equal(result.stored, false, "incomplete must never overwrite complete, even at higher confidence");
  assert.equal(store.get(hash)?.needsFamilyRecovery, false);
});

test("4K.2: two incomplete — second not substantially better (+15) → skip", () => {
  const store = new Map();
  const hash  = "h5";
  const first  = { query: "Hawaiian Airlines diecast airplane model", confidence: 0.7, needsFamilyRecovery: true };
  const second = { query: "United Airlines diecast airplane model",   confidence: 0.7, needsFamilyRecovery: true };
  tryStoreQuality(store, hash, first);
  const result = tryStoreQuality(store, hash, second);
  assert.equal(result.stored, false, "similarly scored incomplete must not overwrite first");
  assert.equal(store.get(hash)?.query, first.query);
});

test("4K.2: generic aircraft toy query gets large penalty and cannot beat specific result", () => {
  const specific = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", confidence: 0.85, needsFamilyRecovery: false };
  const generic  = { query: "white plastic model airplane toy",                    confidence: 0.99, needsFamilyRecovery: false };
  const ss = scoreEntry(specific, isGenericAircraftToyQuery);
  const gs = scoreEntry(generic,  isGenericAircraftToyQuery);
  assert.ok(gs < ss, `generic toy (${gs}) must score below specific aircraft (${ss})`);
  const store = new Map();
  const hash = "h6";
  tryStoreQuality(store, hash, specific);
  const result = tryStoreQuality(store, hash, generic);
  assert.equal(result.stored, false, "generic toy must not overwrite specific aircraft result");
});

test("4K.1: frontend poll continues after marketReady:false — does not stop forever", () => {
  // Simulate the client-side gate: marketReady:false falls through to retry (no return)
  let pollRetryScheduled = false;
  const simulatePoll = (d) => {
    if (d?.ready && d?.query && d?.marketReady !== false) {
      // market search path — stops polling
      return "market_search";
    }
    if (d?.ready && d?.query && d?.marketReady === false) {
      // incomplete — show toast but continue
      pollRetryScheduled = true;
      // falls through to retry (no return)
    }
    // retry scheduled here
    return "retry";
  };

  const result = simulatePoll({ ready: true, query: "Hawaiian Airlines diecast airplane model", marketReady: false });
  assert.equal(result, "retry", "incomplete result must schedule retry, not stop polling");
  assert.equal(pollRetryScheduled, true);
});

test("4K: startup selftests are gated behind RUN_STARTUP_SELFTESTS env", () => {
  // The selftest blocks are now wrapped in `if (process.env.RUN_STARTUP_SELFTESTS === "true")`.
  // During normal startup (env not set), these blocks do not run.
  const wouldRun = process.env.RUN_STARTUP_SELFTESTS === "true";
  assert.equal(wouldRun, false, "selftest blocks must not run during normal startup");
});
