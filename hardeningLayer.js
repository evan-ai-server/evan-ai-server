import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(process.env.HARDENING_ROOT || "./storage/hardening");
const OBS_DIR = path.join(ROOT, "observability");
const STATE_DIR = path.join(ROOT, "state");
const BACKUP_DIR = path.join(ROOT, "backups");

const EVENTS_FILE = path.join(OBS_DIR, "events.json");
const ROUTES_FILE = path.join(STATE_DIR, "routes.json");
const MODELS_FILE = path.join(STATE_DIR, "models.json");
const SECURITY_FILE = path.join(STATE_DIR, "security.json");
const BACKUPS_INDEX_FILE = path.join(BACKUP_DIR, "index.json");

const STRICT_MODE =
  String(process.env.HARDENING_STRICT_MODE || "false").toLowerCase() === "true";

const BACKUP_KEEP = Math.max(
  5,
  Number(process.env.HARDENING_BACKUP_KEEP || 20)
);

const MAX_EVENTS = 500;
const MAX_ROUTE_SAMPLES = 120;
const MAX_SECURITY_ROWS = 3000;

let READY = false;
let READY_PROMISE = null;
let FLUSH_TIMER = null;
let BACKUP_LOOP_STARTED = false;

const RECENT_EVENTS = [];
const ROUTE_STATS = new Map();
const MODEL_STATS = new Map();
const SECURITY_STATS = new Map();
let BACKUP_INDEX = [];

function sha(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function safeStr(value = "", max = 180) {
  return String(value || "").trim().slice(0, max);
}

function normalizeQuery(q = "") {
  return String(q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
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

function routeMapToJson() {
  return [...ROUTE_STATS.entries()].map(([key, value]) => ({
    key,
    ...value,
  }));
}

function modelMapToJson() {
  return [...MODEL_STATS.entries()].map(([key, value]) => ({
    key,
    ...value,
  }));
}

function securityMapToJson(limit = MAX_SECURITY_ROWS) {
  return [...SECURITY_STATS.entries()]
    .map(([key, value]) => ({
      key,
      ...value,
      minuteHits: Array.isArray(value.minuteHits) ? value.minuteHits.length : 0,
      hourHits: Array.isArray(value.hourHits) ? value.hourHits.length : 0,
    }))
    .sort((a, b) => Number(b.riskScore || 0) - Number(a.riskScore || 0))
    .slice(0, limit);
}

function scheduleFlush() {
  if (FLUSH_TIMER) return;

  FLUSH_TIMER = setTimeout(async () => {
    FLUSH_TIMER = null;

    try {
      await Promise.all([
        writeJson(EVENTS_FILE, RECENT_EVENTS.slice(0, MAX_EVENTS)),
        writeJson(ROUTES_FILE, routeMapToJson()),
        writeJson(MODELS_FILE, modelMapToJson()),
        writeJson(SECURITY_FILE, securityMapToJson()),
        writeJson(BACKUPS_INDEX_FILE, BACKUP_INDEX),
      ]);
    } catch (err) {
      console.warn("hardening flush failed", err?.message || err);
    }
  }, 1200);

  FLUSH_TIMER.unref?.();
}

async function ensureReady() {
  if (READY) return;
  if (READY_PROMISE) {
    await READY_PROMISE;
    return;
  }

  READY_PROMISE = (async () => {
    await Promise.all([
      ensureDir(ROOT),
      ensureDir(OBS_DIR),
      ensureDir(STATE_DIR),
      ensureDir(BACKUP_DIR),
    ]);

    const [events, routes, models, security, backups] = await Promise.all([
      readJson(EVENTS_FILE, []),
      readJson(ROUTES_FILE, []),
      readJson(MODELS_FILE, []),
      readJson(SECURITY_FILE, []),
      readJson(BACKUPS_INDEX_FILE, []),
    ]);

    for (const row of Array.isArray(events) ? events : []) {
      RECENT_EVENTS.push(row);
    }

    for (const row of Array.isArray(routes) ? routes : []) {
      if (row?.key) ROUTE_STATS.set(row.key, row);
    }

    for (const row of Array.isArray(models) ? models : []) {
      if (row?.key) MODEL_STATS.set(row.key, row);
    }

    for (const row of Array.isArray(security) ? security : []) {
      if (!row?.key) continue;

      SECURITY_STATS.set(row.key, {
        ...row,
        minuteHits: [],
        hourHits: [],
      });
    }

    BACKUP_INDEX = Array.isArray(backups) ? backups : [];
    READY = true;
  })();

  try {
    await READY_PROMISE;
  } finally {
    READY_PROMISE = null;
  }
}

export function recordHardeningEvent(kind = "", payload = {}) {
  const item = {
    id: sha(`${kind}|${Date.now()}|${Math.random()}`).slice(0, 20),
    kind: safeStr(kind, 80) || "event",
    payload: payload && typeof payload === "object" ? payload : {},
    ts: Date.now(),
  };

  RECENT_EVENTS.unshift(item);

  if (RECENT_EVENTS.length > MAX_EVENTS) {
    RECENT_EVENTS.length = MAX_EVENTS;
  }

  scheduleFlush();
  return item;
}

function isLocalIp(ip = "") {
  const value = String(ip || "").toLowerCase();
  return (
    value.includes("127.0.0.1") ||
    value === "::1" ||
    value.includes("::ffff:127.0.0.1") ||
    value.includes("localhost")
  );
}

function requestFingerprint(req) {
  const ip = String(req.ip || "");
  const ua = String(req.headers["user-agent"] || "");
  const accept = String(req.headers.accept || "");
  return sha(`${ip}|${ua}|${accept}`).slice(0, 24);
}

function routeKindFromReq(req) {
  const route = String(req.originalUrl || req.path || "").toLowerCase();

  if (route.includes("/vision")) return "vision";
  if (route.includes("/market")) return "market";
  if (route.includes("/watch")) return "watch";
  if (route.includes("/analytics")) return "analytics";
  if (route.includes("/debug")) return "debug";
  return "general";
}

function getSecurityRow(key = "") {
  if (!SECURITY_STATS.has(key)) {
    SECURITY_STATS.set(key, {
      fingerprint: key,
      firstSeenAt: Date.now(),
      lastSeenAt: 0,
      riskScore: 0,
      blockedUntil: 0,
      minuteHits: [],
      hourHits: [],
      recentKinds: {},
      lastIp: null,
      lastUserAgent: null,
      lastReason: null,
    });
  }

  return SECURITY_STATS.get(key);
}

function pruneSecurityRow(row) {
  const now = Date.now();

  row.minuteHits = (Array.isArray(row.minuteHits) ? row.minuteHits : []).filter(
    (ts) => now - ts < 60 * 1000
  );

  row.hourHits = (Array.isArray(row.hourHits) ? row.hourHits : []).filter(
    (ts) => now - ts < 60 * 60 * 1000
  );

  return row;
}

function computeRiskScore({ minuteHits, hourHits, routeKind, badUa }) {
  const minute = Number(minuteHits || 0);
  const hour = Number(hourHits || 0);

  let score = 0;

  if (routeKind === "vision") {
    score += minute >= 25 ? 25 : minute;
    score += hour >= 120 ? 20 : Math.floor(hour / 8);
  } else if (routeKind === "market") {
    score += minute >= 40 ? 20 : Math.floor(minute / 2);
    score += hour >= 300 ? 18 : Math.floor(hour / 15);
  } else {
    score += minute >= 80 ? 14 : Math.floor(minute / 6);
    score += hour >= 800 ? 16 : Math.floor(hour / 40);
  }

  if (badUa) score += 60;
  return Math.min(100, score);
}

export function buildHardeningMiddleware() {
  return (req, res, next) => {
    void ensureReady();

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    const ip = String(req.ip || "");
    const ua = String(req.headers["user-agent"] || "");
    const contentLength = Number(req.headers["content-length"] || 0);
    const fingerprint = requestFingerprint(req);
    const routeKind = routeKindFromReq(req);
    const local = isLocalIp(ip);

    const row = pruneSecurityRow(getSecurityRow(fingerprint));
    const now = Date.now();

    row.lastSeenAt = now;
    row.lastIp = ip || null;
    row.lastUserAgent = ua || null;

    row.minuteHits.push(now);
    row.hourHits.push(now);
    row.recentKinds[routeKind] = Number(row.recentKinds[routeKind] || 0) + 1;

    const badUa =
      /\b(sqlmap|nikto|masscan|nmap|gobuster|dirbuster|acunetix|nessus)\b/i.test(
        ua
      );

    const minuteHits = row.minuteHits.length;
    const hourHits = row.hourHits.length;
    const riskScore = computeRiskScore({
      minuteHits,
      hourHits,
      routeKind,
      badUa,
    });

    row.riskScore = riskScore;

    const minuteThreshold =
      routeKind === "vision"
        ? 45
        : routeKind === "market"
        ? 140
        : 260;

    const hardMinuteThreshold =
      routeKind === "vision"
        ? 70
        : routeKind === "market"
        ? 220
        : 420;

    let blockReason = null;

    if (badUa) {
      blockReason = "bad_user_agent";
    } else if (!local && STRICT_MODE && minuteHits > minuteThreshold) {
      blockReason = "strict_rate_limit";
    } else if (!local && minuteHits > hardMinuteThreshold) {
      blockReason = "burst_limit";
    } else if (contentLength > 12 * 1024 * 1024) {
      blockReason = "payload_too_large";
    }

    if (blockReason) {
      row.blockedUntil =
        blockReason === "bad_user_agent"
          ? now + 30 * 60 * 1000
          : now + 10 * 60 * 1000;
      row.lastReason = blockReason;

      recordHardeningEvent("request_blocked", {
        route: req.originalUrl,
        method: req.method,
        ip,
        routeKind,
        fingerprint,
        reason: blockReason,
        minuteHits,
        hourHits,
      });

      scheduleFlush();

      return res.status(blockReason === "payload_too_large" ? 413 : 429).json({
        ok: false,
        error:
          blockReason === "payload_too_large"
            ? "payload_too_large"
            : "temporarily_blocked",
        reason: blockReason,
      });
    }

    if (!local && row.blockedUntil > now) {
      return res.status(429).json({
        ok: false,
        error: "temporarily_blocked",
        reason: row.lastReason || "cooldown_active",
      });
    }

    req.hardening = {
      fingerprint,
      routeKind,
      riskScore,
      local,
      minuteHits,
      hourHits,
      blockedUntil: row.blockedUntil || 0,
    };

    scheduleFlush();
    return next();
  };
}

export function recordRouteObservation({
  route = "",
  method = "",
  statusCode = 0,
  durationMs = 0,
  ip = "",
  userId = null,
  rid = null,
} = {}) {
  void ensureReady();

  const key = `${String(method || "GET").toUpperCase()} ${String(route || "")}`;
  const row = ROUTE_STATS.get(key) || {
    route: String(route || ""),
    method: String(method || "GET").toUpperCase(),
    count: 0,
    errorCount: 0,
    slowCount: 0,
    avgMs: 0,
    maxMs: 0,
    lastStatusCode: 0,
    lastSeenAt: 0,
    samples: [],
  };

  row.count += 1;
  row.errorCount += Number(statusCode || 0) >= 500 ? 1 : 0;
  row.slowCount += Number(durationMs || 0) >= 4000 ? 1 : 0;
  row.lastStatusCode = Number(statusCode || 0);
  row.lastSeenAt = Date.now();
  row.maxMs = Math.max(Number(row.maxMs || 0), Number(durationMs || 0));

  const prevAvg = Number(row.avgMs || 0);
  row.avgMs =
    row.count <= 1
      ? Number(durationMs || 0)
      : round2((prevAvg * (row.count - 1) + Number(durationMs || 0)) / row.count);

  row.samples = Array.isArray(row.samples) ? row.samples : [];
  row.samples.push(Number(durationMs || 0));
  if (row.samples.length > MAX_ROUTE_SAMPLES) {
    row.samples = row.samples.slice(-MAX_ROUTE_SAMPLES);
  }

  ROUTE_STATS.set(key, row);

  if (Number(statusCode || 0) >= 500) {
    recordHardeningEvent("route_error", {
      route,
      method,
      statusCode,
      durationMs,
      ip,
      userId,
      rid,
    });
  } else if (Number(durationMs || 0) >= 4000) {
    recordHardeningEvent("slow_request", {
      route,
      method,
      statusCode,
      durationMs,
      ip,
      userId,
      rid,
    });
  }

  scheduleFlush();
}

function getModelRow(operation = "", provider = "openai", model = "unknown") {
  const key = safeStr(operation, 120) || "unknown_model_op";

  if (!MODEL_STATS.has(key)) {
    MODEL_STATS.set(key, {
      operation: key,
      provider,
      model,
      inflight: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      circuitUntil: 0,
      lastLatencyMs: null,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      lastError: null,
    });
  }

  const row = MODEL_STATS.get(key);
  row.provider = provider || row.provider || "openai";
  row.model = model || row.model || "unknown";
  return row;
}

export async function withModelServing(operation, fn, opts = {}) {
  await ensureReady();

  const provider = safeStr(opts?.provider || "openai", 40) || "openai";
  const model = safeStr(opts?.model || "unknown", 80) || "unknown";
  const maxConsecutiveFailures = Math.max(
    2,
    Number(opts?.maxConsecutiveFailures || 4)
  );
  const circuitMs = Math.max(10_000, Number(opts?.circuitMs || 60_000));

  const row = getModelRow(operation, provider, model);
  const now = Date.now();

  if (Number(row.circuitUntil || 0) > now) {
    const err = new Error(`model_circuit_open:${row.operation}`);
    err.code = "MODEL_CIRCUIT_OPEN";

    recordHardeningEvent("model_circuit_open", {
      operation: row.operation,
      provider: row.provider,
      model: row.model,
      circuitUntil: row.circuitUntil,
    });

    throw err;
  }

  row.inflight += 1;
  const startedAt = Date.now();

  try {
    const result = await fn();

    row.successes += 1;
    row.consecutiveFailures = 0;
    row.lastLatencyMs = Date.now() - startedAt;
    row.lastSuccessAt = Date.now();
    row.lastError = null;
    row.circuitUntil = 0;

    return result;
  } catch (err) {
    row.failures += 1;
    row.consecutiveFailures += 1;
    row.lastLatencyMs = Date.now() - startedAt;
    row.lastFailureAt = Date.now();
    row.lastError = err?.message || String(err);

    if (row.consecutiveFailures >= maxConsecutiveFailures) {
      row.circuitUntil = Date.now() + circuitMs;

      recordHardeningEvent("model_circuit_trip", {
        operation: row.operation,
        provider: row.provider,
        model: row.model,
        consecutiveFailures: row.consecutiveFailures,
        circuitMs,
        error: row.lastError,
      });
    } else {
      recordHardeningEvent("model_failure", {
        operation: row.operation,
        provider: row.provider,
        model: row.model,
        consecutiveFailures: row.consecutiveFailures,
        error: row.lastError,
      });
    }

    throw err;
  } finally {
    row.inflight = Math.max(0, Number(row.inflight || 1) - 1);
    scheduleFlush();
  }
}

function routeSummary(limit = 25) {
  return [...ROUTE_STATS.values()]
    .map((row) => {
      const samples = Array.isArray(row.samples) ? [...row.samples].sort((a, b) => a - b) : [];
      const p95 =
        samples.length > 0
          ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
          : 0;

      return {
        route: row.route,
        method: row.method,
        count: Number(row.count || 0),
        errorCount: Number(row.errorCount || 0),
        slowCount: Number(row.slowCount || 0),
        avgMs: round2(row.avgMs || 0),
        p95Ms: round2(p95 || 0),
        maxMs: Number(row.maxMs || 0),
        lastStatusCode: Number(row.lastStatusCode || 0),
        lastSeenAt: Number(row.lastSeenAt || 0) || null,
      };
    })
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, limit);
}

function modelSummary(limit = 20) {
  return [...MODEL_STATS.values()]
    .map((row) => ({
      operation: row.operation,
      provider: row.provider,
      model: row.model,
      inflight: Number(row.inflight || 0),
      successes: Number(row.successes || 0),
      failures: Number(row.failures || 0),
      consecutiveFailures: Number(row.consecutiveFailures || 0),
      circuitOpen: Number(row.circuitUntil || 0) > Date.now(),
      circuitUntil: Number(row.circuitUntil || 0) || null,
      lastLatencyMs: Number(row.lastLatencyMs || 0) || null,
      lastSuccessAt: Number(row.lastSuccessAt || 0) || null,
      lastFailureAt: Number(row.lastFailureAt || 0) || null,
      lastError: row.lastError || null,
    }))
    .sort(
      (a, b) =>
        Number(b.failures || 0) - Number(a.failures || 0) ||
        Number(b.successes || 0) - Number(a.successes || 0)
    )
    .slice(0, limit);
}

function securitySummary(limit = 25) {
  return [...SECURITY_STATS.values()]
    .map((row) => ({
      fingerprint: row.fingerprint,
      riskScore: Number(row.riskScore || 0),
      blocked: Number(row.blockedUntil || 0) > Date.now(),
      blockedUntil: Number(row.blockedUntil || 0) || null,
      minuteHits: Array.isArray(row.minuteHits) ? row.minuteHits.length : 0,
      hourHits: Array.isArray(row.hourHits) ? row.hourHits.length : 0,
      lastSeenAt: Number(row.lastSeenAt || 0) || null,
      lastReason: row.lastReason || null,
      recentKinds: row.recentKinds || {},
      lastIp: row.lastIp || null,
      lastUserAgent: row.lastUserAgent || null,
    }))
    .sort((a, b) => Number(b.riskScore || 0) - Number(a.riskScore || 0))
    .slice(0, limit);
}

export function getHardeningStats() {
  return {
    root: ROOT,
    strictMode: STRICT_MODE,
    routeCount: ROUTE_STATS.size,
    modelOps: MODEL_STATS.size,
    securityFingerprints: SECURITY_STATS.size,
    recentEvents: RECENT_EVENTS.length,
    backupSnapshots: BACKUP_INDEX.length,
  };
}

export function getHardeningDebugSnapshot(limit = 25) {
  return {
    stats: getHardeningStats(),
    routes: routeSummary(limit),
    models: modelSummary(limit),
    security: securitySummary(limit),
    backups: BACKUP_INDEX.slice(0, limit),
    recentEvents: RECENT_EVENTS.slice(0, limit),
  };
}

async function pruneOldBackups() {
  if (BACKUP_INDEX.length <= BACKUP_KEEP) return;

  const extra = BACKUP_INDEX.slice(BACKUP_KEEP);
  BACKUP_INDEX = BACKUP_INDEX.slice(0, BACKUP_KEEP);

  for (const row of extra) {
    const dir = row?.dir ? path.resolve(row.dir) : null;
    if (!dir) continue;

    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn("backup prune failed", err?.message || err);
    }
  }
}

export async function createBackupSnapshot({ label = "manual", roots = [] } = {}) {
  await ensureReady();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = safeStr(label, 40).replace(/[^a-zA-Z0-9_-]/g, "_") || "manual";
  const snapshotId = `${stamp}-${safeLabel}`;
  const snapshotDir = path.join(BACKUP_DIR, snapshotId);

  await ensureDir(snapshotDir);

  const manifest = {
    id: snapshotId,
    label: safeLabel,
    createdAt: Date.now(),
    dir: snapshotDir,
    items: [],
  };

  const uniqueRoots = [...new Set((Array.isArray(roots) ? roots : []).map((x) => String(x)))];

  for (const root of uniqueRoots) {
    const abs = path.resolve(root);
    if (!existsSync(abs)) continue;

    const name = path.basename(abs);
    const dest = path.join(snapshotDir, name);

    try {
      await fs.cp(abs, dest, {
        recursive: true,
        force: true,
      });

      manifest.items.push({
        root: abs,
        name,
        copiedAt: Date.now(),
      });
    } catch (err) {
      manifest.items.push({
        root: abs,
        name,
        copiedAt: Date.now(),
        error: err?.message || String(err),
      });
    }
  }

  await writeJson(path.join(snapshotDir, "manifest.json"), manifest);

  const indexRow = {
    id: manifest.id,
    label: manifest.label,
    createdAt: manifest.createdAt,
    dir: manifest.dir,
    itemCount: manifest.items.length,
    items: manifest.items,
  };

  BACKUP_INDEX.unshift(indexRow);
  await pruneOldBackups();

  recordHardeningEvent("backup_created", {
    id: manifest.id,
    label: manifest.label,
    itemCount: manifest.items.length,
  });

  scheduleFlush();
  return indexRow;
}

export async function listBackupSnapshots(limit = 20) {
  await ensureReady();
  return BACKUP_INDEX.slice(0, Math.max(1, Number(limit || 20)));
}

export function startBackupLoop(roots = [], intervalMs = null) {
  if (BACKUP_LOOP_STARTED) return;

  BACKUP_LOOP_STARTED = true;

  const ms = Math.max(
    15 * 60 * 1000,
    Number(intervalMs || process.env.HARDENING_BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000)
  );

  const timer = setInterval(() => {
    createBackupSnapshot({
      label: "auto",
      roots,
    }).catch((err) => {
      console.warn("automatic backup failed", err?.message || err);
      recordHardeningEvent("backup_failed", {
        error: err?.message || String(err),
      });
    });
  }, ms);

  timer.unref?.();
}

export async function initializeHardeningLayer() {
  await ensureReady();
  scheduleFlush();
  return getHardeningStats();
}
