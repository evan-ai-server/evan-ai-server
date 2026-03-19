export function listingTrustScore(item) {
  let score = 0.5;

  if (item?.rating) score += 0.1;
  if (item?.reviews > 10) score += 0.1;
  if (item?.linkVerified) score += 0.15;
  if (item?.source?.includes("ebay")) score += 0.1;

  return Math.min(score, 1);
}
