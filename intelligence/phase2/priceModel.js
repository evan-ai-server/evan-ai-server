export function priceDistribution(items) {
  const prices = items
    .map(i => i.totalPrice || i.price)
    .filter(p => typeof p === "number");

  if (!prices.length) return null;

  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return { avg, min, max };
}
