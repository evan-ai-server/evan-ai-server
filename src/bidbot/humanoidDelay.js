/**
 * humanoidDelay.js — Gaussian-distributed human timing simulation
 *
 * Most bots use setTimeout(1000). Platform anti-bot systems fingerprint
 * the distribution of inter-request delays. Uniform or constant delays
 * fail a chi-squared test in < 50 requests.
 *
 * This module uses the Box-Muller transform to generate delays drawn from
 * a normal distribution matching empirical human mobile response latencies:
 *   μ = 3,400ms (median "sees deal → taps confirm" time)
 *   σ = 1,100ms (natural variance)
 *   Clamped to [MIN_MS, MAX_MS] to avoid extreme outliers
 *
 * Additionally, a small "fat tail" event (10% probability) simulates a user
 * who hesitates (re-reads the listing, checks their wallet), adding 2–6s.
 */

const MEAN_MS   = 3_400;   // μ
const SIGMA_MS  = 1_100;   // σ
const MIN_MS    =   900;   // hard floor — no human responds in < 900ms
const MAX_MS    = 8_200;   // hard ceiling — beyond this, most offers expire
const FAT_TAIL_PROB     = 0.10; // 10% chance of a "hesitation" event
const FAT_TAIL_MIN_MS   = 2_000;
const FAT_TAIL_MAX_MS   = 6_000;

/**
 * Box-Muller transform: maps two uniform random values → standard normal.
 * Returns a value drawn from N(0, 1).
 */
function gaussianSample() {
  let u1, u2;
  // Avoid log(0) — resample if u1 is exactly 0
  do {
    u1 = Math.random();
    u2 = Math.random();
  } while (u1 === 0);

  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Returns a delay in milliseconds drawn from the humanoid distribution.
 * Does NOT await — just computes the value. Call `await humanoidDelay()` to sleep.
 *
 * @param {{ mean?: number, sigma?: number }} [opts]
 * @returns {number} ms
 */
export function sampleDelay(opts = {}) {
  const mean  = opts.mean  ?? MEAN_MS;
  const sigma = opts.sigma ?? SIGMA_MS;

  // Primary Gaussian sample
  let delay = mean + gaussianSample() * sigma;
  delay = Math.max(MIN_MS, Math.min(MAX_MS, delay));

  // Fat-tail hesitation event
  if (Math.random() < FAT_TAIL_PROB) {
    delay += FAT_TAIL_MIN_MS + Math.random() * (FAT_TAIL_MAX_MS - FAT_TAIL_MIN_MS);
    delay = Math.min(delay, MAX_MS + FAT_TAIL_MAX_MS); // allow ceiling breach on hesitation
  }

  return Math.round(delay);
}

/**
 * Sleeps for a humanoid delay duration, then resolves.
 *
 * @param {{ mean?: number, sigma?: number }} [opts]
 * @returns {Promise<number>} resolves with actual ms slept
 */
export async function humanoidDelay(opts = {}) {
  const ms = sampleDelay(opts);
  await new Promise((resolve) => setTimeout(resolve, ms));
  return ms;
}

// ─── Micro-jitter ─────────────────────────────────────────────────────────────
/**
 * A smaller jitter (50–350ms) for between-step delays within a single bid flow.
 * Simulates UI animation time, network latency variance, and tap precision.
 */
export async function microJitter() {
  const ms = 50 + Math.random() * 300;
  await new Promise((resolve) => setTimeout(resolve, Math.round(ms)));
  return Math.round(ms);
}

// ─── User-Agent Pool ──────────────────────────────────────────────────────────
/**
 * Rotates through a pool of realistic mobile User-Agent strings.
 * Evan AI presents as a legitimate iOS shopping app, not a headless browser.
 *
 * Strategy:
 *   - Use the platform's own official app UA as a model (eBay, Poshmark)
 *   - Include OS version variance to avoid fingerprinting on a single version
 *   - Rotate deterministically per-session (not per-request) for consistency
 */
const UA_POOL = [
  // eBay iOS app style
  "eBay/6.100.0 (iPhone; iOS 17.4.1; Scale/3.00)",
  "eBay/6.98.0 (iPhone; iOS 17.2; Scale/3.00)",
  "eBay/6.95.0 (iPhone; iOS 16.7.5; Scale/2.00)",
  // Poshmark iOS app style
  "Poshmark/7.29.0 (iPhone; iOS 17.4; CFNetwork/1490.0.4 Darwin/23.3.0)",
  "Poshmark/7.27.1 (iPhone; iOS 16.6; CFNetwork/1410.0.3 Darwin/22.6.0)",
  // Generic iOS WebKit for REST calls (fallback)
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
];

let _uaIndex = Math.floor(Math.random() * UA_POOL.length);

/**
 * Returns the next User-Agent from the pool (round-robin with initial random offset).
 * Call once per session (bid dispatch), not per retry.
 */
export function nextUserAgent() {
  const ua = UA_POOL[_uaIndex % UA_POOL.length];
  _uaIndex++;
  return ua;
}

/**
 * Returns a per-platform UA anchored to the appropriate app.
 * @param {"ebay" | "poshmark" | "default"} platform
 */
export function platformUserAgent(platform) {
  if (platform === "ebay")    return UA_POOL[Math.floor(Math.random() * 3)];
  if (platform === "poshmark") return UA_POOL[3 + Math.floor(Math.random() * 2)];
  return UA_POOL[5 + Math.floor(Math.random() * 2)];
}
