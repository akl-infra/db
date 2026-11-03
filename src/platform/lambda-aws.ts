// The three AWS calls the Lambda host makes besides DynamoDB (replica/log-ddb.ts): SSM GetParameters, S3
// GetObject/PutObject and Lambda Invoke. aws4fetch signs them (SigV4); there is no AWS SDK. The credentials are the
// function's own, from its environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN).
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import type { BlobObject, BlobStore } from "./port";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** What platform/lambda.ts needs from AWS; tests pass a fake. */
export interface Aws {
  /** SSM GetParameters with decryption. `missing` lists names that do not exist (a tolerated state for optional secrets). */
  getParameters(names: string[]): Promise<{ values: Record<string, string>; missing: string[] }>;
  /** Invoke the function's `live` alias synchronously (RequestResponse) with a JSON payload; resolves to the parsed answer. */
  invokeLive(payload: unknown): Promise<unknown>;
  /** The data bucket, under the `dumps/` prefix. */
  dumps: BlobStore;
}

export interface AwsOptions {
  region: string;
  bucket: string;
  /** The function this code runs in (AWS_LAMBDA_FUNCTION_NAME) and its alias. */
  functionName: string;
  alias?: string;
  /** SSM names are `<ssmPrefix><name>`; the prefix ends with `/`. */
  ssmPrefix: string;
  credentials: () => AwsCredentials;
  timeoutMs?: number;
  /** Sends a signed request (default: the global fetch). Tests wrap it. */
  fetch?: (request: Request) => Promise<Response>;
}

/** Percent-encode an object key per path segment, as S3 expects (slashes stay). */
export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createAws(o: AwsOptions): Aws {
  const timeoutMs = o.timeoutMs ?? 5000;
  const send = o.fetch ?? ((r: Request) => fetch(r));
  const alias = o.alias ?? "live";

  async function signed(service: string, url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const client = new AwsClient({ ...o.credentials(), service, region: o.region });
    const { timeoutMs: t, ...rest } = init;
    return send(await client.sign(url, { ...rest, signal: AbortSignal.timeout(t ?? timeoutMs) }));
  }

  const s3Url = (key: string): string => `https://${o.bucket}.s3.${o.region}.amazonaws.com/dumps/${encodeKey(key)}`;

  const dumps: BlobStore = {
    async get(key): Promise<BlobObject | null> {
      const res = await signed("s3", s3Url(key), { method: "GET", timeoutMs: 15000 });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) throw new Error(`S3 GetObject ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const etag = res.headers.get("etag");
      if (etag === null) throw new Error(`S3 GetObject ${key}: no ETag`);
      return {
        body: res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        httpEtag: etag,
        contentType: res.headers.get("content-type"),
        size: Number(res.headers.get("content-length") ?? 0),
      };
    },
    async put(key, body, contentType) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const res = await signed("s3", s3Url(key), { method: "PUT", headers: { "content-type": contentType }, body: bytes as unknown as BodyInit, timeoutMs: 15000 });
      if (!res.ok) throw new Error(`S3 PutObject ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await res.body?.cancel();
    },
  };

  return {
    dumps,
    async getParameters(names) {
      const res = await signed("ssm", `https://ssm.${o.region}.amazonaws.com/`, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AmazonSSM.GetParameters" },
        body: JSON.stringify({ Names: names.map((n) => `${o.ssmPrefix}${n}`), WithDecryption: true }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`SSM GetParameters: ${res.status} ${text.slice(0, 200)}`);
      const json = JSON.parse(text) as { Parameters?: { Name: string; Value: string }[]; InvalidParameters?: string[] };
      const values: Record<string, string> = {};
      for (const p of json.Parameters ?? []) values[p.Name.slice(o.ssmPrefix.length)] = p.Value;
      return { values, missing: (json.InvalidParameters ?? []).map((n) => n.slice(o.ssmPrefix.length)) };
    },
    async invokeLive(payload) {
      const url = `https://lambda.${o.region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(o.functionName)}:${alias}/invocations`;
      const res = await signed("lambda", url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
        body: JSON.stringify(payload),
        timeoutMs: 30000,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Lambda Invoke: ${res.status} ${text.slice(0, 200)}`);
      const fnError = res.headers.get("x-amz-function-error");
      if (fnError !== null) throw new Error(`Lambda Invoke: function error ${fnError}: ${text.slice(0, 200)}`);
      return text === "" ? null : JSON.parse(text);
    },
  };
}

/** The quoted MD5 hex of `bytes`, as S3 serves it for a single-part SSE-S3 object (tests build expected ETags with it). */
export const quotedMd5 = (bytes: Uint8Array): string => `"${createHash("md5").update(bytes).digest("hex")}"`;
