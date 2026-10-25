// Test support for lane Z: a recording wrapper (a minimal stand-in for lane T's recorder, same record shape), a second table
// pair to act as the "prod" source, a driver that runs the fuzzer's request sequences against it, and a queue-feeding helper.
import { createHash } from "node:crypto";
import app from "../../src/index";
import { createNodeLabPlatform, memoryBlobs } from "../../src/platform/node-lab";
import { seedBootstrap } from "../../src/store/ddb/codec";
import { createDdbStore } from "../../src/store/ddb";
import { createDocClient } from "../../src/store/ddb/client";
import type { DdbContext, DdbTables } from "../../src/store/ddb/contracts";
import { createTables, deleteTables } from "../../src/store/ddb/tables";
import type { Store } from "../../src/store/port";
import { encodeTee, type TeeBatch, type TeeCall } from "../../src/mirror/record";
import { MIRROR_WRITES, outcomeOfError, outcomeOfResult } from "../../src/mirror/verify";
import type { Bindings } from "../../src/env";

export const ENDPOINT = process.env.AKLDB_DDB_ENDPOINT ?? "http://127.0.0.1:18531";

/** Wrap `store` so every mirrored write is recorded (serialised, so seqs are attributable) into `sink`. */
export function recordingStore(store: Store, sink: (c: TeeCall) => void): Store {
  let chain: Promise<unknown> = Promise.resolve();
  let lastMs = 0;
  const wrapArea = (area: string, obj: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(obj, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof prop !== "string" || typeof v !== "function" || !(MIRROR_WRITES[area] ?? []).includes(prop)) return typeof v === "function" ? v.bind(target) : v;
        return (...args: unknown[]) => {
          const run = async (): Promise<unknown> => {
            const clocks: string[][] = [];
            const wrapped = args.map((a) => {
              if (typeof a !== "function") return a;
              const seen: string[] = [];
              clocks.push(seen);
              return () => {
                const iso = (a as () => string)();
                seen.push(iso);
                return iso;
              };
            });
            const before = await store.head.headSeq();
            let ci = 0;
            const encArgs = () => args.map((a) => (typeof a === "function" ? { $clock: clocks[ci++]! } : encodeTee(a)));
            let outcome: TeeCall["outcome"];
            let result: unknown;
            let thrown: unknown;
            let threw = false;
            try {
              result = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, wrapped);
              outcome = outcomeOfResult(result);
            } catch (e) {
              threw = true;
              thrown = e;
              outcome = outcomeOfError(e);
            }
            const after = await store.head.headSeq();
            const seqs: number[] = [];
            for (let s = before + 1; s <= after; s++) seqs.push(s);
            lastMs = Math.max(lastMs + 1, Date.now());
            sink({ v: 1, method: `${area}.${prop}`, args: encArgs(), outcome, seqs, atMs: lastMs });
            if (threw) throw thrown;
            return result;
          };
          const p = chain.then(run, run);
          chain = p.catch(() => {});
          return p;
        };
      },
    });
  return new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      return typeof prop === "string" && v !== null && typeof v === "object" ? wrapArea(prop, v as Record<string, unknown>) : v;
    },
  });
}

export interface Source {
  ctx: DdbContext;
  store: Store;
  recorded: Store;
  calls: TeeCall[];
  stop(): Promise<void>;
}

/** A fresh "prod": its own table pair, seeded like the harness, behind a recorder. */
export async function startSource(tag: string): Promise<Source> {
  const doc = createDocClient({ endpoint: ENDPOINT, region: "us-east-2" });
  const prefix = `akldb-zsrc-${createHash("sha1").update(tag).digest("hex").slice(0, 8)}-${process.pid}`;
  const tables: DdbTables = { main: `${prefix}-main`, ephemeral: `${prefix}-eph` };
  await deleteTables(doc, tables).catch(() => {});
  await createTables(doc, tables, { ttl: false });
  const blobs = memoryBlobs();
  await seedBootstrap({ doc, tables, blobs });
  const store = createDdbStore({ doc, tables, blobs });
  const calls: TeeCall[] = [];
  const recorded = recordingStore(store, (c) => calls.push(c));
  const ctx = { doc, tables, blobs } as unknown as DdbContext;
  return { ctx, store, recorded, calls, stop: () => deleteTables(doc, tables).then(() => {}, () => {}) };
}

/** Wrap calls into batches the way a Worker would: consecutive runs of n. */
export function batchesOf(calls: TeeCall[], n: number, direction: TeeBatch["direction"] = "d1->ddb", idPrefix = "b"): TeeBatch[] {
  const out: TeeBatch[] = [];
  for (let i = 0; i < calls.length; i += n) out.push({ v: 1, direction, batchId: `${idPrefix}-${i / n}`, calls: calls.slice(i, i + n) });
  return out;
}

export type AppEnv = Bindings & Record<string, unknown>;

/** Run `app` on the source store with `baseEnv`'s vars. */
export function sourceApp(baseEnv: AppEnv, src: Source, discordUrl: string) {
  const platform = createNodeLabPlatform({ store: src.recorded, blobs: src.ctx.blobs });
  const env = { ...baseEnv, DB: src.recorded as unknown as D1Database, PLATFORM: platform, DISCORD_API_URL: discordUrl } as AppEnv;
  return {
    async fetch(req: Request): Promise<Response> {
      const tasks: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => void tasks.push(p), passThroughOnException() {} };
      const res = await app.fetch(req, env, ctx as unknown as ExecutionContext);
      const body = new Uint8Array(await res.arrayBuffer());
      while (tasks.length > 0) await Promise.allSettled(tasks.splice(0));
      await platform.drain();
      return new Response(body, { status: res.status, headers: res.headers });
    },
  };
}
