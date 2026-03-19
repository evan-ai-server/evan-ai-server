const SELLERS = new Map();

export function recordSeller(item) {

  const seller = item.source;

  if (!seller) return;

  if (!SELLERS.has(seller)) {
    SELLERS.set(seller,{
      listings:0,
      prices:[]
    });
  }

  const data = SELLERS.get(seller);

  data.listings++;

  if (item.totalPrice) {
    data.prices.push(item.totalPrice);
  }

  if (data.prices.length > 200) {
    data.prices.shift();
  }
}

export function sellerScore(item) {

  const seller = SELLERS.get(item.source);

  if (!seller) return 0.5;

  const avg = seller.prices.reduce((a,b)=>a+b,0) / seller.prices.length;

  const priceDelta = Math.abs(item.totalPrice - avg) / avg;

  let score = 0.5;

  if (seller.listings > 20) score += 0.2;

  if (priceDelta < 0.5) score += 0.2;

  return Math.min(score,1);
}
