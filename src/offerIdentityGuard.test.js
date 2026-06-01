// src/offerIdentityGuard.test.js
// node --test src/offerIdentityGuard.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRecoveredOfferIdentity,
  selectBestVerifiedSeller,
  extractSourceTokens,
  extractHostTokens,
  sourceMatchesHost,
  hasIdentityContradiction,
} from "./offerIdentityGuard.js";

// ── Helper builders ────────────────────────────────────────────────────────────

function makeItem({ source = "eBay - sellerA", price = 79.99, title = "Hawaiian Airlines Boeing 787-9 Dreamliner 1:400 Diecast" } = {}) {
  return { source, price, totalPrice: price, title };
}

function makeSeller({ link = "https://ebay.com/itm/123", price = 79.99, name = "" } = {}) {
  return { link, extracted_total_price: price, name };
}

// ── Unit: extractSourceTokens ──────────────────────────────────────────────────

test("extractSourceTokens: eBay prefix always → ['ebay']", () => {
  assert.deepEqual(extractSourceTokens("eBay - hobby-4-you"), ["ebay"]);
  assert.deepEqual(extractSourceTokens("ebay.com"), ["ebay"]);
});

test("extractSourceTokens: ScaleModelStore.com → ['scalemodelstore']", () => {
  const toks = extractSourceTokens("ScaleModelStore.com");
  assert.ok(toks.includes("scalemodelstore"), `got ${JSON.stringify(toks)}`);
});

test("extractSourceTokens: The Flying Mule → ['flying','mule'] (stopword stripped)", () => {
  const toks = extractSourceTokens("The Flying Mule");
  assert.ok(toks.includes("flying"), `got ${JSON.stringify(toks)}`);
  assert.ok(toks.includes("mule"), `got ${JSON.stringify(toks)}`);
  assert.ok(!toks.includes("the"), "stopword 'the' should be stripped");
});

// ── Unit: extractHostTokens ────────────────────────────────────────────────────

test("extractHostTokens: www.ebay.com → ['ebay']", () => {
  assert.deepEqual(extractHostTokens("www.ebay.com"), ["ebay"]);
});

test("extractHostTokens: scalemodelstore.com → ['scalemodelstore']", () => {
  assert.deepEqual(extractHostTokens("scalemodelstore.com"), ["scalemodelstore"]);
});

// ── Unit: sourceMatchesHost ────────────────────────────────────────────────────

test("sourceMatchesHost PASS: eBay source / ebay.com host", () => {
  assert.ok(sourceMatchesHost("eBay - hobby-4-you", "ebay.com"));
});

test("sourceMatchesHost PASS: ScaleModelStore.com source / scalemodelstore.com host", () => {
  assert.ok(sourceMatchesHost("ScaleModelStore.com", "scalemodelstore.com"));
});

test("sourceMatchesHost FAIL: eBay source / scalemodelstore.com host", () => {
  assert.ok(!sourceMatchesHost("eBay - sellerA", "scalemodelstore.com"));
});

test("sourceMatchesHost FAIL: ScaleModelStore.com source / ebay.com host", () => {
  assert.ok(!sourceMatchesHost("ScaleModelStore.com", "ebay.com"));
});

test("sourceMatchesHost FAIL: MTS Aviation Models / wingsmo.com", () => {
  assert.ok(!sourceMatchesHost("MTS Aviation Models", "wingsmo.com"));
});

// ── Unit: hasIdentityContradiction ────────────────────────────────────────────

test("hasIdentityContradiction: aircraft family – 787 original, 777 recovered → true", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787-9", "SomeStore", "777store.com"));
});

test("hasIdentityContradiction: aircraft family – 787 original, 747 in seller name → true", () => {
  assert.ok(hasIdentityContradiction("Boeing 787 Dreamliner", "747-classics-store", "classicmodels.com"));
});

test("hasIdentityContradiction: airline – Hawaiian original, ANA recovered seller → true", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "ANA Models", "anamodels.com"));
});

test("hasIdentityContradiction: airline – Hawaiian original, JAL in host → true", () => {
  assert.ok(hasIdentityContradiction("Hawaiian Airlines Boeing 787", "", "jalcollectors.com"));
});

test("hasIdentityContradiction: no contradiction – Hawaiian 787 / ebay.com → false", () => {
  assert.ok(!hasIdentityContradiction("Hawaiian Airlines Boeing 787-9 Dreamliner", "", "ebay.com"));
});

test("hasIdentityContradiction: no contradiction – 787 original, 787 in recovered → false", () => {
  assert.ok(!hasIdentityContradiction("Boeing 787 model", "787collectors", "787parts.com"));
});

// ── Integration: evaluateRecoveredOfferIdentity ────────────────────────────────

test("PASS: eBay original → eBay recovered, price within tolerance, title compatible", () => {
  const item   = makeItem({ source: "eBay - hobby-4-you", price: 69.99, title: "Hawaiian Airlines Boeing 787-9 Dreamliner 1:400 Diecast" });
  const seller = makeSeller({ link: "https://ebay.com/itm/789", price: 70.75 });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, true, `expected ok but got: ${result.reason}`);
  assert.ok(result.details.sourceMatch, "sourceMatch should be true");
  assert.ok(result.details.priceMatch, "priceMatch should be true");
  assert.ok(result.details.titleMatch, "titleMatch should be true");
});

test("FAIL: eBay original → ScaleModelStore recovered (source mismatch)", () => {
  const item   = makeItem({ source: "eBay - sellerA", price: 79.99 });
  const seller = makeSeller({ link: "https://scalemodelstore.com/product/123", price: 79.99 });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_source_mismatch");
});

test("FAIL: same source family but price too different ($79.99 vs $30.22)", () => {
  const item   = makeItem({ source: "eBay - sellerA", price: 79.99 });
  const seller = makeSeller({ link: "https://ebay.com/itm/999", price: 30.22 });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_price_mismatch");
  assert.ok(result.details.priceDeltaAbs > 2, "priceDeltaAbs should be > $2");
});

test("FAIL: aircraft family contradiction – Hawaiian Boeing 787 original, seller title has 777", () => {
  const item   = makeItem({ source: "eBay - sellerA", price: 79.99, title: "Hawaiian Airlines Boeing 787-9 Dreamliner" });
  const seller = makeSeller({ link: "https://ebay.com/itm/777model", price: 80.00, name: "Boeing 777 collectors" });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_identity_anchor_mismatch");
});

test("FAIL: airline contradiction – Hawaiian Boeing 787 original, ANA seller", () => {
  const item   = makeItem({ source: "eBay - sellerA", price: 79.99, title: "Hawaiian Airlines Boeing 787" });
  const seller = makeSeller({ link: "https://ebay.com/itm/ana-787", price: 80.00, name: "ANA airline models" });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_identity_anchor_mismatch");
});

test("PASS: ScaleModelStore.com original → scalemodelstore.com recovered, price close", () => {
  const item   = makeItem({ source: "ScaleModelStore.com", price: 59.99, title: "Boeing 787 Diecast 1:400" });
  const seller = makeSeller({ link: "https://scalemodelstore.com/product/787", price: 60.50 });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, true, `expected ok but got: ${result.reason}`);
});

test("FAIL: missing recovered price → reject offer_missing_price", () => {
  const item   = makeItem({ source: "eBay - sellerA", price: 79.99 });
  const seller = { link: "https://ebay.com/itm/123", name: "" }; // no price fields
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_missing_price");
});

test("FAIL: blocked/invalid URL → offer_blocked_host", () => {
  const item   = makeItem();
  const seller = makeSeller({ link: "not-a-valid-url", price: 79.99 });
  const result = evaluateRecoveredOfferIdentity(item, seller, seller.link);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_blocked_host");
});

// ── Integration: selectBestVerifiedSeller ─────────────────────────────────────

test("selectBestVerifiedSeller: picks guard-passing seller, not the cheaper failing one", () => {
  const item = makeItem({ source: "eBay - hobby-4-you", price: 69.99, title: "Hawaiian Airlines Boeing 787-9 Dreamliner 1:400 Diecast" });

  // Cheapest seller: wrong host (mismatch) — should be REJECTED
  const cheapSeller  = makeSeller({ link: "https://scalemodelstore.com/product/787", price: 30.22 });
  // Second seller: right host, right price — should PASS
  const rightSeller  = makeSeller({ link: "https://ebay.com/itm/789", price: 70.75 });

  const sellers = [cheapSeller, rightSeller];
  const validator = (url) => !url.includes("blocked");

  const result = selectBestVerifiedSeller(sellers, item, validator);
  assert.ok(result, "expected a passing seller to be found");
  assert.ok(result.link.includes("ebay.com"), `expected ebay.com link, got: ${result.link}`);
  assert.equal(result.guardResult.ok, true);
});

test("selectBestVerifiedSeller: returns null when no seller passes", () => {
  const item = makeItem({ source: "eBay - sellerA", price: 79.99 });

  // Both sellers are wrong host
  const s1 = makeSeller({ link: "https://scalemodelstore.com/1", price: 79.99 });
  const s2 = makeSeller({ link: "https://wingsmo.com/2", price: 79.99 });

  const result = selectBestVerifiedSeller([s1, s2], item, () => true);
  assert.equal(result, null);
});

test("selectBestVerifiedSeller: returns null for empty sellers array", () => {
  assert.equal(selectBestVerifiedSeller([], makeItem(), () => true), null);
});

test("selectBestVerifiedSeller: urlValidator blocks all → null", () => {
  const item   = makeItem({ source: "eBay - sellerA", price: 79.99 });
  const seller = makeSeller({ link: "https://ebay.com/itm/123", price: 79.99 });
  const result = selectBestVerifiedSeller([seller], item, () => false); // validator rejects all
  assert.equal(result, null);
});
