// Lane S: the state differ. Two { table: row[] } states (D1 SQLite rows vs DynamoDB `exportRows`), compared per table
// as multisets of canonical rows; the first differing row of each table is reported. Dump records (gzip sha256/bytes)
// are masked the same way lane K's fuzzer does (dumpmask.mjs).
import { maskStateRows } from "../fuzz/dumpmask.mjs";

export function canonRow(r) {
  return JSON.stringify(Object.fromEntries(Object.entries(r).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))));
}

/**
 * Per-table differences. `first` is the first differing row in canonical order:
 * { side: "oracle"|"other", row } for a row present on one side only.
 */
export function diffStates(a, b, ignore = []) {
  const out = [];
  for (const t of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (ignore.includes(t)) continue;
    const ra = (a[t] ?? []).map(canonRow).sort();
    const rb = (b[t] ?? []).map(canonRow).sort();
    if (ra.length === rb.length && ra.every((x, i) => x === rb[i])) continue;
    const sb = new Set(rb);
    const sa = new Set(ra);
    const only_oracle = ra.filter((x) => !sb.has(x));
    const only_other = rb.filter((x) => !sa.has(x));
    const first = only_oracle[0] !== undefined && (only_other[0] === undefined || only_oracle[0] <= only_other[0]) ? { side: "oracle", row: only_oracle[0] } : only_other[0] !== undefined ? { side: "other", row: only_other[0] } : { side: "count", row: null };
    out.push({ table: t, rows: [ra.length, rb.length], only_oracle: only_oracle.slice(0, 3), only_other: only_other.slice(0, 3), first });
  }
  return out;
}

/** Mask dump records on both sides, then diff. */
export function diffExports(oracle, other, ignore = []) {
  return diffStates(maskStateRows(oracle), maskStateRows(other), ignore);
}

export function renderStateDiff(diffs) {
  if (diffs.length === 0) return "state: identical";
  return diffs.map((d) => `state ${d.table}: ${d.rows[0]} vs ${d.rows[1]} rows; first differing row (${d.first.side} only): ${d.first.row}`).join("\n");
}
