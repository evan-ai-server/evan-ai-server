export function styleDemand(items=[]) {
  if (!items.length) return 0.5;

  const avgPrice =
    items.reduce((a,b)=>a+(b.price||0),0)/items.length;

  return Math.min(1, avgPrice / 200);
}
