import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  recoverFamilyFromMasterFields,
  detectFamilyToken,
  injectAircraftFamily,
  FIELD_RECOVERY_FAMILY_TOKENS,
} from "./aircraftFamilyFieldRecovery.js";

// ── detectFamilyToken ────────────────────────────────────────────────────────

test("detectFamilyToken finds 787 and dreamliner", () => {
  assert.equal(detectFamilyToken("787-9").family, "787");
  assert.equal(detectFamilyToken("Boeing Dreamliner").family, "787");
  assert.equal(detectFamilyToken("A380").family, "a380");
  assert.equal(detectFamilyToken("model airplane"), null);
  assert.equal(detectFamilyToken(""), null);
});

test("detectFamilyToken is word-boundary safe (no false match inside other numbers)", () => {
  assert.equal(detectFamilyToken("part 17877 sticker"), null, "787 must not match inside 17877");
});

// ── injectAircraftFamily ───────────────────────────────────────────────────────

test("injectAircraftFamily inserts manufacturer + family before generic noun", () => {
  const q = injectAircraftFamily("Hawaiian Airlines model airplane", "787");
  assert.ok(/hawaiian airlines/i.test(q));
  assert.ok(/boeing 787/i.test(q), q);
  assert.ok(/model airplane/i.test(q));
});

test("injectAircraftFamily does not double-insert when family already present", () => {
  const q = injectAircraftFamily("Hawaiian Airlines 787 model airplane", "787");
  assert.equal((q.match(/787/g) || []).length, 1);
});

test("injectAircraftFamily Airbus family uses Airbus manufacturer", () => {
  const q = injectAircraftFamily("Emirates model airplane", "a380");
  assert.ok(/airbus a380/i.test(q), q);
});

// ── recoverFamilyFromMasterFields — the V3.10B.6 core ──────────────────────────

test("recovers family from identity.model field (bare token) → synthesizes complete query", () => {
  const r = recoverFamilyFromMasterFields({
    incompleteQuery: "Hawaiian Airlines model airplane",
    requiredAirline: "hawaiian",
    candidateStrings: ["Hawaiian Airlines model airplane"],
    fieldValues: ["787-9"], // e.g. parsed.identity.model
  });
  assert.equal(r.recovered, true);
  assert.equal(r.family, "787");
  assert.equal(r.source, "master_identity_field");
  assert.ok(/hawaiian airlines/i.test(r.query) && /787/.test(r.query), r.query);
});

test("recovers from a complete variant string verbatim (airline + family present)", () => {
  const r = recoverFamilyFromMasterFields({
    incompleteQuery: "Hawaiian Airlines model airplane",
    requiredAirline: "hawaiian",
    candidateStrings: [
      "Hawaiian Airlines model airplane",
      "Hawaiian Airlines Boeing 787-9 1:400 GeminiJets",
    ],
    fieldValues: [],
  });
  assert.equal(r.recovered, true);
  assert.equal(r.source, "master_complete_string");
  assert.equal(r.query, "Hawaiian Airlines Boeing 787-9 1:400 GeminiJets");
});

test("all master output generic → recovered:false (caller keeps needsFamilyRecovery)", () => {
  const r = recoverFamilyFromMasterFields({
    incompleteQuery: "Hawaiian Airlines model airplane",
    requiredAirline: "hawaiian",
    candidateStrings: [
      "Hawaiian Airlines model airplane",
      "Hawaiian Airlines diecast model",
      "Hawaiian Airlines plane replica",
    ],
    fieldValues: ["Hawaiian Airlines", "model airplane", "diecast", "collectible"],
  });
  assert.equal(r.recovered, false);
  assert.equal(r.reason, "no_family_in_master_output");
});

test("recovery requires an airline (no airline → no recovery)", () => {
  const r = recoverFamilyFromMasterFields({
    incompleteQuery: "model airplane",
    requiredAirline: "",
    candidateStrings: ["787 model airplane"],
    fieldValues: [],
  });
  assert.equal(r.recovered, false);
});

test("synthesized query stays airline-locked (keeps the required airline)", () => {
  const r = recoverFamilyFromMasterFields({
    incompleteQuery: "Hawaiian Airlines model airplane",
    requiredAirline: "hawaiian",
    candidateStrings: [],
    fieldValues: ["dreamliner"],
  });
  assert.equal(r.recovered, true);
  assert.ok(/hawaiian/i.test(r.query), "recovered query must keep the airline");
  assert.equal(r.family, "787");
});

// ── drift guard: module family set mirrors index.js AIRCRAFT_FAMILY_MAP ─────────

test("FIELD_RECOVERY_FAMILY_TOKENS keys match AIRCRAFT_FAMILY_MAP in index.js", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");
  const mapStart = src.indexOf("const AIRCRAFT_FAMILY_MAP = {");
  assert.ok(mapStart !== -1, "AIRCRAFT_FAMILY_MAP must exist in index.js");
  const mapBlock = src.slice(mapStart, src.indexOf("};", mapStart));
  const indexKeys = [...mapBlock.matchAll(/"([a-z0-9]+)":/g)].map((m) => m[1]).sort();
  const moduleKeys = Object.keys(FIELD_RECOVERY_FAMILY_TOKENS).sort();
  assert.deepEqual(moduleKeys, indexKeys,
    "module family set drifted from index.js AIRCRAFT_FAMILY_MAP — keep them in sync");
});
