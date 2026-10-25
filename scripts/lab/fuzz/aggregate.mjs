#!/usr/bin/env node
// The fuzzer gate's verdict (lane F; design/aws-port.md §4.3). Reads the unit results of one run from a local directory
// (aws-run.mjs syncs <bucket>/<run>/ down; layout <dir>/<seed>/<from>.json) and says:
//   PASS        every expected unit is present, for one commit (--commit), and clean
//   FAIL        a unit has diffs, mismatches, errors, or the wrong commit (the first diffs are printed)
//   INCOMPLETE  nothing failed but units are missing (listed; `aws-run.mjs --resume` relaunches exactly these)
// Exit 0 / 1 / 3.
//
//   node scripts/lab/fuzz/aggregate.mjs --results <dir> --commit <sha> [--seeds 20] [--sequences 10000] [--unit 500]
//     [--first 5] [--missing-out <file>] [--json]
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import url from "node:url";
import { expectedUnits, isClean, unitKey } from "./units.mjs";

/** Pure: `read(key)` returns a parsed unit result or undefined. */
export function aggregate({ units, read, commit, first = 5 }) {
  const missing = [];
  const bad = [];
  const wrongCommit = [];
  const firstDiffs = [];
  let clean = 0;
  let steps = 0;
  let durationMs = 0;
  for (const u of units) {
    const r = read(unitKey(u));
    if (r === undefined) {
      missing.push(u);
      continue;
    }
    steps += r.steps ?? 0;
    durationMs += r.duration_ms ?? 0;
    if (commit !== undefined && r.commit !== commit) {
      wrongCommit.push({ ...u, commit: r.commit });
      continue;
    }
    if (r.seed !== u.seed || r.from !== u.from || r.count !== u.count || !isClean(r) || r.clean !== true) {
      bad.push({ ...u, diffs: (r.diff_totals?.response_state ?? 0) + (r.diff_totals?.catalog ?? 0) + (r.diff_totals?.index ?? 0), errors: r.errors?.length ?? 0 });
      for (const d of [...(r.response_state_diffs ?? []), ...(r.catalog_mismatches ?? []), ...(r.index_problems ?? [])]) if (firstDiffs.length < first) firstDiffs.push({ unit: unitKey(u), ...d });
      for (const e of r.errors ?? []) if (firstDiffs.length < first) firstDiffs.push({ unit: unitKey(u), error: e });
    } else clean++;
  }
  const verdict = bad.length > 0 || wrongCommit.length > 0 ? "FAIL" : missing.length > 0 ? "INCOMPLETE" : "PASS";
  return { verdict, expected: units.length, clean, missing, bad, wrongCommit, firstDiffs, steps, taskHours: durationMs / 3.6e6 };
}

function main() {
  const a = { results: undefined, commit: undefined, seeds: 20, sequences: 10000, unit: 500, first: 5, missingOut: undefined, json: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--results") a.results = v();
    else if (k === "--commit") a.commit = v();
    else if (k === "--seeds") a.seeds = Number(v());
    else if (k === "--sequences") a.sequences = Number(v());
    else if (k === "--unit") a.unit = Number(v());
    else if (k === "--first") a.first = Number(v());
    else if (k === "--missing-out") a.missingOut = v();
    else if (k === "--json") a.json = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (a.results === undefined) throw new Error("--results <dir> is required");
  const read = (key) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(a.results, key), "utf8"));
    } catch {
      return undefined;
    }
  };
  const units = expectedUnits({ seeds: a.seeds, sequences: a.sequences, unit: a.unit });
  const r = aggregate({ units, read, commit: a.commit, first: a.first });
  if (a.missingOut !== undefined) fs.writeFileSync(a.missingOut, JSON.stringify([...r.missing, ...r.bad.map(({ seed, from, count }) => ({ seed, from, count })), ...r.wrongCommit.map(({ seed, from, count }) => ({ seed, from, count }))], null, 2));
  if (a.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.verdict}: ${r.clean}/${r.expected} units clean, ${r.missing.length} missing, ${r.bad.length} not clean, ${r.wrongCommit.length} for another commit; ${r.steps} steps, ${r.taskHours.toFixed(1)} task-hours`);
    if (r.missing.length > 0) console.log(`missing: ${r.missing.slice(0, 20).map(unitKey).join(" ")}${r.missing.length > 20 ? ` ... (+${r.missing.length - 20})` : ""}`);
    for (const b of r.bad) console.log(`not clean: ${unitKey(b)} (${b.diffs} diffs, ${b.errors} errors)`);
    for (const w of r.wrongCommit) console.log(`wrong commit: ${unitKey(w)} is ${w.commit}`);
    for (const d of r.firstDiffs) console.log(`first diff: ${JSON.stringify(d).slice(0, 700)}`);
  }
  process.exit(r.verdict === "PASS" ? 0 : r.verdict === "FAIL" ? 1 : 3);
}

if (process.argv[1] !== undefined && url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main();
