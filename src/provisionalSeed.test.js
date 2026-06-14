import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateProvisionalSeed, isSafeProvisionalCategory } from "./provisionalSeed.js";

const T = 0.92;

test("safe diecast, high similarity, complete aircraft → accepted (query stays exact)", () => {
  const q = "Hawaiian Airlines Boeing 787 diecast model airplane";
  const r = evaluateProvisionalSeed({ mode: "item", query: q, category: "diecast model", similarity: 0.95, threshold: T });
  assert.equal(r.eligible, true, r.reason);
  assert.equal(r.reason, "accepted");
});

test("prop mode is also allowed", () => {
  const r = evaluateProvisionalSeed({ mode: "prop", query: "GeminiJets 787-9 diecast model airplane", category: "diecast model", similarity: 0.93, threshold: T });
  assert.equal(r.eligible, true, r.reason);
});

test("sneaker, high similarity → rejected (unsafe category)", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Nike ZoomX Vaporfly Next% 2", category: "sneakers", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "unsafe_or_unknown_category");
});

test("electronics (AirPods), high similarity → rejected", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Apple AirPods Pro 2", category: "electronics", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "unsafe_or_unknown_category");
});

test("unknown / empty category → rejected", () => {
  const r1 = evaluateProvisionalSeed({ mode: "item", query: "some thing", category: "general", similarity: 0.99, threshold: T });
  assert.equal(r1.eligible, false);
  assert.equal(r1.reason, "unsafe_or_unknown_category");
  const r2 = evaluateProvisionalSeed({ mode: "item", query: "some thing", category: "", similarity: 0.99, threshold: T });
  assert.equal(r2.eligible, false);
  assert.equal(r2.reason, "unsafe_or_unknown_category");
});

test("below similarity threshold → rejected even for safe category", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Hawaiian Airlines Boeing 787 diecast model airplane", category: "diecast model", similarity: 0.90, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "below_similarity_threshold");
});

test("mode not item/prop → rejected", () => {
  const r = evaluateProvisionalSeed({ mode: "label", query: "Hawaiian Airlines Boeing 787 diecast model airplane", category: "diecast model", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "mode_not_item_prop");
});

test("incomplete aircraft (airline, no family) → rejected, never invents a family", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "Hawaiian Airlines diecast model airplane", category: "diecast model", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "incomplete_aircraft_identity");
});

test("empty prior query → rejected", () => {
  const r = evaluateProvisionalSeed({ mode: "item", query: "", category: "diecast model", similarity: 0.99, threshold: T });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "no_prior_query");
});

test("isSafeProvisionalCategory allowlist vs high-stakes block", () => {
  assert.equal(isSafeProvisionalCategory("diecast model"), true);
  assert.equal(isSafeProvisionalCategory("model airplane"), true);
  assert.equal(isSafeProvisionalCategory("collectible"), true);
  assert.equal(isSafeProvisionalCategory("sneakers"), false);
  assert.equal(isSafeProvisionalCategory("watch"), false);
  assert.equal(isSafeProvisionalCategory("graded card"), false);
  assert.equal(isSafeProvisionalCategory(""), false);
  assert.equal(isSafeProvisionalCategory("general"), false);
});
