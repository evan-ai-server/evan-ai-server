export function demandRadar(items=[]) {
  const avg =
    items.reduce((a,b)=>a+(b.price||0),0)/Math.max(items.length,1);

  if (avg > 120) return "hot";
  if (avg > 60) return "moderate";
  return "slow";
}
