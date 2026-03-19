export function categoryAdapter(query, category) {

  if (!category) return query;

  if (category === "eyewear") {
    return `${query} sunglasses`;
  }

  if (category === "sneakers") {
    return `${query} shoes`;
  }

  if (category === "bags") {
    return `${query} bag`;
  }

  return query;
}
