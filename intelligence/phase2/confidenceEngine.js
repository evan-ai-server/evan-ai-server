export function scanConfidence(identity, items) {

  let score = identity?.fusionConfidence || 0.5;

  if (items?.length > 10) score += 0.1;

  const trusted = items?.filter(i => i.trustModelScore > 0.7).length || 0;

  if (trusted > 5) score += 0.1;

  return Math.min(score,1);
}
