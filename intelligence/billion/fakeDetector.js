export function authenticityScore(item, identity) {

  if (!item?.title) return 0.5;

  let score = 0.5;

  const title = item.title.toLowerCase();

  if (identity?.brand && title.includes(identity.brand.toLowerCase())) {
    score += 0.2;
  }

  if (item.totalPrice && item.totalPrice < 0.3 * (item.consensus?.avg || item.totalPrice)) {
    score -= 0.2;
  }

  if (title.includes("replica") || title.includes("fake")) {
    score -= 0.4;
  }

  return Math.max(0, Math.min(score,1));
}
