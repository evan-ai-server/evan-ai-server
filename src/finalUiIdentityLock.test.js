import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { filterFinalUiByAircraftIdentity } from "./finalUiIdentityLock.js";

// Hawaiian lock fixtures (mirror index.js AIRLINE_COMPETITOR_MAP.hawaiian +
// AIRCRAFT_FAMILY_MAP["787"] + COMPETITOR_AIRCRAFT_ALIASES).
const HAWAIIAN_COMPETITORS = [
  "united", "delta", "american airlines", "southwest", "alaska", "jetblue",
  "spirit", "frontier", "ana", "jal", "lufthansa", "emirates",
  "british airways", "air france", "klm", "aeromexico",
];
const FAMILY_787 = ["787 9", "787", "dreamliner", "boeing 787"];
const ALIASES = { "american airlines": ["american"], "ana": ["all nippon"], "jal": ["japan airlines"] };

const LOCK = {
  requiredAirline: "hawaiian",
  competitors: HAWAIIAN_COMPETITORS,
  requiredFamily: "787",
  familyTokens: FAMILY_787,
  competitorAliases: ALIASES,
};

// The live-leak candidate pool for query
// "geminijets hawaiian airlines boeing 787 9 dreamliner diecast model airplane".
const CANDIDATES = [
  { title: "GeminiJets 787-9 Hawaiian Airlines Dreamliner Diecast Model" },                 // keep
  { title: "Herpa Wings Hawaiian Airlines Boeing 787-9 Dreamliner N781HA 614405" },          // keep
  { title: 'Boeing 787-9 Commercial Aircraft "Hawaiian Airlines" (N781HA) White Tail' },     // keep
  { title: 'Boeing 787-9 Commercial Aircraft "Gulf Air - 70th Anniversary" by GeminiJets' }, // reject: missing airline (the leak)
  { title: "787-9 Dreamliner 1:400 Diecast Model - Aviation 400 AV-AV4194" },                // reject: missing airline (the leak)
  { title: "GeminiJets 1:400 Boeing 787-9 Dreamliner - Qantas Airways" },                    // reject: missing airline
  { title: "Gemini Jets Alaska Airlines Boeing 787-9 Diecast Model Plane" },                 // reject: competitor
  { title: "ANA All Nippon Airways Boeing 787 Acrylic Model" },                              // reject: competitor
  { title: "Hawaiian Airlines Boeing 777 Airplane Model (19CM)" },                           // reject: wrong family
];

test("Hawaiian 787 lock keeps only Hawaiian 787 comps", () => {
  const r = filterFinalUiByAircraftIdentity(CANDIDATES, LOCK);
  const titles = r.kept.map((i) => i.title);
  assert.equal(r.kept.length, 3, JSON.stringify(titles));
  for (const t of titles) {
    assert.ok(/hawaiian/i.test(t), `kept item must name Hawaiian: ${t}`);
    assert.ok(/787|dreamliner/i.test(t), `kept item must be 787 family: ${t}`);
  }
});

test("Gulf Air and generic 787-9 Dreamliner can NEVER appear (the live leak)", () => {
  const r = filterFinalUiByAircraftIdentity(CANDIDATES, LOCK);
  const titles = r.kept.map((i) => i.title.toLowerCase());
  assert.ok(!titles.some((t) => t.includes("gulf air")), "Gulf Air must be rejected");
  assert.ok(!titles.some((t) => t.includes("aviation 400")), "generic Aviation 400 787-9 must be rejected");
  assert.ok(!titles.some((t) => t.includes("qantas")), "Qantas must be rejected");
  assert.ok(!titles.some((t) => t.includes("alaska")), "Alaska must be rejected");
  assert.ok(!titles.some((t) => t.includes("ana ") || t.includes("all nippon")), "ANA must be rejected");
});

test("per-reason rejection counts are reported", () => {
  const r = filterFinalUiByAircraftIdentity(CANDIDATES, LOCK);
  assert.equal(r.rejectedCompetitor, 2, "alaska + ANA");
  assert.equal(r.rejectedMissingAirline, 3, "Gulf Air + Aviation 400 + Qantas");
  assert.equal(r.rejectedFamily, 1, "Hawaiian 777");
});

test("never refills: an all-off-identity pool yields zero kept (honest thin market)", () => {
  const r = filterFinalUiByAircraftIdentity(
    [{ title: "Gulf Air 787-9" }, { title: "generic 787-9 dreamliner" }, { title: "Alaska 787-9" }],
    LOCK,
  );
  assert.equal(r.kept.length, 0);
});

test("no airline in lock → passthrough (guard is a no-op)", () => {
  const r = filterFinalUiByAircraftIdentity(CANDIDATES, { requiredAirline: null });
  assert.equal(r.kept.length, CANDIDATES.length);
});

test("airline present but no required family → only airline + competitor enforced", () => {
  const r = filterFinalUiByAircraftIdentity(
    [{ title: "Hawaiian Airlines 777 model" }, { title: "Delta 787 model" }, { title: "generic 787" }],
    { requiredAirline: "hawaiian", competitors: HAWAIIAN_COMPETITORS, requiredFamily: null, familyTokens: [], competitorAliases: ALIASES },
  );
  const titles = r.kept.map((i) => i.title);
  assert.deepEqual(titles, ["Hawaiian Airlines 777 model"]);
});

// ── drift guard: index.js wires the helper with the real maps ────────────────
test("index.js calls filterFinalUiByAircraftIdentity with family + aliases", () => {
  const indexPath = resolve(new URL(import.meta.url).pathname, "../../index.js");
  const src = readFileSync(indexPath, "utf8");
  const idx = src.indexOf("filterFinalUiByAircraftIdentity(uiItems");
  assert.ok(idx !== -1, "final UI lock must call the helper with uiItems");
  const block = src.slice(idx, idx + 400);
  assert.ok(block.includes("AIRCRAFT_FAMILY_MAP"), "must pass family tokens from AIRCRAFT_FAMILY_MAP");
  assert.ok(block.includes("COMPETITOR_AIRCRAFT_ALIASES"), "must pass competitor aliases");
});
