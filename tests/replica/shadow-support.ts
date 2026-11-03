// Helpers for the shadow tests: an in-process Upstream that answers from the harness app (the real routes, so the feed is
// exactly what production's public API serves), and a shadow world (a fresh migrated replica + the shadow-only schema).
import path from "node:path";
import { SELF } from "../harness";
import type { Bindings } from "../../src/env";
import { buildDump, type Dump } from "../../src/dump/write";
import { memoryBlobs, r2Binding } from "../../src/platform/node";
import { applyShadowMigrations } from "../../src/replica/shadow/schema";
import { UPSTREAM_BASE, UpstreamError, type Upstream } from "../../src/replica/shadow/upstream";
import type { FollowerDeps } from "../../src/replica/shadow/follower";
import { createShimD1 } from "../../src/store/shim/d1";
import { freshReplica } from "../shim/support";
import type { MemoryLogFaults } from "../../src/replica/log-memory";
import type { Replica } from "../../src/replica/replica";

export const SHADOW_MIGRATIONS = path.resolve(import.meta.dirname, "..", "..", "migrations-shadow");

/** The harness app as production's public API. `log` records every path asked. */
export function harnessUpstream(log: string[] = []): Upstream {
  const get = async (p: string): Promise<Response> => {
    log.push(p);
    const res = await SELF.fetch(`${UPSTREAM_BASE}${p}`, { headers: { "user-agent": "akldb-shadow/1" } });
    if (!res.ok) throw new UpstreamError(`GET ${p}: ${res.status}`, res.status);
    return res;
  };
  return {
    base: UPSTREAM_BASE,
    async json(p) {
      return (await get(p)).json();
    },
    async bytes(p) {
      const bytes = new Uint8Array(await (await get(p)).arrayBuffer());
      return { bytes, text: () => new TextDecoder().decode(bytes) };
    },
  };
}

export interface ShadowWorld {
  replica: Replica;
  db: D1Database;
  blobs: ReturnType<typeof memoryBlobs>;
  lines: string[];
  dump(): Promise<Dump>;
  deps(up: Upstream, now: () => number, over?: Partial<FollowerDeps>): FollowerDeps;
}

export async function shadowWorld(clockIso: () => string, faults: MemoryLogFaults = {}): Promise<ShadowWorld> {
  const { replica } = await freshReplica(faults);
  await applyShadowMigrations(replica, SHADOW_MIGRATIONS, () => new Date("2026-11-02T00:00:00Z"));
  const db = createShimD1(replica);
  const blobs = memoryBlobs();
  const lines: string[] = [];
  const env = { DB: db, DUMPS: r2Binding(blobs) } as unknown as Bindings;
  const dump = (): Promise<Dump> => buildDump(env, clockIso);
  return {
    replica,
    db,
    blobs,
    lines,
    dump,
    deps: (up, now, over = {}) => ({ db, up, buildDump: dump, blobs, logLine: (l) => void lines.push(l), now, budgetMs: 60_000, ...over }),
  };
}
