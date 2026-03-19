const SELLER_GRAPH = new Map();

export function recordSeller(item) {

  if (!item?.source) return;

  const seller = item.source;

  if (!SELLER_GRAPH.has(seller)) {
    SELLER_GRAPH.set(seller, { listings: 0 });
  }

  SELLER_GRAPH.get(seller).listings++;
}

export function sellerScore(item) {

  const seller = item?.source;

  if (!seller || !SELLER_GRAPH.has(seller)) return 0.5;

  const listings = SELLER_GRAPH.get(seller).listings;

  if (listings > 100) return 0.9;
  if (listings > 20) return 0.7;

  return 0.5;
}
