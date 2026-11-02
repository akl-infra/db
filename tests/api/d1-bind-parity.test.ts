// [LDB-SH2] bind/readback parity with D1, MEASURED: this file runs unchanged under the `workers` project (miniflare's
// real D1 binding, workerd's SQLite) and the `shim` project (node:sqlite behind the D1 shim) with identical expectations.
// Measured 2026-11-02 on miniflare: every JS number binds as a REAL (so 3 into a TEXT column is "3.0" and
// json_object('a', 3) is {"a":3.0}), booleans as REAL 1.0/0.0 -- NOT as INTEGER -- and an integer above 2^53 read
// back comes as a (lossy) Number rather than an error. Only miniflare was measured; production D1 was not touched.
import { env } from "../harness";
import { beforeAll, describe, expect, it } from "vitest";

const db = (env as unknown as { DB: D1Database }).DB;

async function probe(value: unknown) {
  return db.prepare("SELECT typeof(?) AS t, ? AS v, json_object('a', ?) AS j").bind(value, value, value).first<{ t: string; v: unknown; j: string }>();
}

describe("D1 bind and read-back types", () => {
  it("[LDB-SH2] typeof(), the value read back and json_object output for bound 3, 3.5, true, '3', null", async () => {
    expect(await probe(3)).toEqual({ t: "real", v: 3, j: '{"a":3.0}' });
    expect(await probe(3.5)).toEqual({ t: "real", v: 3.5, j: '{"a":3.5}' });
    expect(await probe(true)).toEqual({ t: "real", v: 1, j: '{"a":1.0}' });
    expect(await probe("3")).toEqual({ t: "text", v: "3", j: '{"a":"3"}' });
    expect(await probe(null)).toEqual({ t: "null", v: null, j: '{"a":null}' });
  });

  it("[LDB-SH2] a Uint8Array binds as a BLOB and reads back as number[]", async () => {
    const r = await db.prepare("SELECT typeof(?) AS t, ? AS v").bind(new Uint8Array([1, 2, 255]), new Uint8Array([1, 2, 255])).first();
    expect(r).toEqual({ t: "blob", v: [1, 2, 255] });
  });

  describe("columns", () => {
    beforeAll(async () => {
      await db.exec("CREATE TABLE bp (id INTEGER PRIMARY KEY, t TEXT, n NUMERIC, i INTEGER)");
    });

    it("[LDB-SH2] a bound integral number lands in a TEXT column as '3.0' and in NUMERIC/INTEGER columns as an integer", async () => {
      await db.prepare("INSERT INTO bp (id, t, n, i) VALUES (1, ?, ?, ?)").bind(3, 3, 3).run();
      expect(await db.prepare("SELECT t, typeof(t) AS tt, typeof(n) AS tn, typeof(i) AS ti, n, i FROM bp WHERE id = 1").first()).toEqual({ t: "3.0", tt: "text", tn: "integer", ti: "integer", n: 3, i: 3 });
    });

    it("[LDB-SH2] an integer above 2^53 stored via SQL reads back as the (lossy) Number, not an error", async () => {
      await db.prepare("INSERT INTO bp (id, i) VALUES (2, 9007199254740994)").run();
      expect(await db.prepare("SELECT i, typeof(i) AS t FROM bp WHERE id = 2").first()).toEqual({ i: 2 ** 53 + 2, t: "integer" });
      expect(await db.prepare("SELECT 9007199254740994 AS v").raw()).toEqual([[2 ** 53 + 2]]);
    });
  });
});
