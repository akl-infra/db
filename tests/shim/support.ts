// Shared helpers for tests/shim/**: replicas on a memory log, with the real migrations applied through the log.
import path from "node:path";
import { MemoryLog, type MemoryLogFaults } from "../../src/replica/log-memory";
import { applyMigrations } from "../../src/replica/migrations";
import { Replica, type ReplicaOptions } from "../../src/replica/replica";
import { createShimD1 } from "../../src/store/shim/d1";
import { createD1Store } from "../../src/store/d1";

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "..", "migrations");
export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Fast, deterministic replica options: no real sleeping. */
export const FAST: ReplicaOptions = { sleep: async () => {}, backoffMs: 0 };

let template: MemoryLog | undefined;

/** A memory log holding the 37 real migrations (built once per file, cloned per call). */
export async function migratedLog(faults: MemoryLogFaults = {}): Promise<MemoryLog> {
  if (template === undefined) {
    const log = new MemoryLog();
    await applyMigrations(new Replica(log, FAST), MIGRATIONS_DIR, () => new Date("2026-11-02T00:00:00Z"));
    template = log;
  }
  return template.clone(faults);
}

/** A replica of `log`, caught up. */
export async function replicaOf(log: MemoryLog, opts: ReplicaOptions = FAST): Promise<Replica> {
  const r = new Replica(log, opts);
  await r.catchUp();
  return r;
}

export async function freshReplica(faults: MemoryLogFaults = {}, opts: ReplicaOptions = FAST): Promise<{ log: MemoryLog; replica: Replica }> {
  const log = await migratedLog(faults);
  return { log, replica: await replicaOf(log, opts) };
}

export const shimOf = (replica: Replica, requestScoped = false): D1Database => createShimD1(replica, { requestScoped });
export const storeOf = (replica: Replica) => createD1Store(createShimD1(replica));

/** A conditional-write scratch table for the protocol tests (one row, a counter and a revision). */
export async function createCounter(db: D1Database): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS ctr (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, rev INTEGER NOT NULL)");
  await db.prepare("INSERT OR IGNORE INTO ctr (id, n, rev) VALUES (1, 0, 0)").run();
}
