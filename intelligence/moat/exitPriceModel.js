export function predictExitPrice(consensus) {
  if (!consensus) return null;

  const { median, low, high } = consensus;

  const weighted =
    median * 0.6 +
    low * 0.25 +
    high * 0.15;

  return Number(weighted.toFixed(2));
}
