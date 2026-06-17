// src/marketOracleGuard.js
// Phase V3.9B.1 — pure helpers for oracle-skip decisions in both the stream
// and non-stream market routes.
//
// Pure + dependency-free. Functions here model the exact conditions used by
// the oracle guard blocks in index.js so the logic is directly testable
// without booting the server.

/**
 * shouldSkipOracleSourceUnavailable({ serpCooling, ebayAvail, itemCount })
 *
 * Returns true when the primary data source is unavailable AND there is no
 * real market evidence at all (itemCount === 0). In that state, oracle would
 * fabricate comps with zero anchor data — almost always wrong, and the
 * resulting junk bypasses the retrieval-stage identity locks.
 *
 * Mirrors the stream-path guard at index.js ~31351:
 *   const _primarySourceUnavailable = isSourceCoolingDown("serpapi") && !hasEbayApi();
 *   const _sourceUnavailableNoData   = _primarySourceUnavailable && phase1Items.length === 0;
 *
 * @param {{ serpCooling: boolean, ebayAvail: boolean, itemCount: number }} opts
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipOracleSourceUnavailable({
  serpCooling = false,
  ebayAvail   = false,
  itemCount   = 0,
} = {}) {
  const primaryUnavailable = serpCooling && !ebayAvail;
  if (!primaryUnavailable) return { skip: false, reason: "primary_source_available" };
  const count = Number(itemCount) || 0;
  if (count > 0) return { skip: false, reason: "has_some_real_items_oracle_may_augment" };
  return { skip: true, reason: "primary_source_rate_limited_no_market_evidence" };
}
