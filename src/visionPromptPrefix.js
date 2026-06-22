// DRIFT CONTRACT (Phase 5A.4C.1): the price/hint/size signal wording below mirrors
// index.js -> modeHeader (item path), which the master/brand_model/visual_shape/fast
// passes still use with signals at the FRONT. Here the same signals are emitted as a
// suffix (with a leading blank-line separator) so the query_fast static prefix stays
// byte-stable across scans for prompt caching. Keep wording in sync with modeHeader;
// the "drift guard" test in visionPromptPrefix.test.js pins this output.
export function buildItemDynamicContext(propContext) {
  const priceBracketMatch = (propContext || "").match(/price:(luxury|premium|mid|entry)/);
  const listedMatch = (propContext || "").match(/listed:([\d.]+)/);
  const altMatch = (propContext || "").match(/alt:([\d.]+)/);
  const hintMatch  = (propContext || "").match(/hint:([^|]+)/);
  const sizeMatch  = (propContext || "").match(/size:([^|]+)/);
  const priceBracketLabel = priceBracketMatch?.[1] || null;
  const listedPrice = listedMatch?.[1] ? `$${listedMatch[1]}` : null;
  const altPrice = altMatch?.[1] ? `$${altMatch[1]}` : null;

  let priceSignal = "";
  if (priceBracketLabel === "luxury") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "high value"}, cheapest alternative ${altPrice || "comparable"}. HIGH-VALUE ITEM — prioritize luxury brand extraction (LV, Gucci, Chanel, Hermès, Rolex, AP, Patek, Prada, Balenciaga, etc). These brands have authentication tells — look harder.`;
  } else if (priceBracketLabel === "premium") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "mid-high"}, cheapest alternative ${altPrice || "comparable"}. PREMIUM BRACKET — check for Nike/Jordan/Adidas/New Balance limited releases, designer streetwear, mid-tier watches, electronics with storage variants.`;
  } else if (priceBracketLabel === "mid") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "mid-range"}, cheapest alternative ${altPrice || "comparable"}. MID BRACKET — branded sportswear, contemporary fashion, used electronics. Condition matters for this price.`;
  } else if (priceBracketLabel === "entry") {
    priceSignal = `\nPRICE SIGNAL: Listed at ${listedPrice || "low"}, cheapest alternative ${altPrice || "comparable"}. ENTRY BRACKET — common brands, mass market, or significantly worn. Be honest about condition.`;
  }

  const itemHintSignal = hintMatch?.[1]
    ? `\nUSER HINT: The user says this is "${hintMatch[1].trim()}". Use this as a strong search-query anchor — confirm visually if consistent, then build the query around it.`
    : "";
  const sizeHintSignal = sizeMatch?.[1]
    ? `\nSIZE HINT: The user specified size/variant "${sizeMatch[1].trim()}". Include this in the search query when relevant (e.g. "Nike Air Force 1 Size 10", "Medium Blue").`
    : "";

  const signals = [priceSignal, itemHintSignal, sizeHintSignal].filter(Boolean);
  return signals.length > 0 ? "\n" + signals.join("") : "";
}

export function assembleUltraLeanVisionPrompt(staticModeHeader, dynamicContext) {
  return `${staticModeHeader}

You are identifying a resale item from an image.
Return ONLY the best marketplace search query.

Rules:
1. Identify the physical item type first (sunglasses, sneaker, handbag, watch, model airplane, etc.).
2. Include visible color, material, and style descriptors.
3. Include brand ONLY if it is clearly readable from text or logo on the item. Never guess brand from shape alone.
4. Do not include condition, price, authenticity, or explanation.
5. Query must be something a buyer would type on eBay or Google Shopping.
6. Prefer concise but specific queries over generic ones.

Special case — model airplane / aircraft collectible:
If the item is a model airplane, diecast aircraft, or airplane toy:
- Include the airline livery if text or markings are visible (Hawaiian Airlines, United, Delta, ANA, Emirates, etc.).
- Include the aircraft family/type if visible or recognizable from body markings or text: 787, 787-9, 777, 747, 737, A321, A320, A350, A330, A380.
- If the fuselage or tail text includes "787", "Dreamliner", "777", etc., include it in the query.
- Include the word "Dreamliner" if clearly marked or visually recognizable.
- Include scale if visible: 1:400, 1:200, 1:300.
- Include maker/brand if text is visible on packaging or base: GeminiJets, NG Models, Herpa, Daron, Skymarks.
- If BOTH airline and aircraft type are visible, you MUST include both in the query.
- If airline livery is visible but aircraft type is ambiguous, include airline only and set confidence lower.

Examples:
- "black oval plastic sunglasses orange lens"
- "white leather Nike low top sneakers"
- "tan leather crossbody bag gold hardware"
- "blue denim Levi's trucker jacket"
- "black digital watch plastic strap"
- "Hawaiian Airlines Boeing 787-9 Dreamliner diecast model airplane"
- "Hawaiian Airlines 787-9 model airplane 1:400 GeminiJets"
- "Daron Hawaiian Airlines single plane toy pullback"
- "United Airlines Boeing 777 diecast model airplane"

Output:
- query: best resale search query (or null if item unclear)
- variants: 3-5 alternate queries ordered specific → broad
- confidence: 0.0-1.0 confidence in item type and visual descriptors
- category: simple noun like "sunglasses", "shoes", "jacket", "bag", "watch", "model airplane", "diecast model"
- brandCertainty: 0.0-1.0 certainty that brand is clearly readable (0 if not visible)

Keep response short.${dynamicContext}`;
}
