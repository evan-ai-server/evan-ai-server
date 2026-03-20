import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = path.resolve(process.env.GLOBAL_SCALE_ROOT || "./storage/global-scale");
const STATE_DIR = path.join(ROOT, "state");
const REPLICA_DIR = path.join(ROOT, "replicas");

const CONFIG_FILE = path.join(STATE_DIR, "config.json");
const HEALTH_FILE = path.join(STATE_DIR, "health.json");
const REPLICATION_FILE = path.join(STATE_DIR, "replication.json");

const parseRegions = () => {
  const raw = String(
    process.env.GLOBAL_REGIONS || "us-east-1,us-central-1,us-west-2,eu-west-1"
  );

  const items = raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return items.length ? [...new Set(items)] : ["us-east-1"];
};

const REGIONS = parseRegions();
const PRIMARY_REGION =
  process.env.GLOBAL_PRIMARY_REGION && REGIONS.includes(process.env.GLOBAL_PRIMARY_REGION)
    ? process.env.GLOBAL_PRIMARY_REGION
    : REGIONS[0];

const CURRENT_REGION =
  process.env.GLOBAL_CURRENT_REGION && REGIONS.includes(process.env.GLOBAL_CURRENT_REGION)
    ? process.env.GLOBAL_CURRENT_REGION
    : PRIMARY_REGION;

const FAILOVER_THRESHOLD = Math.max(
  35,
  Number(process.env.GLOBAL_FAILOVER_THRESHOLD || 55)
);

const FAILOVER_MIN_DELTA = Math.max(
  4,
  Number(process.env.GLOBAL_FAILOVER_MIN_DELTA || 8)
);

const REPLICATION_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.GLOBAL_REPLICATION_INTERVAL_MS || 15 * 60 * 1000)
);

const RESILIENCE_INTERVAL_MS = Math.max(
  15_000,
  Number(process.env.GLOBAL_RESILIENCE_INTERVAL_MS || 30_000)
);

const HEALTH_WINDOW_MS = 15 * 60 * 1000;
const REPLICATION_KEEP = Math.max(
  8,
  Number(process.env.GLOBAL_REPLICATION_KEEP || 30)
);

let READY = false;
let READY_PROMISE = null;
let FLUSH_TIMER = null;
let REPLICATION_LOOP_STARTED = false;
let RESILIENCE_LOOP_STARTED = false;

const REGION_STATS = new Map();
let REPLICATION_INDEX = [];

let GLOBAL_CONFIG = {
  regions: [...REGIONS],
  primaryRegion: PRIMARY_REGION,
  currentRegion: CURRENT_REGION,
  activeRegion: PRIMARY_REGION,
  lastFailoverAt: 0,
  failoverCount: 0,
  replicationCount: 0,
};

function round2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function safeStr(value = "", max = 180) {
  return String(value || "").trim().slice(0, max);
}

function sha(value = "") {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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

function regionRow(region) {
  if (!REGION_STATS.has(region)) {
    REGION_STATS.set(region, {
      region,
      requests: 0,
      errors: 0,
      slow: 0,
      status: region === CURRENT_REGION ? "healthy" : "standby",
      healthScore: region === CURRENT_REGION ? 100 : 96,
      lastSeenAt: 0,
      lastSuccessAt: 0,
      lastFailureAt: 0,
      recentSamples: [],
      replicationLagMs: null,
      lastReplicationAt: 0,
      lastReplicationId: null,
    });
  }

  return REGION_STATS.get(region);
}

function hydrateAllRegions() {
  for (const region of GLOBAL_CONFIG.regions || REGIONS) {
    regionRow(region);
  }
}

function pruneSamples(row) {
  const now = Date.now();
  row.recentSamples = (Array.isArray(row.recentSamples) ? row.recentSamples : []).filter(
    (x) => now - Number(x?.ts || 0) < HEALTH_WINDOW_MS
  );
  return row;
}

function recomputeRegionHealth(row) {
  pruneSamples(row);

  const samples = Array.isArray(row.recentSamples) ? row.recentSamples : [];
  const total = samples.length;
  const errors = samples.filter((x) => Number(x?.statusCode || 0) >= 500).length;
  const slow = samples.filter((x) => Number(x?.durationMs || 0) >= 4000).length;

  let health = 100;

  if (total > 0) {
    const errorRatio = errors / total;
    const slowRatio = slow / total;

    health -= errorRatio * 72;
    health -= slowRatio * 20;
  } else {
    health -= row.region === CURRENT_REGION ? 0 : 2;
  }

  if (row.region !== CURRENT_REGION) {
    health -= 1;
  }

  if (Number(row.replicationLagMs || 0) > 30 * 60 * 1000) {
    health -= 8;
  } else if (Number(row.replicationLagMs || 0) > 10 * 60 * 1000) {
    health -= 4;
  }

  health = Math.max(0, Math.min(100, round2(health) || 0));
  row.healthScore = health;

  row.status =
    health >= 82
      ? row.region === GLOBAL_CONFIG.activeRegion
        ? "healthy"
        : "standby"
      : health >= FAILOVER_THRESHOLD
      ? "degraded"
      : "critical";

  return row;
}

function regionSummary(limit = 20) {
  return [...REGION_STATS.values()]
    .map((row) => {
      recomputeRegionHealth(row);

      const samples = Array.isArray(row.recentSamples) ? row.recentSamples : [];
      const total = samples.length;
      const errors = samples.filter((x) => Number(x?.statusCode || 0) >= 500).length;
      const slow = samples.filter((x) => Number(x?.durationMs || 0) >= 4000).length;

      return {
        region: row.region,
        status: row.status,
        healthScore: Number(row.healthScore || 0),
        active: row.region === GLOBAL_CONFIG.activeRegion,
        current: row.region === CURRENT_REGION,
        requests: Number(row.requests || 0),
        errors: Number(row.errors || 0),
        slow: Number(row.slow || 0),
        windowSamples: total,
        windowErrors: errors,
        windowSlow: slow,
        lastSeenAt: Number(row.lastSeenAt || 0) || null,
        lastSuccessAt: Number(row.lastSuccessAt || 0) || null,
        lastFailureAt: Number(row.lastFailureAt || 0) || null,
        replicationLagMs: Number(row.replicationLagMs || 0) || null,
        lastReplicationAt: Number(row.lastReplicationAt || 0) || null,
        lastReplicationId: row.lastReplicationId || null,
      };
    })
    .sort((a, b) => Number(b.healthScore || 0) - Number(a.healthScore || 0))
    .slice(0, limit);
}

function scheduleFlush() {
  if (FLUSH_TIMER) return;

  FLUSH_TIMER = setTimeout(async () => {
    FLUSH_TIMER = null;

    try {
      await Promise.all([
        writeJson(CONFIG_FILE, GLOBAL_CONFIG),
        writeJson(HEALTH_FILE, regionSummary(100)),
        writeJson(REPLICATION_FILE, REPLICATION_INDEX),
      ]);
    } catch (err) {
      console.warn("global scale flush failed", err?.message || err);
    }
  }, 1000);

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
      ensureDir(STATE_DIR),
      ensureDir(REPLICA_DIR),
    ]);

    const [savedConfig, savedHealth, savedReplication] = await Promise.all([
      readJson(CONFIG_FILE, null),
      readJson(HEALTH_FILE, []),
      readJson(REPLICATION_FILE, []),
    ]);

    if (savedConfig && typeof savedConfig === "object") {
      GLOBAL_CONFIG = {
        ...GLOBAL_CONFIG,
        ...savedConfig,
        regions: [...new Set([...(savedConfig.regions || []), ...REGIONS])],
        currentRegion: CURRENT_REGION,
        primaryRegion: PRIMARY_REGION,
      };
    }

    hydrateAllRegions();

    for (const row of Array.isArray(savedHealth) ? savedHealth : []) {
      if (!row?.region) continue;

      const target = regionRow(row.region);
      Object.assign(target, {
        ...target,
        ...row,
        recentSamples: [],
      });
    }

    REPLICATION_INDEX = Array.isArray(savedReplication) ? savedReplication : [];

    if (!GLOBAL_CONFIG.activeRegion || !REGIONS.includes(GLOBAL_CONFIG.activeRegion)) {
      GLOBAL_CONFIG.activeRegion = PRIMARY_REGION;
    }

    READY = true;
  })();

  try {
    await READY_PROMISE;
  } finally {
    READY_PROMISE = null;
  }
}

function bestRegionCandidate() {
  hydrateAllRegions();

  const rows = [...REGION_STATS.values()].map((row) => recomputeRegionHealth(row));
  rows.sort((a, b) => Number(b.healthScore || 0) - Number(a.healthScore || 0));

  return rows[0] || regionRow(PRIMARY_REGION);
}

export function getGlobalHealthSnapshot() {
  hydrateAllRegions();

  const active = regionRow(GLOBAL_CONFIG.activeRegion || PRIMARY_REGION);
  recomputeRegionHealth(active);

  return {
    currentRegion: CURRENT_REGION,
    primaryRegion: PRIMARY_REGION,
    activeRegion: GLOBAL_CONFIG.activeRegion,
    activeRegionStatus: active.status,
    activeRegionHealthScore: active.healthScore,
    failoverCount: Number(GLOBAL_CONFIG.failoverCount || 0),
    lastFailoverAt: Number(GLOBAL_CONFIG.lastFailoverAt || 0) || null,
    regions: regionSummary(20),
  };
}

export function getGlobalScaleStats() {
  return {
    root: ROOT,
    currentRegion: CURRENT_REGION,
    primaryRegion: PRIMARY_REGION,
    activeRegion: GLOBAL_CONFIG.activeRegion,
    regionCount: GLOBAL_CONFIG.regions.length,
    failoverCount: Number(GLOBAL_CONFIG.failoverCount || 0),
    replicationCount: Number(GLOBAL_CONFIG.replicationCount || 0),
    replicationSnapshots: REPLICATION_INDEX.length,
  };
}

export function getGlobalScaleDebugSnapshot(limit = 20) {
  return {
    stats: getGlobalScaleStats(),
    health: getGlobalHealthSnapshot(),
    replications: REPLICATION_INDEX.slice(0, Math.max(1, Number(limit || 20))),
  };
}

export function buildGlobalScaleMiddleware() {
  return (req, res, next) => {
    void ensureReady();

    const snapshot = getGlobalHealthSnapshot();

    res.setHeader("x-evan-region", snapshot.currentRegion);
    res.setHeader("x-evan-active-region", snapshot.activeRegion);
    res.setHeader("x-evan-region-status", snapshot.activeRegionStatus);
    res.setHeader(
      "x-evan-region-role",
      snapshot.currentRegion === snapshot.activeRegion ? "active" : "standby"
    );

    req.globalScale = {
      currentRegion: snapshot.currentRegion,
      activeRegion: snapshot.activeRegion,
      activeRegionStatus: snapshot.activeRegionStatus,
    };

    next();
  };
}

export function recordGlobalRequestObservation({
  route = "",
  method = "",
  statusCode = 0,
  durationMs = 0,
} = {}) {
  void ensureReady();

  const row = regionRow(CURRENT_REGION);
  row.requests += 1;

  if (Number(statusCode || 0) >= 500) {
    row.errors += 1;
    row.lastFailureAt = Date.now();
  } else {
    row.lastSuccessAt = Date.now();
  }

  if (Number(durationMs || 0) >= 4000) {
    row.slow += 1;
  }

  row.lastSeenAt = Date.now();
  row.recentSamples.push({
    ts: Date.now(),
    route: safeStr(route, 180),
    method: safeStr(method, 16).toUpperCase(),
    statusCode: Number(statusCode || 0),
    durationMs: Number(durationMs || 0),
  });

  pruneSamples(row);
  recomputeRegionHealth(row);
  scheduleFlush();
}

export async function setActiveRegion(region, reason = "manual") {
  await ensureReady();

  const target = safeStr(region, 60);
  if (!target || !GLOBAL_CONFIG.regions.includes(target)) {
    throw new Error("invalid_region");
  }

  if (GLOBAL_CONFIG.activeRegion === target) {
    return getGlobalHealthSnapshot();
  }

  GLOBAL_CONFIG.activeRegion = target;
  GLOBAL_CONFIG.lastFailoverAt = Date.now();
  GLOBAL_CONFIG.failoverCount = Number(GLOBAL_CONFIG.failoverCount || 0) + 1;

  const row = regionRow(target);
  recomputeRegionHealth(row);

  scheduleFlush();

  return getGlobalHealthSnapshot();
}

async function pruneOldReplications() {
  if (REPLICATION_INDEX.length <= REPLICATION_KEEP) return;

  const extra = REPLICATION_INDEX.slice(REPLICATION_KEEP);
  REPLICATION_INDEX = REPLICATION_INDEX.slice(0, REPLICATION_KEEP);

  for (const row of extra) {
    const dir = row?.dir ? path.resolve(row.dir) : null;
    if (!dir) continue;

    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn("replication prune failed", err?.message || err);
    }
  }
}

export async function replicateGlobalState({ label = "manual", roots = [] } = {}) {
  await ensureReady();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeLabel = safeStr(label, 40).replace(/[^a-zA-Z0-9_-]/g, "_") || "manual";
  const replicationId = `${stamp}-${safeLabel}`;

  const targets = GLOBAL_CONFIG.regions.filter((r) => r !== CURRENT_REGION);

  const uniqueRoots = [...new Set((Array.isArray(roots) ? roots : []).map((x) => String(x)))];
  const manifestRows = [];

  for (const targetRegion of targets) {
    const targetDir = path.join(REPLICA_DIR, targetRegion, replicationId);
    await ensureDir(targetDir);

    const manifest = {
      id: replicationId,
      label: safeLabel,
      targetRegion,
      sourceRegion: CURRENT_REGION,
      createdAt: Date.now(),
      items: [],
    };

    for (const root of uniqueRoots) {
      const abs = path.resolve(root);
      if (!existsSync(abs)) continue;

      const name = path.basename(abs);
      const dest = path.join(targetDir, name);

      try {
        await fs.cp(abs, dest, { recursive: true, force: true });
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

    await writeJson(path.join(targetDir, "manifest.json"), manifest);

    const row = regionRow(targetRegion);
    row.lastReplicationAt = Date.now();
    row.replicationLagMs = 0;
    row.lastReplicationId = replicationId;

    const indexRow = {
      id: `${replicationId}:${targetRegion}`,
      replicationId,
      label: safeLabel,
      dir: targetDir,
      targetRegion,
      sourceRegion: CURRENT_REGION,
      createdAt: Date.now(),
      itemCount: manifest.items.length,
      items: manifest.items,
    };

    REPLICATION_INDEX.unshift(indexRow);
    manifestRows.push(indexRow);
  }

  GLOBAL_CONFIG.replicationCount = Number(GLOBAL_CONFIG.replicationCount || 0) + 1;

  await pruneOldReplications();
  scheduleFlush();

  return manifestRows;
}

export async function listReplicationSnapshots(limit = 20) {
  await ensureReady();
  return REPLICATION_INDEX.slice(0, Math.max(1, Number(limit || 20)));
}

function autoFailoverIfNeeded() {
  hydrateAllRegions();

  const active = regionRow(GLOBAL_CONFIG.activeRegion || PRIMARY_REGION);
  recomputeRegionHealth(active);

  const candidate = bestRegionCandidate();
  if (!candidate) return;

  const activeScore = Number(active.healthScore || 0);
  const candidateScore = Number(candidate.healthScore || 0);

  if (
    candidate.region !== active.region &&
    activeScore < FAILOVER_THRESHOLD &&
    candidateScore >= activeScore + FAILOVER_MIN_DELTA
  ) {
    GLOBAL_CONFIG.activeRegion = candidate.region;
    GLOBAL_CONFIG.lastFailoverAt = Date.now();
    GLOBAL_CONFIG.failoverCount = Number(GLOBAL_CONFIG.failoverCount || 0) + 1;
    scheduleFlush();
  }
}

export function startGlobalResilienceLoop() {
  if (RESILIENCE_LOOP_STARTED) return;
  RESILIENCE_LOOP_STARTED = true;

  const timer = setInterval(() => {
    try {
      hydrateAllRegions();

      for (const row of REGION_STATS.values()) {
        pruneSamples(row);
        recomputeRegionHealth(row);

        if (
          row.region !== CURRENT_REGION &&
          Number(row.lastReplicationAt || 0) > 0
        ) {
          row.replicationLagMs = Math.max(0, Date.now() - Number(row.lastReplicationAt || 0));
        }
      }

      autoFailoverIfNeeded();
      scheduleFlush();
    } catch (err) {
      console.warn("global resilience loop failed", err?.message || err);
    }
  }, RESILIENCE_INTERVAL_MS);

  timer.unref?.();
}

export function startGlobalReplicationLoop(roots = []) {
  if (REPLICATION_LOOP_STARTED) return;
  REPLICATION_LOOP_STARTED = true;

  const timer = setInterval(() => {
    replicateGlobalState({
      label: "auto",
      roots,
    }).catch((err) => {
      console.warn("global replication failed", err?.message || err);
    });
  }, REPLICATION_INTERVAL_MS);

  timer.unref?.();
}

export async function initializeGlobalScaleLayer() {
  await ensureReady();
  hydrateAllRegions();
  scheduleFlush();
  return getGlobalScaleStats();
}
