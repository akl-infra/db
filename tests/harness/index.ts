// The one import tests use for the runtime under test (design/aws-port.md
// §4.3). P1: Workers + D1, re-exported from cloudflare:test. P2 adds a
// DynamoDB variant behind a vitest alias with the same exports, so test
// files do not change again.
import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { createD1Store } from "../../src/store/d1";
import type { Store } from "../../src/store/port";
import { d1TestStore } from "./d1";
import type { TestStore } from "./port";

export { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext };
export type { Row, TableName, TestStore, Where } from "./port";

const db = (env as unknown as { DB: D1Database }).DB;

/** Seed and inspect rows (D1-shaped on every backend). */
export const testStore: TestStore = d1TestStore(db);

/** The storage port under test, for tests that call core functions directly. */
export const store: Store = createD1Store(db);
