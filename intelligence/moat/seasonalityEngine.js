export function seasonalBoost(category="") {
  const m = new Date().getMonth();

  if (category==="sunglasses" && (m>=4 && m<=7))
    return 1.2;

  return 1;
}
