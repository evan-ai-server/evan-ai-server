export function evolveQueries(baseQuery, titles = []) {
  const tokens = new Set();

  for (const title of titles) {
    const parts = title.toLowerCase().split(" ");
    for (const p of parts) {
      if (p.length > 3) tokens.add(p);
    }
  }

  const expanded = Array.from(tokens)
    .slice(0, 5)
    .map(t => baseQuery + " " + t);

  return expanded;
}
