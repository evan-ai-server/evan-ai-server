// src/sellerJargonNormalizer.test.js
// node --test src/sellerJargonNormalizer.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSellerJargon,
  containsProtectedIdentity,
} from "./sellerJargonNormalizer.js";

// ── Phase 4C.1 — aircraft identity must survive normalization ──────────────────

test("ANA Airbus A380 is never corrupted into 'ayeezy 380' / 'yeezy 380'", () => {
  const r = normalizeSellerJargon("ANA Airbus A380 diecast model airplane");
  const out = r.normalized.toLowerCase();
  assert.ok(!out.includes("yeezy"), `must not contain yeezy: "${r.normalized}"`);
  assert.ok(!out.includes("ayeezy"), `must not contain ayeezy: "${r.normalized}"`);
  assert.ok(out.includes("a380"), `must preserve a380: "${r.normalized}"`);
  assert.ok(out.includes("airbus"), `must preserve airbus: "${r.normalized}"`);
});

test("Boeing 787-9 stays an aircraft query (no sneaker rewrite)", () => {
  const r = normalizeSellerJargon("Hawaiian Airlines Boeing 787-9 diecast 1:400");
  const out = r.normalized.toLowerCase();
  assert.ok(!out.includes("yeezy"), `no yeezy: "${r.normalized}"`);
  assert.ok(out.includes("787"), `preserve 787: "${r.normalized}"`);
});

test("Boeing 737-700 is not turned into Yeezy 700", () => {
  const r = normalizeSellerJargon("Boeing 737-700 gemini jets diecast");
  assert.ok(!r.normalized.toLowerCase().includes("yeezy"), `no yeezy: "${r.normalized}"`);
  assert.ok(r.normalized.toLowerCase().includes("700"), `preserve 700: "${r.normalized}"`);
});

test("containsProtectedIdentity: true for aircraft/diecast, false for sneakers", () => {
  assert.equal(containsProtectedIdentity("ANA Airbus A380 diecast model airplane"), true);
  assert.equal(containsProtectedIdentity("Boeing 787 model"), true);
  assert.equal(containsProtectedIdentity("gemini jets a320"), true);
  assert.equal(containsProtectedIdentity("adidas yeezy 380 v2"), false);
  assert.equal(containsProtectedIdentity("air jordan 1 bred"), false);
});

// ── Word-boundary defense (independent of the protected-identity guard) ────────

test("numeric model alias only fires on a standalone token, not inside 'x380'", () => {
  // "x380" is not a protected identity, but "380" is embedded in another token
  // so the word-boundary match must not rewrite it.
  const r = normalizeSellerJargon("vintage widget x380 case");
  assert.ok(!r.normalized.toLowerCase().includes("yeezy"), `no yeezy: "${r.normalized}"`);
});

// ── Legit sneaker normalization still works ────────────────────────────────────

test("standalone sneaker model code still normalizes (adidas boost 380 → Yeezy 380)", () => {
  const r = normalizeSellerJargon("adidas boost 380");
  assert.ok(r.normalized.toLowerCase().includes("yeezy 380"), `should normalize to Yeezy 380: "${r.normalized}"`);
  assert.equal(r.changed, true);
});

test("Jordan jargon still normalizes (aj1 bred → Air Jordan 1 / Bred)", () => {
  const r = normalizeSellerJargon("aj1 bred sz 10");
  const out = r.normalized.toLowerCase();
  assert.ok(out.includes("air jordan 1"), `expand aj1: "${r.normalized}"`);
  assert.ok(out.includes("bred"), `keep colorway: "${r.normalized}"`);
});

test("non-matching plain query is returned unchanged", () => {
  const r = normalizeSellerJargon("sony wh-1000xm5 headphones");
  assert.equal(r.changed, false);
});
