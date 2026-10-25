// [LDB-DDB87] The fuzzer's dump masking rule (lane L): the compressed `sha256`
// and `bytes` of dump records are the only things masked (gzip encoders differ
// between workerd and Node); everything else, and any content difference in
// the gunzipped dump, still fails.
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

const MOD = "../../scripts/lab/fuzz/dumpmask.mjs";
type Mask = {
  maskDumpRecords(v: unknown): unknown;
  comparableBody(path: string, b: Buffer): Buffer;
  comparableDump(b: Buffer): Buffer;
  maskStateRows(s: Record<string, Record<string, unknown>[]>): Record<string, Record<string, unknown>[]>;
};
const load = async () => (await import(/* @vite-ignore */ MOD)) as Mask;

const rec = (sha: string, bytes: number, extra: Record<string, unknown> = {}) => ({ date: "2026-10-25", key: "dump-2026-10-25.json.gz", url: "/v1/dump/dump-2026-10-25.json.gz", sha256: sha, bytes, layout_count: 3, seq: 9, ...extra });
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("dump masking", () => {
  it("[LDB-DDB87] masks sha256 and bytes of a dump record, wherever it sits, and nothing else", async () => {
    const m = await load();
    const j = (v: unknown) => JSON.stringify(v);
    expect(j(m.maskDumpRecords(rec(A, 100)))).toBe(j(m.maskDumpRecords(rec(B, 117))));
    expect(j(m.maskDumpRecords({ ran: true, dump: { latest: rec(A, 1) } }))).toBe(j(m.maskDumpRecords({ ran: true, dump: { latest: rec(B, 2) } })));
    // other fields of the record still differ
    expect(j(m.maskDumpRecords(rec(A, 1)))).not.toBe(j(m.maskDumpRecords(rec(A, 1, { seq: 10 }))));
    expect(j(m.maskDumpRecords(rec(A, 1)))).not.toBe(j(m.maskDumpRecords(rec(A, 1, { key: "dump-2026-10-26.json.gz" }))));
    // an object that merely has sha256/bytes fields, or a bad key, is not a dump record
    expect(j(m.maskDumpRecords({ sha256: A, bytes: 1 }))).not.toBe(j(m.maskDumpRecords({ sha256: B, bytes: 1 })));
    expect(j(m.maskDumpRecords({ key: "layout", sha256: A, bytes: 1 }))).not.toBe(j(m.maskDumpRecords({ key: "layout", sha256: B, bytes: 1 })));
    // JSON-encoded cells (event detail_json, state values)
    const ev = (r: unknown) => ({ events: [{ kind: "dump.written", detail_json: JSON.stringify(r) }] });
    expect(j(m.maskDumpRecords(ev(rec(A, 1))))).toBe(j(m.maskDumpRecords(ev(rec(B, 2)))));
    expect(j(m.maskDumpRecords(ev(rec(A, 1))))).not.toBe(j(m.maskDumpRecords(ev(rec(A, 1, { layout_count: 4 })))));
    const st = (r: unknown) => ({ state: [{ key: "dump.latest", value: JSON.stringify(r) }], layouts: [{ id: "x", name: A }] });
    expect(m.maskStateRows(st(rec(A, 1)))).toEqual(m.maskStateRows(st(rec(B, 2))));
  });

  it("[LDB-DDB87] dump objects compare gunzipped: different gzip bytes of equal content pass, a content difference fails", async () => {
    const m = await load();
    const content = Buffer.from(JSON.stringify({ meta: { seq: 3 }, records: [1, 2, 3] }));
    const p = "/v1/dump/dump-2026-10-25.json.gz";
    const fast = zlib.gzipSync(content, { level: 1 });
    const best = zlib.gzipSync(content, { level: 9, memLevel: 9 });
    expect(Buffer.compare(fast, best)).not.toBe(0);
    expect(m.comparableBody(p, fast).equals(m.comparableBody(p, best))).toBe(true);
    const other = zlib.gzipSync(Buffer.from(JSON.stringify({ meta: { seq: 4 }, records: [1, 2, 3] })));
    expect(m.comparableBody(p, fast).equals(m.comparableBody(p, other))).toBe(false);
    // a dump holds earlier dumps' events: their embedded records are masked, the rest of the event is not
    const dumpWith = (r: unknown, seq = 3) => zlib.gzipSync(Buffer.from(JSON.stringify({ meta: { seq }, events: [{ kind: "admin.nightly_ticked", detail_json: JSON.stringify({ dump: { latest: r } }) }] })));
    expect(m.comparableDump(dumpWith(rec(A, 1))).equals(m.comparableDump(dumpWith(rec(B, 2))))).toBe(true);
    expect(m.comparableDump(dumpWith(rec(A, 1))).equals(m.comparableDump(dumpWith(rec(A, 1, { seq: 8 }))))).toBe(false);
    expect(m.comparableDump(dumpWith(rec(A, 1))).equals(m.comparableDump(dumpWith(rec(A, 1), 4)))).toBe(false);
    // other routes are not unzipped, and their JSON is masked only for dump records
    expect(m.comparableBody("/v1/layouts", fast).equals(fast)).toBe(true);
    const latest = (r: unknown) => m.comparableBody("/v1/dump/latest.json", Buffer.from(JSON.stringify(r)));
    expect(latest(rec(A, 1)).equals(latest(rec(B, 2)))).toBe(true);
    expect(latest(rec(A, 1)).equals(latest(rec(A, 1, { seq: 2 })))).toBe(false);
  });
});
