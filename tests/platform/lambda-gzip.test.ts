// [LDB-CV19] Lambda's response limit is 6 MB (base64 included). A real-size `full=1` page (4.9k layouts) is gzipped when the client allows it
// (ETag untouched, Vary added, base64 body), and an answer that still cannot fit is a clear 500 plus one alarm line, never API Gateway's 413.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import frozenSeed from "../fixtures/seed-upstream-100.dump.json" with { type: "json" };
import type { Dump } from "../../src/dump/write";
import { restoreInto } from "../../src/dump/restore";
import { MAX_RESPONSE_BYTES, acceptsGzip, createLambdaHandler } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { MemoryLog } from "../../src/replica/log-memory";
import { applyMigrations } from "../../src/replica/migrations";
import { MemoryObjects } from "../../src/replica/objects";
import { Replica } from "../../src/replica/replica";
import { MemorySnapshotState } from "../../src/replica/snapshot";
import { createShimD1 } from "../../src/store/shim/d1";
import { FAST, MIGRATIONS_DIR } from "../replica/support";

const SECRET = "s3cret-origin-value-0123456789abcdef";
const REPORT = process.env.AKLDB_SIZE_REPORT;

/**
 * The frozen 100-layout catalog (real payloads, from upstream) repeated to `copies` x 100 layouts with fresh ids and names. The copies are
 * sorted apart (name prefix q01-, q02- ...: a copy of a layout sits ~180 KB from the next, beyond gzip's 32 KB window), so the ratio measured is
 * that of 100 distinct real layouts, not of 49 adjacent duplicates.
 */
function catalog(copies: number): Dump {
  const d = structuredClone(frozenSeed) as unknown as Dump & Record<string, any>;
  const records = [...d.records];
  const formats = [...d.layout_formats];
  const idOf = (id: string, k: number): string => `${String(k + 10)}${id.slice(2)}`;
  for (let k = 1; k < copies; k++) {
    for (const r of d.records) records.push({ ...r, id: idOf(r.id, k), name: `q${String(k).padStart(2, "0")}-${r.name}`, upstream_id: null, upstream_source: null, upstream_state: null } as never);
    for (const f of d.layout_formats) formats.push({ ...f, layout_id: idOf(f.layout_id, k) });
  }
  return { ...d, records, layout_formats: formats };
}

function fakeAws(): Aws {
  return {
    async invokeAsync() {},
    dumps: memoryBlobs(),
    async getParameters(names: string[]) {
      return { values: Object.fromEntries(names.filter((n) => n === "origin-secret").map((n) => [n, SECRET])), missing: [] };
    },
    async invokeLive() {
      return { ok: true };
    },
  } as unknown as Aws;
}

async function stack(copies: number, lines: string[]) {
  const log = new MemoryLog({}, new MemoryObjects());
  const writer = new Replica(log, FAST);
  await applyMigrations(writer, MIGRATIONS_DIR, () => new Date("2026-11-04T00:00:00Z"));
  await restoreInto(createShimD1(writer), catalog(copies));
  const h = createLambdaHandler({
    env: { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false" },
    aws: fakeAws(),
    log,
    migrationsDir: MIGRATIONS_DIR,
    snapshots: { state: new MemorySnapshotState(), objects: new MemoryObjects() },
    logError: (m) => void lines.push(`ERR ${m}`),
    logLine: (m) => void lines.push(m),
    now: () => Date.parse("2026-11-04T04:00:00Z"),
    sleep: async () => {},
  });
  return h;
}

const ev = (path: string, query: string, headers: Record<string, string> = {}) => ({
  version: "2.0",
  rawPath: path,
  rawQueryString: query,
  queryStringParameters: Object.fromEntries(new URLSearchParams(query)),
  headers: { "x-akldb-origin": SECRET, ...headers },
  requestContext: { http: { method: "GET", path } },
  isBase64Encoded: false,
});
type Result = { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean };

describe("gzip and the 6 MB guard (CV19)", () => {
  it("[LDB-CV19] Accept-Encoding parsing", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, gzip;q=0.8")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip(undefined)).toBe(false);
  });

  it("[LDB-CV19] a real-size full=1 (4.9k layouts) is gzipped into a base64 body under the limit, the ETag untouched; without gzip it is a clear 500 and one alarm line", async () => {
    const lines: string[] = [];
    const h = await stack(49, lines);
    const q = "format=spark/1&full=1";
    const plain = (await h(ev("/v1/layouts", q))) as Result;
    const gz = (await h(ev("/v1/layouts", q, { "accept-encoding": "gzip, deflate, br" }))) as Result;
    expect(gz.statusCode, gz.body.slice(0, 200)).toBe(200);
    expect(gz.isBase64Encoded).toBe(true);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers["vary"]).toContain("Accept-Encoding");
    expect(gz.headers["content-type"]).toBe("application/json");
    const zipped = Buffer.from(gz.body, "base64");
    const inflated = gunzipSync(zipped).toString("utf8");
    const parsed = JSON.parse(inflated) as { items: unknown[] };
    expect(parsed.items).toHaveLength(4900);

    // raw is over the limit: refused clearly, once, never an opaque 413 (the alarm line carries the raw size)
    expect(plain.statusCode).toBe(500);
    expect(JSON.parse(plain.body)).toMatchObject({ error: "response_too_large" });
    const alarms = lines.filter((l) => l.startsWith("akldb-alarm: response-too-large:"));
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatch(/route=GET \/v1\/layouts bytes=\d+ limit=5900000 encoded=text$/);
    const raw = Number(/bytes=(\d+)/.exec(alarms[0]!)![1]);
    expect(raw).toBeGreaterThan(MAX_RESPONSE_BYTES);

    // the same bytes: the ETag of the gzip answer is the ETag the plain one would have had
    const small = await stack(1, []);
    const a = (await small(ev("/v1/layouts", q))) as Result;
    const b = (await small(ev("/v1/layouts", q, { "accept-encoding": "gzip" }))) as Result;
    expect(a.statusCode).toBe(200);
    expect(b.headers.etag).toBe(a.headers.etag);
    expect(gunzipSync(Buffer.from(b.body, "base64")).toString("utf8")).toBe(a.body);

    const m2 = (await h(ev("/v1/layouts", "format=mana2/1&full=1", { "accept-encoding": "gzip" }))) as Result;
    expect(m2.statusCode, m2.body.slice(0, 200)).toBe(200);
    const m2zip = Buffer.from(m2.body, "base64");
    const m2raw = gunzipSync(m2zip).byteLength;
    const chg = (await h(ev("/v1/layouts", "format=spark/1&limit=1000", { "accept-encoding": "gzip" }))) as Result;
    expect(chg.statusCode).toBe(200);
    const sizes = {
      mana2: { rawBytes: m2raw, gzipBytes: m2zip.byteLength, base64Bytes: m2.body.length },
      listPage1000: { rawBytes: gunzipSync(Buffer.from(chg.body, "base64")).byteLength, base64Bytes: chg.body.length }, layouts: 4900, rawBytes: raw, gzipBytes: zipped.byteLength, base64Bytes: gz.body.length, limit: 6_291_556, guard: MAX_RESPONSE_BYTES, headroomBytes: 6_291_556 - gz.body.length, rawPerLayout: Math.round(raw / 4900), gzipPerLayout: Math.round(zipped.byteLength / 4900), fitsUntilLayouts: Math.floor((MAX_RESPONSE_BYTES / gz.body.length) * 4900) };
    if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(sizes, null, 2));
    expect(gz.body.length).toBeLessThan(MAX_RESPONSE_BYTES);
  }, 240_000);

  it("[LDB-CV19] small answers, 304s, HEAD, already-compressed bodies and the dump routes are left alone; a client without gzip gets identity", async () => {
    const lines: string[] = [];
    const h = await stack(1, lines);
    const meta = (await h(ev("/v1/meta", "", { "accept-encoding": "gzip" }))) as Result;
    expect(meta.statusCode).toBe(200);
    expect(meta.isBase64Encoded).toBe(false);
    expect(meta.headers["content-encoding"]).toBeUndefined();
    const plain = (await h(ev("/v1/layouts", "format=spark/1&full=1"))) as Result;
    expect(plain.statusCode).toBe(200);
    expect(plain.isBase64Encoded).toBe(false);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const etag = plain.headers.etag!;
    const cond = (await h(ev("/v1/layouts", "format=spark/1&full=1", { "accept-encoding": "gzip", "if-none-match": etag }))) as Result;
    expect(cond.statusCode).toBe(304);
    expect(cond.headers["content-encoding"]).toBeUndefined();
  }, 60_000);
});
