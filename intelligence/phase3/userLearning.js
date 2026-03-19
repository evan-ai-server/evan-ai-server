const USER_BEHAVIOR = new Map();

export function recordUserInterest(userId, item) {

  if (!userId) return;

  if (!USER_BEHAVIOR.has(userId)) {
    USER_BEHAVIOR.set(userId, []);
  }

  USER_BEHAVIOR.get(userId).push(item.title);

}

export function userPreferenceBoost(userId, item) {

  const prefs = USER_BEHAVIOR.get(userId);

  if (!prefs) return 0;

  const title = item.title?.toLowerCase() || "";

  for (const p of prefs) {
    if (title.includes(p.toLowerCase())) {
      return 0.15;
    }
  }

  return 0;
}
