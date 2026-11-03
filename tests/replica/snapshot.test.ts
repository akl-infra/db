// Snapshots and boot (design A phase B): RP1 (a snapshot is an image at one seq with a checksum; the pointer moves only
// after the upload verifies, and only upward) and RP2 (boot verifies, replays the tail to HEAD, falls back loudly, and
// serves nothing before that). Memory log, memory object store, no AWS.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bootReplica, bootReportOf } from "../../src/replica/boot";
import type { CommitLog } from "../../src/replica/log";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica } from "../../src/replica/replica";
import { writeDaily } from "../../src/replica/retention";
import { MemorySnapshotState, ROLLING_SLOTS, readSnapshot, rollingKey, snapshotDue, writeSnapshot, type SnapRef } from "../../src/replica/snapshot";
import { zstdCompress } from "../../src/replica/zstd";
import { FAST, churn, digestOf, replayFrom0, world } from "./support";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("snapshot writer (RP1)", () => {
  it("[LDB-RP1] a snapshot is the image at one seq: recorded sha256 and size match the bytes, and the image equals a replay to that seq", async () => {
    const w = await world();
    await churn(w.replica, 30);
    const out = await writeSnapshot(w.replica, w.deps);
    expect(out.status).toBe("written");
    if (out.status !== "written") return;
    const ref = out.ref;
    expect(ref.seq).toBe(w.log.length);
    const raw = await readSnapshot(ref, w.objects);
    expect(sha(raw)).toBe(ref.sha256);
    expect(raw.byteLength).toBe(ref.size);
    const obj = w.objects.peek(ref.key)!;
    expect(obj.meta).toMatchObject({ sha256: ref.sha256, size: String(ref.size), seq: String(ref.seq), "migration-count": "37" });
    expect(ref.migrations).toHaveLength(37);
    expect(ref.migrations[0]).toMatch(/^0001_/);
    const rebuilt = await replayFrom0(w.log, ref.seq);
    expect(digestOf(Replica.fromSnapshot(w.log, raw, ref.seq, FAST))).toBe(digestOf(rebuilt));
  });

  it("[LDB-RP1] the pointer moves only after the upload verified: a failed upload, a damaged object and a vanished object each leave it where it was", async () => {
    const w = await world();
    await churn(w.replica, 10);
    await writeSnapshot(w.replica, w.deps);
    const before = await w.state.pointer();
    await churn(w.replica, 10, 2);

    // 1. the upload fails
    w.objects.failPut.add("snap/");
    await expect(writeSnapshot(w.replica, w.deps)).rejects.toThrow(/injected PUT failure/);
    w.objects.failPut.clear();
    expect(await w.state.pointer()).toEqual(before);

    // 2. the object is damaged on its way in (the store keeps different bytes than were sent)
    const damaging = new (class extends MemoryObjects {
      override async put(key: string, bytes: Uint8Array, meta?: Record<string, string>) {
        const bad = Uint8Array.from(bytes);
        bad[Math.floor(bad.length / 2)]! ^= 0x5a;
        await super.put(key, bad, meta);
      }
    })();
    await expect(writeSnapshot(w.replica, { ...w.deps, objects: damaging })).rejects.toThrow(/snapshot snap\/slot-\d\.sqlite\.zst/);
    expect(await w.state.pointer()).toEqual(before);

    // 3. the object is not there when read back
    const dropping = new (class extends MemoryObjects {
      override async put() {}
    })();
    await expect(writeSnapshot(w.replica, { ...w.deps, objects: dropping })).rejects.toThrow(/missing from the object store/);
    expect(await w.state.pointer()).toEqual(before);

    // and a healthy attempt after all that moves it
    const ok = await writeSnapshot(w.replica, w.deps);
    expect(ok.status === "written" && ok.moved).toBe("moved");
    expect((await w.state.pointer())!.seq).toBe(w.log.length);
  });

  it("[LDB-RP1] the pointer's seq only increases, and the old pointer becomes PREV", async () => {
    const s = new MemorySnapshotState();
    const ref = (seq: number): SnapRef => ({ seq, key: rollingKey(seq % ROLLING_SLOTS), sha256: "a".repeat(64), size: 1, compressed: 1, migrations: [], at: "2026-11-02T00:00:00.000Z" });
    expect(await s.movePointer(ref(5))).toBe("moved");
    expect(await s.movePointer(ref(5))).toBe("stale");
    expect(await s.movePointer(ref(3))).toBe("stale");
    expect(await s.movePointer(ref(9))).toBe("moved");
    expect((await s.pointer())!.seq).toBe(9);
    expect((await s.previous())!.seq).toBe(5);
  });

  it("[LDB-RP1] rolling snapshots rotate through fixed slots and never overwrite what POINTER or PREV names", async () => {
    const w = await world();
    const seen = new Set<string>();
    for (let i = 0; i < 3 * ROLLING_SLOTS; i++) {
      await churn(w.replica, 3, i + 1);
      const pointer = await w.state.pointer();
      const prev = await w.state.previous();
      const before = { pointer: pointer && w.objects.peek(pointer.key)?.bytes.slice(), prev: prev && w.objects.peek(prev.key)?.bytes.slice() };
      const out = await writeSnapshot(w.replica, w.deps);
      expect(out.status).toBe("written");
      if (out.status !== "written") return;
      expect(out.ref.key).not.toBe(pointer?.key);
      expect(out.ref.key).not.toBe(prev?.key);
      // the objects the OLD pointer and PREV named are byte-for-byte unchanged by this write
      if (pointer) expect(w.objects.peek(pointer.key)!.bytes).toEqual(before.pointer);
      if (prev) expect(w.objects.peek(prev.key)!.bytes).toEqual(before.prev);
      seen.add(out.ref.key);
    }
    expect(seen.size).toBe(ROLLING_SLOTS);
    expect(w.objects.keys("snap/")).toHaveLength(ROLLING_SLOTS);
  });

  it("[LDB-RP1] the image is taken at one consistent seq even while writers keep committing", async () => {
    const w = await world();
    await churn(w.replica, 15);
    const writers = churn(w.replica, 40, 9); // keeps committing while the snapshot is taken and compressed
    const out = await writeSnapshot(w.replica, w.deps);
    await writers;
    expect(out.status).toBe("written");
    if (out.status !== "written") return;
    expect(out.ref.seq).toBeLessThanOrEqual(w.log.length);
    const raw = await readSnapshot(out.ref, w.objects);
    const at = await replayFrom0(w.log, out.ref.seq);
    expect(digestOf(Replica.fromSnapshot(w.log, raw, out.ref.seq, FAST))).toBe(digestOf(at));
  });

  it("[LDB-RP1] a snapshot is due after 50 units or an hour, never without a newer head", () => {
    const at = "2026-11-02T00:00:00.000Z";
    const t0 = Date.parse(at);
    const p = (seq: number): SnapRef => ({ seq, key: "k", sha256: "", size: 0, compressed: 0, migrations: [], at });
    expect(snapshotDue(0, null, t0)).toBe(false);
    expect(snapshotDue(5, null, t0)).toBe(true);
    expect(snapshotDue(100, p(100), t0 + 9e9)).toBe(false); // nothing new, however old
    expect(snapshotDue(149, p(100), t0 + 1000)).toBe(false);
    expect(snapshotDue(150, p(100), t0 + 1000)).toBe(true);
    expect(snapshotDue(101, p(100), t0 + 3_599_999)).toBe(false);
    expect(snapshotDue(101, p(100), t0 + 3_600_000)).toBe(true);
  });
});

describe("snapshot boot (RP2)", () => {
  async function withSnapshots(extraAfterFirst = 12, extraAfterSecond = 7) {
    const w = await world();
    await churn(w.replica, 20);
    const first = await writeSnapshot(w.replica, w.deps);
    await churn(w.replica, extraAfterFirst, 2);
    const second = await writeSnapshot(w.replica, w.deps);
    await churn(w.replica, extraAfterSecond, 3);
    if (first.status !== "written" || second.status !== "written") throw new Error("setup");
    return { w, first: first.ref, second: second.ref };
  }
  const boot = (w: Awaited<ReturnType<typeof world>>, lines: string[] = []) => bootReplica(w.log, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: (m) => void lines.push(m) });

  it("[LDB-RP2] boot deserializes the pointer's snapshot, replays only the tail, and equals a replay from 0 at the head", async () => {
    const { w, second } = await withSnapshots();
    const lines: string[] = [];
    const r = await boot(w, lines);
    expect(r.seq).toBe(w.log.length);
    expect(r.stats.replayed).toBe(w.log.length - second.seq);
    expect(bootReportOf(r)).toMatchObject({ path: "pointer", fromSeq: second.seq, seq: w.log.length, fallbacks: [] });
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
    expect(r.db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^akldb-boot: path=pointer snapshot=snap\/slot-\d\.sqlite\.zst snapshotSeq=\d+ seq=\d+ replayed=\d+$/);
  });

  it("[LDB-RP2] a replica booted from a snapshot keeps committing and stays equal to one that replayed everything", async () => {
    const { w } = await withSnapshots();
    const r = await boot(w);
    await churn(r, 12, 5);
    await w.replica.catchUp();
    expect(r.seq).toBe(w.replica.seq);
    expect(digestOf(r)).toBe(digestOf(w.replica));
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
  });

  it("[LDB-RP2] a damaged pointer snapshot falls back to PREV, and says so", async () => {
    const { w, first, second } = await withSnapshots();
    const bytes = w.objects.peek(second.key)!.bytes;
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    const lines: string[] = [];
    const r = await boot(w, lines);
    expect(bootReportOf(r)).toMatchObject({ path: "prev", fromSeq: first.seq });
    expect(bootReportOf(r)!.fallbacks[0]).toMatch(/^pointer: /);
    expect(r.seq).toBe(w.log.length);
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
    expect(lines[0]).toMatch(/^akldb-alarm: boot: fallback: pointer unusable: /);
    expect(lines[1]).toMatch(/^akldb-boot: path=prev .*fallbacks=\[pointer: /);
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toHaveLength(1); // one fallback taken, one alarm line
  });

  it("[LDB-RP2] a wrong checksum (intact zstd, different bytes) is caught, not deserialized", async () => {
    const { w, second } = await withSnapshots();
    const other = (await withSnapshots(3, 3)).w.replica.serialize();
    w.objects.objects.set(second.key, { bytes: Uint8Array.from(zstdCompress(other, 3)), meta: w.objects.peek(second.key)!.meta });
    await expect(readSnapshot(second, w.objects)).rejects.toThrow(/sha256|bytes, expected/);
    const r = await boot(w);
    expect(bootReportOf(r)!.path).toBe("prev");
  });

  it("[LDB-RP2] a failed or missing GET, then a damaged PREV, falls through to a replay from 0", async () => {
    const { w, first, second } = await withSnapshots();
    w.objects.failGet.add(second.key);
    w.objects.objects.delete(first.key);
    const lines: string[] = [];
    const r = await boot(w, lines);
    expect(bootReportOf(r)).toMatchObject({ path: "replay", snapshot: null, fromSeq: 0 });
    expect(bootReportOf(r)!.fallbacks).toHaveLength(2);
    expect(r.seq).toBe(w.log.length);
    expect(r.stats.replayed).toBe(w.log.length);
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
    expect(lines.filter((l) => l.startsWith("akldb-alarm: boot: fallback: "))).toHaveLength(2); // pointer, prev: one line each
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toHaveLength(2);
    expect(lines.at(-1)).toMatch(/^akldb-boot: path=replay /);
  });

  it("[LDB-RP2] [LDB-RP9] bad POINTER, then bad PREV: the newest verified daily snapshot plus its tail boots, one alarm line per fallback", async () => {
    const { w, first, second } = await withSnapshots();
    const daily = await writeDaily(w.replica, w.deps);
    expect(daily.status).toBe("written");
    await churn(w.replica, 6, 8); // a tail after the daily
    w.objects.peek(second.key)!.bytes[30]! ^= 0xff;
    w.objects.peek(first.key)!.bytes[30]! ^= 0xff;
    const lines: string[] = [];
    const r = await boot(w, lines);
    const report = bootReportOf(r)!;
    expect(report.path).toBe("daily");
    expect(report.snapshot!.key).toBe(daily.status === "written" ? daily.ref.key : "");
    expect(r.stats.replayed).toBe(w.log.length - report.fromSeq);
    expect(r.seq).toBe(w.log.length);
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
    const alarms = lines.filter((l) => l.startsWith("akldb-alarm: "));
    expect(alarms).toHaveLength(2);
    expect(alarms[0]).toMatch(/^akldb-alarm: boot: fallback: pointer unusable: /);
    expect(alarms[1]).toMatch(/^akldb-alarm: boot: fallback: prev unusable: /);
    expect(lines.at(-1)).toMatch(/^akldb-boot: path=daily snapshot=snap\/daily\/\d\d\.sqlite\.zst /);
  });

  it("[LDB-RP2] the newest daily is the one tried, and a damaged one falls to the next older, each failure alarmed once", async () => {
    const { w } = await withSnapshots();
    w.clock.ms = Date.parse("2026-11-03T04:00:00Z");
    const d1 = await writeDaily(w.replica, w.deps);
    await churn(w.replica, 4, 20);
    w.clock.ms = Date.parse("2026-11-04T04:00:00Z");
    const d2 = await writeDaily(w.replica, w.deps);
    await churn(w.replica, 3, 21);
    if (d1.status !== "written" || d2.status !== "written") throw new Error("setup");
    for (const k of [(await w.state.pointer())!.key, (await w.state.previous())!.key, d2.ref.key]) w.objects.peek(k)!.bytes[25]! ^= 0xff;
    const lines: string[] = [];
    const r = await boot(w, lines);
    expect(bootReportOf(r)).toMatchObject({ path: "daily", fromSeq: d1.ref.seq });
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toHaveLength(3); // pointer, prev, the newest daily
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
  });

  it("[LDB-RP2] a healthy boot never reads the daily index", async () => {
    const { w } = await withSnapshots();
    const reads = () => w.state.calls.reads;
    const before = reads();
    await boot(w);
    expect(reads() - before).toBe(1); // the pointer only
  });

  it("[LDB-RP2] no pointer yet: replay from 0, with the reason logged", async () => {
    const w = await world();
    await churn(w.replica, 5);
    const lines: string[] = [];
    const r = await boot(w, lines);
    expect(bootReportOf(r)).toMatchObject({ path: "replay" });
    expect(bootReportOf(r)!.fallbacks).toEqual(["pointer: none recorded", "prev: none recorded"]);
    expect(lines.at(-1)).toMatch(/^akldb-boot: path=replay .*none recorded/);
  });

  it("[LDB-RP2] a pointer ahead of the log (the log was restored to an earlier point) is not trusted: PREV or a replay is", async () => {
    const { w, first, second } = await withSnapshots();
    const shorter = w.log.clone();
    // a log that stops before the pointer's seq: only PREV (first) is at or below it
    const cut = first.seq + 2;
    expect(cut).toBeLessThan(second.seq);
    const chopped = await (async () => {
      const l = new (await import("../../src/replica/log-memory")).MemoryLog({}, w.blobs);
      const r = new Replica(l, FAST);
      for (const e of shorter.entries().slice(0, cut)) await l.append(e.seq - 1, { unitId: e.unitId, kind: e.kind, stmts: e.stmts, hash: e.hash, name: e.name, at: e.at });
      r.close();
      return l;
    })();
    const r = await bootReplica(chopped, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: () => {} });
    expect(bootReportOf(r)!.path).toBe("prev");
    expect(r.seq).toBe(cut);
  });

  it("[LDB-RP2] a tail that does not replay on the snapshot (a snapshot of a different history) falls back instead of serving it", async () => {
    const { w, second } = await withSnapshots();
    // a snapshot of ANOTHER database claiming the pointer's seq: it decompresses and checksums fine, but the tail cannot apply
    const alien = await world();
    await churn(alien.replica, 40, 77);
    const cap = await alien.replica.capture();
    const compressed = zstdCompress(cap.bytes, 3);
    const ref: SnapRef = { ...second, sha256: sha(cap.bytes), size: cap.bytes.byteLength, compressed: compressed.byteLength };
    w.objects.objects.set(second.key, { bytes: Uint8Array.from(compressed), meta: { sha256: ref.sha256 } });
    w.state.set("pointer", ref);
    const lines: string[] = [];
    const r = await boot(w, lines);
    expect(bootReportOf(r)!.path).not.toBe("pointer");
    expect(lines.some((l) => /^akldb-alarm: boot: fallback: pointer unusable: .*(does not replay|not a readable)/.test(l))).toBe(true);
    expect(lines.filter((l) => l.startsWith("akldb-alarm: "))).toHaveLength(lines.filter((l) => /path=|^akldb-alarm/.test(l)).length - 1); // one alarm per fallback taken, none from the discarded replica
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
  });

  it("[LDB-RP2] entries that land while the snapshot downloads are replayed before boot resolves: the booted replica is at the head it was served at", async () => {
    const { w } = await withSnapshots();
    // after the boot's first head read, another writer commits; boot must still end at the NEW head
    let heads = 0;
    const late: CommitLog = {
      head: async () => {
        const h = await w.log.head();
        if (++heads === 1) await churn(w.replica, 4, 11);
        return h;
      },
      read: (a, b) => w.log.read(a, b),
      append: (h, e) => w.log.append(h, e),
      get: (s) => w.log.get(s),
    };
    const r = await bootReplica(late, { ...FAST, snapshots: { state: w.state, objects: w.objects }, logLine: () => {} });
    expect(r.seq).toBe(w.log.length);
    expect(digestOf(r)).toBe(digestOf(await replayFrom0(w.log)));
  });

  it("[LDB-RP2] without a snapshot store, boot is phase C's replay from 0 (same signature)", async () => {
    const w = await world();
    await churn(w.replica, 5);
    const lines: string[] = [];
    const r = await bootReplica(w.log, { ...FAST, logLine: (m) => void lines.push(m) });
    expect(r.seq).toBe(w.log.length);
    expect(lines[0]).toMatch(/path=replay .*no snapshot store/);
  });
});
