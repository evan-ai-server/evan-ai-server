// src/urlEvidenceAudit.test.js
// Phase V3.9A — URL evidence preservation / sanitization audit.
//
// Run: node --test src/urlEvidenceAudit.test.js
//
// These are PURE tests (no live SerpAPI, no server boot). They lock in the
// recovery-eligibility rule, prove the snapshot write-compaction loss that
// starves V3.9B, and assert the trust invariants (pricing-only / oracle /
// legacy items never become verified).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeUrlEvidence,
  diffUrlEvidence,
  classifyRecoveryCandidate,
  recoveryEligibilitySummary,
  hasAnyUrl,
} from "./urlEvidenceAudit.js";

// ── Fixtures: the shapes that flow through the real pipeline ──────────────────

// A fresh SerpAPI google_shopping item after normalizeItem(): unresolved google
// link → not clickable, but _productId IS captured (recovery evidence present).
const freshUnresolvedWithPid = {
  title: "Hawaiian Airlines 1:400 Boeing 787-9 Diecast", price: 69.99, source: "eBay",
  directUrl: null, url: null, link: null, buyLink: null,
  clickable: false, urlQuality: "google_unresolved",
  _productId: "pid_787_abc", _serpapiProductApiUrl: "https://serpapi.com/search.json?engine=google_product&product_id=pid_787_abc",
  isVerifiedListing: false, evidenceQuality: "pricing_signal",
};

// A real merchant-direct item: clickable, verified.
const merchantDirect = {
  title: "GeminiJets 787-9 Hawaiian Dreamliner", price: 76.01, source: "Airspotters.com",
  directUrl: "https://www.ebay.com/itm/123456789", url: "https://www.ebay.com/itm/123456789",
  link: "https://www.ebay.com/itm/123456789", buyLink: "https://www.ebay.com/itm/123456789",
  clickable: true, urlQuality: "merchant_direct",
  _productId: "pid_gj", isVerifiedListing: true, evidenceQuality: "verified_listing",
};

// A GPT-oracle estimate: no URL, no productId, must never be verified.
const oracleEstimate = {
  title: "Hawaiian 787 model (est.)", price: 80, source: "eBay - estimate",
  directUrl: null, clickable: false, urlQuality: "oracle_pricing_estimate",
  _productId: null, isVerifiedListing: false, evidenceQuality: "oracle_estimate",
};

// A legacy snapshot item AFTER compactMarketSnapshotItem() (index.js ~15330):
// only title/source/price/url(+link/buyLink) survive — NO directUrl, NO
// _productId, NO urlQuality, NO clickable. This is the live Hawaiian 787 shape.
const legacyCompactedSnapshotItem = {
  title: "Hawaiian Airlines 1:400 Boeing 787-9 Diecast", source: "eBay - bravo4minnesota",
  price: 69.99, totalPrice: 69.99,
  url: null, link: null, buyLink: null, image: null,
  rating: null, reviews: null, linkVerified: true, sold: false, status: null,
};

// ── A. summarizeUrlEvidence — compact field-presence ─────────────────────────

describe("summarizeUrlEvidence — counts field presence without leaking URLs", () => {
  it("counts directUrl / productId / urlQuality / verified across a mixed pool", () => {
    const s = summarizeUrlEvidence([freshUnresolvedWithPid, merchantDirect, oracleEstimate]);
    assert.equal(s.total, 3);
    assert.equal(s.withDirectUrl, 1);     // only merchantDirect
    assert.equal(s.withProductId, 2);     // fresh + merchant
    assert.equal(s.withUrlQuality, 3);    // all three carry a urlQuality
    assert.equal(s.clickableTrue, 1);     // only merchant
    assert.equal(s.verifiedListings, 1);  // only merchant
    assert.equal(s.urlQualityCounts.google_unresolved, 1);
    assert.equal(s.urlQualityCounts.oracle_pricing_estimate, 1);
  });

  it("handles empty / non-array input safely", () => {
    assert.equal(summarizeUrlEvidence([]).total, 0);
    assert.equal(summarizeUrlEvidence(null).total, 0);
    assert.equal(summarizeUrlEvidence(undefined).withProductId, 0);
  });

  it("sampleTitles are short prefixes only (no full payload)", () => {
    const s = summarizeUrlEvidence([merchantDirect]);
    assert.ok(s.sampleTitles[0].length <= 40);
  });

  it("hasAnyUrl: empty-string url fields do not count as a URL", () => {
    assert.equal(hasAnyUrl({ directUrl: "", url: "", link: "", buyLink: "" }), false);
    assert.equal(hasAnyUrl({ link: "https://ebay.com/itm/1" }), true);
  });
});

// ── B. Recovery candidate rule (mirrors index.js ~25188) ─────────────────────

describe("classifyRecoveryCandidate — recovery rule = non-clickable AND _productId", () => {
  it("case 2: productId but no direct URL → recovery candidate (NOT lost)", () => {
    const c = classifyRecoveryCandidate(freshUnresolvedWithPid);
    assert.equal(c.candidate, true);
    assert.equal(c.reason, "has_product_id");
  });

  it("case 1: a real merchant-direct (clickable) item is not a recovery candidate", () => {
    // It needs no recovery — it is already a direct-clickable / verified listing.
    const c = classifyRecoveryCandidate(merchantDirect);
    assert.equal(c.candidate, false);
    assert.equal(c.reason, "already_clickable_or_verified");
  });

  it("case 4: oracle estimate (no productId, no URL) is not a candidate", () => {
    const c = classifyRecoveryCandidate(oracleEstimate);
    assert.equal(c.candidate, false);
    assert.equal(c.reason, "missing_product_id");
  });

  it("case 5: legacy compacted snapshot item is not a candidate (productId stripped)", () => {
    const c = classifyRecoveryCandidate(legacyCompactedSnapshotItem);
    assert.equal(c.candidate, false);
    assert.equal(c.reason, "missing_product_id");
  });

  it("identity-blind: title text never makes an item eligible", () => {
    // URL evidence must not be a back-channel for identity.
    const noisyTitle = { title: "GENUINE VERIFIED AUTHENTIC ebay.com/itm/1", clickable: false, _productId: null };
    assert.equal(classifyRecoveryCandidate(noisyTitle).candidate, false);
  });
});

describe("recoveryEligibilitySummary — reproduces the live DIRECT_URL_RECOVERY_ELIGIBLE reason", () => {
  it("live Hawaiian 787 (9 legacy snapshot items) → eligible:0, reason:no_product_ids", () => {
    const pool = Array.from({ length: 9 }, (_, i) => ({ ...legacyCompactedSnapshotItem, title: `item ${i}` }));
    const r = recoveryEligibilitySummary(pool);
    assert.equal(r.total, 9);
    assert.equal(r.eligible, 0);
    assert.equal(r.missingProductId, 9);
    assert.equal(r.reason, "no_product_ids");
  });

  it("fresh pool with productIds → eligible:N, reason:has_product_ids", () => {
    const r = recoveryEligibilitySummary([freshUnresolvedWithPid, { ...freshUnresolvedWithPid, _productId: "pid2" }]);
    assert.equal(r.eligible, 2);
    assert.equal(r.reason, "has_product_ids");
  });

  it("all-clickable pool → reason:all_clickable_or_verified", () => {
    const r = recoveryEligibilitySummary([merchantDirect, { ...merchantDirect, _productId: "pid_x" }]);
    assert.equal(r.eligible, 0);
    assert.equal(r.reason, "all_clickable_or_verified");
  });

  it("empty pool → reason:empty_pool", () => {
    assert.equal(recoveryEligibilitySummary([]).reason, "empty_pool");
  });
});

// ── C. THE CORE FINDING: snapshot write-compaction drops recovery evidence ───
// Mirrors compactMarketSnapshotItem (index.js ~15330) — the current write shape.

function compactCurrent(it = {}) {
  // EXACT field set persisted today (the lossy path).
  return {
    title: it?.title || null,
    source: it?.source || null,
    price: it?.price ?? null,
    totalPrice: it?.totalPrice ?? it?.price ?? null,
    url: it?.url || it?.buyLink || it?.link || null,
    link: it?.link || it?.url || it?.buyLink || null,
    buyLink: it?.buyLink || it?.url || it?.link || null,
    image: it?.image || null,
    linkVerified: it?.linkVerified !== false,
    sold: it?.sold === true,
    status: it?.status || null,
  };
}

// Proposed V3.9B write shape: same, plus the three non-user-facing recovery
// fields. (NOT yet wired into index.js — this test asserts what the fix buys.)
function compactProposedV39B(it = {}) {
  return {
    ...compactCurrent(it),
    _productId: it?._productId || null,
    _serpapiProductApiUrl: it?._serpapiProductApiUrl || null,
    urlQuality: it?.urlQuality || null,
  };
}

describe("snapshot compaction — current path destroys recovery evidence (V3.9A proof)", () => {
  it("case 7: current compaction DROPS _productId / serpApiUrl / urlQuality", () => {
    const before = [freshUnresolvedWithPid];
    const after = before.map(compactCurrent);
    const d = diffUrlEvidence(before, after);
    assert.equal(d.droppedProductId, 1, "current compaction loses _productId");
    assert.equal(d.droppedSerpApiUrl, 1, "current compaction loses _serpapiProductApiUrl");
    assert.equal(d.droppedUrlQuality, 1, "current compaction loses urlQuality");
    assert.equal(d.anyRecoveryFieldDropped, true);
  });

  it("case 7 (fix): proposed V3.9B compaction PRESERVES recovery evidence", () => {
    const before = [freshUnresolvedWithPid];
    const after = before.map(compactProposedV39B);
    const d = diffUrlEvidence(before, after);
    assert.equal(d.droppedProductId, 0);
    assert.equal(d.droppedSerpApiUrl, 0);
    assert.equal(d.anyRecoveryFieldDropped, false);
    // and a re-served item is now a recovery candidate again
    assert.equal(recoveryEligibilitySummary(after).eligible, 1);
  });

  it("case 6: a spread-style sanitizer does NOT erase recovery metadata", () => {
    // sanitizeOutboundListingForClient spreads {...item}; _productId survives even
    // when the item is forced non-clickable. Compaction is the only loss point.
    const sanitizedSpread = { ...freshUnresolvedWithPid, directUrl: null, clickable: false };
    assert.equal(sanitizedSpread._productId, "pid_787_abc");
    assert.equal(classifyRecoveryCandidate(sanitizedSpread).candidate, true);
  });
});

// ── D. Trust invariants — nothing un-earned becomes verified ─────────────────

describe("trust invariants — pricing-only / oracle / legacy never become verified", () => {
  it("case 3: google-unresolved item is not verified, but its evidence is preserved", () => {
    const s = summarizeUrlEvidence([freshUnresolvedWithPid]);
    assert.equal(s.verifiedListings, 0);          // not verified
    assert.equal(s.withProductId, 1);             // recovery evidence intact
  });

  it("case 9: pricing-only stays pricing-only (no direct/verified evidence)", () => {
    const s = summarizeUrlEvidence([legacyCompactedSnapshotItem, oracleEstimate]);
    assert.equal(s.verifiedListings, 0);
    assert.equal(s.withDirectUrl, 0);
    assert.equal(s.clickableTrue, 0);
  });

  it("case 10: a GPT-oracle item can never be a verified listing", () => {
    assert.equal(summarizeUrlEvidence([oracleEstimate]).verifiedListings, 0);
    assert.equal(classifyRecoveryCandidate(oracleEstimate).candidate, false);
  });

  it("only merchant_direct + clickable + directUrl is verified", () => {
    assert.equal(summarizeUrlEvidence([merchantDirect]).verifiedListings, 1);
  });
});
