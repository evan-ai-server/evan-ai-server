
  // src/resaleGraph.js
  // Private Resale Graph — compounding identity/sold/platform dataset
  // Multi-instance safe (all writes via Redis pipeline)

  import { createHash } from "crypto";

  const RG_ITEM_KEY      = (fp)           => `rgraph:item:${fp}`;
  const RG_SOLD_KEY      = (fp)           => `rgraph:item:${fp}:soldPrices`;
  const RG_VELOCITY_KEY  = (fp)           => `rgraph:item:${fp}:velocity`;
  const RG_PLATFORM_KEY  = (fp, src)      => `rgraph:platform:${src}:${fp}`;
  const RG_SOLD_MONTH_KEY= (cat, month)   => `rgraph:sold:${cat}:${month}`;
  const RG_AUTH_FMT_KEY  = (brand, model) => `rgraph:auth:${brand}:${model}:formats`;
  const RG_AUTH_FLAG_KEY = (brand, model) => `rgraph:auth:${brand}:${model}:redflags`;

  const GRAPH_TTL_SEC  = () => Number(process.env.RESALE_GRAPH_TTL_DAYS      || 90)  * 86400;
  const MAX_SOLD       = () => Number(process.env.RESALE_GRAPH_MAX_ITEMS_PER_FINGERPRINT || 500);
  const MAX_VELOCITY   = 100;

  // ── Fingerprint ─────────────────────────────────────────────────────────────

  export function fingerprintItem(identity = {}) {
    const key = [
      (identity.brand    || "").toLowerCase().trim(),
      (identity.model    || "").toLowerCase().trim(),
      (identity.category || "").toLowerCase().trim(),
      (identity.itemType || "").toLowerCase().trim(),
    ]
      .filter(Boolean)
      .join("|");

    if (!key) return null;
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  }

  // ── Ingest scan ──────────────────────────────────────────────────────────────

  export async function ingestScanToGraph(redis, {
    identity,
    marketItems   = [],
    serialResult  = null,
  }) {
    if (!redis || !identity) return null;

    const fp  = fingerprintItem(identity);
    if (!fp) return null;

    const now      = Date.now();
    const ttl      = GRAPH_TTL_SEC();
    const pipeline = redis.pipeline();

    // Item metadata (hsetnx preserves firstSeenAt across updates)
    pipeline.hsetnx(RG_ITEM_KEY(fp), "firstSeenAt", now);
    pipeline.hset(RG_ITEM_KEY(fp), {
      brand:     identity.brand    || "",
      model:     identity.model    || "",
      category:  identity.category || "",
      itemType:  identity.itemType || "",
      lastScanAt: now,
      updatedAt:  now,
    });
    pipeline.hincrby(RG_ITEM_KEY(fp), "scanCount", 1);
    pipeline.expire(RG_ITEM_KEY(fp), ttl);

    // Per-platform live listings
    const items = Array.isArray(marketItems) ? marketItems : [];
    for (const item of items.slice(0, 50)) {
      if (!item?.source) continue;
      const price = Number(item.totalPrice ?? item.price);
      if (!Number.isFinite(price) || price <= 0) continue;

      const pk = RG_PLATFORM_KEY(fp, item.source);
      pipeline.hset(pk, { lastPrice: price, lastSeenAt: now, source: item.source });
      pipeline.hincrby(pk, "listingCount", 1);
      pipeline.expire(pk, ttl);

      // Time-bucketed sold comps (used for getTopSoldMonthComps)
      const month   = new Date(now).toISOString().slice(0, 7);
      const monthKey = RG_SOLD_MONTH_KEY(identity.category || "unknown", month);
      // Unique member per listing to avoid dedup collisions
      const member  = `${fp}:${item.source}:${now}:${Math.random().toString(36).slice(2, 7)}`;
      pipeline.zadd(monthKey, price, member);
      pipeline.expire(monthKey, 90 * 86400);
    }

    // Auth signals from serial parser
    if (serialResult?.parsed?.brand) {
      const brand = serialResult.parsed.brand.toLowerCase().replace(/\s+/g, "_");
      const model = (serialResult.parsed.line || "unknown").toLowerCase().replace(/\s+/g, "_");

      if (serialResult.parsed.serialFormat) {
        pipeline.sadd(RG_AUTH_FMT_KEY(brand, model), serialResult.parsed.serialFormat);
        pipeline.expire(RG_AUTH_FMT_KEY(brand, model), ttl);
      }
      for (const flag of serialResult.redFlags || []) {
        pipeline.sadd(RG_AUTH_FLAG_KEY(brand, model), flag);
        pipeline.expire(RG_AUTH_FLAG_KEY(brand, model), ttl);
      }
    }

    await pipeline.exec();
    return fp;
  }

  // ── Record a confirmed sold outcome ─────────────────────────────────────────

  export async function recordSoldOutcome(redis, {
    fingerprint,
    platform,
    price,
    daysToSell = null,
    condition  = null,
  }) {
    if (!redis || !fingerprint || !platform) return null;
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return null;

    const now      = Date.now();
    const ttl      = GRAPH_TTL_SEC();
    const pipeline = redis.pipeline();
    const pk       = RG_PLATFORM_KEY(fingerprint, platform);

    pipeline.hset(pk, {
      lastSoldPrice:   p,
      lastSoldAt:      now,
      lastDaysToSell:  daysToSell ?? "",
    });
    pipeline.hincrby(pk, "soldCount", 1);
    pipeline.expire(pk, ttl);

    // Rolling sold price log
    const entry = JSON.stringify({ price: p, platform, daysToSell, condition, ts: now });
    pipeline.lpush(RG_SOLD_KEY(fingerprint), entry);
    pipeline.ltrim(RG_SOLD_KEY(fingerprint), 0, MAX_SOLD() - 1);
    pipeline.expire(RG_SOLD_KEY(fingerprint), ttl);

    // Sell-through velocity (days)
    if (Number.isFinite(daysToSell) && daysToSell > 0) {
      pipeline.lpush(RG_VELOCITY_KEY(fingerprint), daysToSell);
      pipeline.ltrim(RG_VELOCITY_KEY(fingerprint), 0, MAX_VELOCITY - 1);
      pipeline.expire(RG_VELOCITY_KEY(fingerprint), ttl);
    }

    await pipeline.exec();
    return fingerprint;
  }

  // ── Read item history ────────────────────────────────────────────────────────

  export async function queryResaleGraph(redis, fingerprint) {
    if (!redis || !fingerprint) return null;

    const [itemData, soldRaw, velocityRaw] = await Promise.all([
      redis.hgetall(RG_ITEM_KEY(fingerprint)),
      redis.lrange(RG_SOLD_KEY(fingerprint), 0, 99),
      redis.lrange(RG_VELOCITY_KEY(fingerprint), 0, 49),
    ]);

    if (!itemData || !Object.keys(itemData).length) return null;

    const soldPrices = soldRaw
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);

    const velocities   = velocityRaw.map(Number).filter(Number.isFinite);
    const sortedV      = [...velocities].sort((a, b) => a - b);
    const medianDaysToSell = sortedV.length
      ? sortedV[Math.floor(sortedV.length / 2)]
      : null;

    const prices       = soldPrices.map((s) => s.price).filter(Number.isFinite);
    const avgSoldPrice = prices.length
      ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
      : null;

    return {
      fingerprint,
      brand:          itemData.brand     || null,
      model:          itemData.model     || null,
      category:       itemData.category  || null,
      itemType:       itemData.itemType  || null,
      scanCount:      Number(itemData.scanCount  || 0),
      firstSeenAt:    Number(itemData.firstSeenAt || 0),
      lastScanAt:     Number(itemData.lastScanAt  || 0),
      soldPrices,
      avgSoldPrice,
      medianDaysToSell,
      updatedAt:      Number(itemData.updatedAt   || 0),
    };
  }

  // ── Platform performance for one source ─────────────────────────────────────

  export async function getPlatformPerformance(redis, fingerprint, platform) {
    if (!redis || !fingerprint || !platform) return null;
    const data = await redis.hgetall(RG_PLATFORM_KEY(fingerprint, platform));
    if (!data || !Object.keys(data).length) return null;
    return {
      platform,
      lastPrice:      data.lastPrice      ? Number(data.lastPrice)     : null,
      lastSoldPrice:  data.lastSoldPrice  ? Number(data.lastSoldPrice) : null,
      listingCount:   Number(data.listingCount  || 0),
      soldCount:      Number(data.soldCount     || 0),
      lastDaysToSell: data.lastDaysToSell ? Number(data.lastDaysToSell): null,
      lastSeenAt:     Number(data.lastSeenAt    || 0),
      lastSoldAt:     Number(data.lastSoldAt    || 0),
    };
  }

  // ── Known auth signals for a brand/model ────────────────────────────────────

  export async function getKnownAuthSignals(redis, brand, model) {
    if (!redis || !brand) return { formats: [], redFlags: [] };
    const b = brand.toLowerCase().replace(/\s+/g, "_");
    const m = (model || "unknown").toLowerCase().replace(/\s+/g, "_");
    const [formats, redFlags] = await Promise.all([
      redis.smembers(RG_AUTH_FMT_KEY(b, m)),
      redis.smembers(RG_AUTH_FLAG_KEY(b, m)),
    ]);
    return {
      formats:  Array.isArray(formats)  ? formats  : [],
      redFlags: Array.isArray(redFlags) ? redFlags : [],
    };
  }

  // ── Time-bucketed sold comps ─────────────────────────────────────────────────

  export async function getTopSoldMonthComps(redis, category, month, limit = 50) {
    if (!redis || !category || !month) return [];
    try {
      const raw = await redis.zrevrangebyscore(
        RG_SOLD_MONTH_KEY(category, month),
        "+inf", "-inf",
        "LIMIT", 0, limit
      );
      return (raw || [])
        .map((entry) => {
          const [fp, source] = (entry || "").split(":");
          return fp && source ? { fp, source } : null;
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }


