// The DynamoDB commit log against DynamoDB Local (the only phase-A test that
// needs it; skipped with a clear message when Docker / DynamoDB Local is
// unavailable): append, conflict, ambiguous outcomes, read-back, pagination,
// retries, and the whole replica stack on top.
import { AwsClient } from "aws4fetch";
import { afterAll, describe, expect, it } from "vitest";
import { AmbiguousAppendError, LogEntryTooLargeError, LogThrottledError, type NewLogEntry } from "../../src/replica/log";
import { createDdbLog, logTableDefinition } from "../../src/replica/log-ddb";
import { applyMigrations } from "../../src/replica/migrations";
import { Replica } from "../../src/replica/replica";
import { ENDPOINT, startDdbLocal } from "./ddb-local";
import { FAST, MIGRATIONS_DIR, shimOf } from "./support";

const ddb = await startDdbLocal();
afterAll(() => ddb.stop());
if (!ddb.available) console.warn(`[log-ddb.test.ts] SKIPPED: ${ddb.reason}`);

const creds = { accessKeyId: "local", secretAccessKey: "local" };
const raw = new AwsClient({ ...creds, service: "dynamodb", region: "us-east-2" });
let tableCounter = 0;

async function newTable(): Promise<string> {
  const table = `akldb-log-${process.pid}-${Date.now()}-${tableCounter++}`;
  const res = await raw.fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.CreateTable" }, body: JSON.stringify(logTableDefinition(table)) });
  if (!res.ok) throw new Error(`CreateTable: ${await res.text()}`);
  return table;
}

const entry = (unitId: string, sql = "SELECT 1", params: unknown[] = []): NewLogEntry => ({ unitId, kind: "unit", stmts: [{ sql, params }], hash: "ab".repeat(32) });
const log = (table: string, extra: Partial<Parameters<typeof createDdbLog>[0]> = {}) =>
  createDdbLog({ table, endpoint: ENDPOINT, region: "us-east-2", credentials: creds, sleep: async () => {}, ...extra });

describe.skipIf(!ddb.available)("DynamoDB commit log on DynamoDB Local", () => {
  it("[LDB-SH4] head is 0 on an empty table; append at the head lands as seq 1, 2, 3 and a wrong head is a conflict", async () => {
    const l = log(await newTable());
    expect(await l.head()).toBe(0);
    expect(await l.append(0, entry("a"))).toBe("ok");
    expect(await l.append(1, entry("b"))).toBe("ok");
    expect(await l.append(1, entry("c"))).toBe("conflict"); // stale head
    expect(await l.append(0, entry("d"))).toBe("conflict");
    expect(await l.append(9, entry("e"))).toBe("conflict"); // ahead of the head
    expect(await l.head()).toBe(2);
    expect((await l.get(1))?.unitId).toBe("a");
    expect((await l.get(2))?.unitId).toBe("b");
    expect(await l.get(3)).toBeNull();
  });

  it("[LDB-SH4] racing appends from the same head: exactly one wins, seq stays 1..n", async () => {
    const l = log(await newTable());
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => l.append(0, entry(`r${i}`))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(await l.head()).toBe(1);
    // and under retry loops, no hole and no duplicate
    await Promise.all(
      Array.from({ length: 6 }, async (_, w) => {
        for (let k = 0; k < 4; k++) for (;;) if ((await l.append(await l.head(), entry(`w${w}-${k}`))) === "ok") break;
      }),
    );
    const all = await l.read(0, await l.head());
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(all.map((e) => e.unitId)).size).toBe(25);
  });

  it("[LDB-SH4] entries round-trip: statements, BLOB and null parameters, kind, name, hash", async () => {
    const l = log(await newTable());
    const e: NewLogEntry = { unitId: "u1", kind: "migration", name: "0001_x.sql", at: "2026-11-02 00:00:00", hash: "cd".repeat(32), stmts: [{ sql: "INSERT INTO b VALUES (?, ?, ?, ?)", params: [new Uint8Array([0, 255, 7]), null, "é \u0000", 1.5] }] };
    expect(await l.append(0, e)).toBe("ok");
    expect(await l.get(1)).toEqual({ seq: 1, ...e });
    expect(await l.read(0, 1)).toEqual([{ seq: 1, ...e }]);
  });

  it("[LDB-SH4] read paginates: 90 entries of ~25 KB come back complete and in order across Query pages", async () => {
    const l = log(await newTable());
    const big = "x".repeat(25_000);
    for (let i = 0; i < 90; i++) expect(await l.append(i, entry(`p${i}`, `SELECT '${big}' /* ${i} */`))).toBe("ok");
    const all = await l.read(0, 90);
    expect(all).toHaveLength(90);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 90 }, (_, i) => i + 1));
    expect((await l.read(40, 45)).map((e) => e.seq)).toEqual([41, 42, 43, 44, 45]);
    expect(await l.read(90, 90)).toEqual([]);
  });

  it("[LDB-SH4] a body over 350,000 bytes is refused before it is sent, with a clear error", async () => {
    const l = log(await newTable());
    const err = await l.append(0, entry("big", "x".repeat(351_000))).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogEntryTooLargeError);
    expect((err as Error).message).toMatch(/350000-byte/);
    expect(await l.head()).toBe(0);
    expect(await l.append(0, entry("fits", "x".repeat(300_000)))).toBe("ok");
  });

  it("[LDB-SH6] a socket error after the request left is an AmbiguousAppendError, and read-back tells whether it landed", async () => {
    const table = await newTable();
    let drop = true;
    const flaky = log(table, {
      fetch: async (req) => {
        const res = await fetch(req); // the request really goes through ...
        const body = await res.clone().text();
        if (drop && String(req.headers.get("x-amz-target")).endsWith("TransactWriteItems")) {
          drop = false;
          void body;
          throw new TypeError("fetch failed: socket hang up"); // ... but we never see the answer
        }
        return res;
      },
    });
    const err = await flaky.append(0, entry("lost-answer")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousAppendError);
    expect((await flaky.get(1))?.unitId).toBe("lost-answer"); // it did land: the read-back finds our unit id
    expect(await flaky.head()).toBe(1);
  });

  it("[LDB-SH6] a timeout is ambiguous too (the abort signal fires)", async () => {
    const table = await newTable();
    const slow = log(table, { timeoutMs: 1, retries: 0 });
    const err = await slow.append(0, entry("t")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousAppendError);
  });

  it("[LDB-SH6] a 5xx whose first try committed is retried with the unit id as the idempotency token: ok, not conflict, and one entry", async () => {
    const table = await newTable();
    let injected = false;
    const l = log(table, {
      fetch: async (req) => {
        const res = await fetch(req);
        if (!injected && String(req.headers.get("x-amz-target")).endsWith("TransactWriteItems")) {
          injected = true;
          return new Response(JSON.stringify({ __type: "com.amazon.coral.availability#ServiceUnavailableException", message: "try again" }), { status: 503 });
        }
        return res;
      },
    });
    expect(await l.append(0, entry("once"))).toBe("ok");
    expect(injected).toBe(true);
    expect(await l.head()).toBe(1);
    expect((await l.read(0, 5)).map((e) => e.unitId)).toEqual(["once"]);
  });

  it("[LDB-SH6] throttling is retried (bounded); when it never clears the error is LogThrottledError and nothing was written", async () => {
    const table = await newTable();
    let n = 0;
    const throttled = (times: number) =>
      log(table, {
        fetch: async (req) => {
          if (n++ < times) return new Response(JSON.stringify({ __type: "com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException", message: "slow down" }), { status: 400 });
          return fetch(req);
        },
      });
    expect(await throttled(2).append(0, entry("after-throttle"))).toBe("ok");
    n = 0;
    const err = await throttled(1000).append(1, entry("never")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogThrottledError);
    expect(await log(table).head()).toBe(1);
  });

  it("[LDB-SH6] a 500 on a read is retried; a persistent one surfaces as LogThrottledError", async () => {
    const table = await newTable();
    let n = 0;
    const l = log(table, { fetch: async (req) => (n++ < 2 ? new Response("{}", { status: 500 }) : fetch(req)) });
    expect(await l.head()).toBe(0);
    const dead = log(table, { fetch: async () => new Response("{}", { status: 500 }) });
    await expect(dead.head()).rejects.toBeInstanceOf(LogThrottledError);
  });
});

describe.skipIf(!ddb.available)("replicas on the DynamoDB log", () => {
  it("[LDB-SH4] migrations through DynamoDB, concurrent writers on two replicas, a third replica replaying: all byte-identical", async () => {
    const l = log(await newTable());
    const a = new Replica(l, FAST);
    const b = new Replica(l, FAST);
    await applyMigrations(a, MIGRATIONS_DIR, () => new Date("2026-11-02T00:00:00Z"));
    await b.catchUp();
    await Promise.all(
      [a, b].map(async (r, who) => {
        const db = shimOf(r);
        for (let k = 0; k < 12; k++) await db.prepare("INSERT INTO nonces (client_id, nonce, at) VALUES (?, ?, ?)").bind(`c${who}`, `n${k}`, "2026-11-02T00:00:00Z").run();
      }),
    );
    const c = new Replica(l, FAST);
    await Promise.all([a.catchUp(), b.catchUp(), c.catchUp()]);
    expect(a.seq).toBe(await l.head());
    for (const r of [b, c]) expect(Buffer.from(r.serialize()).equals(Buffer.from(a.serialize()))).toBe(true);
    expect((await shimOf(c).prepare("SELECT COUNT(*) AS n FROM nonces").first<{ n: number }>())!.n).toBe(24);
    const entries = await l.read(0, a.seq);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: a.seq }, (_, i) => i + 1));
  });

  it("[LDB-SH6] a unit whose answer is lost on the wire is applied exactly once through the replica's read-back", async () => {
    const table = await newTable();
    const plain = log(table);
    const seed = new Replica(plain, FAST);
    await applyMigrations(seed, MIGRATIONS_DIR, () => new Date("2026-11-02T00:00:00Z"));
    let drop = false;
    const lossy = log(table, {
      fetch: async (req) => {
        const res = await fetch(req);
        if (drop && String(req.headers.get("x-amz-target")).endsWith("TransactWriteItems")) {
          drop = false;
          throw new TypeError("fetch failed");
        }
        return res;
      },
    });
    const r = new Replica(lossy, FAST);
    await r.catchUp();
    drop = true;
    await shimOf(r).prepare("INSERT INTO nonces (client_id, nonce, at) VALUES ('c', 'once', 't')").run();
    expect(r.stats.ambiguous).toBe(1);
    expect((await plain.read(0, await plain.head())).filter((e) => e.stmts.some((s) => s.sql.includes("'once'"))).length).toBe(1);
    expect((await shimOf(r).prepare("SELECT COUNT(*) AS n FROM nonces").first<{ n: number }>())!.n).toBe(1);
  });
});
