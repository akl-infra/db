// The lean S3 client (RP6): GetObject and PutObject over `fetch`, SigV4 by aws4fetch, no AWS SDK, plus ListObjectsV2 and
// DeleteObject for ONE job: removing spilled log bodies (`log/*`) that retention has outlived. Those two refuse any other
// prefix before sending anything. With DynamoDB's GetItem, Query and TransactWriteItems (log-ddb.ts) that is the whole of
// what the replica layer sends to AWS: the plan's five calls and the two the orphan cleanup needs. Bounded retries (5xx, SlowDown, RequestTimeout, transport errors; PUT of the
// same key and bytes is idempotent), and a small error mapping so callers branch on a class, not on XML text.
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { sleep as realSleep } from "./timers";
import { assertSpillKey, type ObjectStore, type StoredObject } from "./objects";

export interface S3Options {
  bucket: string;
  region?: string;
  /** Path-style endpoint for a local S3 (e.g. http://127.0.0.1:9000). Default: the regional virtual-hosted endpoint. */
  endpoint?: string;
  /** Called per request, so a rotated key is picked up. */
  credentials: () => { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Per-request timeout. Default 15000 ms (a 10 MB snapshot GET). */
  timeoutMs?: number;
  /** Retries after the first try. Default 3. */
  retries?: number;
  /** Test hooks. */
  fetch?: (request: Request) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** S3 refused with a status the caller should not retry. */
export class S3Error extends Error {
  constructor(readonly op: string, readonly key: string, readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "S3Error";
  }
}

/** 401/403 or an expired/invalid credential: retrying cannot help; the role or the bucket policy is wrong. */
export class S3AccessError extends S3Error {
  constructor(op: string, key: string, status: number, code: string, message: string) {
    super(op, key, status, code, message);
    this.name = "S3AccessError";
  }
}

/** Retries ran out on 5xx / throttling / timeouts / transport errors. The operation may or may not have taken effect (a PUT is idempotent, so a caller may simply try again later). */
export class S3UnavailableError extends S3Error {
  constructor(op: string, key: string, status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(op, key, status, code, message);
    this.name = "S3Unavailable";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

const RETRYABLE_CODES = new Set(["SlowDown", "RequestTimeout", "InternalError", "ServiceUnavailable", "RequestTimeTooSkewed"]);
const ACCESS_CODES = new Set(["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken", "AllAccessDisabled"]);
const META_PREFIX = "x-amz-meta-";

/** Percent-encode an object key per path segment (slashes stay). */
export const encodeKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

function xmlCode(text: string): string {
  return /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "";
}

export function createS3Objects(o: S3Options): ObjectStore {
  const region = o.region ?? "us-east-2";
  const timeoutMs = o.timeoutMs ?? 15_000;
  const retries = o.retries ?? 3;
  const send = o.fetch ?? ((r: Request) => fetch(r));
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  const url = (key: string): string => (o.endpoint === undefined ? `https://${o.bucket}.s3.${region}.amazonaws.com/${encodeKey(key)}` : `${o.endpoint.replace(/\/$/, "")}/${o.bucket}/${encodeKey(key)}`);

  const bucketUrl = (): string => (o.endpoint === undefined ? `https://${o.bucket}.s3.${region}.amazonaws.com/` : `${o.endpoint.replace(/\/$/, "")}/${o.bucket}/`);

  async function attempt(op: string, key: string, init: RequestInit, bucketLevel: boolean): Promise<Response> {
    const client = new AwsClient({ ...o.credentials(), service: "s3", region });
    const target = bucketLevel ? `${bucketUrl()}${key}` : url(key); // bucket-level calls pass "?query" as `key`
    return send(await client.sign(target, { ...init, signal: AbortSignal.timeout(timeoutMs) }));
  }

  /** One call with bounded retries. Resolves a response whose status is 2xx or 404; throws the mapped error otherwise. */
  async function call(op: string, key: string, init: RequestInit, bucketLevel = false): Promise<Response> {
    let last: S3UnavailableError | undefined;
    for (let i = 0; i <= retries; i++) {
      let res: Response;
      try {
        res = await attempt(op, key, init, bucketLevel);
      } catch (e) {
        last = new S3UnavailableError(op, key, 0, "Transport", `S3 ${op} ${key}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
        if (i < retries) await sleep(Math.floor(20 * 2 ** i * (0.5 + random())));
        continue;
      }
      if (res.ok || res.status === 404) return res;
      const text = await res.text();
      const code = xmlCode(text);
      const message = `S3 ${op} ${key}: ${res.status} ${code}${text === "" ? "" : ` ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`}`;
      if (res.status === 401 || res.status === 403 || ACCESS_CODES.has(code)) throw new S3AccessError(op, key, res.status, code, message);
      if (res.status >= 500 || res.status === 429 || RETRYABLE_CODES.has(code)) {
        last = new S3UnavailableError(op, key, res.status, code, message);
        if (i < retries) await sleep(Math.floor(20 * 2 ** i * (0.5 + random())));
        continue;
      }
      throw new S3Error(op, key, res.status, code, message);
    }
    throw last!;
  }

  return {
    async get(key): Promise<StoredObject | null> {
      const res = await call("GetObject", key, { method: "GET" });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        // the body broke mid-stream: a transport failure after the headers
        throw new S3UnavailableError("GetObject", key, 0, "Transport", `S3 GetObject ${key}: body failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      const want = res.headers.get("content-length");
      if (want !== null && Number(want) !== bytes.byteLength) throw new S3UnavailableError("GetObject", key, 0, "Truncated", `S3 GetObject ${key}: got ${bytes.byteLength} of ${want} bytes`);
      const meta: Record<string, string> = {};
      for (const [k, v] of res.headers) if (k.startsWith(META_PREFIX)) meta[k.slice(META_PREFIX.length)] = v;
      return { bytes, meta };
    },

    async put(key, bytes, meta = {}) {
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        // S3 rejects the upload if the bytes it received do not hash to this.
        "x-amz-checksum-sha256": createHash("sha256").update(bytes).digest("base64"),
      };
      for (const [k, v] of Object.entries(meta)) headers[`${META_PREFIX}${k.toLowerCase()}`] = v;
      const res = await call("PutObject", key, { method: "PUT", headers, body: bytes as unknown as BodyInit });
      if (res.status === 404) throw new S3Error("PutObject", key, 404, "NoSuchBucket", `S3 PutObject ${key}: 404 (the bucket does not exist)`);
      await res.body?.cancel();
    },

    async list(prefix, max = 1000) {
      assertSpillKey("list", prefix);
      const keys: string[] = [];
      let token: string | undefined;
      do {
        // The query string is part of what aws4fetch signs. Keys come back in UTF-8 key order.
        const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": String(Math.min(1000, max - keys.length)) });
        if (token !== undefined) q.set("continuation-token", token);
        const res = await call("ListObjectsV2", `?${q.toString()}`, { method: "GET" }, true);
        if (res.status === 404) throw new S3Error("ListObjectsV2", prefix, 404, "NoSuchBucket", `S3 ListObjectsV2 ${prefix}: 404 (the bucket does not exist)`);
        const text = await res.text();
        for (const m of text.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlUnescape(m[1]!));
        token = /<IsTruncated>true<\/IsTruncated>/.test(text) ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(text)?.[1] : undefined;
        if (token !== undefined) token = xmlUnescape(token);
      } while (token !== undefined && keys.length < max);
      return keys.slice(0, max);
    },

    async delete(key) {
      assertSpillKey("delete", key);
      const res = await call("DeleteObject", key, { method: "DELETE" });
      await res.body?.cancel(); // 204; a missing key is a 204 too, and a 404 here is the same "already gone"
    },
  };
}

const xmlUnescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
