export function arbitrageScore(item, marketStats) {

  if (!item?.totalPrice || !marketStats?.avg) return 0;

  const spread = marketStats.avg - item.totalPrice;

  if (spread <= 0) return 0;

  const margin = spread / marketStats.avg;

  return Math.min(margin * 1.8,1);
}
