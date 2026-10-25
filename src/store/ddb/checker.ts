// The index checker (design/aws-port.md §2.3, §4.1): regenerates every derived
// item (name claims, mirrors, user-side likes, counters, HEAD, index items)
// from the primary items and diffs the result against what is stored. The
// fuzzer runs it after every step and the nightly job runs it on the real
// table. Read-only; never repairs.
import type { Item, RowsByTable } from "./contracts";
import { SCHEMAS } from "./schema";
import { canonicalString, classify, isNonRowItem, itemKey, itemsToRows, rowsToItems, scanItems, type CodecContext } from "./codec";
import { inlinePayloads } from "./schema/core";

export interface CheckResult {
  ok: boolean;
  problems: string[];
}

const MAX_PROBLEMS = 200;

const show = (i: Item): string => `${String(i.pk)} / ${String(i.sk)}`;

function diffTable(table: string, stored: readonly Item[], expected: readonly Item[], problems: string[]): void {
  const have = new Map(stored.map((i) => [itemKey(i), i]));
  const want = new Map(expected.map((i) => [itemKey(i), i]));
  for (const [k, e] of want) {
    const s = have.get(k);
    if (s === undefined) problems.push(`${table}: missing ${show(e)}`);
    else if (canonicalString(s) !== canonicalString(e)) {
      const cols = [...new Set([...Object.keys(s), ...Object.keys(e)])].filter((c) => canonicalString(s[c]) !== canonicalString(e[c]));
      problems.push(`${table}: ${show(e)} differs in ${cols.join(", ")}`);
    }
  }
  for (const [k, s] of have) if (!want.has(k)) problems.push(`${table}: unexpected ${show(s)}`);
}

/** A lane with no rows has no primary items, so it implies no derived items either (an empty `events` would still imply a seq-0 HEAD). */
function withoutEmptyLanes(rows: RowsByTable): RowsByTable {
  const out: RowsByTable = {};
  for (const schema of SCHEMAS) {
    if (schema.tables.every((t) => (rows[t] ?? []).length === 0)) continue;
    for (const t of schema.tables) out[t] = rows[t] ?? [];
  }
  return out;
}

export async function checkIndexes(ctx: CodecContext): Promise<CheckResult> {
  const problems: string[] = [];
  const stored = await scanItems(ctx);

  const unclaimed = stored.main.filter((i) => !isNonRowItem(i) && classify(i) === null);
  for (const i of unclaimed) problems.push(`main: no lane owns ${show(i)}`);

  // Ephemeral items no lane owns (HOLD# leases, which are not D1 rows) are not checked.
  const ephemeral = stored.ephemeral.filter((i) => classify(i) !== null);
  const main = stored.main.filter((i) => classify(i) !== null);

  let expected: ReturnType<typeof rowsToItems>;
  try {
    const rows = itemsToRows({ main: await inlinePayloads(ctx.blobs, main), ephemeral });
    expected = rowsToItems(withoutEmptyLanes(rows));
  } catch (e) {
    problems.push(`primary items do not decode: ${(e as Error).message}`);
    return { ok: false, problems };
  }
  diffTable("main", main, expected.main, problems);
  diffTable("ephemeral", ephemeral, expected.ephemeral, problems);

  if (problems.length > MAX_PROBLEMS) {
    const extra = problems.length - MAX_PROBLEMS;
    problems.length = MAX_PROBLEMS;
    problems.push(`... and ${extra} more`);
  }
  return { ok: problems.length === 0, problems };
}
