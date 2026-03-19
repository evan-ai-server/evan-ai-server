export function imageEmbeddingScore(scanEmbedding, listingEmbedding) {
  if (!scanEmbedding || !listingEmbedding) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < scanEmbedding.length; i++) {
    dot += scanEmbedding[i] * listingEmbedding[i];
    magA += scanEmbedding[i] * scanEmbedding[i];
    magB += listingEmbedding[i] * listingEmbedding[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
