function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n) || 0));
}

export function counterfeitRiskScore(item, context = {}) {
  const title = String(item?.title || "").toLowerCase();
  const source = String(item?.source || "").toLowerCase();
  const total =
    Number.isFinite(item?.totalPrice) ? Number(item.totalPrice) :
    Number.isFinite(item?.price) ? Number(item.price) :
    null;

  const avg =
    Number.isFinite(context?.historicalAvg) ? Number(context.historicalAvg) :
    Number.isFinite(context?.marketAvg) ? Number(context.marketAvg) :
    null;

  let risk = 0.18;

  if (!item?.linkVerified) risk += 0.16;
  if (!item?.source) risk += 0.12;

  if (
    title.includes("replica") ||
    title.includes("inspired") ||
    title.includes("dupe") ||
    title.includes("style") ||
    title.includes("lookalike") ||
    title.includes("knockoff")
  ) {
    risk += 0.42;
  }

  if (
    title.includes("authentic") ||
    title.includes("genuine") ||
    title.includes("original")
  ) {
    risk -= 0.06;
  }

  if (source.includes("ebay")) risk += 0.04;
  if (source.includes("etsy")) risk += 0.03;

  if (Number.isFinite(avg) && Number.isFinite(total) && avg > 0) {
    const ratio = total / avg;
    if (ratio < 0.35) risk += 0.26;
    else if (ratio < 0.5) risk += 0.18;
    else if (ratio < 0.7) risk += 0.08;
  }

  if (Number(item?.trustModelScore || 0) >= 0.82) risk -= 0.12;
  if (Number(item?.sellerScore || 0) >= 0.82) risk -= 0.10;
  if (Number(item?.rating || 0) >= 4.6 && Number(item?.reviews || 0) >= 25) risk -= 0.08;

  return clamp01(risk);
}

export function authSummary(items = []) {
  if (!Array.isArray(items) || !items.length) {
    return {
      avgRisk: 0,
      riskLabel: "Unknown",
      flagged: 0,
    };
  }

  const risks = items
    .map((x) => Number(x?.authRisk ?? 0))
    .filter((n) => Number.isFinite(n));

  if (!risks.length) {
    return {
      avgRisk: 0,
      riskLabel: "Unknown",
      flagged: 0,
    };
  }

  const avgRisk = risks.reduce((a, b) => a + b, 0) / risks.length;
  const flagged = risks.filter((n) => n >= 0.6).length;

  return {
    avgRisk,
    flagged,
    riskLabel:
      avgRisk >= 0.7 ? "High risk" :
      avgRisk >= 0.45 ? "Mixed risk" :
      "Lower risk",
  };
}
