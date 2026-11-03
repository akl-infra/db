// [LDB-CV10] The cutover image (phase E): D1's whole database as ONE log entry of kind "image", always seq 1.
// Memory log + memory object store, plus the real DynamoDB log code over an in-process fake DynamoDB.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootReplica, bootReportOf } from "../../src/replica/boot";
import { appendImage } from "../../src/replica/image";
import { ImageEntryRefusedError, type CommitLog, type LogEntry } from "../../src/replica/log";
import { createDdbLog } from "../../src/replica/log-ddb";
import { MemoryLog } from "../../src/replica/log-memory";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica, ReplicaDivergedError, imageDigest } from "../../src/replica/replica";
import { cleanSpills, runRetention } from "../../src/replica/retention";
import { restoreAt } from "../../src/replica/proof";
import { MemorySnapshotState, writeSnapshot } from "../../src/replica/snapshot";
import { SpillError, imageKey } from "../../src/replica/spill";
import { zstdCompress } from "../../src/replica/zstd";
import { createShimD1 } from "../../src/store/shim/d1";
import { FakeDdb } from "./fake-ddb";
import { FAST, churn, digestOf, replayFrom0, world } from "./support";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const TABLES = { layouts: { count: 0, checksum: "0".repeat(64) } };

/** D1's database, as the cutover would hold it: the real migrations plus data, as one SQLite image. */
async function sourceImage(rows = 40): Promise<{ raw: Uint8Array; digest: string }> {
  const w = await world();
  await churn(w.replica, rows);
  return { raw: w.replica.serialize(), digest: digestOf(w.replica) };
}

/** An empty prod log with a memory object store, as the prod stack starts. */
function emptyStack(): { log: MemoryLog; blobs: MemoryObjects } {
  const blobs = new MemoryObjects();
  return { log: new MemoryLog({}, blobs), blobs };
}

describe("the image entry (CV10)", () => {
  it("[LDB-CV10] an image at seq 1, then units: a fresh replica replaying from 0 equals the live one", async () => {
    const { raw, digest } = await sourceImage();
    const { log, blobs } = emptyStack();
    const r = await appendImage({ log, raw, tables: TABLES, source: { bookmark: "bm-1" }, sleep: async () => {} });
    expect(r).toMatchObject({ outcome: "appended", seq: 1, hash: sha(raw) });
    expect(log.length).toBe(1);
    // the image lives in the object store, not in the log item
    expect(blobs.keys("log/")).toEqual([imageKey(r.unitId)]);
    const entry = log.entries()[0]!;
    expect(entry).toMatchObject({ seq: 1, kind: "image", hash: sha(raw), stmts: [] });
    expect(entry.image).toMatchObject({ key: imageKey(r.unitId), bytes: raw.byteLength, tables: TABLES, source: { bookmark: "bm-1" } });

    const live = new Replica(log, FAST);
    await live.catchUp();
    expect(live.seq).toBe(1);
    expect(digestOf(live)).toBe(digest);
    await churn(live, 25, 7);
    const db = createShimD1(live);
    await db.prepare("INSERT INTO import_state (key, value) VALUES ('cutover.mode', 'read_only')").run();
    expect(log.length).toBeGreaterThan(20);

    const fresh = await replayFrom0(log);
    expect(fresh.seq).toBe(live.seq);
    expect(digestOf(fresh)).toBe(digestOf(live));
    // the replayed replica still writes: foreign keys and statement caches survived the deserialize
    await createShimD1(fresh).prepare("INSERT INTO churn (v) VALUES ('after')").run();
    expect(fresh.seq).toBe(live.seq + 1);
    await live.catchUp();
    expect(digestOf(live)).toBe(digestOf(fresh));
  });

  it("[LDB-CV10] snapshots, point-in-time restore and boot all work across the image", async () => {
    const { raw, digest } = await sourceImage(20);
    const { log, blobs } = emptyStack();
    await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    const live = new Replica(log, FAST);
    await live.catchUp();
    const objects = new MemoryObjects();
    const state = new MemorySnapshotState();
    const lines: string[] = [];
    const deps = { objects, state, logLine: (m: string) => void lines.push(m), now: () => Date.parse("2026-11-04T10:00:00Z") };
    // a snapshot AT the image (the cutover writes the pointer at seq 1), then more units, then a second one
    const first = await writeSnapshot(live, deps);
    expect(first.status === "written" && first.ref.seq).toBe(1);
    await churn(live, 12, 3);
    const second = await writeSnapshot(live, deps);
    expect(second.status === "written" && second.ref.seq).toBe(log.length);

    // restore to seq 1 = the image; to a middle seq = a replay from 0
    const at1 = await restoreAt(1, { log, state, objects });
    expect(digestOf(at1.replica)).toBe(digest);
    const mid = Math.floor((1 + log.length) / 2);
    const atMid = await restoreAt(mid, { log, state, objects });
    expect(digestOf(atMid.replica)).toBe(digestOf(await replayFrom0(log, mid)));
    // boot from the pointer, and from nothing (replay from 0 through the image)
    const booted = await bootReplica(log, { snapshots: { state, objects }, logLine: (m) => lines.push(m) });
    expect(bootReportOf(booted)?.path).toBe("pointer");
    expect(digestOf(booted)).toBe(digestOf(live));
    const cold = await bootReplica(log, { logLine: (m) => lines.push(m) });
    expect(bootReportOf(cold)?.path).toBe("replay");
    expect(digestOf(cold)).toBe(digestOf(live));
    expect(lines.filter((l) => l.includes("akldb-alarm"))).toEqual([]);
    expect(blobs.keys("log/").some((k) => k.endsWith(".image.zst"))).toBe(true);
  });

  it("[LDB-CV10] an image entry at any seq other than 1 is refused, by the helper and by the backend", async () => {
    const { raw } = await sourceImage(5);
    // a log that already holds a migration: the helper refuses and appends nothing
    const w = await world();
    await expect(appendImage({ log: w.log, raw, tables: TABLES, sleep: async () => {} })).rejects.toThrow(ImageEntryRefusedError);
    expect(w.log.entries().every((e) => e.kind === "migration")).toBe(true);
    // the backend itself refuses a hand-made image entry at expectedHead != 0 (seq 2, seq 38 ...)
    for (const head of [1, 5, w.log.length]) {
      await expect(w.log.append(head, { unitId: "U".repeat(26), kind: "image", stmts: [], hash: sha(raw), image: { key: "log/x.image.zst", bytes: 1, zbytes: 1, tables: {} } })).rejects.toThrow(/first entry/);
    }
    expect(w.log.length).toBe(37);
    // an image reference on a unit is refused, an image without a reference is refused
    const e = emptyStack();
    await expect(e.log.append(0, { unitId: "A".repeat(26), kind: "unit", stmts: [], hash: "x", image: { key: "k", bytes: 1, zbytes: 1, tables: {} } })).rejects.toThrow(/carries an image reference/);
    await expect(e.log.append(0, { unitId: "B".repeat(26), kind: "image", stmts: [], hash: "x" })).rejects.toThrow(/no image reference/);
    expect(e.log.length).toBe(0);
  });

  it("[LDB-CV10] a second run is idempotent for the same image and refused for any other", async () => {
    const { raw } = await sourceImage(5);
    const { log, blobs } = emptyStack();
    const a = await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    const b = await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    expect(b).toMatchObject({ outcome: "already", unitId: a.unitId });
    expect(log.length).toBe(1);
    expect(blobs.keys("log/")).toHaveLength(1);
    const other = (await sourceImage(6)).raw;
    await expect(appendImage({ log, raw: other, tables: TABLES, sleep: async () => {} })).rejects.toThrow(/different image/);
    expect(log.length).toBe(1);
  });

  it("[LDB-CV10] an ambiguous image append is resolved by reading seq 1 back, and the image lands once", async () => {
    const { raw } = await sourceImage(5);
    const { log } = emptyStack();
    log.forceNext("timeoutAfter");
    const r = await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    expect(r.outcome).toBe("appended");
    expect(log.length).toBe(1);
    const log2 = emptyStack().log;
    log2.forceNext("timeoutBefore", "throttle");
    const r2 = await appendImage({ log: log2, raw, tables: TABLES, sleep: async () => {} });
    expect(r2.outcome).toBe("appended");
    expect(log2.length).toBe(1);
  });

  it("[LDB-CV10] an image whose bytes do not hash to the entry halts the replica like SH8", async () => {
    const { raw } = await sourceImage(5);
    const { log, blobs } = emptyStack();
    const r = await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    // a different image of the same length, compressed and stored under the same key: the object decompresses, the size
    // matches, only the sha256 differs, so the backend lets it through and the replica must refuse it
    const forged = Uint8Array.from(raw);
    forged[forged.length - 1] = forged[forged.length - 1]! ^ 0xff;
    blobs.objects.set(imageKey(r.unitId), { bytes: zstdCompress(forged, 3), meta: {} });
    const lines: string[] = [];
    const rep = new Replica(log, { ...FAST, alarm: (l) => void lines.push(l) });
    await expect(rep.catchUp()).rejects.toThrow(ReplicaDivergedError);
    expect(rep.dead).toBeInstanceOf(ReplicaDivergedError);
    expect(rep.seq).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^akldb-alarm: replica: halted at seq 0: ReplicaDivergedError: image entry at seq 1 .* image sha256 .* != logged /);
    await expect(rep.catchUp()).rejects.toThrow(ReplicaDivergedError); // dead stays dead
  });

  it("[LDB-CV10] a missing or damaged image object is an error, never an empty database", async () => {
    const { raw } = await sourceImage(5);
    const { log, blobs } = emptyStack();
    const r = await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    const key = imageKey(r.unitId);
    const good = blobs.objects.get(key)!;
    blobs.objects.set(key, { bytes: good.bytes.slice(0, 40), meta: {} });
    await expect(new Replica(log, FAST).catchUp()).rejects.toThrow(SpillError);
    blobs.objects.delete(key);
    await expect(new Replica(log, FAST).catchUp()).rejects.toThrow(/missing from the object store/);
    blobs.objects.set(key, good);
    const ok = new Replica(log, FAST);
    await ok.catchUp();
    expect(ok.seq).toBe(1);
  });

  it("[LDB-CV10] a replay never applies an image anywhere but onto an empty replica at seq 0", async () => {
    const { raw } = await sourceImage(5);
    const hash = sha(raw);
    const entry = (seq: number): LogEntry => ({ seq, unitId: "C".repeat(26), kind: "image", stmts: [], hash, image: { key: "k", bytes: raw.byteLength, zbytes: 1, tables: {} }, imageData: raw });
    // a log that (wrongly) serves the image at seq 2 to a replica sitting at seq 1
    const w = await world();
    const stub: CommitLog = { head: async () => 2, read: async (after) => (after === 0 ? [w.log.entries()[0]!, entry(2)] : [entry(2)]), append: async () => "conflict", get: async () => null };
    const lines: string[] = [];
    const rep = new Replica(stub, { ...FAST, alarm: (l) => void lines.push(l) });
    await expect(rep.catchUp()).rejects.toThrow(/image entry at seq 2 .* the log's first entry/);
    expect(rep.dead).not.toBeNull();
    // an image at seq 1 that meets a replica that already has a schema
    const { log } = emptyStack();
    await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    const dirty = new Replica(log, { ...FAST, alarm: (l) => void lines.push(l) });
    dirty.db.exec("CREATE TABLE stray (x)");
    await expect(dirty.catchUp()).rejects.toThrow(/already has 1 schema objects/);
  });

  it("[LDB-CV10] retention keeps the image object: the orphan sweep matches only .json.zst bodies", async () => {
    const { raw } = await sourceImage(5);
    const { log, blobs } = emptyStack();
    const r = await appendImage({ log, raw, tables: TABLES, ulid: () => "01H0000000000000000000ABCD", sleep: async () => {} });
    const live = new Replica(log, FAST);
    await live.catchUp();
    await churn(live, 4);
    const state = new MemorySnapshotState();
    // everything is ancient relative to "now", so a sweep that matched the image would delete it
    const deps = { objects: blobs, state, logLine: () => {}, now: () => Date.parse("2030-01-01T00:00:00Z") };
    const deleted = await cleanSpills(log, deps, 2);
    expect(deleted).toBe(0);
    expect(blobs.peek(imageKey(r.unitId))).toBeDefined();
    expect(typeof runRetention).toBe("function");
  });
});

describe("the image entry through the DynamoDB log (CV10)", () => {
  const creds = { accessKeyId: "x", secretAccessKey: "y" };

  it("[LDB-CV10] DynamoDB log: the image rides as a small item plus an S3 object, replays on a fresh replica, and a non-first image is refused before any request", async () => {
    const { raw, digest } = await sourceImage(10);
    const ddb = new FakeDdb();
    const blobs = new MemoryObjects();
    const log = createDdbLog({ table: "t", credentials: creds, fetch: ddb.fetch, sleep: async () => {}, blobs });
    const r = await appendImage({ log, raw, tables: TABLES, sleep: async () => {} });
    const item = ddb.items.get("LOG|000000000001")!;
    expect(item.kind!.S).toBe("image");
    expect(Buffer.byteLength(item.body!.S!)).toBeLessThan(2000); // a reference, not the image
    expect(item.spill).toBeUndefined();
    expect(blobs.keys("log/")).toEqual([imageKey(r.unitId)]);
    const rep = new Replica(log, FAST);
    await rep.catchUp();
    expect(digestOf(rep)).toBe(digest);
    await churn(rep, 5, 9);
    const rep2 = new Replica(createDdbLog({ table: "t", credentials: creds, fetch: ddb.fetch, sleep: async () => {}, blobs: blobs.clone() }), FAST);
    await rep2.catchUp();
    expect(imageDigest(rep2.serialize())).toBe(imageDigest(rep.serialize()));
    // seq 7 as an image: refused before DynamoDB is asked anything
    const before = ddb.calls.length;
    await expect(log.append(rep.seq, { unitId: "D".repeat(26), kind: "image", stmts: [], hash: "h", image: { key: "k", bytes: 1, zbytes: 1, tables: {} } })).rejects.toThrow(/first entry/);
    expect(ddb.calls.length).toBe(before);
    // and the helper on a non-empty DynamoDB log
    await expect(appendImage({ log, raw, tables: TABLES, sleep: async () => {} })).resolves.toMatchObject({ outcome: "already" });
    await expect(appendImage({ log, raw: (await sourceImage(3)).raw, tables: TABLES, sleep: async () => {} })).rejects.toThrow(ImageEntryRefusedError);
  });
});
