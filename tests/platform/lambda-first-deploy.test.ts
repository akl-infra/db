// [LDB-RP8] A FIRST deploy: the log is empty when the containers boot, so the init warm-up must not run GET /v1/meta on a
// schema-less database (it answered 500 "no such table: authors_head" and logged at ERROR on shadow's first deploy,
// 2026-11-03). It is skipped with one INFO line, and migrate (and, for containers that booted earlier, the next keep-warm
// ping) runs it once the schema is complete, so the deploy's report shows the post-migrate state.
import { describe, expect, it } from "vitest";
import { createLambdaHandler } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { MemoryLog } from "../../src/replica/log-memory";
import { readMigrationFiles } from "../../src/replica/migrations";
import { MemoryObjects } from "../../src/replica/objects";
import { MemorySnapshotState } from "../../src/replica/snapshot";
import { MIGRATIONS_DIR } from "../replica/support";

function fakeAws(): Aws {
  return {
    async invokeAsync() {},
    dumps: memoryBlobs(),
    async getParameters(names: string[]) {
      return { values: Object.fromEntries(names.filter((n) => n === "origin-secret").map((n) => [n, "s3cret-origin-value-0123456789abcdef"])), missing: [] };
    },
    async invokeLive() {
      return { ok: true, container: "other" };
    },
  } as unknown as Aws;
}

function container(log: MemoryLog, objects: MemoryObjects, state: MemorySnapshotState, lines: string[]) {
  return createLambdaHandler({
    env: { STAGE: "staging", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", AWS_LAMBDA_FUNCTION_VERSION: "1" },
    aws: fakeAws(),
    log,
    migrationsDir: MIGRATIONS_DIR,
    snapshots: { state, objects },
    logError: (m) => void lines.push(`ERR ${m}`),
    logLine: (m) => void lines.push(m),
    now: () => Date.parse("2026-11-03T04:00:00Z"),
    sleep: async () => {},
  });
}

describe("first deploy: empty log, then migrate, then warm", () => {
  it("[LDB-RP8] the init warm-up is skipped on an empty schema, migrate warms up after applying every migration, and no ERROR line is written", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    const objects = new MemoryObjects();
    const state = new MemorySnapshotState();
    const lines: string[] = [];
    const h = container(log, objects, state, lines);
    await h.ready();
    expect(lines.filter((l) => l.startsWith("akldb-boot: warm-up skipped"))).toHaveLength(1);

    const out = (await h({ akldb: "migrate" })) as { ok: boolean; applied: string[]; warmup: string };
    expect(out.ok).toBe(true);
    expect(out.applied).toEqual(readMigrationFiles(MIGRATIONS_DIR).map((m) => m.name));
    expect(out.warmup).toBe("ok");

    const warm = (await h({ akldb: "warm", k: 1 })) as { warmup: string };
    expect(warm.warmup).toBe("ok");
    expect(lines.filter((l) => l.startsWith("ERR ") || l.startsWith("akldb-alarm:")), lines.join("\n")).toEqual([]);
  });

  it("[LDB-RP8] a container that booted before another one migrated warms up on its next keep-warm ping", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    const objects = new MemoryObjects();
    const state = new MemorySnapshotState();
    const early: string[] = [];
    const a = container(log, objects, state, early); // booted on the empty log
    await a.ready();
    const b = container(log, objects, state, []);
    expect(((await b({ akldb: "migrate" })) as { warmup: string }).warmup).toBe("ok");
    const warm = (await a({ akldb: "warm", k: 1 })) as { warmup: string };
    expect(warm.warmup).toBe("ok");
    expect(early.filter((l) => l.startsWith("ERR ") || l.startsWith("akldb-alarm:")), early.join("\n")).toEqual([]);
  });
});
