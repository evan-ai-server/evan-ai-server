const PRODUCT_METADATA = new Map();

export function enrichProduct(query, items) {

  const key = query.toLowerCase();

  if (!PRODUCT_METADATA.has(key)) {
    PRODUCT_METADATA.set(key, {
      scans: 0,
      lastSeen: Date.now()
    });
  }

  const meta = PRODUCT_METADATA.get(key);

  meta.scans += 1;
  meta.lastSeen = Date.now();

  return meta;
}
