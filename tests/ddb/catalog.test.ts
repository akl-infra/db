// [LDB-DDB21..DDB28] The catalog read model (lane H): exact snapshots, freshness, convergence, boot and snapshot.
import { TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { createCatalog, SNAPSHOT_KEY } from "../../src/store/ddb/catalog";
import type { DdbContext } from "../../src/store/ddb/contracts";
import { SPILL_BYTES } from "../../src/store/ddb/payload";
import { txTuning } from "../../src/store/ddb/tx";
import { ddbHarness } from "../harness/ddb";
import { mulberry32, resetTables, Writer } from "./catalog-fixture";

const blobsOf = () => ddbHarness.blobs as typeof ddbHarness.blobs & { objects: Map<string, { bytes: Uint8Array; contentType: string }> };
const newCatalog = (doc?: DdbContext["doc"]) => createCatalog({ ...ddbHarness.ctxBase, ...(doc === undefined ? {} : { doc }) });
const T0 = "2026-01-01T00:00:00.000Z";
const at = (n: number) => new Date(Date.parse(T0) + n * 1000).toISOString();

/** A document client that runs `hook` before each command (to move HEAD between the catalog's reads). */
function hooked(hook: (cmd: object) => Promise<void>): DdbContext["doc"] {
  return new Proxy(ddbHarness.doc, {
    get(target, prop) {
      if (prop === "send") return async (cmd: object, ...r: unknown[]) => (await hook(cmd), (target.send as (...a: unknown[]) => unknown)(cmd, ...r));
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

beforeEach(async () => {
  await resetTables();
  blobsOf().objects.clear();
  // the real backoff shape, scaled down: retries with no delay run in lockstep and exhaust their attempts
  txTuning.sleep = (ms) => new Promise((r) => setTimeout(r, ms / 5));
});

describe("catalog view", () => {
  it("[LDB-DDB21] holds every layout, tombstones included, likers ascending, spilled payloads inlined", async () => {
    const w = new Writer();
    const big = JSON.stringify({ pad: "x".repeat(SPILL_BYTES + 10) });
    await w.create("A1", "Alpha", "u1", at(1));
    await w.create("B2", "bravo", "u2", at(2), big);
    await w.create("C3", "Charlie", "u1", at(3));
    await w.like("A1", "zed", at(4));
    await w.like("A1", "adam", at(5));
    await w.like("A1", "Mike", at(6));
    await w.remove("C3", at(7));
    expect([...blobsOf().objects.keys()].some((k) => k.startsWith("payloads/"))).toBe(true);

    const view = await newCatalog().current();
    expect(view.seq).toBe(w.lastSeq);
    expect(view.layouts.get("C3")!.layout.deleted).toBe(true);
    expect(view.layouts.get("A1")!.likers).toEqual(["Mike", "adam", "zed"]);
    expect(view.layouts.get("B2")!.formats.get("spark")!.payload).toEqual(JSON.parse(big));
    expect(view.layouts).toEqual(await w.expectedAt(view.seq));
  });

  it("[LDB-DDB22] a call sees every write that finished before it, however calls overlap", async () => {
    const w = new Writer();
    const cat = newCatalog();
    await w.create("A1", "Alpha", "u1", at(1));
    expect((await cat.current()).seq).toBe(w.lastSeq);
    for (let i = 2; i < 8; i++) {
      const seq = await w.update("A1", at(i), `{"v":${i}}`);
      const views = await Promise.all([cat.current(), cat.current(), cat.current()]);
      for (const v of views) {
        expect(v.seq).toBeGreaterThanOrEqual(seq);
        expect(v.layouts.get("A1")!.formats.get("spark")!.payload).toEqual({ v: i });
      }
    }
    // nothing changed: the same view comes back, with no layout read
    const a = await cat.current();
    const { result: b, calls } = await ddbHarness.calls.measure(() => cat.current());
    expect(b).toBe(a);
    expect(calls.byCommand).toEqual({ Get: 1 });
  });

  it("[LDB-DDB23] under concurrent writers every view equals the replay of the log at its own seq", async () => {
    const w = new Writer();
    const cat = newCatalog();
    const rnd = mulberry32(11);
    const ids = Array.from({ length: 4 }, (_, i) => `L${i}`);
    for (const [i, id] of ids.entries()) await w.create(id, `Name${i}`, `u${i % 3}`, at(i));
    const views: { seq: number; layouts: ReturnType<typeof w.expectedAt> | unknown; raw: Awaited<ReturnType<typeof cat.current>> }[] = [];
    let stop = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const reader = (async () => {
      while (!stop) {
        // a reader may give up under writes that never pause (LDB-DDB24); it must never return a wrong view
        const v = await cat.current().catch(() => null);
        if (v !== null) views.push({ seq: v.seq, layouts: null, raw: v });
        await sleep(1);
      }
    })();
    // each layout is driven by one chain of operations; the chains run in parallel
    await Promise.all(
      ids.map(async (id, i) => {
        for (let k = 0; k < 6; k++) {
          await sleep(20 + Math.floor(rnd() * 30));
          const r = rnd();
          // an operation may give up under contention (the writer's retries are bounded); the shadow then rolls back
          if (r < 0.4) await w.update(id, at(100 + i * 10 + k), `{"i":${i},"k":${k}}`).catch(() => {});
          else if (r < 0.8) await w.like(id, `liker${Math.floor(rnd() * 5)}`, at(100 + i * 10 + k)).catch(() => {});
          else await w.update(id, at(100 + i * 10 + k), `{"i":${i},"k":${k},"pad":1}`).catch(() => {});
        }
      }),
    );
    stop = true;
    await reader;
    views.push({ seq: 0, layouts: null, raw: await cat.current() });
    // how many views the reader got mid-run depends on timing (it may give up under writes that never pause); the final one always exists
    expect(views.length).toBeGreaterThanOrEqual(1);
    for (const v of views) expect(v.raw.layouts, `view at seq ${v.raw.seq}`).toEqual(await w.expectedAt(v.raw.seq));
  });

  it("[LDB-DDB24] converges when HEAD moves between the HEAD read and the layout read, and gives up after 5 rounds", async () => {
    const w = new Writer();
    await w.create("A1", "Alpha", "u1", at(1));
    await w.create("B2", "Bravo", "u1", at(2));
    let armed = false;
    let n = 0;
    const once = newCatalog(
      hooked(async (cmd) => {
        // one concurrent write lands between the catalog's event read and its layout read
        if (armed && cmd instanceof TransactGetCommand && n++ === 0) await w.update("B2", at(4), '{"v":4}');
      }),
    );
    await once.current();
    await w.update("A1", at(3), '{"v":3}');
    armed = true;
    const v = await once.current();
    expect(n).toBeGreaterThan(0);
    expect(v.seq).toBe(w.lastSeq);
    expect(v.layouts).toEqual(await w.expectedAt(v.seq));

    // a writer that never stops
    let k = 5;
    let hammer = false;
    const never = newCatalog(
      hooked(async (cmd) => {
        if (hammer && cmd instanceof TransactGetCommand) await w.update("A1", at(k), `{"v":${k++}}`);
      }),
    );
    await never.current();
    await w.update("A1", at(k), `{"v":${k++}}`);
    hammer = true;
    await expect(never.current()).rejects.toThrow();
    expect(k).toBeGreaterThanOrEqual(10);
    // the failure leaves nothing half-applied: a fresh catalog reads an exact view
    const fresh = await newCatalog().current();
    expect(fresh.layouts).toEqual(await w.expectedAt(fresh.seq));
  });

  it("[LDB-DDB25] a refresh reads only the layouts the new events name", async () => {
    const w = new Writer();
    for (let i = 0; i < 30; i++) await w.create(`L${String(i).padStart(2, "0")}`, `n${i}`, "u", at(i));
    const cat = newCatalog();
    await cat.current();
    await w.update("L05", at(40), '{"v":1}');
    await w.like("L07", "someone", at(41));
    const { result: v, calls } = await ddbHarness.calls.measure(() => cat.current());
    expect(v.layouts).toEqual(await w.expectedAt(v.seq));
    expect(calls.byCommand.Scan ?? 0).toBe(0);
    // HEAD, the events, one TransactGet of HEAD + 2 layouts, the likers of the liked layout, HEAD again
    expect(calls.byCommand).toEqual({ Get: 2, Query: 2, TransactGet: 1 });
  });
});

describe("catalog boot and snapshot", () => {
  it("[LDB-DDB26] boots from the snapshot with no scan, then catches up; writes only when HEAD moved", async () => {
    const w = new Writer();
    for (let i = 0; i < 12; i++) await w.create(`L${i}`, `n${i}`, "u", at(i));
    await w.like("L3", "u9", at(20));
    const a = newCatalog();
    const s1 = w.lastSeq;
    expect(await a.writeSnapshot()).toEqual({ seq: s1, written: true });
    expect(await a.writeSnapshot()).toEqual({ seq: s1, written: false });
    const stored = blobsOf().objects.get(SNAPSHOT_KEY)!;
    await w.update("L4", at(21), '{"v":2}');

    const b = newCatalog();
    const { result: v, calls } = await ddbHarness.calls.measure(() => b.current());
    expect(calls.byCommand.Scan ?? 0).toBe(0);
    expect(v.seq).toBe(w.lastSeq);
    expect(v.layouts).toEqual(await w.expectedAt(v.seq));
    expect(await b.writeSnapshot()).toEqual({ seq: w.lastSeq, written: true });
    expect(blobsOf().objects.get(SNAPSHOT_KEY)).not.toBe(stored);
  });

  it("[LDB-DDB27] a missing, garbled, inconsistent or too-new snapshot falls back to a scan and the view is still exact", async () => {
    const w = new Writer();
    for (let i = 0; i < 6; i++) await w.create(`L${i}`, `n${i}`, "u", at(i));
    await w.like("L1", "x", at(9));
    const good = newCatalog();
    await good.writeSnapshot();
    const goodBytes = blobsOf().objects.get(SNAPSHOT_KEY)!.bytes;
    const put = (bytes: Uint8Array) => blobsOf().put(SNAPSHOT_KEY, bytes, "application/gzip");
    const gz = async (text: string) => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

    const cases: [string, () => Promise<void>][] = [
      ["missing", async () => void blobsOf().objects.delete(SNAPSHOT_KEY)],
      ["garbage", () => put(new TextEncoder().encode("not gzip at all"))],
      ["truncated", () => put(goodBytes.slice(0, Math.floor(goodBytes.length / 2)))],
      ["header and body disagree", async () => put(await gz('AKLSNAP1 3\n{"v":1,"seq":4,"layouts":[]}'))],
      ["ahead of HEAD", async () => put(await gz('AKLSNAP1 999\n{"v":1,"seq":999,"layouts":[]}'))],
      ["valid but empty and behind", async () => put(await gz('AKLSNAP1 0\n{"v":1,"seq":0,"layouts":[]}'))],
    ];
    for (const [name, arrange] of cases) {
      await arrange();
      const { result: v, calls } = await ddbHarness.calls.measure(() => newCatalog().current());
      expect(v.layouts, name).toEqual(await w.expectedAt(v.seq));
      expect(v.seq, name).toBe(w.lastSeq);
      if (name !== "valid but empty and behind") expect(calls.byCommand.Scan, name).toBe(1);
    }
  });

  it("[LDB-DDB28] a writer holding an older view never regresses the stored snapshot", async () => {
    const w = new Writer();
    await w.create("A1", "Alpha", "u", at(1));
    await w.create("B2", "Bravo", "u", at(2));
    const cat = newCatalog();
    // a newer writer already stored seq 50 (its body is irrelevant to the check)
    const newer = new Uint8Array(await new Response(new Blob(['AKLSNAP1 50\n{"v":1,"seq":50,"layouts":[]}']).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    await blobsOf().put(SNAPSHOT_KEY, newer, "application/gzip");
    const before = blobsOf().objects.get(SNAPSHOT_KEY)!;
    expect(await cat.writeSnapshot()).toEqual({ seq: 50, written: false });
    expect(blobsOf().objects.get(SNAPSHOT_KEY)).toBe(before);
  });
});

describe("catalog rebuild", () => {
  it("[LDB-DDB27] rebuildFromScan is exact, independent of the snapshot and of the cached model", async () => {
    const w = new Writer();
    const rnd = mulberry32(5);
    for (let i = 0; i < 10; i++) await w.create(`L${i}`, `n${i}`, "u", at(i));
    const cat = newCatalog();
    const cached = await cat.current();
    for (let i = 0; i < 20; i++) await w.like(`L${Math.floor(rnd() * 10)}`, `u${Math.floor(rnd() * 6)}`, at(30 + i)).catch(() => {});
    const scanned = await cat.rebuildFromScan();
    expect(scanned.layouts).toEqual(await w.expectedAt(scanned.seq));
    expect(scanned.seq).toBeGreaterThan(cached.seq);
    expect(await cat.current()).toEqual(scanned);
  });
});
