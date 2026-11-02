// [LDB-SH4] the log is gap-free and totally ordered: an append succeeds only
// if the head is what the writer expected, so seq is 1..n with no hole and no
// duplicate, however many writers race.
import { describe, expect, it } from "vitest";
import { AmbiguousAppendError, LogEntryTooLargeError, decodeBody, encodeBody, type NewLogEntry } from "../../src/replica/log";
import { MemoryLog } from "../../src/replica/log-memory";
import { Replica } from "../../src/replica/replica";
import { FAST, freshReplica, migratedLog, replicaOf, shimOf } from "./support";

const entry = (unitId: string, sql = "SELECT 1"): NewLogEntry => ({ unitId, kind: "unit", stmts: [{ sql, params: [] }], hash: "0".repeat(64) });

describe("memory commit log", () => {
  it("[LDB-SH4] append succeeds only at the expected head; a wrong head is a conflict that changes nothing", async () => {
    const log = new MemoryLog();
    expect(await log.head()).toBe(0);
    expect(await log.append(0, entry("a"))).toBe("ok");
    expect(await log.append(0, entry("b"))).toBe("conflict");
    expect(await log.append(5, entry("c"))).toBe("conflict");
    expect(await log.head()).toBe(1);
    expect((await log.get(1))?.unitId).toBe("a");
    expect(await log.get(2)).toBeNull();
    expect(await log.get(0)).toBeNull();
  });

  it("[LDB-SH4] racing appends on the same head: exactly one wins, and seq stays 1..n with no hole", async () => {
    const log = new MemoryLog({ maxYields: 3, seed: 7 });
    const wins: string[] = [];
    // 8 writers, each retries from the head it reads, 5 entries each.
    await Promise.all(
      Array.from({ length: 8 }, async (_, w) => {
        for (let k = 0; k < 5; k++) {
          const id = `w${w}-${k}`;
          for (;;) {
            const head = await log.head();
            if ((await log.append(head, entry(id))) === "ok") break;
          }
          wins.push(id);
        }
      }),
    );
    const all = log.entries();
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(new Set(all.map((e) => e.unitId)).size).toBe(40);
    expect(wins).toHaveLength(40);
  });

  it("[LDB-SH4] read(after, upTo) returns exactly the entries in between, in order", async () => {
    const log = new MemoryLog();
    for (let i = 0; i < 6; i++) await log.append(i, entry(`e${i}`));
    expect((await log.read(2, 5)).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect((await log.read(0, 100)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await log.read(6, 6)).toEqual([]);
  });

  it("[LDB-SH4] entries survive the JSON body codec: BLOB parameters, exec flags, migration names", () => {
    const e: NewLogEntry = { unitId: "u", kind: "migration", name: "0001_x.sql", at: "2026-11-02 00:00:00", hash: "h", stmts: [{ sql: "INSERT INTO b VALUES (?, ?, ?)", params: [new Uint8Array([0, 1, 255]), null, "é\u0000"] }, { sql: "CREATE TABLE z (a)", params: [], exec: true }] };
    const back = decodeBody(encodeBody(e));
    expect(back.stmts[0]!.params[0]).toBeInstanceOf(Uint8Array);
    expect(back).toEqual({ stmts: e.stmts, hash: "h", name: "0001_x.sql", at: "2026-11-02 00:00:00" });
  });

  it("[LDB-SH4] a body over the item budget is refused with a clear error (the DynamoDB log's 350,000 bytes)", async () => {
    const log = new MemoryLog({ maxBodyBytes: 1000 });
    await expect(log.append(0, entry("big", "x".repeat(2000)))).rejects.toBeInstanceOf(LogEntryTooLargeError);
    expect(await log.head()).toBe(0);
  });

  it("[LDB-SH4] an ambiguous outcome is a distinct error class", async () => {
    const log = new MemoryLog();
    log.forceNext("timeoutBefore");
    const err = await log.append(0, entry("a")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousAppendError);
    expect(err).not.toBeInstanceOf(LogEntryTooLargeError);
  });
});

describe("replicas on one log", () => {
  it("[LDB-SH4] concurrent writers on three replicas produce a gap-free log and the same database everywhere", async () => {
    const log = await migratedLog({ maxYields: 4, seed: 11 });
    const replicas = await Promise.all([1, 2, 3].map(() => replicaOf(log)));
    await shimOf(replicas[0]!).exec("CREATE TABLE w (id INTEGER PRIMARY KEY AUTOINCREMENT, who INTEGER, k INTEGER)");
    await Promise.all(
      replicas.map(async (r, who) => {
        const db = shimOf(r);
        for (let k = 0; k < 10; k++) await db.prepare("INSERT INTO w (who, k) VALUES (?, ?)").bind(who, k).run();
      }),
    );
    const entries = log.entries();
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: entries.length }, (_, i) => i + 1));
    for (const r of replicas) await r.catchUp();
    const [a, b, c] = replicas.map((r) => Buffer.from(r.serialize()));
    expect(a!.equals(b!)).toBe(true);
    expect(a!.equals(c!)).toBe(true);
    expect((await shimOf(replicas[0]!).prepare("SELECT COUNT(*) AS n FROM w").first<{ n: number }>())!.n).toBe(30);
  });

  it("[LDB-SH4] a fresh replica that replays the log from 0 equals a replica that wrote it", async () => {
    const { log, replica } = await freshReplica();
    const db = shimOf(replica);
    await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)");
    for (let i = 0; i < 7; i++) await db.prepare("INSERT INTO r (a) VALUES (?)").bind(`v${i}`).run();
    await db.prepare("DELETE FROM r WHERE id IN (2, 4)").run();
    const fresh = new Replica(log, FAST);
    await fresh.catchUp();
    expect(fresh.seq).toBe(replica.seq);
    expect(Buffer.from(fresh.serialize()).equals(Buffer.from(replica.serialize()))).toBe(true);
  });
});
