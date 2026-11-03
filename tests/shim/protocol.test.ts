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

  it("[LDB-SH7] a request whose snapshot went stale: its CAS UPDATE ... WHERE rev = ? re-executes on the newer state and answers what D1 would (0 changes)", async () => {
    const req = shimOf(b, true);
    expect((await counter(req)).rev).toBe(0); // the request's snapshot: rev 0
    await da.prepare("UPDATE ctr SET n = 100, rev = rev + 1 WHERE id = 1 AND rev = 0").run(); // another replica commits
    const before = log.length;
    const cas = await req.prepare("UPDATE ctr SET n = 200, rev = rev + 1 WHERE id = 1 AND rev = 0").run();
    expect(cas.meta.changes).toBe(0); // on D1 the winner's rev is already 1, so a rev = 0 guard matches nothing
    expect(log.length).toBe(before); // the stale attempt rolled back; the re-executed no-op logs nothing
    expect(await counter(req)).toEqual({ n: 100, rev: 1 }); // and the request now sees its own re-execution's state
    // The same unit when the guard still holds on the newer state commits there, after the retry.
    const win = await req.prepare("UPDATE ctr SET n = n + 1, rev = rev + 1 WHERE id = 1 AND rev = 1 RETURNING n, rev").first();
    expect(win).toEqual({ n: 101, rev: 2 });
    expect(log.length).toBe(before + 1);
  });

  it("[LDB-SH7] a unit that changes nothing is linearized at the request's snapshot: not logged, answered from the snapshot", async () => {
    const req = shimOf(b, true);
    expect((await counter(req)).n).toBe(0);
    await da.prepare("UPDATE ctr SET n = 7 WHERE id = 1").run(); // lands after the request's snapshot
    const before = log.length;
    const noop = await req.prepare("UPDATE ctr SET n = 9 WHERE id = 1 AND rev = 99").run(); // matches nothing at the snapshot
    expect(noop.meta.changes).toBe(0);
    expect(log.length).toBe(before);
    expect((await counter(req)).n).toBe(0); // the snapshot answer, not the newer commit's
  });

  it("[LDB-SH7] a database that is not request-scoped catches up before every statement", async () => {
    const heads = log.counts.heads;
    for (let i = 0; i < 3; i++) await db.prepare("SELECT n FROM ctr").first();
    expect(log.counts.heads - heads).toBe(3);
  });
});

describe("real time under a frozen test clock", () => {
  it("[LDB-SH5] the default backoff keeps real time when a test has installed fake timers: conflicted units still land", async () => {
    // tests/api/dump.test.ts and tests/rehost.test.ts call vi.useFakeTimers(); before src/replica/timers.ts the
    // replica's default setTimeout backoff froze with them and the 20% fault run hung idle in both files.
    const { vi } = await import("vitest");
    const { log: flog, replica } = await freshReplica({}, { backoffMs: 5 }); // the default (real-time) sleep
    const d = shimOf(replica);
    await createCounter(d);
    flog.setFaults({ conflict: 0.5, seed: 7 });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 10; i++) await d.prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
      expect((await counter(d)).n).toBe(10);
      expect(replica.stats.retries).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("last_insert_rowid across retries and replicas", () => {
  it("[LDB-SH5] a retried unit reports D1's meta.last_row_id: an aborted attempt's INSERT never leaks into the retry", async () => {
    // SQLite keeps last_insert_rowid() across ROLLBACK. Found by the 20% fault run (d1-meta-parity: a guarded batch's UPDATE
    // reported the aborted attempt's inserted rowid, 28, instead of the pre-unit 10).
    const { log: flog, replica } = await freshReplica({}, FAST);
    const d = shimOf(replica);
    await d.exec("CREATE TABLE lr (id INTEGER PRIMARY KEY, v INTEGER NOT NULL); CREATE TABLE lr_log (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT)");
    await d.prepare("INSERT INTO lr (id, v) VALUES (1, 0)").run();
    await d.prepare("INSERT INTO lr_log (msg) VALUES ('seed')").run(); // last_insert_rowid() = 1
    const before = (await d.prepare("SELECT 1").run()).meta.last_row_id;
    flog.setFaults({ conflict: 1 }); // the first append conflicts...
    let first = true;
    const realAppend = flog.append.bind(flog);
    flog.append = async (h, e) => {
      if (first) {
        first = false;
        return "conflict";
      }
      flog.setFaults({});
      return realAppend(h, e);
    };
    const out = await d.batch([
      d.prepare("UPDATE lr SET v = v + 1 WHERE id = 1"),
      d.prepare("INSERT INTO lr_log (msg) SELECT 'claimed' WHERE changes() = 1"),
    ]);
    expect(replica.stats.retries).toBe(1);
    expect(out[0]!.meta.last_row_id).toBe(before); // the UPDATE inserted nothing: the pre-unit value, as on D1
    expect(out[1]!.meta.last_row_id).toBe(2);
    expect((await d.prepare("SELECT 1").run()).meta.last_row_id).toBe(2);
  });

  it("[LDB-SH8] replay restores the writer's last_insert_rowid: SQL reading it before its own insert replays identically on a snapshot-booted replica", async () => {
    const { log, replica: a } = await freshReplica({}, FAST);
    const da = shimOf(a);
    await da.exec("CREATE TABLE p (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT); CREATE TABLE q (id INTEGER PRIMARY KEY AUTOINCREMENT, ref INTEGER)");
    await da.prepare("INSERT INTO p (v) VALUES ('x')").run();
    await da.prepare("INSERT INTO p (v) VALUES ('y')").run(); // a's connection: last_insert_rowid() = 2
    // b boots from a snapshot of a: a fresh connection, last_insert_rowid() = 0
    const b = Replica.fromSnapshot(log, a.serialize(), a.seq, FAST);
    // a unit whose SQL reads last_insert_rowid() before inserting anything: the writer saw 2
    await da.prepare("INSERT INTO q (ref) SELECT last_insert_rowid()").run();
    await b.catchUp();
    expect(b.dead).toBeNull(); // without the logged lrid the replay computes ref = 0, the changeset hash differs and b halts
    const db = shimOf(b);
    expect((await db.prepare("SELECT ref FROM q").first<{ ref: number }>())!.ref).toBe(2);
    expect((await da.prepare("SELECT ref FROM q").first<{ ref: number }>())!.ref).toBe(2);
  });
});
