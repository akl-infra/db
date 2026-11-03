// Phase E on the Lambda: prod awaits the cutover image (AKLDB_AWAIT_IMAGE=1 → migrate, tick and nightly do nothing on an empty
// log, LDB-CV12) and every answer carries X-Akldb-Backend: aws (LDB-CV13).
import { describe, expect, it } from "vitest";
import { createLambdaHandler, safeEqual } from "../../src/platform/lambda";
import type { Aws } from "../../src/platform/lambda-aws";
import { memoryBlobs } from "../../src/platform/node";
import { appendImage } from "../../src/replica/image";
import { MemoryLog } from "../../src/replica/log-memory";
import { readMigrationFiles } from "../../src/replica/migrations";
import { MemoryObjects } from "../../src/replica/objects";
import { MemorySnapshotState } from "../../src/replica/snapshot";
import { MIGRATIONS_DIR, churn, world } from "../replica/support";

const SECRET = "s3cret-origin-value-0123456789abcdef";
function fakeAws(): Aws {
  return {
    async invokeAsync() {},
    dumps: memoryBlobs(),
    async getParameters(names: string[]) {
      return { values: Object.fromEntries(names.filter((n) => n === "origin-secret").map((n) => [n, SECRET])), missing: [] };
    },
    async invokeLive() {
      return { ok: true, container: "other" };
    },
  } as unknown as Aws;
}
function container(log: MemoryLog, env: Record<string, string>, lines: string[]) {
  return createLambdaHandler({
    env: { STAGE: "prod", DISCORD_API_URL: "http://127.0.0.1:1/discord", MODQUEUE_DISCORD_COMPONENTS: "false", AWS_LAMBDA_FUNCTION_VERSION: "1", ...env },
    aws: fakeAws(),
    log,
    migrationsDir: MIGRATIONS_DIR,
    snapshots: { state: new MemorySnapshotState(), objects: new MemoryObjects() },
    logError: (m) => void lines.push(`ERR ${m}`),
    logLine: (m) => void lines.push(m),
    now: () => Date.parse("2026-11-04T04:00:00Z"),
    sleep: async () => {},
  });
}
const httpEvent = (path: string, headers: Record<string, string> = {}) => ({
  version: "2.0",
  rawPath: path,
  rawQueryString: "",
  headers,
  requestContext: { http: { method: "GET", path } },
  isBase64Encoded: false,
});

describe("prod awaits its image (CV12)", () => {
  it("[LDB-CV12] with AKLDB_AWAIT_IMAGE=1 an empty log is never migrated, ticked or snapshotted; the image makes migrate a no-op", async () => {
    const blobs = new MemoryObjects();
    const log = new MemoryLog({}, blobs);
    const lines: string[] = [];
    const h = container(log, { AKLDB_AWAIT_IMAGE: "1" }, lines);
    await h.ready();
    for (const ev of [{ akldb: "migrate" }, { akldb: "tick" }, { akldb: "nightly" }]) {
      const out = (await h(ev)) as Record<string, unknown>;
      expect(out, JSON.stringify(ev)).toMatchObject({ ok: true, awaiting: "image", seq: 0 });
    }
    expect(((await h({ akldb: "migrate" })) as { message: string }).message).toBe("awaiting image");
    expect(log.length).toBe(0); // nothing reached the log
    expect(lines.filter((l) => l.includes("awaiting image")).length).toBeGreaterThanOrEqual(4);
    expect(lines.filter((l) => l.startsWith("ERR ") || l.startsWith("akldb-alarm:")), lines.join("\n")).toEqual([]);

    // the cutover appends the image (D1's own migrations come with it) ...
    const src = await world();
    await churn(src.replica, 10);
    await appendImage({ log, raw: src.replica.serialize(), tables: {}, sleep: async () => {} });
    // ... and this SAME container, which booted on the empty log, now migrates as a no-op and warms up
    const out = (await h({ akldb: "migrate" })) as { ok: boolean; applied: string[]; seq: number; warmup: string; awaiting?: string };
    expect(out).toMatchObject({ ok: true, applied: [], seq: 1, warmup: "ok" });
    expect(out.awaiting).toBeUndefined();
    expect(log.length).toBe(1); // still only the image
  });

  it("[LDB-CV12] without the flag (staging, shadow) an empty log migrates as before", async () => {
    const log = new MemoryLog({}, new MemoryObjects());
    const h = container(log, { STAGE: "staging", AKLDB_AWAIT_IMAGE: "0" }, []);
    const out = (await h({ akldb: "migrate" })) as { applied: string[] };
    expect(out.applied).toEqual(readMigrationFiles(MIGRATIONS_DIR).map((m) => m.name));
  });
});

describe("X-Akldb-Backend (CV13)", () => {
  it("[LDB-CV13] every HTTP answer, 403s included, says x-akldb-backend: aws", async () => {
    const src = await world();
    const log = new MemoryLog({}, new MemoryObjects());
    await appendImage({ log, raw: src.replica.serialize(), tables: {}, sleep: async () => {} });
    const h = container(log, { AKLDB_AWAIT_IMAGE: "1" }, []);
    const ok = (await h(httpEvent("/v1/meta", { "x-akldb-origin": SECRET }))) as { statusCode: number; headers: Record<string, string> };
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-akldb-backend"]).toBe("aws");
    const denied = (await h(httpEvent("/v1/meta"))) as { statusCode: number; headers: Record<string, string> };
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["x-akldb-backend"]).toBe("aws");
    expect(safeEqual("a", "a")).toBe(true);
  });
});
