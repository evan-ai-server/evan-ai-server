const PRICE_MEMORY = new Map();

export function recordPriceObservation(query, price) {
  if (!price) return;

  const key = query.toLowerCase();

  if (!PRICE_MEMORY.has(key)) {
    PRICE_MEMORY.set(key, []);
  }

  const arr = PRICE_MEMORY.get(key);
  arr.push({ price, t: Date.now() });

  if (arr.length > 200) arr.shift();
}

export function getHistoricalStats(query) {
  const arr = PRICE_MEMORY.get(query.toLowerCase()) || [];

  if (!arr.length) return null;

  const prices = arr.map(x => x.price);
  const avg = prices.reduce((a,b)=>a+b,0) / prices.length;

  return {
    avg,
    min: Math.min(...prices),
    max: Math.max(...prices),
    samples: prices.length
  };
}
