  // src/counterfactualEngine.js
  // Counterfactual scan engine — runs alternate identity hypotheses and ranks them
  // Produces: primary identity + N ranked alternatives with evidence scores

  import { normalizeAttributeCertaintyMap, mergeAttributeCertaintyMaps } from "./attributeCertaintyMap.js";

  const COUNTERFACTUAL_ENABLED = process.env.COUNTERFACTUAL_ENABLED !== "false";
  const ALLOWED_PLANS = new Set(
    (process.env.COUNTERFACTUAL_PLANS || "pro,internal").split(",").map((s) => s.trim()).filter(Boolean)
  );

  // ── Score a hypothesis against primary result and market data ────────────────

  function scoreHypothesis(parsed = {}, primaryResult = {}, marketItems = []) {
    let score = 0;

    const hypothesisConf = Number(parsed?.confidence || 0);
    const primaryConf    = Number(primaryResult?.confidence || 0);

    // Confidence relative to primary
    score += hypothesisConf * 30;

    // Penalize if significantly less confident than primary
    if (hypothesisConf < primaryConf * 0.70) score -= 15;

    // Identity completeness
    const id = parsed?.identity || {};
    if (id.brand)    score += 14;
    if (id.model)    score += 16;
    if (id.category) score += 8;
    if (id.condition) score += 4;

    // Query specificity (token count proxy)
    const query  = String(parsed?.query || "");
    const tokens = query.split(/\s+/).filter(Boolean);
    score += Math.min(tokens.length, 7) * 3;

    // Market alignment: does query match any listing title?
    if (query && Array.isArray(marketItems) && marketItems.length) {
      const queryLower = query.toLowerCase();
      const tokens     = queryLower.split(/\s+/).filter((t) => t.length > 2);
      let matchCount   = 0;
      for (const item of marketItems.slice(0, 20)) {
        const title = String(item?.title || "").toLowerCase();
        const hits  = tokens.filter((t) => title.includes(t)).length;
        if (hits >= Math.max(1, Math.floor(tokens.length * 0.5))) matchCount++;
      }
      score += Math.min(matchCount, 5) * 4;
    }

    // Attribute certainty
    const ac = normalizeAttributeCertaintyMap(parsed?.attributeCertainty || null);
    const avgCertainty = Object.values(ac).reduce((a, b) => a + b, 0) / Object.keys(ac).length;
    score += avgCertainty * 12;

    return Math.round(Math.max(0, Math.min(100, score)));
  }

  // ── Rank hypotheses: primary first, then sort alternatives by evidence ────────

  function rankHypotheses(primary, alternativesParsed = [], marketItems = []) {
    const primaryScore = scoreHypothesis(primary?.parsed, primary?.parsed, marketItems);

    const ranked = alternativesParsed
      .filter((alt) => alt?.parsed?.query && alt.parsed.query !== primary?.parsed?.query)
      .map((alt) => ({
        identity:        alt.parsed?.identity || null,
        query:           alt.parsed?.query    || null,
        confidence:      Number(alt.parsed?.confidence || 0),
        evidenceScore:   scoreHypothesis(alt.parsed, primary?.parsed, marketItems),
        attributeCertainty: normalizeAttributeCertaintyMap(alt.parsed?.attributeCertainty || null),
        passLabel:       alt.passLabel || "alt",
      }))
      .filter((alt) => alt.evidenceScore > 20) // discard obviously bad guesses
      .sort((a, b) => b.evidenceScore - a.evidenceScore)
      .slice(0, 3);

    return {
      primary: {
        identity:      primary?.parsed?.identity || null,
        query:         primary?.parsed?.query    || null,
        confidence:    Number(primary?.parsed?.confidence || 0),
        evidenceScore: primaryScore,
        attributeCertainty: normalizeAttributeCertaintyMap(
          primary?.parsed?.attributeCertainty || null
        ),
      },
      alternatives: ranked,
      ran:  true,
    };
  }

  // ── Main export ───────────────────────────────────────────────────────────────

  /**
   * @param {object}   opts
   * @param {string}   opts.dataUrl          - base64 data URL of the image
   * @param {string}   opts.mode             - "item" | "mark" | "part" | "label" | "prop"
   * @param {string}   opts.propContext       - optional prop context
   * @param {string}   opts.rid              - request ID for logging
   * @param {object}   opts.primaryResult    - result from runVisionConsensus
   * @param {Array}    opts.marketItems      - current market items for scoring
   * @param {string}   opts.plan             - user plan ("free"|"pro"|"internal")
   * @param {Function} opts.runVisionPassFn  - bound runVisionPass from index.js
   */
  export async function runCounterfactualScan({
    dataUrl,
    mode,
    propContext,
    rid,
    primaryResult,
    marketItems = [],
    plan        = "free",
    runVisionPassFn,
  }) {
    if (!COUNTERFACTUAL_ENABLED)        return null;
    if (!ALLOWED_PLANS.has(plan))       return null;
    if (!runVisionPassFn)               return null;
    if (!dataUrl || !primaryResult)     return null;

    const primaryCategory = primaryResult?.identity?.category || "";
    const primaryBrand    = primaryResult?.identity?.brand    || "";

    // Build alternate prior hints based on what the primary found
    const alt1Hint = buildAlt1Hint(primaryCategory, primaryBrand);
    const alt2Hint = buildAlt2Hint(primaryCategory, primaryBrand);

    let alt1Result = null;
    let alt2Result = null;

    try {
      [alt1Result, alt2Result] = await Promise.all([
        runVisionPassFn({
          dataUrl,
          mode,
          propContext,
          passLabel: "counterfactual_alt1",
          rid,
          priorHint: alt1Hint,
        }),
        runVisionPassFn({
          dataUrl,
          mode,
          propContext,
          passLabel: "counterfactual_alt2",
          rid,
          priorHint: alt2Hint,
        }),
      ]);
    } catch (err) {
      console.warn("⚡ COUNTERFACTUAL: pass error", err?.message || err);
      return null;
    }

    const primaryWrapped = { parsed: primaryResult, passLabel: "primary" };
    const alternatives   = [
      alt1Result ? { parsed: alt1Result.parsed, passLabel: "alt1" } : null,
      alt2Result ? { parsed: alt2Result.parsed, passLabel: "alt2" } : null,
    ].filter(Boolean);

    if (!alternatives.length) return null;

    return rankHypotheses(primaryWrapped, alternatives, marketItems);
  }

  // ── Alt hint builders ─────────────────────────────────────────────────────────

  function buildAlt1Hint(category, brand) {
    const hints = {
      eyewear:     brand ? `fashion or designer eyewear other than ${brand}` : "generic fashion eyewear",
      sneakers:    brand ? `athletic footwear other than ${brand}` : "generic athletic sneakers",
      apparel:     brand ? `streetwear or casual apparel other than ${brand}` : "generic casual apparel",
      electronics: brand ? `consumer electronics other than ${brand}` : "generic consumer electronics",
      collectibles:"vintage or niche collectible item",
      watches:     "fashion or luxury watch",
      bags:        "fashion bag or backpack",
    };
    return hints[category?.toLowerCase()] || "alternative consumer product category";
  }

  function buildAlt2Hint(category, brand) {
    const hints = {
      eyewear:     "sports or safety protective eyewear",
      sneakers:    "casual lifestyle shoe or loafer",
      apparel:     "workwear, uniform, or performance apparel",
      electronics: "vintage or budget electronics alternative",
      collectibles:"toy, hobby supply, or game accessory",
      watches:     "smart watch or fitness tracker",
      bags:        "tool bag, laptop bag, or travel bag",
    };
    return hints[category?.toLowerCase()] || "industrial or commercial product";
  }


