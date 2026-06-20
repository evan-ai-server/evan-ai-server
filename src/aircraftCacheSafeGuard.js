const NON_AIRCRAFT_TERMS = new Set([
  "glasses", "sunglasses", "eyeglasses", "eyewear",
  "shoes", "sneakers", "boots", "sandals", "heels", "loafers",
  "shirt", "pants", "dress", "jacket", "coat", "skirt", "blouse", "hoodie", "sweater",
  "hat", "cap", "beanie", "scarf", "gloves", "socks", "underwear",
  "purse", "handbag", "wallet", "backpack", "tote",
  "ring", "necklace", "bracelet", "earring", "earrings",
  "perfume", "cologne", "cosmetics", "makeup", "lipstick",
  "jeans", "shorts", "leggings", "joggers",
]);

const AIRCRAFT_QUERY_TERMS = [
  "airplane", "aircraft", "diecast", "die cast", "aviation",
  "boeing", "airbus", "model plane", "model airplane", "aircraft model",
];

export function isAircraftQueryContext(query) {
  const q = (query || "").toLowerCase();
  return AIRCRAFT_QUERY_TERMS.some((w) => q.includes(w));
}

export function sanitizeAircraftVariants(query, variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return { variants: variants || [], removed: [] };
  }
  if (!isAircraftQueryContext(query)) {
    return { variants, removed: [] };
  }
  const kept = [];
  const removed = [];
  for (const v of variants) {
    const vLower = String(v || "").toLowerCase().trim();
    if (!vLower) { kept.push(v); continue; }
    const tokens = vLower.split(/\s+/);
    if (tokens.some((t) => NON_AIRCRAFT_TERMS.has(t))) {
      removed.push(v);
    } else {
      kept.push(v);
    }
  }
  return { variants: kept, removed };
}
