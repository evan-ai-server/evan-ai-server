// Visual vector memory for product similarity

const VECTOR_DB = [];

function cosine(a, b) {
  if (!a || !b) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function storeVector(query, embedding, item = null) {

  if (!embedding) return;

  VECTOR_DB.push({
    query,
    embedding,
    item,
    time: Date.now()
  });

  if (VECTOR_DB.length > 5000) {
    VECTOR_DB.shift();
  }
}

export function nearestVectors(embedding, limit = 10) {

  if (!embedding) return [];

  const scored = [];

  for (const row of VECTOR_DB) {

    const sim = cosine(embedding, row.embedding);

    if (sim > 0.75) {
      scored.push({
        similarity: sim,
        ...row
      });
    }
  }

  scored.sort((a,b)=>b.similarity-a.similarity);

  return scored.slice(0, limit);
}
