// Lane R: the skipped-request report. A request the replay cannot rebuild is skipped, counted and reported, never
// dropped silently; the replay fails its gate when more than `maxFraction` (default 1%) of the considered requests
// (everything on the API surface; non-API paths are `ignored`, listed apart) were skipped.
export const MAX_SKIP_FRACTION = 0.01;

export function skipReport(plan, opts = {}) {
  const maxFraction = opts.maxFraction ?? MAX_SKIP_FRACTION;
  const byReason = {};
  for (const s of plan.skipped) {
    const r = (byReason[s.reason] ??= { count: 0, examples: [] });
    r.count++;
    if (r.examples.length < (opts.examples ?? 5)) r.examples.push({ ts: s.req.ts, method: s.req.method, path: s.req.path + s.req.query, status: s.req.status });
  }
  const considered = plan.considered;
  const skipped = plan.skipped.length;
  const fraction = considered === 0 ? 0 : skipped / considered;
  const notes = {};
  for (const it of plan.items) for (const n of it.notes ?? []) notes[n] = (notes[n] ?? 0) + 1;
  return {
    considered,
    replayed: plan.items.length,
    skipped,
    ignored: plan.ignored,
    fraction,
    maxFraction,
    ok: fraction <= maxFraction,
    byReason,
    inferred: notes,
  };
}

export function renderSkipReport(r) {
  const lines = [`replayed ${r.replayed} of ${r.considered} API requests; skipped ${r.skipped} (${(r.fraction * 100).toFixed(3)}%, gate ${(r.maxFraction * 100).toFixed(1)}%: ${r.ok ? "PASS" : "FAIL"}); ignored ${r.ignored} non-API`];
  for (const [reason, v] of Object.entries(r.byReason).sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`  ${reason}: ${v.count}`);
    for (const e of v.examples) lines.push(`    ${new Date(e.ts).toISOString()} ${e.method} ${e.path} -> ${e.status}`);
  }
  const inf = Object.entries(r.inferred).sort();
  if (inf.length > 0) lines.push(`  inferred: ${inf.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return lines.join("\n");
}
