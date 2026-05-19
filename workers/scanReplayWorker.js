// workers/scanReplayWorker.js
// Scan Replay Worker — re-queries market data for saved scans to detect price drift.
// Compares current market signal against original signal at scan time.
// If verdict changed (STRONG BUY → FAIR, etc.) → surface in daily feed as RESCAN card.
//
// Queue name: "scan-replay"
// Job: { userId, scanId, originalSignal, query, category }

import { Worker, Queue } from "bullmq";

const QUEUE_NAME  = "scan-replay";
const CONCURRENCY = 3;
const REPLAY_TTL  = 72 * 3600 * 1000; // don't replay scans older than 72h

let _queue = null;

export function getScanReplayQueue(redisConnection) {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, { connection: redisConnection });
  }
  return _queue;
}

/**
 * Enqueue a single scan for replay.
 * Called from /watch/refresh/enqueue or from the discovery engine.
 */
export async function enqueueScanReplay(redisConnection, {
  userId,
  scanId,
  originalSignal,
  query,
  category,
  scannedAt,
}) {
  const age = Date.now() - (scannedAt || 0);
  if (age > REPLAY_TTL) return; // stale — skip

  const q = getScanReplayQueue(redisConnection);
  await q.add("replay-scan", {
    userId, scanId, originalSignal, query, category, scannedAt,
  }, {
    jobId:    `replay-${scanId}`,       // deduplicates per scan
    attempts: 2,
    backoff:  { type: "fixed", delay: 10000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 50 },
  });
}

/**
 * Enqueue all active watched items for a user.
 * Called nightly from the watchlist refresh cron.
 */
export async function enqueueWatchlistReplay(redisConnection, watchlistItems = []) {
  const q = getScanReplayQueue(redisConnection);
  const jobs = watchlistItems
    .filter((w) => w.is_active && w.query)
    .map((w) => ({
      name: "replay-scan",
      data: {
        userId:         w.user_id,
        scanId:         w.scan_id || w.watch_id,
        originalSignal: null,    // watchlist: compare against target_price, not original signal
        query:          w.query,
        category:       w.category,
        targetPrice:    w.target_price,
        addedPrice:     w.added_price,
        watchId:        w.watch_id,
      },
      opts: {
        jobId:    `replay-watch-${w.watch_id}`,
        attempts: 2,
        removeOnComplete: { count: 200 },
        removeOnFail:     { count: 50 },
      },
    }));

  if (jobs.length) await q.addBulk(jobs);
  return jobs.length;
}

// ── Worker ────────────────────────────────────────────────────────────────────

export function startScanReplayWorker({ redisConnection, redis, assembleProfitIntel }) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const {
        userId, scanId, originalSignal, query, category,
        targetPrice, addedPrice, watchId,
      } = job.data;

      if (!query || !userId) return;

      // Re-run the market query pipeline (simplified — uses same core as /market/search)
      // This is intentionally kept thin: just enough to detect verdict drift.
      // Full vision re-processing would be wasteful; we only re-query market data.
      const fresh = await assembleProfitIntel({
        query,
        category,
        // No vision identity — we're re-querying price only
        visionIdentity: null,
        confidenceV2:   0.75,  // assume prior identity was correct
      }).catch(() => null);

      if (!fresh) return;

      const currentSignal = fresh.buySignal;
      const currentPrice  = fresh.priceStats?.median;
      const verdictChanged = originalSignal && currentSignal !== originalSignal;

      // Store drift in Redis for daily feed consumption
      const driftKey  = `scan_drift:${userId}`;
      const driftData = JSON.stringify({
        scanId:           scanId || watchId,
        watchId:          watchId || null,
        query,
        category,
        originalSignal,
        currentSignal,
        currentPrice,
        verdictChanged,
        verdictDelta:     verdictChanged ? `${originalSignal} → ${currentSignal}` : null,
        currentReasoning: fresh.reasoning || null,
        checkedAt:        Date.now(),
      });

      // Push to per-user drift ZSET, keyed by scanId, scored by checkedAt
      if (redis) {
        await redis.zadd(driftKey, Date.now(), driftData);
        await redis.zremrangebyrank(driftKey, 0, -51); // keep latest 50
        await redis.expire(driftKey, 7 * 86400);       // 7 days
      }

      // Watchlist-specific: check if target_price was hit
      if (watchId && targetPrice != null && currentPrice != null) {
        const targetHit = currentPrice <= targetPrice;
        const dropPct   = addedPrice && currentPrice < addedPrice
          ? Math.round(((addedPrice - currentPrice) / addedPrice) * 100)
          : 0;

        if (targetHit || dropPct >= 10) {
          const alertData = JSON.stringify({
            watchId,
            alertType:    targetHit ? "target_hit" : "significant_drop",
            currentPrice,
            targetPrice,
            addedPrice,
            dropPct,
            query,
            category,
            priority:     targetHit ? "HIGH" : "MEDIUM",
            reason:       targetHit
              ? `Hit $${currentPrice?.toFixed(2)} — at or below your $${targetPrice?.toFixed(2)} target`
              : `Down ${dropPct}% from $${addedPrice?.toFixed(2)} when you saved this`,
            triggeredAt:  Date.now(),
          });

          const alertKey = `watchlist_alerts:${userId}`;
          await redis.zadd(alertKey, Date.now(), alertData);
          await redis.zremrangebyrank(alertKey, 0, -26);
          await redis.expire(alertKey, 7 * 86400);
        }
      }
    },
    { connection: redisConnection, concurrency: CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.log(`[ScanReplayWorker] ✓ replay-${job.data?.scanId} (${job.id})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[ScanReplayWorker] ✗ ${job?.id}: ${err.message}`);
  });

  return worker;
}
