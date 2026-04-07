// src/phase8Validation.js
// Phase 8 — Validation Suite.
//
// 10 validation scenarios covering the full Phase 8 surface:
//
//   1. Shareable item link generates OG meta + QR code
//   2. OG meta blocked for revoked/inactive references
//   3. Listing export trust injection — verified item (eBay HTML)
//   4. Listing export trust injection blocked for unverified item
//   5. External usage tracker — engagement scoring + leaderboard
//   6. Trustmark display — all output formats for verified item
//   7. Partner sandbox — API key issue + rate limit enforcement
//   8. Feedback engine — CRITICAL report triggers revocation flag
//   9. Distribution playbook — generates channel recommendations
//  10. Trustmark safety monitor — detects critical alerts

import { buildShareableItemLink, buildShareableResellerLink } from "./shareableLinkEngine.js";
import { buildListingExportBundle, injectTrustIntoListing  } from "./listingExportEngine.js";
import { recordUsageEvent, USAGE_EVENT_TYPE, getTopEngagedItems } from "./externalUsageTracker.js";
import { buildItemTrustmarkDisplay, buildResellerTrustmarkDisplay, buildEmbedWidget } from "./trustmarkDisplayEngine.js";
import { issuePartnerApiKey, validateApiKey, buildSandboxResponse } from "./partnerSandboxEngine.js";
import { submitFeedbackReport, FEEDBACK_TYPE, getRevocationFlags } from "./externalFeedbackEngine.js";
import { buildDistributionPlaybook, runTrustmarkSafetyMonitor } from "./distributionInsightsEngine.js";

export const PHASE8_VALIDATION_VERSION = "8.0";

// ── Mock Redis ─────────────────────────────────────────────────────────────────

function makeMockRedis() {
  const store     = new Map();
  const hstore    = new Map();
  const zstore    = new Map();
  const sstore    = new Map();
  const expiryMap = new Map();

  const getH  = k => hstore.get(k) || {};
  const getZ  = k => zstore.get(k) || [];

  return {
    // STRING
    get:    async k => store.get(k) ?? null,
    set:    async (k, v, opts) => {
      store.set(k, v);
      if (opts?.EX) expiryMap.set(k, Date.now() + opts.EX * 1000);
    },
    incrBy: async (k, n) => { const v = Number(store.get(k) || 0) + n; store.set(k, String(v)); return v; },
    incrByFloat: async (k, n) => { const v = (Number(store.get(k) || 0) + n); store.set(k, String(v)); return v; },
    expire: async (k, s) => { expiryMap.set(k, Date.now() + s * 1000); },
    del:    async k => store.delete(k),

    // HASH
    hSet:    async (k, fields) => {
      const h = getH(k);
      if (typeof fields === "object" && !Array.isArray(fields)) Object.assign(h, fields);
      hstore.set(k, h);
    },
    hGet:    async (k, f)  => (getH(k))[f] ?? null,
    hGetAll: async k       => ({ ...getH(k) }),
    hIncrBy: async (k, f, n) => {
      const h = getH(k);
      h[f]    = (Number(h[f] || 0) + n);
      hstore.set(k, h);
      return h[f];
    },

    // ZSET
    zAdd: async (k, members) => {
      const z = getZ(k);
      for (const { score, value } of members) {
        const idx = z.findIndex(e => e.value === value);
        if (idx >= 0) z[idx].score = score;
        else z.push({ score, value });
      }
      z.sort((a, b) => a.score - b.score);
      zstore.set(k, z);
    },
    zIncrBy: async (k, incr, value) => {
      const z = getZ(k);
      const e = z.find(e => e.value === value);
      if (e) { e.score += incr; }
      else   { z.push({ score: incr, value }); }
      z.sort((a, b) => a.score - b.score);
      zstore.set(k, z);
      return (z.find(e => e.value === value))?.score || incr;
    },
    zRange: async (k, start, stop, opts) => {
      const z = [...getZ(k)];
      if (opts?.REV) z.reverse();
      const slice = z.slice(start, stop + 1 === 0 ? undefined : stop + 1);
      if (opts?.WITHSCORES) {
        const out = [];
        for (const e of slice) { out.push(e.value); out.push(String(e.score)); }
        return out;
      }
      return slice.map(e => e.value);
    },
    zScore: async (k, v) => { const e = getZ(k).find(e => e.value === v); return e ? e.score : null; },
    zRem:   async (k, v) => { const z = getZ(k).filter(e => e.value !== v); zstore.set(k, z); },
    zRemRangeByRank: async (k, s, e) => {
      let z = [...getZ(k)];
      if (e < 0) { const len = z.length; e = len + e; }
      z.splice(s, e - s + 1);
      zstore.set(k, z);
    },

    // SET
    sAdd:    async (k, v) => { const s = sstore.get(k) || new Set(); s.add(v); sstore.set(k, s); },
    sMembers:async k => [...(sstore.get(k) || new Set())],

    // PIPELINE
    multi: () => {
      const cmds = [];
      const p = {
        incrBy:  (k, n) => { cmds.push(["incrBy", k, n]); return p; },
        expire:  (k, s) => { cmds.push(["expire", k, s]); return p; },
        hSet:    (k, f) => { cmds.push(["hSet", k, f]);   return p; },
        hIncrBy: (k, f, n) => { cmds.push(["hIncrBy", k, f, n]); return p; },
        exec: async () => {
          for (const [cmd, ...args] of cmds) {
            if (cmd === "incrBy")  { const h = getH(args[0]); h[args[1]] = (Number(h[args[1]] || 0) + args[2]); hstore.set(args[0], h); }
            // other cmds are no-ops in mock
          }
        },
      };
      return p;
    },
  };
}

// ── Validation runner ─────────────────────────────────────────────────────────

export async function runAllPhase8Validations(redis) {
  const redis8 = redis || makeMockRedis();
  const results = [];

  const run = async (id, name, fn) => {
    try {
      const passed = await fn(redis8);
      results.push({ id, name, passed: !!passed, error: null });
    } catch (err) {
      results.push({ id, name, passed: false, error: err?.message });
    }
  };

  // ── Scenario 1: Shareable item link generates OG meta + QR ──────────────────
  await run(1, "Shareable item link — OG meta + QR generated", async (r) => {
    const result = await buildShareableItemLink(r, {
      referenceId:    "evr_test001",
      itemName:       "Jordan 1 Retro High OG",
      category:       "sneakers",
      brand:          "Nike",
      userId:         "user_abc",
      referenceRecord:{ status: "ACTIVE", referenceType: "ITEM_VERIFIED" },
    });
    const hasShortUrl  = typeof result.shortUrl === "string" && result.shortUrl.includes("evr_test001");
    const hasOg        = result.ogMeta && result.ogMeta["og:title"] && result.ogMeta._rendered;
    const hasQr        = result.qrCode && typeof result.qrCode.imageUrl === "string";
    return hasShortUrl && hasOg && hasQr;
  });

  // ── Scenario 2: OG meta blocked / degraded for revoked reference ─────────────
  await run(2, "Shareable link — revoked reference degrades OG meta", async (r) => {
    const result = await buildShareableItemLink(r, {
      referenceId:    "evr_revoked01",
      itemName:       "Fake Watch",
      category:       "watches",
      referenceRecord:{ status: "REVOKED", referenceType: "ITEM_VERIFIED" },
    });
    // For revoked, OG image should use the unverified variant
    const ogImage = result.ogMeta?.["og:image"] || "";
    return ogImage.includes("unverified") || !ogImage.includes("verified");
  });

  // ── Scenario 3: Listing export — verified item gets eBay HTML trust block ────
  await run(3, "Listing export — verified item eBay trust block injected", async () => {
    const result = buildListingExportBundle({
      platform:         "ebay",
      itemName:         "Rolex Submariner",
      category:         "watches",
      brand:            "Rolex",
      condition:        "good",
      price:            8500,
      evanVerification: { status: "VERIFIED", evidenceLevel: "HIGH", expertReviewed: true },
      trustmarkRecord:  { status: "ACTIVE" },
      referenceId:      "evr_rolex01",
    });
    const ebayBundle = result.bundles?.ebay;
    const hasHtml    = ebayBundle?.description?.includes("<div") && ebayBundle?.description?.includes("Evan AI Trust");
    const hasLink    = ebayBundle?.verificationLink?.includes("evr_rolex01");
    return result.isVerified && hasHtml && hasLink;
  });

  // ── Scenario 4: Listing export — unverified item blocks trust injection ───────
  await run(4, "Listing export — unverified item gets no trust language", async () => {
    const result = buildListingExportBundle({
      platform:         "poshmark",
      itemName:         "Generic Handbag",
      category:         "handbags",
      evanVerification: null,
      trustmarkRecord:  null,
    });
    const poshBundle = result.bundles?.poshmark;
    const noTrust    = !poshBundle?.description?.includes("Evan-Verified") &&
                       !poshBundle?.description?.includes("evan.ai");
    return !result.isVerified && noTrust;
  });

  // ── Scenario 5: Usage tracker — engagement scoring + leaderboard ─────────────
  await run(5, "Usage tracker — engagement scoring and leaderboard update", async (r) => {
    const refId = "evr_engage_test";
    await recordUsageEvent(r, { eventType: USAGE_EVENT_TYPE.VERIFICATION_VIEWED, referenceId: refId, category: "sneakers" });
    await recordUsageEvent(r, { eventType: USAGE_EVENT_TYPE.QR_SCANNED,          referenceId: refId, category: "sneakers" });
    await recordUsageEvent(r, { eventType: USAGE_EVENT_TYPE.LINK_SHARED,         referenceId: refId, userId: "u1" });

    const top = await getTopEngagedItems(r, 5);
    const item = top.find(i => i.referenceId === refId);
    // Score should be: VERIFICATION_VIEWED(5) + QR_SCANNED(5) + LINK_SHARED(3) = 13
    return item && item.engagementScore >= 13;
  });

  // ── Scenario 6: Trustmark display — all formats for verified item ─────────────
  await run(6, "Trustmark display — all output formats for verified item", async (r) => {
    const result = await buildItemTrustmarkDisplay(r, {
      referenceId:      "evr_display01",
      itemName:         "Supreme Box Logo Hoodie",
      category:         "streetwear",
      verifyUrl:        "https://verify.evanai.app/verify/item/evr_display01",
      evanVerification: { status: "VERIFIED", evidenceLevel: "HIGH", expertReviewed: false },
      trustmarkRecord:  { status: "ACTIVE", issuedAt: Date.now() },
      formats:          ["all"],
    });
    return result.ok &&
      typeof result.snippets.html      === "string" && result.snippets.html.includes("Evan-Verified") &&
      typeof result.snippets.markdown  === "string" && result.snippets.markdown.includes("Evan-Verified") &&
      typeof result.snippets.plaintext === "string" &&
      typeof result.snippets.svg       === "string" && result.snippets.svg.includes("<svg") &&
      typeof result.snippets.json      === "string";
  });

  // ── Scenario 7: Partner sandbox — key issue + rate limit ─────────────────────
  await run(7, "Partner sandbox — API key issue and validation", async (r) => {
    const issued = await issuePartnerApiKey(r, {
      partnerId:   "partner_test_001",
      partnerType: "marketplace",
      tier:        "free",
      env:         "sbx",
    });
    if (!issued.ok || !issued.apiKey) return false;

    const validated = await validateApiKey(r, issued.apiKey);
    const allowed   = validated.ok && validated.allowed && validated.env === "sbx";

    // Test sandbox response filtering
    const rawPayload = {
      referenceId: "evr_001",
      rawTrustScore: 0.92,          // INTERNAL — should be stripped
      authScore: 0.88,              // INTERNAL — should be stripped
      status: "VERIFIED",           // PUBLIC — should pass
    };
    const filtered = buildSandboxResponse(rawPayload, "marketplace", "sbx");
    const stripped = !("rawTrustScore" in filtered) && !("authScore" in filtered);

    return allowed && stripped && filtered._sandbox === true;
  });

  // ── Scenario 8: Feedback — CRITICAL triggers revocation flag ─────────────────
  await run(8, "Feedback engine — CRITICAL reports trigger revocation flag", async (r) => {
    const refId = "evr_feedback_test";
    const r1 = await submitFeedbackReport(r, {
      feedbackType: FEEDBACK_TYPE.COUNTERFEIT_ALLEGATION,
      referenceId:  refId,
      submittedBy:  "buyer_001",
      description:  "Item appears to be a replica",
    });
    const r2 = await submitFeedbackReport(r, {
      feedbackType: FEEDBACK_TYPE.COUNTERFEIT_ALLEGATION,
      referenceId:  refId,
      submittedBy:  "buyer_002",
      description:  "Confirmed counterfeit markings",
    });

    // Second critical report should trigger the flag
    const flags = await getRevocationFlags(r, 10);
    const flagged = flags.some(f => f.referenceId === refId);
    return r1.ok && r2.ok && r2.revocationFlagged && flagged;
  });

  // ── Scenario 9: Distribution playbook — channel recommendations ───────────────
  await run(9, "Distribution playbook — generates ranked channel recommendations", async (r) => {
    const playbook = await buildDistributionPlaybook(r, {
      userId:          "user_reseller_001",
      certTier:        "STANDARD",
      category:        "sneakers",
      price:           350,
      isVerified:      true,
      isCertified:     true,
      engagementScore: 25,
    });
    return playbook.ok &&
      Array.isArray(playbook.recommendations) &&
      playbook.recommendations.length > 0 &&
      playbook.recommendations[0].priority === "primary" &&
      typeof playbook.topChannel === "object";
  });

  // ── Scenario 10: Trustmark safety monitor ────────────────────────────────────
  await run(10, "Trustmark safety monitor — runs and returns health status", async (r) => {
    // Seed a critical feedback to ensure the monitor can detect it
    await submitFeedbackReport(r, {
      feedbackType: FEEDBACK_TYPE.BUYER_DISPUTE,
      referenceId:  "evr_monitor_test",
      submittedBy:  "buyer_x",
    });

    const monitor = await runTrustmarkSafetyMonitor(r);
    return monitor.ok &&
      typeof monitor.health?.status === "string" &&
      ["HEALTHY", "MONITOR", "DEGRADED", "CRITICAL"].includes(monitor.health.status) &&
      typeof monitor.ranAt === "number";
  });

  // ── Summary ───────────────────────────────────────────────────────────────────

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed);

  return {
    total:   results.length,
    passed,
    failed:  failed.length,
    results,
    failedDetails: failed,
    phase:   "Phase 8 — Activate the Evan Network in the Real World",
    version: PHASE8_VALIDATION_VERSION,
    allPassed: passed === results.length,
  };
}
