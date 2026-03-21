// src/categoryQueryLadder.js
// Category-specialized query ladders for Evan AI scan engine.
// Each category gets a tailored set of query strategies:
// exact → used → cheaper-brand → aesthetic-match → functional-substitute → budget-fallback
// This is the retrieval moat: generic vision → specific market intelligence.

// ── Utility ───────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function dedup(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ── Category detection ────────────────────────────────────────────────────────
export function detectCategory(identity = {}) {
  const cat = norm(identity?.category || "");
  const itemType = norm(identity?.itemType || "");
  const brand = norm(identity?.brand || "");
  const q = norm(identity?.exactQuery || identity?.query || "");
  const combined = `${cat} ${itemType} ${q}`;

  if (/sneaker|shoe|boot|footwear|air max|air force|yeezy|jordan|vans|converse|stan smith|ultraboost/i.test(combined)) return "sneakers";
  if (/sunglass|eyewear|glasses|frames|wayfarer|aviator|clubmaster|oakley|ray-ban|lens/i.test(combined)) return "eyewear";
  if (/hoodie|sweatshirt|jacket|coat|parka|bomber|windbreaker|fleece|puffer|vest/i.test(combined)) return "outerwear";
  if (/tee|t-shirt|shirt|polo|button.?down|flannel|jersey/i.test(combined)) return "tops";
  if (/pants|jeans|shorts|denim|chino|trousers|jogger/i.test(combined)) return "bottoms";
  if (/bag|backpack|tote|purse|handbag|crossbody|wallet|clutch|satchel/i.test(combined)) return "bags";
  if (/watch|timepiece|rolex|omega|seiko|casio|chrono/i.test(combined)) return "watches";
  if (/iphone|phone|android|samsung|pixel|smartphone/i.test(combined)) return "phones";
  if (/macbook|laptop|notebook|chromebook|surface/i.test(combined)) return "laptops";
  if (/airpod|headphone|earphone|earbud|speaker|audio|bose|sony|beats/i.test(combined)) return "audio";
  if (/console|playstation|xbox|nintendo|switch|gameboy|gaming/i.test(combined)) return "gaming";
  if (/camera|lens|mirrorless|dslr|gopro|fuji|canon|sony|nikon/i.test(combined)) return "cameras";
  if (/card|pokemon|trading card|graded|psa|bgs/i.test(combined)) return "cards";
  if (/jewelry|ring|necklace|bracelet|earring|pendant|gold|silver|diamond/i.test(combined)) return "jewelry";
  if (/hat|cap|beanie|snapback|fitted|bucket/i.test(combined)) return "hats";
  if (/supreme|palace|off.?white|bape|vintage|streetwear/i.test(combined)) return "streetwear";
  return "general";
}

// ── Per-category ladder builders ──────────────────────────────────────────────

function sneakersLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");
  const colors = (identity?.colors || []).slice(0, 2).map(norm).join(" ");
  const condition = norm(identity?.condition || "");
  const isUsed = /fair|good|poor|worn/.test(condition);

  const exact = dedup([
    brand && model ? `${brand} ${model}${colors ? " " + colors : ""}` : null,
    brand && model ? `${brand} ${model}` : null,
    model || null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    brand && model ? `${brand} ${model} pre-owned` : null,
    model ? `${model} used` : null,
  ]);

  // Brand-tier-down alternatives
  const alternatives = [];
  if (/jordan/.test(brand + model)) alternatives.push("puma court sneaker", "fila disruptor", "reebok classic");
  if (/air force 1/.test(model)) alternatives.push("vans sk8 lo white", "dc shoes pure", "etnies scout");
  if (/yeezy/.test(model)) alternatives.push("new balance 574", "saucony jazz original", "asics gel lyte");
  if (/air max/.test(model)) alternatives.push("new balance 990 v5", "asics gel nimbus", "hoka clifton");
  if (/adidas ultra/.test(model)) alternatives.push("hoka clifton 9", "new balance fresh foam", "brooks ghost");
  if (/converse/.test(brand + model)) alternatives.push("vans authentic", "superga 2750", "keds champion");
  if (/nike/.test(brand) && !alternatives.length) alternatives.push("adidas originals", "new balance", "vans old skool");

  const visual = dedup([
    colors && model ? `${colors} sneaker` : null,
    colors ? `${colors} low top sneaker` : null,
    brand ? `${brand} sneakers cheap` : null,
    "budget sneakers",
  ]);

  return { exact, used, alternatives, visual, budget: ["sneakers under 50", "cheap sneakers"] };
}

function eyewearLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");
  const colors = (identity?.colors || []).slice(0, 2).map(norm).join(" ");
  const styleWords = (identity?.styleWords || []).slice(0, 2).map(norm).join(" ");
  const shape = styleWords || colors;

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
    brand ? `${brand} sunglasses` : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    brand ? `${brand} sunglasses used` : null,
  ]);

  const alternatives = [];
  if (/ray-ban|rayban/.test(brand)) alternatives.push("knockaround premiums", "goodr sunglasses", "diff eyewear", "quay sunglasses");
  if (/oakley/.test(brand)) alternatives.push("knockaround sport", "goodr wrap sunglasses", "tifosi optics");
  if (/gucci|prada|versace|dior/.test(brand)) alternatives.push("le specs sunglasses", "diff eyewear", "mvmt sunglasses");
  if (/maui jim/.test(brand)) alternatives.push("costa del mar", "native eyewear", "spy optic");
  if (!alternatives.length && brand) alternatives.push("knockaround sunglasses", "goodr sunglasses", "sungait sunglasses");

  const visual = dedup([
    shape ? `${shape} sunglasses` : null,
    colors ? `${colors} frames` : null,
    "cheap sunglasses",
    "budget sunglasses",
  ]);

  return { exact, used, alternatives, visual, budget: ["sunglasses under 30", "affordable sunglasses"] };
}

function outerwearLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");
  const colors = (identity?.colors || []).slice(0, 2).map(norm).join(" ");
  const materials = (identity?.materials || []).slice(0, 1).map(norm).join(" ");

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
    brand ? `${brand} jacket` : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    brand ? `${brand} jacket used` : null,
  ]);

  const alternatives = [];
  if (/canada goose/.test(brand)) alternatives.push("columbia omni-heat jacket", "the north face mcmurdo parka", "patagonia down sweater");
  if (/moncler/.test(brand)) alternatives.push("the north face nuptse puffer", "patagonia silent puffer", "uniqlo ultra light down");
  if (/arc.?teryx/.test(brand)) alternatives.push("patagonia torrentshell 3l", "columbia pouring adventure", "outdoor research helium");
  if (/the north face/.test(brand)) alternatives.push("columbia sportswear jacket", "patagonia better sweater", "carhartt active jacket");
  if (!alternatives.length) alternatives.push("columbia jacket", "the north face jacket", "patagonia fleece");

  const visual = dedup([
    colors && materials ? `${colors} ${materials} jacket` : null,
    colors ? `${colors} winter jacket` : null,
    "affordable puffer jacket",
  ]);

  return { exact, used, alternatives, visual, budget: ["winter jacket under 100", "cheap puffer jacket"] };
}

function audioLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
    brand ? `${brand} headphones` : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
  ]);

  const alternatives = [];
  if (/airpods pro/.test(model)) alternatives.push("soundcore liberty 4 nc", "samsung galaxy buds2 pro", "jabra elite 4");
  if (/airpods/.test(model) && !/pro/.test(model)) alternatives.push("soundcore life p3", "jlab go air pop", "anker soundcore a3i");
  if (/sony wh.?1000/.test(model)) alternatives.push("anker soundcore q45", "jbl tune 770nc", "edifier wh950nb");
  if (/bose quietcomfort/.test(model + brand)) alternatives.push("anker q45 anc headphones", "jbl live 660nc", "soundcore life q35");
  if (/beats/.test(brand)) alternatives.push("jbl tune 770nc", "soundcore q45", "anker soundcore q20i");
  if (!alternatives.length && brand) alternatives.push("anker soundcore headphones", "jbl wireless headphones", "soundcore earbuds");

  const visual = dedup([
    "wireless headphones cheap",
    "budget earbuds",
    "affordable anc headphones",
  ]);

  return { exact, used, alternatives, visual, budget: ["earbuds under 50", "headphones under 100"] };
}

function watchesLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
    brand ? `${brand} watch` : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    brand ? `${brand} watch used` : null,
  ]);

  const alternatives = [];
  if (/rolex/.test(brand)) alternatives.push("seiko presage", "orient bambino", "tissot prx");
  if (/omega/.test(brand)) alternatives.push("seiko prospex", "hamilton khaki", "tissot seastar");
  if (/tag heuer/.test(brand)) alternatives.push("hamilton jazzmaster", "seiko 5 sports", "citizen promaster");
  if (/ap|audemars/.test(brand)) alternatives.push("seiko 5 sports stainless", "orient star", "citizen geometric");
  if (/cartier/.test(brand)) alternatives.push("seiko presage cocktail", "orient bambino roman", "tissot le locle");
  if (!alternatives.length && brand) alternatives.push("seiko automatic", "citizen eco-drive", "orient automatic");

  const visual = dedup([
    "affordable automatic watch",
    "seiko alternative",
    "budget dress watch",
  ]);

  return { exact, used, alternatives, visual, budget: ["watch under 200", "automatic watch under 300"] };
}

function bagsLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");
  const colors = (identity?.colors || []).slice(0, 1).map(norm).join(" ");

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
    brand ? `${brand} bag` : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    brand ? `${brand} bag pre-owned` : null,
  ]);

  const alternatives = [];
  if (/louis vuitton|lv/.test(brand)) alternatives.push("coach signature tote", "kate spade tote bag", "fossil leather tote");
  if (/gucci/.test(brand)) alternatives.push("kate spade shoulder bag", "coach crossbody", "michael kors bag");
  if (/chanel/.test(brand)) alternatives.push("coach quilted bag", "kate spade quilted", "madewell the transport tote");
  if (/prada/.test(brand)) alternatives.push("coach nylon bag", "madewell nylon zip", "cuyana system tote");
  if (/coach/.test(brand)) alternatives.push("fossil leather bag", "kate spade budget", "michael kors hamilton");
  if (!alternatives.length) alternatives.push("coach leather bag", "kate spade tote", "fossil crossbody");

  const visual = dedup([
    colors ? `${colors} leather bag` : null,
    "affordable designer bag",
    "budget tote bag",
  ]);

  return { exact, used, alternatives, visual, budget: ["bag under 100", "affordable tote bag"] };
}

function phonesLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    brand && model ? `${brand} ${model} refurbished` : null,
    brand && model ? `${brand} ${model} unlocked` : null,
  ]);

  const alternatives = [];
  // Previous gen is always a great alternative
  const genMatch = model.match(/(\d+)\s*(pro|plus|max|ultra)?/i);
  if (genMatch && Number(genMatch[1]) > 12 && brand === "iphone") {
    const prevGen = Number(genMatch[1]) - 1;
    alternatives.push(`iphone ${prevGen} pro used`, `iphone ${prevGen} used`);
  }
  if (/iphone/.test(brand + model)) alternatives.push("samsung galaxy s24", "google pixel 8", "oneplus 12");
  if (/samsung s/.test(model)) alternatives.push("google pixel 8a", "oneplus 12r", "motorola edge");
  if (!alternatives.length && brand) alternatives.push(`${brand} ${model} previous generation`, "refurbished smartphone");

  const visual = dedup([
    brand && model ? `refurbished ${brand} ${model}` : null,
    "used smartphone unlocked",
    "budget flagship phone",
  ]);

  return { exact, used, alternatives, visual, budget: ["phone under 400", "cheap unlocked phone"] };
}

function gamingLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");

  const exact = dedup([
    brand && model ? `${brand} ${model}` : null,
    model ? model : null,
  ]);

  const used = dedup([
    brand && model ? `${brand} ${model} used` : null,
    model ? `${model} used` : null,
  ]);

  const alternatives = [];
  if (/playstation 5|ps5/.test(model + brand)) alternatives.push("playstation 4 pro used", "xbox series s");
  if (/xbox series x/.test(model)) alternatives.push("xbox series s", "playstation 4 pro used");
  if (/nintendo switch oled/.test(model)) alternatives.push("nintendo switch v2", "nintendo switch lite");
  if (/gameboy|game boy/.test(model)) alternatives.push("game boy advance sp used", "analogue pocket");

  const visual = dedup([
    model ? `${model} bundle` : null,
    "gaming console used bundle",
    "retro console cheap",
  ]);

  return { exact, used, alternatives, visual, budget: ["gaming console under 200", "used gaming console"] };
}

function generalLadder(identity) {
  const brand = norm(identity?.brand || "");
  const model = norm(identity?.model || "");
  const category = norm(identity?.category || "");
  const itemType = norm(identity?.itemType || "");
  const colors = (identity?.colors || []).slice(0, 2).map(norm).join(" ");

  const base = brand && model ? `${brand} ${model}` : model || brand || category || itemType;

  const exact = dedup([base || null]);
  const used = dedup([base ? `${base} used` : null, base ? `${base} pre-owned` : null]);
  const alternatives = [];
  if (category || itemType) {
    alternatives.push(`cheap ${category || itemType}`, `affordable ${category || itemType}`);
    if (colors) alternatives.push(`${colors} ${category || itemType}`);
  }

  return {
    exact,
    used,
    alternatives,
    visual: dedup([colors && (category || itemType) ? `${colors} ${category || itemType}` : null]),
    budget: dedup([(category || itemType) ? `${category || itemType} under 50` : null]),
  };
}

// ── Main export: build full query ladder for any item ─────────────────────────
export function buildCategoryQueryLadder(identity = {}, substituteCandidates = []) {
  const category = detectCategory(identity);

  let ladder;
  switch (category) {
    case "sneakers":    ladder = sneakersLadder(identity); break;
    case "eyewear":     ladder = eyewearLadder(identity); break;
    case "outerwear":   ladder = outerwearLadder(identity); break;
    case "audio":       ladder = audioLadder(identity); break;
    case "watches":     ladder = watchesLadder(identity); break;
    case "bags":        ladder = bagsLadder(identity); break;
    case "phones":      ladder = phonesLadder(identity); break;
    case "gaming":      ladder = gamingLadder(identity); break;
    default:            ladder = generalLadder(identity); break;
  }

  // Merge vision-detected substituteCandidates into alternatives
  const visionSubstitutes = substituteCandidates.map(norm).filter(Boolean);
  const merged = {
    ...ladder,
    alternatives: dedup([...visionSubstitutes, ...(ladder.alternatives || [])]).slice(0, 8),
    category,
  };

  return merged;
}

// ── Get flat list of all queries in priority order ────────────────────────────
export function getLadderQueryList(ladder = {}, maxPerLane = 3) {
  return dedup([
    ...(ladder.exact     || []).slice(0, maxPerLane),
    ...(ladder.used      || []).slice(0, maxPerLane),
    ...(ladder.alternatives || []).slice(0, maxPerLane),
    ...(ladder.visual    || []).slice(0, maxPerLane),
    ...(ladder.budget    || []).slice(0, 2),
  ]);
}

// ── Get cheaper-focused queries only (for 60% cheaper hunter) ────────────────
export function getCheaperQueryList(ladder = {}) {
  return dedup([
    ...(ladder.alternatives || []).slice(0, 5),
    ...(ladder.budget || []).slice(0, 3),
    ...(ladder.visual || []).slice(0, 2),
  ]);
}
