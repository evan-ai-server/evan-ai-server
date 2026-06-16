// Phase V3.7 — pure decision helpers for incomplete-aircraft market policy.
//
// "Incomplete aircraft identity" = a query that names an airline but no aircraft
// family/model (e.g. "Hawaiian Airlines diecast airplane model" with no "787").
// Pricing such a query yields a mixed-family pool, and when live sources are
// rate-limited it falls to the GPT market oracle, which fabricates generic junk
// comps (Delta/Southwest/"generic" + airline-only survivors). The route-level and
// stream oracle paths already refuse these queries; V3.7 closes the two paths that
// did not:
//   (a) /api/vision/background-result handed the client approximateAllowed:true,
//       which greenlit a market search for the airline-only query;
//   (c) the in-merge rescue oracle inside mergeCheapestSources fired without an
//       incomplete-aircraft guard whenever the caller did not pass skipOracle
//       (the non-stream /market/search route).
//
// detectIncompleteAircraftIdentityQuery (in index.js) is the detector; these are
// the pure policy decisions wired around it, kept here so the gates are unit-
// testable without the request pipeline.

/**
 * Background-result approximate-market decision. Approximate market exists for
 * safe collectibles that are not market-ready. V3.7 additionally refuses it for an
 * incomplete aircraft identity (airline present, family/model missing). Non-aircraft
 * safe collectibles are unaffected — for them incompleteAircraft is always false.
 *
 * @returns {{ allowed: boolean, blocked: boolean, reason: string }}
 *   blocked=true means it WOULD have been allowed (safe collectible) but was
 *   refused specifically because the query is an incomplete aircraft identity.
 */
export function approximateMarketDecision({
  marketReady = false,
  incompleteAircraft = false,
  baseApproxAllowed = false,
} = {}) {
  if (marketReady) return { allowed: false, blocked: false, reason: "already_market_ready" };
  if (incompleteAircraft) return { allowed: false, blocked: true, reason: "incomplete_aircraft_identity" };
  return {
    allowed: !!baseApproxAllowed,
    blocked: false,
    reason: baseApproxAllowed ? "safe_collectible_family_unconfirmed" : "not_approx_eligible",
  };
}

/**
 * In-merge rescue-oracle decision (mergeCheapestSources). The oracle fires when the
 * merged pool is thin (< minItems) and the caller did not opt out via skipOracle.
 * V3.7 blocks it for an incomplete aircraft identity so a family-missing aircraft
 * query never fabricates comps — matching the route/stream oracle guards.
 *
 * @returns {{ run: boolean, blocked: boolean, reason: string }}
 *   run=true → fire the oracle. blocked=true → it would have fired but was refused
 *   for incomplete aircraft identity. Both false → not needed / skipOracle.
 */
export function rescueOracleDecision({
  itemCount = 0,
  skipOracle = false,
  incompleteAircraft = false,
  minItems = 4,
} = {}) {
  const count = Number(itemCount) || 0;
  const wouldRun = (count <= 0 || count < minItems) && !skipOracle;
  if (!wouldRun) return { run: false, blocked: false, reason: skipOracle ? "skip_oracle" : "pool_sufficient" };
  if (incompleteAircraft) return { run: false, blocked: true, reason: "incomplete_aircraft_identity" };
  return { run: true, blocked: false, reason: "ok" };
}
