// Per-table checksums of the dump-covered tables and the comparison of two dumps (LDB-PV4). Pure: shared by the shadow
// tick's checkpoint (checkpoint.ts), the CLI (scripts/lab/shadow/checksums.mjs) and the gate report.
//
// A table's checksum is sha256 of `canonical(rows)`: the rows exactly as the dump holds them (each table paged in key order
// by the same code on both sides), keys sorted, so two dumps of the same data agree byte for byte and a difference names its
// table. FEED tables are the ones the follower reproduces exactly; STATE tables are replaced from the dump (apply.ts), so
// their comparison is informational ("how stale was shadow before the resync").
import { createHash } from "node:crypto";
import { canonical } from "../../core/canonical";
import type { Dump } from "../../dump/write";

export type TableClass = "feed" | "state";

/** Dump key -> database table name and class. `auth_cache` is never dumped (always []), so it is not here. */
export const DUMP_TABLES: Record<string, { table: string; class: TableClass }> = {
  records: { table: "layouts", class: "feed" },
  layout_formats: { table: "layout_formats", class: "feed" },
  layout_revs: { table: "layout_revs", class: "feed" },
  likes: { table: "likes", class: "feed" },
  events: { table: "events", class: "feed" },
  authors: { table: "authors", class: "state" },
  admins: { table: "admins", class: "state" },
  clients: { table: "clients", class: "state" },
  bans: { table: "bans", class: "state" },
  import_state: { table: "import_state", class: "state" },
  import_map: { table: "import_map", class: "state" },
  link_submissions: { table: "link_submissions", class: "state" },
  wpm_submissions: { table: "wpm_submissions", class: "state" },
  layout_comments: { table: "layout_comments", class: "state" },
  comment_likes: { table: "comment_likes", class: "state" },
};

/** `meta` fields that follow the feed (the author fields follow the authors table, a state table). */
const FEED_META = ["layout_count", "seq", "revision", "layouts_modified_at", "formats"] as const;

export const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface TableCheck {
  class: TableClass;
  equal: boolean;
  shadowRows: number;
  publicRows: number;
  shadowSha: string;
  publicSha: string;
  /** The first row (in dump order) that differs, truncated; absent when equal. */
  firstDiff?: { index: number; shadow: string | null; public: string | null };
}

export interface DumpComparison {
  /** Both dumps' seq (they must be equal for a comparison to mean anything; callers check). */
  shadowSeq: number;
  publicSeq: number;
  tables: Record<string, TableCheck>;
  meta: { equal: boolean; differing: string[] };
  /** Every feed table and the feed meta fields equal. */
  feedEqual: boolean;
  /** Every state table and the author meta fields equal (informational). */
  stateEqual: boolean;
}

const clip = (s: string | undefined): string | null => (s === undefined ? null : s.length > 240 ? `${s.slice(0, 240)}...` : s);

function checkTable(klass: TableClass, shadow: unknown[], pub: unknown[]): TableCheck {
  const a = shadow.map((r) => canonical(r));
  const b = pub.map((r) => canonical(r));
  const shaS = sha256Hex(`[${a.join(",")}]`);
  const shaP = sha256Hex(`[${b.join(",")}]`);
  const out: TableCheck = { class: klass, equal: shaS === shaP, shadowRows: a.length, publicRows: b.length, shadowSha: shaS, publicSha: shaP };
  if (!out.equal) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    out.firstDiff = { index: i, shadow: clip(a[i]), public: clip(b[i]) };
  }
  return out;
}

/** Compare two dumps table by table. Neither is modified. */
export function compareDumps(shadow: Dump, pub: Dump): DumpComparison {
  const tables: Record<string, TableCheck> = {};
  for (const [key, { class: klass }] of Object.entries(DUMP_TABLES)) {
    tables[key] = checkTable(klass, ((shadow as unknown as Record<string, unknown[]>)[key] ?? []), ((pub as unknown as Record<string, unknown[]>)[key] ?? []));
  }
  const sm = shadow.meta as unknown as Record<string, unknown>;
  const pm = pub.meta as unknown as Record<string, unknown>;
  const feedDiff = FEED_META.filter((k) => canonical(sm[k] ?? null) !== canonical(pm[k] ?? null));
  const authorDiff = (["author_count", "authors_modified_at", "authors_version"] as const).filter((k) => canonical(sm[k] ?? null) !== canonical(pm[k] ?? null));
  const feedTables = Object.values(tables).filter((t) => t.class === "feed");
  const stateTables = Object.values(tables).filter((t) => t.class === "state");
  return {
    shadowSeq: shadow.meta.seq,
    publicSeq: pub.meta.seq,
    tables,
    meta: { equal: feedDiff.length === 0 && authorDiff.length === 0, differing: [...feedDiff, ...authorDiff] },
    feedEqual: feedTables.every((t) => t.equal) && feedDiff.length === 0,
    stateEqual: stateTables.every((t) => t.equal) && authorDiff.length === 0,
  };
}

/** The tables of `cmp` that differ, as `name(class)` strings. */
export function differingTables(cmp: DumpComparison): string[] {
  return [...Object.entries(cmp.tables).filter(([, t]) => !t.equal).map(([k, t]) => `${k}(${t.class})`), ...cmp.meta.differing.map((m) => `meta.${m}`)];
}

/**
 * The dump's own seq as the events it holds say: the largest `events.seq`. A dump whose table pages were read at different
 * instants (src/dump/write.ts reads `meta` first, then the tables) can hold events past `meta.seq`; such a dump is "skewed" and
 * cannot be compared exactly.
 */
export function dumpEventSeq(d: Dump): number {
  let max = 0;
  for (const e of d.events) if (e.seq > max) max = e.seq;
  return max;
}
