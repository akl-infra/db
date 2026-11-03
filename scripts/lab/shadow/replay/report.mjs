// The replay's markdown summary: counts by route class (equal, diff, diff-state, skipped, error), then every diff and error.
import { CLASSES } from "./routes.mjs";

export const VERDICTS = ["equal", "diff", "diff-state", "skipped", "error"];

export function summarize(records) {
  const byClass = {};
  const skipReasons = {};
  for (const r of records) {
    const row = (byClass[r.class] ??= Object.fromEntries(VERDICTS.map((v) => [v, 0])));
    row[r.verdict] = (row[r.verdict] ?? 0) + 1;
    if (r.verdict === "skipped") {
      const why = (r.reason ?? "").replace(/\d+/g, "N");
      skipReasons[why] = (skipReasons[why] ?? 0) + 1;
    }
  }
  const totals = Object.fromEntries(VERDICTS.map((v) => [v, Object.values(byClass).reduce((n, row) => n + row[v], 0)]));
  return { byClass, totals, skipReasons, compared: totals.equal + totals.diff + totals["diff-state"] };
}

export function renderMarkdown(records, meta = {}) {
  const s = summarize(records);
  const out = [];
  out.push(`# akldb shadow replay${meta.from !== undefined ? `, ${meta.from} .. ${meta.to}` : ""}`);
  if (meta.note) out.push("", meta.note);
  out.push("", `${records.length} records: ${s.totals.equal} equal, ${s.totals.diff} diff, ${s.totals["diff-state"]} diff-state (informational), ${s.totals.skipped} skipped, ${s.totals.error} error.`);
  out.push("", "| route class | equal | diff | diff-state | skipped | error |", "|---|---:|---:|---:|---:|---:|");
  const order = [...CLASSES.filter((c) => s.byClass[c]), ...Object.keys(s.byClass).filter((c) => !CLASSES.includes(c))];
  for (const c of order) {
    const r = s.byClass[c];
    out.push(`| ${c} | ${r.equal} | ${r.diff} | ${r["diff-state"]} | ${r.skipped} | ${r.error} |`);
  }
  out.push(`| **all** | ${s.totals.equal} | ${s.totals.diff} | ${s.totals["diff-state"]} | ${s.totals.skipped} | ${s.totals.error} |`);
  if (Object.keys(s.skipReasons).length > 0) {
    out.push("", "Skipped, by reason:", "");
    for (const [why, n] of Object.entries(s.skipReasons).sort((a, b) => b[1] - a[1])) out.push(`- ${n} x ${why}`);
  }
  const bad = records.filter((r) => r.verdict === "diff" || r.verdict === "error");
  if (bad.length > 0) {
    out.push("", "## Diffs and errors", "");
    for (const r of bad.slice(0, 50)) out.push(`- ${r.verdict} ${r.phase} \`${r.path}${r.query}\` (${r.class}): ${(r.reason ?? r.problems.map((p) => p.detail).join("; ")).slice(0, 300)}`);
    if (bad.length > 50) out.push(`- ... and ${bad.length - 50} more (see the NDJSON)`);
  }
  return `${out.join("\n")}\n`;
}
