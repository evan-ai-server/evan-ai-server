export function detectSuspicious(item) {
  if (!item.price) return false;

  if (item.price < 5) return true;
  if ((item.reviews||0) < 3 && (item.rating||0) < 2) return true;

  return false;
}
