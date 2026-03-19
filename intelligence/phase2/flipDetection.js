export function flipOpportunity(item, market) {

  if (!item?.totalPrice || !market?.avg) return 0;

  const margin = (market.avg - item.totalPrice) / market.avg;

  if (margin <= 0) return 0;

  return Math.min(margin * 1.3, 1);
}
