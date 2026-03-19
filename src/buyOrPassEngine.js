// src/buyOrPassEngine.js
// Feature 62 — Buy or Pass Engine: THE FINAL VERDICT.
// Synthesizes every Evan AI signal into one unambiguous recommendation:
// BUY / PASS / WAIT — with a confidence score, exact dollar reasoning,
// top supporting signals, and top risk flags. This is Evan's last word.
// "BUY — 87% confidence. $43 below market, hot demand, low risk."

// ── Verdict definitions ───────────────────────────────────────────────────────
const VERDICTS = {
  BUY:         { label: "BUY",          emoji: "✅", color: "green"  },
  STRONG_BUY:  { label: "STRONG BUY",   emoji: "🔥", color: "green"  },
  WAIT:        { label: "WAIT",          emoji: "⏳", color: "yellow" },
  PASS:        { label: "PASS",          emoji: "❌", color: "red"    },
  CAUTION:     { label: "CAUTION",       emoji: "⚠️", color: "orange" },
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

  // ── Dimension scores ─────────────────────────────────────────────────────
  const priceScore    = scorePriceSignal(deal?.verdict,   deal?.savingsPct ?? deal?.discountPct);
  const demandScore   = scoreDemandSignal(demand?.tier);
  const flipScoreVal  = scoreFlipSignal(flip?.score);
  const riskScoreVal  = scoreRiskSignal(risk?.tier ?? (risk?.score < 0.2 ? "safe" : risk?.score < 0.5 ? "moderate" : "risky"));
  const authScoreVal  = scoreAuthSignal(auth?.riskTier ?? "low");
  const condScoreVal  = scoreConditionSignal(bundle?.visionIdentity?.condition ?? "good");

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

  // ── Price drop signal (push toward WAIT) ────────────────────────────────
  const forceWait = priceProj?.verdict === "WAIT" && raw >= 0.4 && raw < 0.72;

  // ── Normalised confidence (0-100) ───────────────────────────────────────
  const confidence = Math.round(Math.min(100, Math.max(0, raw * 100)));

  // ── Verdict assignment ───────────────────────────────────────────────────
  let verdictKey;
  if (hardPass.length)        verdictKey = "PASS";
  else if (forceWait)         verdictKey = "WAIT";
  else if (confidence >= 82)  verdictKey = "STRONG_BUY";
  else if (confidence >= 65)  verdictKey = "BUY";
  else if (confidence >= 48)  verdictKey = "CAUTION";
  else if (confidence >= 35)  verdictKey = "WAIT";
  else                        verdictKey = "PASS";

  const verdict = VERDICTS[verdictKey];

  // ── Supporting signal text ───────────────────────────────────────────────
  const supportingSignals = [];
  const riskFlags         = [];

  // Price signals
  const savingsPct = finiteOrNull(deal?.savingsPct ?? deal?.discountPct);
  const median     = finiteOrNull(bundle?.consensus?.median ?? bundle?.consensus?.medianPrice);
  const scanPrice  = finiteOrNull(bundle?.scannedPrice ?? bundle?.bestPrice);

  if (deal?.verdict === "steal" && savingsPct) {
    supportingSignals.push(`${savingsPct.toFixed(0)}% below market median — steal pricing`);
  } else if (deal?.verdict === "good" && median && scanPrice) {
    supportingSignals.push(`$${(median - scanPrice).toFixed(0)} below market median`);
  } else if (deal?.verdict === "fair") {
    riskFlags.push("Priced at market — no built-in margin");
  } else if (deal?.verdict === "high" || deal?.verdict === "price_trap") {
    riskFlags.push("Overpriced vs market — avoid unless personal use");
  }

  if (demand?.tier === "hot")        supportingSignals.push("HOT demand — fast resale");
  else if (demand?.tier === "warm")  supportingSignals.push("Healthy demand");
  else if (demand?.tier === "cold")  riskFlags.push("Cold demand — slow market");

  if (flip?.score >= 72)             supportingSignals.push(`Flip Score ${flip.score}/100 — strong flip potential`);
  else if (flip?.score >= 55)        supportingSignals.push(`Flip Score ${flip.score}/100 — solid opportunity`);
  else if (flip?.score !== undefined && flip.score < 38) riskFlags.push(`Flip Score ${flip.score}/100 — weak flip`);

  if (risk?.tier === "safe" || (finiteOrNull(risk?.score) ?? 1) < 0.2) {
    supportingSignals.push("Low risk profile");
  } else if (risk?.tier === "risky" || risk?.tier === "avoid") {
    riskFlags.push(`Risk tier: ${risk.tier}`);
  }

  if (["high", "extreme"].includes(auth?.riskTier)) {
    riskFlags.push(`Auth risk: ${auth.riskTier} — authenticate before buying`);
  }

  if (condition?.hasDetectedDamage) {
    riskFlags.push(`Condition issue: ${condition.detections?.[0]?.label ?? "damage detected"}`);
  }

  if (priceProj?.verdict === "WAIT") {
    riskFlags.push("Price expected to drop in 90 days — consider waiting");
  }

  if (hardPass.length) {
    riskFlags.unshift(...hardPass.map(f => `HARD PASS: ${f.replace(/_/g, " ")}`));
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
    emoji:             verdict.emoji,
    color:             verdict.color,
    confidence,
    oneLineReason,
    supportingSignals: supportingSignals.slice(0, 5),
    riskFlags:         riskFlags.slice(0, 5),
    hardDisqualifiers: hardPass,
    dimensions,
    topSignal:         oneLineReason,
  };
}

function buildOneLineReason(verdictKey, confidence, topPositive, topNegative, scanPrice, median, dealVerdict) {
  const pricePart = scanPrice && median
    ? ` ($${(Math.abs(median - scanPrice)).toFixed(0)} ${scanPrice < median ? "below" : "above"} market)`
    : "";

  if (verdictKey === "STRONG_BUY")  return `STRONG BUY — ${confidence}% confidence${pricePart}${topPositive ? `. ${topPositive}` : ""}`;
  if (verdictKey === "BUY")         return `BUY — ${confidence}% confidence${pricePart}${topPositive ? `. ${topPositive}` : ""}`;
  if (verdictKey === "CAUTION")     return `CAUTION — ${confidence}% confidence${topNegative ? `. ${topNegative}` : ""}${topPositive ? ` but ${topPositive.toLowerCase()}` : ""}`;
  if (verdictKey === "WAIT")        return `WAIT — ${confidence}% confidence. ${topNegative || "Better opportunity may come"}`;
  if (verdictKey === "PASS")        return `PASS — ${confidence}% confidence. ${topNegative || "Signals do not support this purchase"}`;
  return `REVIEWING — ${confidence}% confidence`;
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
