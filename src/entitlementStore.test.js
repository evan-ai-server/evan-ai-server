// src/entitlementStore.test.js
// node --test src/entitlementStore.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  readAuthUserById,
  writeAuthUserPlan,
  resolveLivePlan,
  mapRevenueCatEventToPlan,
} from "./entitlementStore.js";

async function withTempAuthDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "evan-entitlement-test-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeFixture(dir, filename, record) {
  await fs.writeFile(path.join(dir, filename), JSON.stringify(record, null, 2), "utf8");
}

// ── readAuthUserById ──────────────────────────────────────────────────────

test("readAuthUserById finds a record by userId via directory scan", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", { userId: "u1", email: "a@x.com", plan: "free" });
    const found = await readAuthUserById("u1", { authUsersDir: dir });
    assert.ok(found);
    assert.equal(found.record.userId, "u1");
  });
});

test("readAuthUserById returns null for an unknown userId", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", { userId: "u1", plan: "free" });
    const found = await readAuthUserById("u_missing", { authUsersDir: dir });
    assert.equal(found, null);
  });
});

// ── resolveLivePlan ───────────────────────────────────────────────────────

test("resolveLivePlan defaults a missing plan field to free", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", { userId: "u1", email: "a@x.com" }); // no plan field
    const plan = await resolveLivePlan("u1", null, { authUsersDir: dir });
    assert.equal(plan, "free");
  });
});

test("resolveLivePlan returns null for an unknown user (caller falls back to JWT claim)", async () => {
  await withTempAuthDir(async (dir) => {
    const plan = await resolveLivePlan("ghost", null, { authUsersDir: dir });
    assert.equal(plan, null);
  });
});

test("resolveLivePlan resolves an active paid plan", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", {
      userId: "u1",
      plan: "hunter",
      planExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const plan = await resolveLivePlan("u1", null, { authUsersDir: dir });
    assert.equal(plan, "hunter");
  });
});

test("resolveLivePlan downgrades an expired plan to free", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", {
      userId: "u1",
      plan: "pro",
      planExpiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const plan = await resolveLivePlan("u1", null, { authUsersDir: dir });
    assert.equal(plan, "free");
  });
});

test("resolveLivePlan never expires an internal plan", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", {
      userId: "u1",
      plan: "internal",
      planExpiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const plan = await resolveLivePlan("u1", null, { authUsersDir: dir });
    assert.equal(plan, "internal");
  });
});

// ── writeAuthUserPlan ─────────────────────────────────────────────────────

test("writeAuthUserPlan updates the plan atomically and is re-readable", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", { userId: "u1", email: "a@x.com", plan: "free" });
    const result = await writeAuthUserPlan(
      "u1",
      { plan: "pro", source: "revenuecat", eventTsMs: Date.now() },
      { authUsersDir: dir }
    );
    assert.equal(result.ok, true);
    const found = await readAuthUserById("u1", { authUsersDir: dir });
    assert.equal(found.record.plan, "pro");
    assert.equal(found.record.entitlementSource, "revenuecat");
  });
});

test("writeAuthUserPlan is a safe no-op for an unknown userId (never fakes a record)", async () => {
  await withTempAuthDir(async (dir) => {
    const result = await writeAuthUserPlan("ghost", { plan: "pro", eventTsMs: Date.now() }, { authUsersDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "user_not_found");
  });
});

test("writeAuthUserPlan last-write-wins ignores an older event", async () => {
  await withTempAuthDir(async (dir) => {
    await writeFixture(dir, "abc.json", { userId: "u1", plan: "pro", entitlementUpdatedAt: 2000 });
    const result = await writeAuthUserPlan("u1", { plan: "free", eventTsMs: 1000 }, { authUsersDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stale_event");
    const found = await readAuthUserById("u1", { authUsersDir: dir });
    assert.equal(found.record.plan, "pro"); // unchanged
  });
});

// ── mapRevenueCatEventToPlan ──────────────────────────────────────────────

test("mapRevenueCatEventToPlan: pro entitlement on INITIAL_PURCHASE", () => {
  const r = mapRevenueCatEventToPlan(
    { type: "INITIAL_PURCHASE", entitlement_ids: ["pro"] },
    { entitlementHunterId: "hunter", entitlementProId: "pro" }
  );
  assert.equal(r.plan, "pro");
  assert.equal(r.changed, true);
});

test("mapRevenueCatEventToPlan: hunter entitlement on RENEWAL", () => {
  const r = mapRevenueCatEventToPlan(
    { type: "RENEWAL", entitlement_ids: ["hunter"] },
    { entitlementHunterId: "hunter", entitlementProId: "pro" }
  );
  assert.equal(r.plan, "hunter");
  assert.equal(r.changed, true);
});

test("mapRevenueCatEventToPlan: unrecognized entitlement on a granting event defaults to free", () => {
  const r = mapRevenueCatEventToPlan(
    { type: "INITIAL_PURCHASE", entitlement_ids: ["some_other_product"] },
    { entitlementHunterId: "hunter", entitlementProId: "pro" }
  );
  assert.equal(r.plan, "free");
  assert.equal(r.changed, true);
});

test("mapRevenueCatEventToPlan: EXPIRATION revokes to free", () => {
  const r = mapRevenueCatEventToPlan({ type: "EXPIRATION", entitlement_ids: ["pro"] });
  assert.equal(r.plan, "free");
  assert.equal(r.changed, true);
});

test("mapRevenueCatEventToPlan: CANCELLATION does not change plan (access continues until EXPIRATION)", () => {
  const r = mapRevenueCatEventToPlan({ type: "CANCELLATION", entitlement_ids: ["pro"] });
  assert.equal(r.changed, false);
});

test("mapRevenueCatEventToPlan: unknown event type is a safe no-op", () => {
  const r = mapRevenueCatEventToPlan({ type: "BILLING_ISSUE", entitlement_ids: ["pro"] });
  assert.equal(r.changed, false);
});
