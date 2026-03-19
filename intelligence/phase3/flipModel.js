// Flip probability model
// Predicts if an item can be flipped for profit

export function flipScore(item, consensus = {}) {

  if (!item) return 0;

  const price =
    Number(item.totalPrice) ||
    Number(item.price) ||
    null;

  if (!price) return 0;

  const marketAvg =
    consensus?.avg ||
    consensus?.typical ||
    consensus?.typicalHigh ||
    null;

  if (!marketAvg) return 0;

  const sellerScore = Number(item.sellerScore || 0.5);
  const trustScore = Number(item.trustModelScore || item.__trustScore || 0.5);
  const dealScore = Number(item.dealScore || 0);

  const margin = (marketAvg - price) / marketAvg;

  if (margin <= 0) return 0;

  let score = 0;

  // raw margin
  score += margin * 0.55;

  // seller reliability
  score += sellerScore * 0.15;

  // listing trust
  score += trustScore * 0.15;

  // detected deal
  score += dealScore * 0.15;

  return Math.max(0, Math.min(score, 1));
}
