export function overlayInsight(item, market) {

  if (!item || !market) return null;

  const margin = market.avg - item.totalPrice;

  return {
    flipOpportunity: margin > market.avg * 0.35,
    estimatedProfit: margin,
    marketAverage: market.avg
  };
}
