const PRODUCT_MEMORY = new Map();

export function rememberProduct(query, item) {

  if (!query || !item?.title) return;

  const key = query.toLowerCase();

  if (!PRODUCT_MEMORY.has(key)) {
    PRODUCT_MEMORY.set(key, []);
  }

  const bucket = PRODUCT_MEMORY.get(key);

  bucket.push({
    title: item.title,
    price: item.totalPrice,
    time: Date.now()
  });

  if (bucket.length > 200) {
    bucket.shift();
  }
}

export function productStats(query) {

  const bucket = PRODUCT_MEMORY.get(query.toLowerCase());

  if (!bucket || !bucket.length) return null;

  const prices = bucket.map(x => x.price).filter(Boolean);

  if (!prices.length) return null;

  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  return {
    avg,
    min: Math.min(...prices),
    max: Math.max(...prices),
    count: prices.length
  };
}
