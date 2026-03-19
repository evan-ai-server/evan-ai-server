export function computeSoldCompStats(items = []) {
  const sold = items.filter(i => i?.sold === true || i?.source === "ebay_sold");

  if (!sold.length) return null;

  const prices = sold
    .map(i => Number(i.price ?? i.totalPrice))
    .filter(n => Number.isFinite(n));

  if (!prices.length) return null;

  prices.sort((a,b)=>a-b);

  const median = prices[Math.floor(prices.length/2)];
  const low = prices[Math.floor(prices.length*0.25)];
  const high = prices[Math.floor(prices.length*0.75)];

  return { median, low, high, count: prices.length };
}
