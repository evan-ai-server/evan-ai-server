export function restorationUpside(price) {
  if (!price) return null;

  return price * 1.25;
}
