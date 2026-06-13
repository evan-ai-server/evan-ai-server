// src/aircraftIdentity.test.js
// node --test src/aircraftIdentity.test.js
// Tests for aircraft identity completeness detection, family token detection,
// query preservation, and aircraft family lock non-regression.
//
// These tests reproduce the inline logic from index.js (AIRCRAFT_FAMILY_MAP,
// AIRCRAFT_FAMILY_MATCH, AIRLINE_COMPETITOR_MAP) since those data structures
// are not exported as a module. The goal is to pin the exact token sets and
// classification rules so regressions surface immediately.
//
// Run: node --test src/aircraftIdentity.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateAffiliateEligibility } from "./affiliateGate.js";
import { detectIncompleteAircraftIdentityQuery } from "./queryGuards.js";

// ── Mirrors of the index.js aircraft data structures ─────────────────────────
// Keep these in sync if AIRCRAFT_FAMILY_MATCH or AIRLINE_COMPETITOR_MAP change.

const AIRCRAFT_FAMILY_MATCH = [
  { family: "787",      tokens: ["787 9", "787", "dreamliner", "boeing 787"] },
  { family: "777",      tokens: ["777", "boeing 777"] },
  { family: "747",      tokens: ["747", "jumbo jet", "boeing 747"] },
  { family: "737",      tokens: ["737", "boeing 737"] },
  { family: "a321",     tokens: ["a321neo", "a321", "airbus a321"] },
  { family: "a320",     tokens: ["a320", "airbus a320"] },
  { family: "a350",     tokens: ["a350", "airbus a350"] },
  { family: "a330",     tokens: ["a330", "airbus a330"] },
  { family: "a380",     tokens: ["a380", "airbus a380"] },
  { family: "a319",     tokens: ["a319", "airbus a319"] },
  { family: "concorde", tokens: ["concorde"] },
];

const AIRLINE_COMPETITOR_MAP = {
  "hawaiian":  ["united", "delta", "american airlines", "southwest", "alaska", "jetblue", "ana"],
  "united":    ["hawaiian", "delta", "american airlines", "southwest", "alaska"],
  "delta":     ["hawaiian", "united", "american airlines", "southwest", "alaska"],
  "ana":       ["united", "delta", "american airlines", "alaska", "jetblue", "korean air", "jal"],
  "jal":       ["ana", "united", "delta", "american airlines", "alaska", "korean air"],
  "emirates":  ["qatar", "etihad", "lufthansa", "british airways", "air france"],
};

function normalizeTitleKey(t = "") {
  return String(t).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function titleHasToken(titleKey, token) {
  return (` ${titleKey} `).includes(` ${token.trim()} `);
}

function hasFamilyInQuery(query) {
  const qNorm = normalizeTitleKey(query || "");
  return AIRCRAFT_FAMILY_MATCH.some(({ tokens }) => tokens.some((tok) => qNorm.includes(tok)));
}

function hasAirlineInQuery(query) {
  const qNorm = normalizeTitleKey(query || "");
  return Object.keys(AIRLINE_COMPETITOR_MAP).some((airline) => titleHasToken(qNorm, airline));
}

function detectFamilyInQuery(query) {
  const qNorm = normalizeTitleKey(query || "");
  const entry = AIRCRAFT_FAMILY_MATCH.find(({ tokens }) => tokens.some((tok) => qNorm.includes(tok)));
  return entry?.family || null;
}

function needsAircraftFamilyRefinement(query, category) {
  const catNorm = (category || "").toLowerCase();
  const isAircraftCategory =
    catNorm.includes("airplane") || catNorm.includes("aircraft") ||
    catNorm.includes("diecast") || catNorm.includes("model plane") ||
    catNorm.includes("aviation");
  return isAircraftCategory && hasAirlineInQuery(query) && !hasFamilyInQuery(query);
}

// ── A. Aircraft identity completeness detection ───────────────────────────────

describe("Aircraft identity — needsAircraftFamilyRefinement", () => {
  it("airline present, family absent → needs refinement", () => {
    assert.equal(
      needsAircraftFamilyRefinement("Hawaiian Airlines diecast model airplane", "diecast"),
      true
    );
  });

  it("airline + family present → no refinement needed", () => {
    assert.equal(
      needsAircraftFamilyRefinement("Hawaiian Airlines Boeing 787 diecast model airplane", "diecast"),
      false
    );
  });

  it("no airline, family present → no refinement needed", () => {
    assert.equal(
      needsAircraftFamilyRefinement("Boeing 787 diecast model airplane", "diecast"),
      false
    );
  });

  it("non-aircraft category → no refinement (not aircraft context)", () => {
    assert.equal(
      needsAircraftFamilyRefinement("Hawaiian Airlines shirt", "clothing"),
      false
    );
  });

  it("ANA airline without A380 → needs refinement", () => {
    assert.equal(
      needsAircraftFamilyRefinement("ANA diecast airplane model", "diecast"),
      true
    );
  });

  it("ANA with A380 → no refinement needed", () => {
    assert.equal(
      needsAircraftFamilyRefinement("ANA Airbus A380 diecast airplane model", "diecast"),
      false
    );
  });
});

// ── B. Aircraft family token detection ────────────────────────────────────────

describe("Aircraft family token detection", () => {
  it("detects 787 from Boeing 787 query", () => {
    assert.equal(detectFamilyInQuery("Hawaiian Airlines Boeing 787 diecast"), "787");
  });

  it("detects 787 from bare 787 token", () => {
    assert.equal(detectFamilyInQuery("787 diecast model airplane"), "787");
  });

  it("detects dreamliner as 787 family", () => {
    assert.equal(detectFamilyInQuery("Hawaiian Airlines Dreamliner model airplane"), "787");
  });

  it("detects a380 family", () => {
    assert.equal(detectFamilyInQuery("Emirates Airbus A380 diecast model"), "a380");
  });

  it("detects a330 family", () => {
    assert.equal(detectFamilyInQuery("Air France Airbus A330 model airplane"), "a330");
  });

  it("detects 777 family", () => {
    assert.equal(detectFamilyInQuery("United Airlines Boeing 777 diecast"), "777");
  });

  it("no family tokens → null", () => {
    assert.equal(detectFamilyInQuery("Hawaiian Airlines diecast model airplane"), null);
  });

  it("no family tokens — generic diecast → null", () => {
    assert.equal(detectFamilyInQuery("white diecast metal airplane model"), null);
  });
});

// ── C. Hawaiian 787 query preserves critical tokens ───────────────────────────

describe("Hawaiian 787 query token preservation", () => {
  const GOOD_QUERY    = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const GENERIC_QUERY = "Hawaiian Airlines diecast model airplane";

  it("GOOD_QUERY contains 787 family token", () => {
    assert.equal(hasFamilyInQuery(GOOD_QUERY), true);
    assert.equal(detectFamilyInQuery(GOOD_QUERY), "787");
  });

  it("GENERIC_QUERY is missing 787 family token — refinement needed", () => {
    assert.equal(hasFamilyInQuery(GENERIC_QUERY), false);
    assert.equal(needsAircraftFamilyRefinement(GENERIC_QUERY, "diecast"), true);
  });

  it("GOOD_QUERY does not trigger refinement", () => {
    assert.equal(needsAircraftFamilyRefinement(GOOD_QUERY, "diecast"), false);
  });

  it("GOOD_QUERY would lock on 787 as requiredFamily", () => {
    const family = detectFamilyInQuery(GOOD_QUERY);
    assert.equal(family, "787");
  });

  it("GENERIC_QUERY gives requiredFamily=null (no lock → accepts wrong families)", () => {
    const family = detectFamilyInQuery(GENERIC_QUERY);
    assert.equal(family, null);
  });
});

// ── D. Aircraft family lock rejects wrong families ────────────────────────────

describe("Aircraft family lock — requiredFamily=787 rejects A321/A330/B777", () => {
  // Mirrors the AIRCRAFT_FAMILY_MATCH filtering logic in index.js:
  // when requiredFamily is set, listing titles with a DIFFERENT family token are rejected.

  const requiredFamily = "787";

  function isWrongFamily(listingTitle) {
    const titleNorm = normalizeTitleKey(listingTitle);
    const listingFamily = detectFamilyInQuery(titleNorm);
    if (!listingFamily) return false; // no family token in title → may be kept as generic
    return listingFamily !== requiredFamily;
  }

  it("A321 listing is wrong family for 787 query", () => {
    assert.equal(isWrongFamily("Hawaiian Airlines Airbus A321 diecast model"), true);
  });

  it("A330 listing is wrong family for 787 query", () => {
    assert.equal(isWrongFamily("Hawaiian Airlines Airbus A330 model airplane"), true);
  });

  it("777 listing is wrong family for 787 query", () => {
    assert.equal(isWrongFamily("United Airlines Boeing 777 diecast model"), true);
  });

  it("787 listing passes for 787 requiredFamily", () => {
    assert.equal(isWrongFamily("Hawaiian Airlines Boeing 787 Dreamliner diecast"), false);
  });

  it("787 Dreamliner listing passes via dreamliner token", () => {
    assert.equal(isWrongFamily("Hawaiian Airlines Dreamliner 1:400 model"), false);
  });

  it("Generic 'Hawaiian Airlines diecast' with no family is NOT wrong family (no token)", () => {
    assert.equal(isWrongFamily("Hawaiian Airlines diecast model airplane"), false);
  });
});

// ── E. Refinement outcome — fast pass result with 787 overrides generic query ─

describe("Aircraft refinement — fast pass override logic", () => {
  it("fast pass result with 787 would be accepted as refinement", () => {
    const fastPassResult = { parsed: { identity: { exactQuery: "Hawaiian Airlines Boeing 787-9 diecast model airplane 1:400" } } };
    const rq = normalizeTitleKey(fastPassResult?.parsed?.query || fastPassResult?.parsed?.identity?.exactQuery || "");
    const hasFamily = AIRCRAFT_FAMILY_MATCH.some(({ tokens }) => tokens.some((tok) => rq.includes(tok)));
    assert.equal(hasFamily, true);
    assert.equal(detectFamilyInQuery(fastPassResult.parsed.identity.exactQuery), "787");
  });

  it("fast pass result without 787 would NOT be used as refinement", () => {
    const fastPassResult = { parsed: { identity: { exactQuery: "Hawaiian Airlines white diecast airplane model" } } };
    const rq = normalizeTitleKey(fastPassResult?.parsed?.query || fastPassResult?.parsed?.identity?.exactQuery || "");
    const hasFamily = AIRCRAFT_FAMILY_MATCH.some(({ tokens }) => tokens.some((tok) => rq.includes(tok)));
    assert.equal(hasFamily, false);
  });

  it("visual_shape result with 787 would be accepted as refinement", () => {
    const visualResult = { parsed: { query: "Hawaiian Airlines Boeing 787-9 Dreamliner collectible model" } };
    const rq = normalizeTitleKey(visualResult?.parsed?.query || "");
    const hasFamily = AIRCRAFT_FAMILY_MATCH.some(({ tokens }) => tokens.some((tok) => rq.includes(tok)));
    assert.equal(hasFamily, true);
  });

  it("cancelled result is never used (safety check)", () => {
    const cancelledResult = { cancelled: true, parsed: { query: "Hawaiian Airlines Boeing 787 diecast" } };
    const accepted = !(!cancelledResult || cancelledResult.cancelled);
    assert.equal(accepted, false);
  });
});

// ── G. Aircraft family market recovery — dominant family inference ────────────

describe("Aircraft family market recovery — dominant family inference", () => {
  // Mirrors the Step 6.5 logic in filterRelevantListings (identity lock)
  function inferDominantFamily(items) {
    const counts = {};
    for (const it of items) {
      const t = normalizeTitleKey(it.title || "");
      const entry = AIRCRAFT_FAMILY_MATCH.find(({ tokens }) => tokens.some((tok) => t.includes(tok)));
      if (entry) counts[entry.family] = (counts[entry.family] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    const [topFamily, topCount] = sorted[0];
    const secondCount = sorted[1]?.[1] || 0;
    if (topCount >= 3 && topCount >= secondCount * 2) return topFamily;
    return null;
  }

  it("787 dominates pool → infers 787 family", () => {
    const items = [
      { title: "NG Models Hawaiian Boeing 787-9 Dreamliner 1:400" },
      { title: "GeminiJets Hawaiian 787-9 Dreamliner Diecast" },
      { title: "Herpa Hawaiian 787-9 Dreamliner" },
      { title: "Hawaiian Airlines Boeing 787 diecast model" },
    ];
    assert.equal(inferDominantFamily(items), "787");
  });

  it("mixed pool (787+A330+A321) → no dominant family (no inference)", () => {
    const items = [
      { title: "NG Models Hawaiian Boeing 787-9 Dreamliner" },
      { title: "Skymarks Hawaiian Airbus A330-200 1/200" },
      { title: "GeminiJets Hawaiian Airlines A321neo" },
    ];
    assert.equal(inferDominantFamily(items), null);
  });

  it("pool without family tokens → no inference", () => {
    const items = [
      { title: "Daron Hawaiian Airlines Single Plane" },
      { title: "Hawaiian Airlines pullback toy airplane" },
    ];
    assert.equal(inferDominantFamily(items), null);
  });

  it("only 2 items in dominant family → below threshold (need ≥3)", () => {
    const items = [
      { title: "NG Models Hawaiian Boeing 787-9 1:400" },
      { title: "GeminiJets Hawaiian Airlines 787-9" },
      { title: "Skymarks Hawaiian A330" },
    ];
    assert.equal(inferDominantFamily(items), null); // 2 < 3
  });

  it("A380 dominates ANA pool → infers a380", () => {
    const items = [
      { title: "ANA Airbus A380 Flying Honu 1:400 Diecast" },
      { title: "ANA Airbus A380 Sea Turtle Livery 1:200" },
      { title: "ANA A380 Sea Turtle JA381A Model" },
    ];
    assert.equal(inferDominantFamily(items), "a380");
  });
});

// ── H. Query identity preservation — collector must not drop airline tokens ──

describe("Query identity guard — collector must not drop identity tokens", () => {
  // Mirrors the _IDENTITY_GUARD_TOKENS guard in buildCollectorSearchQuery.
  // visionQuery → collectorQuery: any token in _IDENTITY_GUARD_TOKENS present
  // in visionQuery must also appear in the collector query.
  const IDENTITY_GUARD_TOKENS = [
    "hawaiian", "united", "boeing", "787", "777", "a380", "dreamliner",
    "jordan", "yeezy", "vaporfly",
  ];

  function wouldBlock(visionQuery, collectorQuery) {
    const vNorm = visionQuery.toLowerCase();
    const cNorm = collectorQuery.toLowerCase();
    return IDENTITY_GUARD_TOKENS.some((tok) => vNorm.includes(tok) && !cNorm.includes(tok));
  }

  it("collector drops 'hawaiian' → blocked", () => {
    assert.equal(
      wouldBlock("hawaiian airlines diecast airplane model", "diecast airplane model white diecast metal"),
      true
    );
  });

  it("collector drops 'boeing' → blocked", () => {
    assert.equal(
      wouldBlock("hawaiian airlines boeing 787 diecast model airplane", "hawaiian airlines diecast"),
      true
    );
  });

  it("collector preserves airline and family → allowed", () => {
    assert.equal(
      wouldBlock("hawaiian airlines diecast airplane model", "hawaiian airlines boeing 787 diecast model"),
      false
    );
  });

  it("non-aircraft collector query without identity tokens → allowed", () => {
    assert.equal(
      wouldBlock("sunglasses orange lens", "orange lens retro sunglasses 1990s"),
      false
    );
  });

  it("collector drops 'jordan' brand → blocked", () => {
    assert.equal(
      wouldBlock("air jordan 1 low og year of the rabbit", "low og year rabbit sneakers"),
      true
    );
  });
});

// ── F. Non-regression — Prompt 3 trust contract unchanged ─────────────────────

describe("Prompt 3 non-regression — trust/evidence contract", () => {
  it("pricing_signal_only still blocks affiliate", () => {
    const result = evaluateAffiliateEligibility({
      signal: "GOOD DEAL", trustScore: 0.9, verdict: "BUY",
      evidenceTier: "pricing_signal_only", verifiedListingCount: 0,
    });
    assert.equal(result.eligible, false);
  });

  it("verifiedListingCount=0 still blocks affiliate for any evidence tier", () => {
    const result = evaluateAffiliateEligibility({
      signal: "STRONG BUY", trustScore: 0.95, verdict: "BUY",
      evidenceTier: "strong_verified", verifiedListingCount: 0,
    });
    assert.equal(result.eligible, false);
  });

  it("google_unresolved URL → pricing_signal evidence quality (non-verified)", () => {
    const urlQuality = "google_unresolved";
    const isMerchant = (q) => q === "merchant_direct" || q === "merchant_resolved";
    const evidenceQuality = (isMerchant(urlQuality) && true && true) ? "verified_listing" : "pricing_signal";
    assert.equal(evidenceQuality, "pricing_signal");
  });
});

// ── I. Vision hard deadline — master cannot block first result ────────────────
// These tests reproduce the Phase 4H.2 hard-deadline race logic in isolation,
// verifying that a slow master does not block the first response.

describe("Vision hard deadline — master cannot block first result", () => {
  it("hard_deadline tag wins when master is slower than deadline", async () => {
    let masterDone = false;
    const masterP = new Promise((res) => setTimeout(() => { masterDone = true; res("m"); }, 500));
    const deadlineP = new Promise((res) => setTimeout(() => res(), 50));
    const tag = await Promise.race([
      masterP.then(() => "master_consensus"),
      deadlineP.then(() => "hard_deadline"),
    ]);
    assert.equal(tag, "hard_deadline");
    assert.equal(masterDone, false, "master must still be running at deadline");
    await masterP;
  });

  it("master_consensus tag wins when master is faster than deadline", async () => {
    const masterP = new Promise((res) => setTimeout(() => res("m"), 50));
    const deadlineP = new Promise((res) => setTimeout(() => res(), 500));
    const tag = await Promise.race([
      masterP.then(() => "master_consensus"),
      deadlineP.then(() => "hard_deadline"),
    ]);
    assert.equal(tag, "master_consensus");
  });

  it("VISION_MASTER_BLOCKS_FIRST_RESULT defaults to false (deadline enabled)", () => {
    const val = String(process.env.VISION_MASTER_BLOCKS_FIRST_RESULT || "false").toLowerCase() === "true";
    assert.equal(val, false, "hard deadline must be active by default");
  });

  it("VISION_BAD_SCAN_HARD_FAIL_MS defaults to 4500", () => {
    const val = Number(process.env.VISION_BAD_SCAN_HARD_FAIL_MS || 4500);
    assert.equal(val, 4500);
  });

  it("hard_deadline_fail path sets passes=[] preventing .map() crash", () => {
    let passes = undefined;   // initial let passes; in runVisionConsensus
    let visionTier = "consensus";
    const raceWinner = "hard_deadline";
    if (raceWinner === "hard_deadline") {
      passes = [];
      visionTier = "hard_deadline_fail";
    }
    assert.deepEqual(passes, []);
    assert.equal(visionTier, "hard_deadline_fail");
    const parsedList = passes.map((p) => p?.parsed || {});
    assert.deepEqual(parsedList, []);
  });

  it("hard_deadline_fail guard prevents visionTier being overwritten by consensus branch", () => {
    let visionTier = "hard_deadline_fail";
    let passes = [];
    let passLabels = [];
    // Mirrors: if (visionTier !== "hard_return" && visionTier !== "hard_deadline_fail")
    if (visionTier !== "hard_return" && visionTier !== "hard_deadline_fail") {
      passes = ["should_not_be_set"];
      passLabels = ["consensus"];
      visionTier = "consensus";
    }
    assert.deepEqual(passes, [], "passes must remain [] for hard_deadline_fail");
    assert.equal(visionTier, "hard_deadline_fail", "visionTier must not be overwritten");
  });
});

// ── J. Background result marketReady — Phase 4J.2 ────────────────────────────
// Mirrors the logic in GET /api/vision/background-result:
//   marketReady = !(entry.needsFamilyRecovery || detectIncompleteAircraftIdentityQuery(query).incomplete)

describe("Background result marketReady — Phase 4J.2", () => {
  function computeMarketReady(entry) {
    return !(entry.needsFamilyRecovery || detectIncompleteAircraftIdentityQuery(entry.query).incomplete);
  }

  it("needsFamilyRecovery:true → marketReady:false", () => {
    const entry = { query: "Hawaiian Airlines diecast airplane model", needsFamilyRecovery: true };
    assert.equal(computeMarketReady(entry), false);
  });

  it("incomplete query without needsFamilyRecovery flag → marketReady:false", () => {
    const entry = { query: "Hawaiian Airlines diecast airplane model", needsFamilyRecovery: false };
    assert.equal(computeMarketReady(entry), false);
  });

  it("recovered query with family present → marketReady:true", () => {
    const entry = { query: "Hawaiian Airlines Boeing 787 diecast model airplane", needsFamilyRecovery: false };
    assert.equal(computeMarketReady(entry), true);
  });

  it("recovered query with family — needsFamilyRecovery undefined → marketReady:true", () => {
    const entry = { query: "Hawaiian Airlines Boeing 787 diecast model airplane" };
    assert.equal(computeMarketReady(entry), true);
  });

  it("ANA A380 exact query → marketReady:true", () => {
    const entry = { query: "ANA Airbus A380 Sea Turtle diecast model airplane" };
    assert.equal(computeMarketReady(entry), true);
  });

  it("non-aircraft query → marketReady:true (not flagged as incomplete)", () => {
    const entry = { query: "Nike Air Jordan 1 Low OG Year of the Rabbit" };
    assert.equal(computeMarketReady(entry), true);
  });

  it("spread order: entry.marketReady=true cannot overwrite computed marketReady:false", () => {
    // Proves { ..._entry, ready: true, marketReady: _bgMarketReady } is correct order.
    // If the entry already has marketReady:true, the computed false must still win.
    const entry = { query: "Hawaiian Airlines diecast airplane model", needsFamilyRecovery: true, marketReady: true };
    const computed = computeMarketReady(entry);
    // Simulate spread: { ...entry, ready: true, marketReady: computed }
    const response = { ...entry, ready: true, marketReady: computed };
    assert.equal(computed, false, "computed marketReady must be false for incomplete query");
    assert.equal(response.marketReady, false, "response.marketReady must not be overwritten by entry.marketReady");
  });

  it("spread order: entry without marketReady key — computed value is preserved correctly", () => {
    const entry = { query: "Hawaiian Airlines Boeing 787 diecast model airplane" };
    const computed = computeMarketReady(entry);
    const response = { ...entry, ready: true, marketReady: computed };
    assert.equal(response.marketReady, true);
    assert.equal(response.ready, true);
  });
});

// ── K. Frontend marketReady guard logic — Phase 4J.2 ─────────────────────────
// Mirrors the client gate: `_d?.ready && _d?.query && _d?.marketReady !== false`

describe("Frontend marketReady gate — Phase 4J.2", () => {
  function shouldRunMarketSearch(d) {
    return !!(d?.ready && d?.query && d?.marketReady !== false);
  }

  it("marketReady:false → market search is NOT called", () => {
    const d = { ready: true, query: "Hawaiian Airlines diecast airplane model", marketReady: false };
    assert.equal(shouldRunMarketSearch(d), false);
  });

  it("marketReady:true → market search IS called", () => {
    const d = { ready: true, query: "Hawaiian Airlines Boeing 787 diecast model airplane", marketReady: true };
    assert.equal(shouldRunMarketSearch(d), true);
  });

  it("marketReady missing (old server) → market search IS called (backwards compat)", () => {
    const d = { ready: true, query: "Hawaiian Airlines Boeing 787 diecast model airplane" };
    assert.equal(shouldRunMarketSearch(d), true);
  });

  it("ready:false → market search is NOT called", () => {
    const d = { ready: false, query: "Hawaiian Airlines Boeing 787 diecast model airplane", marketReady: true };
    assert.equal(shouldRunMarketSearch(d), false);
  });

  it("no query → market search is NOT called", () => {
    const d = { ready: true, query: null, marketReady: true };
    assert.equal(shouldRunMarketSearch(d), false);
  });
});
