// Lane S: the response differ, the state differ and the fake-Discord record diff (scripts/lab/diff/). Pure and local.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = path.join(process.cwd(), "scripts/lab/diff");
const load = async (f: string): Promise<any> => import(/* @vite-ignore */ path.join(D, f));
const res = (status: number, headers: Record<string, string>, text: string) => ({ status, headers, body: Buffer.from(text) });
const meta = (a1: number, a2: number | null) => JSON.stringify({ seq: 5, health: { dump: { last_at: "x", age_s: a1, stale: false }, diff: { last_at: "y", age_s: a2, stale: false } } });

describe("diff (lane S)", () => {
  it("[LDB-PG47] diffPair(a, b, ctx) reports status, contract-header and body-byte differences with the first differing byte", async () => {
    const { diffPair } = await load("pair.mjs");
    expect(diffPair.length).toBeGreaterThanOrEqual(2);
    const ok = res(200, { etag: '"1"', "content-type": "application/json" }, '{"a":1}');
    expect(diffPair(ok, res(200, { etag: '"1"', "content-type": "application/json" }, '{"a":1}'), {})).toEqual([]);
    expect(diffPair(ok, ok)).toEqual([]);
    expect(diffPair(ok, res(404, { etag: '"2"', "content-type": "application/json" }, '{"a":2}'), {}).map((p: any) => p.kind)).toEqual(["status", "header", "body"]);
    const [b] = diffPair(ok, res(200, { etag: '"1"', "content-type": "application/json" }, '{"a":2}'), {});
    expect(b.detail).toContain("byte 5");
    // a header the contract does not list is not compared
    expect(diffPair(ok, res(200, { etag: '"1"', "content-type": "application/json", "x-other": "1" }, '{"a":1}'), {})).toEqual([]);
    // a differing content-length is a problem when nothing was masked
    expect(diffPair(res(200, { "content-length": "7" }, '{"a":1}'), res(200, { "content-length": "8" }, '{"a":1}'), {}).map((p: any) => p.kind)).toEqual(["header"]);
  });

  it("[LDB-PG48] the allow-list holds only health.*.age_s: a differing age_s passes, any other difference in the same body fails", async () => {
    const { diffPair, loadAllowList } = await load("pair.mjs");
    const allow = JSON.parse(fs.readFileSync(path.join(D, "allow.json"), "utf8")).allow;
    expect(allow.map((e: any) => e.path)).toEqual(["health.*.age_s"]);
    expect(loadAllowList()).toEqual([["health", "*", "age_s"]]);
    const h = { etag: '"m"', "content-length": "1" };
    const ctx = { path: "/v1/meta", query: "" };
    // age_s 9 vs 12345 (different digit count -> content-length differs too) and null vs a number
    expect(diffPair(res(200, h, meta(9, null)), res(200, { ...h, "content-length": "2" }, meta(12345, 3)), ctx)).toEqual([]);
    // the same masked body with a different `stale`, `last_at` or `seq` is still a diff
    const stale = JSON.parse(meta(9, 1));
    stale.health.dump.stale = true;
    expect(diffPair(res(200, h, meta(9, 1)), res(200, h, JSON.stringify(stale)), ctx).map((p: any) => p.kind)).toEqual(["body"]);
    const seq = JSON.parse(meta(9, 1));
    seq.seq = 6;
    expect(diffPair(res(200, h, meta(9, 1)), res(200, h, JSON.stringify(seq)), ctx).map((p: any) => p.kind)).toEqual(["body"]);
    // an age_s anywhere else (not under health.<x>) is not allowed
    const other = (n: number) => JSON.stringify({ age_s: n, health: { age_s: n } });
    expect(diffPair(res(200, h, other(1)), res(200, h, other(2)), ctx).map((p: any) => p.kind)).toEqual(["body"]);
    // a non-numeric age_s is not masked
    const str = (v: string) => JSON.stringify({ health: { dump: { age_s: v } } });
    expect(diffPair(res(200, h, str("a")), res(200, h, str("b")), ctx).map((p: any) => p.kind)).toEqual(["body"]);
    // non-JSON bodies compare as bytes
    expect(diffPair(res(200, {}, "abc"), res(200, {}, "abd"), ctx).map((p: any) => p.kind)).toEqual(["body"]);
  });

  it("[LDB-PG49] the state diff compares per-table multisets of canonical rows, names the first differing row, and masks dump records", async () => {
    const { diffStates, diffExports, renderStateDiff } = await load("state.mjs");
    const a = { layouts: [{ id: "1", name: "x" }, { id: "2", name: "y" }], authors: [{ user_id: "u" }], empty: [] };
    // column order and row order do not matter
    expect(diffStates(a, { layouts: [{ name: "y", id: "2" }, { name: "x", id: "1" }], authors: [{ user_id: "u" }], empty: [] })).toEqual([]);
    const d = diffStates(a, { layouts: [{ id: "1", name: "x" }, { id: "2", name: "CHANGED" }], authors: [], extra: [{ k: 1 }] });
    expect(d.map((x: any) => x.table)).toEqual(["authors", "extra", "layouts"]);
    const lay = d.find((x: any) => x.table === "layouts");
    expect(lay.rows).toEqual([2, 2]);
    expect(lay.first.side).toBe("other"); // "CHANGED" sorts before "y"
    expect(lay.first.row).toBe('{"id":"2","name":"CHANGED"}');
    expect(d.find((x: any) => x.table === "extra").first.side).toBe("other");
    expect(diffStates(a, { layouts: [], authors: [], empty: [] }, ["layouts"]).map((x: any) => x.table)).toEqual(["authors"]);
    expect(renderStateDiff(d)).toContain("state layouts: 2 vs 2 rows; first differing row (other only)");
    // dump records differ only in the compressed sha256/bytes: masked
    const rec = (sha: string, bytes: number) => ({ id: 1, detail_json: JSON.stringify({ key: "dump-2026-10-25.json.gz", sha256: sha.repeat(64), bytes }) });
    expect(diffExports({ events: [rec("a", 10)] }, { events: [rec("b", 11)] })).toEqual([]);
    expect(diffExports({ events: [rec("a", 10)] }, { events: [{ ...rec("a", 10), id: 2 }] }).length).toBe(1);
  });

  it("[LDB-PG50] the fuzzer and the replay use the shared differ modules (no copies)", () => {
    const fuzz = fs.readFileSync(path.join(process.cwd(), "scripts/lab/fuzz/run.mjs"), "utf8");
    expect(fuzz).toContain('from "../diff/state.mjs"');
    expect(fuzz).not.toMatch(/^function canonRow|^export function diffStates/m);
    const replay = fs.readFileSync(path.join(process.cwd(), "scripts/lab/replay/replay.mjs"), "utf8");
    expect(replay).toContain('from "../diff/pair.mjs"');
    expect(fs.existsSync(path.join(process.cwd(), "scripts/lab/replay/diff-shim.mjs"))).toBe(false);
    const pair = fs.readFileSync(path.join(D, "pair.mjs"), "utf8");
    expect(pair).toContain('from "../p1-crawl-diff.mjs"');
    expect(pair).toContain('from "../fuzz/dumpmask.mjs"');
  });

  it("[LDB-PG51] the fake-Discord record diff ignores seq, at and transport headers only, names the first differing call, and can compare as a multiset", async () => {
    const { diffRecords, parseRecord, normalizeCall } = await load("discord.mjs");
    const call = (seq: number, over: any = {}) => ({ seq, at: `2026-11-01T00:00:0${seq}Z`, method: "POST", path: "/api/v10/channels/9/messages", authKind: "bot", headers: { "content-type": "application/json", host: `h${seq}`, "user-agent": `ua${seq}` }, body: { content: "hi" }, status: 200, injected: null, ...over });
    const a = [call(1), call(2, { path: "/api/v10/channels/9/messages/5", method: "PATCH" })];
    const b = [call(7, { headers: { "content-type": "application/json", host: "other", "user-agent": "node" } }), call(8, { path: "/api/v10/channels/9/messages/5", method: "PATCH" })];
    expect(diffRecords(a, b).ok).toBe(true);
    const bad = [b[0], { ...b[1], body: { content: "hello" } }];
    const r = diffRecords(a, bad);
    expect(r.ok).toBe(false);
    expect(r.problems[0].index).toBe(1);
    expect(r.problems[0].detail).toContain("differing: body");
    // a content-type difference is real
    expect(diffRecords(a, [{ ...b[0], headers: { "content-type": "text/plain" } }, b[1]]).ok).toBe(false);
    // different counts
    expect(diffRecords(a, [b[0]]).problems.map((p: any) => p.kind)).toEqual(["count"]);
    // order matters unless unordered
    expect(diffRecords(a, [b[1], b[0]]).ok).toBe(false);
    expect(diffRecords(a, [b[1], b[0]], { ordered: false }).ok).toBe(true);
    expect(diffRecords(a, [b[0], b[0]], { ordered: false }).problems[0].kind).toBe("oracle-only");
    // NDJSON in, and the credential never appears in what is compared
    expect(parseRecord(`${JSON.stringify(a[0])}\n\n${JSON.stringify(a[1])}\n`)).toHaveLength(2);
    expect(Object.keys(normalizeCall(a[0]))).not.toContain("seq");
    expect(() => parseRecord("{nope")).toThrow(/line 1/);
  });

  it("[LDB-PG51] the diff CLI exits 0 for equal inputs, 1 for a difference, 2 for bad usage", async () => {
    const os = await import("node:os");
    const { main } = await load("index.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg51-"));
    const w = (n: string, t: string) => {
      const f = path.join(dir, n);
      fs.writeFileSync(f, t);
      return f;
    };
    const line = (s: number, st: number) => `${JSON.stringify({ seq: s, at: "t", method: "GET", path: "/p", status: st })}\n`;
    const quiet = (fn: () => number) => {
      const log = console.log;
      console.log = () => {};
      try {
        return fn();
      } finally {
        console.log = log;
      }
    };
    try {
      expect(quiet(() => main(["discord", w("a", line(1, 200)), w("b", line(9, 200))]))).toBe(0);
      expect(quiet(() => main(["discord", w("a2", line(1, 200)), w("b2", line(1, 500))]))).toBe(1);
      expect(quiet(() => main(["state", w("s1", '{"t":[{"a":1}]}'), w("s2", '{"t":[{"a":1}]}')]))).toBe(0);
      expect(quiet(() => main(["state", w("s3", '{"t":[{"a":1}]}'), w("s4", '{"t":[]}')]))).toBe(1);
      const err = console.error;
      console.error = () => {};
      try {
        expect(main(["bogus"])).toBe(2);
      } finally {
        console.error = err;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
