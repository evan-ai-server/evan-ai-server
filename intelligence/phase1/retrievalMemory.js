const QUERY_MEMORY = new Map();

export function rememberQuerySuccess(query, count) {
  QUERY_MEMORY.set(query, {
    results: count,
    time: Date.now()
  });
}

export function bestHistoricalQuery(base) {
  let best = base;
  let bestScore = 0;

  for (const [q, data] of QUERY_MEMORY.entries()) {
    if (q.includes(base) && data.results > bestScore) {
      best = q;
      bestScore = data.results;
    }
  }

  return best;
}
