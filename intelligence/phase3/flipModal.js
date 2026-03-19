export function flipScore(item, consensus) {

  if (!item?.totalPrice || !consensus?.typicalHigh) return 0;

  const price = item.totalPrice;
  const high = consensus.typicalHigh;

  const margin = (high - price) / high;

  if (margin <= 0) return 0;

  return Math.min(margin * 1.4, 1);
}
