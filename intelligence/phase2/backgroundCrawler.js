const BACKGROUND_CACHE = new Map();

export function rememberListings(query, items) {

  BACKGROUND_CACHE.set(query, items.slice(0,20));
}

export function getCachedListings(query) {
  return BACKGROUND_CACHE.get(query) || [];
}
