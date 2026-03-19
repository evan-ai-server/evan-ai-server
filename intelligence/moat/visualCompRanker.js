import { visualSimilarityScore } from "./visualTwinSearch.js";

export function rankVisualComps(query, items) {
  return items
    .map(i => ({
      ...i,
      visualScore: visualSimilarityScore(query, i.title || "")
    }))
    .sort((a,b)=>b.visualScore-a.visualScore);
}
