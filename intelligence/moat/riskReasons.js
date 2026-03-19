export function riskReasons(item) {
  const reasons=[];

  if ((item.reviews||0) < 5)
    reasons.push("low seller history");

  if (item.price < 10)
    reasons.push("unusually low price");

  return reasons;
}
