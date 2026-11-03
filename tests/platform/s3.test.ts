// The lean signer (RP6): the replica layer sends exactly five kinds of AWS call (DynamoDB GetItem, Query, TransactWriteItems;
// S3 GetObject, PutObject), signed by aws4fetch with no AWS SDK, with bounded retries and a small error mapping.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryObjects } from "../../src/replica/objects";
import { createS3Objects, S3AccessError, S3Error, S3UnavailableError } from "../../src/replica/s3";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const creds = () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" });

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []));
}

function client(responses: (Response | Error)[], extra: Partial<Parameters<typeof createS3Objects>[0]> = {}) {
  const seen: Request[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const store = createS3Objects({
    bucket: "akldb-test-data",
    region: "us-east-2",
    credentials: creds,
    fetch: async (req) => {
      seen.push(req.clone());
      const r = responses[Math.min(i++, responses.length - 1)]!;
      if (r instanceof Error) throw r;
      // a fresh Response each time (a cloned body is tee'd, and cancelling one branch of a tee waits for the other)
      return new Response([204, 304].includes(r.status) ? null : await r.clone().arrayBuffer(), { status: r.status, headers: r.headers });
    },
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...extra,
  });
  return { store, seen, sleeps };
}

const xml = (status: number, code: string) => new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`, { status });

describe("the lean signer (RP6)", () => {
  it("[LDB-RP6] the replica layer's AWS surface is exactly GetItem, Query, TransactWriteItems, GetObject, PutObject, plus ListObjectsV2 and DeleteObject for log/* only, and no AWS SDK is imported anywhere", () => {
    const dynamo = new Set<string>();
    const s3 = new Set<string>();
    for (const f of walk(path.join(ROOT, "src", "replica"))) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/callRetrying\(\s*"(\w+)"/g)) dynamo.add(m[1]!);
      for (const m of src.matchAll(/\bcall\(\s*"(\w+Object|ListObjectsV2)"/g)) s3.add(m[1]!);
      expect(src, f).not.toMatch(/@aws-sdk|aws-sdk\//);
    }
    expect([...dynamo].sort()).toEqual(["GetItem", "Query", "TransactWriteItems"]);
    expect([...s3].sort()).toEqual(["DeleteObject", "GetObject", "ListObjectsV2", "PutObject"]);
    for (const f of walk(path.join(ROOT, "src"))) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/from\s+["']@aws-sdk/);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).filter((d) => d.startsWith("@aws-sdk"))).toEqual([]);
    expect(Object.keys(createS3Objects({ bucket: "b", credentials: creds })).sort()).toEqual(["delete", "get", "list", "put"]);
  });

  it("[LDB-RP6] a PUT is a signed virtual-hosted request: SigV4, UNSIGNED-PAYLOAD, the key percent-encoded per segment, lower-cased metadata and a sha256 checksum of the bytes", async () => {
    const { store, seen } = client([new Response(null, { status: 200 })]);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await store.put("snap/daily/05 x.sqlite.zst", bytes, { SHA256: "abc", seq: "7" });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("https://akldb-test-data.s3.us-east-2.amazonaws.com/snap/daily/05%20x.sqlite.zst");
    expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/s3\/aws4_request, SignedHeaders=[^,]*x-amz-content-sha256[^,]*, Signature=[0-9a-f]{64}$/);
    expect(req.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(req.headers.get("x-amz-security-token")).toBe("tok");
    expect(req.headers.get("x-amz-meta-sha256")).toBe("abc");
    expect(req.headers.get("x-amz-meta-seq")).toBe("7");
    expect(req.headers.get("x-amz-checksum-sha256")).toBe(createHash("sha256").update(bytes).digest("base64"));
    expect(new Uint8Array(await req.arrayBuffer())).toEqual(bytes);
  });

  it("[LDB-RP6] a GET returns the bytes and the object's metadata; a missing key is null", async () => {
    const ok = client([new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "x-amz-meta-sha256": "ff", "x-amz-meta-seq": "3", "content-length": "3" } })]);
    expect(await ok.store.get("snap/slot-0.sqlite.zst")).toEqual({ bytes: new Uint8Array([9, 8, 7]), meta: { sha256: "ff", seq: "3" } });
    expect(ok.seen[0]!.method).toBe("GET");
    const gone = client([xml(404, "NoSuchKey")]);
    expect(await gone.store.get("nope")).toBeNull();
    expect(gone.seen).toHaveLength(1); // a 404 is an answer, not a failure to retry
  });

  it("[LDB-RP6] retries are bounded: 503/SlowDown/timeouts retry with backoff and then surface as S3UnavailableError after retries+1 tries", async () => {
    const always = client([xml(503, "SlowDown")]);
    await expect(always.store.get("k")).rejects.toBeInstanceOf(S3UnavailableError);
    expect(always.seen).toHaveLength(4); // 1 + 3 retries
    expect(always.sleeps).toHaveLength(3);
    expect(always.sleeps.every((ms, i) => ms === Math.floor(20 * 2 ** i)) ).toBe(true);

    const fewer = client([xml(500, "InternalError")], { retries: 1 });
    await expect(fewer.store.put("k", new Uint8Array([1]))).rejects.toThrow(/S3 PutObject k: 500 InternalError/);
    expect(fewer.seen).toHaveLength(2);

    const recovers = client([xml(503, "SlowDown"), xml(400, "RequestTimeout"), new Response(null, { status: 200 })]);
    await recovers.store.put("k", new Uint8Array([1, 2]));
    expect(recovers.seen).toHaveLength(3);
    // each retry re-sends the same bytes
    expect(await Promise.all(recovers.seen.map(async (r) => new Uint8Array(await r.arrayBuffer())))).toEqual([new Uint8Array([1, 2]), new Uint8Array([1, 2]), new Uint8Array([1, 2])]);
  });

  it("[LDB-RP6] transport failures retry (the PUT is idempotent) and then map to S3UnavailableError with the cause", async () => {
    const boom = new TypeError("fetch failed");
    const flaky = client([boom, new Response(new Uint8Array([1]), { status: 200, headers: { "content-length": "1" } })]);
    expect((await flaky.store.get("k"))!.bytes).toEqual(new Uint8Array([1]));
    expect(flaky.seen).toHaveLength(2);
    const dead = client([boom]);
    const err = await dead.store.put("k", new Uint8Array([1])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3UnavailableError);
    expect((err as S3UnavailableError).cause).toBe(boom);
    expect(dead.seen).toHaveLength(4);
  });

  it("[LDB-RP6] errors map by kind: access errors and other 4xx are not retried; a short body is an S3UnavailableError", async () => {
    const denied = client([xml(403, "AccessDenied")]);
    await expect(denied.store.get("k")).rejects.toBeInstanceOf(S3AccessError);
    expect(denied.seen).toHaveLength(1);
    const expired = client([xml(400, "ExpiredToken")]);
    await expect(expired.store.get("k")).rejects.toBeInstanceOf(S3AccessError);
    const bad = client([xml(400, "InvalidRequest")]);
    const e = await bad.store.put("k", new Uint8Array([1])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(S3Error);
    expect(e).not.toBeInstanceOf(S3UnavailableError);
    expect(bad.seen).toHaveLength(1);
    const short = client([new Response(new Uint8Array([1, 2]), { status: 200, headers: { "content-length": "9" } })], { retries: 0 });
    await expect(short.store.get("k")).rejects.toThrow(/got 2 of 9 bytes/);
  });

  it("[LDB-RP6] list and delete work on log/* only: any other prefix throws before a request is made, in the S3 client and in the memory store alike", async () => {
    const { store, seen } = client([new Response(null, { status: 204 })]);
    for (const bad of ["snap/slot-0.sqlite.zst", "dumps/x", "logs/x", "log", "", "../log/x"]) {
      await expect(store.delete(bad), bad).rejects.toThrow(/restricted to log\/\*/);
      await expect(store.list(bad), bad).rejects.toThrow(/restricted to log\/\*/);
    }
    expect(seen).toHaveLength(0);
    const mem = new MemoryObjects();
    await mem.put("snap/slot-0.sqlite.zst", new Uint8Array([1]));
    await expect(mem.delete("snap/slot-0.sqlite.zst")).rejects.toThrow(/restricted to log\/\*/);
    await expect(mem.list("snap/")).rejects.toThrow(/restricted to log\/\*/);
    expect(mem.keys()).toEqual(["snap/slot-0.sqlite.zst"]);
    await store.delete("log/01ABC.json.zst");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("DELETE");
    expect(seen[0]!.url).toBe("https://akldb-test-data.s3.us-east-2.amazonaws.com/log/01ABC.json.zst");
    expect(seen[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("[LDB-RP6] a listing is a signed bucket-level GET with the prefix, follows the continuation token, and unescapes the keys", async () => {
    const page = (keys: string[], next?: string) => new Response(`<?xml version="1.0"?><ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`, { status: 200 });
    const { store, seen } = client([page(["log/a.json.zst", "log/b&amp;c.json.zst"], "tok/1+="), page(["log/d.json.zst"])]);
    expect(await store.list("log/")).toEqual(["log/a.json.zst", "log/b&c.json.zst", "log/d.json.zst"]);
    expect(seen).toHaveLength(2);
    const u1 = new URL(seen[0]!.url);
    expect(u1.origin + u1.pathname).toBe("https://akldb-test-data.s3.us-east-2.amazonaws.com/");
    expect(u1.searchParams.get("list-type")).toBe("2");
    expect(u1.searchParams.get("prefix")).toBe("log/");
    expect(new URL(seen[1]!.url).searchParams.get("continuation-token")).toBe("tok/1+=");
    expect(seen[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    const capped = client([page(["log/1", "log/2", "log/3"], "more")]);
    expect(await capped.store.list("log/", 2)).toEqual(["log/1", "log/2"]);
  });

  it("[LDB-RP6] credentials are read per call, so a rotated key signs the next request", async () => {
    let n = 0;
    const seen: string[] = [];
    const store = createS3Objects({ bucket: "b", credentials: () => ({ accessKeyId: `AKID${++n}`, secretAccessKey: "s" }), fetch: async (r) => (seen.push(r.headers.get("authorization")!), new Response(null, { status: 200 })) });
    await store.put("a", new Uint8Array([1]));
    await store.put("b", new Uint8Array([1]));
    expect(seen[0]).toContain("Credential=AKID1/");
    expect(seen[1]).toContain("Credential=AKID2/");
  });
});
