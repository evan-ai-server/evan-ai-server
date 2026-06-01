// src/buyOrPassEngine.js
// Buy or Pass Engine — three states, no qualifiers.
//
// BUY  — signals support the purchase.
// PASS — signals do not support the purchase.
// HOLD — not enough signal to lock the call (needs more comps / better photo).
//
// No STRONG / CAUTION / WAIT. The verdict either lands or it doesn't.

const VERDICTS = {
  BUY:  { label: "BUY",  color: "green"   },
  HOLD: { label: "HOLD", color: "neutral" },
  PASS: { label: "PASS", color: "red"     },
};

// ── Signal weights (sum = 1.0) ────────────────────────────────────────────────
// Higher weight = bigger influence on final score
const WEIGHTS = {
  price:        0.28, // price vs market median
  flipScore:    0.22, // flip potential
  demand:       0.15, // demand tier
  risk:         0.15, // risk score (inverted — high risk = low score)
  authenticity: 0.10, // auth risk (inverted)
  condition:    0.10, // condition grade
};

// ── Scoring helpers ───────────────────────────────────────────────────────────

function scorePriceSignal(dealVerdict, savingsPct) {
  // steal → 1.0, good → 0.8, fair → 0.5, high/trap → 0.1
  const base = {
    steal:      1.0,
    good:       0.8,
    fair:       0.5,
    high:       0.1,
    price_trap: 0.05,
  }[dealVerdict] ?? 0.4;

  // Bonus for large discount
  const pct = finiteOrNull(savingsPct) ?? 0;
  const bonus = pct >= 30 ? 0.1 : pct >= 20 ? 0.06 : pct >= 10 ? 0.03 : 0;
  return Math.min(1.0, base + bonus);
}

function scoreDemandSignal(tier) {
  return { hot: 1.0, warm: 0.75, cool: 0.4, cold: 0.2 }[tier] ?? 0.5;
}

function scoreFlipSignal(flipScore) {
  const s = finiteOrNull(flipScore) ?? 0;
  if (s >= 88) return 1.0;
  if (s >= 72) return 0.85;
  if (s >= 55) return 0.65;
  if (s >= 38) return 0.4;
  return 0.2;
}

function scoreRiskSignal(riskTier) {
  // Inverted: safe → 1.0, avoid → 0.0
  return { safe: 1.0, low: 0.9, moderate: 0.55, risky: 0.2, avoid: 0.0 }[riskTier] ?? 0.5;
}

function scoreAuthSignal(authTier) {
  // Inverted: low risk = high score
  return { low: 1.0, moderate: 0.55, high: 0.15, extreme: 0.0 }[authTier] ?? 0.7;
}

function scoreConditionSignal(condition) {
  return {
    new:       1.0,
    like_new:  0.9,
    good:      0.75,
    fair:      0.5,
    poor:      0.2,
  }[condition] ?? 0.6;
}

// ── Core verdict engine ────────────────────────────────────────────────────────

export function computeBuyOrPass(bundle = {}) {
  const deal         = bundle?.dealComparator;
  const demand       = bundle?.demandSignals;
  const flip         = bundle?.flipScore?.flipScore;
  const risk         = bundle?.riskScore;
  const auth         = bundle?.authenticityIntel;
  const condition    = bundle?.conditionForensics;
  const priceProj    = bundle?.priceProjection?.projection;
  const fakeDetect   = bundle?.fakeDetector?.listing;
  const calibration  = bundle?.calibration  || null;   // Phase 4A.1

  // ── Evidence gate ────────────────────────────────────────────────────────
  // Without comps, every downstream signal (deal, flip, demand, risk) is
  // synthesised from defaults and produces a confidently-scored verdict on
  // no data. Short-circuit to an honest "not enough evidence" result and
  // skip dimension scoring entirely.
  const listingCount = bundle?.consensus?.listingCount ?? 0;
  const itemsCount   = Array.isArray(bundle?.items) ? bundle.items.length : 0;
  if (listingCount === 0 && itemsCount === 0) {
    return {
      verdict:           "HOLD",
      verdictKey:        "HOLD",
      color:             "neutral",
      confidence:        15,
      oneLineReason:     "Not enough evidence yet — try a clearer photo or wait for more comps.",
      supportingSignals: [],
      riskFlags:         [],
      hardDisqualifiers: [],
      dimensions: {
        price:         { score: null, weight: WEIGHTS.price        },
        flipPotential: { score: null, weight: WEIGHTS.flipScore    },
        demand:        { score: null, weight: WEIGHTS.demand       },
        risk:          { score: null, weight: WEIGHTS.risk         },
        authenticity:  { score: null, weight: WEIGHTS.authenticity },
        condition:     { score: null, weight: WEIGHTS.condition    },
      },
      topSignal:         "Not enough evidence yet",
      noEvidence:        true,
    };
  }

  // ── Dimension scores ─────────────────────────────────────────────────────
  // Missing inputs default to neutral 0.5, never to optimistic max — absence
  // of data must not look like "we checked and it's clean."
  const priceScore    = scorePriceSignal(deal?.verdict,   deal?.savingsPct ?? deal?.discountPct);
  const demandScore   = scoreDemandSignal(demand?.tier);
  const flipScoreVal  = scoreFlipSignal(flip?.score);
  const riskScoreVal  = (risk?.tier && risk.tier !== "unknown")
    ? scoreRiskSignal(risk.tier)
    : 0.5;
  const authScoreVal  = auth?.riskTier
    ? scoreAuthSignal(auth.riskTier)
    : 0.5;
  const condScoreVal  = bundle?.visionIdentity?.condition
    ? scoreConditionSignal(bundle.visionIdentity.condition)
    : 0.5;

  // ── Weighted composite ──────────────────────────────────────────────────
  const raw =
    priceScore    * WEIGHTS.price     +
    flipScoreVal  * WEIGHTS.flipScore +
    demandScore   * WEIGHTS.demand    +
    riskScoreVal  * WEIGHTS.risk      +
    authScoreVal  * WEIGHTS.authenticity +
    condScoreVal  * WEIGHTS.condition;

  // ── Hard disqualifiers (force PASS regardless of score) ─────────────────
  const hardPass = [];
  if ((fakeDetect?.riskScore ?? 0) >= 65)                           hardPass.push("extreme_fraud_risk");
  if (["extreme"].includes(auth?.riskTier))                         hardPass.push("extreme_auth_risk");
  if (risk?.tier === "avoid")                                       hardPass.push("risk_avoid");
  if (deal?.verdict === "price_trap")                               hardPass.push("price_trap");

  // ── Price drop signal pushes ambiguous reads to HOLD ────────────────────
  const forceHold = priceProj?.verdict === "WAIT" && raw >= 0.4 && raw < 0.72;

  // ── Normalised confidence (0-100) ───────────────────────────────────────
  const confidence = Math.round(Math.min(100, Math.max(0, raw * 100)));

  // ── Three-state assignment — no qualifiers ──────────────────────────────
  // PASS at <40 or any hard disqualifier; HOLD in the ambiguous middle;
  // BUY when confidence clears 65. The bar to land BUY is deliberately high
  // so the call carries weight; everything in between is honestly HOLD.
  let verdictKey;
  if (hardPass.length)        verdictKey = "PASS";
  else if (forceHold)         verdictKey = "HOLD";
  else if (confidence >= 65)  verdictKey = "BUY";
  else if (confidence >= 40)  verdictKey = "HOLD";
  else                        verdictKey = "PASS";

  // ── SerpAPI market-evidence cap ─────────────────────────────────────────
  // A BUY that rests on weak market evidence (few/all-indirect listings,
  // wide price spread, low query relevance) is downgraded to HOLD. The
  // verdict can still PASS — we never *upgrade* on this signal, only cap.
  const marketEvidence = bundle?.marketEvidence;
  const capReasons = [];
  if (verdictKey === "BUY" && marketEvidence?.confidence === "low") {
    verdictKey = "HOLD";
    capReasons.push(`weak market evidence (${marketEvidence.reason || "low_confidence"})`);
  } else if (verdictKey === "BUY" && marketEvidence?.confidence === "medium" && confidence < 75) {
    verdictKey = "HOLD";
    capReasons.push(`limited market evidence (${marketEvidence.reason || "few_direct_urls"})`);
  }

  // Single-source thin market: HOLD with low evidence → PASS.
  // When all results come from one marketplace and evidence is weak, we have
  // no cross-market price signal — HOLD is overconfident, PASS is honest.
  if (
    verdictKey === "HOLD" &&
    marketEvidence?.confidence === "low" &&
    marketEvidence?.reason?.includes("single_source")
  ) {
    verdictKey = "PASS";
    capReasons.push(`single-source thin market (${marketEvidence.reason})`);
  }

  // ── Phase 4A.1: Evidence-calibration verdict-strength cap ──────────────────
  // Downgrades BUY → HOLD when the calibration layer determined that evidence
  // is too weak to support a BUY call (no verified listings + other risk factors).
  // Never fires if the existing SerpAPI gate already handled the downgrade.
  if (calibration) {
    const { verdictStrengthCap, evidenceTier, capReasons: calibCapReasons } = calibration;

    if (verdictKey === "BUY" && verdictStrengthCap === "evidence_limited" && evidenceTier !== "verified_strong") {
      const topReason = calibCapReasons?.[0] || "weak_evidence";
      capReasons.push(`evidence_limited: ${topReason}`);
      try {
        console.log("VERDICT_STRENGTH_CAPPED", {
          scanId:                   bundle.scanId || null,
          query:                    bundle.query  || null,
          verdict:                  verdictKey,
          rawConfidence:            confidence,
          finalConfidence:          confidence,
          rawStrength:              "uncapped",
          cappedStrength:           "evidence_limited",
          capReasons:               calibCapReasons || [],
          marketEvidenceConfidence: marketEvidence?.confidence ?? null,
          evidenceTier,
        });
      } catch {}
      verdictKey = "HOLD";
    }

    // Phase 4A.1: PASS escalation — allow PASS on pricing_signal_only when
    // the scanned price is clearly above the clean market signal range.
    // This is evidence_limited-grade: honest PASS, not a strong PASS.
    if (
      verdictKey === "HOLD" &&
      evidenceTier === "pricing_signal_only" &&
      calibCapReasons?.includes("pricing_signal_against_high_scan_price") &&
      (calibration.evidence?.cleanCompCount ?? 0) >= 4
    ) {
      verdictKey = "PASS";
      capReasons.push("pass_on_pricing_signal_above_market");
    }
  }

  const verdict = VERDICTS[verdictKey];

  // ── Supporting signal text ───────────────────────────────────────────────
  const supportingSignals = [];
  const riskFlags         = [];

  // Price signals
  const savingsPct = finiteOrNull(deal?.savingsPct ?? deal?.discountPct);
  const median     = finiteOrNull(bundle?.consensus?.median ?? bundle?.consensus?.medianPrice);
  const scanPrice  = finiteOrNull(bundle?.scannedPrice ?? bundle?.bestPrice);

  if (deal?.verdict === "steal" && savingsPct) {
    supportingSignals.push(`${savingsPct.toFixed(0)}% under market`);
  } else if (deal?.verdict === "good" && median && scanPrice) {
    supportingSignals.push(`$${(median - scanPrice).toFixed(0)} under market`);
  } else if (deal?.verdict === "fair") {
    riskFlags.push("Priced at market — no margin built in");
  } else if (deal?.verdict === "high" || deal?.verdict === "price_trap") {
    riskFlags.push("Above market on recent comps");
  }

  if (demand?.tier === "hot")        supportingSignals.push("Resells fast at this price");
  else if (demand?.tier === "warm")  supportingSignals.push("Steady resale demand");
  else if (demand?.tier === "cold")  riskFlags.push("Slow resale at this price");

  if (flip?.score >= 72)             supportingSignals.push(`Strong margin on recent sales`);
  else if (flip?.score >= 55)        supportingSignals.push(`Margin holds on recent sales`);
  else if (flip?.score !== undefined && flip.score < 38) riskFlags.push(`Thin margin on recent sales`);

  if (risk?.tier === "safe" || (finiteOrNull(risk?.score) ?? 1) < 0.2) {
    supportingSignals.push("Clean recent sale history");
  } else if (risk?.tier === "risky" || risk?.tier === "avoid") {
    riskFlags.push(`Listing pattern looks risky`);
  }

  if (["high", "extreme"].includes(auth?.riskTier)) {
    riskFlags.push(`Authenticate before buying`);
  }

  if (condition?.hasDetectedDamage) {
    riskFlags.push(`Visible wear: ${condition.detections?.[0]?.label ?? "damage in photo"}`);
  }

  if (priceProj?.verdict === "WAIT") {
    riskFlags.push("Recent comps trending down — may sell cheaper soon");
  }

  if (hardPass.length) {
    riskFlags.unshift(...hardPass.map(f => f.replace(/_/g, " ")));
  }

  // Surface the SerpAPI evidence cap reason so the user sees *why* we held
  // back, rather than a silent BUY → HOLD swap.
  if (capReasons.length) {
    riskFlags.unshift(...capReasons);
  }

  // ── One-line reason ──────────────────────────────────────────────────────
  const topPositive = supportingSignals[0] || null;
  const topNegative = riskFlags[0] || null;

  const oneLineReason = buildOneLineReason(verdictKey, confidence, topPositive, topNegative, scanPrice, median, deal?.verdict);

  // ── Dimension breakdown ──────────────────────────────────────────────────
  const dimensions = {
    price:        { score: Math.round(priceScore    * 100), weight: WEIGHTS.price        },
    flipPotential:{ score: Math.round(flipScoreVal  * 100), weight: WEIGHTS.flipScore    },
    demand:       { score: Math.round(demandScore   * 100), weight: WEIGHTS.demand       },
    risk:         { score: Math.round(riskScoreVal  * 100), weight: WEIGHTS.risk         },
    authenticity: { score: Math.round(authScoreVal  * 100), weight: WEIGHTS.authenticity },
    condition:    { score: Math.round(condScoreVal  * 100), weight: WEIGHTS.condition    },
  };

  return {
    verdict:           verdict.label,
    verdictKey,
    color:             verdict.color,
    confidence,
    oneLineReason,
    supportingSignals: supportingSignals.slice(0, 5),
    riskFlags:         riskFlags.slice(0, 5),
    hardDisqualifiers: hardPass,
    dimensions,
    topSignal:         oneLineReason,
    marketEvidence:    marketEvidence || null,
    // Phase 4A.1 — calibration mirrors (also set from index.js as safety net)
    verdictStrength:   calibration?.verdictStrengthCap ?? null,
    evidenceTier:      calibration?.evidenceTier       ?? null,
    capReasons:        capReasons.length ? capReasons : (calibration?.capReasons ?? []),
  };
}

// One-line summary — plain language, no jargon.
// BUY  leads with the price truth, then the strongest supporting signal.
// PASS leads with the strongest risk flag.
// HOLD leads with what's missing — the user should feel we're being honest,
//      not hedging.
function buildOneLineReason(verdictKey, confidence, topPositive, topNegative, scanPrice, median, dealVerdict) {
  const pricePart = scanPrice && median
    ? ` — $${(Math.abs(median - scanPrice)).toFixed(0)} ${scanPrice < median ? "under" : "over"} market`
    : "";

  if (verdictKey === "BUY") {
    return `BUY${pricePart}${topPositive ? `. ${topPositive}` : ""}`;
  }
  if (verdictKey === "PASS") {
    return `PASS${topNegative ? ` — ${topNegative.toLowerCase()}` : `${pricePart}`}`;
  }
  // HOLD — admit what's missing rather than fake certainty
  return `HOLD — need more comps to lock the call`;
}

// ── Master payload builder ────────────────────────────────────────────────────

export function buildBuyOrPassPayload(bundle = {}) {
  try {
    const result = computeBuyOrPass(bundle);
    return {
      buyOrPass: result,
      topSignal: result?.topSignal || null,
    };
  } catch {
    return { buyOrPass: null, topSignal: null };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
