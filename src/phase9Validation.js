// src/phase9Validation.js
// Phase 9 — Partner Infrastructure Readiness Test Suite.
//
// 12 scenarios covering partner auth, compliance, widgets, analytics,
// trust packets, webhooks, failsafe, schema contracts, and workflows.
//
// Run: node -e "import('./src/phase9Validation.js').then(m => m.runPhase9Validations())"

import { registerPartner, issuePartnerJWT, verifyPartnerJWT, filterPayloadByScopes, PARTNER_TIER, SCOPE } from "./partnerAuthTierEngine.js";
import { guardEmbeddedRequest, getComplianceOps, COMPLIANCE_DECISION } from "./embeddedComplianceGuard.js";
import { resolveEmbeddedVerification } from "./embeddedVerificationResolver.js";
import { registerWidgetDomain, isWidgetDomainAllowed, generateWidgetNonce, verifyWidgetNonce, buildEmbedWidget } from "./embedWidgetEngine.js";
import { trackAnalyticsEvent, getDownstreamTrustRecord, getAnalyticsOps, ANALYTICS_EVENT } from "./embeddedAnalyticsEngine.js";
import { buildTrustPacket, PACKET_TYPE } from "./marketplaceTrustPacketEngine.js";
import { registerWebhook, dispatchWebhookEvent, getPartnerWebhooks, getWebhookOps } from "./partnerWebhookEngine.js";
import { checkFailsafe, FAILSAFE_STATE } from "./embeddedFailsafeEngine.js";
import { checkSchemaCompatibility, transformToVersion, pinPartnerSchema, getSchemaContract } from "./partnerSchemaContracts.js";
import { buildListingPrefill, buildValuationHandoff, buildSellPackage } from "./workflowIntegrationPrimitives.js";
import { buildPartnerDashboard } from "./partnerDashboardEngine.js";
import { CLAIM_TYPE } from "./externalClaimGovernor.js";
import { BADGE_TYPE } from "./externalBadgePolicyEngine.js";

// ── Mock Redis ────────────────────────────────────────────────────────────

function makeMockRedis() {
  const store   = new Map();
  const hashes  = new Map();
  const zsets   = new Map();
  const lists   = new Map();

  return {
    get:       async (k)     => store.get(k) ?? null,
    set:       async (k, v, opts) => { store.set(k, v); return "OK"; },
    del:       async (k)     => { store.delete(k); return 1; },
    incr:      async (k)     => { const n = (Number(store.get(k)) || 0) + 1; store.set(k, String(n)); return n; },
    expire:    async ()      => 1,
    hSet:      async (k, f, v) => {
      if (!hashes.has(k)) hashes.set(k, {});
      if (typeof f === "object") Object.assign(hashes.get(k), f);
      else hashes.get(k)[f] = String(v ?? "");
      return 1;
    },
    hGet:      async (k, f)  => hashes.get(k)?.[f] ?? null,
    hGetAll:   async (k)     => hashes.get(k) || {},
    hIncrBy:   async (k, f, n) => {
      if (!hashes.has(k)) hashes.set(k, {});
      const val = (Number(hashes.get(k)[f]) || 0) + Number(n);
      hashes.get(k)[f] = String(val);
      return val;
    },
    hIncrByFloat: async (k, f, n) => {
      if (!hashes.has(k)) hashes.set(k, {});
      const val = (parseFloat(hashes.get(k)[f]) || 0) + Number(n);
      hashes.get(k)[f] = String(val);
      return val;
    },
    zAdd:      async (k, members) => {
      if (!zsets.has(k)) zsets.set(k, []);
      const z = zsets.get(k);
      for (const m of (Array.isArray(members) ? members : [members])) {
        const idx = z.findIndex(x => x.value === m.value);
        if (idx >= 0) z[idx].score = m.score;
        else z.push({ score: m.score, value: m.value });
      }
      z.sort((a, b) => a.score - b.score);
      return members.length || 1;
    },
    zRange:    async (k, start, stop, opts) => {
      const z = zsets.get(k) || [];
      const sorted = opts?.REV ? [...z].reverse() : z;
      const end = stop === -1 ? sorted.length : stop + 1;
      return sorted.slice(start, end).map(x => x.value);
    },
    zRem:      async (k, v)  => { if (!zsets.has(k)) return 0; const z = zsets.get(k); const i = z.findIndex(x => x.value === v); if (i >= 0) z.splice(i, 1); return 1; },
    zRemRangeByRank: async () => 0,
    lPush:     async (k, v)  => { if (!lists.has(k)) lists.set(k, []); lists.get(k).unshift(v); return lists.get(k).length; },
    rPop:      async (k)     => { const l = lists.get(k); if (!l || !l.length) return null; return l.pop(); },
  };
}

// ── Test runner ───────────────────────────────────────────────────────────

export async function runPhase9Validations() {
  const results = [];
  const redis   = makeMockRedis();
  const PASS    = "✅ PASS";
  const FAIL    = "❌ FAIL";

  function record(id, name, passed, detail = "") {
    results.push({ id, name, passed, detail });
    console.log(`  ${passed ? PASS : FAIL}  Scenario ${id}: ${name}${detail ? " — " + detail : ""}`);
  }

  console.log("\n=== Phase 9 Partner Infrastructure Validation ===\n");

  // ── Scenario A: Partner registration + JWT issuance ────────────────────
  console.log("Scenario A: Partner Registration + JWT");
  let tokenA = null;
  try {
    const reg = await registerPartner(redis, {
      partnerId:    "partner_test_001",
      partnerName:  "TestCo Integration",
      tier:         PARTNER_TIER.DEVELOPER,
      contactEmail: "dev@testco.com",
      allowedDomains: ["testco.com"],
    });
    const jwt = await issuePartnerJWT(redis, {
      partnerId:     "partner_test_001",
      tier:          PARTNER_TIER.DEVELOPER,
    });
    tokenA = jwt.token;
    const verify = await verifyPartnerJWT(redis, tokenA);
    record("A", "Partner Registration + JWT", reg.ok && jwt.ok && verify.ok,
      `tier=${verify.tier} scopes=${verify.scopes?.length}`);
  } catch (e) {
    record("A", "Partner Registration + JWT", false, e.message);
  }

  // ── Scenario B: Scope filtering — profit margin blocked ───────────────
  console.log("Scenario B: Scope Filtering — profit margin blocked");
  try {
    const verify = await verifyPartnerJWT(redis, tokenA);
    const rawPayload = {
      price: 200,
      expectedProfit: 80,      // requires profit_margin scope
      estimatedValue: 220,
      brand: "Nike",
    };
    const filtered = filterPayloadByScopes(rawPayload, verify.scopes);
    const profitBlocked = filtered.expectedProfit === undefined;
    const priceVisible  = filtered.price === 200;
    record("B", "Scope filtering — profit_margin blocked for developer tier",
      profitBlocked && priceVisible,
      `profit blocked=${profitBlocked} price visible=${priceVisible}`);
  } catch (e) {
    record("B", "Scope Filtering", false, e.message);
  }

  // ── Scenario C: Compliance guard — approved ───────────────────────────
  console.log("Scenario C: Compliance Guard — approved path");
  try {
    const guard = await guardEmbeddedRequest(redis, {
      token:       tokenA,
      claimType:   CLAIM_TYPE.ITEM_VERIFIED,
      claimText:   "Evan-Verified",
      embedContext: "widget",
      badgeType:   BADGE_TYPE.EVAN_VERIFIED,
      payload:     { brand: "Nike", model: "Air Max 90", price: 200 },
      requestMeta: { domain: "testco.com" },
    });
    record("C", "Compliance guard — ITEM_VERIFIED + widget approved",
      guard.ok && guard.decision === COMPLIANCE_DECISION.APPROVED,
      `decision=${guard.decision}`);
  } catch (e) {
    record("C", "Compliance Guard", false, e.message);
  }

  // ── Scenario D: Compliance guard — PRICE_ACCURATE blocked on widget ───
  console.log("Scenario D: Compliance Guard — PRICE_ACCURATE blocked on widget");
  try {
    const guard = await guardEmbeddedRequest(redis, {
      token:       tokenA,
      claimType:   CLAIM_TYPE.PRICE_ACCURATE,
      claimText:   "This price is accurate",
      embedContext: "widget",
      payload:     { price: 200 },
      requestMeta: {},
    });
    // PUBLIC_VERIFICATION channel blocks PRICE_ACCURATE (per Phase 7 governance)
    record("D", "Compliance guard — PRICE_ACCURATE blocked (governance)",
      !guard.ok && guard.decision === COMPLIANCE_DECISION.BLOCKED_GOVERNANCE,
      `decision=${guard.decision}`);
  } catch (e) {
    record("D", "Compliance Guard Block", false, e.message);
  }

  // ── Scenario E: Domain whitelisting ────────────────────────────────────
  console.log("Scenario E: Widget Domain Whitelisting");
  try {
    await registerWidgetDomain(redis, "partner_test_001", "testco.com");
    const allowed    = await isWidgetDomainAllowed(redis, "partner_test_001", "testco.com");
    const blocked    = await isWidgetDomainAllowed(redis, "partner_test_001", "evil.com");
    const subdomain  = await isWidgetDomainAllowed(redis, "partner_test_001", "shop.testco.com");
    record("E", "Domain whitelisting — allow/block/subdomain",
      allowed && !blocked && subdomain,
      `allowed=${allowed} blocked=${!blocked} subdomain=${subdomain}`);
  } catch (e) {
    record("E", "Domain Whitelisting", false, e.message);
  }

  // ── Scenario F: Nonce generation + verification ────────────────────────
  console.log("Scenario F: Nonce Generation + Verification");
  try {
    const nonceResult = await generateWidgetNonce(redis, {
      partnerSecret: "test_secret_key",
      domain:        "testco.com",
      referenceId:   "ref_abc123",
      partnerId:     "partner_test_001",
    });
    const verify = await verifyWidgetNonce(redis, nonceResult.nonce);
    record("F", "Nonce generation + verification",
      nonceResult.ok && verify.valid,
      `nonce=${nonceResult.nonce?.slice(0, 8)}... valid=${verify.valid}`);
  } catch (e) {
    record("F", "Nonce System", false, e.message);
  }

  // ── Scenario G: Analytics + downstream_trust_id ────────────────────────
  console.log("Scenario G: Analytics + downstream_trust_id conversion");
  try {
    // Track a badge click first
    const click = await trackAnalyticsEvent(redis, {
      eventType:   ANALYTICS_EVENT.BADGE_CLICKED,
      referenceId: "ref_nike_001",
      partnerId:   "partner_test_001",
    });

    // Track a purchase conversion
    const purchase = await trackAnalyticsEvent(redis, {
      eventType:       ANALYTICS_EVENT.PURCHASE_ATTRIBUTED,
      referenceId:     "ref_nike_001",
      partnerId:       "partner_test_001",
      conversionValue: 189.99,
    });

    const dtRecord = await getDownstreamTrustRecord(redis, purchase.downstream_trust_id);
    record("G", "Analytics + downstream_trust_id attribution",
      click.ok && purchase.ok && !!purchase.downstream_trust_id && !!dtRecord,
      `dtid=${purchase.downstream_trust_id?.slice(0, 20)}... value=${dtRecord?.conversionValue}`);
  } catch (e) {
    record("G", "Analytics", false, e.message);
  }

  // ── Scenario H: Trust packet — marketplace type ────────────────────────
  console.log("Scenario H: Marketplace Trust Packet");
  try {
    const packet = await buildTrustPacket(redis, {
      packetType:  PACKET_TYPE.MARKETPLACE,
      referenceId: "ref_nike_001",
      token:       tokenA,
      embedContext: "marketplace",
      sourceData: {
        verified:   true,
        confidence: 0.88,
        identity:   { brand: "Nike", model: "Air Max 90" },
        condition:  "excellent",
      },
    });
    record("H", "Marketplace trust packet",
      packet.ok && packet.packetType === "marketplace" && !!packet.claimLanguage,
      `trustLevel=${packet.trustLevel} claim="${packet.claimLanguage?.slice(0, 30)}..."`);
  } catch (e) {
    record("H", "Trust Packet", false, e.message);
  }

  // ── Scenario I: Webhook registration + dispatch ────────────────────────
  console.log("Scenario I: Webhook Registration + Dispatch");
  try {
    const regResult = await registerWebhook(redis, {
      partnerId:   "partner_test_001",
      url:         "https://testco.com/webhooks/evan",
      secret:      "webhook_secret_xyz",
      events:      ["trust.verified", "trust.revoked"],
      description: "Primary webhook",
    });

    const dispatchResult = await dispatchWebhookEvent(redis, {
      partnerId: "partner_test_001",
      eventType: "trust.verified",
      payload:   { referenceId: "ref_nike_001", status: "ACTIVE" },
    });

    const webhooks = await getPartnerWebhooks(redis, "partner_test_001");
    record("I", "Webhook registration + dispatch",
      regResult.ok && dispatchResult.ok && webhooks.length > 0,
      `registered=${regResult.ok} dispatched=${dispatchResult.dispatched} endpoints=${webhooks.length}`);
  } catch (e) {
    record("I", "Webhooks", false, e.message);
  }

  // ── Scenario J: Failsafe — REVOKED hard block ──────────────────────────
  console.log("Scenario J: Failsafe — REVOKED hard block");
  try {
    const result = await checkFailsafe(redis, {
      referenceId: "ref_revoked_001",
      payload:     null,
      status:      "REVOKED",
      fetchError:  null,
    });
    record("J", "Failsafe — REVOKED → HARD_BLOCK",
      !result.ok && result.failsafeState === FAILSAFE_STATE.REVOKED,
      `state=${result.failsafeState} mode=${result.degradationMode}`);
  } catch (e) {
    record("J", "Failsafe REVOKED", false, e.message);
  }

  // ── Scenario K: Schema contracts + compatibility ───────────────────────
  console.log("Scenario K: Schema Contracts + Compatibility Check");
  try {
    // Server is on 3.0 — partner requires 2.0 (should pass)
    const compat = checkSchemaCompatibility("verification", "2.0");

    // Transform 3.0 → 2.0
    const data30 = { referenceId: "r1", verified: true, status: "ACTIVE", badgeUrl: "x", verifyUrl: "y", referenceType: "ITEM", issuedAt: 1000, auditHash: "abc", institutionalIds: {} };
    const xform  = transformToVersion("verification", "2.0", data30);

    // Incompatible check (server 3.0 < min 5.0)
    const incompat = checkSchemaCompatibility("verification", "5.0");

    // Get contract
    const contract = getSchemaContract("verification", "3.0");

    record("K", "Schema compatibility + transform",
      compat.ok && xform.ok && !incompat.ok && !!contract,
      `compat=${compat.ok} transformed=${xform.ok} incompat blocked=${!incompat.ok} transforms=${xform.transformsApplied?.join(",")}`);
  } catch (e) {
    record("K", "Schema Contracts", false, e.message);
  }

  // ── Scenario L: Workflow — listing prefill + sell package ─────────────
  console.log("Scenario L: Workflow Integration — listing prefill + sell package");
  try {
    const prefill = await buildListingPrefill(redis, {
      referenceId:   "ref_nike_001",
      token:         tokenA,
      visionData: {
        identity:  { brand: "Nike", model: "Air Max 90", category: "sneakers" },
        condition: "excellent",
        priceEstimate: { mid: 189 },
      },
      trustData:     { verified: true },
      targetPlatform: "ebay",
    });

    const sellPkg = await buildSellPackage(redis, {
      referenceId: "ref_nike_001",
      token:       tokenA,
      visionData: {
        identity:  { brand: "Nike", model: "Air Max 90", category: "sneakers" },
        priceEstimate: { mid: 189 },
      },
      trustData:   { verified: true },
    });

    record("L", "Workflow — listing prefill + sell package",
      prefill.ok && sellPkg.ok && !!prefill.fields?.title && !!sellPkg.platformFees,
      `title="${prefill.fields?.title?.slice(0, 25)}..." bestPlatform=${sellPkg.bestPlatform}`);
  } catch (e) {
    record("L", "Workflow Integration", false, e.message);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed).length;
  const total  = results.length;
  console.log(`\n=== Results: ${passed}/${total} passed ===`);
  if (passed === total) {
    console.log("🎉 All Phase 9 validations passed — Partner Infrastructure is READY.\n");
  } else {
    const failed = results.filter(r => !r.passed);
    console.log("Failed scenarios:");
    failed.forEach(f => console.log(`  ❌ ${f.id}: ${f.name} — ${f.detail}`));
  }

  return { passed, total, results };
}
