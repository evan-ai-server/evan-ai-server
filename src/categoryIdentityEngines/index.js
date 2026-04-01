// src/categoryIdentityEngines/index.js
// Category Identity Engine Dispatcher — Phase 15: Category Immortality.
//
// Routes record/compute calls to the correct per-category engine.
// Provides a unified API so callers don't need to import individual engines.

import { CAT } from "../categoryRegistry.js";

import {
  recordSneakerOutcome,
  computeSneakerIdentityScore,
} from "./sneakers.js";
import {
  recordWatchOutcome,
  computeWatchIdentityScore,
} from "./watches.js";
import {
  recordElectronicsOutcome,
  computeElectronicsIdentityScore,
} from "./electronics.js";
import {
  recordHandbagOutcome,
  computeHandbagIdentityScore,
} from "./handbags.js";
import {
  recordTradingCardOutcome,
  computeTradingCardIdentityScore,
} from "./tradingCards.js";
import {
  recordGenericOutcome,
  computeGenericIdentityScore,
} from "./generic.js";

// ── Dispatch tables ───────────────────────────────────────────────────────────

const RECORD_FN = {
  [CAT.SNEAKERS]:      recordSneakerOutcome,
  [CAT.WATCHES]:       recordWatchOutcome,
  [CAT.ELECTRONICS]:   recordElectronicsOutcome,
  [CAT.HANDBAGS]:      recordHandbagOutcome,
  [CAT.TRADING_CARDS]: recordTradingCardOutcome,
};

const SCORE_FN = {
  [CAT.SNEAKERS]:      computeSneakerIdentityScore,
  [CAT.WATCHES]:       computeWatchIdentityScore,
  [CAT.ELECTRONICS]:   computeElectronicsIdentityScore,
  [CAT.HANDBAGS]:      computeHandbagIdentityScore,
  [CAT.TRADING_CARDS]: computeTradingCardIdentityScore,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a realized category-specific outcome.
 * Falls back to the generic engine for categories without a specialized one.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string} canonicalCategory — from CAT.*
 * @param {object} outcome — engine-specific outcome fields
 */
export async function recordCategoryOutcome(redis, userId, canonicalCategory, outcome = {}) {
  const fn = RECORD_FN[canonicalCategory];
  if (fn) {
    return fn(redis, userId, outcome);
  }
  // Generic fallback: extract brand if available
  return recordGenericOutcome(redis, userId, {
    brand:     outcome.brand || null,
    isWin:     outcome.isWin || false,
    netProfit: outcome.netProfit || 0,
  });
}

/**
 * Compute a category-specific identity score for an item context.
 * Falls back to the generic engine.
 *
 * @param {object} redis
 * @param {string} userId
 * @param {string} canonicalCategory — from CAT.*
 * @param {object} ctx — engine-specific context fields (brand, model, etc.)
 * @returns {object|null} identity score result or null
 */
export async function computeCategoryIdentityScore(redis, userId, canonicalCategory, ctx = {}) {
  const fn = SCORE_FN[canonicalCategory];
  if (fn) {
    return fn(redis, userId, ctx);
  }
  return computeGenericIdentityScore(redis, userId, ctx.brand || null);
}

/**
 * Check whether a category has a specialized engine (vs. generic fallback).
 */
export function hasSpecializedEngine(canonicalCategory) {
  return !!SCORE_FN[canonicalCategory];
}
