// src/seasonalFlipCalendar.js
// Seasonal flip calendar: month-by-month demand index per category, buy-low
// windows, sell-high windows, and upcoming event-driven demand spikes.
// "Buy Air Max in January (post-holiday dip), sell in April (spring surge)."

// ── Monthly demand index per category (1.0 = average, >1.0 = above average) ──
// Based on observed eBay/StockX/GOAT volume patterns
const MONTHLY_DEMAND = {
  sneakers: [
    { month: 1,  index: 0.72, label: "Jan",  note: "Post-holiday hangover — buyers tapped out" },
    { month: 2,  index: 0.85, label: "Feb",  note: "Valentine's gifting bump, still slow" },
    { month: 3,  index: 1.05, label: "Mar",  note: "Spring drops, tax refund season begins" },
    { month: 4,  index: 1.18, label: "Apr",  note: "Peak tax refund spend — best sell window" },
    { month: 5,  index: 1.12, label: "May",  note: "Mother's Day, Jordan release season" },
    { month: 6,  index: 1.08, label: "Jun",  note: "Graduation gifting, NBA Finals hype" },
    { month: 7,  index: 0.90, label: "Jul",  note: "Summer slowdown — people traveling" },
    { month: 8,  index: 1.05, label: "Aug",  note: "Back-to-school demand spike" },
    { month: 9,  index: 1.10, label: "Sep",  note: "Fall drops, fashion week hype" },
    { month: 10, index: 1.15, label: "Oct",  note: "Pre-holiday stocking up" },
    { month: 11, index: 1.20, label: "Nov",  note: "Black Friday / holiday peak" },
    { month: 12, index: 1.00, label: "Dec",  note: "Christmas gifting, then sharp drop" },
  ],
  electronics: [
    { month: 1,  index: 0.68, label: "Jan",  note: "Post-holiday crash — best time to buy" },
    { month: 2,  index: 0.75, label: "Feb",  note: "CES hype fades, prices bottom" },
    { month: 3,  index: 0.90, label: "Mar",  note: "Tax refund season starts" },
    { month: 4,  index: 1.05, label: "Apr",  note: "Tax refund peak" },
    { month: 5,  index: 0.95, label: "May",  note: "Memorial Day deals flatten resale" },
    { month: 6,  index: 0.85, label: "Jun",  note: "Slowdown before Prime Day" },
    { month: 7,  index: 1.20, label: "Jul",  note: "Amazon Prime Day drives volume spike" },
    { month: 8,  index: 0.95, label: "Aug",  note: "Back to school, steady demand" },
    { month: 9,  index: 1.10, label: "Sep",  note: "Apple/Samsung launch hype" },
    { month: 10, index: 1.05, label: "Oct",  note: "Pre-holiday restocking" },
    { month: 11, index: 1.25, label: "Nov",  note: "Black Friday / Cyber Monday peak" },
    { month: 12, index: 1.15, label: "Dec",  note: "Christmas gifting" },
  ],
  bag: [
    { month: 1,  index: 0.78, label: "Jan",  note: "Post-holiday, best time to buy luxury bags" },
    { month: 2,  index: 1.05, label: "Feb",  note: "Valentine's luxury gifting" },
    { month: 3,  index: 0.90, label: "Mar",  note: "Seasonal lull" },
    { month: 4,  index: 1.00, label: "Apr",  note: "Spring fashion events" },
    { month: 5,  index: 1.05, label: "May",  note: "Mother's Day luxury demand" },
    { month: 6,  index: 1.10, label: "Jun",  note: "Wedding season, graduation gifts" },
    { month: 7,  index: 0.85, label: "Jul",  note: "Summer slowdown" },
    { month: 8,  index: 0.88, label: "Aug",  note: "Pre-fall, mild" },
    { month: 9,  index: 1.08, label: "Sep",  note: "Fall fashion week demand" },
    { month: 10, index: 1.05, label: "Oct",  note: "Pre-holiday prep" },
    { month: 11, index: 1.20, label: "Nov",  note: "Holiday gift peak" },
    { month: 12, index: 1.12, label: "Dec",  note: "Christmas luxury gifting" },
  ],
  watch: [
    { month: 1,  index: 0.80, label: "Jan",  note: "Post-holiday dip" },
    { month: 2,  index: 1.08, label: "Feb",  note: "Valentine's — watches are top gift" },
    { month: 3,  index: 0.92, label: "Mar",  note: "Watches & Wonders Geneva hype" },
    { month: 4,  index: 0.95, label: "Apr",  note: "Steady" },
    { month: 5,  index: 1.02, label: "May",  note: "Father's Day run-up begins" },
    { month: 6,  index: 1.15, label: "Jun",  note: "Father's Day — peak watch demand" },
    { month: 7,  index: 0.88, label: "Jul",  note: "Summer lull" },
    { month: 8,  index: 0.90, label: "Aug",  note: "Quiet month" },
    { month: 9,  index: 1.00, label: "Sep",  note: "Hodinkee events, Watches & Wonders Asia" },
    { month: 10, index: 1.05, label: "Oct",  note: "Pre-holiday demand" },
    { month: 11, index: 1.18, label: "Nov",  note: "Black Friday / holiday peak" },
    { month: 12, index: 1.12, label: "Dec",  note: "Christmas gifting" },
  ],
  apparel: [
    { month: 1,  index: 0.70, label: "Jan",  note: "Post-Christmas deep lull" },
    { month: 2,  index: 0.80, label: "Feb",  note: "Winter clearance, bad sell month" },
    { month: 3,  index: 0.95, label: "Mar",  note: "Spring transition, tax refunds" },
    { month: 4,  index: 1.10, label: "Apr",  note: "Spring drop season + tax refunds" },
    { month: 5,  index: 1.05, label: "May",  note: "Spring/summer buying" },
    { month: 6,  index: 1.00, label: "Jun",  note: "Steady" },
    { month: 7,  index: 0.85, label: "Jul",  note: "Summer heat — slower streetwear" },
    { month: 8,  index: 1.02, label: "Aug",  note: "Back-to-school apparel" },
    { month: 9,  index: 1.12, label: "Sep",  note: "Fall fashion, hoodie season begins" },
    { month: 10, index: 1.15, label: "Oct",  note: "Peak fall drop season" },
    { month: 11, index: 1.20, label: "Nov",  note: "Holiday gifting peak" },
    { month: 12, index: 0.95, label: "Dec",  note: "Mixed — gift buying vs. cash tight" },
  ],
  eyewear: [
    { month: 1,  index: 0.75, label: "Jan",  note: "Post-holiday low" },
    { month: 2,  index: 0.82, label: "Feb",  note: "Valentine's mild bump" },
    { month: 3,  index: 0.95, label: "Mar",  note: "Spring prep" },
    { month: 4,  index: 1.05, label: "Apr",  note: "Spring outdoor season" },
    { month: 5,  index: 1.18, label: "May",  note: "Peak sunglass season begins" },
    { month: 6,  index: 1.22, label: "Jun",  note: "Summer — peak sunglass demand" },
    { month: 7,  index: 1.20, label: "Jul",  note: "Vacation season, prime sunglass month" },
    { month: 8,  index: 1.10, label: "Aug",  note: "Late summer, still strong" },
    { month: 9,  index: 0.95, label: "Sep",  note: "Fall, demand softens" },
    { month: 10, index: 0.85, label: "Oct",  note: "Off-season" },
    { month: 11, index: 0.90, label: "Nov",  note: "Holiday gifting offset" },
    { month: 12, index: 0.88, label: "Dec",  note: "Gift buying, low urgency" },
  ],
};

// ── Known event-driven demand spikes ─────────────────────────────────────────
const DEMAND_EVENTS = [
  { name: "Tax Refund Season",     months: [3, 4],     categories: ["sneakers", "electronics", "apparel"], lift: 0.20 },
  { name: "Valentine's Day",       months: [2],         categories: ["watch", "bag", "eyewear"],           lift: 0.15 },
  { name: "Mother's Day",          months: [5],         categories: ["bag", "watch", "apparel"],           lift: 0.12 },
  { name: "Father's Day",          months: [6],         categories: ["watch", "electronics", "sneakers"],  lift: 0.15 },
  { name: "Back to School",        months: [8],         categories: ["electronics", "sneakers", "apparel"],lift: 0.10 },
  { name: "Amazon Prime Day",      months: [7],         categories: ["electronics"],                        lift: 0.20 },
  { name: "Black Friday",          months: [11],        categories: ["electronics", "sneakers", "apparel"],lift: 0.25 },
  { name: "Christmas",             months: [12],        categories: ["electronics", "bag", "watch"],       lift: 0.18 },
  { name: "NBA Season",            months: [10, 11, 4], categories: ["sneakers", "apparel"],               lift: 0.08 },
  { name: "Fall Drop Season",      months: [9, 10],     categories: ["sneakers", "apparel"],               lift: 0.12 },
  { name: "Spring Drop Season",    months: [3, 4, 5],   categories: ["sneakers", "apparel"],               lift: 0.10 },
  { name: "Sunglass Peak Season",  months: [5, 6, 7],   categories: ["eyewear"],                           lift: 0.22 },
];

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Get the demand index for a category in a specific month (1-12).
 */
export function getDemandIndex(category = "", month = null) {
  const cat  = String(category || "").toLowerCase().replace(/s$/, "");
  const m    = month ?? new Date().getMonth() + 1;
  const curve = MONTHLY_DEMAND[cat] || MONTHLY_DEMAND.sneakers;
  return curve.find(c => c.month === m) || { month: m, index: 1.0, label: "", note: "" };
}

/**
 * Find the best buy month and best sell month for a category.
 */
export function getBuySellWindows(category = "") {
  const cat   = String(category || "").toLowerCase().replace(/s$/, "");
  const curve = MONTHLY_DEMAND[cat] || MONTHLY_DEMAND.sneakers;

  const buyMonth  = [...curve].sort((a, b) => a.index - b.index)[0];
  const sellMonth = [...curve].sort((a, b) => b.index - a.index)[0];

  return { buyMonth, sellMonth };
}

/**
 * Get upcoming demand events for a category within the next N months.
 */
export function getUpcomingDemandEvents(category = "", fromMonth = null, lookAheadMonths = 3) {
  const cat     = String(category || "").toLowerCase().replace(/s$/, "");
  const current = fromMonth ?? new Date().getMonth() + 1;

  const upcoming = [];
  for (let offset = 1; offset <= lookAheadMonths; offset++) {
    const targetMonth = ((current - 1 + offset) % 12) + 1;
    for (const event of DEMAND_EVENTS) {
      if (!event.categories.includes(cat)) continue;
      if (event.months.includes(targetMonth)) {
        upcoming.push({
          ...event,
          targetMonth,
          monthsAway: offset,
          monthLabel: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][targetMonth - 1],
        });
      }
    }
  }

  return upcoming.sort((a, b) => a.monthsAway - b.monthsAway);
}

/**
 * Compute flip timing recommendation given current month and category.
 */
export function computeFlipTiming(category = "", currentMonth = null) {
  const month       = currentMonth ?? new Date().getMonth() + 1;
  const nowDemand   = getDemandIndex(category, month);
  const { buyMonth, sellMonth } = getBuySellWindows(category);
  const upcomingEvents = getUpcomingDemandEvents(category, month, 4);

  // Is now a good time to buy? (current demand ≤ 0.90)
  const isBuyWindow  = nowDemand.index <= 0.90;
  // Is now a good time to sell? (current demand ≥ 1.10)
  const isSellWindow = nowDemand.index >= 1.10;

  const monthsUntilBestSell = (() => {
    let offset = 0;
    for (let i = 1; i <= 12; i++) {
      const m = ((month - 1 + i) % 12) + 1;
      if (m === sellMonth.month) { offset = i; break; }
    }
    return offset;
  })();

  const monthsUntilBestBuy = (() => {
    let offset = 0;
    for (let i = 1; i <= 12; i++) {
      const m = ((month - 1 + i) % 12) + 1;
      if (m === buyMonth.month) { offset = i; break; }
    }
    return offset;
  })();

  const verdict = isBuyWindow && !isSellWindow ? "BUY_NOW"
                : isSellWindow && !isBuyWindow  ? "SELL_NOW"
                : isBuyWindow && isSellWindow   ? "HOLD"
                : "NEUTRAL";

  return {
    currentMonth:    month,
    currentDemand:   nowDemand,
    isBuyWindow,
    isSellWindow,
    verdict,
    bestBuyMonth:    buyMonth,
    bestSellMonth:   sellMonth,
    monthsUntilBestSell,
    monthsUntilBestBuy,
    upcomingEvents,
    signal: verdict === "BUY_NOW"
      ? `Buy now — ${nowDemand.label} is a demand low (index ${nowDemand.index}). Best sell window: ${sellMonth.label} (${monthsUntilBestSell}mo away, index ${sellMonth.index})`
      : verdict === "SELL_NOW"
      ? `Sell now — ${nowDemand.label} demand is high (index ${nowDemand.index}). Next buy window: ${buyMonth.label}`
      : upcomingEvents.length
      ? `${upcomingEvents[0].name} in ${upcomingEvents[0].monthsAway}mo (${upcomingEvents[0].monthLabel}) — +${Math.round(upcomingEvents[0].lift * 100)}% demand lift expected`
      : `Current demand is average — monitor for upcoming events`,
  };
}

/**
 * Master seasonal flip calendar payload.
 */
export function buildSeasonalFlipCalendarPayload({
  category     = "",
  currentMonth = null,
  scannedPrice = null,
  medianMarket = null,
} = {}) {
  const month       = currentMonth ?? new Date().getMonth() + 1;
  const flipTiming  = computeFlipTiming(category, month);
  const fullCurve   = MONTHLY_DEMAND[String(category || "").toLowerCase().replace(/s$/, "")] || MONTHLY_DEMAND.sneakers;
  const events      = getUpcomingDemandEvents(category, month, 6);

  // Estimate sell price premium at best sell month vs. now
  const nowIndex   = flipTiming.currentDemand.index;
  const sellIndex  = flipTiming.bestSellMonth.index;
  const priceBase  = finiteOrNull(medianMarket) || finiteOrNull(scannedPrice);
  const estimatedSellPrice = (priceBase && nowIndex && sellIndex)
    ? round2(priceBase * (sellIndex / nowIndex))
    : null;
  const estimatedLift = estimatedSellPrice && priceBase
    ? round2(estimatedSellPrice - priceBase)
    : null;

  return {
    flipTiming,
    fullCurve,
    upcomingEvents:       events,
    estimatedSellPrice,
    estimatedLift,
    topSignal:            flipTiming.signal,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────
function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
