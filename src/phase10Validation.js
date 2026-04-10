// src/phase10Validation.js
// Phase 10 — Validation Suite.
//
// Tests all Phase 10 schema/model layer correctness:
//   A. Listing record lifecycle (DRAFT → ACTIVE → SOLD)
//   B. Transaction ledger — double-entry balance
//   C. Transaction ledger — ADJUSTMENT requires reason (fail-closed)
//   D. Lot creation + item assessment persistence
//   E. Inventory — quantity, conditionNotes, sourceType enum validation
//   F. Outcome — dispute/counterfeit flags + financial correction audit trail
//   G. Affiliate kill-switch — visionConfidence < 65 blocks links
//   H. Affiliate kill-switch — visionConfidence >= 65 allows links
//   I. Reporting engine — telemetry export structure + signal accuracy
//   J. Lot lot source type normalization (invalid → OTHER)
//
// All tests use an in-memory mock Redis (ioredis API).

import { createListing, getListing, activateListing, markListingSold, endListing,
         getListingMetrics, LISTING_STATUS } from "./listingRecordModel.js";

import { recordEntry, recordPurchase, recordSale, recordFee, recordAdjustment,
         getLedgerBalance, getEntriesForRelated, TXN_TYPE, TXN_DIRECTION } from "./transactionLedger.js";

import { createLot, getLot, addItemsToLot, closeLot, LOT_STATUS, LOT_SOURCE_TYPE }
  from "./lotAssessmentEngine.js";

import { createInventoryItem, SOURCE_TYPE } from "./inventoryEngine.js";

import { initOutcome, transitionOutcome, setOutcomeFlags, correctOutcomeFinancials,
         OUTCOME_STATES } from "./outcomeEngine.js";

import { attachAffiliateLinksToPayload, AFFILIATE_CONFIDENCE_THRESHOLD }
  from "./affiliateRouter.js";

// ── Mock Redis (ioredis-compatible) ──────────────────────────────────────────

function makeMockRedis() {
  const store  = new Map();   // key → value
  const hashes = new Map();   // key → Map<field, value>
  const zsets  = new Map();   // key → Map<member, score>

  // Unified set — handles both ioredis ("EX", ttl) and node-redis v4 ({ EX: ttl })
  function _rawSet(key, val, exFlagOrOpts, ttlSecs) {
    store.set(key, val);
    return "OK";
  }

  // Unified zadd — handles both ioredis (score, member) and node-redis v4 ([{score,value}])
  function _rawZadd(key, scoreOrArr, member) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    const z = zsets.get(key);
    if (Array.isArray(scoreOrArr)) {
      // node-redis v4: zadd(key, [{ score, value }])
      for (const { score, value } of scoreOrArr) z.set(value, score);
    } else {
      // ioredis: zadd(key, score, member)
      z.set(member, scoreOrArr);
    }
    return 1;
  }

  // Unified zrem
  function _rawZrem(key, ...members) {
    const z = zsets.get(key);
    if (!z) return 0;
    for (const m of members) z.delete(m);
    return members.length;
  }

  // Unified hIncrBy
  function _rawHincrby(key, field, n) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    const h = hashes.get(key);
    const cur = Number(h.get(field) || 0);
    h.set(field, String(cur + n));
    return cur + n;
  }

  const redis = {
    // ── String ops ──────────────────────────────────────────────────────
    async get(key)               { return store.get(key) ?? null; },
    async set(key, val, a, b)    { return _rawSet(key, val, a, b); },

    // ── TTL ─────────────────────────────────────────────────────────────
    async expire(key, ttl)       { return 1; },

    // ── Sorted set (ioredis lowercase) ───────────────────────────────────
    async zadd(key, score, member)            { return _rawZadd(key, score, member); },
    async zcard(key)                          { return zsets.get(key)?.size ?? 0; },
    async zremrangebyrank(key, start, stop)   { return 0; },
    async zrangebyscore(key, min, max, ...args) {
      const z = zsets.get(key);
      if (!z) return [];
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ?  Infinity : Number(max);
      const all = [...z.entries()].filter(([,s]) => s >= lo && s <= hi)
        .sort((a,b) => a[1]-b[1]).map(([k])=>k);
      const li = args.indexOf("LIMIT");
      if (li >= 0) { const off=Number(args[li+1])||0, cnt=Number(args[li+2])||all.length; return all.slice(off,off+cnt); }
      return all;
    },
    async zrevrangebyscore(key, max, min, ...args) {
      const z = zsets.get(key);
      if (!z) return [];
      const lo = min === "-inf" ? -Infinity : Number(min);
      const hi = max === "+inf" ?  Infinity : Number(max);
      const all = [...z.entries()].filter(([,s]) => s >= lo && s <= hi)
        .sort((a,b) => b[1]-a[1]).map(([k])=>k);
      const li = args.indexOf("LIMIT");
      if (li >= 0) { const off=Number(args[li+1])||0, cnt=Number(args[li+2])||all.length; return all.slice(off,off+cnt); }
      return all;
    },

    // ── Sorted set (node-redis v4 PascalCase) ────────────────────────────
    async zAdd(key, members)                       { return _rawZadd(key, members); },
    async zRem(key, ...members)                    { return _rawZrem(key, ...members); },
    async zRemRangeByRank(key, start, stop)        { return 0; },
    async zCard(key)                               { return zsets.get(key)?.size ?? 0; },
    async zRange(key, start, stop, opts)           { return []; },

    // ── Hash (ioredis lowercase) ─────────────────────────────────────────
    async hgetall(key) {
      const h = hashes.get(key);
      return h ? Object.fromEntries(h.entries()) : {};
    },
    async hincrby(key, field, n)      { return _rawHincrby(key, field, n); },
    async hincrbyfloat(key, field, n) { return _rawHincrby(key, field, n); },

    // ── Hash (node-redis v4 PascalCase) ──────────────────────────────────
    async hGetAll(key) {
      const h = hashes.get(key);
      return h ? Object.fromEntries(h.entries()) : {};
    },
    async hIncrBy(key, field, n)      { return _rawHincrby(key, field, n); },
    async hSet(key, field, val) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key).set(field, val); return 1;
    },

    // ── Pipeline / Multi (supports both ioredis and node-redis v4 APIs) ──
    pipeline() {
      const ops = [];
      const pipe = {
        // ioredis lowercase
        set(key,val,a,b)          { ops.push(async()=>redis.set(key,val,a,b)); return pipe; },
        get(key)                  { ops.push(async()=>redis.get(key)); return pipe; },
        expire(key,ttl)           { ops.push(async()=>redis.expire(key,ttl)); return pipe; },
        zadd(key,score,member)    { ops.push(async()=>redis.zadd(key,score,member)); return pipe; },
        zcard(key)                { ops.push(async()=>redis.zcard(key)); return pipe; },
        zremrangebyrank(key,s,e)  { ops.push(async()=>redis.zremrangebyrank(key,s,e)); return pipe; },
        hincrby(key,f,n)          { ops.push(async()=>redis.hincrby(key,f,n)); return pipe; },
        hincrbyfloat(key,f,n)     { ops.push(async()=>redis.hincrbyfloat(key,f,n)); return pipe; },
        // node-redis v4 PascalCase
        zAdd(key,members)         { ops.push(async()=>redis.zAdd(key,members)); return pipe; },
        zRem(key,...ms)           { ops.push(async()=>redis.zRem(key,...ms)); return pipe; },
        zRemRangeByRank(key,s,e)  { ops.push(async()=>redis.zRemRangeByRank(key,s,e)); return pipe; },
        hIncrBy(key,f,n)          { ops.push(async()=>redis.hIncrBy(key,f,n)); return pipe; },
        hSet(key,f,v)             { ops.push(async()=>redis.hSet(key,f,v)); return pipe; },
        async exec() {
          const results = [];
          for (const op of ops) results.push([null, await op()]);
          return results;
        },
      };
      return pipe;
    },
    multi() { return this.pipeline(); },
  };
  return redis;
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(label, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── Scenario A: Listing record lifecycle ─────────────────────────────────────

async function scenarioA() {
  console.log("\n[A] Listing Record Lifecycle");
  const redis = makeMockRedis();

  const { ok, listingId, listing } = await createListing(redis, {
    userId: "u1", invId: "inv_abc",
    marketplace: "ebay", listedPrice: 89.99,
    listingUrl: "https://ebay.com/123", startDraft: true,
  });
  assert("create listing in DRAFT", ok && listing.status === LISTING_STATUS.DRAFT);
  assert("listedPrice stored correctly", listing.listedPrice === 89.99);
  assert("marketplace normalized", listing.marketplace === "ebay");

  const act = await activateListing(redis, listingId);
  assert("activate → ACTIVE", act.ok && act.listing.status === LISTING_STATUS.ACTIVE);

  const sold = await markListingSold(redis, listingId, {
    soldPrice: 95.00, fees: 12.64, shippingCost: 5.00,
  });
  assert("mark SOLD", sold.ok && sold.listing.status === LISTING_STATUS.SOLD);
  assert("netProceeds computed", sold.listing.netProceeds === 77.36);  // 95 - 12.64 - 5

  // Attempt invalid transition: SOLD → ACTIVE
  const bad = await activateListing(redis, listingId);
  assert("invalid transition blocked", !bad.ok && bad.error === "invalid_transition");

  // Create a second listing and end it
  const { listingId: lst2 } = await createListing(redis, {
    userId: "u1", invId: "inv_def", marketplace: "poshmark", listedPrice: 45.00,
  });
  const ended = await endListing(redis, lst2, { reason: "relisting_elsewhere" });
  assert("end listing → ENDED", ended.ok && ended.listing.endReason === "relisting_elsewhere");
}

// ── Scenario B: Transaction ledger — double-entry balance ─────────────────────

async function scenarioB() {
  console.log("\n[B] Transaction Ledger — Double-Entry Balance");
  const redis = makeMockRedis();

  // Simulate: buy for $30, sell for $75, pay $10 fee, $5 shipping
  await recordPurchase(redis, "u2", { amount: 30, invId: "inv_xyz", recordedBy: "/scan/buy-outcome" });
  await recordSale(redis, "u2", { amount: 75, listingId: "lst_xyz" });
  await recordFee(redis, "u2", { amount: 10, listingId: "lst_xyz" });
  await recordShippingCost(redis, "u2", { amount: 5, listingId: "lst_xyz" });

  const bal = await getLedgerBalance(redis, "u2");
  assert("balance computed", bal.balance === 30);               // 75 - 30 - 10 - 5 = 30
  assert("credits sum correct", bal.totalCredits === 75);
  assert("debits sum correct", bal.totalDebits === 45);         // 30 + 10 + 5
  assert("entry count correct", bal.entryCount === 4);

  // Verify related-entity lookup (sale + fee + shipping = 3; purchase uses invId as relatedId)
  const relEntries = await getEntriesForRelated(redis, "lst_xyz");
  assert("related entries found", relEntries.length === 3);
}

// ── Scenario C: Adjustment requires reason (fail-closed) ─────────────────────

async function scenarioC() {
  console.log("\n[C] Adjustment — Fail-Closed Without Reason");
  const redis = makeMockRedis();

  // Without reason — must fail
  const bad = await recordAdjustment(redis, "u3", {
    amount: 5, relatedId: "inv_bad",
    // adjustmentReason deliberately omitted
  });
  assert("adjustment without reason rejected", bad.error === "adjustment_requires_reason");

  // With reason — must succeed
  const good = await recordAdjustment(redis, "u3", {
    amount: 5, relatedId: "inv_ok",
    adjustmentReason:     "Misrecorded shipping cost",
    adjustmentApprovedBy: "user",
    description:          "Correction to shipping entry",
    recordedBy:           "/api/p10/ledger/adjust",
  });
  assert("adjustment with reason accepted", good.type === TXN_TYPE.ADJUSTMENT);
  assert("audit fields present", good.adjustmentReason === "Misrecorded shipping cost");
  assert("immutable marker set", good.immutable === true);
}

// ── Scenario D: Lot creation + item assessment ────────────────────────────────

async function scenarioD() {
  console.log("\n[D] Lot Assessment Engine — Create + Close");
  const redis = makeMockRedis();

  const { ok, lotId, lot } = await createLot(redis, {
    userId: "u4", name: "Estate Sale — Oak Park March 2026",
    sourceType: "ESTATE_SALE", location: "Oak Park, IL",
    totalPaid: 120.00, notes: "20 items total",
  });
  assert("lot created", ok && lot.status === LOT_STATUS.DRAFT);
  assert("sourceType normalized", lot.sourceType === LOT_SOURCE_TYPE.ESTATE_SALE);
  assert("totalPaid stored", lot.totalPaid === 120);

  // Close without adding items
  const closed = await closeLot(redis, lotId, { notes: "Closed after review" });
  assert("lot closed", closed.ok && closed.lot.status === LOT_STATUS.CLOSED);
  assert("frozen summary present", closed.lot.closedSummary !== null);
  assert("closedAt set", closed.lot.closedAt > 0);

  // Adding to closed lot must fail
  const addFail = await addItemsToLot(redis, lotId, ["scan_123"], { userId: "u4" });
  assert("cannot add items to closed lot", !addFail.ok && addFail.error === "lot_closed");
}

// ── Scenario E: Inventory enhancements — quantity, conditionNotes, sourceType ─

async function scenarioE() {
  console.log("\n[E] Inventory — Phase 10 Fields (quantity, conditionNotes, sourceType)");
  const redis = makeMockRedis();

  // Valid sourceType from enum
  const r1 = await createInventoryItem(redis, {
    userId: "u5", scanId: "scan_e1", purchasePrice: 25,
    sourceType: "THRIFT", quantity: 3, conditionNotes: "Slight fading on left sleeve",
  });
  assert("inventory created", r1.ok && r1.created);
  assert("sourceType stored as enum", r1.item.sourceType === SOURCE_TYPE.THRIFT);
  assert("quantity stored", r1.item.quantity === 3);
  assert("conditionNotes stored", r1.item.conditionNotes === "Slight fading on left sleeve");

  // Invalid sourceType → falls back to OTHER
  const r2 = await createInventoryItem(redis, {
    userId: "u5", scanId: "scan_e2", purchasePrice: 10,
    sourceType: "GARAGE_SALE",  // not in enum
  });
  assert("invalid sourceType normalized to OTHER", r2.ok && r2.item.sourceType === SOURCE_TYPE.OTHER);

  // Idempotent: same scanId returns existing item
  const r3 = await createInventoryItem(redis, {
    userId: "u5", scanId: "scan_e1", purchasePrice: 999,
  });
  assert("idempotent creation", r3.ok && !r3.created && r3.item.purchasePrice === 25);

  // Invalid quantity → minimum 1
  const r4 = await createInventoryItem(redis, {
    userId: "u5", scanId: "scan_e3", purchasePrice: 15,
    quantity: -5,
  });
  assert("negative quantity clamped to 1", r4.ok && r4.item.quantity === 1);
}

// ── Scenario F: Outcome flags + financial correction ─────────────────────────

async function scenarioF() {
  console.log("\n[F] Outcome — Dispute Flags + Financial Correction Audit");
  const redis = makeMockRedis();

  // Init outcome
  await initOutcome(redis, null, "u6", "scan_f1", {
    category: "sneakers", brand: "nike", buySignal: "GOOD DEAL",
    scannedPrice: 80, confidenceV2: 0.78,
  });

  // Transition to BOUGHT
  await transitionOutcome(redis, null, "u6", "scan_f1", "BOUGHT", { buyPrice: 80 });

  // Set dispute flag
  const flagged = await setOutcomeFlags(redis, null, "u6", "scan_f1", {
    disputeFlag: true, notes: "Buyer claims item not as described",
  });
  assert("dispute flag set", flagged.ok && flagged.record.disputeFlag === true);
  assert("correction history updated", flagged.record.correctionHistory.length === 1);
  assert("flag change logged with type", flagged.record.correctionHistory[0].type === "flag_change");

  // Financial correction — must have reason
  const badCorr = await correctOutcomeFinancials(redis, null, "u6", "scan_f1",
    { buyPrice: 85 }, { reason: "" }  // empty reason
  );
  assert("correction without reason rejected", badCorr.error === "correction_requires_reason");

  // Correction with reason
  const goodCorr = await correctOutcomeFinancials(redis, null, "u6", "scan_f1",
    { buyPrice: 82 }, { reason: "Receipt showed higher price", correctedBy: "user" }
  );
  assert("financial correction applied", goodCorr.ok && goodCorr.record.buyPrice === 82);
  assert("correction in history", goodCorr.record.correctionHistory.length === 2);
  assert("reason preserved",
    goodCorr.record.correctionHistory[1].reason === "Receipt showed higher price");
  assert("original value preserved in diff",
    goodCorr.applied.buyPrice?.from === 80);
}

// ── Scenario G: Affiliate kill-switch — low confidence blocks ─────────────────

async function scenarioG() {
  console.log("\n[G] Affiliate Kill-Switch — Low Confidence Blocks");

  const payload = {
    visionConfidence: 55,   // below 65 threshold
    profitIntel: {
      items: [
        { url: "https://www.ebay.com/itm/123456", title: "Nike Dunk" },
      ],
    },
  };

  attachAffiliateLinksToPayload(payload);

  assert("affiliate blocked on low confidence", payload._affiliateBlocked === true);
  assert("block reason is low_confidence", payload._affiliateBlockReason === "low_vision_confidence");
  assert("no disclosure attached", !payload.affiliateDisclosure);
  assert("block confidence recorded", payload._affiliateConfidence === 55);
  assert("threshold recorded", payload._affiliateThreshold === AFFILIATE_CONFIDENCE_THRESHOLD);
  // Items should be untouched
  assert("original items untouched",
    payload.profitIntel.items[0].isAffiliate === undefined);
}

// ── Scenario H: Affiliate kill-switch — high confidence allows ────────────────

async function scenarioH() {
  console.log("\n[H] Affiliate Kill-Switch — High Confidence Allows");

  const payload = {
    visionConfidence: 88,   // above 65 threshold
    profitIntel: {
      items: [
        { url: "https://www.ebay.com/itm/999", title: "Air Max 90" },
      ],
    },
  };

  attachAffiliateLinksToPayload(payload);

  // eBay EPN not configured in test env, so isAffiliate won't be set,
  // but importantly the kill-switch should NOT have fired
  assert("kill-switch not triggered", payload._affiliateBlocked !== true);
  assert("no block reason", !payload._affiliateBlockReason);
}

// ── Scenario I: Reporting engine structure ────────────────────────────────────

async function scenarioI() {
  console.log("\n[I] Reporting Engine — Telemetry Structure");
  const { getTelemetryExport } = await import("./reportingEngine.js");
  const redis = makeMockRedis();

  // Record a few ledger entries to give the engine something to aggregate
  await recordPurchase(redis, "u9", { amount: 50, invId: "inv_i1" });
  await recordSale(redis, "u9", { amount: 90, invId: "inv_i1" });
  await recordFee(redis, "u9", { amount: 11, listingId: "lst_i1" });

  const telemetry = await getTelemetryExport(redis, null, "u9");
  assert("telemetry ok", telemetry.ok === true);
  assert("schemaVersion present", telemetry.schemaVersion === "10.0");
  assert("reportVersion present", telemetry.reportVersion === "10.0");
  assert("ledger section present", telemetry.ledger?.entryCount === 3);
  assert("timePeriodPnL present", typeof telemetry.timePeriodPnL === "object");
  assert("signalAccuracy array", Array.isArray(telemetry.signalAccuracy));
  assert("dataQuality present", telemetry.dataQuality?.level != null);
}

// ── Scenario J: Lot source type normalization ─────────────────────────────────

async function scenarioJ() {
  console.log("\n[J] Lot Source Type — Invalid Value → OTHER");
  const redis = makeMockRedis();

  const r = await createLot(redis, {
    userId: "u10", name: "Test lot",
    sourceType: "YARDSALE",   // not in enum
  });
  assert("invalid sourceType → OTHER", r.ok && r.lot.sourceType === LOT_SOURCE_TYPE.OTHER);

  const r2 = await createLot(redis, {
    userId: "u10", name: "Thrift lot",
    sourceType: "THRIFT",
  });
  assert("valid sourceType preserved", r2.ok && r2.lot.sourceType === LOT_SOURCE_TYPE.THRIFT);
}

// ── Import missing function for scenario B ────────────────────────────────────

async function recordShippingCost(redis, userId, opts) {
  return recordEntry(redis, userId, {
    type: TXN_TYPE.SHIPPING_COST,
    amount: opts.amount,
    relatedId: opts.listingId,
    relatedType: "listing",
    description: "Shipping cost",
    recordedBy: "test",
  });
}

// Export for route-level invocation (non-process-exit mode)
export async function runPhase10Validations() {
  const savedPassed = passed;
  const savedFailed = failed;
  // Reset counters for isolated run
  passed = 0; failed = 0;
  await runAll(false);
  const result = { passed, failed, total: passed + failed };
  // Restore if running in combined context
  passed = savedPassed + result.passed;
  failed = savedFailed + result.failed;
  return result;
}

async function runAll(doExit = true) {
  if (doExit) {
    console.log("══════════════════════════════════════════════════════");
    console.log("  Phase 10 Validation — Schema & Model Layer");
    console.log("══════════════════════════════════════════════════════");
  }

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF();
  await scenarioG();
  await scenarioH();
  await scenarioI();
  await scenarioJ();

  if (doExit) {
    console.log("\n══════════════════════════════════════════════════════");
    const total = passed + failed;
    console.log(`  Results: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ""}`);
    console.log("══════════════════════════════════════════════════════\n");
    if (failed > 0) process.exit(1);
  }
}

// CLI entry point
runAll(true).catch(err => { console.error("Validation crashed:", err); process.exit(1); });
