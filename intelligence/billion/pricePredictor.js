export function predictPrice(history = [], currentPrice) {

  if (!history.length) {
    return {
      expected: currentPrice,
      trend: "flat",
      confidence: 0.3
    };
  }

  const prices = history.map(x=>x.price);

  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  const change = avg - currentPrice;

  let trend = "flat";

  if (change > 0) trend = "rising";
  if (change < 0) trend = "falling";

  return {
    expected: avg,
    trend,
    confidence: Math.min(history.length/50,1)
  };
}
