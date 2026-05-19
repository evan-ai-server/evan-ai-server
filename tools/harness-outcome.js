#!/usr/bin/env node
// tools/harness-outcome.js
// Record ground-truth outcome for a scan recorded by the harness.
//
// Usage:
//   node tools/harness-outcome.js <scanId> --truth=BUY|HOLD|PASS [opts]
//
// Options:
//   --truth=<BUY|HOLD|PASS>      what the verdict SHOULD have been
//   --soldFor=<n>                actual sale price (if sold)
//   --paidFor=<n>                what you actually paid (if bought)
//   --daysToSell=<n>             days from purchase to sale
//   --regret=<low|med|high>      qualitative regret if you followed Evan
//   --evanWasRight=<yes|no>      one-word judgment
//   --notes="..."                free text — what Evan got wrong / right

import { readScans, recordOutcome } from "../src/scanHarness.js";

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

const args = parseArgs(process.argv);
const scanId = args._[0] || args.scanId;
if (!scanId) {
  console.error("error: scanId is required as first positional arg");
  console.error("usage: node tools/harness-outcome.js <scanId> --truth=BUY|HOLD|PASS [--soldFor=n --notes='...']");
  process.exit(1);
}

const TRUTH = ["BUY", "HOLD", "PASS"];
const truth = args.truth ? String(args.truth).toUpperCase() : null;
if (truth && !TRUTH.includes(truth)) {
  console.error(`error: --truth must be one of ${TRUTH.join("|")}`);
  process.exit(1);
}

(async () => {
  const scans = await readScans();
  const match = scans.find((s) => s.scanId === scanId);
  if (!match) {
    console.warn(`warn: no scan with id ${scanId} found in harness ledger`);
    console.warn(`      recording outcome anyway in case scan is upcoming`);
  } else {
    console.log(`matched scan: ${match.summary?.title || "<no title>"} — ts=${match.ts}`);
    console.log(`  evan said: verdict=${match.summary?.verdict}  conf=${match.summary?.confidence}  estResale=${match.summary?.estResale}`);
  }

  const outcome = {
    scanId,
    truth:        truth || null,
    soldFor:      args.soldFor ? Number(args.soldFor) : null,
    paidFor:      args.paidFor ? Number(args.paidFor) : null,
    daysToSell:   args.daysToSell ? Number(args.daysToSell) : null,
    regret:       args.regret || null,
    evanWasRight: args.evanWasRight || null,
    notes:        args.notes || null,
  };

  const ok = await recordOutcome(outcome);
  if (!ok) { console.error("error: failed to write outcome"); process.exit(1); }
  console.log("recorded outcome:", JSON.stringify(outcome, null, 2));
})();
