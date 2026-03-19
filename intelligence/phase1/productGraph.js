const PRODUCT_GRAPH = new Map();

export function rememberProductNode(query, item) {
  const key = query.toLowerCase();
  if (!PRODUCT_GRAPH.has(key)) PRODUCT_GRAPH.set(key, []);

  PRODUCT_GRAPH.get(key).push(item);

  if (PRODUCT_GRAPH.get(key).length > 100) {
    PRODUCT_GRAPH.get(key).shift();
  }
}

export function getProductNeighbors(query) {
  return PRODUCT_GRAPH.get(query.toLowerCase()) || [];
}
