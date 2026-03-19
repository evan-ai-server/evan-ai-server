export function categorySignals(identity) {

  const category = identity?.category;

  if (!category) return {};

  if (category === "eyewear") {
    return { features: ["lens","frame","sunglasses"] };
  }

  if (category === "sneakers") {
    return { features: ["size","nike","adidas"] };
  }

  return {};
}
