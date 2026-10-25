// setupFiles of the `ddb` project (lane L): one fresh table pair per test
// file, named from a hash of the file path plus the worker id, created with
// G's createTables before the file's imports run and dropped after it.
import { createHash } from "node:crypto";
import { afterAll, vi } from "vitest";
import { createDocClient } from "../../src/store/ddb/client";
import type { DdbTables } from "../../src/store/ddb/contracts";
import { createTables, deleteTables } from "../../src/store/ddb/tables";
import { seedBootstrap } from "../../src/store/ddb/codec";
import { memoryBlobs } from "../../src/platform/node-lab";

export interface DdbFileState {
  endpoint: string;
  tables: DdbTables;
  file: string;
}

export const STATE_KEY = "__aklddbFileState";

const worker = (globalThis as unknown as { __vitest_worker__?: { filepath?: string; ctx?: { workerId?: number } } }).__vitest_worker__;
const file = worker?.filepath ?? `pid${process.pid}`;
// Files whose cost on DynamoDB Local is legitimately higher (call count x latency); D1 keeps the default.
const SLOW_FILES: Record<string, number> = { "tests/events/fold.test.ts": 900_000 };
for (const [suffix, ms] of Object.entries(SLOW_FILES)) if (file.endsWith(suffix)) vi.setConfig({ testTimeout: ms, hookTimeout: ms });
const prefix = `akldb-t-${createHash("sha1").update(file).digest("hex").slice(0, 10)}-w${process.env.VITEST_POOL_ID ?? worker?.ctx?.workerId ?? 0}`;
const tables: DdbTables = { main: `${prefix}-main`, ephemeral: `${prefix}-eph` };
const endpoint = process.env.AKLDB_DDB_ENDPOINT ?? `http://127.0.0.1:${process.env.AKLDB_DDB_PORT ?? 18307}`;

const doc = createDocClient({ endpoint, region: "us-east-2" });
// A previous crashed run may have left this pair behind (same path, same worker).
await deleteTables(doc, tables).catch(() => {});
// No TTL on test tables: DynamoDB Local really deletes ttl-expired items, and pinned test clocks write past expiries.
// Production keeps TTL and never relies on it for correctness (every expiry is checked on read).
await createTables(doc, tables, { ttl: false });
// What the D1 migrations seed (the bootstrap admin, the heads, the delivery gate), as the D1 harness has it.
await seedBootstrap({ doc, tables, blobs: memoryBlobs() });
(globalThis as Record<string, unknown>)[STATE_KEY] = { endpoint, tables, file } satisfies DdbFileState;

afterAll(async () => {
  await deleteTables(doc, tables).catch(() => {});
});
