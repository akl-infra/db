// The row-for-row proof of the cutover (design/aws-port.md §5.2 step 3 and the rollback's step 4): two sets of D1-shaped rows by table,
// compared as multisets over every non-ephemeral table. Pure and dependency-free so the orchestrator and its tests share it; the real
// rows come from `scripts/mirror/daily-proof.mjs`'s ops (D1 export vs the mirror's `exportRows`).
import { createHash } from "node:crypto";

/** Tables the cutover copies instead of proving (design §5.2 step 3), plus the reverse mirror's own queue. */
export const EPHEMERAL_TABLES = ["nonces", "auth_cache", "ratelimit"];
const NOT_PROVEN = new Set([...EPHEMERAL_TABLES, "mirror_queue"]);

function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}
// The flag itself: D1 keeps it in `import_state`, DynamoDB in STATE/cutover (not an `import_state` row), so it is never part of the proof.
const isFlagRow = (table, row) => table === "import_state" && row.key === "cutover.mode";
const digest = (row) => createHash("sha256").update(stable(row)).digest("hex");

/**
 * @param {Record<string, object[]>} left rows by table
 * @param {Record<string, object[]>} right rows by table
 * @returns {{ ok: boolean, tables: number, rows: number, diffs: { table: string, onlyLeft: number, onlyRight: number }[] }}
 */
export function proveRows(left, right) {
  const tables = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((t) => !NOT_PROVEN.has(t)).sort();
  const diffs = [];
  let rows = 0;
  for (const table of tables) {
    const count = new Map();
    const lrows = (left[table] ?? []).filter((r) => !isFlagRow(table, r));
    for (const r of lrows) count.set(digest(r), (count.get(digest(r)) ?? 0) + 1);
    rows += lrows.length;
    let onlyRight = 0;
    for (const r of (right[table] ?? []).filter((r) => !isFlagRow(table, r))) {
      const d = digest(r);
      const n = count.get(d) ?? 0;
      if (n === 0) onlyRight += 1;
      else count.set(d, n - 1);
    }
    let onlyLeft = 0;
    for (const n of count.values()) onlyLeft += n;
    if (onlyLeft > 0 || onlyRight > 0) diffs.push({ table, onlyLeft, onlyRight });
  }
  return { ok: diffs.length === 0, tables: tables.length, rows, diffs };
}
