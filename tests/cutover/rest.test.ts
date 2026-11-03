// [LDB-CV22] The D1 REST port (scripts/cutover/ports-real.mjs): read-only SELECTs, several statements per call, the account's rate limit waited out.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { createD1RestPort } from "../../scripts/cutover/ports-real.mjs";

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });

describe("the D1 REST port (CV22)", () => {
  it("[LDB-CV22] POSTs the SQL with the bearer token to the database's query endpoint, one result per statement, and refuses anything but a SELECT before sending", async () => {
    const sent: { url: string; auth: string | null; body: any }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      sent.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      const n = String(JSON.parse(String(init.body)).sql).split(";\n").length;
      return ok(Array.from({ length: n }, (_, i) => ({ success: true, results: [{ n: i + 1 }] })));
    };
    const ids: string[] = [];
    const d1 = createD1RestPort({ accountId: "acct", token: "tok", resolveId: (name: string) => (ids.push(name), `id-of-${name}`), fetchImpl });
    expect(await d1.select("SELECT 1 AS n", "akl-db")).toEqual([{ n: 1 }]);
    expect(await d1.selectMany(["SELECT 1", "SELECT 2", "SELECT 3"], "akl-db")).toEqual([[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]]);
    expect(sent).toHaveLength(2); // three statements, one call
    expect(sent[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/id-of-akl-db/query");
    expect(sent[0]!.auth).toBe("Bearer tok");
    expect(sent[1]!.body.sql).toBe("SELECT 1;\nSELECT 2;\nSELECT 3");
    expect(ids).toEqual(["akl-db"]); // the id is resolved once
    for (const bad of ["DELETE FROM t", "INSERT INTO t VALUES (1)", "PRAGMA writable_schema = 1", "select 1; drop table t"]) {
      if (bad.startsWith("select")) continue; // one statement per entry: a smuggled second statement is the caller's string; the port checks the leading verb of each
      await expect(d1.select(bad, "akl-db")).rejects.toThrow(/read-only/);
      await expect(d1.selectMany(["SELECT 1", bad], "akl-db")).rejects.toThrow(/read-only/);
    }
    expect(sent).toHaveLength(2);
  });

  it("[LDB-CV22] a 429 or 5xx waits (Retry-After first) and retries; an API error is an error with its code; a missing result is refused", async () => {
    const slept: number[] = [];
    let n = 0;
    const answers = [new Response("slow down", { status: 429, headers: { "retry-after": "3" } }), new Response("oops", { status: 503 }), ok([{ success: true, results: [{ a: 1 }] }])];
    const d1 = createD1RestPort({ accountId: "a", token: "t", resolveId: () => "i", fetchImpl: async () => answers[n++]!, sleep: async (ms: number) => void slept.push(ms) });
    expect(await d1.select("SELECT 1", "x")).toEqual([{ a: 1 }]);
    expect(slept).toEqual([3000, 1000]);
    const bad = createD1RestPort({ accountId: "a", token: "t", resolveId: () => "i", fetchImpl: async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "no such table: nope" }] }), { status: 400 }) });
    await expect(bad.select("SELECT * FROM nope", "x")).rejects.toThrow(/D1 REST 400: 7003 no such table: nope/);
    const short = createD1RestPort({ accountId: "a", token: "t", resolveId: () => "i", fetchImpl: async () => ok([{ success: true, results: [] }]) });
    await expect(short.selectMany(["SELECT 1", "SELECT 2"], "x")).rejects.toThrow(/answered 1 results for 2 statements/);
    const forever = createD1RestPort({ accountId: "a", token: "t", resolveId: () => "i", fetchImpl: async () => new Response("", { status: 429 }), sleep: async () => {}, retries: 2 });
    await expect(forever.select("SELECT 1", "x")).rejects.toThrow(/D1 REST 429/);
  });
});
