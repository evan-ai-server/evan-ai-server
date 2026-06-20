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
