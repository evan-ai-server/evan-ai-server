// profit/sourceBudget.js
const LOCAL_USAGE = new Map();

function dayKeyUtc() {
  return new Date().toISOString().slice(0, 10);
}

function usageKey(namespace, source) {
  return `${namespace}:${dayKeyUtc()}:${String(source || "").toLowerCase()}`;
}

export function createSourceBudgetManager({
  redis,
  namespace = "evanai:budget:v1",
  budgets = {},
} = {}) {
  function budgetFor(source) {
    const key = String(source || "").toLowerCase();
    return (
      budgets[key] || {
        maxDailyUnits: Number.POSITIVE_INFINITY,
        allow: {
          free: true,
          pro: true,
          internal: true,
        },
      }
    );
  }

  async function getUsed(source) {
    const key = usageKey(namespace, source);

    if (!redis) {
      return Number(LOCAL_USAGE.get(key) || 0);
    }

    try {
      return Number((await redis.get(key)) || 0);
    } catch {
      return 0;
    }
  }

  async function canUse(source, { plan = "free", costUnits = 1 } = {}) {
    const spec = budgetFor(source);
    const normalizedPlan = String(plan || "free").toLowerCase();

    if (spec?.allow?.[normalizedPlan] === false) {
      return false;
    }

    const used = await getUsed(source);
    return used + Number(costUnits || 0) <= Number(spec.maxDailyUnits || Number.POSITIVE_INFINITY);
  }

  async function note(source, { costUnits = 1 } = {}) {
    const key = usageKey(namespace, source);
    const amount = Math.max(0, Number(costUnits || 0));

    if (!redis) {
      LOCAL_USAGE.set(key, Number(LOCAL_USAGE.get(key) || 0) + amount);
      return;
    }

    try {
      await redis.incrby(key, amount);
      await redis.expire(key, 2 * 24 * 60 * 60);
    } catch {}
  }

  return {
    budgetFor,
    getUsed,
    canUse,
    note,
  };
}
