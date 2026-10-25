// The akldb Lambda entry (design/aws-port.md sections 3 and 4.1): one esbuild bundle, five handlers
// (infra/akldb.yaml's Handler values lambda.api, .feed, .jobs, .mirrorIngest, .mirrorApply).
// api and feed stream the existing Hono app onto the DynamoDB store; jobs runs the Worker's `scheduled` dispatch;
// the mirror pair are thin adapters onto lane Z (platform/lambda-mirror.ts).
// Environment (set by the template): AKLDB_STAGE, AKLDB_TABLE_MAIN, AKLDB_TABLE_EPHEMERAL, AKLDB_BUCKET_DATA|DUMPS|SNAPSHOT,
// AKLDB_SSM_PREFIX, DISCORD_API_URL, MIRROR_MODE, MIRROR_APPLY_FUNCTION, AKLDB_DDB_ALLOW_REMOTE.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SSMClient } from "@aws-sdk/client-ssm";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulidx";
import { platformFor } from "../app";
import { systemClock } from "../core/time";
import type { Bindings } from "../env";
import { readDumpState } from "../dump/write";
import worker from "../index";
import { createCatalog } from "../store/ddb/catalog";
import { createDocClient } from "../store/ddb/client";
import type { DdbTables } from "../store/ddb/contracts";
import { createDdbStore } from "../store/ddb";
import type { Store } from "../store/port";
import { ingestBatch, runApplier } from "./lambda-mirror";
import {
  ParamReader,
  createMetrics,
  discordConfig,
  eventToRequest,
  headersToObject,
  originVerified,
  s3Blobs,
  type Metrics,
  type UrlEvent,
} from "./lambda-support";
import { lruResponseCache } from "./node-lab";
import type { Platform } from "./port";

/** What the handlers are built from; tests pass fakes. */
export interface LambdaDeps {
  env: Record<string, string | undefined>;
  doc: DynamoDBDocumentClient;
  s3: Pick<S3Client, "send">;
  ssm: Pick<SSMClient, "send">;
  lambda: Pick<LambdaClient, "send">;
  /** The Worker's `fetch`/`scheduled` (src/index.ts). */
  worker: Pick<typeof worker, "fetch" | "scheduled">;
  fetch: typeof fetch;
  /** `awslambda.streamifyResponse` in the Lambda runtime; the identity elsewhere. */
  streamify(h: StreamHandler): StreamHandler;
  httpResponseStream?: { from(s: WritableLike, meta: { statusCode: number; headers: Record<string, string>; cookies?: string[] }): WritableLike };
  log: { error: (...a: unknown[]) => void; log: (l: string) => void };
}

export interface WritableLike {
  write(chunk: Uint8Array | string): unknown;
  end(): unknown;
}
export type StreamHandler = (event: UrlEvent, stream: WritableLike, context?: unknown) => Promise<void>;
type Ctx = { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void };

const need = (env: LambdaDeps["env"], k: string): string => {
  const v = env[k];
  if (v === undefined || v === "") throw new Error(`missing environment variable ${k}`);
  return v;
};

export function createHandlers(deps: LambdaDeps) {
  const e = deps.env;
  const stage = e.AKLDB_STAGE ?? "lab";
  const metrics: Metrics = createMetrics(stage, deps.log.log);
  const params = new ParamReader(deps.ssm, e.AKLDB_SSM_PREFIX ?? `/akldb/${stage}`);
  const tables: DdbTables = { main: e.AKLDB_TABLE_MAIN ?? "", ephemeral: need(e, "AKLDB_TABLE_EPHEMERAL") };

  // Count EVENTTX_EXHAUSTED lines for the alarm, then log as usual.
  const origError = deps.log.error;
  deps.log.error = (...a: unknown[]) => {
    metrics.noteConsoleError(a);
    origError(...a);
  };

  const blobs = () => s3Blobs(deps.s3, { data: need(e, "AKLDB_BUCKET_DATA"), dumps: need(e, "AKLDB_BUCKET_DUMPS"), snapshot: need(e, "AKLDB_BUCKET_SNAPSHOT") });

  // One runtime per container: store, catalog, platform factory, env. Built lazily on first use.
  let runtime: Promise<{ env: Bindings; store: Store; blobs: ReturnType<typeof blobs>; pending: Set<Promise<unknown>>; drain(): Promise<void> }> | undefined;
  const getRuntime = () => {
    runtime ??= (async () => {
      const b = blobs();
      const store = createDdbStore({ doc: deps.doc, tables, blobs: b });
      const cache = lruResponseCache();
      const pending = new Set<Promise<unknown>>();
      const factory = (env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void } | undefined): Platform => ({
        store,
        blobs: b,
        cache,
        config: env,
        now: systemClock,
        ulid: () => ulid(),
        fetch: (input, init) => deps.fetch(input, init),
        background(task) {
          const guarded = task.catch((err: unknown) => deps.log.error(`background task failed: ${err instanceof Error ? err.message : String(err)}`));
          pending.add(guarded);
          void guarded.finally(() => pending.delete(guarded));
          ctx?.waitUntil(guarded);
        },
      });
      const env = {
        DISCORD_API_URL: e.DISCORD_API_URL ?? "https://discord.com/api",
        ...(await discordConfig(params)),
        DB: store as unknown as D1Database,
        PLATFORM: factory,
      } as unknown as Bindings;
      return {
        env,
        store,
        blobs: b,
        pending,
        async drain() {
          while (pending.size > 0) await Promise.all([...pending]);
        },
      };
    })();
    return runtime;
  };

  const makeCtx = (tasks: Promise<unknown>[]): Ctx => ({ waitUntil: (p) => void tasks.push(p), passThroughOnException() {} });

  const web = (name: "api" | "feed"): StreamHandler =>
    async (event, stream) => {
      const verify = await params.require("origin-verify");
      let status = 200;
      let headers: Record<string, string> = { "content-type": "application/json" };
      let cookies: string[] = [];
      let body: ReadableStream<Uint8Array> | null = null;
      let rt: Awaited<ReturnType<typeof getRuntime>> | undefined;
      const tasks: Promise<unknown>[] = [];
      try {
        if (!originVerified(event.headers["x-origin-verify"], verify)) {
          body = new Response(JSON.stringify({ error: "forbidden" })).body;
          status = 403;
        } else {
          rt = await getRuntime();
          const res = await deps.worker.fetch(eventToRequest(event) as never, rt.env, makeCtx(tasks) as unknown as ExecutionContext);
          status = res.status;
          ({ headers, cookies } = headersToObject(res.headers as unknown as Headers));
          body = res.body as unknown as ReadableStream<Uint8Array> | null;
        }
      } catch (err) {
        deps.log.error(`${name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        status = 500;
        body = new Response(JSON.stringify({ error: "internal" })).body;
      }
      const out = deps.httpResponseStream ? deps.httpResponseStream.from(stream, { statusCode: status, headers, ...(cookies.length ? { cookies } : {}) }) : stream;
      if (body !== null && status !== 204 && status !== 304) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out.write(value);
        }
      }
      out.end();
      // The response is out; run post-response work (design section 3), then the metrics.
      while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
      await rt?.drain();
      metrics.flush();
    };

  const jobs = async (event: { scheduledTime?: string | number } = {}): Promise<void> => {
    const rt = await getRuntime();
    const scheduledTime = event.scheduledTime === undefined ? Date.now() : typeof event.scheduledTime === "number" ? event.scheduledTime : Date.parse(event.scheduledTime);
    const tasks: Promise<unknown>[] = [];
    let failure: unknown;
    try {
      await deps.worker.scheduled({ cron: "*/5 * * * *", scheduledTime, noRetry() {} } as unknown as ScheduledController, rt.env, makeCtx(tasks) as unknown as ExecutionContext);
      while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
      await rt.drain();
    } catch (err) {
      failure = err;
    }
    // Replica snapshot (every tick, written only when HEAD moved). Age is 0 once confirmed current; a failure reports a
    // sentinel above the alarm threshold so the alarm sees it even though the invocation also errors.
    try {
      await createCatalog({ doc: deps.doc, tables, blobs: rt.blobs }).writeSnapshot();
      metrics.emit("ReplicaSnapshotAgeSeconds", 0);
    } catch (err) {
      metrics.emit("ReplicaSnapshotAgeSeconds", 86400);
      failure ??= err;
    }
    try {
      const dump = await readDumpState(rt.store);
      if (dump !== null) metrics.emit("DumpAgeSeconds", Math.max(0, Math.round((Date.now() - Date.parse(dump.at)) / 1000)));
    } catch (err) {
      failure ??= err;
    }
    metrics.flush();
    if (failure !== undefined) throw failure;
  };

  const mirrorIngest = async (event: UrlEvent): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> => {
    const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if ((e.MIRROR_MODE ?? "off") !== "apply") return json(503, { error: "mirror ingest is off" });
    const secret = await params.require("tee-hmac");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers[k.toLowerCase()] = v;
    const raw = event.body ?? "";
    const body = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
    try {
      const r = await ingestBatch(
        { headers, body, nowMs: Date.now() },
        {
          doc: deps.doc,
          tables,
          secret,
          wake: async () => {
            await deps.lambda.send(new InvokeCommand({ FunctionName: need(e, "MIRROR_APPLY_FUNCTION"), InvocationType: "Event", Payload: Buffer.from("{}") }));
          },
        },
      );
      return json(r.status, r.body);
    } catch (err) {
      deps.log.error(`mirrorIngest: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return json(500, { error: err instanceof Error && err.name === "MirrorNotImplemented" ? err.message : "internal" });
    } finally {
      metrics.flush();
    }
  };

  const mirrorApply = async (): Promise<unknown> => {
    if ((e.MIRROR_MODE ?? "off") !== "apply") return { skipped: "mirror mode is not apply" };
    const rt = await getRuntime();
    try {
      const r = await runApplier({ store: rt.store, doc: deps.doc, tables, blobs: rt.blobs, now: () => Date.now() }, { mode: "apply" });
      if (r.diverged) metrics.emit("MirrorDiverged", 1);
      return r;
    } catch (err) {
      if (err instanceof Error && err.name === "MirrorDivergedError") metrics.emit("MirrorDiverged", 1);
      throw err;
    } finally {
      metrics.flush();
    }
  };

  return { api: deps.streamify(web("api")), feed: deps.streamify(web("feed")), jobs, mirrorIngest, mirrorApply };
}

// ---------------------------------------------------------------- runtime wiring

type AwsLambdaGlobal = { streamifyResponse(h: StreamHandler): StreamHandler; HttpResponseStream: NonNullable<LambdaDeps["httpResponseStream"]> };
const awslambda = (globalThis as unknown as { awslambda?: AwsLambdaGlobal }).awslambda;

const streaming = typeof awslambda?.streamifyResponse === "function";
let handlers: ReturnType<typeof createHandlers> | undefined;
function real() {
  handlers ??= createHandlers({
    env: process.env,
    doc: createDocClient({ region: process.env.AWS_REGION ?? "us-east-2" }),
    s3: new S3Client({}),
    ssm: new SSMClient({}),
    lambda: new LambdaClient({}),
    worker,
    fetch: (i, init) => fetch(i, init),
    streamify: (h) => (awslambda ? awslambda.streamifyResponse(h) : h),
    httpResponseStream: awslambda?.HttpResponseStream,
    log: { error: (...a) => console.error(...a), log: (l) => console.log(l) },
  });
  return handlers;
}

// The runtime requires the streaming handlers to be wrapped at module load, so these two are created eagerly in Lambda.
export const api: StreamHandler = streaming ? real().api : (ev, s, c) => real().api(ev, s, c);
export const feed: StreamHandler = streaming ? real().feed : (ev, s, c) => real().feed(ev, s, c);
export const jobs = (event?: { scheduledTime?: string | number }) => real().jobs(event);
export const mirrorIngest = (event: UrlEvent) => real().mirrorIngest(event);
export const mirrorApply = () => real().mirrorApply();
