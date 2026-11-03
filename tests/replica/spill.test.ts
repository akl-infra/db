// S3 spill for big log bodies (design A phase B, RP7), on the memory log and memory object store. The DynamoDB-side
// proof with a real-size dump restore is tests/replica/spill-ddb.test.ts.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LogEntryTooLargeError, MAX_BODY_BYTES, encodeBody, type NewLogEntry } from "../../src/replica/log";
import { MemoryLog } from "../../src/replica/log-memory";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica } from "../../src/replica/replica";
import { SPILL_THRESHOLD, SpillError, spillKey } from "../../src/replica/spill";
import { zstdDecompress } from "../../src/replica/zstd";
import { createShimD1 } from "../../src/store/shim/d1";
import { FAST, churn, digestOf, replayFrom0, world } from "./support";

const entry = (unitId: string, bytes: number): NewLogEntry => ({ unitId, kind: "unit", hash: "ab".repeat(32), stmts: [{ sql: "INSERT INTO t VALUES (?)", params: ["x".repeat(bytes), new Uint8Array([0, 255, 7]), null] }] });
const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

describe("S3 spill (RP7)", () => {
  it("[LDB-RP7] a body at the threshold stays inline; one byte over goes to log/<unitId>.json.zst and the log item keeps only {spill, hash}", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    // find the size whose encoded body is exactly the threshold
    const base = Buffer.byteLength(encodeBody(entry("u0", 0)), "utf8");
    const exact = entry("u1", SPILL_THRESHOLD - base);
    expect(Buffer.byteLength(encodeBody(exact), "utf8")).toBe(SPILL_THRESHOLD);
    expect(await log.append(0, exact)).toBe("ok");
    expect(blobs.objects.size).toBe(0);
    const over = entry("u2", SPILL_THRESHOLD - base + 1);
    expect(await log.append(1, over)).toBe("ok");
    expect(blobs.keys()).toEqual([spillKey("u2")]);
    expect(spillKey("u2")).toBe("log/u2.json.zst");
    // what is stored is the zstd of the JSON text, and the log item's hash is that text's sha256
    const stored = blobs.peek("log/u2.json.zst")!;
    const json = Buffer.from(zstdDecompress(stored.bytes)).toString("utf8");
    expect(json).toBe(encodeBody(over));
    expect(stored.meta.sha256).toBe(sha(json));
    expect(log.entries()[1]).toMatchObject({ seq: 2, unitId: "u2", stmts: over.stmts });
    expect((await log.get(2))!.stmts[0]!.params[1]).toEqual(new Uint8Array([0, 255, 7]));
  });

  it("[LDB-RP7] the object is uploaded BEFORE the append: when the PUT happens the entry is not in the log yet", async () => {
    const order: string[] = [];
    let log!: MemoryLog;
    const blobs = new (class extends MemoryObjects {
      override async put(key: string, bytes: Uint8Array, meta?: Record<string, string>) {
        order.push(`put(log length ${log.length})`);
        await super.put(key, bytes, meta);
      }
    })();
    log = new MemoryLog({}, blobs);
    await log.append(0, entry("a", 10));
    await log.append(1, entry("b", 400_000));
    expect(order).toEqual(["put(log length 1)"]);
    expect(log.length).toBe(2);
  });

  it("[LDB-RP7] a failed upload appends nothing; a lost append leaves an orphan object that nothing reads, and the retry uploads under its own unit id", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    blobs.failPut.add("log/");
    await expect(log.append(0, entry("x", 400_000))).rejects.toThrow(/injected PUT failure/);
    expect(log.length).toBe(0);
    blobs.failPut.clear();
    expect(await log.append(0, entry("a", 400_000))).toBe("ok");
    expect(await log.append(0, entry("b", 400_000))).toBe("conflict"); // lost the race after uploading
    expect(blobs.keys()).toEqual([spillKey("a"), spillKey("b")]); // b is an orphan
    expect(log.length).toBe(1);
    expect(await log.append(1, entry("c", 400_000))).toBe("ok");
    expect((await log.read(0, 2)).map((e) => e.unitId)).toEqual(["a", "c"]);
  });

  it("[LDB-RP7] an append retried with the same entry after an ambiguous outcome uploads once", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    const e = entry("same", 400_000);
    log.forceNext("timeoutBefore");
    await expect(log.append(0, e)).rejects.toThrow(/timeout/);
    expect(await log.append(0, e)).toBe("ok");
    expect(blobs.calls.puts).toBe(1);
    expect(log.spiller.uploads.count).toBe(1);
  });

  it("[LDB-RP7] readers fetch and verify: a missing, truncated or altered object is an error that names the entry, never an empty body", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    await log.append(0, entry("a", 400_000));
    const key = spillKey("a");
    const good = Uint8Array.from(blobs.peek(key)!.bytes);

    blobs.objects.delete(key);
    await expect(log.get(1)).rejects.toThrow(/commit log entry 1: spilled body log\/a\.json\.zst is missing/);
    await expect(log.read(0, 1)).rejects.toBeInstanceOf(SpillError);

    blobs.objects.set(key, { bytes: good.slice(0, good.length - 5), meta: {} });
    await expect(log.get(1)).rejects.toThrow(/does not decompress|sha256/);

    // intact zstd of different JSON: the sha256 in the log item catches it
    const { zstdCompress } = await import("../../src/replica/zstd");
    blobs.objects.set(key, { bytes: Uint8Array.from(zstdCompress(Buffer.from(encodeBody(entry("a", 400_001))), 3)), meta: {} });
    await expect(log.get(1)).rejects.toThrow(/has sha256 [0-9a-f]{64}, the log item says [0-9a-f]{64}/);

    blobs.objects.set(key, { bytes: good, meta: {} });
    expect((await log.get(1))!.unitId).toBe("a");
  });

  it("[LDB-RP7] a replica that cannot read a spilled body stays alive and intact, and replays it once the object is back", async () => {
    const w = await world();
    await churn(w.replica, 5);
    const reader = new Replica(w.log, FAST);
    await reader.catchUp();
    const db = createShimD1(w.replica);
    await db.exec("CREATE TABLE IF NOT EXISTS big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await db.prepare("INSERT INTO big (v) VALUES (?)").bind("y".repeat(420_000)).run();
    const key = w.blobs.keys("log/")[0]!;
    const good = w.blobs.peek(key)!;
    w.blobs.objects.delete(key);
    await expect(reader.catchUp()).rejects.toBeInstanceOf(SpillError);
    expect(reader.dead).toBeNull();
    w.blobs.objects.set(key, good);
    await reader.catchUp();
    expect(reader.seq).toBe(w.log.length);
    expect(digestOf(reader)).toBe(digestOf(w.replica));
    expect(digestOf(reader)).toBe(digestOf(await replayFrom0(w.log)));
  });

  it("[LDB-RP7] a big unit replicates byte for byte, whether the second replica starts from 0 or from a snapshot", async () => {
    const w = await world();
    const db = createShimD1(w.replica);
    await db.exec("CREATE TABLE IF NOT EXISTS big (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await db.batch(Array.from({ length: 5 }, (_, i) => db.prepare("INSERT INTO big (id, v) VALUES (?, ?)").bind(i, String(i).repeat(90_000))));
    expect(w.blobs.keys("log/")).toHaveLength(1);
    const b = await replayFrom0(w.log);
    expect(b.serialize()).toEqual(w.replica.serialize()); // raw bytes, both replicas replayed natively
    expect((b.db.prepare("SELECT count(*) AS n FROM big").get() as { n: number }).n).toBe(5);
  });

  it("[LDB-RP7] without an object store the 350,000-byte inline limit stands, and an entry between 300,000 and 350,000 bytes is still inline", async () => {
    const log = new MemoryLog({ maxBodyBytes: MAX_BODY_BYTES });
    const base = Buffer.byteLength(encodeBody(entry("u0", 0)), "utf8");
    expect(await log.append(0, entry("a", 320_000 - base))).toBe("ok");
    await expect(log.append(1, entry("b", 360_000))).rejects.toBeInstanceOf(LogEntryTooLargeError);
    const withBlobs = new MemoryLog({ maxBodyBytes: MAX_BODY_BYTES }, new MemoryObjects());
    expect(await withBlobs.append(0, entry("c", 360_000))).toBe("ok");
  });
});
