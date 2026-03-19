const MARKET_PULSE = new Map();

export function recordScan(query) {

  const key = query.toLowerCase();

  if (!MARKET_PULSE.has(key)) {
    MARKET_PULSE.set(key, []);
  }

  const arr = MARKET_PULSE.get(key);

  arr.push(Date.now());

  if (arr.length > 500) arr.shift();
}

export function marketTrend(query) {

  const arr = MARKET_PULSE.get(query.toLowerCase()) || [];

  const lastHour = Date.now() - 3600000;

  const recent = arr.filter(x=>x>lastHour).length;

  return Math.min(recent/40,1);
}
