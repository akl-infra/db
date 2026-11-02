// [LDB-SH8] replicas replay statements (never changesets) and verify the
// writer's changeset hash; a mismatch halts the replica.
import { describe, expect, it, vi } from "vitest";
import type { CommitLog, LogEntry } from "../../src/replica/log";
import { ReplicaDivergedError, Replica } from "../../src/replica/replica";
import { createD1Store } from "../../src/store/d1";
import { createShimD1 } from "../../src/store/shim/d1";
import { createCounter, FAST, freshReplica, replicaOf, shimOf } from "./support";

/** A view of `log` whose entries pass through `mutate` (a corrupted copy, a tampering middlebox). */
function tampered(log: CommitLog, mutate: (e: LogEntry) => LogEntry): CommitLog {
  return {
    head: () => log.head(),
    append: (h, e) => log.append(h, e),
    get: async (s) => {
      const e = await log.get(s);
      return e === null ? null : mutate(e);
    },
    read: async (x, y) => (await log.read(x, y)).map(mutate),
  };
}

describe("replay and verification", () => {
  it("[LDB-SH8] akldb's 10 triggers fire exactly once on a replica: the store's writes replicate to an identical database", async () => {
    const { log, replica } = await freshReplica();
    const store = createD1Store(createShimD1(replica));
    const t = "2026-11-02T00:00:00.000Z";
    await store.admin.setAuthorNameByAdmin("u1", "Ann", t); // authors insert/rename triggers -> authors_head, count
    await store.admin.setAuthorNameByAdmin("u1", "Anna", t);
    await shimOf(replica).prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at) VALUES ('L1', 'One', 'u1', 1, 1, ?, ?)").bind(t, t).run(); // layouts_head trigger
    const other = await replicaOf(log);
    expect(Buffer.from(other.serialize()).equals(Buffer.from(replica.serialize()))).toBe(true);
    const heads = await shimOf(other).prepare("SELECT (SELECT version FROM authors_head) AS av, (SELECT count FROM authors_head) AS ac").first();
    expect(heads).toEqual(await shimOf(replica).prepare("SELECT (SELECT version FROM authors_head) AS av, (SELECT count FROM authors_head) AS ac").first());
  });

  it("[LDB-SH8] replicas never apply changesets: catching up works with applyChangeset forbidden", async () => {
    const { log, replica } = await freshReplica();
    await createCounter(shimOf(replica));
    await shimOf(replica).prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    const other = new Replica(log, FAST);
    const spy = vi.spyOn(other.db, "applyChangeset").mockImplementation(() => {
      throw new Error("applyChangeset must never be used: it fires triggers on the replica");
    });
    await other.catchUp();
    expect(spy).not.toHaveBeenCalled();
    expect(other.seq).toBe(replica.seq);
  });

  it("[LDB-SH8] a logged hash that does not match the replay halts the replica: ReplicaDivergedError now and on every later call", async () => {
    const { log, replica } = await freshReplica();
    await createCounter(shimOf(replica));
    await shimOf(replica).prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    const bad = new Replica(
      tampered(log, (e) => (e.seq === log.length ? { ...e, hash: "f".repeat(64) } : e)),
      FAST,
    );
    await expect(bad.catchUp()).rejects.toBeInstanceOf(ReplicaDivergedError);
    expect(bad.dead).toBeInstanceOf(ReplicaDivergedError);
    expect(bad.seq).toBe(log.length - 1); // the diverging entry was rolled back, not half-applied
    await expect(bad.catchUp()).rejects.toBe(bad.dead);
    await expect(bad.runUnit([{ sql: "SELECT 1", params: [] }])).rejects.toBe(bad.dead);
    await expect(shimOf(bad).prepare("SELECT 1").first()).rejects.toBe(bad.dead);
  });

  it("[LDB-SH8] a statement whose parameters were altered in the log is caught by the hash even though it replays cleanly", async () => {
    const { log, replica } = await freshReplica();
    await createCounter(shimOf(replica));
    await shimOf(replica).prepare("UPDATE ctr SET n = ? WHERE id = 1").bind(5).run();
    const bad = new Replica(
      tampered(log, (e) => (e.stmts.some((s) => s.sql.startsWith("UPDATE ctr")) ? { ...e, stmts: e.stmts.map((s) => ({ ...s, params: [6] })) } : e)),
      FAST,
    );
    await expect(bad.catchUp()).rejects.toBeInstanceOf(ReplicaDivergedError);
  });

  it("[LDB-SH8] a statement that cannot replay at all also halts the replica instead of skipping it", async () => {
    const { log, replica } = await freshReplica();
    await createCounter(shimOf(replica));
    await shimOf(replica).prepare("UPDATE ctr SET n = n + 1 WHERE id = 1").run();
    const bad = new Replica(
      tampered(log, (e) => (e.stmts.some((s) => s.sql.startsWith("UPDATE ctr")) ? { ...e, stmts: [{ sql: "UPDATE no_such_table SET x = 1", params: [] }] } : e)),
      FAST,
    );
    await expect(bad.catchUp()).rejects.toBeInstanceOf(ReplicaDivergedError);
    expect(bad.dead).not.toBeNull();
  });

  it("[LDB-SH8] a log that loses entries (its head falls behind this replica) also halts it", async () => {
    const { log, replica } = await freshReplica();
    await createCounter(shimOf(replica));
    let shrink = false;
    const view: CommitLog = {
      head: async () => (shrink ? replica.seq - 1 : log.head()),
      read: (x, y) => log.read(x, y),
      get: (s) => log.get(s),
      append: (h, e) => log.append(h, e),
    };
    const r = new Replica(view, FAST);
    await r.catchUp();
    expect(r.seq).toBe(replica.seq);
    shrink = true;
    await expect(r.catchUp()).rejects.toBeInstanceOf(ReplicaDivergedError);
    expect(r.dead).not.toBeNull();
  });
});
