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

// ── P0 regressions: "ow" substring must not corrupt words containing "ow" ─────
// Root cause: COLORWAY_ALIASES "ow"→"Off-White" was using substring match
// without word boundaries, so "Low"→"LOff-White", "Yellow"→"YellOff-White",
// "Brown"→"BrOff-Whiten", "Glow"→"GlOff-White", "snow"→"snOff-White".

test("P0: 'Low' in sneaker query is never corrupted to 'LOff-White'", () => {
  const r = normalizeSellerJargon("Air Jordan 1 Low OG Year of the Rabbit");
  assert.ok(!r.normalized.includes("Off-White"), `must not contain Off-White: "${r.normalized}"`);
  assert.ok(!r.normalized.includes("LOff"),      `must not contain LOff: "${r.normalized}"`);
  assert.ok(r.normalized.toLowerCase().includes("low"), `must preserve Low: "${r.normalized}"`);
  assert.ok(r.normalized.toLowerCase().includes("jordan"), `must preserve Jordan identity: "${r.normalized}"`);
});

test("P0: 'Air Force 1 Low White' — Low is not corrupted", () => {
  const r = normalizeSellerJargon("Air Force 1 Low White");
  assert.ok(!r.normalized.includes("Off-White"), `must not produce Off-White: "${r.normalized}"`);
  assert.ok(!r.normalized.includes("LOff"),      `must not contain LOff: "${r.normalized}"`);
  assert.ok(r.normalized.toLowerCase().includes("low"), `must preserve Low: "${r.normalized}"`);
});

test("P0: 'Nike Dunk Low Panda' — Low is not corrupted", () => {
  const r = normalizeSellerJargon("Nike Dunk Low Panda");
  assert.ok(!r.normalized.includes("LOff"),      `must not contain LOff: "${r.normalized}"`);
  // 'panda' is a real colorway alias — it should still resolve
  assert.ok(r.normalized.toLowerCase().includes("panda"), `Panda colorway should be kept: "${r.normalized}"`);
});

test("P0: 'Yellow' is not corrupted to 'YellOff-White'", () => {
  const r = normalizeSellerJargon("New Balance 550 Yellow colorway");
  assert.ok(!r.normalized.includes("YellOff"),   `must not contain YellOff: "${r.normalized}"`);
  assert.ok(!r.normalized.includes("Off-White"), `must not produce Off-White: "${r.normalized}"`);
  assert.ok(r.normalized.toLowerCase().includes("yellow"), `must preserve Yellow: "${r.normalized}"`);
});

test("P0: 'Brown' is not corrupted to 'BrOff-Whiten'", () => {
  const r = normalizeSellerJargon("Brown leather boot");
  assert.ok(!r.normalized.includes("BrOff"),     `must not contain BrOff: "${r.normalized}"`);
  assert.ok(!r.normalized.includes("Off-White"), `must not produce Off-White: "${r.normalized}"`);
});

test("P0: 'Glow in the dark' is not corrupted", () => {
  const r = normalizeSellerJargon("Glow in the dark sneaker");
  assert.ok(!r.normalized.includes("Off-White"), `must not produce Off-White: "${r.normalized}"`);
  assert.ok(!r.normalized.includes("GlOff"),     `must not contain GlOff: "${r.normalized}"`);
});

test("P0: 'snow boot' is not corrupted", () => {
  const r = normalizeSellerJargon("snow boot");
  assert.ok(!r.normalized.includes("Off-White"), `must not produce Off-White: "${r.normalized}"`);
});

// ── Positive: standalone seller shorthand still resolves ──────────────────────

test("'ow' as a standalone token still maps to Off-White", () => {
  const r = normalizeSellerJargon("ow jordan 1");
  assert.ok(r.normalized.includes("Off-White"), `standalone ow must resolve to Off-White: "${r.normalized}"`);
  assert.equal(r.extracted.colorway, "Off-White");
});

test("'off white' phrase still maps to Off-White", () => {
  const r = normalizeSellerJargon("off white jordan 1");
  assert.ok(r.normalized.includes("Off-White"), `"off white" phrase must resolve: "${r.normalized}"`);
  assert.equal(r.extracted.colorway, "Off-White");
});

test("condition alias 'vnds' works as standalone token", () => {
  const r = normalizeSellerJargon("vnds jordan 1 bred sz 10");
  assert.ok(r.extracted.condition !== null, `vnds should extract condition, got null: "${r.normalized}"`);
  assert.equal(r.extracted.condition, "like_new");
  // Should not appear in normalized output (stripped)
  assert.ok(!r.normalized.toLowerCase().includes("vnds"), `vnds should be stripped from output: "${r.normalized}"`);
});

test("condition alias 'ds' works as standalone token", () => {
  const r = normalizeSellerJargon("ds jordan 1");
  assert.ok(r.extracted.condition !== null, `ds should extract condition: "${r.normalized}"`);
  assert.equal(r.extracted.condition, "deadstock");
  assert.ok(!r.normalized.toLowerCase().includes(" ds ") && !r.normalized.toLowerCase().startsWith("ds "),
    `ds should be stripped from output: "${r.normalized}"`);
});
