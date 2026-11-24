// [LDB-MD29] The `akldb-req` line (src/platform/request-line.ts) and its emission, one per HTTP invocation, by the Lambda front.
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createLambdaHandler, ORIGIN_HEADER, type LambdaOptions } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { countryToken, errorCodeOf, ipKey, pathHash, rayToken, requestLine, uaToken } from "../../src/platform/request-line";
import { bootReplica } from "../../src/replica/boot";
import { MemoryLog } from "../../src/replica/log-memory";
import { applyMigrations } from "../../src/replica/migrations";
import { Replica } from "../../src/replica/replica";

const MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "migrations");
const SECRET = "s3cret-origin-value-0123456789abcdef";
const FAST = { sleep: async () => {}, backoffMs: 0 };

describe("requestLine", () => {
  it("[LDB-MD29] golden: fixed key order, one token per field", () => {
    expect(
      requestLine({ rid: "rid-0001-abcd", gw: "Zk3x9Q=", ray: "8a1b2c3d4e5f6a7b-IAD", m: "GET", r: "/v1/layouts/:id", ph: pathHash("/v1/layouts/x"), st: 404, ms: 12.4, cold: true, boot: 850.2, edge: "cf", gate: "ok", ua: "akl-spark/1.2", cli: "01M238JDXXXXXXXXXXXXXXXXXX", cc: "US", ipk: "0123abcd", b: 87, err: "not_found", hold: false }),
    ).toBe(`akldb-req v=1 rid=rid-0001-abcd gw=Zk3x9Q= ray=8a1b2c3d4e5f6a7b-IAD m=GET r=/v1/layouts/:id ph=${pathHash("/v1/layouts/x")} st=404 ms=12 cold=1 boot=850 edge=cf gate=ok ua=akl-spark/1.2 cli=01M238JDXXXXXXXXXXXXXXXXXX cc=US ipk=0123abcd b=87 err=not_found hold=0`);
  });

  it("[LDB-MD29] absent values are `-`, a catch-all route is `-`, and no value can hold a space, a `?` or a quote", () => {
    const line = requestLine({ rid: "a b?c\"d\n", m: "GET", r: "/*", ph: "00000000", ms: 1, cold: false, edge: "direct", gate: "missing", b: 0, hold: true });
    expect(line).toBe("akldb-req v=1 rid=a_b_c_d_ gw=- ray=- m=GET r=- ph=00000000 st=- ms=1 cold=0 boot=- edge=direct gate=missing ua=- cli=- cc=- ipk=- b=0 err=- hold=1");
    expect(line.split(" ")).toHaveLength(21);
    expect(line).not.toMatch(/[?"\n]/);
  });

  it("[LDB-MD29] header reducers: UA product token, Mozilla is `browser`, country, ray", () => {
    expect(uaToken("akl-spark/1.2 (node)")).toBe("akl-spark/1.2");
    expect(uaToken("Mozilla/5.0 (Macintosh)")).toBe("browser");
    expect(uaToken("curl/8.4.0")).toBe("curl/8.4.0");
    expect(uaToken(undefined)).toBeUndefined();
    expect(uaToken("x".repeat(80))).toBe("x".repeat(40));
    expect(countryToken("US")).toBe("US");
    expect(countryToken("usa")).toBeUndefined();
    expect(rayToken("8a1b-IAD")).toBe("8a1b-IAD");
    expect(rayToken("bad ray")).toBeUndefined();
  });

  it("[LDB-MD29] ipk is stable within a UTC day, differs across days and across addresses, and never shows the address", () => {
    const a = ipKey(SECRET, "2026-11-24", "203.0.113.9");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(ipKey(SECRET, "2026-11-24", "203.0.113.9")).toBe(a);
    expect(ipKey(SECRET, "2026-11-25", "203.0.113.9")).not.toBe(a);
    expect(ipKey(SECRET, "2026-11-24", "203.0.113.10")).not.toBe(a);
    expect(ipKey("other-secret", "2026-11-24", "203.0.113.9")).not.toBe(a);
  });

  it("[LDB-MD29] the error code is read only from a small, non-base64 JSON body", () => {
    expect(errorCodeOf('{"error":"rate_limited","message":"x"}', false)).toBe("rate_limited");
    expect(errorCodeOf('{"error":"x"}', true)).toBeUndefined();
    expect(errorCodeOf("forbidden", false)).toBeUndefined();
    expect(errorCodeOf(`{"error":"x","pad":"${"y".repeat(3000)}"}`, false)).toBeUndefined();
    expect(errorCodeOf("{not json", false)).toBeUndefined();
  });
});

let seeded: MemoryLog;
beforeAll(async () => {
  seeded = new MemoryLog();
  const seed = new Replica(seeded, FAST);
  await applyMigrations(seed, MIGRATIONS);
  seed.close();
}, 60_000);

function fakeAws(): Aws {
  type Names = string[];
  const blobs = memoryBlobs();
  const values: Record<string, string> = { "origin-secret": SECRET };
  return {
    dumps: blobs,
    async getParameters(names: Names) {
      return { values: Object.fromEntries(names.filter((n: string) => n in values).map((n: string) => [n, values[n]!])), missing: names.filter((n: string) => !(n in values)) };
    },
    async invokeAsync() {},
    async invokeLive() {
      return { ok: true };
    },
  } as unknown as Aws;
}

function stack(extra: Partial<LambdaOptions> = {}) {
  const lines: string[] = [];
  const handler = createLambdaHandler({
    env: { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", AWS_LAMBDA_FUNCTION_VERSION: "7" },
    aws: fakeAws(),
    log: seeded,
    migrationsDir: MIGRATIONS,
    boot: (l) => bootReplica(l, FAST),
    logError: () => {},
    logLine: (m) => lines.push(m),
    ...extra,
  });
  return { handler, lines, req: () => lines.filter((l) => l.startsWith("akldb-req ")) };
}

function event(rawPath: string, headers: Record<string, string> = {}, method = "GET", query = "") {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: query,
    headers: { host: "staging-api.akldb.org", ...headers },
    requestContext: { accountId: "335937358231", apiId: "abc", domainName: "staging-api.akldb.org", domainPrefix: "staging-api", http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "203.0.113.9", userAgent: "vitest" }, requestId: "gw-req-1=", routeKey: "$default", stage: "$default", time: "x", timeEpoch: 0 },
    isBase64Encoded: false,
  };
}

const fieldsOf = (line: string): Record<string, string> => Object.fromEntries(line.split(" ").slice(1).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));

describe("one akldb-req line per HTTP invocation", () => {
  it("[LDB-MD29] a 200 through the app: route pattern, ids, timing, edge and ipk, with no raw IP, query or path", async () => {
    const { handler, req } = stack();
    await handler.ready();
    const res = (await handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET, "x-request-id": "line-rid_0001", "cf-ray": "8a1b2c3d4e5f6a7b-IAD", "cf-ipcountry": "DE", "cf-connecting-ip": "198.51.100.77", "user-agent": "Mozilla/5.0 (X11)", authorization: "Bearer topsecrettoken" }, "GET", "q=secretquery"))) as { statusCode: number };
    expect(res.statusCode).toBe(200);
    const lines = req();
    expect(lines).toHaveLength(1);
    const f = fieldsOf(lines[0]!);
    expect(f).toMatchObject({ v: "1", rid: "line-rid_0001", gw: "gw-req-1=", ray: "8a1b2c3d4e5f6a7b-IAD", m: "GET", r: "/v1/meta", ph: pathHash("/v1/meta"), st: "200", edge: "cf", gate: "ok", ua: "browser", cli: "-", cc: "DE", err: "-", hold: "0" });
    expect(f.ipk).toBe(ipKey(SECRET, new Date().toISOString().slice(0, 10), "198.51.100.77"));
    expect(Number(f.b)).toBeGreaterThan(10);
    const line = lines[0]!;
    expect(line).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(line).not.toContain("?");
    expect(line).not.toContain("secretquery");
    expect(line).not.toContain("topsecrettoken");
    expect(line).not.toMatch(/\d{17,20}/);
  });

  it("[LDB-MD29] a 404 from the app names its error code and the response's own request id", async () => {
    const { handler, req } = stack();
    await handler.ready();
    await handler(event("/v1/layouts/NOPE00000000000000000000", { [ORIGIN_HEADER]: SECRET }));
    const f = fieldsOf(req()[0]!);
    expect(f.st).toBe("404");
    expect(f.err).not.toBe("-");
    expect(f.rid).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(req()[0]).not.toContain("NOPE");
  });

  it("[LDB-MD29] the front's 403: one line, gate=missing with no ipk (no SSM read), gate=bad with an ipk from the sourceIp", async () => {
    const { handler, req } = stack();
    await handler.ready();
    await handler(event("/v1/meta", { "x-request-id": "front-403_0001", "cf-connecting-ip": "198.51.100.77" }));
    await handler(event("/v1/meta", { [ORIGIN_HEADER]: "wrong", "cf-connecting-ip": "198.51.100.77" }));
    const [missing, bad] = req().map(fieldsOf);
    expect(missing).toMatchObject({ rid: "front-403_0001", st: "403", gate: "missing", ipk: "-", r: "-" });
    expect(bad).toMatchObject({ st: "403", gate: "bad" });
    // a request that failed the gate does not get to name its own address: the peer is used, not cf-connecting-ip
    expect(bad!.ipk).toBe(ipKey(SECRET, new Date().toISOString().slice(0, 10), "203.0.113.9"));
  });

  it("[LDB-MD29] ipk differs across UTC days", async () => {
    let t = Date.parse("2026-11-24T12:00:00Z");
    const { handler, req } = stack({ now: () => t });
    await handler.ready();
    const h = { [ORIGIN_HEADER]: SECRET, "cf-connecting-ip": "198.51.100.77" };
    await handler(event("/v1/meta", h));
    await handler(event("/v1/meta", h));
    t = Date.parse("2026-11-25T12:00:00Z");
    await handler(event("/v1/meta", h));
    const ipks = req().map((l) => fieldsOf(l).ipk);
    expect(ipks[0]).toBe(ipks[1]);
    expect(ipks[2]).not.toBe(ipks[0]);
  });

  it("[LDB-MD29] cold is set on the container's first HTTP invocation only; boot is reported once", async () => {
    const { handler, req } = stack();
    await handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }));
    await handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }));
    const [first, second] = req().map(fieldsOf);
    expect(first!.cold).toBe("1");
    expect(first!.boot).toMatch(/^\d+$/);
    expect(second!.cold).toBe("0");
    expect(second!.boot).toBe("-");
  });

  it("[LDB-MD29] a throw logs st=- err=throw and still rethrows", async () => {
    const dead = new Error("halted for the test");
    const { handler, req } = stack({
      boot: async (l) => {
        const r = await bootReplica(l, FAST);
        Object.defineProperty(r, "dead", { value: dead, configurable: true });
        return r;
      },
    });
    await expect(handler(event("/v1/meta", { [ORIGIN_HEADER]: SECRET }))).rejects.toThrow();
    const lines = req();
    expect(lines).toHaveLength(1);
    expect(fieldsOf(lines[0]!)).toMatchObject({ st: "-", err: "throw" });
  });
});
