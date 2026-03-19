const MARKET_ACTIVITY = new Map();

export function recordMarketActivity(query) {

  const key = query.toLowerCase();

  if (!MARKET_ACTIVITY.has(key)) {
    MARKET_ACTIVITY.set(key, []);
  }

  const arr = MARKET_ACTIVITY.get(key);

  arr.push(Date.now());

  if (arr.length > 200) arr.shift();
}

export function marketHeat(query) {

  const arr = MARKET_ACTIVITY.get(query.toLowerCase()) || [];

  if (!arr.length) return 0;

  const lastHour = Date.now() - 3600000;

  const recent = arr.filter(t => t > lastHour);

  return Math.min(recent.length / 20, 1);
}
