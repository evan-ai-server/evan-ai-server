#!/usr/bin/env node
// tools/harness-review.js
// Print a side-by-side review of recorded scans vs ground-truth outcomes.
//
// Usage:
//   node tools/harness-review.js                 # table of all scans (newest first)
//   node tools/harness-review.js --id <scanId>   # full dump of one scan
//   node tools/harness-review.js --mismatches    # only scans where evan != truth

import { readScans, readOutcomes } from "../src/scanHarness.js";

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--")) {
      const [k, ...rest] = a.slice(2).split("=");
      out[k] = rest.length ? rest.join("=") : true;
    } else out._.push(a);
  }
  return out;
}

function pad(s, n) {
  s = String(s ?? "");
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

function shortId(id) {
  return id ? String(id).slice(0, 10) : "<no-id>   ";
}

(async () => {
  const args = parseArgs(process.argv);
  const [scans, outcomes] = await Promise.all([readScans(), readOutcomes()]);

  if (args.id) {
    const s = scans.find((x) => x.scanId === args.id || String(x.scanId).startsWith(args.id));
    if (!s) { console.error(`no scan matched ${args.id}`); process.exit(1); }
    const os = outcomes.filter((o) => o.scanId === s.scanId);
    console.log(JSON.stringify({ scan: s, outcomes: os }, null, 2));
    return;
  }

  // Latest outcome per scanId
  const outcomeByScan = new Map();
  for (const o of outcomes) outcomeByScan.set(o.scanId, o);

  const rows = scans.map((s) => {
    const o = outcomeByScan.get(s.scanId);
    const evanVerdict  = s.summary?.verdict  || "?";
    const evanConf     = s.summary?.confidence;
    const truthVerdict = o?.truth || null;
    const mismatch     = truthVerdict && evanVerdict && truthVerdict !== evanVerdict;
    return { s, o, evanVerdict, evanConf, truthVerdict, mismatch };
  });

  const filtered = args.mismatches ? rows.filter((r) => r.mismatch) : rows;

  if (filtered.length === 0) {
    console.log("no scans recorded yet — run a scan and they'll show up here.");
    console.log("ledger files:");
    console.log("  storage/scan-harness/scans.jsonl");
    console.log("  storage/scan-harness/outcomes.jsonl");
    return;
  }

  // Header
  console.log(
    pad("scanId", 12) + pad("when", 22) + pad("title", 28) +
    pad("evan", 8) + pad("conf", 6) + pad("truth", 8) + pad("mismatch", 9) + "notes"
  );
  console.log("─".repeat(110));

  // Rows newest-first
  filtered.sort((a, b) => (b.s.ts || "").localeCompare(a.s.ts || ""));
  for (const r of filtered) {
    console.log(
      pad(shortId(r.s.scanId), 12) +
      pad(r.s.ts || "", 22) +
      pad(r.s.summary?.title || "", 28) +
      pad(r.evanVerdict, 8) +
      pad(r.evanConf == null ? "" : r.evanConf, 6) +
      pad(r.truthVerdict || "", 8) +
      pad(r.mismatch ? "YES" : "", 9) +
      (r.o?.notes || "")
    );
  }

  // Summary stats
  const labeled = rows.filter((r) => r.truthVerdict);
  if (labeled.length) {
    const right = labeled.filter((r) => r.evanVerdict === r.truthVerdict).length;
    console.log("─".repeat(110));
    console.log(`labeled: ${labeled.length}   evan correct: ${right}/${labeled.length}   accuracy: ${((right / labeled.length) * 100).toFixed(0)}%`);
  } else {
    console.log("─".repeat(110));
    console.log(`${rows.length} scans recorded, 0 labeled. add ground truth with: node tools/harness-outcome.js <scanId> --truth=BUY|HOLD|PASS`);
  }
})();
