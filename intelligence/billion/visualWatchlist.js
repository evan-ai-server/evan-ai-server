const VISUAL_WATCHLIST = new Map();

export function addVisualWatch(userId, embedding) {

  if (!userId || !embedding) return;

  if (!VISUAL_WATCHLIST.has(userId)) {
    VISUAL_WATCHLIST.set(userId, []);
  }

  VISUAL_WATCHLIST.get(userId).push({
    embedding,
    time: Date.now()
  });
}

export function getVisualWatch(userId) {
  return VISUAL_WATCHLIST.get(userId) || [];
}
