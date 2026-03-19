const GLOBAL_GRAPH = new Map();

export function updateProductGraph(query, item) {

  const key = query.toLowerCase();

  if (!GLOBAL_GRAPH.has(key)) {
    GLOBAL_GRAPH.set(key,{
      scans:0,
      sellers:new Set(),
      prices:[]
    });
  }

  const node = GLOBAL_GRAPH.get(key);

  node.scans++;

  if (item?.source) node.sellers.add(item.source);

  if (item?.totalPrice) node.prices.push(item.totalPrice);

  if (node.prices.length > 500) node.prices.shift();
}

export function graphStats(query) {

  const node = GLOBAL_GRAPH.get(query.toLowerCase());

  if (!node) return null;

  const avg = node.prices.reduce((a,b)=>a+b,0)/node.prices.length;

  return {
    scans: node.scans,
    sellers: node.sellers.size,
    avgPrice: avg
  };
}
