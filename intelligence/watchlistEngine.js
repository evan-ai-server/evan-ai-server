const WATCH_MEMORY = new Map();

export function recordWatch(query, item) {
  const key = query.toLowerCase();

  if (!WATCH_MEMORY.has(key)) {
    WATCH_MEMORY.set(key, []);
  }

  WATCH_MEMORY.get(key).push({
    price: item.totalPrice || item.price,
    t: Date.now()
  });
}

export function watchlistTrend(query) {
  const arr = WATCH_MEMORY.get(query.toLowerCase()) || [];

  if (arr.length < 5) return null;

  const prices = arr.map(x => x.price);
  const avg = prices.reduce((a,b)=>a+b,0)/prices.length;

  return avg;
}
