// [LDB-CV20] The dump history moves from R2 to S3 (scripts/cutover/dumps.mjs) before the flip, object by object and proven, and the dump routes of
// the two sides answer identically (status, Content-Type, Cache-Control, ETag, redirect, bytes).
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { copyDumps } from "../../scripts/cutover/dumps.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { r2Source, s3Destination } from "../../scripts/cutover/dumps-real.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { main as copyMain } from "../../scripts/cutover/copy-dumps.mjs";
import { cleanup, makeWorld, type World } from "./world";

let w: World;
afterEach(() => w && cleanup(w));
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const text = (r: { out: string[] }) => r.out.join("\n");

type Store = Map<string, { bytes: Uint8Array; contentType: string }>;
const enc = (s: string) => new TextEncoder().encode(s);
function stores() {
  const r2: Store = new Map([
    ["latest.json", { bytes: enc('{"key":"dump-2026-11-03.json.gz"}'), contentType: "application/json" }],
    ["dump-2026-11-02.json.gz", { bytes: enc("one"), contentType: "application/gzip" }],
    ["monthly/dump-2026-10.json.gz", { bytes: enc("month"), contentType: "application/gzip" }],
    ["latest.spark-1.json.sha256", { bytes: enc("sum"), contentType: "text/plain" }],
  ]);
  const s3: Store = new Map();
  const src = {
    list: async () => [...r2].map(([key, o]) => ({ key, size: o.bytes.byteLength, etag: `"${md5(o.bytes)}"` })),
    get: async (key: string, opts: { headOnly?: boolean } = {}) => ({ bytes: opts.headOnly ? new Uint8Array(0) : r2.get(key)!.bytes, contentType: r2.get(key)!.contentType, etag: `"${md5(r2.get(key)!.bytes)}"`, size: r2.get(key)!.bytes.byteLength }),
  };
  const dst = {
    head: async (key: string) => (s3.has(key) ? { size: s3.get(key)!.bytes.byteLength, etag: `"${md5(s3.get(key)!.bytes)}"`, contentType: s3.get(key)!.contentType } : null),
    put: async (key: string, bytes: Uint8Array, contentType: string) => void s3.set(key, { bytes, contentType }),
  };
  return { r2, s3, src, dst };
}

describe("copyDumps (CV20)", () => {
  it("[LDB-CV20] copies every object with its content type, verifies md5 and size, skips what is already there, and picks up what changed", async () => {
    const { r2, s3, src, dst } = stores();
    const dry = await copyDumps({ src, dst, dryRun: true });
    expect(dry.copied).toHaveLength(4);
    expect(s3.size).toBe(0);
    const r = await copyDumps({ src, dst });
    expect(r).toMatchObject({ ok: true, objects: 4, skipped: [] });
    expect(r.copied.sort()).toEqual([...r2.keys()].sort());
    for (const [k, o] of r2) expect(s3.get(k)).toEqual(o); // bytes AND content type
    const again = await copyDumps({ src, dst });
    expect(again).toMatchObject({ ok: true, copied: [], bytes: 0 });
    expect(again.skipped).toHaveLength(4);
    // a new dump and a changed latest.json are the only things the re-sync copies
    r2.set("dump-2026-11-03.json.gz", { bytes: enc("two"), contentType: "application/gzip" });
    r2.set("latest.json", { bytes: enc('{"key":"dump-2026-11-03.json.gz","n":2}'), contentType: "application/json" });
    const resync = await copyDumps({ src, dst });
    expect(resync.copied.sort()).toEqual(["dump-2026-11-03.json.gz", "latest.json"]);
    expect(resync.skipped).toHaveLength(3);
    // a content type that drifted on S3 is repaired
    s3.get("latest.spark-1.json.sha256")!.contentType = "binary/octet-stream";
    expect((await copyDumps({ src, dst })).copied).toEqual(["latest.spark-1.json.sha256"]);
    expect(s3.get("latest.spark-1.json.sha256")!.contentType).toBe("text/plain");
  });

  it("[LDB-CV20] a damaged transfer, a wrong size and an S3 that loses the content type are mismatches, named, and ok is false", async () => {
    const a = stores();
    const damaged = { ...a.src, get: async (key: string, o?: { headOnly?: boolean }) => { const g = await a.src.get(key, o); return key === "dump-2026-11-02.json.gz" && !o?.headOnly ? { ...g, bytes: enc("0ne") } : g; } };
    const r = await copyDumps({ src: damaged, dst: a.dst });
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([{ key: "dump-2026-11-02.json.gz", why: expect.stringContaining("R2 bytes have md5") }]);
    expect(a.s3.has("dump-2026-11-02.json.gz")).toBe(false); // nothing wrong is stored
    const b = stores();
    const short = { ...b.src, list: async () => (await b.src.list()).map((o: { key: string; size: number; etag: string }) => (o.key === "latest.json" ? { ...o, size: o.size + 1 } : o)) };
    expect((await copyDumps({ src: short, dst: b.dst })).mismatches[0]).toMatchObject({ key: "latest.json", why: expect.stringContaining("listed") });
    const c = stores();
    const lossy = { ...c.dst, put: async (k: string, bytes: Uint8Array) => void c.s3.set(k, { bytes, contentType: "binary/octet-stream" }) };
    const lr = await copyDumps({ src: c.src, dst: lossy });
    expect(lr.ok).toBe(false);
    expect(lr.mismatches.every((m: { why: string }) => m.why.includes("content type"))).toBe(true);
  });

  it("[LDB-CV20] the real ends: R2 through its S3 API (list pages, XML escapes, HEAD) and S3 under dumps/, signed, with nothing but fetch", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: Request | string) => {
      const req = typeof input === "string" ? new Request(input) : input;
      calls.push(`${req.method} ${new URL(req.url).host}${new URL(req.url).pathname}${new URL(req.url).search}`);
      expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
      const u = new URL(req.url);
      if (u.host.includes("r2.cloudflarestorage.com")) {
        if (u.search.startsWith("?list-type=2")) {
          const second = u.searchParams.has("continuation-token");
          return new Response(second ? `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>monthly/dump-2026-10.json.gz</Key><Size>5</Size><ETag>&quot;${md5(enc("month"))}&quot;</ETag></Contents></ListBucketResult>` : `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken><Contents><Key>latest.json</Key><Size>2</Size><ETag>&quot;${md5(enc("{}"))}&quot;</ETag></Contents></ListBucketResult>`);
        }
        return new Response(req.method === "HEAD" ? null : u.pathname.endsWith("latest.json") ? "{}" : "month", { headers: { "content-type": u.pathname.endsWith("latest.json") ? "application/json" : "application/gzip", etag: `"x"`, "content-length": u.pathname.endsWith("latest.json") ? "2" : "5" } });
      }
      if (req.method === "HEAD") return new Response(null, { status: 404 });
      return new Response("", { status: 200 });
    };
    const src = r2Source({ accountId: "acct", accessKeyId: "k", secretAccessKey: "s", fetchImpl });
    expect((await src.list()).map((o: { key: string }) => o.key)).toEqual(["latest.json", "monthly/dump-2026-10.json.gz"]);
    expect(calls.some((c) => c.includes("continuation-token=tok%261"))).toBe(true);
    expect((await src.get("monthly/dump-2026-10.json.gz")).contentType).toBe("application/gzip");
    const dst = s3Destination({ bucket: "akldb-prod-data-1", credentials: { accessKeyId: "a", secretAccessKey: "b" }, fetchImpl });
    expect(await dst.head("monthly/dump-2026-10.json.gz")).toBeNull();
    await dst.put("monthly/dump-2026-10.json.gz", enc("month"), "application/gzip");
    expect(calls.at(-1)).toBe("PUT akldb-prod-data-1.s3.us-east-2.amazonaws.com/dumps/monthly/dump-2026-10.json.gz");
  });

  it("[LDB-CV20] the standalone script needs a destination bucket, the R2 env file and AWS credentials; --dest-bucket serves staging and shadow too; nothing secret is printed and a dry run puts nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-r2env-"));
    try {
      const envFile = path.join(dir, "r2.env");
      fs.writeFileSync(envFile, "# read-only\nR2_KEY_ID=r2keyid-visible-nowhere\nR2_SECRET='r2secret-visible-nowhere'\nR2_ENDPOINT=https://58a5eb82948e2134d8b7b242e9567ac4.r2.cloudflarestorage.com\n");
      const out: string[] = [];
      const run = (argv: string[], env: Record<string, string>, fetchImpl?: any) => copyMain(argv, { env, out: (l: string) => out.push(l), fetchImpl });
      expect(await run([], {})).toBe(2);
      expect(await run(["--dest-bucket", "b", "--r2-env", path.join(dir, "nope.env")], {})).toBe(2);
      expect(await run(["--dest-bucket", "b", "--r2-env", envFile], {})).toBe(2);
      expect(out.join("\n")).toMatch(/--dest-bucket .* is required[\s\S]*cannot read .*nope\.env: not found[\s\S]*missing AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/);
      const seen: string[] = [];
      const fetchImpl = async (input: Request | string) => {
        const req = typeof input === "string" ? new Request(input) : input;
        seen.push(`${req.method} ${req.url}`);
        if (req.url.includes("r2.cloudflarestorage.com")) return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>latest.json</Key><Size>2</Size><ETag>&quot;${md5(enc("{}"))}&quot;</ETag></Contents></ListBucketResult>`);
        if (req.method === "HEAD") return new Response(null, { status: 404 });
        throw new Error("a dry run must not put anything");
      };
      out.length = 0;
      expect(await run(["--dest-bucket", "akldb-staging-data-335937358231", "--r2-env", envFile], { AWS_ACCESS_KEY_ID: "AKIAFAKE", AWS_SECRET_ACCESS_KEY: "awssecret-visible-nowhere" }, fetchImpl)).toBe(0);
      expect(out.join("\n")).toContain("1 objects: would copy 1, already there 0, 0 bytes (dry run: add --execute)");
      expect(seen[0]).toBe("GET https://58a5eb82948e2134d8b7b242e9567ac4.r2.cloudflarestorage.com/akl-db-dumps?list-type=2");
      expect(seen[1]).toBe("HEAD https://akldb-staging-data-335937358231.s3.us-east-2.amazonaws.com/dumps/latest.json");
      expect(seen.some((l) => l.startsWith("PUT"))).toBe(false);
      expect(JSON.stringify([out, seen])).not.toMatch(/visible-nowhere/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

describe("the dump copy in the cutover (CV20)", () => {
  it("[LDB-CV20] copy-dumps runs before the freeze (outside the write pause) and the stack then serves every dump route like the Worker, including the history the shadow 404ed", async () => {
    w = await makeWorld();
    const r = await w.cutover();
    expect(r.code, text(r)).toBe(0);
    const order = w.calls.filter((c) => c === "dumps.sync" || c === "d1.write" || c === "aws.operator.appendImage");
    expect(order[0]).toBe("dumps.sync");
    expect(order.indexOf("dumps.sync")).toBeLessThan(order.indexOf("d1.write"));
    expect(order.filter((c) => c === "dumps.sync")).toHaveLength(1);
    expect(w.state().steps["copy-dumps"].proof).toMatchObject({ objects: 6, copied: 6, skipped: 0 });
    expect([...w.s3.keys()].sort()).toEqual([...w.r2.keys()].sort());
    const checks = w.state().steps.serve.proof.dumps as { path: string; diffs: string[] }[];
    expect(checks.map((c) => c.path)).toEqual(["/v1/dump/latest.json", "/v1/dump", "/v1/dump/dump-2026-11-03.json.gz"]);
    expect(checks.every((c) => c.diffs.length === 0)).toBe(true);
    const old = await w.ports.stack.request("/v1/dump/dump-2026-11-02.json.gz", { method: "GET" });
    expect(old.status).toBe(200);
    expect(old.headers["content-type"]).toBe("application/gzip");
    expect(old.headers["cache-control"]).toBeUndefined();
    // running the step again (the re-sync) copies nothing new
    const again = await w.cutover(["--execute", "--only", "copy-dumps"]);
    expect(again.code, text(again)).toBe(0);
    expect(w.state().steps["copy-dumps"].proof).toMatchObject({ copied: 0, skipped: 6 });
  });

  it("[LDB-CV20] no R2 token stops the run before the freeze; a damaged object stops it before the freeze too; a dump that appears after the copy is caught by the parity check", async () => {
    w = await makeWorld({ faults: { noR2Token: true } });
    let r = await w.cutover();
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/needs R2_KEY_ID in .*, R2_SECRET in .*R2_ENDPOINT; bucket-scoped list and read on akl-db-dumps/);
    expect(w.calls).not.toContain("d1.write");
    cleanup(w);
    w = await makeWorld({ faults: { r2CorruptKey: "dump-2026-11-02.json.gz" } });
    r = await w.cutover();
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/dump copy found mismatches: dump-2026-11-02\.json\.gz: R2 bytes have md5/);
    expect(w.calls).not.toContain("d1.write");
    cleanup(w);
    w = await makeWorld();
    await w.cutoverUntil("image");
    w.r2.set("dump-2026-11-04.json.gz", { bytes: new TextEncoder().encode("night"), contentType: "application/gzip" });
    w.r2.set("latest.json", { bytes: new TextEncoder().encode('{"key":"dump-2026-11-04.json.gz"}'), contentType: "application/json" });
    // serve (before the re-sync) sees the Worker and the stack disagree about latest.json: CV20 catches it
    r = await w.cutover(["--execute", "--only", "serve"]);
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/dump routes differ between the Worker and the prod stack \(CV20\): \/v1\/dump\/latest\.json: etag/);
  });

  it("[LDB-CV20] a stack that loses content types or caches is caught by the parity check", async () => {
    w = await makeWorld({ faults: { s3LosesContentType: true } });
    const r = await w.cutover();
    expect(r.code).toBe(1);
    expect(text(r)).toMatch(/dump copy found mismatches: .*content type binary\/octet-stream/);
  });
});
