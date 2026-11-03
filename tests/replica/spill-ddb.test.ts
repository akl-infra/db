// Phase B against DynamoDB Local (skipped with a reason when Docker / DynamoDB Local is unavailable). Port 18447, container
// akldb-ddb-b unless AKLDB_DDB_PORT / AKLDB_DDB_CONTAINER say otherwise. Gate: a real-size dump restore, through the
// existing dump/restore code path, whose largest batch is over 450 KB, lands in the DynamoDB log via S3 spill, replicates
// to a second replica byte for byte, and boots a third from a snapshot whose pointer lives in the same table.
import { AwsClient } from "aws4fetch";
import { afterAll, describe, expect, it } from "vitest";
import frozenSeed from "../fixtures/seed-upstream-100.dump.json" with { type: "json" };
import type { Dump } from "../../src/dump/write";
import { restoreInto, restoreSql } from "../../src/dump/restore";
import { bootReplica, bootReportOf } from "../../src/replica/boot";
import { createDdbLog, createDdbSnapshotState, logTableDefinition } from "../../src/replica/log-ddb";
import { applyMigrations } from "../../src/replica/migrations";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica } from "../../src/replica/replica";
import { SPILL_THRESHOLD, spillKey } from "../../src/replica/spill";
import { rollingKey, writeSnapshot } from "../../src/replica/snapshot";
import { createShimD1 } from "../../src/store/shim/d1";
import { FAST, MIGRATIONS_DIR } from "../shim/support";

// the shared helper reads these when it is first imported
process.env.AKLDB_DDB_PORT ??= "18447";
process.env.AKLDB_DDB_CONTAINER ??= "akldb-ddb-b";
const { ENDPOINT, startDdbLocal } = await import("../shim/ddb-local");
const ddb = await startDdbLocal();
afterAll(() => ddb.stop());
if (!ddb.available) console.warn(`[spill-ddb.test.ts] SKIPPED: ${ddb.reason}`);

const creds = { accessKeyId: "local", secretAccessKey: "local" };
const raw = new AwsClient({ ...creds, service: "dynamodb", region: "us-east-2" });
let n = 0;
async function newTable(): Promise<string> {
  const table = `akldb-b-${process.pid}-${Date.now()}-${n++}`;
  const res = await raw.fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.CreateTable" }, body: JSON.stringify(logTableDefinition(table)) });
  if (!res.ok) throw new Error(`CreateTable: ${await res.text()}`);
  return table;
}
async function rawItem(table: string, pk: string, sk: string): Promise<Record<string, { S?: string; N?: string }> | undefined> {
  const res = await raw.fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.GetItem" }, body: JSON.stringify({ TableName: table, Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }) });
  return ((await res.json()) as { Item?: Record<string, { S?: string; N?: string }> }).Item;
}
const logOn = (table: string, blobs: MemoryObjects) => createDdbLog({ table, endpoint: ENDPOINT, region: "us-east-2", credentials: creds, sleep: async () => {}, blobs });
const stateOn = (table: string) => createDdbSnapshotState({ table, endpoint: ENDPOINT, region: "us-east-2", credentials: creds, sleep: async () => {} });

/** The frozen 100-layout dump, with each format's payload padded so the largest restore batch is over 450 KB (the real DB's batches reach about 458 KB). */
function bigDump(): Dump {
  const d = structuredClone(frozenSeed) as unknown as Dump;
  for (const f of d.layout_formats) f.payload_json = JSON.stringify({ ...(JSON.parse(f.payload_json) as object), pad: "p".repeat(1700) });
  return d;
}
const batchBytes = (dump: Dump): number[] => {
  const st = restoreSql(dump);
  const out: number[] = [];
  for (let i = 0; i < st.length; i += 100) out.push(st.slice(i, i + 100).reduce((a, s) => a + Buffer.byteLength(s, "utf8"), 0));
  return out;
};

describe.skipIf(!ddb.available)("phase B on DynamoDB Local", () => {
  it("[LDB-RP7] a real-size dump restore (one batch over 450 KB) lands through the S3 spill, replicates to a second replica byte for byte, and a third boots from a snapshot", async () => {
    const dump = bigDump();
    expect(Math.max(...batchBytes(dump))).toBeGreaterThanOrEqual(450_000);

    const table = await newTable();
    const blobs = new MemoryObjects();
    const a = new Replica(logOn(table, blobs), FAST);
    await applyMigrations(a, MIGRATIONS_DIR, () => new Date("2026-11-02T00:00:00Z"));
    await restoreInto(createShimD1(a), dump); // the dump/restore code path: restoreSql in batches of 100 statements

    // the big batch is a spill: an S3 key on the log item, no body attribute
    const spilled = blobs.keys("log/");
    expect(spilled.length).toBeGreaterThanOrEqual(1);
    const items = await Promise.all(Array.from({ length: a.seq }, (_, i) => rawItem(table, "LOG", String(i + 1).padStart(12, "0"))));
    const withSpill = items.filter((it) => it?.spill !== undefined);
    expect(withSpill).toHaveLength(spilled.length);
    for (const it of withSpill) {
      expect(it!.body).toBeUndefined();
      expect(it!.spill!.S).toBe(spillKey(it!.unit!.S!));
      expect(it!.spillhash!.S).toMatch(/^[0-9a-f]{64}$/);
    }
    // every inline item fits the 350,000-byte budget; the largest spilled body is over 450 KB of JSON
    for (const it of items.filter((x) => x?.body !== undefined)) expect(Buffer.byteLength(it!.body!.S!, "utf8")).toBeLessThanOrEqual(SPILL_THRESHOLD);
    const biggest = Math.max(...spilled.map((k) => Number(blobs.peek(k)!.meta.size)));
    expect(biggest).toBeGreaterThanOrEqual(450_000);

    // a second replica on its own connection (fresh spiller) replays everything, spills included
    const b = new Replica(logOn(table, blobs), FAST);
    await b.catchUp();
    expect(b.seq).toBe(a.seq);
    expect(Buffer.compare(b.serialize(), a.serialize())).toBe(0);
    expect((b.db.prepare("SELECT count(*) AS n FROM layouts").get() as { n: number }).n).toBe(dump.records.length);

    // a snapshot whose pointer is a DynamoDB item; a third replica boots from it
    const state = stateOn(table);
    const objects = new MemoryObjects();
    const w = await writeSnapshot(a, { objects, state, logLine: () => {} });
    expect(w.status).toBe("written");
    const pointerItem = await rawItem(table, "SNAP", "POINTER");
    expect(pointerItem?.key?.S).toBe(rollingKey(0));
    expect(Number(pointerItem?.seq?.N)).toBe(a.seq);
    const c = await bootReplica(logOn(table, blobs), { ...FAST, snapshots: { state, objects }, logLine: () => {} });
    expect(bootReportOf(c)?.path).toBe("pointer");
    expect(c.seq).toBe(a.seq);
    expect(c.stats.replayed).toBe(0);
    expect(c.db.prepare("SELECT count(*) AS n FROM layouts").get()).toEqual(b.db.prepare("SELECT count(*) AS n FROM layouts").get());
    for (const r of [a, b, c]) r.close();
  }, 120_000);

  it("[LDB-RP1] the DynamoDB pointer only moves up, keeps the old one as PREV, and a racing writer cannot make PREV wrong", async () => {
    const table = await newTable();
    const s = stateOn(table);
    const ref = (seq: number, slot: number) => ({ seq, key: rollingKey(slot), sha256: String(seq).padStart(64, "0"), size: 10, compressed: 5, migrations: ["0001_init.sql", "0002_x.sql"], at: "2026-11-02T00:00:00.000Z" });
    expect(await s.pointer()).toBeNull();
    expect(await s.movePointer(ref(5, 0))).toBe("moved");
    expect(await s.movePointer(ref(5, 1))).toBe("stale");
    expect(await s.movePointer(ref(2, 1))).toBe("stale");
    expect(await s.pointer()).toEqual(ref(5, 0));
    expect(await s.previous()).toBeNull();
    // two writers move at once: exactly the higher seq ends as the pointer, and PREV is whichever pointer was replaced
    const results = await Promise.all([s.movePointer(ref(8, 1)), s.movePointer(ref(9, 2)), s.movePointer(ref(7, 3))]);
    expect(results.filter((r) => r === "moved").length).toBeGreaterThanOrEqual(1);
    expect((await s.pointer())!.seq).toBe(9);
    const prev = await s.previous();
    expect([5, 7, 8]).toContain(prev!.seq);
    expect(prev!.migrations).toEqual(["0001_init.sql", "0002_x.sql"]);
  });

  it("[LDB-RP3] daily slots, the retention mark and log expiry marks work on DynamoDB: the ttl lands on exactly the entries asked for", async () => {
    const table = await newTable();
    const blobs = new MemoryObjects();
    const log = logOn(table, blobs);
    const r = new Replica(log, FAST);
    await applyMigrations(r, MIGRATIONS_DIR, () => new Date("2026-11-02T00:00:00Z"));
    const s = stateOn(table);
    const d = (seq: number, slot: number, day: string) => ({ seq, key: `snap/daily/${String(slot).padStart(2, "0")}.sqlite.zst`, sha256: "a".repeat(64), size: 1, compressed: 1, migrations: [], at: `${day}T03:00:00.000Z`, day, slot });
    expect(await s.putDaily(d(10, 3, "2026-11-01"))).toBe("put");
    expect(await s.putDaily(d(5, 3, "2026-10-01"))).toBe("stale");
    expect(await s.putDaily(d(7, 1, "2026-10-30"))).toBe("put");
    expect((await s.dailies()).map((x) => [x.slot, x.seq, x.day])).toEqual([[1, 7, "2026-10-30"], [3, 10, "2026-11-01"]]);

    expect(await s.expiredThrough()).toBe(0);
    await s.setExpiredThrough(12);
    await s.setExpiredThrough(4); // monotonic
    expect(await s.expiredThrough()).toBe(12);

    const total = r.seq;
    expect(total).toBeGreaterThan(30);
    const out = await log.expire(0, 25, 1_900_000_000, 10);
    expect(out).toEqual({ marked: 10, through: 10 });
    const out2 = await log.expire(10, 25, 1_900_000_000, 100);
    expect(out2).toEqual({ marked: 15, through: 25 });
    for (let seq = 1; seq <= total; seq++) {
      const it = await rawItem(table, "LOG", String(seq).padStart(12, "0"));
      if (seq <= 25) expect(it?.ttl?.N, `seq ${seq}`).toBe("1900000000");
      else expect(it?.ttl, `seq ${seq}`).toBeUndefined();
      expect(it?.body?.S ?? it?.spill?.S, `seq ${seq} still has its body`).toBeDefined();
    }
    // the HEAD item is never marked, and an expire over nothing is a no-op
    expect((await rawItem(table, "HEAD", "HEAD"))?.ttl).toBeUndefined();
    expect(await log.expire(total, total + 5, 1_900_000_000, 10)).toEqual({ marked: 0, through: total + 5 });
  }, 60_000);
});
