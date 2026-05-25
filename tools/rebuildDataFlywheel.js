// tools/rebuildDataFlywheel.js
// Local dev helper for Phase 5.
// Usage:
//   node tools/rebuildDataFlywheel.js
//   node tools/rebuildDataFlywheel.js <userId>

import { rebuildDataFlywheel } from "../src/iterationSpeedEngine.js";

const userId = process.argv[2] || null;

try {
  const result = await rebuildDataFlywheel(userId);

  console.log("\n✅ Evan AI Data Flywheel Rebuilt");
  console.log("────────────────────────────────");
  console.log("User:           ", result.userId || "global");
  console.log("Duration:       ", `${result.durationMs}ms`);
  console.log("Status:         ", result.health?.status);
  console.log("Score:          ", result.health?.score);
  console.log("Outcomes:       ", result.phases?.outcomes?.totalOutcomes ?? 0);
  console.log("Sold:           ", result.phases?.outcomes?.soldCount ?? 0);
  console.log("Dataset records:", result.phases?.dataset?.usableRecords ?? 0);

  if (result.regressionComparison?.compared) {
    const { regressions, improvements } = result.regressionComparison;
    if (regressions.length) {
      console.log("\n⚠️  Regressions vs previous snapshot:");
      for (const r of regressions) {
        console.log(`  - ${r.label}: ${r.before} → ${r.after} (Δ${r.delta.toFixed(4)})`);
      }
    }
    if (improvements.length) {
      console.log("\n📈 Improvements vs previous snapshot:");
      for (const i of improvements) {
        console.log(`  - ${i.label}: ${i.before} → ${i.after} (Δ+${i.delta.toFixed(4)})`);
      }
    }
    if (!regressions.length && !improvements.length) {
      console.log("\n— No significant changes vs previous snapshot.");
    }
  }

  if (result.health?.warnings?.length) {
    console.log("\nWarnings:");
    for (const w of result.health.warnings) console.log(" -", w);
  }
  if (result.health?.recommendations?.length) {
    console.log("\nRecommendations:");
    for (const r of result.health.recommendations) console.log(" -", r);
  }

  process.exit(0);
} catch (e) {
  console.error("Data flywheel rebuild failed:", e?.message || e);
  process.exit(1);
}
