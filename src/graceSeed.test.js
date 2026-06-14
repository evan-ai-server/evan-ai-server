import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorQueryFastSeedIdentity, effectiveSeedCategory, slaFallbackPayload } from "./graceSeed.js";

test("mirrors flat query_fast category into identity.category (the V3.3 fix)", () => {
  const qfParsed = {
    query: "Hawaiian Airlines Boeing 787 diecast model airplane",
    confidence: 0.95,
    category: "diecast model",
    brandCertainty: 0.9,
    variants: ["Hawaiian Airlines 787 model airplane"],
  };
  const out = mirrorQueryFastSeedIdentity(qfParsed);
  assert.equal(out.identity.category, "diecast model", "identity.category populated from flat category");
  assert.equal(effectiveSeedCategory(qfParsed), "diecast model");
  // full parsed object preserved (query/confidence/variants intact, nothing collapsed)
  assert.equal(out.query, qfParsed.query);
  assert.equal(out.confidence, 0.95);
  assert.deepEqual(out.variants, qfParsed.variants);
});

test("an existing identity.category is preserved over the flat value", () => {
  const out = mirrorQueryFastSeedIdentity({ category: "flatcat", identity: { category: "Real Category" } });
  assert.equal(out.identity.category, "Real Category");
});

test("no category anywhere → identity.category is null (never fabricated)", () => {
  assert.equal(mirrorQueryFastSeedIdentity({ query: "x" }).identity.category, null);
  assert.equal(effectiveSeedCategory({}), null);
});

test("does not mutate the input parsed object", () => {
  const input = { category: "diecast model" };
  mirrorQueryFastSeedIdentity(input);
  assert.equal(input.identity, undefined, "input left untouched");
});

test("slaFallbackPayload returns cached payload only when it has items", () => {
  const withItems = { payload: { items: [{ title: "a" }, { title: "b" }], finalQuery: "q" } };
  assert.deepEqual(slaFallbackPayload(withItems), withItems.payload);
});

test("slaFallbackPayload returns null for empty/missing cache (forces honest empty)", () => {
  assert.equal(slaFallbackPayload({ payload: { items: [] } }), null);
  assert.equal(slaFallbackPayload({ payload: {} }), null);
  assert.equal(slaFallbackPayload(null), null);
  assert.equal(slaFallbackPayload(undefined), null);
});
