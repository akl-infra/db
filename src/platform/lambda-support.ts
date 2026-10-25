// Pieces of the Lambda entry (src/platform/lambda.ts) that need no handler: the S3 BlobStore, the once-per-container
// SSM reader, EMF metrics, and the Function URL <-> Request/Response adapters (design/aws-port.md section 3).
import { timingSafeEqual } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { PlatformConfig, BlobStore, BlobObject } from "./port";

// ---------------------------------------------------------------- blobs

export interface Buckets {
  data: string;
  dumps: string;
  snapshot: string;
}

/** Which bucket holds a key: payload spill in data, the catalog snapshot in snapshot, the dump files (dump-*, latest.json, monthly/*) in dumps. */
export function bucketFor(key: string, b: Buckets): string {
  if (key.startsWith("payloads/")) return b.data;
  if (key.startsWith("replica/")) return b.snapshot;
  return b.dumps;
}

export function s3Blobs(s3: Pick<S3Client, "send">, buckets: Buckets): BlobStore {
  return {
    async get(key): Promise<BlobObject | null> {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucketFor(key, buckets), Key: key }));
        if (r.Body === undefined) return null;
        return {
          body: (r.Body as unknown as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream(),
          httpEtag: r.ETag ?? "",
          contentType: r.ContentType ?? null,
          size: r.ContentLength ?? 0,
        };
      } catch (e) {
        const name = (e as { name?: string } | null)?.name;
        if (name === "NoSuchKey" || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucketFor(key, buckets), Key: key, Body: body, ContentType: contentType }));
    },
  };
}

// ------------------------------------------------------------------ SSM

/** Reads SecureString parameters under a prefix; each name is fetched at most once per container. A missing parameter reads as undefined (unset). */
export class ParamReader {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  constructor(
    private readonly ssm: Pick<SSMClient, "send">,
    readonly prefix: string,
  ) {}

  get(name: string): Promise<string | undefined> {
    let p = this.cache.get(name);
    if (p === undefined) {
      p = this.ssm
        .send(new GetParameterCommand({ Name: `${this.prefix}/${name}`, WithDecryption: true }))
        .then((r) => r.Parameter?.Value)
        .catch((e: unknown) => {
          if ((e as { name?: string } | null)?.name === "ParameterNotFound") return undefined;
          this.cache.delete(name); // a transient failure is retried by the next invocation
          throw e;
        });
      this.cache.set(name, p);
    }
    return p;
  }

  /** Like get, but a missing value is an error (secrets the function cannot run without). */
  async require(name: string): Promise<string> {
    const v = await this.get(name);
    if (v === undefined || v === "") throw new Error(`SSM parameter ${this.prefix}/${name} is not set`);
    return v;
  }
}

/** SSM name (under the prefix) -> PlatformConfig key. All optional: unset means the feature is off. */
export const DISCORD_PARAMS: Record<string, keyof PlatformConfig> = {
  "discord/bot-token": "MODQUEUE_DISCORD_BOT_TOKEN",
  "discord/application-id": "MODQUEUE_DISCORD_APPLICATION_ID",
  "discord/public-key": "MODQUEUE_DISCORD_PUBLIC_KEY",
  "discord/modqueue-webhook": "MODQUEUE_DISCORD_WEBHOOK",
  "discord/guild-id": "MODQUEUE_DISCORD_GUILD_ID",
  "discord/channel-id": "MODQUEUE_DISCORD_CHANNEL_ID",
  "discord/cards": "MODQUEUE_DISCORD_CARDS",
  "discord/actions": "MODQUEUE_DISCORD_ACTIONS",
  "discord/dms": "MODQUEUE_DISCORD_DMS",
  "discord/components": "MODQUEUE_DISCORD_COMPONENTS",
};

export async function discordConfig(reader: ParamReader): Promise<Partial<PlatformConfig>> {
  const out: Record<string, string> = {};
  await Promise.all(
    Object.entries(DISCORD_PARAMS).map(async ([name, key]) => {
      const v = await reader.get(name);
      if (v !== undefined && v !== "") out[key] = v;
    }),
  );
  return out as Partial<PlatformConfig>;
}

// ------------------------------------------------------------------ EMF

export type MetricName = "EventTxRetriesExhausted" | "ReplicaSnapshotAgeSeconds" | "DumpAgeSeconds";

/** One CloudWatch Embedded Metric Format line, namespace Akldb, dimension Stage (infra/akldb.yaml's alarms). */
export function emfLine(stage: string, name: MetricName, value: number, unit: "Count" | "Seconds", nowMs = Date.now()): string {
  return JSON.stringify({
    _aws: { Timestamp: nowMs, CloudWatchMetrics: [{ Namespace: "Akldb", Dimensions: [["Stage"]], Metrics: [{ Name: name, Unit: unit }] }] },
    Stage: stage,
    [name]: value,
  });
}

export interface Metrics {
  emit(name: MetricName, value: number, unit?: "Count" | "Seconds"): void;
  /** Counts EVENTTX_EXHAUSTED lines (src/store/ddb/tx.ts, community.ts), emits EventTxRetriesExhausted once per flush. */
  noteConsoleError(args: unknown[]): void;
  flush(): void;
}

export function createMetrics(stage: string, write: (line: string) => void = (l) => console.log(l)): Metrics {
  const pending: string[] = [];
  let exhausted = 0;
  return {
    emit(name, value, unit = name.endsWith("Seconds") ? "Seconds" : "Count") {
      pending.push(emfLine(stage, name, value, unit));
    },
    noteConsoleError(args) {
      if (typeof args[0] === "string" && args[0].startsWith("EVENTTX_EXHAUSTED")) exhausted++;
    },
    flush() {
      if (exhausted > 0) pending.push(emfLine(stage, "EventTxRetriesExhausted", exhausted, "Count"));
      exhausted = 0;
      for (const l of pending.splice(0)) write(l);
    },
  };
}

// ------------------------------------------------- Function URL adapters

export interface UrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string }; domainName?: string };
}

export function eventToRequest(e: UrlEvent): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(e.headers)) if (v !== undefined) headers.set(k, v);
  if (e.cookies !== undefined && e.cookies.length > 0) headers.set("cookie", e.cookies.join("; "));
  const host = headers.get("host") ?? e.requestContext.domainName ?? "localhost";
  const url = `https://${host}${e.rawPath}${e.rawQueryString ? `?${e.rawQueryString}` : ""}`;
  const method = e.requestContext.http.method;
  const hasBody = method !== "GET" && method !== "HEAD" && e.body !== undefined && e.body !== "";
  const body = hasBody ? (e.isBase64Encoded ? Buffer.from(e.body!, "base64") : Buffer.from(e.body!, "utf8")) : undefined;
  return new Request(url, { method, headers, body });
}

export function headersToObject(h: Headers): { headers: Record<string, string>; cookies: string[] } {
  const headers: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  return { headers, cookies: h.getSetCookie() };
}

/** Constant-time check of X-Origin-Verify against the SSM secret. */
export function originVerified(provided: string | undefined, secret: string): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
