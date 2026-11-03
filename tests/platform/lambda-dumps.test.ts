// [LDB-CV20] /v1/dump* on the Lambda answers exactly as the Worker does over R2 (src/routes/dump.ts): the route picks the Content-Type by
// key (not from what S3 stored), the ETag is the object's own, there is no Cache-Control, no re-compression, the bytes are the stored bytes
// even when the client asks for gzip, the 302 of /v1/dump goes to the same-origin /v1/dump/<key>, and an unknown key is the same JSON 404.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createLambdaHandler } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { MemoryLog } from "../../src/replica/log-memory";
import { applyMigrations } from "../../src/replica/migrations";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica } from "../../src/replica/replica";
import { MemorySnapshotState } from "../../src/replica/snapshot";
import { FAST, MIGRATIONS_DIR } from "../replica/support";

const SECRET = "s3cret-origin-value-0123456789abcdef";
const md5 = (b: Uint8Array) => `"${createHash("md5").update(b).digest("hex")}"`;
type Result = { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean };
const ev = (path: string, headers: Record<string, string> = {}) => ({ version: "2.0", rawPath: path, rawQueryString: "", headers: { "x-akldb-origin": SECRET, ...headers }, requestContext: { http: { method: "GET", path } }, isBase64Encoded: false });

async function stack() {
  const dumps = memoryBlobs();
  const aws = {
    async invokeAsync() {},
    dumps,
    async getParameters(names: string[]) {
      return { values: Object.fromEntries(names.filter((n) => n === "origin-secret").map((n) => [n, SECRET])), missing: [] };
    },
    async invokeLive() {
      return { ok: true };
    },
  } as unknown as Aws;
  const log = new MemoryLog({}, new MemoryObjects());
  await applyMigrations(new Replica(log, FAST), MIGRATIONS_DIR, () => new Date("2026-11-04T00:00:00Z"));
  const h = createLambdaHandler({ env: { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/d", MODQUEUE_DISCORD_COMPONENTS: "false" }, aws, log, migrationsDir: MIGRATIONS_DIR, snapshots: { state: new MemorySnapshotState(), objects: new MemoryObjects() }, logError: () => {}, logLine: () => {}, now: () => 0, sleep: async () => {} });
  return { h, dumps };
}

describe("dump routes match the Worker's (CV20)", () => {
  it("[LDB-CV20] status, Content-Type by key, ETag, no Cache-Control, no re-compression, redirect and 404, with and without Accept-Encoding: gzip", async () => {
    const { h, dumps } = await stack();
    const big = gzipSync(Buffer.from("x".repeat(100_000))); // a .json.gz: gzip bytes, served as stored
    const latest = new TextEncoder().encode(JSON.stringify({ key: "dump-2026-11-03.json.gz", seq: 7, pad: "p".repeat(3000) }));
    // S3 stores everything as binary/octet-stream unless told: the route must not depend on it
    for (const [k, b] of [["latest.json", latest], ["dump-2026-11-03.json.gz", big], ["dump-2026-11-02.json.gz", big], ["monthly/dump-2026-10.json.gz", big], ["latest.spark-1.json", latest], ["latest.spark-1.json.sha256", new TextEncoder().encode("abc  f\n")]] as [string, Uint8Array][]) await dumps.put(k, b, "binary/octet-stream");
    const expected: [string, string, Uint8Array][] = [
      ["/v1/dump/latest.json", "application/json", latest],
      ["/v1/dump/dump-2026-11-03.json.gz", "application/gzip", big],
      ["/v1/dump/dump-2026-11-02.json.gz", "application/gzip", big],
      ["/v1/dump/monthly/dump-2026-10.json.gz", "application/gzip", big],
      ["/v1/dump/latest.spark-1.json", "application/json", latest],
      ["/v1/dump/latest.spark-1.json.sha256", "text/plain", new TextEncoder().encode("abc  f\n")],
    ];
    for (const accept of [undefined, "gzip, deflate, br"]) {
      for (const [path, type, bytes] of expected) {
        const r = (await h(ev(path, accept ? { "accept-encoding": accept } : {}))) as Result;
        const label = `${path} accept=${accept ?? "-"}`;
        expect(r.statusCode, label).toBe(200);
        expect(r.headers["content-type"], label).toBe(type);
        expect(r.headers.etag, label).toBe(md5(bytes));
        expect(r.headers["cache-control"], label).toBeUndefined();
        expect(r.headers["content-encoding"], label).toBeUndefined();
        expect(r.headers.vary, label).toBeUndefined();
        expect(r.headers["x-akldb-backend"], label).toBe("aws");
        const got = r.isBase64Encoded ? Buffer.from(r.body, "base64") : Buffer.from(r.body, "utf8");
        expect(Buffer.compare(got, Buffer.from(bytes)), `${label}: the bytes are the stored bytes`).toBe(0);
      }
    }
    // /v1/dump: 302 to the same-origin key, no body, no caching header
    const redirect = (await h(ev("/v1/dump", { "accept-encoding": "gzip" }))) as Result;
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe("/v1/dump/dump-2026-11-03.json.gz");
    expect(redirect.headers["cache-control"]).toBeUndefined();
    // absent and malformed keys: the Worker's JSON 404
    for (const path of ["/v1/dump/dump-2026-11-01.json.gz", "/v1/dump/monthly/dump-2025-01.json.gz", "/v1/dump/nope.txt", "/v1/dump/dump-2026-11-3.json.gz"]) {
      const r = (await h(ev(path))) as Result;
      expect(r.statusCode, path).toBe(404);
      expect(r.headers["content-type"], path).toContain("application/json");
      expect(r.headers["cache-control"] ?? "", path).not.toContain("max-age=14400");
    }
  });
});
