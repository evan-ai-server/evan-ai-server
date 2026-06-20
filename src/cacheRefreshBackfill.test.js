import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractProductIdFromGoogleUrl } from "./urlEvidenceAudit.js";

const INDEX_SRC = readFileSync(resolve(import.meta.dirname, "../index.js"), "utf8");

// ── extractProductIdFromGoogleUrl ───────────────────────────────────────────

test("extracts productid from Google Shopping prds URL", () => {
  const url = "https://www.google.com/search?ibp=oshop&q=hawaiian+airlines+boeing+787&prds=catalogid:6327683082585613489,productid:11076768015358219087,headlineOfferDocid:14896600905251281130";
  assert.equal(extractProductIdFromGoogleUrl(url), "11076768015358219087");
});

test("extracts productid when it is the first prds field", () => {
  const url = "https://www.google.com/search?ibp=oshop&q=test&prds=productid:3525694999786582311,headlineOfferDocid:3525694999786582311";
  assert.equal(extractProductIdFromGoogleUrl(url), "3525694999786582311");
});

test("returns null for non-Google URL", () => {
  assert.equal(extractProductIdFromGoogleUrl("https://www.ebay.com/itm/123"), null);
});

test("returns null for null/empty/undefined", () => {
  assert.equal(extractProductIdFromGoogleUrl(null), null);
  assert.equal(extractProductIdFromGoogleUrl(""), null);
  assert.equal(extractProductIdFromGoogleUrl(undefined), null);
});

test("does not match short numeric strings", () => {
  assert.equal(extractProductIdFromGoogleUrl("https://example.com?productid:123"), null);
});

// ── Static guards: backfill logic in index.js ───────────────────────────────

test("CACHE_REFRESH_DUPLICATE_METADATA_BACKFILLED log exists", () => {
  assert.ok(INDEX_SRC.includes("CACHE_REFRESH_DUPLICATE_METADATA_BACKFILLED"), "backfill log missing");
});

test("backfill uses extractProductIdFromGoogleUrl", () => {
  assert.ok(INDEX_SRC.includes("extractProductIdFromGoogleUrl(liveItem.googleUrl)"), "googleUrl extraction missing");
});

test("backfill imports extractProductIdFromGoogleUrl", () => {
  assert.ok(INDEX_SRC.includes("extractProductIdFromGoogleUrl"), "import missing");
});

test("backfill calls saveInternalMarketSnapshot when metadata backfilled", () => {
  assert.ok(INDEX_SRC.includes('saveInternalMarketSnapshot(query, { items: _internalItems, source: "metadata_backfill" })'), "snapshot save after backfill missing");
});

test("backfill does not set clickable or isVerifiedListing", () => {
  const backfillBlock = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2B: backfill"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(!backfillBlock.includes("cached.clickable"), "backfill must not set clickable");
  assert.ok(!backfillBlock.includes("cached.isVerifiedListing"), "backfill must not set isVerifiedListing");
  assert.ok(!backfillBlock.includes("cached.directUrl"), "backfill must not set directUrl");
});

test("backfill only upgrades urlQuality from unknown_legacy_no_url", () => {
  const backfillBlock = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2B: backfill"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(backfillBlock.includes('cached.urlQuality === "unknown_legacy_no_url"'), "urlQuality upgrade guard missing");
});

// ── Static guards: Phase 5A.2C payload cache invalidation ───────────────────

test("CACHE_REFRESH_METADATA_BACKFILL_PAYLOAD_CACHE_INVALIDATED log exists", () => {
  assert.ok(INDEX_SRC.includes("CACHE_REFRESH_METADATA_BACKFILL_PAYLOAD_CACHE_INVALIDATED"), "invalidation log missing");
});

test("payload cache invalidation uses _makeAllBudgetKeys", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(block.includes("_makeAllBudgetKeys"), "must use _makeAllBudgetKeys for surgical key derivation");
});

test("payload cache invalidation deletes from MARKET_SCAN_RESULT_CACHE", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(block.includes("MARKET_SCAN_RESULT_CACHE.delete(k)"), "must delete from MARKET_SCAN_RESULT_CACHE");
});

test("payload cache invalidation deletes from INSTANT_SCAN_CACHE", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(block.includes("INSTANT_SCAN_CACHE.delete(cacheKey)"), "must delete from INSTANT_SCAN_CACHE");
});

test("payload cache invalidation deletes from ENRICHED_SCAN_CACHE", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(block.includes("ENRICHED_SCAN_CACHE.delete(cacheKey)"), "must delete from ENRICHED_SCAN_CACHE");
});

test("invalidation only runs when _metadataBackfillCount > 0", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(block.includes("_metadataBackfillCount > 0") || INDEX_SRC.indexOf("Phase 5A.2C") > INDEX_SRC.indexOf("if (_metadataBackfillCount > 0)"), "invalidation must be inside metadataBackfillCount > 0 guard");
});

test("invalidation does not set clickable, directUrl, or isVerifiedListing", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(!block.includes("clickable = true"), "must not set clickable");
  assert.ok(!block.includes("directUrl ="), "must not set directUrl");
  assert.ok(!block.includes("isVerifiedListing"), "must not set isVerifiedListing");
});

// ── Static guards: Phase 5A.2D — try/catch + TTLCache API ───────────────────

test("invalidation block is wrapped in try/catch", () => {
  const block = INDEX_SRC.slice(
    INDEX_SRC.indexOf("Phase 5A.2C"),
    INDEX_SRC.indexOf("Run identity/aircraft filter on net-new candidates")
  );
  assert.ok(block.includes("try {"), "invalidation must be wrapped in try");
  assert.ok(block.includes("CACHE_REFRESH_METADATA_BACKFILL_PAYLOAD_CACHE_INVALIDATION_FAILED"), "catch must log failure");
});

test("TTLCache has delete and has methods", () => {
  const ttlBlock = INDEX_SRC.slice(
    INDEX_SRC.indexOf("class TTLCache"),
    INDEX_SRC.indexOf("class TTLCache") + 1500
  );
  assert.ok(ttlBlock.includes("delete(key)"), "TTLCache must have delete method");
  assert.ok(ttlBlock.includes("has(key)"), "TTLCache must have has method");
});
