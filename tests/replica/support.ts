// Helpers for tests/replica/**: replicas on a memory log (with a memory object store) carrying the real migrations,
// deterministic churn that exercises the page layout (inserts, updates, deletes, BLOBs, AUTOINCREMENT), snapshots.
import { MemoryLog } from "../../src/replica/log-memory";
import { MemoryObjects } from "../../src/replica/objects";
import { applyMigrations } from "../../src/replica/migrations";
import { Replica, imageDigest, type ReplicaOptions } from "../../src/replica/replica";
import { MemorySnapshotState, type SnapshotDeps } from "../../src/replica/snapshot";
import { seededRandom } from "../../src/replica/log-memory";
import { createShimD1 } from "../../src/store/shim/d1";
import { FAST, MIGRATIONS_DIR } from "../shim/support";

export { FAST, MIGRATIONS_DIR };

export interface World {
  log: MemoryLog;
  blobs: MemoryObjects;
  objects: MemoryObjects;
  state: MemorySnapshotState;
  /** The writer replica. */
  replica: Replica;
  lines: string[];
  deps: SnapshotDeps;
  clock: { ms: number };
}

/** A world at the real 37 migrations. `clock` is the fake time every snapshot job reads. */
export async function world(start = "2026-11-02T00:00:00Z"): Promise<World> {
  const blobs = new MemoryObjects();
  const log = new MemoryLog({}, blobs);
  const replica = new Replica(log, FAST);
  await applyMigrations(replica, MIGRATIONS_DIR, () => new Date(start));
  const objects = new MemoryObjects();
  const state = new MemorySnapshotState();
  const lines: string[] = [];
  const clock = { ms: Date.parse(start) };
  return { log, blobs, objects, state, replica, lines, clock, deps: { objects, state, logLine: (m) => void lines.push(m), now: () => clock.ms } };
}

/** `n` varied units through the shim: each insert/update/delete/batch is one log entry. Deterministic in `seed`. */
export async function churn(replica: Replica, n: number, seed = 1): Promise<void> {
  const db = createShimD1(replica);
  const rng = seededRandom(seed);
  await db.exec("CREATE TABLE IF NOT EXISTS churn (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL, b BLOB, n INTEGER NOT NULL DEFAULT 0)");
  for (let i = 0; i < n; i++) {
    const r = rng();
    const text = "x".repeat(Math.floor(rng() * 1500)) + String(i);
    if (r < 0.5) await db.prepare("INSERT INTO churn (v, b) VALUES (?, ?)").bind(text, new Uint8Array([i & 255, 1, 2, 3])).run();
    else if (r < 0.7) await db.prepare("UPDATE churn SET v = ?, n = n + 1 WHERE id = (SELECT id FROM churn ORDER BY id LIMIT 1 OFFSET ?)").bind(text, Math.floor(rng() * 5)).run();
    else if (r < 0.85) await db.prepare("DELETE FROM churn WHERE id = (SELECT id FROM churn ORDER BY id DESC LIMIT 1 OFFSET ?)").bind(Math.floor(rng() * 3)).run();
    else
      await db.batch([
        db.prepare("INSERT INTO churn (v) VALUES (?)").bind(text),
        db.prepare("INSERT INTO churn (v, n) VALUES (?, ?)").bind(text.slice(0, 40), i),
        db.prepare("UPDATE churn SET n = n + 1 WHERE id % 7 = 0"),
      ]);
  }
}

export const digestOf = (r: Replica): string => imageDigest(r.serialize());

/** A fresh replica replaying the whole log from seq 0, to compare against. */
export async function replayFrom0(log: MemoryLog, upTo?: number): Promise<Replica> {
  const r = new Replica(log, FAST);
  await r.catchUp(upTo);
  return r;
}

export type { ReplicaOptions };
