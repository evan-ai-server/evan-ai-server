export function sellRecommendation(item, market) {

  if (!item?.totalPrice || !market?.avg) return null;

  const margin = market.avg - item.totalPrice;

  return {
    expectedSell: market.avg,
    profit: margin,
    sellScore: Math.min(margin/market.avg,1)
  };
}
