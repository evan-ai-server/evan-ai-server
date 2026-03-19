export function imageSimilarityScore(scanIdentity, listing) {
  if (!scanIdentity || !listing?.title) return 0;

  let score = 0;
  const title = listing.title.toLowerCase();

  for (const c of scanIdentity.colors || []) {
    if (title.includes(c)) score += 0.15;
  }

  for (const s of scanIdentity.styleWords || []) {
    if (title.includes(s)) score += 0.15;
  }

  if (scanIdentity.brand && title.includes(scanIdentity.brand.toLowerCase())) {
    score += 0.35;
  }

  return Math.min(score, 1);
}
