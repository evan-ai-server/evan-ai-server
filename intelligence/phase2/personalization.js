const USER_PREFS = new Map();

export function recordUserClick(userId, item) {

  if (!userId) return;

  if (!USER_PREFS.has(userId)) USER_PREFS.set(userId, []);

  USER_PREFS.get(userId).push(item.title);
}

export function preferenceBoost(userId, item) {

  const prefs = USER_PREFS.get(userId);

  if (!prefs) return 0;

  const title = item.title?.toLowerCase() || "";

  for (const p of prefs) {
    if (title.includes(p.toLowerCase())) return 0.15;
  }

  return 0;
}
