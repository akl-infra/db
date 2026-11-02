// [LDB-SH2] `meta.changes` and `meta.last_row_id` on every statement pattern store/d1 uses, MEASURED: this file runs
// unchanged under the `workers` project (miniflare's real D1) and the `shim` project (node:sqlite behind the D1 shim)
// and both must produce the same table. A statement-by-statement list of [label, changes, last_row_id].
// last_row_id is SQLite's last_insert_rowid() on the connection (D1 reports it for reads too), so every case is stated
// relative to rows this file inserted itself.
import { env } from "../harness";
import { describe, expect, it } from "vitest";
import { d1CommentStore } from "../../src/store/d1/comments";
import { d1LinkStore } from "../../src/store/d1/links";

const db = (env as unknown as { DB: D1Database }).DB;
type Row = [label: string, changes: number, lastRowId: number];

const meta = (label: string, r: D1Result): Row => [label, r.meta.changes, r.meta.last_row_id];
const run = async (label: string, sql: string, ...p: unknown[]): Promise<Row> => meta(label, await db.prepare(sql).bind(...p).run());

/** A batch whose results are recorded one per statement. */
async function batch(label: string, ...stmts: D1PreparedStatement[]): Promise<Row[]> {
  return (await db.batch(stmts)).map((r, i) => meta(`${label}#${i}`, r));
}

/** A database whose batch() results are recorded, to see the meta of the statements the real store methods run. */
function recording(): { db: D1Database; metas: Row[] } {
  const metas: Row[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const out = await target.batch(stmts);
          out.forEach((r, i) => metas.push(meta(`store-batch#${i}`, r)));
          return out;
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: wrapped as unknown as D1Database, metas };
}

describe("D1 meta parity", () => {
  it("[LDB-SH2] meta.changes (a total_changes() delta: trigger rows count) and last_row_id for UPDATE, INSERT OR IGNORE, ON CONFLICT, DELETE, RETURNING, triggers and reads", async () => {
    await db.exec(
      "CREATE TABLE mt (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT UNIQUE, v INTEGER NOT NULL DEFAULT 0);" +
        "CREATE TABLE mt_log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT);" +
        "CREATE TRIGGER mt_ins AFTER INSERT ON mt BEGIN INSERT INTO mt_log (msg) VALUES ('ins'); INSERT INTO mt_log (msg) VALUES ('ins2'); END;" +
        "CREATE TRIGGER mt_upd AFTER UPDATE ON mt BEGIN INSERT INTO mt_log (msg) VALUES ('upd'); END;",
    );
    const rows: Row[] = [];
    const add = (...r: Row[]) => void rows.push(...r);

    add(await run("insert one (trigger writes 2 log rows)", "INSERT INTO mt (k, v) VALUES (?, 1)", "a"));
    add(await run("insert three", "INSERT INTO mt (k, v) VALUES ('b', 1), ('c', 1), ('d', 1)"));
    add(await run("select after insert", "SELECT * FROM mt"));
    add(await run("update 0 rows", "UPDATE mt SET v = 9 WHERE k = 'nope'"));
    add(await run("update 1 row (trigger writes a log row)", "UPDATE mt SET v = 2 WHERE k = 'a'"));
    add(await run("update n rows", "UPDATE mt SET v = 3 WHERE k IN ('b', 'c', 'd')"));
    add(await run("update to the same value", "UPDATE mt SET v = 3 WHERE k = 'b'"));
    add(await run("insert or ignore, miss", "INSERT OR IGNORE INTO mt (k, v) VALUES ('e', 1)"));
    add(await run("insert or ignore, hit", "INSERT OR IGNORE INTO mt (k, v) VALUES ('e', 5)"));
    add(await run("on conflict do nothing, hit", "INSERT INTO mt (k, v) VALUES ('e', 7) ON CONFLICT (k) DO NOTHING"));
    add(await run("on conflict do update, hit", "INSERT INTO mt (k, v) VALUES ('e', 7) ON CONFLICT (k) DO UPDATE SET v = excluded.v"));
    add(await run("on conflict do update, miss", "INSERT INTO mt (k, v) VALUES ('f', 7) ON CONFLICT (k) DO UPDATE SET v = excluded.v"));
    add(await run("insert or replace", "INSERT OR REPLACE INTO mt (id, k, v) VALUES (1, 'a', 11)"));
    add(await run("insert ... returning", "INSERT INTO mt (k, v) VALUES ('g', 1) RETURNING id"));
    add(await run("update ... returning n rows", "UPDATE mt SET v = v + 1 WHERE v = 3 RETURNING k"));
    add(await run("delete 0 rows", "DELETE FROM mt WHERE k = 'nope'"));
    add(await run("delete 1 row", "DELETE FROM mt WHERE k = 'g'"));
    add(await run("delete n rows", "DELETE FROM mt WHERE v = 4"));
    add(await run("select after a no-op delete", "SELECT COUNT(*) FROM mt"));

    // The `changes() = 1` guard chain shape of store/d1/sql.ts: a claiming UPDATE, then an INSERT ... WHERE changes() = 1.
    const guarded = (k: string) => [
      db.prepare("UPDATE mt SET v = v + 100 WHERE k = ? AND v < 100").bind(k),
      db.prepare("INSERT INTO mt_log (msg) SELECT ? WHERE changes() = 1").bind(`claimed-${k}`),
      db.prepare("INSERT INTO mt_log (msg) SELECT 'chained' WHERE changes() = 1"), // chained on the previous insert
    ];
    add(...(await batch("guard passes", ...guarded("a"))));
    add(...(await batch("guard fails (already claimed)", ...guarded("a"))));
    add(...(await batch("guard fails (no such row)", ...guarded("zz"))));
    // The SQL function changes() ignores rows a trigger wrote (the INSERT ... WHERE changes() = 1 after this UPDATE sees 1),
    // although meta.changes -- D1's total_changes() delta -- counts them (2).
    add(...(await batch("meta counts trigger rows, changes() does not", db.prepare("UPDATE mt SET v = v + 1 WHERE k = 'e'"), db.prepare("INSERT INTO mt_log (msg) SELECT 'after-update' WHERE changes() = 1"))));

    expect(rows).toEqual(EXPECTED_RAW);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM mt_log").first<{ n: number }>())!.n).toBe(EXPECTED_LOG_ROWS);
  });

  it("[LDB-SH2] the real guard chains: links.reject and comments.remove report claimed / eventAppended from meta.changes", async () => {
    const t = "2026-11-02T00:00:00.000Z";
    await db.exec("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at) VALUES ('ML1', 'MetaLayout', 'o', 1, 1, '" + t + "', '" + t + "')");
    await db.exec("INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at) VALUES ('LS1', 'ML1', 'https://example.com/x', 'u1', '" + t + "')");
    await db.exec(
      "INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at, review_version) VALUES ('MC1', 'ML1', 'u1', 'hi', 'discord', '" + t + "', 'approved', 'mod', '" + t + "', 0);" +
        "INSERT INTO comment_likes (layout_id, author_id, user_id, via, created_at) VALUES ('ML1', 'u1', 'u2', 'discord', '" + t + "')",
    );
    const rec = recording();
    const links = d1LinkStore(rec.db);
    const event = { kind: "link_rejected", layoutId: "ML1", actor: "mod", via: "discord", source: { client: "test", version: null } } as never;
    const first = await links.reject({ id: "LS1", by: "mod", at: t, reason: null, event });
    const again = await links.reject({ id: "LS1", by: "mod", at: t, reason: null, event }); // the claim is lost: the gated event must not append
    const comments = d1CommentStore(rec.db);
    const won = await comments.remove({ id: "MC1", layoutId: "ML1", userId: "u1", by: "mod", at: t, reason: null, reviewVersion: 0 });
    const lost = await comments.remove({ id: "MC1", layoutId: "ML1", userId: "u1", by: "mod", at: t, reason: null, reviewVersion: 0 });
    const likesLeft = (await db.prepare("SELECT COUNT(*) AS n FROM comment_likes").first<{ n: number }>())!.n;
    expect({ first, again, won, lost, likesLeft, changes: rec.metas.map((m) => m[1]) }).toEqual(EXPECTED_STORE);
  });
});

const EXPECTED_RAW: Row[] = [
  ["insert one (trigger writes 2 log rows)", 3, 1],
  ["insert three", 9, 4],
  ["select after insert", 0, 4],
  ["update 0 rows", 0, 4],
  ["update 1 row (trigger writes a log row)", 2, 4],
  ["update n rows", 6, 4],
  ["update to the same value", 2, 4],
  ["insert or ignore, miss", 3, 5],
  ["insert or ignore, hit", 0, 5],
  ["on conflict do nothing, hit", 0, 5],
  ["on conflict do update, hit", 2, 5],
  ["on conflict do update, miss", 3, 9],
  ["insert or replace", 3, 1],
  ["insert ... returning", 3, 10],
  ["update ... returning n rows", 6, 10],
  ["delete 0 rows", 0, 10],
  ["delete 1 row", 1, 10],
  ["delete n rows", 3, 10],
  ["select after a no-op delete", 0, 10],
  ["guard passes#0", 2, 10],
  ["guard passes#1", 1, 27],
  ["guard passes#2", 1, 28],
  ["guard fails (already claimed)#0", 0, 28],
  ["guard fails (already claimed)#1", 0, 28],
  ["guard fails (already claimed)#2", 0, 28],
  ["guard fails (no such row)#0", 0, 28],
  ["guard fails (no such row)#1", 0, 28],
  ["guard fails (no such row)#2", 0, 28],
  ["meta counts trigger rows, changes() does not#0", 2, 28],
  ["meta counts trigger rows, changes() does not#1", 1, 30],
];
const EXPECTED_LOG_ROWS = 30;
// store-batch metas: [claim, gated event] for links.reject twice (won, lost), then [claim, likes cleanup] for comments.remove twice.
const EXPECTED_STORE = {
  first: { claimed: true, eventAppended: true },
  again: { claimed: false, eventAppended: false },
  won: { claimed: true },
  lost: { claimed: false },
  likesLeft: 0,
  changes: [1, 1, 0, 0, 1, 1, 0, 0],
};
