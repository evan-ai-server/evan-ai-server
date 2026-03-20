import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(
  process.env.PRODUCT_SCALE_ROOT || "./storage/product-scale"
);

const USERS_DIR = path.join(ROOT, "users");
const NOTIFICATIONS_DIR = path.join(ROOT, "notifications");
const PRECOMPUTE_DIR = path.join(ROOT, "precompute");
const ANALYTICS_DIR = path.join(ROOT, "analytics");
const META_DIR = path.join(ROOT, "meta");

const RECENT_ANALYTICS_FILE = path.join(META_DIR, "recent-analytics.json");

const USER_CACHE = new Map();
const NOTIFICATION_CACHE = new Map();
const PRECOMPUTE_CACHE = new Map();
let RECENT_ANALYTICS = [];

let INITIALIZED = false;
let INIT_PROMISE = null;

function sha(input = "") {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function safeId(value = "", max = 120) {
  return String(value || "").trim().slice(0, max);
}

function normalizeQuery(q = "") {
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function finitePrice(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? round2(v) : null;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function userFile(userId = "") {
  return path.join(USERS_DIR, `${sha(userId).slice(0, 24)}.json`);
}

function notificationFile(userId = "") {
  return path.join(NOTIFICATIONS_DIR, `${sha(userId).slice(0, 24)}.json`);
}

function precomputeFile(query = "") {
  return path.join(PRECOMPUTE_DIR, `${sha(normalizeQuery(query)).slice(0, 24)}.json`);
}

function analyticsDailyFile(dateKey = "") {
  return path.join(ANALYTICS_DIR, `${dateKey}.json`);
}

function dayKeyFromTs(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

async function ensureReady() {
  if (INITIALIZED) return;
  if (INIT_PROMISE) {
    await INIT_PROMISE;
    return;
  }

  INIT_PROMISE = (async () => {
    await Promise.all([
      ensureDir(ROOT),
      ensureDir(USERS_DIR),
      ensureDir(NOTIFICATIONS_DIR),
      ensureDir(PRECOMPUTE_DIR),
      ensureDir(ANALYTICS_DIR),
      ensureDir(META_DIR),
    ]);

    RECENT_ANALYTICS = Array.isArray(await readJson(RECENT_ANALYTICS_FILE, []))
      ? await readJson(RECENT_ANALYTICS_FILE, [])
      : [];

    INITIALIZED = true;
  })();

  try {
    await INIT_PROMISE;
  } finally {
    INIT_PROMISE = null;
  }
}

export async function initializeProductScale() {
  await ensureReady();
  return getProductScaleStats();
}

export function getProductScaleStats() {
  return {
    root: ROOT,
    cachedUsers: USER_CACHE.size,
    cachedNotifications: NOTIFICATION_CACHE.size,
    cachedPrecomputes: PRECOMPUTE_CACHE.size,
    recentAnalyticsEvents: Array.isArray(RECENT_ANALYTICS)
      ? RECENT_ANALYTICS.length
      : 0,
  };
}

export async function getUserProfile(userId = "") {
  await ensureReady();

  const id = safeId(userId, 120);
  if (!id) return null;

  if (USER_CACHE.has(id)) {
    return USER_CACHE.get(id);
  }

  const profile = await readJson(userFile(id), null);
  if (profile && typeof profile === "object") {
    USER_CACHE.set(id, profile);
    return profile;
  }

  return null;
}

export async function upsertUserProfile(userId = "", patch = {}) {
  await ensureReady();

  const id = safeId(userId, 120);
  if (!id) return null;

  const prev = (await getUserProfile(id)) || {
    userId: id,
    createdAt: Date.now(),
  };

  const next = {
    ...prev,
    ...patch,
    userId: id,
    updatedAt: Date.now(),
  };

  USER_CACHE.set(id, next);
  await writeJson(userFile(id), next);
  return next;
}

async function getNotificationRows(userId = "") {
  const id = safeId(userId, 120);
  if (!id) return [];

  if (NOTIFICATION_CACHE.has(id)) {
    return NOTIFICATION_CACHE.get(id);
  }

  const rows = await readJson(notificationFile(id), []);
  const list = Array.isArray(rows) ? rows : [];
  NOTIFICATION_CACHE.set(id, list);
  return list;
}

async function saveNotificationRows(userId = "", rows = []) {
  const id = safeId(userId, 120);
  if (!id) return [];

  NOTIFICATION_CACHE.set(id, rows);
  await writeJson(notificationFile(id), rows);
  return rows;
}

export async function enqueueNotification({
  userId,
  kind = "general",
  title = "",
  body = "",
  data = null,
  dedupeKey = null,
  cooldownMs = 6 * 60 * 60 * 1000,
} = {}) {
  await ensureReady();

  const id = safeId(userId, 120);
  if (!id) return null;

  const rows = await getNotificationRows(id);
  const now = Date.now();
  const normalizedDedupe = safeId(dedupeKey || "", 180) || null;

  if (normalizedDedupe) {
    const existing = rows.find(
      (row) =>
        row?.dedupeKey === normalizedDedupe &&
        now - Number(row?.createdAt || 0) <= cooldownMs
    );

    if (existing) return existing;
  }

  const item = {
    id: sha(`${id}|${kind}|${title}|${body}|${now}`).slice(0, 24),
    userId: id,
    kind: safeId(kind, 60) || "general",
    title: String(title || "").trim() || "Update",
    body: String(body || "").trim() || "",
    data: data && typeof data === "object" ? data : null,
    dedupeKey: normalizedDedupe,
    read: false,
    createdAt: now,
  };

  const next = [item, ...rows].slice(0, 250);
  await saveNotificationRows(id, next);
  return item;
}

export async function listNotifications(userId = "", limit = 50) {
  await ensureReady();

  const id = safeId(userId, 120);
  if (!id) return [];

  const rows = await getNotificationRows(id);
  return rows.slice(0, Math.max(1, Number(limit || 50)));
}

export async function markNotificationsRead({
  userId,
  ids = [],
  all = false,
} = {}) {
  await ensureReady();

  const id = safeId(userId, 120);
  if (!id) return [];

  const rows = await getNotificationRows(id);
  const idSet = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)));

  const next = rows.map((row) => {
    if (all || idSet.has(String(row?.id || ""))) {
      return {
        ...row,
        read: true,
        readAt: Date.now(),
      };
    }
    return row;
  });

  await saveNotificationRows(id, next);
  return next;
}

export async function recordAnalyticsEventScaled({
  userId = null,
  event = "",
  payload = {},
  ts = Date.now(),
} = {}) {
  await ensureReady();

  const eventName = safeId(event, 80);
  if (!eventName) return null;

  const dateKey = dayKeyFromTs(ts);
  const file = analyticsDailyFile(dateKey);

  const prev = (await readJson(file, null)) || {
    date: dateKey,
    totalEvents: 0,
    uniqueUsers: [],
    byEvent: {},
    byPath: {},
    lastEventAt: 0,
  };

  const pathKey = safeId(payload?.path || payload?.route || "", 160) || "unknown";

  prev.totalEvents = Number(prev.totalEvents || 0) + 1;
  prev.byEvent = prev.byEvent || {};
  prev.byPath = prev.byPath || {};
  prev.uniqueUsers = Array.isArray(prev.uniqueUsers) ? prev.uniqueUsers : [];

  prev.byEvent[eventName] = Number(prev.byEvent[eventName] || 0) + 1;
  prev.byPath[pathKey] = Number(prev.byPath[pathKey] || 0) + 1;
  prev.lastEventAt = Number(ts || Date.now());

  if (userId) {
    const uid = safeId(userId, 120);
    if (uid && !prev.uniqueUsers.includes(uid)) {
      prev.uniqueUsers.push(uid);
    }
  }

  prev.uniqueUserCount = prev.uniqueUsers.length;

  await writeJson(file, prev);

  const recentEvent = {
    userId: userId ? safeId(userId, 120) : null,
    event: eventName,
    payload: payload && typeof payload === "object" ? payload : {},
    ts: Number(ts || Date.now()),
  };

  RECENT_ANALYTICS.unshift(recentEvent);
  RECENT_ANALYTICS = RECENT_ANALYTICS.slice(0, 500);
  await writeJson(RECENT_ANALYTICS_FILE, RECENT_ANALYTICS);

  return {
    ok: true,
    date: dateKey,
    totalEvents: prev.totalEvents,
    uniqueUserCount: prev.uniqueUserCount,
  };
}

export async function getAnalyticsSummary(days = 7) {
  await ensureReady();

  const safeDays = Math.max(1, Math.min(30, Number(days || 7)));
  const out = {
    days: safeDays,
    totalEvents: 0,
    uniqueUsers: new Set(),
    byEvent: {},
    byPath: {},
    recent: RECENT_ANALYTICS.slice(0, 50),
    daily: [],
  };

  for (let i = 0; i < safeDays; i++) {
    const ts = Date.now() - i * 24 * 60 * 60 * 1000;
    const key = dayKeyFromTs(ts);
    const row = await readJson(analyticsDailyFile(key), null);
    if (!row) continue;

    out.totalEvents += Number(row.totalEvents || 0);

    for (const uid of Array.isArray(row.uniqueUsers) ? row.uniqueUsers : []) {
      out.uniqueUsers.add(uid);
    }

    for (const [eventName, count] of Object.entries(row.byEvent || {})) {
      out.byEvent[eventName] = Number(out.byEvent[eventName] || 0) + Number(count || 0);
    }

    for (const [pathKey, count] of Object.entries(row.byPath || {})) {
      out.byPath[pathKey] = Number(out.byPath[pathKey] || 0) + Number(count || 0);
    }

    out.daily.push({
      date: row.date || key,
      totalEvents: Number(row.totalEvents || 0),
      uniqueUserCount:
        Number(row.uniqueUserCount || 0) ||
        (Array.isArray(row.uniqueUsers) ? row.uniqueUsers.length : 0),
      lastEventAt: Number(row.lastEventAt || 0) || null,
    });
  }

  return {
    days: out.days,
    totalEvents: out.totalEvents,
    uniqueUserCount: out.uniqueUsers.size,
    byEvent: out.byEvent,
    byPath: out.byPath,
    daily: out.daily.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    recent: out.recent,
  };
}

export async function savePrecomputeSnapshot(query = "", snapshot = null) {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q || !snapshot || typeof snapshot !== "object") return null;

  const record = {
    query: q,
    ...snapshot,
    updatedAt: Date.now(),
  };

  PRECOMPUTE_CACHE.set(q, record);
  await writeJson(precomputeFile(q), record);
  return record;
}

export async function getPrecomputeSnapshot(query = "") {
  await ensureReady();

  const q = normalizeQuery(query);
  if (!q) return null;

  if (PRECOMPUTE_CACHE.has(q)) {
    return PRECOMPUTE_CACHE.get(q);
  }

  const row = await readJson(precomputeFile(q), null);
  if (row && typeof row === "object") {
    PRECOMPUTE_CACHE.set(q, row);
    return row;
  }

  return null;
}

export async function maybeHydrateUserFromActivity(userId = "", patch = {}) {
  await ensureReady();

  const id = safeId(userId, 120);
  if (!id) return null;

  return await upsertUserProfile(id, {
    lastActiveAt: Date.now(),
    ...patch,
  });
}
