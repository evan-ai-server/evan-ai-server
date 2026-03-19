export function estimateSellThrough(active = [], sold = []) {
  const a = active.length;
  const s = sold.length;

  if (!a && !s) return 0;

  return Math.min(1, s / (a + s));
}
