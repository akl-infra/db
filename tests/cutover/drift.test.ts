// [LDB-CV26] The cutover tolerates exactly the read-path drift set (scripts/cutover/drift.mjs, measured by tests/api/read-path-drift.test.ts) and nothing
// else: the tolerant table comparison, the statement recognizer for bookkeeping units, and what verify makes of drift.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { DRIFT_SET, compareDriftTable, describeDrift, isBookkeepingSql, isBookkeepingUnit, isDriftTable, mergeSummaries, summarizeDrift } from "../../scripts/cutover/drift.mjs";

const author = (id: string, extra: Record<string, unknown> = {}) => ({ user_id: id, name: `n-${id}`, first_seen_at: "2026-01-01", last_seen_at: "2026-01-02", name_source: "user", ...extra });

describe("the drift comparison (CV26)", () => {
  it("[LDB-CV26] describeDrift counts rows added, removed and columns changed by primary key; summarizeDrift drops the counts", () => {
    const before = { authors: [author("a"), author("b")], nonces: [], events: [{ seq: 1 }] };
    const after = { authors: [author("a", { last_seen_at: "2026-02-01" }), author("b", { name: "new", name_source: "user" }), author("c")], nonces: [{ client_id: "c", nonce: "n", at: "t" }], events: [{ seq: 1 }] };
    const d = describeDrift(before, after);
    expect(Object.keys(d)).toEqual(["authors", "nonces"]);
    expect(d.authors).toEqual({ added: 1, removed: 0, changed: { last_seen_at: 1, name: 1 } });
    expect(summarizeDrift(d)).toEqual({ authors: { rows: "added", columns: ["last_seen_at", "name"] }, nonces: { rows: "added", columns: [] } });
    expect(mergeSummaries({ authors: { rows: "added", columns: ["name"] } }, { authors: { rows: "none", columns: ["last_seen_at"] }, x: { rows: "removed", columns: [] } })).toEqual({ authors: { rows: "added", columns: ["last_seen_at", "name"] }, x: { rows: "removed", columns: [] } });
  });

  it("[LDB-CV26] the pinned set is what the tolerant comparison allows: new rows on the live side, drift columns, nothing else", () => {
    expect(Object.keys(DRIFT_SET).sort()).toEqual(["auth_cache", "authors", "authors_head", "nonces"]);
    expect(isDriftTable("authors")).toBe(true);
    expect(isDriftTable("layouts")).toBe(false);
    const image = [author("a"), author("b")];
    // live: a refreshed, b renamed from Discord, c signed in after the export
    const live = [author("a", { last_seen_at: "2026-11-04" }), author("b", { name: "renamed", name_source: "user" }), author("c")];
    expect(compareDriftTable("authors", image, live)).toEqual({ ok: true, leftOnly: 0, rightOnly: 1, tolerated: { last_seen_at: 1, name: 1 }, bad: {} });
    // a column outside the set differing is a failure
    expect(compareDriftTable("authors", image, [author("a", { first_seen_at: "2020-01-01" }), author("b")])).toMatchObject({ ok: false, bad: { first_seen_at: 1 } });
    // a row that vanished from live is a failure
    expect(compareDriftTable("authors", image, [author("a")])).toMatchObject({ ok: false, leftOnly: 1 });
    // authors_head: the counters drift, a second row or a different id does not
    const head = (extra: Record<string, unknown> = {}) => ({ id: 1, version: 3, modified_at: "t", count: 32, ...extra });
    expect(compareDriftTable("authors_head", [head()], [head({ version: 9, count: 40, modified_at: "u" })])).toMatchObject({ ok: true, tolerated: { version: 1, count: 1, modified_at: 1 } });
    expect(compareDriftTable("authors_head", [head()], [head(), head({ id: 2 })])).toMatchObject({ ok: false, rightOnly: 1 }); // rows: "none"
    // nonces: live may hold more, never fewer; D1 JSON shapes (numbers, byte arrays) compare equal to local ones
    const nonce = (n: string) => ({ client_id: "c", nonce: n, at: "t" });
    expect(compareDriftTable("nonces", [nonce("1")], [nonce("1"), nonce("2")])).toMatchObject({ ok: true, rightOnly: 1 });
    expect(compareDriftTable("nonces", [nonce("1"), nonce("2")], [nonce("1")])).toMatchObject({ ok: false, leftOnly: 1 });
    expect(compareDriftTable("auth_cache", [{ token_hash: "h", user_id: "u", name: "n", app_id: null, ok: 1n, expires_at: "a" }], [{ token_hash: "h", user_id: "u", name: "n", app_id: null, ok: 1, expires_at: "b" }])).toMatchObject({ ok: true, tolerated: { expires_at: 1 } });
    // both sides may bookkeep on their own (the original D1 against AWS's capture)
    expect(compareDriftTable("nonces", [nonce("1"), nonce("2")], [nonce("1"), nonce("3")], { extras: "both" })).toMatchObject({ ok: true, leftOnly: 1, rightOnly: 1 });
    expect(compareDriftTable("authors_head", [head()], [], { extras: "both" })).toMatchObject({ ok: false });
    expect(() => compareDriftTable("layouts", [], [])).toThrow(/not a drift table/);
  });

  it("[LDB-CV26] a commit unit is bookkeeping only when every statement is one of the read path's, as written in src/store/d1/auth.ts", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "src", "store", "d1", "auth.ts"), "utf8");
    // every write to the three drift tables in the file, from the statement's first word on
    const writes = [...src.matchAll(/(INSERT INTO (?:nonces|auth_cache|authors) \(|UPDATE (?:authors|auth_cache|nonces) SET|DELETE FROM (?:nonces|auth_cache|authors))[^`"]*/g)].map((m) => m[0]);
    expect(writes.length).toBeGreaterThanOrEqual(5);
    for (const w of writes) {
      if (/^DELETE/.test(w)) expect(isBookkeepingSql(w), `${w.slice(0, 40)} is a job, not a read`).toBe(false); // the nightly prunes
      else expect(isBookkeepingSql(w), w.slice(0, 60)).toBe(true);
    }
    const kinds = new Set(writes.map((w) => /^(INSERT INTO \w+|UPDATE \w+|DELETE FROM \w+)/.exec(w)![1]));
    expect(kinds).toEqual(new Set(["INSERT INTO nonces", "INSERT INTO auth_cache", "INSERT INTO authors", "UPDATE authors", "DELETE FROM nonces", "DELETE FROM auth_cache"]));
    expect(isBookkeepingUnit(["INSERT INTO nonces (client_id, nonce, at) VALUES (?, ?, ?)", "INSERT INTO authors (user_id) VALUES (?)"])).toBe(true);
    expect(isBookkeepingUnit(["INSERT INTO nonces (client_id, nonce, at) VALUES (?, ?, ?)", "INSERT INTO layouts (id) VALUES (?)"])).toBe(false);
    expect(isBookkeepingUnit(["DELETE FROM nonces WHERE at < ?"])).toBe(false); // the nightly prune is a job, not a read
    expect(isBookkeepingUnit([])).toBe(false);
  });
});
