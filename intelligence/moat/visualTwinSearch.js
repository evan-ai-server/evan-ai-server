export function visualSimilarityScore(a = "", b = "") {
  const ta = a.toLowerCase().split(" ");
  const tb = b.toLowerCase().split(" ");

  const setA = new Set(ta);
  const setB = new Set(tb);

  let overlap = 0;

  for (const t of setA) {
    if (setB.has(t)) overlap++;
  }

  return overlap / Math.max(setA.size, 1);
}
