import { cosineSimilarity } from "../vision/embeddingSearch.js";

export function visualProductSearch(scanEmbedding, listings = []) {

  if (!scanEmbedding || !listings.length) return [];

  const scored = [];

  for (const item of listings) {

    if (!item.embedding) continue;

    const score = cosineSimilarity(scanEmbedding, item.embedding);

    scored.push({
      ...item,
      visualMatch: score
    });
  }

  scored.sort((a,b)=>b.visualMatch-a.visualMatch);

  return scored.slice(0,25);
}
