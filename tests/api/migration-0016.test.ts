// [LDB-F40] migrations/0016_no_board.sql (design/layout-db/26-no-board.md):
// every stored spark/1 payload -- the current `layout_formats` row AND every
// historical `layout_revs` payload -- loses its `board` key in place, and
// what is left is byte-identical to `canonical()` of the same board-less
// payload (so a stored row still hashes/compares exactly like a freshly
// written one). The suite's own D1 already has 0016 applied by the time
// any test runs (tests/setup-workers.ts), so this test re-runs the
// migration's own statements (read back from the TEST_MIGRATIONS binding,
// never retyped here) over rows it inserts WITH a board first.
import { env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { ulid } from "ulidx";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

function migration0016(): D1Migration {
  const m = e.TEST_MIGRATIONS.find((x) => x.name.startsWith("0016_"));
  if (m === undefined) throw new Error("migrations/0016_no_board.sql is not in TEST_MIGRATIONS");
  return m;
}

async function rerun0016(): Promise<void> {
  for (const q of migration0016().queries) await e.DB.prepare(q).run();
}

describe("[LDB-F40] migration 0016 strips `board` from every stored spark/1 payload", () => {
  it("[LDB-F40] layout_formats and layout_revs rows lose the key; the result equals canonical() of the board-less payload; other lineages/rows are untouched", async () => {
    const id = ulid();
    const now = "2026-09-13T00:00:00Z";
    const withBoard = { keys: [{ char: "a", row: 0, col: 0, finger: "LP" }], board: "ansi", magic: { rules: [{ inputs: "aa", output: "ab" }] } };
    const without = { keys: withBoard.keys, magic: withBoard.magic };
    await e.DB.prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at) VALUES (?, ?, ?, 2, 1, ?, ?)")
      .bind(id, `m0016-${id}`, "184412255822020608", now, now)
      .run();
    await e.DB.prepare("INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic) VALUES (?, 'spark', 'spark/1', 2, ?, ?, ?, 1)")
      .bind(id, now, now, canonical(withBoard))
      .run();
    // rev 1 (historical, WITH board) and rev 2 (current, WITH board) in the history table, plus a layout-scope row with no payload at all.
    await e.DB.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES (?, 1, 'spark', 1, 1, 'spark/1', ?)").bind(id, canonical({ keys: [], board: "colstag" })).run();
    await e.DB.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES (?, 2, 'spark', 2, 2, 'spark/1', ?)").bind(id, canonical(withBoard)).run();
    await e.DB.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES (?, 3, NULL, 2, 3, NULL, NULL)").bind(id).run();

    await rerun0016();

    const current = await e.DB.prepare("SELECT payload_json, rev FROM layout_formats WHERE layout_id = ?").bind(id).first<{ payload_json: string; rev: number }>();
    expect(current!.payload_json).toBe(canonical(without)); // byte-identical, not just deep-equal
    expect(current!.rev).toBe(2); // never bumped

    const revs = await e.DB.prepare("SELECT n, payload_json FROM layout_revs WHERE layout_id = ? ORDER BY n").bind(id).all<{ n: number; payload_json: string | null }>();
    expect(revs.results.map((r) => r.payload_json)).toEqual([canonical({ keys: [] }), canonical(without), null]);

    // Idempotent: a second run changes nothing.
    await rerun0016();
    const again = await e.DB.prepare("SELECT payload_json FROM layout_formats WHERE layout_id = ?").bind(id).first<{ payload_json: string }>();
    expect(again!.payload_json).toBe(canonical(without));
  });
});
