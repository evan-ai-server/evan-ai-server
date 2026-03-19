export function trustScore(item={}) {
  const rating = item.rating || 0;
  const reviews = item.reviews || 0;

  const ratingScore = rating / 5;
  const reviewScore = Math.min(reviews / 500, 1);

  return (ratingScore * 0.6) + (reviewScore * 0.4);
}
