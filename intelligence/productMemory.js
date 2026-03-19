const PRODUCT_GRAPH = new Map();

export function rememberProduct(query, item) {
  const key = query.toLowerCase();

  if (!PRODUCT_GRAPH.has(key)) {
    PRODUCT_GRAPH.set(key, []);
  }

  const arr = PRODUCT_GRAPH.get(key);
  arr.push(item);

  if (arr.length > 50) arr.shift();
}

export function getProductMemory(query) {
  return PRODUCT_GRAPH.get(query.toLowerCase()) || [];
}
