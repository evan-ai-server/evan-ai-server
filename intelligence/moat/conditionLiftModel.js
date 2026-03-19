export function conditionLift(price, condition="used") {
  if (!price) return null;

  if (condition==="used")
    return price * 1.2;

  return price;
}
