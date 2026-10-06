// [LDB-R12] [LDB-R13] [LDB-R14] What a read COSTS, in D1's own billing unit
// (`meta.rows_read`), for the three reads the 2026-10-05 usage review found
// scanning whole tables: the owner list (80% of all rows read: about 9,100
// rows per call to return a handful), a name-sorted catalog page (every page
// re-read and re-sorted the catalog), and `/v1/meta`'s `MAX(at)` (every
// event). `tests/api/list.test.ts` (LDB-R4/LDB-F5) already proves WHAT these
// lists return; this file only bounds how many rows they read to do it, on
// the statements `list()` and `readMetaCore()` really issue (recorded below,
// never retyped here), so a change to either query is measured as written.
//
// The bounds are counts, never timings, and are stated against the result
// size: a regression to "read the catalog" breaks them at any catalog size.
import { beforeAll, describe, expect, it } from "vitest";
import { db, seedUpstream100 } from "./support";
import { readHead } from "../../src/core/etag";
import { readMetaCore } from "../../src/core/meta";
import { decodeCursor, list, type ListParams } from "../../src/core/records";

interface Seen {
  sql: string;
  args: unknown[];
}

// A pass-through D1 that records every statement's SQL and binds.
function recording(inner: D1Database): { db: D1Database; seen: Seen[] } {
  const seen: Seen[] = [];
  const wrapped = {
    prepare(sql: string) {
      const entry: Seen = { sql, args: [] };
      seen.push(entry);
      const stmt = inner.prepare(sql);
      return {
        bind: (...args: unknown[]) => {
          entry.args = args;
          return stmt.bind(...args);
        },
        first: (...a: [string?]) => (a[0] === undefined ? stmt.first() : stmt.first(a[0])),
        all: () => stmt.all(),
        run: () => stmt.run(),
      };
    },
  } as unknown as D1Database;
  return { db: wrapped, seen };
}

interface Cost {
  plan: string;
  rowsRead: number;
}

async function costOf(q: Seen): Promise<Cost> {
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
    .bind(...q.args)
    .all<{ detail: string }>();
  const run = await db
    .prepare(q.sql)
    .bind(...q.args)
    .all();
  return { plan: plan.results.map((r) => r.detail).join(" | "), rowsRead: run.meta.rows_read };
}

const BASE: Pick<ListParams, "sourceLineage" | "withPayload"> = { sourceLineage: "spark", withPayload: false };

async function listCost(params: Omit<ListParams, "sourceLineage">) {
  const rec = recording(db);
  const page = await list(rec.db, { ...BASE, ...params });
  const q = rec.seen.find((s) => s.sql.includes("FROM layouts l"));
  if (q === undefined) throw new Error("list() issued no list statement");
  return { page, ...(await costOf(q)) };
}

let live = 0;
let owners: { owner: string; n: number }[] = [];

beforeAll(async () => {
  await seedUpstream100();
  const rows = await db
    .prepare(
      "SELECT l.owner AS owner, COUNT(*) AS n FROM layouts l JOIN layout_formats f ON f.layout_id = l.id WHERE l.deleted = 0 AND f.lineage = 'spark' GROUP BY l.owner ORDER BY n DESC, l.owner ASC",
    )
    .all<{ owner: string; n: number }>();
  owners = rows.results;
  live = owners.reduce((sum, o) => sum + o.n, 0);
});

describe("list read cost", () => {
  it("the seed is big enough for the bounds below to mean something", () => {
    expect(live).toBeGreaterThanOrEqual(80);
    expect(owners.length).toBeGreaterThanOrEqual(10);
    expect(owners[owners.length - 1]!.n).toBeLessThanOrEqual(3);
  });

  it("[LDB-R12] an owner list reads about two rows per layout that owner has, for every owner in the seed, and never sorts", async () => {
    let total = 0;
    for (const { owner, n } of owners) {
      const { page, plan, rowsRead } = await listCost({ owner, sort: "name", limit: 1000 });
      expect(page.items.length, `owner ${owner}`).toBe(n);
      expect(rowsRead, `owner ${owner} (${n} layouts): ${plan}`).toBeLessThanOrEqual(2 * n + 2);
      expect(plan).toContain("layouts_owner_name");
      expect(plan).not.toContain("TEMP B-TREE");
      total += rowsRead;
    }
    // Every owner asked once reads the catalog about twice over in total --
    // not once per owner, which is what each call used to cost.
    expect(total).toBeLessThanOrEqual(2 * live + 2 * owners.length);
  });

  it("[LDB-R12] the owner list stays proportional under every sort (the non-name sorts may sort that owner's rows, nothing more)", async () => {
    const { owner, n } = owners[0]!;
    for (const sort of ["modified_at", "created_at", "like_count"] as const) {
      const { page, plan, rowsRead } = await listCost({ owner, sort, limit: 1000 });
      expect(page.items.length).toBe(n);
      // One more per row than the name sort: these go through the sorter.
      expect(rowsRead, `${sort}: ${plan}`).toBeLessThanOrEqual(3 * n + 2);
    }
  });

  it("[LDB-R13] a name-sorted page walks the name index and never sorts: about two rows read per row returned, plus the index entries a cursor page steps over to reach its cursor", async () => {
    const limit = 10;
    let cursor: ListParams["cursor"];
    let pages = 0;
    let seenRows = 0;
    for (;;) {
      const { page, plan, rowsRead } = await listCost({ sort: "name", limit, cursor });
      // limit + 1 rows are fetched (the one past the page names the cursor);
      // `seenRows` is how many index entries sit before this page's cursor.
      expect(rowsRead, `page ${pages}: ${plan}`).toBeLessThanOrEqual(seenRows + 2 * (limit + 1) + 2);
      expect(plan).toContain("layouts_name_live");
      expect(plan).not.toContain("TEMP B-TREE");
      pages += 1;
      seenRows += page.items.length;
      if (page.nextCursor === null) break;
      cursor = decodeCursor(page.nextCursor) ?? undefined;
      expect(cursor).toBeDefined();
    }
    expect(seenRows).toBe(live);
    expect(pages).toBe(Math.ceil(live / limit));
  });

  it("[LDB-R13] a format-flag filter still starts from that flag's own index, so a rare flag reads only its own rows", async () => {
    for (const [param, column] of [
      ["hasMagic", "has_magic"],
      ["hasAlts", "has_alts"],
      ["hasCombos", "has_combos"],
    ] as const) {
      const count = await db
        .prepare(`SELECT COUNT(*) AS n FROM layouts l JOIN layout_formats f ON f.layout_id = l.id WHERE l.deleted = 0 AND f.lineage = 'spark' AND f.${column} = 1`)
        .first<{ n: number }>();
      const matches = count?.n ?? 0;
      const { page, plan, rowsRead } = await listCost({ [param]: true, sort: "name", limit: 1000 });
      expect(page.items.length, param).toBe(matches);
      expect(plan, param).toContain(`layout_formats_${column}`);
      expect(rowsRead, `${param}: ${plan}`).toBeLessThanOrEqual(2 * matches + 2);
    }
  });
});

describe("/v1/meta read cost", () => {
  it("[LDB-R14] the head event time is one row read through events_at, and is still the latest `at` in the log", async () => {
    const rec = recording(db);
    const meta = await readMetaCore(rec.db, await readHead(db));
    const q = rec.seen.find((s) => /MAX\(at\)/i.test(s.sql));
    if (q === undefined) throw new Error("readMetaCore() issued no MAX(at) statement");
    const { plan, rowsRead } = await costOf(q);
    expect(plan).toContain("events_at");
    expect(rowsRead).toBeLessThanOrEqual(1);

    const all = await db.prepare("SELECT at FROM events").all<{ at: string }>();
    expect(all.results.length).toBeGreaterThan(100);
    const latest = all.results.map((r) => r.at).reduce((a, b) => (a > b ? a : b));
    expect(meta.revision).toBe(latest);
  });
});
