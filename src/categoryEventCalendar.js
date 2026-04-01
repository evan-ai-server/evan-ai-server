// src/categoryEventCalendar.js
// Category Event Calendar — Phase 15: Category Immortality.
//
// Manages two types of market-altering events:
//   1. Static event catalog — known recurring events (releases, restocks, holidays)
//   2. Redis overlay — upcoming/recent events injected by ops or learned from scans
//
// Events affect buy/sell signals:
//   - Pre-release scarcity window  → hold pressure / buy confirmation for resellers
//   - Post-release glut window     → sell pressure / buy price drops
//   - Holiday demand surge         → general premium window
//   - Restock event               → price floor drop, sell if holding
//
// Redis keys:
//   cal:event:{category}:{YYYY-MM}   ZSET  scored by timestamp (90d TTL)
//   cal:event:global:{YYYY-MM}       ZSET  cross-category events (90d TTL)

import { CAT } from "./categoryRegistry.js";

const EVENT_TTL = 90 * 86400; // 90 days

// ── Event types ───────────────────────────────────────────────────────────────

export const EVENT_TYPE = {
  PRODUCT_RELEASE:    "product_release",     // new model drops
  LIMITED_RELEASE:    "limited_release",     // limited edition / collab
  RESTOCK:            "restock",             // supply restock
  DISCONTINUATION:    "discontinuation",     // model killed
  PRICE_DROP:         "price_drop",          // MSRP cut
  HOLIDAY_DEMAND:     "holiday_demand",      // seasonal demand surge
  SET_RELEASE:        "set_release",         // trading card set release
  CHAMPIONSHIP:       "championship",        // sports cards — championship boosts player value
};

// ── Static event catalog ──────────────────────────────────────────────────────
//
// Recurring events keyed by [MM-DD] (month-day, no year).
// At query time, expanded to the nearest occurrence.

const RECURRING_EVENTS = {
  // Global / cross-category
  "11-25": { type: EVENT_TYPE.HOLIDAY_DEMAND, category: null,           name: "Black Friday",       window: 7,  priceEffect: "up",   note: "Consumer demand surge. Best time to sell discretionary items." },
  "12-01": { type: EVENT_TYPE.HOLIDAY_DEMAND, category: null,           name: "Holiday Season",     window: 25, priceEffect: "up",   note: "Peak gifting demand. Hold premiums for desirable items." },
  "12-26": { type: EVENT_TYPE.PRICE_DROP,     category: null,           name: "Post-Christmas",     window: 7,  priceEffect: "down", note: "Supply flood post-holiday. Expect 5–15% softening." },
  "01-01": { type: EVENT_TYPE.PRICE_DROP,     category: null,           name: "January Softening",  window: 14, priceEffect: "down", note: "Post-holiday liquidation depresses secondary market." },
  "02-14": { type: EVENT_TYPE.HOLIDAY_DEMAND, category: null,           name: "Valentine's Day",    window: 5,  priceEffect: "up",   note: "Jewelry, watches, bags see demand uptick." },
  // Sneakers
  "04-01": { type: EVENT_TYPE.HOLIDAY_DEMAND, category: CAT.SNEAKERS,   name: "Spring Drop Season", window: 30, priceEffect: "up",   note: "Spring sneaker drops typically start April." },
  "08-01": { type: EVENT_TYPE.HOLIDAY_DEMAND, category: CAT.SNEAKERS,   name: "Back to School",     window: 31, priceEffect: "up",   note: "August is peak back-to-school sneaker demand." },
  "12-15": { type: EVENT_TYPE.LIMITED_RELEASE,category: CAT.SNEAKERS,   name: "Holiday Drops",      window: 14, priceEffect: "up",   note: "Major brands drop holiday-exclusive colorways." },
  // Electronics
  "09-01": { type: EVENT_TYPE.PRODUCT_RELEASE, category: CAT.ELECTRONICS, name: "Apple Event Season", window: 30, priceEffect: "down", note: "iPhone/Apple Watch announcements depress prior-gen pricing." },
  "03-01": { type: EVENT_TYPE.PRODUCT_RELEASE, category: CAT.ELECTRONICS, name: "Samsung Galaxy Season", window: 30, priceEffect: "down", note: "Galaxy S series announcements depress prior-gen Galaxy pricing." },
  // Watches — Baselworld/Watches & Wonders (late March)
  "03-25": { type: EVENT_TYPE.PRODUCT_RELEASE, category: CAT.WATCHES,   name: "Watches & Wonders",  window: 7,  priceEffect: "up",   note: "New model announcements. Discontinued references spike." },
  // Trading cards — Pokémon set releases (variable; use overlays for exact dates)
  "06-01": { type: EVENT_TYPE.SET_RELEASE,    category: CAT.TRADING_CARDS, name: "Summer TCG Releases", window: 14, priceEffect: "down", note: "New set releases flood the market with new chase cards." },
  "11-01": { type: EVENT_TYPE.SET_RELEASE,    category: CAT.TRADING_CARDS, name: "Holiday TCG Releases", window: 14, priceEffect: "down", note: "Pre-holiday set drops often suppress older card values." },
};

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayUTC() {
  return new Date();
}

function mmdd(date) {
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${m}-${d}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function yearMonthKey(date) {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

// ── Static event lookup ───────────────────────────────────────────────────────

/**
 * Get static recurring events active within ±windowDays of today.
 * Filters by category (null matches global events).
 *
 * @param {string|null} canonicalCategory
 * @param {number} [lookAheadDays=14]  — how far ahead to look for upcoming events
 * @param {number} [lookBehindDays=7]  — how far back to include recent events
 * @returns {object[]} array of active event objects
 */
export function getActiveStaticEvents(canonicalCategory = null, lookAheadDays = 14, lookBehindDays = 7) {
  const now    = todayUTC();
  const active = [];

  for (const [key, event] of Object.entries(RECURRING_EVENTS)) {
    // Only include events for this category or global events (null)
    if (event.category !== null && event.category !== canonicalCategory) continue;

    const [mm, dd] = key.split("-").map(Number);

    // Check this year and next (in case we're near year-end)
    for (const year of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const eventStart = new Date(Date.UTC(year, mm - 1, dd));
      const eventEnd   = addDays(eventStart, event.window);

      // Is today within [eventStart - lookBehindDays, eventEnd + lookAheadDays]?
      const windowStart = addDays(eventStart, -lookBehindDays);
      const windowEnd   = addDays(eventEnd, lookAheadDays);

      if (now >= windowStart && now <= windowEnd) {
        const daysUntilStart = Math.round((eventStart - now) / 86400000);
        const isActive       = now >= eventStart && now <= eventEnd;
        const isUpcoming     = daysUntilStart > 0;
        const isRecent       = now > eventEnd;

        active.push({
          ...event,
          eventDate:      eventStart.toISOString().slice(0, 10),
          eventEndDate:   eventEnd.toISOString().slice(0, 10),
          daysUntilStart,
          isActive,
          isUpcoming,
          isRecent,
        });
        break; // only one occurrence per year per event
      }
    }
  }

  return active;
}

// ── Redis overlay ─────────────────────────────────────────────────────────────

function calKey(category, ym) {
  const cat = category || "global";
  return `cal:event:${cat}:${ym}`;
}

/**
 * Store a custom/ops-injected event in Redis.
 * Events are stored in ZSET scored by timestamp.
 *
 * @param {object} redis
 * @param {object} event — { type, category, name, eventDate, window, priceEffect, note }
 */
export async function storeCalendarEvent(redis, event) {
  if (!redis || !event?.eventDate) return;
  try {
    const d   = new Date(event.eventDate);
    const ym  = yearMonthKey(d);
    const key = calKey(event.category || null, ym);
    await redis.zadd(key, d.getTime(), JSON.stringify(event));
    await redis.expire(key, EVENT_TTL);
  } catch { /* non-fatal */ }
}

/**
 * Get Redis overlay events for a category within a date range.
 *
 * @param {object} redis
 * @param {string|null} canonicalCategory
 * @param {number} [lookAheadDays=14]
 * @returns {object[]}
 */
export async function getCalendarOverlayEvents(redis, canonicalCategory = null, lookAheadDays = 14) {
  if (!redis) return [];
  try {
    const now   = todayUTC();
    const future = addDays(now, lookAheadDays);
    const months  = [yearMonthKey(now), yearMonthKey(future)];
    const keys    = [...new Set([
      calKey(canonicalCategory, months[0]),
      calKey(canonicalCategory, months[1]),
      calKey(null, months[0]),
      calKey(null, months[1]),
    ])];

    const results = await Promise.all(
      keys.map((k) => redis.zrangebyscore(k, now.getTime() - 7 * 86400000, future.getTime()).catch(() => []))
    );

    return results.flat()
      .map((r) => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ── Composite query ───────────────────────────────────────────────────────────

/**
 * Get all calendar context (static + overlay) for a category.
 * Returns a CalendarContext object:
 *   { activeEvents, upcomingEvents, recentEvents, marketPressure, contextNote }
 *
 * marketPressure: "buy" | "sell" | "hold" | "neutral"
 * contextNote: human-readable summary of active signals
 *
 * @param {object|null} redis
 * @param {string|null} canonicalCategory
 */
export async function getCategoryCalendarContext(redis, canonicalCategory = null) {
  const staticEvents  = getActiveStaticEvents(canonicalCategory, 14, 7);
  const overlayEvents = await getCalendarOverlayEvents(redis, canonicalCategory, 14).catch(() => []);

  const allEvents    = [...staticEvents, ...overlayEvents];
  const activeEvents = allEvents.filter((e) => e.isActive || e.isRecent);
  const upcomingEvents = allEvents.filter((e) => e.isUpcoming && !e.isActive);

  // Derive market pressure from active/upcoming events
  let pressure    = "neutral";
  let contextNote = null;

  const upPressure   = allEvents.filter((e) => e.priceEffect === "up"   && (e.isActive || (e.isUpcoming && e.daysUntilStart <= 7)));
  const downPressure = allEvents.filter((e) => e.priceEffect === "down" && (e.isActive || (e.isUpcoming && e.daysUntilStart <= 7)));

  if (upPressure.length > 0 && downPressure.length === 0) {
    pressure    = "buy";  // good time to buy before premium / hold before demand surge
    contextNote = upPressure[0].note;
  } else if (downPressure.length > 0 && upPressure.length === 0) {
    pressure    = "sell"; // sell before price softens
    contextNote = downPressure[0].note;
  } else if (downPressure.length > 0 && upPressure.length > 0) {
    pressure    = "hold";
    contextNote = "Mixed signals — hold until clarity.";
  }

  return {
    activeEvents:  activeEvents.map(summaryEvent),
    upcomingEvents: upcomingEvents.map(summaryEvent),
    marketPressure: pressure,
    contextNote,
    hasCalendarSignal: allEvents.length > 0,
  };
}

function summaryEvent(e) {
  return {
    name:        e.name,
    type:        e.type,
    priceEffect: e.priceEffect,
    eventDate:   e.eventDate,
    daysUntil:   e.daysUntilStart,
    isActive:    e.isActive,
    note:        e.note,
  };
}
