export function liquidityScore(active=0,sold=0) {
  const total = active + sold;
  if (!total) return 0;

  return sold/total;
}
