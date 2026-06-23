import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateNearDupServeGate, detectNearDupContradiction } from "./nearDupServeGate.js";

describe("evaluateNearDupServeGate", () => {
  it("blocks empty query", () => {
    const r = evaluateNearDupServeGate({ query: "  ", category: "shoes" });
    assert.equal(r.serve, false);
    assert.equal(r.reason, "empty_query");
  });

  it("blocks high-stakes via exact-set flag", () => {
    const r = evaluateNearDupServeGate({ query: "some item", category: "sneakers", isHighStakesExact: true });
    assert.equal(r.serve, false);
    assert.equal(r.reason, "high_stakes_category");
  });

  it("blocks high-stakes via substring the exact-set misses — running shoes", () => {
    const r = evaluateNearDupServeGate({ query: "nike running shoes red", category: "footwear", isHighStakesExact: false });
    assert.equal(r.serve, false);
    assert.equal(r.reason, "high_stakes_category");
  });

  it("blocks high-stakes — wristwatch", () => {
    const r = evaluateNearDupServeGate({ query: "vintage wristwatch leather", category: "accessory", isHighStakesExact: false });
    assert.equal(r.serve, false);
  });

  it("blocks high-stakes — designer handbag", () => {
    const r = evaluateNearDupServeGate({ query: "brown leather handbag", category: "bag", isHighStakesExact: false });
    assert.equal(r.serve, false);
  });

  it("blocks high-stakes — iphone (electronics)", () => {
    const r = evaluateNearDupServeGate({ query: "Apple iPhone 13 blue", category: "phone", isHighStakesExact: false });
    assert.equal(r.serve, false);
  });

  it("blocks high-stakes brand in query even when category is generic", () => {
    const r = evaluateNearDupServeGate({ query: "Louis Vuitton Neverfull", category: "general", isHighStakesExact: false });
    assert.equal(r.serve, false);
  });

  it("serves a complete aircraft identity (airline + family)", () => {
    const r = evaluateNearDupServeGate({
      query: "Hawaiian Airlines Boeing 787 diecast model airplane",
      category: "diecast model", airline: "hawaiian", hasFamily: true,
    });
    assert.equal(r.serve, true);
    assert.equal(r.reason, "ok");
  });

  it("blocks aircraft with family but no airline", () => {
    const r = evaluateNearDupServeGate({
      query: "Boeing 787 diecast model airplane",
      category: "diecast model", airline: null, hasFamily: true,
    });
    assert.equal(r.serve, false);
    assert.equal(r.reason, "aircraft_missing_airline");
  });

  it("blocks aircraft with airline but no family", () => {
    const r = evaluateNearDupServeGate({
      query: "Hawaiian Airlines model airplane",
      category: "diecast model", airline: "hawaiian", hasFamily: false,
    });
    assert.equal(r.serve, false);
    assert.equal(r.reason, "aircraft_missing_family");
  });

  it("detects aircraft from query tokens even without airline lock and blocks", () => {
    const r = evaluateNearDupServeGate({
      query: "boeing dreamliner plane", category: "toy", airline: null, hasFamily: false,
    });
    assert.equal(r.serve, false);
    assert.equal(r.reason, "aircraft_missing_airline");
  });

  it("serves a safe non-aircraft non-high-stakes item", () => {
    const r = evaluateNearDupServeGate({
      query: "blue ceramic vase floral pattern", category: "home decor",
      airline: null, hasFamily: false, isHighStakesExact: false,
    });
    assert.equal(r.serve, true);
    assert.equal(r.reason, "ok");
  });
});

describe("detectNearDupContradiction", () => {
  it("does not heal on low-confidence verify", () => {
    const r = detectNearDupContradiction({
      servedQuery: "Hawaiian Airlines Boeing 787", verifyQuery: "Gulf Air Boeing 787",
      servedAirline: "hawaiian", verifyAirline: "gulf air", verifyConfidence: 0.4,
    });
    assert.equal(r.contradicts, false);
    assert.equal(r.reason, "verify_low_confidence");
  });

  it("heals on airline mismatch with confident verify", () => {
    const r = detectNearDupContradiction({
      servedQuery: "Hawaiian Airlines Boeing 787", verifyQuery: "Gulf Air Boeing 787",
      servedAirline: "hawaiian", verifyAirline: "gulf air", verifyConfidence: 0.9,
    });
    assert.equal(r.contradicts, true);
    assert.equal(r.reason, "airline_mismatch");
  });

  it("heals on family mismatch", () => {
    const r = detectNearDupContradiction({
      servedQuery: "Hawaiian Airlines Boeing 787", verifyQuery: "Hawaiian Airlines Boeing 777",
      servedAirline: "hawaiian", verifyAirline: "hawaiian",
      servedFamily: "787", verifyFamily: "777", verifyConfidence: 0.9,
    });
    assert.equal(r.contradicts, true);
    assert.equal(r.reason, "family_mismatch");
  });

  it("heals on near-zero token overlap (different item entirely)", () => {
    const r = detectNearDupContradiction({
      servedQuery: "blue ceramic vase floral", verifyQuery: "leather office chair black",
      verifyConfidence: 0.85,
    });
    assert.equal(r.contradicts, true);
    assert.equal(r.reason, "low_token_overlap");
  });

  it("does not heal when consistent", () => {
    const r = detectNearDupContradiction({
      servedQuery: "Hawaiian Airlines Boeing 787 diecast model",
      verifyQuery: "Hawaiian Airlines Boeing 787 model airplane",
      servedAirline: "hawaiian", verifyAirline: "hawaiian",
      servedFamily: "787", verifyFamily: "787", verifyConfidence: 0.9,
    });
    assert.equal(r.contradicts, false);
    assert.equal(r.reason, "consistent");
  });

  it("does not heal on empty verify query", () => {
    const r = detectNearDupContradiction({
      servedQuery: "anything", verifyQuery: "", verifyConfidence: 0.9,
    });
    assert.equal(r.contradicts, false);
    assert.equal(r.reason, "verify_empty");
  });
});
