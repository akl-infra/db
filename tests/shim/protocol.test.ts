// [LDB-SH5] a conflict rolls back, catches up and re-executes the unit against
// the newer state (D1's own serialization); [LDB-SH6] an ambiguous append is
// resolved by reading the unit id back and the unit is applied exactly once;
// [LDB-SH7] each request reads the head once, strongly, before its first statement.
import { beforeEach, describe, expect, it } from "vitest";
import type { CommitLog, LogEntry, NewLogEntry } from "../../src/replica/log";
import { MemoryLog } from "../../src/replica/log-memory";
import { Replica } from "../../src/replica/replica";
import { createCounter, FAST, freshReplica, replicaOf, shimOf } from "./support";

let log: MemoryLog;
let a: Replica;
let b: Replica;
let da: D1Database;
let db: D1Database;

beforeEach(async () => {
  ({ log, replica: a } = await freshReplica());
  da = shimOf(a);
  await createCounter(da);
  b = await replicaOf(log);
  db = shimOf(b);
});

const counter = async (d: D1Database) => (await d.prepare("SELECT n, rev FROM ctr WHERE id = 1").first<{ n: number; rev: number }>())!;

describe("conflict handling", () => {
  it("[LDB-SH5] a unit that lost the race re-executes against the newer state: UPDATE ... RETURNING sees the winner's write", async () => {
    // B's request has synced (fresh), then A commits, then B's unit runs from its stale seq.
    const staleSeq = b.seq;
    await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run(); // A wins seq+1
    expect(b.seq).toBe(staleSeq);
    const [out] = await b.runUnit([{ sql: "UPDATE ctr SET n = n + 1 WHERE id = 1 RETURNING n", params: [] }], { fresh: true });
    expect(out!.rows).toEqual([{ n: 2 }]); // not 1: the retry ran on the state that includes A's commit
    expect(b.stats.conflicts).toBe(1);
    expect(b.stats.retries).toBe(1);
    expect(log.length).toBe(staleSeq + 2);
    expect((await counter(db)).n).toBe(2);
  });

  it("[LDB-SH5] akldb's own CAS guard decides after a conflict: the stale writer's `WHERE rev = ?` matches nothing on the newer state and logs nothing", async () => {
    await da.prepare("UPDATE ctr SET n = 100, rev = rev + 1 WHERE id = 1 AND rev = 0").run(); // A: rev 0 -> 1
    const before = log.length;
    const [out] = await b.runUnit([{ sql: "UPDATE ctr SET n = 200, rev = rev + 1 WHERE id = 1 AND rev = 0", params: [] }], { fresh: true });
    expect(out!.changes).toBe(0);
    expect(log.length).toBe(before); // the retried unit was a no-op, so nothing was appended
    expect(await counter(db)).toEqual({ n: 100, rev: 1 });
  });

  it("[LDB-SH5] an injected conflict (nothing else wrote) rolls back and the unit lands once", async () => {
    const before = log.length;
    log.forceNext("conflict", "conflict");
    await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect(log.length).toBe(before + 1);
    expect(a.stats.conflicts).toBe(2);
    expect((await counter(da)).n).toBe(1);
  });

  it("[LDB-SH5] twenty-five straight conflicts end in D1_ERROR: commit log contention, with nothing left behind", async () => {
    const before = log.length;
    log.forceNext(...Array.from({ length: 25 }, () => "conflict" as const));
    const err = await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run().catch((e: unknown) => e as Error);
    expect((err as Error).message).toMatch(/^D1_ERROR: commit log contention/);
    expect(log.length).toBe(before);
    expect((await counter(da)).n).toBe(0); // the local transaction was rolled back every time
    expect((await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run()).meta.changes).toBe(1); // and the replica is still usable
  });

  it("[LDB-SH5] throttling is retried without re-running the unit", async () => {
    log.forceNext("throttle", "throttle", "throttle");
    await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect(a.stats.throttled).toBe(3);
    expect((await counter(da)).n).toBe(1);
    expect(log.length).toBe(a.seq);
  });
});

describe("ambiguous appends", () => {
  it("[LDB-SH6] a timeout AFTER the commit: read-back finds our unit id, the unit is applied exactly once", async () => {
    const before = log.length;
    log.forceNext("timeoutAfter");
    const r = await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect(r.meta.changes).toBe(1);
    expect(log.length).toBe(before + 1);
    expect(a.stats.ambiguous).toBe(1);
    expect((await counter(da)).n).toBe(1);
    expect((await counter(db)).n).toBe(1); // and so everywhere else
    expect(log.entries().filter((e) => e.stmts.some((s) => s.sql.startsWith("UPDATE ctr"))).length).toBe(1);
  });

  it("[LDB-SH6] a timeout BEFORE the commit: nothing at seq+1, so the append is retried with the SAME unit id, once", async () => {
    const seen: string[] = [];
    const spy: CommitLog = {
      head: () => log.head(),
      read: (x, y) => log.read(x, y),
      get: (s) => log.get(s),
      append: (h: number, e: NewLogEntry) => (seen.push(e.unitId), log.append(h, e)),
    };
    const r = new Replica(spy, FAST);
    await r.catchUp();
    log.forceNext("timeoutBefore");
    await shimOf(r).prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1);
    expect((await counter(shimOf(r))).n).toBe(1);
  });

  it("[LDB-SH6] a timeout where ANOTHER unit took seq+1: our attempt is rolled back and re-run on the newer state, still once", async () => {
    // B's first append times out before commit while A sneaks in: B's read-back finds A's entry, not ours.
    let raced = false;
    const racing: CommitLog = {
      head: () => log.head(),
      read: (x, y) => log.read(x, y),
      get: (s) => log.get(s),
      async append(h, e) {
        if (!raced) {
          raced = true;
          await da.prepare("UPDATE ctr SET n = n + 10 WHERE id = 1").run(); // A commits first
          log.forceNext("timeoutBefore");
        }
        return log.append(h, e);
      },
    };
    const r = new Replica(racing, FAST);
    await r.catchUp();
    await shimOf(r).prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect((await counter(da)).n).toBe(11);
    expect((await counter(shimOf(r))).n).toBe(11);
    expect(log.entries().filter((e) => e.stmts.some((s) => s.sql === "UPDATE ctr SET n = n + 1 WHERE id = 1")).length).toBe(1);
  });

  it("[LDB-SH6] a late-landing copy of our own entry after a timeout is recognised on the next conflict: no double application", async () => {
    // First try: timeout BEFORE the commit as far as the read-back can tell; the request then lands late (here: right after the read-back).
    let phase = 0;
    const late: CommitLog = {
      head: () => log.head(),
      read: (x, y) => log.read(x, y),
      get: (s) => log.get(s),
      async append(h, e) {
        if (phase === 0) {
          phase = 1;
          throw new (await import("../../src/replica/log")).AmbiguousAppendError("lost on the wire");
        }
        if (phase === 1) {
          phase = 2;
          await log.append(h, e); // the delayed first request lands now
          return log.append(h, e); // our retry: conflict, because seq+1 is taken by ourselves
        }
        return log.append(h, e);
      },
    };
    const r = new Replica(late, FAST);
    await r.catchUp();
    await shimOf(r).prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect((await counter(shimOf(r))).n).toBe(1);
    expect(log.entries().filter((e) => e.stmts.some((s) => s.sql === "UPDATE ctr SET n = n + 1 WHERE id = 1")).length).toBe(1);
  });

  it("[LDB-SH6] under 30% mixed faults every acknowledged write lands exactly once", async () => {
    const faulty = log.clone({ conflict: 0.075, throttle: 0.075, timeoutBefore: 0.075, timeoutAfter: 0.075, seed: 5, maxYields: 2 });
    const r = await replicaOf(faulty);
    const d = shimOf(r);
    let acked = 0;
    for (let i = 0; i < 60; i++) {
      await d.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
      acked++;
    }
    expect((await counter(d)).n).toBe(acked);
    expect(faulty.entries().filter((e) => e.stmts.some((s) => s.sql.startsWith("UPDATE ctr"))).length).toBe(acked);
    expect(faulty.counts.timeoutsAfter + faulty.counts.timeoutsBefore + faulty.counts.injectedConflicts + faulty.counts.throttles).toBeGreaterThan(5);
  });
});

describe("the request snapshot", () => {
  it("[LDB-SH7] a request-scoped database reads the head exactly once, however many statements it runs", async () => {
    const heads = log.counts.heads;
    const req = shimOf(a, true);
    for (let i = 0; i < 6; i++) await req.prepare("SELECT n FROM ctr").first();
    await req.batch([req.prepare("SELECT 1"), req.prepare("SELECT 2")]);
    expect(log.counts.heads - heads).toBe(1);
  });

  it("[LDB-SH7] a request that reads and then writes still reads the head once: the write goes straight to its append", async () => {
    const heads = log.counts.heads;
    const req = shimOf(a, true);
    await req.prepare("SELECT n FROM ctr").first();
    await req.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect(log.counts.heads - heads).toBe(1);
  });

  it("[LDB-SH7] statements racing for a request's first read share one head read", async () => {
    const heads = log.counts.heads;
    const req = shimOf(a, true);
    await Promise.all([req.prepare("SELECT 1").all(), req.prepare("SELECT 2").all(), req.prepare("SELECT 3").all()]);
    expect(log.counts.heads - heads).toBe(1);
  });

  it("[LDB-SH7] the first statement sees every unit committed before the request began, even on a replica that was behind", async () => {
    await da.prepare("UPDATE ctr SET n = 41 WHERE id = 1").run();
    await da.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    expect(b.seq).toBeLessThan(a.seq); // B has not heard of either
    const req = shimOf(b, true);
    expect((await req.prepare("SELECT n FROM ctr WHERE id = 1").first<{ n: number }>())!.n).toBe(42);
  });

  it("[LDB-SH7] a request keeps its snapshot: a later statement does not re-read the head, a new request does", async () => {
    const req = shimOf(b, true);
    await req.prepare("SELECT n FROM ctr").first();
    await da.prepare("UPDATE ctr SET n = 7 WHERE id = 1").run();
    expect((await req.prepare("SELECT n FROM ctr").first<{ n: number }>())!.n).toBe(0);
    expect((await shimOf(b, true).prepare("SELECT n FROM ctr").first<{ n: number }>())!.n).toBe(7);
  });

  it("[LDB-SH7] a database that is not request-scoped catches up before every statement", async () => {
    const heads = log.counts.heads;
    for (let i = 0; i < 3; i++) await db.prepare("SELECT n FROM ctr").first();
    expect(log.counts.heads - heads).toBe(3);
  });
});
